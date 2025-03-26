const createLogger = require('../utils/logger');

module.exports = function scraper(page, totalPages, searchUrl) {
  const logger = createLogger();

  function splitName(fullName) {
    if (!fullName || typeof fullName !== 'string') {
      return { firstName: '', lastName: '' };
    }
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    return { firstName, lastName };
  }

  function cleanData(rawData) {
    return rawData.map((entry) => {
      const { firstName, lastName } = splitName(entry.name);
      let company = entry.company || '';
      if (!company && entry.jobTitle) {
        const jobParts = entry.jobTitle.split('\n').map((part) => part.trim());
        company = jobParts.length > 1 ? jobParts[jobParts.length - 1] : '';
      }
      return {
        firstName,
        lastName,
        jobTitle: entry.jobTitle?.trim() || '',
        company: company || null,
        profileLink: entry.profileLink?.trim() || 'N/A',
        connectionLevel: entry.connectionLevel || 'N/A',
        location: entry.location || 'N/A',
        about: entry.about || 'N/A',
        companyLink: entry.companyLink || 'N/A',
        isPremium: entry.isPremium || false,
      };
    });
  }

  async function scrapePage(currentPage) {
    try {
      logger.info(`Scraping page ${currentPage}/${totalPages}`);

      const paginatedUrl = `${searchUrl}&page=${currentPage}`;
      await page.goto(paginatedUrl, { waitUntil: 'networkidle2' });

      await page.waitForSelector('#search-results-container', { timeout: 30000 });

      const pageResults = await page.evaluate(() => {
        const results = [];
        const resultElements = document.querySelectorAll('#search-results-container > div > ol > li');

        resultElements.forEach((element) => {
          const nameElement = element.querySelector('.artdeco-entity-lockup__title > a > span');
          const name = nameElement ? nameElement.textContent.trim() : null;

          const profileLink = element.querySelector('.artdeco-entity-lockup__title > a')?.href || null;

          const jobTitleElement = element.querySelector('.artdeco-entity-lockup__subtitle');
          const jobTitle = jobTitleElement ? jobTitleElement.textContent.trim() : null;

          const companyElement = element.querySelector('.artdeco-entity-lockup__subtitle a[data-anonymize="company-name"]');
          const company = companyElement ? companyElement.textContent.trim() : null;

          const connectionLevelElement = element.querySelector('.artdeco-entity-lockup__degree');
          const connectionLevel = connectionLevelElement
            ? connectionLevelElement.textContent.replace(/·\s*/, '').trim()
            : null;

          const locationElement = element.querySelector('.artdeco-entity-lockup__caption span[data-anonymize="location"]');
          const location = locationElement ? locationElement.textContent.trim() : null;

          const aboutElement = element.querySelector('dt.t-12 + dd .t-12 span');
          const about = aboutElement ? aboutElement.textContent.trim() : null;

          const companyLinkElement = element.querySelector('a[data-anonymize="company-name"]');
          const companyLink = companyLinkElement
            ? `https://www.linkedin.com${companyLinkElement.getAttribute('href')}`
            : null;

          const isPremiumElement = element.querySelector('li-icon[type="linkedin-premium-gold-icon"]');
          const isPremium = Boolean(isPremiumElement);

          results.push({
            name,
            profileLink,
            jobTitle,
            company,
            connectionLevel,
            location,
            about,
            companyLink,
            isPremium,
          });
        });

        return results;
      });

      logger.success(`Scraped ${pageResults.length} results from page ${currentPage}`);
      const cleanedResults = cleanData(pageResults);
      return cleanedResults;
    } catch (error) {
      logger.error(`Error scraping page ${currentPage}: ${error.message}`);
      throw error;
    }
  }

  return { scrapePage };
};