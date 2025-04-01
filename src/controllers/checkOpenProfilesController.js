const createLogger = require('../utils/logger');
const cookieLoader = require('../modules/cookieLoader');
const zoomHandler = require('../modules/zoomHandler');
const openProfilesModule = require('../modules/openProfiles');
const { insertLeads, insertScrapedProfiles, withTimeout } = require('../utils/databaseUtils');
const jobQueueManager = require('../utils/jobQueueManager');
const puppeteer = require('puppeteer');
const { bot } = require('../telegramBot');

const logger = createLogger();

/**
 * Creates a controller function for checking open profiles
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase - Supabase client instance
 * @returns {Function} Express route handler
 */
module.exports = (supabase) => {
  /**
   * Express route handler for checking open profiles
   * @param {import('express').Request} req - Express request object
   * @param {import('express').Response} res - Express response object
   * @returns {Promise<void>}
   */
  return async (req, res) => {
    let jobId = null;

    try {
      // Validate request body
      if (!req.body || typeof req.body !== 'object') {
        logger.warn('Request body is missing or invalid');
        return res.status(400).json({
          success: false,
          error: 'Request body is missing or invalid',
        });
      }

      const { campaignId, batchSize = 5, delayBetweenBatches = 5000, delayBetweenProfiles = 2000, maxProfiles = 100 } = req.body;

      // Validate required fields
      if (!campaignId) {
        logger.warn('Missing required field: campaignId');
        return res.status(400).json({
          success: false,
          error: 'Missing required field: campaignId',
        });
      }

      // Create a new job record
      const { data: jobData, error: jobError } = await withTimeout(
        supabase
          .from('jobs')
          .insert({
            type: 'check_open_profiles',
            status: 'queued',
            campaign_id: campaignId,
            batch_size: batchSize,
            delay_between_batches: delayBetweenBatches,
            delay_between_profiles: delayBetweenProfiles,
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
          error: `Failed to create job record: ${jobError.message}`,
        });
      }

      jobId = jobData.job_id;
      logger.info(`Created job with ID: ${jobId} with status: ${jobData.status}`);

      // Return success response with job ID
      res.status(200).json({
        success: true,
        jobId,
      });

      // Define the job function
      const jobFunction = async () => {
        let browser = null;
        let page = null;

        try {
          // Update job status to started
          await withTimeout(
            supabase
              .from('jobs')
              .update({
                status: 'started',
                updated_at: new Date().toISOString(),
              })
              .eq('job_id', jobId),
            10000,
            'Timeout while updating job status to started'
          );

          // Fetch job data
          const { data: jobData, error: jobFetchError } = await withTimeout(
            supabase
              .from('jobs')
              .select('*')
              .eq('job_id', jobId)
              .single(),
            10000,
            'Timeout while fetching job data'
          );

          if (jobFetchError || !jobData) {
            logger.error(`Failed to fetch job ${jobId}: ${jobFetchError?.message}`);
            return;
          }

          const campaignId = jobData.campaign_id;

          // Fetch campaign data
          const { data: campaignData, error: campaignError } = await withTimeout(
            supabase
              .from('campaigns')
              .select('cookies, client_id')
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
                .eq('job_id', jobId),
              10000,
              'Timeout while updating job status'
            );
            return;
          }

          const { cookies, error: cookieError } = await cookieLoader(supabase, { campaignId });
          if (cookieError || !cookies) {
            const msg = `Failed to load LinkedIn cookies: ${cookieError || 'No valid cookies found'}`;
            logger.error(msg);
            await withTimeout(
              supabase
                .from('jobs')
                .update({
                  status: 'failed',
                  error: msg,
                  error_category: 'cookie_load_failed',
                  updated_at: new Date().toISOString(),
                })
                .eq('job_id', jobId),
              10000,
              'Timeout while updating job status'
            );
            return;
          }

          // Initialize browser
          browser = await puppeteer.launch({
            headless: true,
            args: ['--start-maximized'],
          });

          page = await browser.newPage();
          await page.setViewport({ width: 1280, height: 800 });

          // Set LinkedIn cookies
          await page.setCookie(
            { name: 'li_at', value: cookies.li_at, domain: '.linkedin.com' },
            { name: 'li_a', value: cookies.li_a, domain: '.linkedin.com' }
          );

          await zoomHandler(page);

          const { checkOpenProfile } = openProfilesModule(page);

          // Fetch premium profiles to check
          const { data: premiumProfiles, error: fetchError } = await withTimeout(
            supabase
              .from('premium_profiles')
              .select('*')
              .eq('campaign_id', campaignId.toString())
              .eq('is_checked', false)
              .eq('moved_to_scraped', false)
              .limit(jobData.max_profiles || 50),
            10000,
            'Timeout while fetching premium profiles'
          );

          if (fetchError) {
            logger.error(`Failed to fetch premium profiles: ${fetchError.message}`);
            await withTimeout(
              supabase
                .from('jobs')
                .update({
                  status: 'failed',
                  error: fetchError.message,
                  error_category: 'database_fetch_failed',
                  updated_at: new Date().toISOString(),
                })
                .eq('job_id', jobId),
              10000,
              'Timeout while updating job status'
            );
            return;
          }

          if (!premiumProfiles || premiumProfiles.length === 0) {
            logger.info(`No unchecked premium profiles found for campaign ${campaignId}`);
            await withTimeout(
              supabase
                .from('jobs')
                .update({
                  status: 'completed',
                  progress: 1,
                  result: { message: 'No unchecked premium profiles found' },
                  updated_at: new Date().toISOString(),
                })
                .eq('job_id', jobId),
              10000,
              'Timeout while updating job status'
            );
            return;
          }

          logger.info(`Found ${premiumProfiles.length} unchecked premium profiles to process`);

          const totalProfiles = premiumProfiles.length;
          let processedProfiles = 0;
          const openProfiles = [];
          const nonOpenProfiles = [];

          // Process profiles in batches
          for (let i = 0; i < premiumProfiles.length; i += (jobData.batch_size || 10)) {
            const batch = premiumProfiles.slice(i, i + (jobData.batch_size || 10));
            logger.info(`Processing batch ${Math.floor(i / (jobData.batch_size || 10)) + 1} (${batch.length} profiles)`);

            for (const profile of batch) {
              logger.info(`Visiting profile: ${profile.full_name}`);

              const isOpen = await checkOpenProfile(profile.linkedin);
              const status = isOpen ? 'Open Profile' : 'not an Open Profile';
              logger.info(`${profile.full_name} is ${status}`);

              logger.info(`Updating premium profile ${profile.id} with is_open_profile: ${isOpen}`);

              const { data: updatedData, error: updateError } = await withTimeout(
                supabase
                  .from('premium_profiles')
                  .update({
                    is_checked: true,
                    is_open_profile: isOpen,
                  })
                  .eq('id', profile.id)
                  .select(),
                10000,
                'Timeout while updating premium_profiles'
              );

              if (updateError) {
                logger.error(`Failed to update premium profile ${profile.id}: ${updateError.message}`);
                await withTimeout(
                  supabase
                    .from('jobs')
                    .update({
                      status: 'failed',
                      error: updateError.message,
                      error_category: 'database_update_failed',
                      updated_at: new Date().toISOString(),
                    })
                    .eq('job_id', jobId),
                  10000,
                  'Timeout while updating job status'
                );
                return;
              }

              logger.info(`Updated premium profile ${profile.id}: ${JSON.stringify(updatedData)}`);

              // Update the profile object in memory with the new is_open_profile value
              profile.is_open_profile = isOpen;

              if (isOpen) {
                openProfiles.push(profile);
              } else {
                nonOpenProfiles.push(profile);
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
                  .eq('job_id', jobId),
                10000,
                'Timeout while updating job progress'
              );

              if (processedProfiles < totalProfiles && batch.indexOf(profile) < batch.length - 1) {
                logger.info(`Waiting ${delayBetweenProfiles}ms before processing next profile`);
                await new Promise(resolve => setTimeout(resolve, delayBetweenProfiles));
              }
            }

            if (i + (jobData.batch_size || 10) < premiumProfiles.length) {
              logger.info(`Waiting ${delayBetweenBatches}ms before processing next batch`);
              await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
            }
          }

          let totalMovedToLeads = 0;
          let totalMovedToScraped = 0;

          // Process open profiles
          if (openProfiles.length > 0) {
            totalMovedToLeads = await insertLeads(supabase, openProfiles, campaignData.client_id);

            const openProfileIds = openProfiles.map(profile => profile.id);
            const { error: updateLeadsError } = await withTimeout(
              supabase
                .from('premium_profiles')
                .update({
                  moved_to_leads: true,
                })
                .in('id', openProfileIds),
              10000,
              'Timeout while updating premium_profiles for leads'
            );

            if (updateLeadsError) {
              logger.error(`Failed to update premium_profiles for leads: ${updateLeadsError.message}`);
              throw new Error(`Failed to update premium_profiles for leads: ${updateLeadsError.message}`);
            }
          }

          // Process non-open profiles
          if (nonOpenProfiles.length > 0) {
            totalMovedToScraped = await insertScrapedProfiles(supabase, nonOpenProfiles);

            const nonOpenProfileIds = nonOpenProfiles.map(profile => profile.id);
            const { error: updateScrapedError } = await withTimeout(
              supabase
                .from('premium_profiles')
                .update({
                  moved_to_scraped: true,
                })
                .in('id', nonOpenProfileIds),
              10000,
              'Timeout while updating premium_profiles for scraped_profiles'
            );

            if (updateScrapedError) {
              logger.error(`Failed to update premium_profiles for scraped_profiles: ${updateScrapedError.message}`);
              throw new Error(`Failed to update premium_profiles for scraped_profiles: ${updateScrapedError.message}`);
            }
          }

          logger.success(`Open Profiles check completed for job ${jobId}.`);
          await withTimeout(
            supabase
              .from('jobs')
              .update({
                status: 'completed',
                progress: 1,
                result: {
                  totalProfilesChecked: totalProfiles,
                  totalOpenProfiles: openProfiles.length,
                  totalMovedToLeads: totalMovedToLeads,
                  totalMovedToScrapedProfiles: totalMovedToScraped,
                },
                updated_at: new Date().toISOString(),
              })
              .eq('job_id', jobId),
            10000,
            'Timeout while updating job status'
          );
        } catch (error) {
          logger.error(`Error in check open profiles job ${jobId}: ${error.message}`);
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
              .eq('job_id', jobId),
            10000,
            'Timeout while updating job status'
          );
        } finally {
          try {
            if (page) await page.close();
            if (browser) await browser.close();
          } catch (err) {
            logger.error(`Failed to close browser or page: ${err.message}`);
          }
        }
      };

      // Instead of immediately executing the job function
      jobQueueManager.addJob(() => jobFunction(), { 
        jobId, 
        type: 'check_open_profiles',
        campaignId: req.body.campaignId
      }).catch(err => {
        logger.error(`Queue processing failed for job ${jobId}: ${err.message}`);
      });
      
    } catch (error) {
      logger.error(`Error in /check-open-profiles route: ${error.message}`);
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