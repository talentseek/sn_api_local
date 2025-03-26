module.exports = (page) => {
  const checkOpenProfile = async (profileUrl) => {
    try {
      // Ensure the URL is a string and valid
      if (typeof profileUrl !== 'string' || !profileUrl.includes('linkedin.com')) {
        throw new Error(`Invalid profile URL: ${profileUrl}`);
      }

      console.log(`Navigating to profile URL: ${profileUrl}`);
      // Navigate to the profile URL with retry logic
      let navigationSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          navigationSuccess = true;
          break;
        } catch (error) {
          console.error(`Navigation attempt ${attempt} failed: ${error.message}`);
          if (attempt === 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      if (!navigationSuccess) {
        throw new Error('Failed to navigate to profile URL after 3 attempts');
      }

      // Simplified human-like behavior: only a small scroll and delay
      console.log('Simulating human-like behavior...');
      await page.evaluate(() => window.scrollBy(0, 300));
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Wait for the profile page to fully load by checking for the profile name heading
      console.log('Waiting for profile page to load (checking for h1[data-x--lead--name])...');
      try {
        await page.waitForSelector('h1[data-x--lead--name]', { timeout: 30000 });
        console.log('Profile page loaded successfully (h1[data-x--lead--name] found).');
      } catch (error) {
        console.error('Failed to load profile page: h1[data-x--lead--name] not found within 30 seconds.');
        const pageContent = await page.content();
        console.log(`Final page content (first 2000 characters):\n${pageContent.slice(0, 2000)}...`);
        throw new Error('Profile page did not load within 30 seconds.');
      }

      // Check if the "Message" button is available
      console.log('Checking for Message button...');
      let messageButton = await page.$('button[data-anchor-send-inmail]');

      // Fallback: Use text-based search if the primary selector fails
      if (!messageButton) {
        console.log('Primary selector not found, trying text-based search...');
        const buttons = await page.$$('button');
        for (const button of buttons) {
          const text = await page.evaluate(el => el.textContent.trim(), button);
          if (text.includes('Message')) {
            messageButton = button;
            console.log('Message button found via text-based search.');
            break;
          }
        }
      }

      if (messageButton) {
        console.log('Message button found, clicking to open InMail modal...');
        await messageButton.click();

        console.log('Waiting for InMail modal...');
        await page.waitForSelector('span.ml1.t-12.truncate', { timeout: 5000 });

        console.log('Checking for Open Profile indicator...');
        const isOpen = await page.evaluate(() => {
          const openProfileIndicator = document.querySelector('span.ml1.t-12.truncate');
          const isOpenProfile = openProfileIndicator?.textContent.includes('Free to Open Profile') || false;
          console.log(`Open Profile indicator text: ${openProfileIndicator?.textContent}, isOpen: ${isOpenProfile}`);
          return isOpenProfile;
        });

        console.log(`Profile ${profileUrl} is ${isOpen ? 'an Open Profile' : 'not an Open Profile'}`);
        return isOpen;
      } else {
        console.log('Message button not available, marking as not an Open Profile.');
        const pageContent = await page.content();
        console.log(`Final page content (no Message button, first 2000 characters):\n${pageContent.slice(0, 2000)}...`);
        return false;
      }
    } catch (error) {
      console.error(`Error checking profile ${profileUrl}: ${error.message}`);
      return false;
    }
  };

  return { checkOpenProfile };
};