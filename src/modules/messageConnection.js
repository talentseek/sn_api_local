const puppeteer = require('puppeteer');
const createLogger = require('../utils/logger');
const logger = createLogger();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Random delay between min and max milliseconds
const randomDelay = (min, max) =>
  delay(Math.floor(Math.random() * (max - min + 1)) + min);

module.exports = () => {
  let browser = null;
  let page = null;

  // Initialize the browser (called once per session)
  const initializeBrowser = async (cookies) => {
    logger.info('Launching Puppeteer with dynamic cookies...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--start-maximized',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ],
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Set LinkedIn cookies
    await page.setCookie(
      { name: 'li_at', value: cookies.li_at, domain: '.linkedin.com' },
      { name: 'li_a', value: cookies.li_a, domain: '.linkedin.com' }
    );

    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    );

    logger.info('Browser initialized successfully.');
  };

  // Helper function to log available elements
  const logPageState = async (context) => {
    try {
      const state = await page.evaluate(() => {
        const messageButton = document.querySelector('button[data-anchor-send-inmail]');
        const textarea = document.querySelector('textarea._message-field_jrrmou');
        const sendButton = document.querySelector('fieldset._actions-container_3o17um button._button_ps32ck._primary_ps32ck');
        
        return {
          hasMessageButton: !!messageButton,
          messageButtonClasses: messageButton ? messageButton.className : null,
          hasTextarea: !!textarea,
          textareaClasses: textarea ? textarea.className : null,
          hasSendButton: !!sendButton,
          sendButtonClasses: sendButton ? sendButton.className : null,
          bodyContent: document.body.innerHTML.substring(0, 500) + '...' // First 500 chars for brevity
        };
      });
      
      logger.info(`Page state at ${context}:`, state);
    } catch (error) {
      logger.error(`Failed to log page state at ${context}:`, error.message);
    }
  };

  // Send a message to a 1st connection
  const sendMessage = async ({ leadUrl, message }) => {
    if (!page) {
      throw new Error('Browser not initialized. Call initializeBrowser first.');
    }

    try {
      logger.info(`Navigating to lead profile: ${leadUrl}`);
      await page.goto(leadUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await randomDelay(2000, 4000); // Random delay 2-4 seconds

      // Log state before clicking
      await logPageState('before clicking message button');

      // Click the message button using the working selector
      const messageButtonSelector = 'button[data-anchor-send-inmail]';
      await page.waitForSelector(messageButtonSelector, { visible: true, timeout: 10000 });
      await page.click(messageButtonSelector);
      logger.info('Clicked the message button.');
      
      // Add delay after clicking message button (2-4 seconds)
      await randomDelay(2000, 4000);
      
      // Log state after clicking
      await logPageState('after clicking message button');

      // Wait for and find the textarea directly (no form wrapper needed)
      const textareaSelector = 'textarea._message-field_jrrmou';
      await page.waitForSelector(textareaSelector, { visible: true, timeout: 10000 });
      logger.info('Message textarea appeared.');
      
      // Clear any existing text and type the message
      await page.evaluate((selector) => {
        const textarea = document.querySelector(selector);
        if (textarea) textarea.value = '';
      }, textareaSelector);
      
      await page.type(textareaSelector, message.content);
      logger.info('Typed message into textarea.');

      // Add delay after typing (1-2 seconds)
      await randomDelay(1000, 2000);

      // Log state before sending
      await logPageState('before sending message');

      // Wait for and click the send button with the correct selector
      const sendButtonSelector = 'fieldset._actions-container_3o17um button._button_ps32ck._primary_ps32ck';
      
      // Wait for the send button to become enabled
      await page.waitForFunction(
        (selector) => {
          const button = document.querySelector(selector);
          return button && !button.disabled && 
                 button.querySelector('span._text_ddl063') &&
                 button.querySelector('span._text_ddl063').textContent.trim() === 'Send';
        },
        { timeout: 10000 },
        sendButtonSelector
      );

      // Click the send button using evaluate to ensure we get the right one
      await page.evaluate(() => {
        const sendButton = document.querySelector('fieldset._actions-container_3o17um button._button_ps32ck._primary_ps32ck:not([disabled])');
        if (sendButton) sendButton.click();
      });
      logger.info('Clicked the send button.');

      // Add delay after sending (2-4 seconds)
      await randomDelay(2000, 4000);

      // Verify message was sent by checking if the textarea is empty or gone
      await page.waitForFunction(
        (textareaSelector) => {
          const textarea = document.querySelector(textareaSelector);
          return !textarea || textarea.value.trim() === '';
        },
        { timeout: 10000 },
        textareaSelector
      );

      logger.info('Message successfully sent and verified.');
      return { success: true };
    } catch (error) {
      // Log the final state if there's an error
      await logPageState('at error');

      logger.error(`Failed to send message to ${leadUrl}: ${error.message}`);
      return { success: false, error: error.message };
    }
  };

  // Close the browser (called at the end of the session)
  const closeBrowser = async () => {
    if (page) await page.close();
    if (browser) await browser.close();
    logger.info('Browser closed.');
  };

  return { initializeBrowser, sendMessage, closeBrowser };
};