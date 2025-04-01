const createLogger = require('../utils/logger');
const cookieLoader = require('../modules/cookieLoader');
const zoomHandler = require('../modules/zoomHandler');
const sendConnectionRequestModule = require('../modules/sendConnectionRequest');
const { withTimeout, getScrapedProfiles, updateScrapedProfile } = require('../utils/databaseUtils');
const jobQueueManager = require('../utils/jobQueueManager');
const puppeteer = require('puppeteer');
const { bot, sendJobStatusReport } = require('../telegramBot');
const { personalizeMessage } = require('../utils/messageUtils');

const logger = createLogger();

// Utility to generate a random delay between min and max (in milliseconds)
const randomDelay = (min, max) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

// Utility to simulate scrolling
const simulateScroll = async (page) => {
  await page.evaluate(async () => {
    window.scrollBy(0, Math.random() * 300 + 200);
    await new Promise(resolve => setTimeout(resolve, Math.random() * 500 + 500));
  });
};

/**
 * Controller for sending connection requests to LinkedIn profiles
 * @module controllers/sendConnectionRequestsController
 */

/**
 * Creates a controller function for handling connection request sending
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase - Supabase client instance
 * @returns {Function} Express route handler
 */
const sendConnectionRequestsController = (supabase) => {
  return async (req, res) => {
    try {
      // Validate request body
      if (!req.body) {
        return res.status(400).json({
          success: false,
          error: 'Request body is required'
        });
      }

      const { 
        campaignId, 
        maxProfiles = 20, 
        batchSize = 5, 
        delayBetweenBatches = 5000, 
        delayBetweenProfiles = 5000, 
        sendMessage = true 
      } = req.body;

      // Validate required fields
      if (!campaignId) {
        return res.status(400).json({
          success: false,
          error: 'campaignId is required'
        });
      }

      // Fetch campaign data to get connection message template
      const { data: campaignData, error: campaignError } = await withTimeout(
        supabase
          .from('campaigns')
          .select('connection_messages')
          .eq('id', campaignId)
          .single(),
        10000,
        'Timeout while fetching campaign data'
      );

      if (campaignError) {
        logger.error(`Error fetching campaign data: ${campaignError.message}`);
        return res.status(500).json({ success: false, error: 'Failed to fetch campaign data' });
      }

      // If sendMessage is true, validate that we have a template
      if (sendMessage && (!campaignData?.connection_messages?.connection_request_message?.content)) {
        logger.warn(`Campaign ${campaignId} has no connection message template. Proceeding without message.`);
        // Don't return error, just continue without message
      }

      // Create a job function that will be executed by the queue
      const jobFunction = async () => {
        const browser = await puppeteer.launch({
          headless: true,
          args: ['--start-maximized']
        });
        const page = await browser.newPage();
        
        // Initialize counters outside try block so they're accessible in catch
        let processedCount = 0;
        let sentCount = 0;
        let pendingCount = 0;
        let connectedCount = 0;
        let followingCount = 0;
        let failedCount = 0;
        
        try {
          // Set up the page with necessary configurations
          await page.setViewport({ width: 1280, height: 800 });
          await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
          
          // Load cookies from database
          const { cookies, error: cookieError } = await cookieLoader(supabase, { campaignId });
          if (cookieError || !cookies) {
            throw new Error(`Failed to load LinkedIn cookies: ${cookieError || 'No valid cookies found'}`);
          }

          // Set LinkedIn cookies
          await page.setCookie(
            { name: 'li_at', value: cookies.li_at, domain: '.linkedin.com' },
            { name: 'JSESSIONID', value: cookies.li_a, domain: '.linkedin.com' }
          );

          // Get profiles to process
          const profiles = await getScrapedProfiles(supabase, campaignId, maxProfiles);
          if (!profiles || profiles.length === 0) {
            throw new Error('No profiles found to process');
          }

          // Fetch campaign data to get connection message template
          const { data: campaignData, error: campaignError } = await withTimeout(
            supabase
              .from('campaigns')
              .select('connection_messages')
              .eq('id', campaignId)
              .single(),
            10000,
            'Timeout while fetching campaign data'
          );

          if (campaignError || !campaignData?.connection_messages?.connection_request_message?.content) {
            throw new Error(`Failed to load connection message template: ${campaignError?.message || 'No template found'}`);
          }

          const messageTemplate = campaignData.connection_messages.connection_request_message.content;

          // Initialize the connection request module
          const { sendRequest } = sendConnectionRequestModule(page);

          // Process profiles in batches
          const totalProfiles = profiles.length;

          for (let i = 0; i < totalProfiles; i += batchSize) {
            const batch = profiles.slice(i, i + batchSize);
            
            // Process each profile in the batch
            for (const profile of batch) {
              try {
                // Validate profile URL
                if (!profile.linkedin) {
                  logger.error(`Profile ${profile.id} has no LinkedIn URL`);
                  failedCount++;
                  processedCount++;
                  continue;
                }

                // Personalize the message
                let personalizedMessage = messageTemplate;
                if (sendMessage) {
                  personalizedMessage = personalizeMessage(
                    messageTemplate,
                    {
                      first_name: profile.first_name,
                      last_name: profile.last_name,
                      company: profile.company,
                      job_title: profile.job_title,
                      linkedin: profile.linkedin
                    },
                    null, // No landing page URL needed for connection requests
                    null  // No CPD landing page URL needed for connection requests
                  );
                }

                const result = await sendRequest(profile.linkedin, personalizedMessage);
                
                if (result.success) {
                  if (result.status === 'pending') pendingCount++;
                  else if (result.status === 'connected') connectedCount++;
                  else if (result.status === 'following') followingCount++;
                  else sentCount++;
                } else {
                  failedCount++;
                }

                // Update profile status in database - only use allowed values
                const dbStatus = result.success ? 
                  (result.status === 'pending' ? 'pending' : 
                   result.status === 'connected' ? 'connected' : 'not sent') : 
                  'not sent';

                await updateScrapedProfile(supabase, profile.id, dbStatus);

                processedCount++;
                await new Promise(resolve => setTimeout(resolve, delayBetweenProfiles));
              } catch (error) {
                failedCount++;
                processedCount++;
                logger.error(`Error processing profile ${profile.linkedin}: ${error.message}`);
              }
            }

            // Wait between batches
            if (i + batchSize < totalProfiles) {
              await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
            }
          }

          // Send job completion report
          const message = `Connection requests completed for campaign ${campaignId}:\n` +
            `✅ Total Processed: ${processedCount}\n` +
            `📤 New Sent: ${sentCount}\n` +
            `⏳ Already Pending: ${pendingCount}\n` +
            `✅ Already Connected: ${connectedCount}\n` +
            `👥 Following: ${followingCount}\n` +
            `❌ Failed: ${failedCount}`;

          await sendJobStatusReport(
            job.id,
            'connect',
            'completed',
            {
              campaignId,
              message,
              savedCount: sentCount,
              totalScraped: processedCount,
              totalValid: processedCount - failedCount
            }
          );

          logger.success(`Connection requests sending completed for job ${job.id}.`);
          return { success: true };
        } catch (error) {
          logger.error(`Error processing connection requests job ${job.id}: ${error.message}`);
          
          // Send error notification
          await sendJobStatusReport(
            job.id,
            'connect',
            'failed',
            {
              campaignId,
              message: `❌ Connection requests failed for campaign ${campaignId}:\n${error.message}`,
              savedCount: sentCount,
              totalScraped: processedCount,
              totalValid: processedCount - failedCount,
              error: error.message
            }
          );

          throw error;
        } finally {
          await page.close();
          await browser.close();
        }
      };

      // Create the job object
      const job = {
        id: `connect_${Date.now()}`,
        type: 'connect',
        campaignId,
        maxProfiles,
        batchSize,
        delayBetweenBatches,
        delayBetweenProfiles,
        sendMessage,
        supabase
      };

      // Send immediate response
      res.json({
        success: true,
        message: 'Connection requests job accepted and queued',
        jobId: job.id
      });

      // Add the job to the queue after sending response
      await jobQueueManager.addJob(jobFunction, job);

    } catch (error) {
      logger.error(`Error in sendConnectionRequestsController: ${error.message}`);
      // Only send response if headers haven't been sent yet
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: error.message });
      }
    }
  };
};

module.exports = sendConnectionRequestsController;