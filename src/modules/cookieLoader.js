const puppeteer = require('puppeteer');
const createLogger = require('../utils/logger');
const config = require('../utils/config');

/**
 * Loads LinkedIn cookies from the campaign in the database
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase - Supabase client instance
 * @param {Object} options - Options object
 * @param {string} options.campaignId - Campaign ID to fetch cookies from
 * @returns {Promise<{cookies: {li_at: string, li_a: string}, error: string|null}>} - Object containing cookies or error
 */
const cookieLoader = async (supabase, { campaignId }) => {
  const logger = require('../utils/logger')();
  
  try {
    logger.info('Starting Puppeteer with Chromium...');
    
    // Fetch cookies from the campaign
    const { data: campaignData, error: campaignError } = await supabase
      .from('campaigns')
      .select('cookies')
      .eq('id', parseInt(campaignId))
      .single();
    
    if (campaignError || !campaignData?.cookies) {
      const errorMsg = campaignError 
        ? `Failed to fetch cookies: ${campaignError.message}` 
        : `No valid cookies found for campaign ${campaignId}`;
      logger.error(errorMsg);
      return { cookies: null, error: errorMsg };
    }
    
    logger.info('Creating new page...');
    logger.info('Setting cookies for authentication...');
    
    // Return the cookies
    return { 
      cookies: {
        li_at: campaignData.cookies.li_at,
        li_a: campaignData.cookies.li_a
      }, 
      error: null 
    };
  } catch (error) {
    const errorMsg = `Error in cookieLoader: ${error.message}`;
    logger.error(errorMsg);
    return { cookies: null, error: errorMsg };
  }
};

module.exports = cookieLoader;