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

  // Send a message to a lead
  const sendMessage = async ({ leadUrl, message }) => {
    if (!page) {
      throw new Error('Browser not initialized. Call initializeBrowser first.');
    }

    if (!message || !message.content || typeof message.content !== 'string') {
      throw new Error('Invalid message format: message content must be a string');
    }
    
    // Convert any non-string content to string as a fallback
    const messageContent = String(message.content);

    console.log(`Navigating to profile: ${leadUrl}`);
    await page.goto(leadUrl, { waitUntil: 'networkidle2' });
    await randomDelay(1000, 3000); // Random delay 1-3 seconds

    // Retry logic for finding the Message button
    let messageButton = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Attempt ${attempt}: Waiting for the Message button...`);
        messageButton = await page.waitForSelector('button[data-anchor-send-inmail]', {
          timeout: 10000,
        });
        break;
      } catch (error) {
        console.error(`Attempt ${attempt} failed: ${error.message}`);
        if (attempt === 3) throw new Error('Message button not found after 3 attempts');
        await randomDelay(2000, 4000); // Wait 2-4 seconds before retrying
      }
    }

    console.log('Clicking the Message button...');
    await messageButton.click();
    await randomDelay(1000, 3000); // Random delay 1-3 seconds

    // Wait for the messaging modal
    console.log('Waiting for the messaging modal...');
    await page.waitForSelector('input._subject-field_jrrmou', { timeout: 10000 });

    console.log('Filling in the subject...');
    // Use a default subject if none is provided
    const subject = message.subject || "Let's connect";
    await page.type('input._subject-field_jrrmou', subject);
    await randomDelay(500, 1500); // Random delay 0.5-1.5 seconds

    console.log('Filling in the message content...');
    await page.type('textarea._message-field_jrrmou', messageContent);
    await randomDelay(500, 1500); // Random delay 0.5-1.5 seconds

    // Wait for the Send button
    console.log('Waiting for the Send button...');
    await page.waitForSelector('fieldset._actions-container_3o17um button._button_ps32ck._primary_ps32ck', {
      timeout: 10000,
    });

    console.log('Clicking the Send button...');
    await page.evaluate(() => {
      const sendButton = document.querySelector(
        'fieldset._actions-container_3o17um button._button_ps32ck._primary_ps32ck:not([disabled])'
      );
      if (sendButton) sendButton.click();
    });
    await randomDelay(2000, 4000); // Random delay 2-4 seconds

    console.log('Message sent successfully!');
    return { success: true, message: 'Message sent successfully.' };
  };

  // Close the browser (called at the end of the session)
  const closeBrowser = async () => {
    if (page) await page.close();
    if (browser) await browser.close();
    console.log('Browser closed.');
  };

  return { initializeBrowser, sendMessage, closeBrowser };
};