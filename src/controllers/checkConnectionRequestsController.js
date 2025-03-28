const createLogger = require('../utils/logger');
const { withTimeout } = require('../utils/databaseUtils');
const checkConnectionRequestsModule = require('../modules/checkConnectionRequests');
const { bot } = require('../telegramBot');

// Random delay between min and max milliseconds
const randomDelay = (min, max) =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

// Process the job asynchronously
const processJob = async (currentJobId, supabase) => {
  const logger = createLogger();
  let connectionChecker = null;

  try {
    // Fetch job data
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

    const campaignId = parseInt(jobData.campaign_id);
    const maxProfiles = jobData.max_profiles;
    const batchSize = jobData.batch_size;

    // Update job status to started
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

    // Fetch campaign data
    const { data: campaignData, error: campaignError } = await withTimeout(
      supabase
        .from('campaigns')
        .select('client_id, cookies')
        .eq('id', campaignId)
        .single(),
      10000,
      'Timeout while fetching campaign data'
    );

    if (campaignError || !campaignData?.cookies) {
      const msg = `Could not load campaign data (cookies) for campaign ${campaignId}`;
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

    // Fetch profiles with pending connection requests
    const { data: profiles, error: fetchError } = await withTimeout(
      supabase
        .from('scraped_profiles')
        .select('*')
        .eq('campaign_id', campaignId.toString())
        .eq('connection_status', 'pending')
        .limit(maxProfiles),
      10000,
      'Timeout while fetching profiles'
    );

    if (fetchError) {
      logger.error(`Failed to fetch profiles: ${fetchError.message}`);
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

    if (!profiles || profiles.length === 0) {
      logger.info(`No pending connection requests found for campaign ${campaignId}`);
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            status: 'completed',
            progress: 1,
            result: { message: 'No pending connection requests to check' },
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job status'
      );
      return;
    }

    logger.info(`Found ${profiles.length} profiles with pending connection requests for campaign ${campaignId}`);

    // Initialize the connection checker
    connectionChecker = checkConnectionRequestsModule();
    await connectionChecker.initializeBrowser(campaignData.cookies);

    const totalProfiles = profiles.length;
    let processedProfiles = 0;
    let profilesAccepted = 0;
    let profilesMovedToLeads = 0;
    const failedChecks = [];
    let consecutiveFailures = 0;

    // Process profiles in batches
    for (let i = 0; i < profiles.length; i += batchSize) {
      const batch = profiles.slice(i, i + batchSize);
      logger.info(`Processing batch ${Math.floor(i / batchSize) + 1} (${batch.length} profiles)`);

      for (const profile of batch) {
        const fullName = `${profile.first_name} ${profile.last_name}`.trim();
        logger.info(`Checking connection status for ${fullName}`);

        try {
          const result = await connectionChecker.checkConnectionStatus(profile.linkedin);

          if (result.status === 'accepted') {
            profilesAccepted++;

            // Move the profile to the leads table
            const { error: insertLeadError } = await withTimeout(
              supabase
                .from('leads')
                .insert({
                  client_id: campaignData.client_id,
                  first_name: profile.first_name,
                  last_name: profile.last_name,
                  company: profile.company,
                  position: profile.job_title, // Map job_title to position
                  linkedin: profile.linkedin,
                  companyLink: profile.companylink,
                  connection_level: '1st', // Set to 1st since the connection was accepted
                  is_open_profile: false,
                  message_sent: false,
                  message_stage: null,
                  last_contacted: null,
                  status: 'not_replied',
                }),
              10000,
              `Timeout while inserting lead for profile ${profile.id}`
            );

            if (insertLeadError) {
              throw new Error(`Failed to insert lead for profile ${profile.id}: ${insertLeadError.message}`);
            }

            profilesMovedToLeads++;

            // Update the scraped_profiles entry
            const { error: updateProfileError } = await withTimeout(
              supabase
                .from('scraped_profiles')
                .update({
                  connection_status: 'connected', // Changed from 'accepted' to 'connected'
                  error: null,
                })
                .eq('id', profile.id),
              10000,
              `Timeout while updating scraped profile ${profile.id}`
            );

            if (updateProfileError) {
              throw new Error(`Failed to update scraped profile ${profile.id}: ${updateProfileError.message}`);
            }
          } else if (result.status === 'pending') {
            // Leave the profile unchanged
            logger.info(`Connection request for ${fullName} is still pending.`);
          } else if (result.status === 'not_sent') {
            // Update the profile to allow retrying
            const { error: updateProfileError } = await withTimeout(
              supabase
                .from('scraped_profiles')
                .update({
                  connection_status: 'not sent', // Fixed to 'not sent'
                  error: null,
                })
                .eq('id', profile.id),
              10000,
              `Timeout while updating scraped profile ${profile.id}`
            );

            if (updateProfileError) {
              throw new Error(`Failed to update scraped profile ${profile.id}: ${updateProfileError.message}`);
            }
          }

          consecutiveFailures = 0;
        } catch (error) {
          logger.error(`Failed to check connection status for profile ${profile.id}: ${error.message}`);
          consecutiveFailures++;
          failedChecks.push({ profileId: profile.id, error: error.message });

          // Update the profile with the error
          await withTimeout(
            supabase
              .from('scraped_profiles')
              .update({ error: error.message })
              .eq('id', profile.id),
            10000,
            `Timeout while updating scraped profile ${profile.id} with error`
          );

          // Check for 3 consecutive failures
          if (consecutiveFailures >= 3) {
            const msg = `Job stopped due to 3 consecutive failures. Last error: ${error.message}`;
            logger.error(msg);

            // Send Telegram notification
            await bot.sendMessage(
              process.env.TELEGRAM_NOTIFICATION_CHAT_ID,
              `❌ Connection request check failed for campaign ${campaignId}: ${msg}`
            );

            await withTimeout(
              supabase
                .from('jobs')
                .update({
                  status: 'failed',
                  error: msg,
                  error_category: 'consecutive_failures',
                  result: {
                    totalProfilesChecked: processedProfiles,
                    profilesAccepted,
                    profilesMovedToLeads,
                    failedChecks,
                  },
                  updated_at: new Date().toISOString(),
                })
                .eq('job_id', currentJobId),
              10000,
              'Timeout while updating job status'
            );
            return;
          }
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

        // Small delay between profiles within a batch
        if (batch.indexOf(profile) < batch.length - 1) {
          logger.info(`Waiting 1-2 seconds before the next profile...`);
          await randomDelay(1000, 2000);
        }
      }

      // Delay between batches
      if (i + batchSize < profiles.length) {
        logger.info(`Waiting 5-10 seconds before the next batch...`);
        await randomDelay(5000, 10000);
      }
    }

    logger.success(`Connection request check completed for job ${currentJobId}.`);
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'completed',
          progress: 1,
          result: {
            totalProfilesChecked: totalProfiles,
            profilesAccepted,
            profilesMovedToLeads,
            failedChecks,
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

    // Send Telegram notification for general failure
    await bot.sendMessage(
      process.env.TELEGRAM_NOTIFICATION_CHAT_ID,
      `❌ Connection request check failed for job ${currentJobId}: ${error.message}`
    );
  } finally {
    if (connectionChecker) {
      await connectionChecker.closeBrowser();
    }
  }
};

// Factory function pattern
module.exports = (supabase) => {
  return async (req, res) => {
    const logger = createLogger();

    let jobId = null;

    try {
      if (!req.body || typeof req.body !== 'object') {
        logger.warn('Request body is missing or invalid');
        return res.status(400).json({
          success: false,
          error: 'Request body is missing or invalid',
        });
      }

      const {
        campaignId,
        maxProfiles = 20,
        batchSize = 5,
      } = req.body;

      if (!campaignId) {
        logger.warn('Missing required field: campaignId');
        return res.status(400).json({
          success: false,
          error: 'Missing required field: campaignId',
        });
      }

      if (!Number.isInteger(maxProfiles) || maxProfiles < 1) {
        logger.warn('Invalid maxProfiles: must be a positive integer');
        return res.status(400).json({
          success: false,
          error: 'Invalid maxProfiles: must be a positive integer',
        });
      }

      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maxProfiles) {
        logger.warn('Invalid batchSize: must be a positive integer less than or equal to maxProfiles');
        return res.status(400).json({
          success: false,
          error: 'Invalid batchSize: must be a positive integer less than or equal to maxProfiles',
        });
      }

      logger.info(`Received request to check connection requests for campaignId: ${campaignId}`);

      // Create a job
      const { data: jobData, error: jobError } = await withTimeout(
        supabase
          .from('jobs')
          .insert({
            type: 'check_connection_requests',
            status: 'started',
            progress: 0,
            error: null,
            result: null,
            campaign_id: campaignId.toString(),
            max_profiles: maxProfiles,
            batch_size: batchSize,
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

      // Process the job asynchronously
      setImmediate(() => {
        processJob(jobId, supabase).catch((err) => {
          logger.error(`Background processing failed for job ${jobId}: ${err.message}`);
        });
      });
    } catch (error) {
      logger.error(`Error in /check-connection-requests route: ${error.message}`);
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