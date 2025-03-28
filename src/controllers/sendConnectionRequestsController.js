const createLogger = require('../utils/logger');
const cookieLoader = require('../modules/cookieLoader');
const zoomHandler = require('../modules/zoomHandler');
const sendConnectionRequestModule = require('../modules/sendConnectionRequest');
const { withTimeout } = require('../utils/databaseUtils');

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

module.exports = (supabase) => {
  return async (req, res) => {
    let jobId = null;

    // Function to process a single job
    const processJob = async (currentJobId) => {
      let browser = null;
      let page = null;

      try {
        const { data: jobData, error: jobFetchError } = await withTimeout(
          supabase
            .from('jobs')
            .select('*')
            .eq('job_id', currentJobId)
            .single(),
          10000,
          'Timeout while fetching job data'
        );

        if (jobFetchError || !jobData) {
          logger.error(`Failed to fetch job ${currentJobId}: ${jobFetchError?.message}`);
          return;
        }

        const campaignId = jobData.campaign_id;
        // Retrieve sendMessage from the result column
        const sendMessage = jobData.result?.sendMessage ?? true; // Default to true if not specified

        const { error: updateStartError } = await withTimeout(
          supabase
            .from('jobs')
            .update({
              status: 'started',
              updated_at: new Date().toISOString(),
            })
            .eq('job_id', currentJobId),
          10000,
          'Timeout while updating job status to started'
        );

        if (updateStartError) {
          logger.error(`Failed to update job ${currentJobId} to started: ${updateStartError.message}`);
          return;
        }

        const { data: campaignData, error: campaignError } = await withTimeout(
          supabase
            .from('campaigns')
            .select('cookies, client_id, connection_messages')
            .eq('id', parseInt(campaignId))
            .single(),
          10000,
          'Timeout while fetching campaign data'
        );

        if (campaignError || !campaignData?.cookies || campaignData.client_id == null) {
          const msg = `Could not load campaign data (cookies or client_id) for campaign ${campaignId}`;
          logger.error(msg);
          await withTimeout(
            supabase
              .from('jobs')
              .update({
                status: 'failed',
                error: msg,
                error_category: 'campaign_load_failed',
                updated_at: new Date().toISOString(),
              })
              .eq('job_id', currentJobId),
            10000,
            'Timeout while updating job status'
          );
          return;
        }

        // Validate connection request message if sendMessage is true
        let connectionRequestMessage = '';
        if (sendMessage) {
          connectionRequestMessage = campaignData.connection_messages?.connection_request_message?.content;
          if (!connectionRequestMessage) {
            const msg = `Connection request message not found in connection_messages for campaign ${campaignId}`;
            logger.error(msg);
            await withTimeout(
              supabase
                .from('jobs')
                .update({
                  status: 'failed',
                  error: msg,
                  error_category: 'invalid_connection_message',
                  updated_at: new Date().toISOString(),
                })
                .eq('job_id', currentJobId),
              10000,
              'Timeout while updating job status'
            );
            return;
          }
        }

        const cookies = [
          { name: 'li_a', value: campaignData.cookies.li_a, domain: '.linkedin.com' },
          { name: 'li_at', value: campaignData.cookies.li_at, domain: '.linkedin.com' },
        ];

        // Launch browser and load cookies (no proxyConfig)
        const { browser: loadedBrowser, page: loadedPage } = await cookieLoader({ cookies, searchUrl: 'https://www.linkedin.com' });
        browser = loadedBrowser;
        page = loadedPage;
        await zoomHandler(page);

        const { sendRequest } = sendConnectionRequestModule(page);

        // Fetch profiles from scraped_profiles where connection_status is 'not sent' or NULL
        const { data: profilesToConnect, error: fetchError } = await withTimeout(
          supabase
            .from('scraped_profiles')
            .select('*')
            .eq('campaign_id', campaignId)
            .or('connection_status.eq.not sent,connection_status.is.null') // Fetch both 'not sent' and NULL
            .limit(jobData.max_profiles || 20),
          10000,
          'Timeout while fetching profiles from scraped_profiles'
        );

        if (fetchError) {
          logger.error(`Failed to fetch profiles from scraped_profiles: ${fetchError.message}`);
          await withTimeout(
            supabase
              .from('jobs')
              .update({
                status: 'failed',
                error: fetchError.message,
                error_category: 'database_fetch_failed',
                updated_at: new Date().toISOString(),
              })
              .eq('job_id', currentJobId),
            10000,
            'Timeout while updating job status'
          );
          return;
        }

        if (!profilesToConnect || profilesToConnect.length === 0) {
          logger.info(`No profiles found in scraped_profiles for campaign ${campaignId} with connection_status 'not sent' or NULL`);
          await withTimeout(
            supabase
              .from('jobs')
              .update({
                status: 'completed',
                progress: 1,
                result: { message: 'No profiles found to send connection requests to', sendMessage },
                updated_at: new Date().toISOString(),
              })
              .eq('job_id', currentJobId),
            10000,
            'Timeout while updating job status'
          );
          return;
        }

        logger.info(`Found ${profilesToConnect.length} profiles to send connection requests to`);

        const totalProfiles = profilesToConnect.length;
        let processedProfiles = 0;
        let successfulRequests = 0;

        for (let i = 0; i < profilesToConnect.length; i += (jobData.batch_size || 5)) {
          const batch = profilesToConnect.slice(i, i + (jobData.batch_size || 5));
          logger.info(`Processing batch ${Math.floor(i / (jobData.batch_size || 5)) + 1} (${batch.length} profiles)`);

          for (const profile of batch) {
            const fullName = `${profile.first_name} ${profile.last_name}`.trim();
            logger.info(`Sending connection request to: ${fullName}`);

            // Personalize the connection message if sendMessage is true
            let personalizedMessage = '';
            if (sendMessage) {
              personalizedMessage = connectionRequestMessage
                .replace('{first_name}', profile.first_name ?? 'there')
                .replace('{last_name}', profile.last_name ?? '')
                .replace('{job_title}', profile.job_title ?? '')
                .replace('{company}', profile.company ?? 'your company');
            }

            try {
              await sendRequest(profile.linkedin, personalizedMessage);

              // Update the profile to mark the connection_status as 'pending'
              const { error: updateError } = await withTimeout(
                supabase
                  .from('scraped_profiles')
                  .update({
                    connection_status: 'pending',
                    error: null,
                  })
                  .eq('id', profile.id),
                10000,
                'Timeout while updating scraped_profiles'
              );

              if (updateError) {
                logger.error(`Failed to update scraped profile ${profile.id}: ${updateError.message}`);
                throw new Error(`Failed to update scraped profile ${profile.id}: ${updateError.message}`);
              }

              successfulRequests++;
              logger.info(`Successfully updated scraped profile ${profile.id} to connection_status 'pending'`);
            } catch (error) {
              logger.error(`Failed to send connection request to ${fullName}: ${error.message}`);
              // Update the profile with the error
              await withTimeout(
                supabase
                  .from('scraped_profiles')
                  .update({ error: error.message })
                  .eq('id', profile.id),
                10000,
                `Timeout while updating scraped profile ${profile.id} with error`
              );
            }

            processedProfiles++;
            const progress = processedProfiles / totalProfiles;
            await withTimeout(
              supabase
                .from('jobs')
                .update({
                  status: 'in_progress',
                  progress,
                  updated_at: new Date().toISOString(),
                })
                .eq('job_id', currentJobId),
              10000,
              'Timeout while updating job progress'
            );

            if (processedProfiles < totalProfiles && batch.indexOf(profile) < batch.length - 1) {
              const delay = randomDelay((jobData.delay_between_profiles || 5000) - 500, (jobData.delay_between_profiles || 5000) + 500);
              logger.info(`Waiting ${delay}ms before processing next profile`);
              await new Promise(resolve => setTimeout(resolve, delay));
              await simulateScroll(page);
            }
          }

          if (i + (jobData.batch_size || 5) < profilesToConnect.length) {
            const delay = randomDelay((jobData.delay_between_batches || 5000) - 1000, (jobData.delay_between_batches || 5000) + 1000);
            logger.info(`Waiting ${delay}ms before processing next batch`);
            await new Promise(resolve => setTimeout(resolve, delay));
            await simulateScroll(page);
          }
        }

        logger.success(`Connection requests sending completed for job ${currentJobId}.`);
        await withTimeout(
          supabase
            .from('jobs')
            .update({
              status: 'completed',
              progress: 1,
              result: {
                totalProfilesProcessed: totalProfiles,
                successfulRequests: successfulRequests,
                sendMessage, // Include sendMessage in the final result
              },
              updated_at: new Date().toISOString(),
            })
            .eq('job_id', currentJobId),
          10000,
          'Timeout while updating job status'
        );
      } catch (error) {
        logger.error(`Error in job ${currentJobId}: ${error.message}`);
        let errorCategory = 'unknown';
        if (error.message.includes('Cookies are invalid')) {
          errorCategory = 'authentication_failed';
        } else if (error.message.includes('waitForSelector')) {
          errorCategory = 'selector_timeout';
        }
        await withTimeout(
          supabase
            .from('jobs')
            .update({
              status: 'failed',
              error: error.message,
              error_category: errorCategory,
              updated_at: new Date().toISOString(),
            })
            .eq('job_id', currentJobId),
          10000,
          'Timeout while updating job status'
        );
      } finally {
        try {
          if (page) await page.close();
          if (browser) await browser.close();
        } catch (err) {
          logger.error(`Failed to close browser or page for job ${currentJobId}: ${err.message}`);
        }
      }
    };

    try {
      // Safely access req.body
      if (!req.body || typeof req.body !== 'object') {
        logger.warn('Request body is missing or invalid');
        return res.status(400).json({
          success: false,
          error: 'Request body is missing or invalid',
        });
      }

      const { campaignId, batchSize = 5, delayBetweenBatches = 5000, delayBetweenProfiles = 5000, maxProfiles = 20, sendMessage = true } = req.body;

      if (!campaignId) {
        logger.warn('Missing required field: campaignId');
        return res.status(400).json({
          success: false,
          error: 'Missing required field: campaignId',
        });
      }

      // Validate maxProfiles (capped at 20)
      if (maxProfiles > 20) {
        logger.warn(`maxProfiles exceeds limit: ${maxProfiles}`);
        return res.status(400).json({
          success: false,
          error: 'maxProfiles cannot exceed 20 to limit connection requests per day',
        });
      }

      // Validate sendMessage
      if (typeof sendMessage !== 'boolean') {
        logger.warn('Invalid sendMessage: must be a boolean');
        return res.status(400).json({
          success: false,
          error: 'Invalid sendMessage: must be a boolean',
        });
      }

      logger.info(`Received request to send connection requests for campaignId: ${campaignId}, sendMessage: ${sendMessage}`);

      const { data: jobData, error: jobError } = await withTimeout(
        supabase
          .from('jobs')
          .insert({
            type: 'send_connection_requests',
            status: 'started',
            progress: 0,
            error: null,
            result: { sendMessage }, // Store sendMessage in the result column
            campaign_id: campaignId,
            batch_size: batchSize,
            delay_between_batches: delayBetweenBatches,
            delay_between_profiles: delayBetweenProfiles,
            max_profiles: maxProfiles,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select('job_id')
          .single(),
        10000,
        'Timeout while creating job in database'
      );

      if (jobError || !jobData) {
        logger.error(`Failed to create job: ${jobError?.message}`);
        return res.status(500).json({ success: false, error: 'Failed to create job' });
      }

      jobId = jobData.job_id;
      logger.info(`Created job with ID: ${jobId} with status: started`);

      res.json({ success: true, jobId });

      setImmediate(() => {
        processJob(jobId).catch(err => {
          logger.error(`Background processing failed for job ${jobId}: ${err.message}`);
        });
      });
    } catch (error) {
      logger.error(`Error in /send-connection-requests route: ${error.message}`);
      if (jobId) {
        await withTimeout(
          supabase
            .from('jobs')
            .update({
              status: 'failed',
              error: error.message,
              error_category: 'request_validation_failed',
              updated_at: new Date().toISOString(),
            })
            .eq('job_id', jobId),
          10000,
          'Timeout while updating job status'
        );
      }
      return res.status(500).json({ success: false, error: error.message });
    }
  };
};