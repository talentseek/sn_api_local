const puppeteer = require('puppeteer');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Random delay between min and max milliseconds
const randomDelay = (min, max) =>
  delay(Math.floor(Math.random() * (max - min + 1)) + min);

module.exports = () => {
  let browser = null;
  let page = null;

  // Initialize the browser (called once per session)
  const initializeBrowser = async (cookies) => {
    console.log('Launching Puppeteer with dynamic cookies...');
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

    console.log('Browser initialized successfully.');
  };

  // Send a message to a 1st connection (no subject required)
  const sendMessage = async ({ leadUrl, message }) => {
    if (!page) {
      throw new Error('Browser not initialized. Call initializeBrowser first.');
    }

    try {
      console.log(`Navigating to lead profile: ${leadUrl}`);
      await page.goto(leadUrl, { waitUntil: 'networkidle2' });
      await randomDelay(1000, 3000); // Random delay 1-3 seconds

      // Click the "Message" button to open the chat
      const messageButtonSelector = 'button[data-anchor-send-inmail]';
      await page.waitForSelector(messageButtonSelector, { visible: true, timeout: 10000 });
      await page.click(messageButtonSelector);
      console.log('Clicked the "Message" button to open the chat.');

      // Wait for the chat input to appear
      const chatInputSelector = 'div.msg-form__contenteditable[contenteditable="true"]';
      await page.waitForSelector(chatInputSelector, { visible: true, timeout: 10000 });

      // Type the message into the chat input
      await page.type(chatInputSelector, message.content);
      console.log(`Typed message into chat: ${message.content}`);

      // Wait for the send button to be enabled
      const sendButtonSelector = 'button.msg-form__send-button';
      await page.waitForSelector(`${sendButtonSelector}:not([disabled])`, { visible: true, timeout: 5000 });

      // Click the send button
      await page.click(sendButtonSelector);
      console.log('Clicked the send button.');

      // Wait for the message to be sent (e.g., by checking the chat history)
      await page.waitForSelector(`div.msg-s-event-listitem__message-bubble[title="${message.content}"]`, { timeout: 10000 });
      console.log('Message successfully sent.');

      return { success: true };
    } catch (error) {
      console.error(`Failed to send message to ${leadUrl}: ${error.message}`);
      return { success: false, error: error.message };
    }
  };

  // Close the browser (called at the end of the session)
  const closeBrowser = async () => {
    if (page) await page.close();
    if (browser) await browser.close();
    console.log('Browser closed.');
  };

  return { initializeBrowser, sendMessage, closeBrowser };
};