const createLogger = require('../utils/logger');
const zoomHandler = require('../modules/zoomHandler');
const sendConnectionRequestModule = require('../modules/sendConnectionRequest');
const { withTimeout, getScrapedProfiles, updateScrapedProfile } = require('../utils/databaseUtils');
const jobQueueManager = require('../utils/jobQueueManager');
const puppeteer = require('puppeteer');
const { bot, sendJobStatusReport } = require('../telegramBot');
const { personalizeMessage } = require('../utils/messageUtils');
const ResistanceHandler = require('../utils/resistanceHandler');
const { logActivity } = require('../utils/activityLogger');

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

// Function to update daily connection count
async function updateDailyConnectionCount(supabase, campaignId, connectionsToAdd) {
  const today = new Date().toISOString().split('T')[0];
  
  try {
    // First try to update existing record
    const { data: existing, error: selectError } = await supabase
      .from('daily_connection_tracking')
      .select('connections_sent')
      .eq('campaign_id', campaignId)
      .eq('date', today)
      .single();

    if (selectError && selectError.code !== 'PGRST116') { // PGRST116 is "not found"
      throw selectError;
    }

    if (existing) {
      // Update existing record
      const { error: updateError } = await supabase
        .from('daily_connection_tracking')
        .update({ connections_sent: existing.connections_sent + connectionsToAdd })
        .eq('campaign_id', campaignId)
        .eq('date', today);

      if (updateError) throw updateError;
    } else {
      // Insert new record
      const { error: insertError } = await supabase
        .from('daily_connection_tracking')
        .insert({
          campaign_id: campaignId,
          date: today,
          connections_sent: connectionsToAdd
        });

      if (insertError) throw insertError;
    }
  } catch (error) {
    logger.error(`Failed to update daily connection count for campaign ${campaignId}: ${error.message}`);
    throw error;
  }
}

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
  const resistanceHandler = new ResistanceHandler(supabase);

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
        sendMessage = true,
        maxRetries = 3
      } = req.body;

      // Validate required fields
      if (!campaignId) {
        return res.status(400).json({
          success: false,
          error: 'campaignId is required'
        });
      }

      // Create a job function that will be executed by the queue
      const jobFunction = async () => {
        let browser = null;
        let page = null;
        
        // Initialize counters outside try block so they're accessible in catch
        let processedCount = 0;
        let sentCount = 0;
        let pendingCount = 0;
        let connectedCount = 0;
        let followingCount = 0;
        let failedCount = 0;
        
        try {
          // Fetch campaign data to get cookies and message template
          const { data: campaignData, error: campaignError } = await withTimeout(
            supabase
              .from('campaigns')
              .select('name, cookies, connection_messages')
              .eq('id', campaignId)
              .single(),
            10000,
            'Timeout while fetching campaign data'
          );

          if (campaignError || !campaignData?.cookies) {
            throw new Error(`Failed to load campaign data: ${campaignError?.message || 'No cookies found'}`);
          }

          // Initialize browser
          browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          });

          page = await browser.newPage();
          await page.setViewport({ width: 1280, height: 800 });
          await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

          // Set LinkedIn cookies
          await page.setCookie(
            { name: 'li_at', value: campaignData.cookies.li_at, domain: '.linkedin.com', path: '/' },
            { name: 'li_a', value: campaignData.cookies.li_a, domain: '.linkedin.com', path: '/' }
          );

          // Get profiles to process
          const profiles = await getScrapedProfiles(supabase, campaignId, maxProfiles);
          
          if (!profiles || profiles.length === 0) {
            logger.info('No profiles to process');
            return;
          }

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

                // Check if we've already tried this profile too many times
                const { data: attempts } = await supabase
                  .from('connection_request_attempts')
                  .select('attempts')
                  .eq('profile_id', profile.id)
                  .single();

                if (attempts && attempts.attempts >= maxRetries) {
                  logger.warn(`Profile ${profile.id} has reached maximum retry attempts`);
                  failedCount++;
                  processedCount++;
                  continue;
                }

                // Personalize the message if needed
                let personalizedMessage = null;
                if (sendMessage && campaignData?.connection_messages?.connection_request_message?.content) {
                  personalizedMessage = personalizeMessage(
                    campaignData.connection_messages.connection_request_message.content,
                    {
                      first_name: profile.first_name,
                      last_name: profile.last_name,
                      company: profile.company,
                      job_title: profile.job_title,
                      linkedin: profile.linkedin
                    },
                    null,
                    null
                  );
                }

                // Send the connection request
                const result = await sendRequest(profile.linkedin, personalizedMessage);

                // Update profile status based on result
                if (result.success) {
                  // Update profile status
                  await supabase
                    .from('scraped_profiles')
                    .update({
                      connection_status: result.status,
                      last_connection_attempt: new Date().toISOString(),
                      connection_error: null
                    })
                    .eq('id', profile.id);

                  // Track the attempt
                  await supabase
                    .from('connection_request_attempts')
                    .upsert({
                      profile_id: profile.id,
                      campaign_id: campaignId,
                      attempts: (attempts?.attempts || 0) + 1,
                      last_attempt: new Date().toISOString(),
                      status: result.status,
                      error: null
                    });

                  if (result.status === 'pending') {
                    sentCount++;
                  } else if (result.status === 'connected') {
                    connectedCount++;
                  } else if (result.status === 'following') {
                    followingCount++;
                  }
                } else {
                  // Update profile with error
                  await supabase
                    .from('scraped_profiles')
                    .update({
                      connection_status: 'failed',
                      last_connection_attempt: new Date().toISOString(),
                      connection_error: result.error
                    })
                    .eq('id', profile.id);

                  // Track the failed attempt
                  await supabase
                    .from('connection_request_attempts')
                    .upsert({
                      profile_id: profile.id,
                      campaign_id: campaignId,
                      attempts: (attempts?.attempts || 0) + 1,
                      last_attempt: new Date().toISOString(),
                      status: 'failed',
                      error: result.error
                    });

                  failedCount++;
                }

                processedCount++;
                await new Promise(resolve => setTimeout(resolve, delayBetweenProfiles));
              } catch (error) {
                logger.error(`Error processing profile ${profile.id}: ${error.message}`);
                failedCount++;
                processedCount++;

                // Track the error
                await supabase
                  .from('connection_request_attempts')
                  .upsert({
                    profile_id: profile.id,
                    campaign_id: campaignId,
                    attempts: (attempts?.attempts || 0) + 1,
                    last_attempt: new Date().toISOString(),
                    status: 'error',
                    error: error.message
                  });
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
              campaignName: campaignData.name,
              message,
              savedCount: sentCount,
              totalScraped: processedCount,
              totalValid: processedCount - failedCount
            }
          );

          logger.success(`Connection requests sending completed for job ${job.id}.`);

          // After processing connections, update the activity log with results
          await logActivity(supabase, campaignId, 'connection_request', 'success', {
            total: processedCount,
            successful: sentCount,
            failed: failedCount
          }, null, {
            batchSize,
            maxProfiles,
            pendingCount,
            connectedCount,
            followingCount
          });

          // Update daily connection tracking
          await updateDailyConnectionCount(supabase, campaignId, sentCount);

          return { success: true };
        } catch (error) {
          // Check for resistance in any uncaught errors
          await resistanceHandler.handleResistance(campaignId, error.message);
          logger.error(`Error processing connection requests job ${job.id}: ${error.message}`);
          
          // Send error notification
          await sendJobStatusReport(
            job.id,
            'connect',
            'failed',
            {
              campaignId,
              campaignName: campaignData?.name,
              message: `❌ Connection requests failed for campaign ${campaignId}:\n${error.message}`,
              savedCount: sentCount,
              totalScraped: processedCount,
              totalValid: processedCount - failedCount,
              error: error.message
            }
          );

          // Log failed activity
          await logActivity(supabase, campaignId, 'connection_request', 'failed', 
            { total: 0, successful: 0, failed: 0 }, 
            error.message,
            { jobId: job.id }
          );

          throw error;
        } finally {
          // Safely close browser and page instances
          if (page) {
            try {
              await page.close();
            } catch (e) {
              logger.error(`Error closing page: ${e.message}`);
            }
          }
          if (browser) {
            try {
              await browser.close();
            } catch (e) {
              logger.error(`Error closing browser: ${e.message}`);
            }
          }
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