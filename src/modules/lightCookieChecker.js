const fetch = require('node-fetch');
const createLogger = require('../utils/logger');

const logger = createLogger();

const lightCookieChecker = async (cookies) => {
  try {
    logger.info('Performing lightweight cookie check...');

    // Prepare cookies for the HTTP request
    const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

    // Make a lightweight HTTP request to LinkedIn Sales Navigator
    const response = await fetch('https://www.linkedin.com/sales/home', {
      method: 'GET',
      headers: {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'manual', // Prevent automatic redirects to detect login page
    });

    // Check if the response indicates a redirect to the login page
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && (location?.includes('linkedin.com/sales/login') || location?.includes('linkedin.com/login'))) {
      logger.warn('Redirected to login page. Cookies are invalid.');
      return { isValid: false, message: 'Redirected to login page. Cookies are invalid.' };
    }

    // Check for CAPTCHA or 2FA in the response body (if not redirected)
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text/html')) {
      const body = await response.text();
      if (body.includes('challenge') || body.includes('captcha')) {
        logger.warn('CAPTCHA detected during lightweight cookie check.');
        return { isValid: false, message: 'CAPTCHA detected. Manual intervention required.' };
      }
      if (body.includes('two-step-verification')) {
        logger.warn('Two-factor authentication required during lightweight cookie check.');
        return { isValid: false, message: 'Two-factor authentication required.' };
      }
    }

    logger.success('Lightweight cookie check passed: Cookies are valid.');
    return { isValid: true, message: 'Cookies are valid.' };
  } catch (error) {
    logger.error(`Error in lightweight cookie check: ${error.message}`);
    return { isValid: false, message: `Failed to validate cookies: ${error.message}` };
  }
};

module.exports = lightCookieChecker;