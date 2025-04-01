/**
 * LinkedIn Sales Navigator scraper module
 * @module modules/scraper
 */

const puppeteer = require('puppeteer');
const createLogger = require('../utils/logger');
const zoomHandler = require('./zoomHandler');
const config = require('../utils/config');

/**
 * Creates a scraper instance for LinkedIn Sales Navigator
 * @returns {Object} Scraper methods
 */
const scraper = () => {
  const logger = createLogger();
  let browser = null;
  let page = null;

  // Custom delay function
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * Initialize the browser and page
   * @param {Object} cookies - LinkedIn cookies (li_at and li_a)
   * @returns {Promise<void>}
   */
  const initializeBrowser = async (cookies) => {
    logger.info('Starting Puppeteer with Chromium...');
    browser = await puppeteer.launch({
      headless: true, // Keep headless true for server environment
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
    });
    logger.info('Creating new page...');
    page = await browser.newPage();

    // Set viewport from config
    const { width, height, deviceScaleFactor } = config.viewport;
    await page.setViewport({ width, height, deviceScaleFactor });
    logger.info(`Viewport set to: ${JSON.stringify(config.viewport)}`);

    // Apply zoom settings using zoomHandler
    await zoomHandler(page);
    logger.info('Zoom settings applied.');

    logger.info('Setting cookies for authentication...');
    if (!cookies || !cookies.li_at || !cookies.li_a) {
        throw new Error('Missing required cookies (li_at, li_a)');
    }
    await page.setCookie(
      { name: 'li_at', value: cookies.li_at, domain: '.linkedin.com' },
      { name: 'li_a', value: cookies.li_a, domain: '.linkedin.com' }
    );
    logger.info('Browser initialized and cookies set.');
  };

  /**
   * Splits a full name into first and last name.
   * @param {string} fullName - The full name string.
   * @returns {object} - Object with firstName and lastName properties.
   */
  function splitName(fullName) {
    if (!fullName || typeof fullName !== 'string') {
      return { firstName: '', lastName: '' };
    }
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    return { firstName, lastName };
  }


  /**
   * Scrape search results page by page.
   * @param {string} searchUrl - The base Sales Navigator search URL.
   * @param {number} lastPage - The last page number to scrape.
   * @returns {Promise<Array<Object>>} - Array of raw scraped profile data.
   */
  const scrapeSearchResults = async (searchUrl, lastPage) => {
    if (!page) {
      throw new Error('Browser page is not initialized. Call initializeBrowser first.');
    }

    const allResults = [];
    logger.info(`Starting to scrape pages 1 to ${lastPage}...`);

    try {
      for (let currentPage = 1; currentPage <= lastPage; currentPage++) {
        logger.info(`Scraping page ${currentPage} of ${lastPage}`);

        const paginatedUrl = `${searchUrl}&page=${currentPage}`;
        logger.info(`Navigating to: ${paginatedUrl}`);
        await page.goto(paginatedUrl, { waitUntil: 'networkidle2', timeout: 60000 }); // Increased timeout

        // Wait for the main results container
        try {
            await page.waitForSelector('#search-results-container > div > ol > li', { timeout: 30000 });
            logger.info('Results container found.');
        } catch (waitError) {
            logger.warn(`Could not find results list (#search-results-container > div > ol > li) on page ${currentPage}. Checking for empty results or page issues.`);
            // Check if it's an empty results page
            const isEmpty = await page.$('.artdeco-empty-state');
            if (isEmpty) {
                logger.warn(`Page ${currentPage} appears to be empty or end of results. Stopping pagination.`);
                break; // Stop if no results found
            }
            // Check for common errors like "Hmm, something went wrong"
            const pageError = await page.evaluate(() => document.body.innerText.includes("something went wrong") || document.body.innerText.includes("try again"));
            if (pageError) {
                 logger.error(`LinkedIn page error detected on page ${currentPage}. Stopping pagination.`);
                 break;
            }
            // If neither empty nor known error, rethrow the original timeout
            throw new Error(`Timeout waiting for results selector on page ${currentPage}. URL: ${paginatedUrl}. Error: ${waitError.message}`);
        }


        const pageResults = await page.evaluate(() => {
          const results = [];
          // Use the selector from the working example
          const resultElements = document.querySelectorAll('#search-results-container > div > ol > li');

          resultElements.forEach((element, index) => {
            try {
                // --- Use selectors from the working example ---
                const nameElement = element.querySelector('.artdeco-entity-lockup__title > a > span');
                const name = nameElement ? nameElement.textContent.trim() : null;

                // Profile Link (Crucial)
                const profileLinkAnchor = element.querySelector('.artdeco-entity-lockup__title > a');
                const profileLink = profileLinkAnchor ? profileLinkAnchor.href : null; // Get full URL

                const jobTitleElement = element.querySelector('.artdeco-entity-lockup__subtitle');
                // Extract primary job title and company if possible from subtitle structure
                let jobTitle = null;
                let companyFromSubtitle = null;
                if (jobTitleElement) {
                    const parts = jobTitleElement.innerText.split('\n').map(s => s.trim()).filter(Boolean);
                    jobTitle = parts[0] || null; // First line is usually title
                    if (parts.length > 1) {
                        // Check if the last part looks like a company link within the subtitle
                        const companyLinkElement = jobTitleElement.querySelector('a[data-anonymize="company-name"]');
                        if (companyLinkElement) {
                            companyFromSubtitle = companyLinkElement.textContent.trim();
                        } else {
                             // Fallback: Assume last line is company if no link found
                             companyFromSubtitle = parts[parts.length - 1];
                        }
                    }
                }

                // Company Name (Prefer specific link, fallback to subtitle extraction)
                const companyNameElement = element.querySelector('a[data-anonymize="company-name"]');
                const company = companyNameElement ? companyNameElement.textContent.trim() : companyFromSubtitle;

                // Company Link
                const companyLinkElement = element.querySelector('a[data-anonymize="company-name"]');
                // Ensure it's a relative path before prepending domain, or use absolute if provided
                let companyLink = null;
                if (companyLinkElement) {
                    const href = companyLinkElement.getAttribute('href');
                    if (href) {
                        companyLink = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
                    }
                }

                const connectionLevelElement = element.querySelector('.artdeco-entity-lockup__degree');
                // Clean up the connection level text (e.g., "· 2nd")
                const connectionLevel = connectionLevelElement
                  ? connectionLevelElement.textContent.replace(/·\s*/, '').trim()
                  : null;

                // --- End of selectors from working example ---

                // Basic check: If profileLink is missing, log it here
                if (!profileLink) {
                   console.log(`[Browser] Skipping item index ${index} on page: Missing profileLink. Name: ${name || 'N/A'}`);
                   return; // Skip this item if the crucial link is missing
                }
                 if (!name) {
                   console.log(`[Browser] Skipping item index ${index} on page: Missing name. ProfileLink: ${profileLink}`);
                   return; // Skip if name is missing
                }


                results.push({
                  name,
                  profileLink,
                  jobTitle,
                  company,
                  companyLink,
                  connectionLevel,
                  // Add other fields from example if needed later (location, about)
                });

            } catch (e) {
                 console.error(`[Browser] Error processing item index ${index} on page: ${e.message}`);
            }
          });

          return results;
        });

        logger.info(`Extracted ${pageResults.length} valid profiles from page ${currentPage}.`);
        allResults.push(...pageResults);

        // Add a random delay like in the example
        if (currentPage < lastPage) {
            const randomDelayMs = Math.floor(Math.random() * (4000 - 1500 + 1)) + 1500; // 1.5-4 seconds
            logger.info(`Waiting ${randomDelayMs}ms before scraping next page...`);
            await delay(randomDelayMs);
        }
      }

      logger.info(`Finished scraping ${lastPage} pages. Total raw results: ${allResults.length}.`);

      // Validate the results before returning
      const validProfiles = allResults.filter(profile => {
        // Check for required fields
        if (!profile || !profile.name || !profile.profileLink) {
          logger.warn(`Invalid profile found: ${JSON.stringify(profile)}`);
          return false;
        }
        return true;
      });

      logger.info(`Validated ${validProfiles.length} profiles out of ${allResults.length} total.`);
      return validProfiles; // Return only valid profiles

    } catch (error) {
      logger.error(`Error during scraping process: ${error.message}`);
      if (error.stack) {
          logger.error(`Stack trace: ${error.stack}`);
      }
      // Return whatever was collected so far, along with the error
      return { leads: allResults, error: error.message };
    }
  };

  /**
   * Close the browser
   * @returns {Promise<void>}
   */
  const closeBrowser = async () => {
    if (page) {
      try {
        await page.close();
        page = null;
      } catch (e) {
        logger.warn(`Error closing page: ${e.message}`);
      }
    }
    if (browser) {
      try {
        await browser.close();
        browser = null;
        logger.info('Browser closed');
      } catch (e) {
        logger.warn(`Error closing browser: ${e.message}`);
      }
    } else {
        logger.info('Browser already closed or not initialized.');
    }
  };

  return {
    initializeBrowser,
    scrapeSearchResults,
    closeBrowser
  };
};

module.exports = scraper;