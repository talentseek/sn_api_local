const createLogger = require('../utils/logger');
const cookieLoader = require('../modules/cookieLoader');
const lightCookieChecker = require('../modules/lightCookieChecker');
const { withTimeout } = require('../utils/databaseUtils');

const logger = createLogger();

// Utility to generate a random delay for retries (exponential backoff)
const randomDelay = (attempt) => {
  const baseDelay = 5000; // 5 seconds base delay
  const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff: 5s, 10s, 20s
  const jitter = Math.random() * 2000; // Add up to 2s of jitter
  return delay + jitter;
};

// Export a factory function that takes supabase as a parameter
module.exports = (supabase) => {
  return async (req, res) => {
    const logger = createLogger();

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
        return res.status(404).json({
          success: false,
          error: 'Campaign not found',
        });
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
        return res.status(400).json({
          success: false,
          error: 'No valid cookies found for this campaign',
        });
      }

      const cookies = [
        { name: 'li_a', value: campaignData.cookies.li_a, domain: '.linkedin.com' },
        { name: 'li_at', value: campaignData.cookies.li_at, domain: '.linkedin.com' },
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
          let browser = null;
          let page = null;

          try {
            logger.info(`Attempt ${attempt}/${maxRetries}: Validating cookies for campaign ${campaignId}`);
            logger.info(`Cookies being validated: ${JSON.stringify(cookies.map(c => ({ name: c.name, domain: c.domain })))}`);
            const { browser: loadedBrowser, page: loadedPage } = await cookieLoader({
              cookies,
              searchUrl: 'https://www.linkedin.com/sales/home',
            });
            browser = loadedBrowser;
            page = loadedPage;

            validationResult = 'Cookies are valid';
            cookiesStatus = 'valid';
            logger.success(`Cookies validated successfully for campaign ${campaignId}`);
            break;
          } catch (error) {
            logger.error(`Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
            if (error.message.includes('CAPTCHA detected')) {
              cookiesStatus = 'manual_intervention_required';
              validationResult = 'CAPTCHA detected. Manual intervention required.';
              break;
            } else if (error.message.includes('Two-factor authentication required')) {
              cookiesStatus = 'manual_intervention_required';
              validationResult = 'Two-factor authentication required.';
              break;
            }

            validationResult = `Failed to validate cookies: ${error.message}`;
            cookiesStatus = 'invalid';

            if (attempt === maxRetries) {
              logger.error(`All attempts failed for campaign ${campaignId}. Marking as invalid.`);
            } else {
              const delay = randomDelay(attempt);
              logger.info(`Retrying in ${Math.round(delay/1000)} seconds...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          } finally {
            try {
              if (page) await page.close();
              if (browser) await browser.close();
              logger.info(`Closed browser and page for attempt ${attempt}`);
            } catch (err) {
              logger.error(`Failed to close browser or page for attempt ${attempt}: ${err.message}`);
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
        return res.status(500).json({
          success: false,
          error: 'Failed to update cookies status in the database',
        });
      }

      logger.info(`Updated cookies_status to '${cookiesStatus}' for campaign ${campaignId}`);

      // Return the result
      return res.json({
        success: true,
        message: validationResult,
        cookiesStatus,
        campaignId,
        campaignName: campaignData.name,
      });
    } catch (error) {
      logger.error(`Error in /check-cookies route: ${error.message}`);
      return res.status(500).json({
        success: false,
        error: 'Internal Server Error',
      });
    }
  };
};