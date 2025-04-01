/**
 * Scrapes company data from a company's LinkedIn page.
 * @param {import('puppeteer').Page} page - The Puppeteer page instance.
 * @param {string} companyLink - The URL to the company's LinkedIn page.
 * @returns {Promise<Object|null>} An object containing the "about" text, the website URL, and website meta data,
 * or null if an error occurs.
 */
module.exports = async function scrapeCompanyData(page, companyLink) {
  try {
    // Visit the company's LinkedIn page
    await page.goto(companyLink, { waitUntil: 'networkidle2' });
    
    // Wait for the about element to be available.
    await page.waitForSelector('[data-anonymize="company-blurb"]', { timeout: 10000 });
    
    // Check for the "Show more" button and click it if found.
    const showMoreButtonSelector = 'button[data-control-name="read_more_description"]';
    const showMoreButton = await page.$(showMoreButtonSelector);
    if (showMoreButton) {
      await showMoreButton.click();
      // Wait a short time for the content to expand using a promise-based delay.
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (err) {
    console.error(`Error navigating to company LinkedIn page (${companyLink}): ${err.message}`);
    return null;
  }

  // Extract the about text using the provided selector.
  const about = await page.evaluate(() => {
    const aboutElement = document.querySelector('[data-anonymize="company-blurb"]');
    return aboutElement ? aboutElement.innerText.trim() : null;
  });

  // Extract the website URL using the provided selector.
  const websiteUrl = await page.evaluate(() => {
    const websiteAnchor = document.querySelector('a[data-control-name="visit_company_website"]');
    return websiteAnchor ? websiteAnchor.href : null;
  });

  let websiteMeta = null;
  if (websiteUrl) {
    try {
      // Open a new page to scrape the external website's meta data.
      const browser = page.browser();
      const websitePage = await browser.newPage();
      await websitePage.goto(websiteUrl, { waitUntil: 'networkidle2' });
      
      websiteMeta = await websitePage.evaluate(() => {
        const title = document.querySelector('title')?.innerText || null;
        const metaDescription = document.querySelector('meta[name="description"]')
          ? document.querySelector('meta[name="description"]').getAttribute('content')
          : null;
        const ogDescription = document.querySelector('meta[property="og:description"]')
          ? document.querySelector('meta[property="og:description"]').getAttribute('content')
          : null;
        return { title, metaDescription, ogDescription };
      });
      await websitePage.close();
    } catch (err) {
      console.error(`Error scraping website meta data from ${websiteUrl}: ${err.message}`);
    }
  }

  return {
    about,
    website: websiteUrl,
    meta: websiteMeta,
  };
}; 