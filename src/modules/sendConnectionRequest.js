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
          // Check for both enabled and disabled buttons
          const connectButton = buttons.find(button => {
            const text = button.textContent.trim();
            // Skip buttons that are already pending
            if (text.includes('Pending') || text.includes('pending')) return false;
            return text === 'Connect';
          });
          return connectButton || null;
        }, connectButtonSelector);

        if (!connectButton) {
          // Check if the button exists but is disabled with "Pending" status
          const pendingStatus = await page.evaluate((selector) => {
            const buttons = Array.from(document.querySelectorAll(selector));
            const pendingButton = buttons.find(button => {
              const text = button.textContent.trim();
              return text.includes('Pending') || text.includes('pending');
            });
            return pendingButton ? 'pending' : null;
          }, connectButtonSelector);

          if (pendingStatus === 'pending') {
            logger.info('Connection request is already pending');
            return { success: true, status: 'pending' };
          }

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

      // Wait for the connection request modal to appear with increased timeout and better error handling
      const modalSelector = 'div.artdeco-modal-overlay';
      try {
        // First try to wait for the modal to be visible
        await page.waitForSelector(modalSelector, { visible: true, timeout: 15000 });
        
        // Then wait for it to be fully loaded and interactive
        await page.waitForFunction(
          (selector) => {
            const modal = document.querySelector(selector);
            return modal && !modal.offsetParent && modal.getAttribute('aria-hidden') === 'false';
          },
          { timeout: 15000 },
          modalSelector
        );
        
        logger.info('Connection request modal appeared and is interactive');
      } catch (error) {
        // Check if the connection request was already sent before logging any error
        const connectionStatus = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const buttonTexts = buttons.map(button => button.textContent.trim());
          
          if (buttonTexts.some(text => text.includes('Connect -- pending'))) return 'pending';
          if (buttonTexts.some(text => text.includes('Pending'))) return 'pending';
          if (buttonTexts.some(text => text.includes('Message sent'))) return 'pending';
          if (buttonTexts.some(text => text.includes('Message'))) return 'pending';
          if (buttonTexts.some(text => text.includes('Connected'))) return 'connected';
          
          return 'not_connected';
        });

        if (connectionStatus !== 'not_connected') {
          logger.info(`Lead is already ${connectionStatus}`);
          return { success: true, status: connectionStatus };
        }

        // Only log error if we're not in a known good state
        logger.error(`Modal did not appear after clicking Connect: ${error.message}`);
        throw new Error('Failed to open connection request modal');
      }

      // Add a delay to ensure the modal is fully loaded
      await delay(2000);

      // Check if we need to click "Add a note" first
      const addNoteButtonSelector = 'button[aria-label="Add a note"]';
      const addNoteButton = await page.$(addNoteButtonSelector);
      if (addNoteButton) {
        logger.info('Found "Add a note" button, clicking it');
        await addNoteButton.click();
        await delay(1000);
      }

      // Fill in the message in the textarea
      const messageTextareaSelector = 'textarea#connect-cta-form__invitation';
      await page.waitForSelector(messageTextareaSelector, { visible: true, timeout: 5000 });
      
      // Clear any existing text first
      await page.evaluate((selector) => {
        const textarea = document.querySelector(selector);
        if (textarea) {
          textarea.value = '';
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, messageTextareaSelector);
      
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

      // Click the button and wait for any animations
      await page.evaluate((selector) => {
        const button = document.querySelector(selector);
        if (button) {
          button.click();
          return true;
        }
        return false;
      }, sendButtonSelector);
      logger.info('Clicked the "Send Invitation" button');

      // Add a delay after clicking
      await delay(2000);

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

      // Wait for the modal to close or the "Connect -- pending" status to appear
      try {
        await Promise.race([
          page.waitForSelector(modalSelector, { hidden: true, timeout: 20000 }),
          page.waitForFunction(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.some(button => 
              button.textContent.includes('Connect -- pending') || 
              button.textContent.includes('Pending') ||
              button.textContent.includes('Message sent')
            );
          }, { timeout: 20000 })
        ]);
      } catch (error) {
        logger.warn('Timeout waiting for modal to close or status to change. Checking current state...');
        
        // Check if the connection request was already sent
        const connectionStatus = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const buttonTexts = buttons.map(button => button.textContent.trim());
          
          if (buttonTexts.some(text => text.includes('Connect -- pending'))) return 'pending';
          if (buttonTexts.some(text => text.includes('Pending'))) return 'pending';
          if (buttonTexts.some(text => text.includes('Message sent'))) return 'pending';
          if (buttonTexts.some(text => text.includes('Message'))) return 'pending';
          if (buttonTexts.some(text => text.includes('Connected'))) return 'connected';
          if (buttonTexts.some(text => text.includes('Following'))) return 'following';
          
          return 'not_connected';
        });

        if (connectionStatus !== 'not_connected') {
          logger.info(`Lead is already ${connectionStatus}`);
          return { success: true, status: connectionStatus };
        }

        // Check if the modal is still visible
        const isModalVisible = await page.evaluate((selector) => {
          const modal = document.querySelector(selector);
          return modal && !modal.offsetParent;
        }, modalSelector);
        
        if (isModalVisible) {
          // Try clicking the send button again
          logger.info('Modal still visible, attempting to click send button again');
          await page.evaluate((selector) => {
            const button = document.querySelector(selector);
            if (button) {
              button.click();
              return true;
            }
            return false;
          }, sendButtonSelector);
          await delay(2000);
          
          // Check if the modal is now hidden
          const isModalStillVisible = await page.evaluate((selector) => {
            const modal = document.querySelector(selector);
            return modal && !modal.offsetParent;
          }, modalSelector);
          
          if (isModalStillVisible) {
            throw new Error('Modal still visible after second attempt to send invitation');
          }
        }
      }

      // Add a delay to allow the UI to update
      await delay(2000);

      // Verify the connection request was sent by checking for various success states
      const requestStatus = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const buttonTexts = buttons.map(button => button.textContent.trim());
        
        // Check for various success states
        if (buttonTexts.some(text => text.includes('Connect -- pending'))) return 'pending';
        if (buttonTexts.some(text => text.includes('Pending'))) return 'pending';
        if (buttonTexts.some(text => text.includes('Message sent'))) return 'sent';
        if (buttonTexts.some(text => text.includes('Message'))) return 'sent';
        
        // Check if the modal is gone
        const modal = document.querySelector('div.artdeco-modal-overlay');
        if (!modal || modal.offsetParent === null) return 'modal_closed';
        
        return 'unknown';
      });

      logger.info(`Connection request status: ${requestStatus}`);
      
      if (requestStatus === 'unknown') {
        // Take a screenshot for debugging
        await page.screenshot({ path: 'connection-request-error.png' });
        throw new Error('Could not verify connection request was sent successfully');
      }

      logger.success(`Successfully sent connection request to ${linkedinUrl}${standardProfileUrl ? ` (via standard profile: ${standardProfileUrl})` : ''}`);

      return { success: true, status: requestStatus };
    } catch (error) {
      logger.error(`Failed to send connection request to ${linkedinUrl}: ${error.message}`);
      return { success: false, error: error.message };
    }
  };

  return { sendRequest };
};

module.exports = sendConnectionRequest;