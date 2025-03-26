const createLogger = require('../utils/logger');
const cookieLoader = require('../modules/cookieLoader');
const zoomHandler = require('../modules/zoomHandler');
const scraperModule = require('../modules/scraper');
const { insertPremiumProfiles, withTimeout } = require('../utils/databaseUtils');

const logger = createLogger();

const randomDelay = (min, max) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const simulateScroll = async (page) => {
  await page.evaluate(async () => {
    window.scrollBy(0, Math.random() * 300 + 200);
    await new Promise(resolve => setTimeout(resolve, Math.random() * 500 + 500));
  });
};

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

      const { campaignId, searchUrl, maxPages = 5 } = req.body;

      if (!campaignId) {
        logger.warn('Missing required field: campaignId');
        return res.status(400).json({
          success: false,
          error: 'Missing required field: campaignId',
        });
      }

      if (!searchUrl || typeof searchUrl !== 'string' || !searchUrl.includes('linkedin.com')) {
        logger.warn(`Invalid searchUrl: ${searchUrl}`);
        return res.status(400).json({
          success: false,
          error: 'Invalid searchUrl: must be a valid LinkedIn search URL',
        });
      }

      const totalPages = Math.min(Number(maxPages) || 5, 80);
      const maxPremiumProfiles = 50;

      logger.info(`Starting premium profile scrape for campaignId: ${campaignId}, searchUrl: ${searchUrl}`);

      const { data: jobData, error: jobError } = await withTimeout(
        supabase
          .from('jobs')
          .insert({
            type: 'scrape_premium_profiles',
            status: 'started',
            progress: 0,
            error: null,
            result: null,
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
      logger.info(`Created job with ID: ${jobId}`);

      res.json({ success: true, jobId });

      (async () => {
        let browser = null;
        let page = null;

        try {
          const { data: campaignData, error: campaignError } = await withTimeout(
            supabase
              .from('campaigns')
              .select('cookies')
              .eq('id', parseInt(campaignId))
              .single(),
            10000,
            'Timeout while fetching campaign data'
          );

          if (campaignError || !campaignData?.cookies) {
            const msg = `Could not load campaign cookies for campaign ${campaignId}`;
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

          const cookies = [
            { name: 'li_a', value: campaignData.cookies.li_a, domain: '.linkedin.com' },
            { name: 'li_at', value: campaignData.cookies.li_at, domain: '.linkedin.com' },
          ];

          // Launch browser and load cookies (no proxyConfig)
          const { browser: loadedBrowser, page: loadedPage } = await cookieLoader({ cookies, searchUrl });
          browser = loadedBrowser;
          page = loadedPage;
          await zoomHandler(page);

          const { scrapePage } = scraperModule(page, totalPages, searchUrl);

          let allPremiumProfiles = [];
          for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
            logger.info(`Processing page ${currentPage} of ${totalPages}`);

            const pageResults = await scrapePage(currentPage);

            const premiumProfiles = pageResults.filter(profile => profile.isPremium);

            logger.info(`Found ${premiumProfiles.length} premium profiles on page ${currentPage}`);

            const profilesToInsert = premiumProfiles.map(profile => ({
              campaign_id: campaignId.toString(),
              linkedin: profile.profileLink,
              full_name: `${profile.firstName} ${profile.lastName}`.trim(),
              job_title: profile.jobTitle,
              company: profile.company,
              companyLink: profile.companyLink,
              connection_level: profile.connectionLevel,
              scraped_at: new Date().toISOString(),
              website: null,
              error: null,
              is_checked: false,
              is_open_profile: null,
              moved_to_leads: false,
              moved_to_scraped: false,
              company_data: null,
            }));

            if (profilesToInsert.length > 0) {
              const insertedCount = await insertPremiumProfiles(supabase, profilesToInsert);
              allPremiumProfiles = allPremiumProfiles.concat(profilesToInsert.slice(0, insertedCount));
              logger.info(`Inserted ${insertedCount} premium profiles from page ${currentPage}`);
            }

            const progress = currentPage / totalPages;
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

            if (allPremiumProfiles.length >= maxPremiumProfiles) {
              logger.info(`Reached target of ${maxPremiumProfiles} premium profiles. Stopping scrape early.`);
              break;
            }

            if (currentPage < totalPages) {
              const delay = randomDelay(5000, 10000);
              logger.info(`Waiting ${delay}ms before scraping next page`);
              await new Promise(resolve => setTimeout(resolve, delay));
              await simulateScroll(page);
            }
          }

          logger.success(`Premium profile scraping completed. Total premium profiles found: ${allPremiumProfiles.length}`);
          await withTimeout(
            supabase
              .from('jobs')
              .update({
                status: 'completed',
                progress: 1,
                result: {
                  totalPagesScraped: allPremiumProfiles.length > 0 ? Math.ceil(allPremiumProfiles.length / 25) : totalPages,
                  totalPremiumProfilesFound: allPremiumProfiles.length,
                },
                updated_at: new Date().toISOString(),
              })
              .eq('job_id', jobId),
            10000,
            'Timeout while updating job status'
          );
        } catch (error) {
          logger.error(`Error in scrapePremiumProfilesController: ${error.message}`);
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
      })();
    } catch (error) {
      logger.error(`Error in /scrape-premium-profiles route: ${error.message}`);
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