require('dotenv').config();
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const createLogger = require('../utils/logger');
const { withTimeout } = require('../utils/databaseUtils');
const { bot } = require('../telegramBot');

const logger = createLogger();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Validate Telegram configuration
const TELEGRAM_NOTIFICATION_CHAT_ID = process.env.TELEGRAM_NOTIFICATION_CHAT_ID;
if (!TELEGRAM_NOTIFICATION_CHAT_ID) {
  logger.error('Missing Telegram configuration: TELEGRAM_NOTIFICATION_CHAT_ID must be set in .env');
  process.exit(1);
}

// Randomize the interval between 50 and 70 minutes
const getRandomInterval = () => {
  const minMinutes = 50;
  const maxMinutes = 70;
  const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
  return randomMinutes;
};

// Utility function to add a delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Lock variable to prevent overlapping checks
let isChecking = false;

// Function to check cookies for all active campaigns
const checkCookiesForActiveCampaigns = async () => {
  if (isChecking) {
    logger.warn('Another cookie check is already in progress. Skipping this run.');
    return;
  }

  isChecking = true;
  try {
    logger.info('Starting scheduled cookie check for active campaigns...');

    // Fetch all active campaigns
    const { data: campaigns, error } = await withTimeout(
      supabase
        .from('campaigns')
        .select('id, name')
        .eq('status', 'active'),
      10000,
      'Timeout while fetching active campaigns'
    );

    if (error || !campaigns || campaigns.length === 0) {
      logger.warn(`No active campaigns found: ${error?.message || 'No data'}`);
      return;
    }

    logger.info(`Found ${campaigns.length} active campaigns.`);

    // Check cookies for each campaign sequentially with a delay
    for (const campaign of campaigns) {
      try {
        logger.info(`Checking cookies for campaign ${campaign.id} (${campaign.name})`);
        const response = await fetch('http://localhost:8080/api/check-cookies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ campaignId: campaign.id }),
        });

        const result = await response.json();

        if (!result.success) {
          logger.error(`Failed to check cookies for campaign ${campaign.id}: ${result.error}`);
          continue;
        }

        if (result.cookiesStatus === 'invalid') {
          const message = `⚠️ Invalid cookies detected for campaign ${campaign.id} (${campaign.name}). Please update the cookies.`;
          await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, message);
          logger.info(`Sent Telegram notification for invalid cookies in campaign ${campaign.id}`);
        }

        // Add a 5-second delay between campaigns to avoid overwhelming LinkedIn or the machine
        logger.info(`Waiting 5 seconds before checking the next campaign...`);
        await delay(5000);
      } catch (error) {
        logger.error(`Error checking cookies for campaign ${campaign.id}: ${error.message}`);
      }
    }

    logger.info('Completed scheduled cookie check.');
  } catch (error) {
    logger.error(`Error in scheduled cookie check: ${error.message}`);
  } finally {
    isChecking = false; // Release the lock
  }
};

// Schedule the task with a random interval
let scheduledTask = null;

const scheduleTask = () => {
  if (scheduledTask) {
    scheduledTask.stop(); // Stop the previous schedule if it exists
  }

  const intervalMinutes = getRandomInterval();
  const cronExpression = `0 */${intervalMinutes} * * * *`; // Run every X minutes
  logger.info(`Scheduling cookie check to run every ${intervalMinutes} minutes.`);

  scheduledTask = cron.schedule(cronExpression, async () => {
    await checkCookiesForActiveCampaigns();
  });
};

// Export the main function for manual triggering
module.exports = {
  checkCookiesForActiveCampaigns
};

// Start the scheduler
logger.info('Starting cookie check scheduler...');
scheduleTask();