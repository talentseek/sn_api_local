const puppeteer = require('puppeteer');
const createLogger = require('../utils/logger');
const config = require('../utils/config');

module.exports = async function cookieLoader({ cookies, searchUrl }) {
  const logger = createLogger();

  let browser;
  let page;

  try {
    logger.info('Starting Puppeteer with Chromium...');
    browser = await puppeteer.launch({
      headless: config.headless,
      timeout: 60000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        '--disable-notifications',
      ].filter(Boolean),
      dumpio: false, // Disable verbose logging to reduce I/O
    });

    logger.info('Creating new page...');
    page = await browser.newPage();

    // Set viewport
    await page.setViewport(config.viewport);

    // Spoof browser properties
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Apple Inc.';
        if (parameter === 37446) return 'Apple GPU';
        return getParameter(parameter);
      };
    });

    logger.info('Setting cookies for authentication...');
    await page.setCookie(...cookies);

    logger.info(`Navigating to the target URL: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    logger.info('Simulating human-like behavior...');
    await page.evaluate(async () => {
      window.scrollBy(0, Math.random() * 300 + 200);
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
    });

    logger.info('Validating page access...');
    const currentUrl = page.url();

    if (currentUrl.includes('https://www.linkedin.com/sales/login') || currentUrl.includes('https://www.linkedin.com/login')) {
      const pageContent = await page.content();
      logger.error(`Redirected to login page. Page content (first 2000 characters):\n${pageContent.slice(0, 2000)}`);
      throw new Error('Redirected to login page. Cookies are invalid.');
    }

    logger.success('Page access validated: No redirect to login page.');
    return { browser, page };
  } catch (error) {
    logger.error(`Error in cookieLoader: ${error.message}`);
    if (error.message.includes('net::ERR_TOO_MANY_REDIRECTS')) {
      throw new Error('Too many redirects detected. Cookies are invalid.');
    }
    throw error;
  } finally {
    // Let the caller handle browser closure
  }
};