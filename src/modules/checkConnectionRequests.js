const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const createLogger = require('../utils/logger');
const logger = createLogger();

class CheckConnectionRequests {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  async initializeBrowser(cookies) {
    logger.info('Launching Puppeteer with dynamic cookies...');

    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });

    this.page = await this.browser.newPage();

    // Set cookies
    const formattedCookies = [
      { name: 'li_at', value: cookies.li_at, domain: '.linkedin.com', path: '/' },
      { name: 'li_a', value: cookies.li_a, domain: '.linkedin.com', path: '/' },
    ];

    await this.page.setCookie(...formattedCookies);

    // Set a realistic user agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    );

    logger.info('Browser initialized successfully.');
  }

  async checkConnectionStatus(profileUrl) {
    try {
      logger.info(`Navigating to profile: ${profileUrl}`);
      await this.page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      // Wait for the connection level element to appear
      const connectionLevelSelector = 'span._name-sublabel--no-pronunciation_sqh8tm span';
      await this.page.waitForSelector(connectionLevelSelector, { timeout: 10000 });

      // Extract the connection level (e.g., '1st', '2nd')
      const connectionLevel = await this.page.evaluate((selector) => {
        const element = document.querySelector(selector);
        return element ? element.textContent.trim() : null;
      }, connectionLevelSelector);

      if (!connectionLevel) {
        throw new Error('Connection level not found on the page');
      }

      logger.info(`Connection level for ${profileUrl}: ${connectionLevel}`);

      if (connectionLevel === '1st') {
        logger.info('Connection request accepted (1st degree connection).');
        return { status: 'accepted' };
      } else if (connectionLevel === '2nd') {
        logger.info('Connection request still pending or not sent (2nd degree connection).');
        // We can't distinguish between 'pending' and 'not_sent' just from the connection level,
        // but since this module is called for profiles with status 'pending', we'll assume it's still pending
        return { status: 'pending' };
      } else {
        logger.warn(`Unexpected connection level: ${connectionLevel}`);
        return { status: 'not_sent' }; // Fallback to allow retrying
      }
    } catch (error) {
      logger.error(`Error checking connection status for ${profileUrl}: ${error.message}`);
      throw error;
    }
  }

  async closeBrowser() {
    if (this.page) {
      await this.page.close();
    }
    if (this.browser) {
      await this.browser.close();
      logger.info('Browser closed.');
    }
  }
}

module.exports = () => new CheckConnectionRequests();