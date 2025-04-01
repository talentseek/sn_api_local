const createLogger = require('./logger');
const logger = createLogger();

/**
 * Personalizes a message template by replacing placeholders with actual values
 * @param {string} template - The message template with placeholders
 * @param {Object} profile - The profile data to use for personalization
 * @param {string} [landingPageUrl] - Optional landing page URL
 * @param {string} [cpdLandingPageUrl] - Optional CPD landing page URL
 * @returns {string} The personalized message
 */
const personalizeMessage = (template, profile, landingPageUrl = null, cpdLandingPageUrl = null) => {
  try {
    let message = template;

    // Replace profile data placeholders
    const replacements = {
      '{first_name}': profile.first_name || '',
      '{last_name}': profile.last_name || '',
      '{company}': profile.company || '',
      '{job_title}': profile.job_title || '',
      '{linkedin}': profile.linkedin || '',
      '{landing_page_url}': landingPageUrl || '',
      '{cpd_landing_page_url}': cpdLandingPageUrl || ''
    };

    // Replace all placeholders in the template
    Object.entries(replacements).forEach(([placeholder, value]) => {
      message = message.replace(new RegExp(placeholder, 'g'), value);
    });

    return message;
  } catch (error) {
    logger.error(`Error personalizing message: ${error.message}`);
    return template; // Return original template if personalization fails
  }
};

module.exports = {
  personalizeMessage
}; 