const createLogger = require('../utils/logger');
const cookieLoader = require('../modules/cookieLoader');
const zoomHandler = require('../modules/zoomHandler');
const openProfilesModule = require('../modules/openProfiles');
const { insertLeads, insertScrapedProfiles, withTimeout } = require('../utils/databaseUtils');

const logger = createLogger();

// Function to process a single job
const processJob = async (currentJobId, supabase) => {
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
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job status'
      );
      return;
    }

    const cookies = [
      { name: 'li_a', value: campaignData.cookies.li_a, domain: '.linkedin.com' },
      { name: 'li_at', value: campaignData.cookies.li_at, domain: '.linkedin.com' },
    ];

    const clientId = campaignData.client_id;

    // Launch browser and load cookies (use Sales Navigator URL since openProfiles.js works with Sales Navigator profiles)
    const { browser: loadedBrowser, page: loadedPage } = await cookieLoader({ cookies, searchUrl: 'https://www.linkedin.com/sales/home' });
    browser = loadedBrowser;
    page = loadedPage;
    await zoomHandler(page);

    const { checkOpenProfile } = openProfilesModule(page);

    const { data: premiumProfiles, error: fetchError } = await withTimeout(
      supabase
        .from('premium_profiles')
        .select('*')
        .eq('campaign_id', campaignId.toString())
        .eq('is_checked', false)
        .eq('moved_to_scraped', false) // Add this condition to avoid duplicates in scraped_profiles
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
          .eq('job_id', currentJobId),
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
          .eq('job_id', currentJobId),
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
              .eq('job_id', currentJobId),
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
            .eq('job_id', currentJobId),
          10000,
          'Timeout while updating job progress'
        );

        if (processedProfiles < totalProfiles && batch.indexOf(profile) < batch.length - 1) {
          logger.info(`Waiting 2000ms before processing next profile`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      if (i + (jobData.batch_size || 10) < premiumProfiles.length) {
        logger.info(`Waiting 5000ms before processing next batch`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    let totalMovedToLeads = 0;
    let totalMovedToScraped = 0;

    if (openProfiles.length > 0) {
      totalMovedToLeads = await insertLeads(supabase, openProfiles, clientId);

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

    logger.success(`Open Profiles check completed for job ${currentJobId}.`);
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

// Factory function pattern
module.exports = (supabase) => {
  return async (req, res) => {
    const logger = createLogger();

    let jobId = null;

    try {
      // Safely access req.body
      if (!req.body || typeof req.body !== 'object') {
        logger.warn('Request body is missing or invalid');
        return res.status(400).json({
          success: false,
          error: 'Request body is missing or invalid',
        });
      }

      const { campaignId, batchSize = 10, delayBetweenBatches = 5000, delayBetweenProfiles = 2000, maxProfiles = 50 } = req.body;

      if (!campaignId) {
        logger.warn('Missing required field: campaignId');
        return res.status(400).json({
          success: false,
          error: 'Missing required field: campaignId',
        });
      }

      logger.info(`Received request to start open profile check for campaignId: ${campaignId}`);

      const { data: jobData, error: jobError } = await withTimeout(
        supabase
          .from('jobs')
          .insert({
            type: 'check_open_profiles',
            status: 'started',
            progress: 0,
            error: null,
            result: null,
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

      // Process the job asynchronously
      setImmediate(() => {
        processJob(jobId, supabase).catch(err => {
          logger.error(`Background processing failed for job ${jobId}: ${err.message}`);
        });
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