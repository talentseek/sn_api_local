/**
 * Controller for scraping company data from LinkedIn
 * @module controllers/scrapeCompanyDataController
 */

const createLogger = require('../utils/logger');
const cookieLoader = require('../modules/cookieLoader');
const scrapeCompanyData = require('../modules/scrapeCompanyData');
const { withTimeout } = require('../utils/databaseUtils');
const { bot } = require('../telegramBot');
const puppeteer = require('puppeteer');
const jobQueueManager = require('../utils/jobQueueManager');

// Process the job asynchronously
const processJob = async (currentJobId, supabase) => {
  const logger = createLogger();
  let browser = null;
  let page = null;

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
    const batchSize = jobData.batch_size || 5;
    const delayBetweenBatches = jobData.result?.delayBetweenBatches || 5000;
    const delayBetweenProfiles = jobData.result?.delayBetweenProfiles || 5000;
    const maxProfiles = jobData.result?.maxProfiles || 20;

    // Update job status to processing
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'processing',
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', currentJobId),
      10000,
      'Timeout while updating job status'
    );

    // Fetch campaign data
    const { data: campaignData, error: campaignError } = await withTimeout(
      supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .single(),
      10000,
      'Timeout while fetching campaign data'
    );

    if (campaignError || !campaignData) {
      const msg = `Failed to fetch campaign data for campaign ${campaignId}: ${campaignError?.message}`;
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

    // Fetch leads that need company data
    const { data: leads, error: fetchError } = await withTimeout(
      supabase
        .from('leads')
        .select('id, companyLink, company_data')
        .eq('client_id', campaignData.client_id)
        .eq('message_sent', false)
        .eq('is_open_profile', true)
        .eq('status', 'not_replied')
        .or('company_data.is.null,company_data.eq.{}')
        .not('companyLink', 'is', null)
        .limit(maxProfiles),
      10000,
      'Timeout while fetching leads'
    );

    if (fetchError) {
      const msg = `Failed to fetch leads for campaign ${campaignId}: ${fetchError.message}`;
      logger.error(msg);
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            status: 'failed',
            error: msg,
            error_category: 'leads_load_failed',
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job status'
      );
      return;
    }

    if (!leads || leads.length === 0) {
      const msg = `No leads found that need company data for campaign ${campaignId}`;
      logger.info(msg);
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            status: 'completed',
            result: {
              ...jobData.result,
              message: msg,
              leadsProcessed: 0,
            },
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job status'
      );
      return;
    }

    logger.info(`Found ${leads.length} leads that need company data for campaign ${campaignId}`);

    // Load LinkedIn cookies
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
          .eq('job_id', currentJobId),
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

    // Process leads in batches
    let leadsProcessed = 0;
    let successfulScrapes = 0;
    let failedScrapes = 0;

    for (let i = 0; i < leads.length; i += batchSize) {
      const batch = leads.slice(i, i + batchSize);
      logger.info(`Processing batch ${Math.floor(i / batchSize) + 1} (${batch.length} leads)`);

      for (const lead of batch) {
        try {
          leadsProcessed++;
          
          if (!lead.companyLink) {
            logger.warn(`Lead ${lead.id} has no company link, skipping`);
            continue;
          }
          
          logger.info(`Scraping company data for lead ${lead.id} with company link: ${lead.companyLink}`);
          
          try {
            // Scrape company data
            const companyData = await scrapeCompanyData(page, lead.companyLink);
            
            if (!companyData) {
              logger.warn(`Failed to scrape company data for lead ${lead.id}`);
              failedScrapes++;
              continue;
            }
            
            // Update the lead with the company data
            const { error: updateError } = await withTimeout(
              supabase
                .from('leads')
                .update({
                  company_data: companyData
                })
                .eq('id', lead.id),
              10000,
              `Timeout while updating lead ${lead.id} with company data`
            );
            
            if (updateError) {
              throw new Error(`Failed to update lead ${lead.id} with company data: ${updateError.message}`);
            }
            
            successfulScrapes++;
            logger.info(`Successfully updated lead ${lead.id} with company data`);
          } catch (error) {
            failedScrapes++;
            logger.error(`Failed to update lead ${lead.id} with company data: ${error.message}`);
          }
          
          // Add delay between profiles
          if (lead !== batch[batch.length - 1]) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenProfiles));
          }
        } catch (error) {
          failedScrapes++;
          logger.error(`Failed to update lead ${lead.id} with company data: ${error.message}`);
        }
      }

      // Update job progress
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            result: {
              ...jobData.result,
              leadsProcessed,
              successfulScrapes,
              failedScrapes,
            },
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job progress'
      );

      // Delay between batches
      if (i + batchSize < leads.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }

    // Send notification to Telegram
    try {
      const successMessage = `✅ Company data scraping completed for campaign ${campaignId}:\n` +
        `- Leads processed: ${leadsProcessed}\n` +
        `- Successful scrapes: ${successfulScrapes}\n` +
        `- Failed scrapes: ${failedScrapes}`;
      
      await bot.sendMessage(process.env.TELEGRAM_NOTIFICATION_CHAT_ID, successMessage);
      logger.info('Sent completion notification to Telegram');
    } catch (telegramError) {
      logger.error(`Failed to send Telegram notification: ${telegramError.message}`);
    }

    // Update job status to completed
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'completed',
          result: {
            ...jobData.result,
            leadsProcessed,
            successfulScrapes,
            failedScrapes,
            message: 'Company data scraping completed',
          },
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', currentJobId),
      10000,
      'Timeout while updating job status'
    );

    logger.info(`Company data scraping job ${currentJobId} completed successfully`);
  } catch (error) {
    logger.error(`Error in company data scraping job ${currentJobId}: ${error.message}`);
    
    // Update job status to failed
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'failed',
          error: error.message,
          error_category: 'processing_failed',
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', currentJobId),
      10000,
      'Timeout while updating job status'
    );
  } finally {
    // Close browser
    if (page) await page.close();
    if (browser) await browser.close();
  }
};

/**
 * Creates a controller function for scraping company data
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase - Supabase client instance
 * @returns {Function} Express route handler
 */
module.exports = (supabase) => {
  /**
   * Express route handler for scraping company data
   * @param {import('express').Request} req - Express request object
   * @param {import('express').Response} res - Express response object
   * @returns {Promise<void>}
   */
  return async (req, res) => {
    let jobId = null;
    const logger = createLogger();

    try {
      // Validate request body
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
          success: false,
          error: 'Request body is missing or invalid',
        });
      }

      const { 
        campaignId, 
        batchSize = 5, 
        delayBetweenBatches = 5000, 
        delayBetweenProfiles = 5000,
        maxProfiles = 20
      } = req.body;

      if (!campaignId) {
        return res.status(400).json({
          success: false,
          error: 'campaignId is required',
        });
      }

      // Create a job record
      const { data: jobData, error: jobError } = await withTimeout(
        supabase
          .from('jobs')
          .insert({
            status: 'started',
            type: 'scrape_company_data',
            error: null,
            result: { 
              delayBetweenBatches,
              delayBetweenProfiles,
              maxProfiles
            },
            campaign_id: campaignId.toString(),
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
      jobQueueManager.addJob(() => processJob(jobId, supabase), { 
        jobId, 
        type: 'scrape_company_data',
        campaignId
      }).catch(err => {
        logger.error(`Queue processing failed for job ${jobId}: ${err.message}`);
      });
    } catch (error) {
      logger.error(`Error in /scrape-company-data route: ${error.message}`);
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