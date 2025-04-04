/**
 * Controller for checking LinkedIn cookie validity
 * @module controllers/checkCookiesController
 */

const createLogger = require('../utils/logger');
const lightCookieChecker = require('../modules/lightCookieChecker');
const { withTimeout } = require('../utils/databaseUtils');
const jobQueueManager = require('../utils/jobQueueManager');
const puppeteer = require('puppeteer');

const logger = createLogger();

// Utility to generate a random delay for retries (exponential backoff)
const randomDelay = (attempt) => {
  const baseDelay = 5000; // 5 seconds base delay
  const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff: 5s, 10s, 20s
  const jitter = Math.random() * 2000; // Add up to 2s of jitter
  return delay + jitter;
};

/**
 * Validates LinkedIn cookies using Puppeteer
 * @param {Array} cookies - Array of cookie objects
 * @returns {Promise<{isValid: boolean, message: string}>}
 */
const validateCookiesWithPuppeteer = async (cookies) => {
  let browser = null;
  let page = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Set cookies
    await page.setCookie(...cookies);

    // First try Sales Navigator
    logger.info('Attempting to validate cookies with Sales Navigator...');
    await page.goto('https://www.linkedin.com/sales', { 
      waitUntil: ['domcontentloaded', 'networkidle0'],
      timeout: 30000 
    });

    const currentUrl = page.url();
    if (currentUrl.includes('linkedin.com/sales/login')) {
      // If Sales Navigator fails, try regular LinkedIn
      logger.info('Sales Navigator login failed, trying regular LinkedIn...');
      await page.goto('https://www.linkedin.com/feed/', { 
        waitUntil: ['domcontentloaded', 'networkidle0'],
        timeout: 30000 
      });

      const regularUrl = page.url();
      if (regularUrl.includes('linkedin.com/login')) {
        return { isValid: false, message: 'Cookies are invalid for both Sales Navigator and regular LinkedIn.' };
      }
    }

    // Check for common LinkedIn elements that indicate we're logged in
    const validSelectors = [
      'div[data-test-id="nav-search-typeahead"]', // Sales Nav search
      '#global-nav', // Regular LinkedIn nav
      '.feed-identity-module', // LinkedIn feed module
      '.search-global-typeahead', // LinkedIn search
      '.authentication-outlet', // General LinkedIn authenticated container
      '.application-outlet', // Another common LinkedIn container
      '.nav-search-typeahead' // Alternative search selector
    ];

    let foundSelector = null;
    for (const selector of validSelectors) {
      try {
        const element = await page.waitForSelector(selector, { timeout: 5000 });
        if (element) {
          foundSelector = selector;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!foundSelector) {
      return { isValid: false, message: 'Unable to validate page access: No LinkedIn elements found.' };
    }

    return { isValid: true, message: 'Cookies are valid.' };
  } catch (error) {
    return { isValid: false, message: `Failed to validate cookies: ${error.message}` };
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
};

/**
 * Creates a controller function for checking cookie validity
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase - Supabase client instance
 * @returns {Function} Express route handler
 */
module.exports = (supabase) => {
  /**
   * Express route handler for checking cookies
   * @param {import('express').Request} req - Express request object
   * @param {import('express').Response} res - Express response object
   * @returns {Promise<void>}
   */
  return async (req, res) => {
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

      const { campaignId } = req.body;

      // Validate request body
      if (!campaignId || !Number.isInteger(Number(campaignId))) {
        logger.warn(`Invalid campaignId: ${campaignId}`);
        return res.status(400).json({
          success: false,
          error: 'Missing or invalid required field: campaignId must be an integer',
        });
      }

      logger.info(`Checking cookies for campaignId: ${campaignId}`);

      // Create a job entry in the database
      const { data: jobData, error: jobError } = await withTimeout(
        supabase
          .from('jobs')
          .insert({
            type: 'check_cookies',
            status: 'queued',
            progress: 0,
            error: null,
            result: null,
            campaign_id: campaignId.toString(),
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
      logger.info(`Created job with ID: ${jobId} with status: queued`);

      // Return the job ID immediately to the client
      res.json({ success: true, jobId });

      // Define the job function
      const jobFunction = async () => {
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

          // Fetch campaign cookies from Supabase
          const { data: campaignData, error: campaignError } = await withTimeout(
            supabase
              .from('campaigns')
              .select('cookies, name')
              .eq('id', parseInt(campaignId))
              .single(),
            10000,
            'Timeout while fetching campaign data'
          );

          if (campaignError || !campaignData) {
            logger.error(`Failed to fetch campaign ${campaignId}: ${campaignError?.message || 'No data found'}`);
            await withTimeout(
              supabase
                .from('jobs')
                .update({
                  status: 'failed',
                  error: 'Campaign not found',
                  error_category: 'campaign_load_failed',
                  updated_at: new Date().toISOString(),
                })
                .eq('job_id', jobId),
              10000,
              'Timeout while updating job status'
            );
            return;
          }

          if (!campaignData.cookies || !campaignData.cookies.li_a || !campaignData.cookies.li_at) {
            logger.warn(`No valid cookies found for campaign ${campaignId}`);
            await withTimeout(
              supabase
                .from('campaigns')
                .update({
                  cookies_status: 'invalid',
                })
                .eq('id', parseInt(campaignId)),
              10000,
              'Timeout while updating cookies_status'
            );
            await withTimeout(
              supabase
                .from('jobs')
                .update({
                  status: 'failed',
                  error: 'No valid cookies found for this campaign',
                  error_category: 'authentication_failed',
                  updated_at: new Date().toISOString(),
                })
                .eq('job_id', jobId),
              10000,
              'Timeout while updating job status'
            );
            return;
          }

          const cookies = [
            { name: 'li_a', value: campaignData.cookies.li_a, domain: '.linkedin.com', path: '/' },
            { name: 'li_at', value: campaignData.cookies.li_at, domain: '.linkedin.com', path: '/' }
          ];

          // First, try the lightweight cookie check
          logger.info('Attempting lightweight cookie check...');
          const lightCheckResult = await lightCookieChecker(cookies);

          let validationResult = lightCheckResult.message;
          let cookiesStatus = lightCheckResult.isValid ? 'valid' : 'invalid';

          // If lightweight check fails or detects manual intervention, fall back to Puppeteer
          if (!lightCheckResult.isValid && !lightCheckResult.message.includes('CAPTCHA') && !lightCheckResult.message.includes('Two-factor')) {
            logger.info('Lightweight check failed. Falling back to Puppeteer-based check...');
            const maxRetries = 5;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
              try {
                logger.info(`Attempt ${attempt}/${maxRetries}: Validating cookies for campaign ${campaignId}`);
                logger.info(`Cookies being validated: ${JSON.stringify(cookies.map(c => ({ name: c.name, domain: c.domain })))}`);
                
                const result = await validateCookiesWithPuppeteer(cookies);

                if (result.isValid) {
                  validationResult = 'Cookies are valid';
                  cookiesStatus = 'valid';
                  logger.success(`Cookies validated successfully for campaign ${campaignId}`);
                  break;
                } else if (result.message.includes('CAPTCHA')) {
                  cookiesStatus = 'manual_intervention_required';
                  validationResult = 'CAPTCHA detected. Manual intervention required.';
                  break;
                } else if (result.message.includes('Two-factor')) {
                  cookiesStatus = 'manual_intervention_required';
                  validationResult = 'Two-factor authentication required.';
                  break;
                }

                validationResult = `Failed to validate cookies: ${result.message}`;
                cookiesStatus = 'invalid';

                if (attempt === maxRetries) {
                  logger.error(`All attempts failed for campaign ${campaignId}. Marking as invalid.`);
                } else {
                  const delay = randomDelay(attempt);
                  logger.info(`Retrying in ${Math.round(delay/1000)} seconds...`);
                  await new Promise(resolve => setTimeout(resolve, delay));
                }
              } catch (error) {
                logger.error(`Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
                if (attempt === maxRetries) {
                  validationResult = `Failed to validate cookies after ${maxRetries} attempts: ${error.message}`;
                  cookiesStatus = 'invalid';
                }
              }
            }
          } else if (lightCheckResult.message.includes('CAPTCHA') || lightCheckResult.message.includes('Two-factor')) {
            cookiesStatus = 'manual_intervention_required';
            validationResult = lightCheckResult.message;
          }

          // Update cookies_status in the campaigns table
          const { error: updateError } = await withTimeout(
            supabase
              .from('campaigns')
              .update({
                cookies_status: cookiesStatus,
              })
              .eq('id', parseInt(campaignId)),
            10000,
            'Timeout while updating cookies_status'
          );

          if (updateError) {
            logger.error(`Failed to update cookies_status for campaign ${campaignId}: ${updateError.message}`);
            await withTimeout(
              supabase
                .from('jobs')
                .update({
                  status: 'failed',
                  error: 'Failed to update cookies status in the database',
                  error_category: 'database_update_failed',
                  updated_at: new Date().toISOString(),
                })
                .eq('job_id', jobId),
              10000,
              'Timeout while updating job status'
            );
            return;
          }

          logger.info(`Updated cookies_status to '${cookiesStatus}' for campaign ${campaignId}`);

          // Return the result
          await withTimeout(
            supabase
              .from('jobs')
              .update({
                status: 'completed',
                result: validationResult,
                cookies_status: cookiesStatus,
                updated_at: new Date().toISOString(),
              })
              .eq('job_id', jobId),
            10000,
            'Timeout while updating job status'
          );

        } catch (error) {
          logger.error(`Error in job ${jobId}: ${error.message}`);
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
          throw error; // Rethrow for the queue manager
        }
      };

      // Add the job to the queue with bypass flag set to true
      jobQueueManager.addJob(jobFunction, { 
        jobId, 
        type: 'check_cookies',
        campaignId: req.body.campaignId
      }, true).catch(err => {
        logger.error(`Cookie check failed for job ${jobId}: ${err.message}`);
      });
      
    } catch (error) {
      logger.error(`Error in /check-cookies route: ${error.message}`);
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