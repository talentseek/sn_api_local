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

      // Try both selectors with fallback logic
      const connectionLevel = await this.page.evaluate(() => {
        // Helper function to extract connection level from element
        const getConnectionLevel = (element) => {
          if (!element) return null;
          
          const spans = element.querySelectorAll('span');
          const spansArray = Array.from(spans);
          
          // Check for separator
          const hasSeparator = spansArray.some(span => span.classList.contains('separator--middot'));
          
          if (hasSeparator) {
            // Get the last span after separator
            const lastSpan = spansArray[spansArray.length - 1];
            return lastSpan ? lastSpan.textContent.trim() : null;
          } else {
            // For cases without separator, get the last non-empty span
            for (let i = spansArray.length - 1; i >= 0; i--) {
              const text = spansArray[i].textContent.trim();
              if (text && !text.startsWith('(') && !text.endsWith(')')) {
                return text;
              }
            }
          }
          return null;
        };

        // Try primary selector first
        let element = document.querySelector('span._name-sublabel--no-pronunciation_sqh8tm');
        if (!element) {
          // Try fallback selector
          element = document.querySelector('span._bodyText_1e5nen._default_1i6ulk._sizeSmall_1e5nen._lowEmphasis_1i6ulk');
        }

        return getConnectionLevel(element);
      });

      if (!connectionLevel) {
        // Log the actual HTML structure for debugging
        const htmlStructure = await this.page.evaluate(() => {
          const element1 = document.querySelector('span._name-sublabel--no-pronunciation_sqh8tm');
          const element2 = document.querySelector('span._bodyText_1e5nen._default_1i6ulk._sizeSmall_1e5nen._lowEmphasis_1i6ulk');
          return {
            primary: element1 ? element1.outerHTML : null,
            fallback: element2 ? element2.outerHTML : null
          };
        });
        logger.warn(`Connection level not found. HTML structures:\nPrimary: ${htmlStructure.primary}\nFallback: ${htmlStructure.fallback}`);
        throw new Error('Connection level not found on the page');
      }

      logger.info(`Connection level for ${profileUrl}: ${connectionLevel}`);

      // Handle all possible connection levels
      switch (connectionLevel.toLowerCase()) {
        case '1st':
          logger.info('Connection request accepted (1st degree connection).');
          return { status: 'accepted' };
        case '2nd':
        case '3rd':
          // Both 2nd and 3rd degree connections should be treated as pending
          // since we're checking profiles that had connection requests sent
          logger.info(`Connection request still pending (${connectionLevel} degree connection).`);
          return { status: 'pending' };
        default:
          logger.warn(`Unexpected connection level: ${connectionLevel}`);
          return { status: 'not_sent' }; // Fallback to allow retrying
      }
    } catch (error) {
      logger.error(`Error checking connection status for ${profileUrl}: ${error.message}`);
      // If it's a timeout error, we'll treat it as pending to allow retry
      if (error.message.includes('timeout')) {
        logger.warn('Timeout occurred while checking connection status - treating as pending');
        return { status: 'pending' };
      }
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