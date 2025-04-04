const createLogger = require('../utils/logger');
const { withTimeout } = require('../utils/databaseUtils');
const checkConnectionRequestsModule = require('../modules/checkConnectionRequests');
const { bot, sendJobStatusReport } = require('../telegramBot');
const jobQueueManager = require('../utils/jobQueueManager');
const { logActivity } = require('../utils/activityLogger');

const logger = createLogger();

// Random delay between min and max milliseconds
const randomDelay = (min, max) =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

// Process the job asynchronously
const processJob = async (currentJobId, supabase) => {
  const startTime = new Date().toISOString();
  let connectionChecker = null;
  let page = null;
  let browser = null;

  try {
    // Get job details
    const { data: job, error: jobError } = await withTimeout(
      supabase
        .from('jobs')
        .select('*')
        .eq('job_id', currentJobId)
        .single(),
      10000,
      'Timeout while fetching job'
    );

    if (jobError) throw new Error(`Failed to fetch job: ${jobError.message}`);
    
    const campaignId = job.campaign_id;
    
    // Log activity start
    await logActivity(supabase, campaignId, 'connection_check', 'running', 
      { total: 0, successful: 0, failed: 0 }, 
      null,
      { startTime }
    );

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
        .order('last_checked', { nullsFirst: true })  // NULL values first, then oldest checked
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

            // First check if lead already exists - get ALL matching leads
            const { data: existingLeads, error: checkLeadError } = await withTimeout(
              supabase
                .from('leads')
                .select('id, linkedin')
                .eq('client_id', campaignData.client_id)
                .eq('linkedin', profile.linkedin),
              10000,
              `Timeout while checking existing leads for profile ${profile.id}`
            );

            if (checkLeadError) {
              throw new Error(`Failed to check existing leads for profile ${profile.id}: ${checkLeadError.message}`);
            }

            // Handle existing leads
            if (existingLeads && existingLeads.length > 0) {
              logger.info(`Found ${existingLeads.length} existing lead(s) for profile ${profile.id}`);
              // Update the first lead we found
              const leadToUpdate = existingLeads[0];
              const { error: updateLeadError } = await withTimeout(
                supabase
                  .from('leads')
                  .update({
                    first_name: profile.first_name,
                    last_name: profile.last_name,
                    company: profile.company,
                    position: profile.job_title,
                    companyLink: profile.companylink,
                    connection_level: '1st',
                    is_open_profile: false,
                    error: null,
                  })
                  .eq('id', leadToUpdate.id),
                10000,
                `Timeout while updating lead ${leadToUpdate.id}`
              );

              if (updateLeadError) {
                throw new Error(`Failed to update lead ${leadToUpdate.id}: ${updateLeadError.message}`);
              }

              // If we found multiple leads, log it as a warning
              if (existingLeads.length > 1) {
                logger.warn(`Multiple leads found for profile ${profile.id} (${profile.linkedin}). Updated lead ${leadToUpdate.id}`);
              }
            } else {
              // Insert new lead
              const { error: insertLeadError } = await withTimeout(
                supabase
                  .from('leads')
                  .insert({
                    client_id: campaignData.client_id,
                    first_name: profile.first_name,
                    last_name: profile.last_name,
                    company: profile.company,
                    position: profile.job_title,
                    linkedin: profile.linkedin,
                    companyLink: profile.companylink,
                    connection_level: '1st',
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
              logger.info(`Created new lead for profile ${profile.id}`);
            }

            profilesMovedToLeads++;

            // Always update the scraped profile status to connected
            const { error: updateProfileError } = await withTimeout(
              supabase
                .from('scraped_profiles')
                .update({
                  connection_status: 'connected',
                  error: null,
                  last_checked: new Date().toISOString(),
                })
                .eq('id', profile.id),
              10000,
              `Timeout while updating scraped profile ${profile.id}`
            );

            if (updateProfileError) {
              throw new Error(`Failed to update scraped profile ${profile.id}: ${updateProfileError.message}`);
            }
            logger.info(`Updated profile ${profile.id} to connected status`);
          } else if (result.status === 'pending') {
            // Update the last_checked timestamp even for pending profiles
            const { error: updateProfileError } = await withTimeout(
              supabase
                .from('scraped_profiles')
                .update({
                  connection_status: 'pending',
                  error: null,
                  last_checked: new Date().toISOString(),
                })
                .eq('id', profile.id),
              10000,
              `Timeout while updating scraped profile ${profile.id}`
            );

            if (updateProfileError) {
              throw new Error(`Failed to update scraped profile ${profile.id}: ${updateProfileError.message}`);
            }
            logger.info(`Connection request for ${fullName} is still pending.`);
          } else if (result.status === 'not_sent') {
            // Update the profile to allow retrying
            const { error: updateProfileError } = await withTimeout(
              supabase
                .from('scraped_profiles')
                .update({
                  connection_status: 'not sent',
                  error: null,
                  last_checked: new Date().toISOString(),
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
              .update({
                error: error.message,
                last_checked: new Date().toISOString(),
              })
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
          logger.info('Waiting between profile checks...');
          await randomDelay(1000, 3000);
        }
      }

      // Small delay between batches
      if (i + batchSize < profiles.length) {
        logger.info('Waiting between batches...');
        await randomDelay(3000, 5000);
      }
    }

    // Log final activity
    const endTime = new Date().toISOString();
    const duration = new Date(endTime) - new Date(startTime);
    const avgTimePerProfile = duration / processedProfiles;

    await logActivity(supabase, campaignId, 'connection_check', 'success', 
      { 
        total: processedProfiles,
        successful: profilesAccepted,
        failed: failedChecks.length
      },
      null,
      {
        profilesAccepted,
        profilesMovedToLeads,
        failedChecks,
        duration,
        avgTimePerProfile,
        startTime,
        endTime
      }
    );

    // Get campaign name for reporting
    const { data: campaignNameData, error: campaignNameError } = await withTimeout(
      supabase
        .from('campaigns')
        .select('name')
        .eq('id', campaignId)
        .single(),
      10000,
      'Timeout while fetching campaign name'
    );

    if (campaignNameError) {
      logger.warn(`Could not fetch campaign name: ${campaignNameError.message}`);
    }

    // Send job completion report
    const message = `Connection checks completed for campaign ${campaignId}:\n` +
      `✅ Total Processed: ${totalProfiles}\n` +
      `🤝 Accepted: ${profilesAccepted}\n` +
      `📥 Moved to Leads: ${profilesMovedToLeads}\n` +
      `❌ Failed Checks: ${failedChecks.length}`;

    await sendJobStatusReport(
      currentJobId,
      'check',
      'completed',
      {
        campaignId,
        campaignName: campaignNameData?.name,
        message,
        totalChecked: totalProfiles,
        acceptedCount: profilesAccepted,
        movedToLeadsCount: profilesMovedToLeads,
        failedCount: failedChecks.length
      }
    );

    // Update job status to completed
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'completed',
          progress: 1,
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

    logger.info(`Job ${currentJobId} completed successfully`);
  } catch (error) {
    logger.error(`Job ${currentJobId} failed: ${error.message}`);

    // Log failed activity
    await logActivity(supabase, campaignId, 'connection_check', 'failed', 
      { total: 0, successful: 0, failed: 0 },
      error.message,
      { startTime }
    );

    // Update job status to failed
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'failed',
          error: error.message,
          error_category: 'unknown',
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', currentJobId),
      10000,
      'Timeout while updating job status'
    );

    // Send Telegram notification
    await bot.sendMessage(
      process.env.TELEGRAM_NOTIFICATION_CHAT_ID,
      `❌ Connection request check failed for campaign ${campaignId}: ${error.message}`
    );

    // Send job completion report
    await sendJobStatusReport(
      currentJobId,
      'check',
      'failed',
      {
        campaignId,
        campaignName: campaignNameData?.name,
        message: `❌ Connection checks failed for campaign ${campaignId}:\n${error.message}`,
        totalChecked: totalProfiles || 0,
        acceptedCount: profilesAccepted || 0,
        movedToLeadsCount: profilesMovedToLeads || 0,
        failedCount: failedChecks.length || 0,
        error: error.message
      }
    );
  } finally {
    try {
      if (connectionChecker) {
        await connectionChecker.closeBrowser();
      }
      if (page) await page.close();
      if (browser) await browser.close();
    } catch (err) {
      logger.error(`Failed to close browser or page: ${err.message}`);
    }
  }
};

/**
 * Creates a controller function for checking connection requests
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase - Supabase client instance
 * @returns {Function} Express route handler
 */
module.exports = (supabase) => {
  /**
   * Express route handler for checking connection requests
   * @param {import('express').Request} req - Express request object
   * @param {import('express').Response} res - Express response object
   * @returns {Promise<void>}
   */
  return async (req, res) => {
    let jobId = null;

    try {
      // Validate request body
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
          success: false,
          error: 'Request body is missing or invalid'
        });
      }

      const { 
        campaignId, 
        batchSize = 5, 
        maxProfiles = 50 
      } = req.body;

      if (!campaignId) {
        return res.status(400).json({
          success: false,
          error: 'campaignId is required'
        });
      }

      // Create a job record
      const { data: jobData, error: jobError } = await withTimeout(
        supabase
          .from('jobs')
          .insert({
            type: 'check_connection_requests',
            status: 'queued',
            campaign_id: campaignId,
            batch_size: batchSize,
            max_profiles: maxProfiles,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select()
          .single(),
        10000,
        'Timeout while creating job record'
      );

      if (jobError) {
        logger.error(`Failed to create job record: ${jobError.message}`);
        return res.status(500).json({
          success: false,
          error: `Failed to create job record: ${jobError.message}`
        });
      }

      jobId = jobData.job_id;
      logger.info(`Created job with ID: ${jobId}`);

      // Return success response with job ID
      res.status(200).json({
        success: true,
        jobId
      });

      // Queue the job for processing
      jobQueueManager.addJob(() => processJob(jobId, supabase), {
        jobId,
        type: 'check_connection_requests',
        campaignId
      }).catch(err => {
        logger.error(`Queue processing failed for job ${jobId}: ${err.message}`);
      });

    } catch (error) {
      logger.error(`Error in check-connection-requests route: ${error.message}`);
      
      // If we created a job but something else failed, update its status
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

      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  };
};