const createLogger = require('../utils/logger');
const cookieLoader = require('../modules/cookieLoader');
const zoomHandler = require('../modules/zoomHandler');
const scraper = require('../modules/scraper');
const { insertPremiumProfiles, insertScrapedProfiles, withTimeout } = require('../utils/databaseUtils');

const logger = createLogger();

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

      const { campaignId, searchUrl, lastPage, batchSize, delayBetweenBatches } = req.body;

      if (!campaignId || !searchUrl || !lastPage) {
        logger.warn('Missing required fields: campaignId, searchUrl, or lastPage');
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: campaignId, searchUrl, or lastPage',
        });
      }

      if (!Number.isInteger(Number(lastPage)) || Number(lastPage) < 1) {
        logger.warn(`Invalid lastPage: ${lastPage}`);
        return res.status(400).json({
          success: false,
          error: 'lastPage must be a positive integer',
        });
      }

      logger.info(`Starting profile scrape for campaignId: ${campaignId}`);

      // Create a new job entry in the jobs table
      const { data: jobData, error: jobError } = await withTimeout(
        supabase
          .from('jobs')
          .insert({
            type: 'scrape',
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

      // Return the job ID immediately to the client
      res.json({ success: true, jobId });

      // Run the scraping task asynchronously
      (async () => {
        let browser = null;
        let page = null;

        try {
          // Fetch campaign data
          const { data: campaignData, error: campaignError } = await withTimeout(
            supabase
              .from('campaigns')
              .select('cookies, client_id')
              .eq('id', campaignId)
              .single(),
            10000,
            'Timeout while fetching campaign data'
          );

          if (campaignError || !campaignData?.cookies || !campaignData?.client_id) {
            const msg = `Could not load campaign cookies and/or client_id for campaign ${campaignId}`;
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

          logger.info(`Scraping pages 1 to ${lastPage}`);

          const scraperInstance = scraper(page, lastPage, searchUrl);
          let totalInsertedNonPremium = 0;
          let totalInsertedPremium = 0;
          const batchSz = Math.min(Number(batchSize) || 10, 25);

          // Scrape and process each page
          for (let currentPage = 1; currentPage <= lastPage; currentPage++) {
            let scrapedData = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                scrapedData = await scraperInstance.scrapePage(currentPage);
                break;
              } catch (error) {
                logger.warn(`Attempt ${attempt}/3 failed for page ${currentPage}: ${error.message}`);
                if (attempt === 3) {
                  logger.error(`Failed to scrape page ${currentPage} after 3 retries: ${error.message}`);
                  await withTimeout(
                    supabase
                      .from('jobs')
                      .update({
                        status: 'failed',
                        error: error.message,
                        error_category: 'scrape_page_failed',
                        updated_at: new Date().toISOString(),
                      })
                      .eq('job_id', jobId),
                    10000,
                    'Timeout while updating job status'
                  );
                  return;
                }
                const retryDelay = 5000 * attempt;
                logger.info(`Waiting ${retryDelay}ms before retrying page ${currentPage}`);
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
              }
            }

            if (!scrapedData || scrapedData.length === 0) {
              logger.warn(`No profiles found on page ${currentPage}, continuing to next page`);
              const progress = currentPage / lastPage;
              await withTimeout(
                supabase
                  .from('jobs')
                  .update({ status: 'in_progress', progress, updated_at: new Date().toISOString() })
                  .eq('job_id', jobId),
                10000,
                'Timeout while updating job progress'
              );
              if (currentPage < lastPage) {
                const randomDelay = Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;
                logger.info(`Waiting ${randomDelay}ms before scraping page ${currentPage + 1}`);
                await new Promise((resolve) => setTimeout(resolve, randomDelay));
              }
              continue;
            }

            logger.info(`Processing profiles from page ${currentPage}`);

            const validateProfile = (profile) => {
              const requiredFields = [
                'profileLink',
                'firstName',
                'lastName',
                'jobTitle',
                'companyLink',
                'connectionLevel',
              ];
              return requiredFields.every((field) => profile[field] && typeof profile[field] === 'string' && profile[field].trim() !== '');
            };

            const completeProfiles = scrapedData.filter((profile) => {
              const isValid = validateProfile(profile);
              if (!isValid) {
                logger.warn(`Skipping incomplete profile: ${JSON.stringify(profile)}`);
              }
              return isValid;
            });

            logger.info(`Filtered to ${completeProfiles.length} complete profiles from page ${currentPage}`);

            const premiumProfiles = completeProfiles.filter((profile) => profile.isPremium);
            const nonPremiumProfiles = completeProfiles.filter((profile) => !profile.isPremium);

            for (let i = 0; i < nonPremiumProfiles.length; i += batchSz) {
              const batch = nonPremiumProfiles.slice(i, i + batchSz);
              logger.info(`Processing batch ${i / batchSz + 1} (${batch.length} non-premium profiles) from page ${currentPage}`);

              const profilesToInsert = batch.map((profile) => ({
                campaign_id: campaignId,
                linkedin: profile.profileLink,
                first_name: profile.firstName,
                last_name: profile.lastName,
                job_title: profile.jobTitle,
                company: profile.company || null,
                companylink: profile.companyLink,
                connection_level: profile.connectionLevel,
                connection_status: 'not sent',
                scraped_at: new Date().toISOString(),
              }));

              const insertedCount = await insertScrapedProfiles(supabase, profilesToInsert);
              totalInsertedNonPremium += insertedCount;

              if (delayBetweenBatches && i + batchSz < nonPremiumProfiles.length) {
                logger.info(`Waiting ${delayBetweenBatches}ms before next batch of non-premium profiles on page ${currentPage}`);
                await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
              }
            }

            for (let i = 0; i < premiumProfiles.length; i += batchSz) {
              const batch = premiumProfiles.slice(i, i + batchSz);
              logger.info(`Processing batch ${i / batchSz + 1} (${batch.length} premium profiles) from page ${currentPage}`);

              const profilesToInsert = batch.map((profile) => ({
                campaign_id: campaignId.toString(),
                linkedin: profile.profileLink,
                full_name: `${profile.firstName} ${profile.lastName}`.trim(),
                job_title: profile.jobTitle,
                company: profile.company || null,
                companyLink: profile.companyLink,
                connection_level: profile.connectionLevel,
                scraped_at: new Date().toISOString(),
                is_open_profile: false,
                is_checked: false,
              }));

              const insertedCount = await insertPremiumProfiles(supabase, profilesToInsert);
              totalInsertedPremium += insertedCount;

              if (delayBetweenBatches && i + batchSz < premiumProfiles.length) {
                logger.info(`Waiting ${delayBetweenBatches}ms before next batch of premium profiles on page ${currentPage}`);
                await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
              }
            }

            const progress = currentPage / lastPage;
            await withTimeout(
              supabase
                .from('jobs')
                .update({ status: 'in_progress', progress, updated_at: new Date().toISOString() })
                .eq('job_id', jobId),
              10000,
              'Timeout while updating job progress'
            );

            if (currentPage < lastPage) {
              const randomDelay = Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;
              logger.info(`Waiting ${randomDelay}ms before scraping page ${currentPage + 1}`);
              await new Promise((resolve) => setTimeout(resolve, randomDelay));
            }
          }

          logger.success(`Scraping and storage completed. Total non-premium profiles stored: ${totalInsertedNonPremium}, Total premium profiles stored: ${totalInsertedPremium}`);
          await withTimeout(
            supabase
              .from('jobs')
              .update({
                status: 'completed',
                progress: 1,
                result: { totalNonPremiumProfilesScraped: totalInsertedNonPremium, totalPremiumProfilesScraped: totalInsertedPremium },
                updated_at: new Date().toISOString(),
              })
              .eq('job_id', jobId),
            10000,
            'Timeout while updating job status'
          );
        } catch (error) {
          logger.error(`Error in scrapeController: ${error.message}`);
          let errorCategory = 'unknown';
          if (error.message.includes('Cookies are invalid')) {
            errorCategory = 'authentication_failed';
          } else if (error.message.includes('Key elements not found')) {
            errorCategory = 'page_validation_failed';
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
      logger.error(`Error in /scrape-profiles route: ${error.message}`);
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