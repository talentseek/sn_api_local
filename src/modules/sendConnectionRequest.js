const createLogger = require('../utils/logger');

const logger = createLogger();

// Custom delay function to replace page.waitForTimeout
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const sendConnectionRequest = (page) => {
  const sendRequest = async (linkedinUrl, message) => {
    try {
      // Navigate to the lead's profile
      logger.info(`Navigating to profile: ${linkedinUrl}`);
      await page.goto(linkedinUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      // Check if the "Connect" button is directly available on the page (common on standard profile pages)
      let connectButtonSelector = 'button[aria-label="Invite to connect"]';
      let connectButton = await page.$(connectButtonSelector);
      let standardProfileUrl = null;

      if (!connectButton) {
        // If the "Connect" button isn't directly available, try the overflow menu (common on Sales Navigator)
        const threeDotsSelector = 'button[id^="hue-menu-trigger-ember"][class*="_overflow-menu--trigger_1xow7n"]';
        await page.waitForSelector(threeDotsSelector, { visible: true, timeout: 10000 });

        // Extract the aria-controls value to target the exact menu
        const ariaControls = await page.evaluate((selector) => {
          const button = document.querySelector(selector);
          return button ? button.getAttribute('aria-controls') : null;
        }, threeDotsSelector);

        if (!ariaControls) {
          throw new Error('Could not find aria-controls attribute on the three dots button');
        }

        await page.click(threeDotsSelector);
        logger.info('Clicked the three dots button to open the overflow menu');

        // Wait for the menu to appear
        const menuSelector = `div#${ariaControls}[aria-hidden="false"]`;
        await page.waitForSelector(menuSelector, { visible: true, timeout: 10000 });

        // Log the menu content for debugging
        const menuContent = await page.evaluate((selector) => {
          const menu = document.querySelector(selector);
          return menu ? menu.innerHTML : 'Menu not found';
        }, menuSelector);
        logger.info(`Menu content for ${menuSelector}:\n${menuContent}`);

        // Find the "Connect" button in the menu using a standard CSS selector and text filtering
        connectButtonSelector = `div#${ariaControls}[aria-hidden="false"] li button._item_1xnv7i`;
        connectButton = await page.evaluateHandle((selector) => {
          const buttons = Array.from(document.querySelectorAll(selector));
          return buttons.find(button => button.textContent.trim() === 'Connect') || null;
        }, connectButtonSelector);

        if (!connectButton) {
          logger.warn('Connect button not found in the overflow menu. Attempting to find standard LinkedIn profile URL...');

          // Try to extract the standard LinkedIn profile URL from the "View LinkedIn profile" link
          const viewProfileLinkSelector = `div#${ariaControls}[aria-hidden="false"] li a._item_1xnv7i`;
          const viewProfileLink = await page.evaluateHandle((selector) => {
            const links = Array.from(document.querySelectorAll(selector));
            return links.find(link => link.textContent.trim() === 'View LinkedIn profile') || null;
          }, viewProfileLinkSelector);

          if (viewProfileLink) {
            standardProfileUrl = await page.evaluate((selector) => {
              const link = document.querySelector(selector);
              return link ? link.getAttribute('href') : null;
            }, viewProfileLinkSelector);

            if (standardProfileUrl) {
              logger.info(`Found standard LinkedIn profile URL: ${standardProfileUrl}`);
              // Navigate to the standard profile URL
              await page.goto(standardProfileUrl, { waitUntil: 'networkidle2', timeout: 30000 });

              // Try to find the "Connect" button on the standard profile page
              connectButtonSelector = 'button[aria-label="Invite to connect"]';
              connectButton = await page.$(connectButtonSelector);

              if (!connectButton) {
                // If the "Connect" button still isn't available, try the overflow menu on the standard profile page
                await page.waitForSelector(threeDotsSelector, { visible: true, timeout: 10000 });
                await page.click(threeDotsSelector);
                logger.info('Clicked the three dots button on the standard profile page to open the overflow menu');

                const standardAriaControls = await page.evaluate((selector) => {
                  const button = document.querySelector(selector);
                  return button ? button.getAttribute('aria-controls') : null;
                }, threeDotsSelector);

                if (!standardAriaControls) {
                  throw new Error('Could not find aria-controls attribute on the three dots button (standard profile page)');
                }

                const standardMenuSelector = `div#${standardAriaControls}[aria-hidden="false"]`;
                await page.waitForSelector(standardMenuSelector, { visible: true, timeout: 10000 });

                connectButtonSelector = `div#${standardAriaControls}[aria-hidden="false"] li button._item_1xnv7i`;
                connectButton = await page.evaluateHandle((selector) => {
                  const buttons = Array.from(document.querySelectorAll(selector));
                  return buttons.find(button => button.textContent.trim() === 'Connect') || null;
                }, connectButtonSelector);

                if (!connectButton) {
                  throw new Error('Connect button not found on the standard LinkedIn profile page');
                }
              }
            } else {
              throw new Error('Could not extract standard LinkedIn profile URL from the menu');
            }
          } else {
            throw new Error('Connect button and View LinkedIn profile link not found in the overflow menu');
          }
        }

        // Click the "Connect" button using page.evaluate
        await page.evaluate((selector) => {
          const button = document.querySelector(selector);
          if (button) button.click();
        }, connectButtonSelector);
        logger.info('Clicked the "Connect" button using evaluate method');
      }

      // Wait for the connection request modal to appear
      const modalSelector = 'div.artdeco-modal-overlay';
      await page.waitForSelector(`${modalSelector}[aria-hidden="false"]`, { visible: true, timeout: 10000 });
      logger.info('Connection request modal appeared');

      // Log the modal's state before proceeding
      const modalStateBefore = await page.evaluate((selector) => {
        const modal = document.querySelector(selector);
        return modal ? { ariaHidden: modal.getAttribute('aria-hidden'), isVisible: !modal.offsetParent } : null;
      }, modalSelector);
      logger.info(`Modal state before filling message: ${JSON.stringify(modalStateBefore)}`);

      // Fill in the message in the textarea
      const messageTextareaSelector = 'textarea#connect-cta-form__invitation';
      await page.waitForSelector(messageTextareaSelector, { visible: true, timeout: 5000 });
      await page.type(messageTextareaSelector, message);
      logger.info(`Added message to connection request: ${message}`);

      // Add a delay to ensure LinkedIn's JavaScript is ready
      await delay(1000);

      // Click the "Send Invitation" button using page.evaluate
      const sendButtonSelector = 'button.connect-cta-form__send';
      await page.waitForSelector(sendButtonSelector, { visible: true, timeout: 5000 });

      // Log whether the button was found
      const sendButtonExists = await page.evaluate((selector) => {
        const button = document.querySelector(selector);
        return !!button;
      }, sendButtonSelector);
      logger.info(`"Send Invitation" button found: ${sendButtonExists}`);

      if (!sendButtonExists) {
        throw new Error('"Send Invitation" button not found on the page');
      }

      await page.evaluate((selector) => {
        const button = document.querySelector(selector);
        if (button) button.click();
      }, sendButtonSelector);
      logger.info('Clicked the "Send Invitation" button');

      // Check for error messages or CAPTCHAs
      const errorMessage = await page.evaluate(() => {
        const error = document.querySelector('div.error-container, div[role="alert"]');
        return error ? error.textContent.trim() : null;
      });
      if (errorMessage) {
        throw new Error(`LinkedIn error after clicking "Send Invitation": ${errorMessage}`);
      }

      const captcha = await page.$('iframe[src*="challenge"]');
      if (captcha) {
        throw new Error('CAPTCHA detected after clicking "Send Invitation". Manual intervention required.');
      }

      // Log the modal's state after clicking "Send Invitation"
      const modalStateAfter = await page.evaluate((selector) => {
        const modal = document.querySelector(selector);
        return modal ? { ariaHidden: modal.getAttribute('aria-hidden'), isVisible: !modal.offsetParent } : null;
      }, modalSelector);
      logger.info(`Modal state after clicking "Send Invitation": ${JSON.stringify(modalStateAfter)}`);

      // Log the page content for debugging
      const pageContent = await page.evaluate(() => document.body.innerHTML);
      logger.info(`Page content after clicking "Send Invitation":\n${pageContent}`);

      // Wait for the modal to close or the "Connect -- pending" status to appear
      await Promise.race([
        page.waitForSelector(modalSelector, { hidden: true, timeout: 20000 }),
        page.waitForSelector('button:has-text("Connect -- pending")', { visible: true, timeout: 20000 }),
      ]);
      logger.success(`Successfully sent connection request to ${linkedinUrl}${standardProfileUrl ? ` (via standard profile: ${standardProfileUrl})` : ''}`);

      return true;
    } catch (error) {
      logger.error(`Failed to send connection request to ${linkedinUrl}: ${error.message}`);
      throw error;
    }
  };

  return { sendRequest };
};

module.exports = sendConnectionRequest;