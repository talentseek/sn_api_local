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
      args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'],
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Set cookies for authentication
    await page.setCookie(
      {
        name: 'li_at',
        value: cookies.li_at,
        domain: '.linkedin.com',
        path: '/',
        httpOnly: true,
        secure: true,
      },
      {
        name: 'li_a',
        value: cookies.li_a,
        domain: '.linkedin.com',
        path: '/',
        httpOnly: true,
        secure: true,
      }
    );

    // Navigate to LinkedIn to verify login
    await page.goto('https://www.linkedin.com/sales', { waitUntil: 'networkidle2' });
    
    // Check if we're logged in
    const isLoggedIn = await page.evaluate(() => {
      return !document.querySelector('.login__form');
    });
    
    if (!isLoggedIn) {
      throw new Error('Failed to log in to LinkedIn with provided cookies');
    }
    
    console.log('Browser initialized successfully.');
    return true;
  };

  // Send a message to a lead
  const sendMessage = async ({ leadUrl, message, subject = "Let's connect", lead = {} }) => {
    // Validate inputs
    if (!leadUrl) throw new Error('Lead URL is required');
    
    // Fix the message format validation
    let messageContent = message;
    
    // Handle different message formats
    if (typeof message === 'object' && message.content) {
      messageContent = message.content;
    } else if (typeof message !== 'string') {
      throw new Error('Invalid message format: message content must be a string');
    }
    
    // Personalize the subject line
    let personalizedSubject = subject;
    if (lead && lead.company && subject.includes('{company}')) {
      personalizedSubject = subject.replace(/{company}/g, lead.company);
    }
    
    console.log(`Sending message to ${leadUrl}`);
    console.log(`Subject: ${personalizedSubject}`);
    console.log(`Message length: ${messageContent.length} characters`);
    
    if (!page) {
      throw new Error('Browser not initialized. Call initializeBrowser first.');
    }

    try {
      // Navigate to the lead's profile
      await page.goto(leadUrl, { waitUntil: 'networkidle2' });
      await randomDelay(2000, 4000); // Random delay 2-4 seconds

      // Click the Message button
      console.log('Clicking the Message button...');
      await page.waitForSelector('button[data-anchor-send-inmail]', { timeout: 10000 });
      await page.click('button[data-anchor-send-inmail]');
      await randomDelay(2000, 4000); // Random delay 2-4 seconds

      // Wait for the message compose dialog to appear
      console.log('Waiting for message compose dialog...');
      await page.waitForSelector('input._subject-field_jrrmou', { timeout: 10000 });
      await randomDelay(1000, 2000); // Random delay 1-2 seconds

      // Fill in the subject if available
      console.log('Filling in subject...');
      try {
        await page.type('input._subject-field_jrrmou', personalizedSubject);
        await randomDelay(1000, 2000); // Random delay 1-2 seconds
      } catch (subjectError) {
        console.log('Could not find subject field, continuing without subject');
      }

      // Fill in the message
      console.log('Filling in message...');
      await page.waitForSelector('textarea._message-field_jrrmou', { timeout: 10000 });
      await page.type('textarea._message-field_jrrmou', messageContent);
      await randomDelay(2000, 3000); // Random delay 2-3 seconds

      // Click the Send button
      console.log('Clicking the Send button...');
      await page.waitForSelector('fieldset._actions-container_3o17um button._button_ps32ck._primary_ps32ck', { timeout: 10000 });
      await page.evaluate(() => {
        const sendButton = document.querySelector('fieldset._actions-container_3o17um button._button_ps32ck._primary_ps32ck:not([disabled])');
        if (sendButton) sendButton.click();
      });
      await randomDelay(2000, 4000); // Random delay 2-4 seconds

      console.log('Message sent successfully!');
      return { success: true, message: 'Message sent successfully.' };
    } catch (error) {
      console.error(`Error sending message: ${error.message}`);
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