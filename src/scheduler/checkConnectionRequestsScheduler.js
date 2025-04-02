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

// Configuration constants
const CHECK_SCHEDULE = {
  runHours: [6, 9, 12, 15, 18, 21], // Every 3 hours during active hours
  maxProfilesPerRun: 20,
  batchSize: 5,
  delayBetweenBatches: 5000,
  minTimeBetweenChecks: 4 * 60 * 60 * 1000, // 4 hours in milliseconds
  maxCheckAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
  cooldownPeriod: 2 * 60 * 60 * 1000 // 2 hours cooldown if we detect issues
};

// Utility function to add a delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Lock variable to prevent overlapping runs
let isProcessing = false;

// Campaign cooldown tracking
const campaignCooldowns = new Map();

// Function to check if campaign is in cooldown
const isInCooldown = (campaignId) => {
  const cooldownUntil = campaignCooldowns.get(campaignId);
  return cooldownUntil && cooldownUntil > Date.now();
};

// Function to set campaign cooldown
const setCampaignCooldown = (campaignId) => {
  campaignCooldowns.set(campaignId, Date.now() + CHECK_SCHEDULE.cooldownPeriod);
};

// Function to log activity
async function logActivity(campaignId, status, counts = {}, error = null, details = {}) {
  try {
    const { data, error: logError } = await supabase
      .from('campaign_activity_logs')
      .insert({
        campaign_id: campaignId,
        activity_type: 'connection_check',
        status: status,
        total_processed: counts.total || 0,
        successful_count: counts.successful || 0,
        failed_count: counts.failed || 0,
        error_message: error,
        details: details,
        completed_at: status !== 'running' ? new Date().toISOString() : null
      });

    if (logError) {
      logger.error(`Error logging activity: ${logError.message}`);
    }
  } catch (err) {
    logger.error(`Failed to log activity: ${err.message}`);
  }
}

// Function to process connection checks for a campaign
async function processConnectionChecks(campaign) {
  if (isInCooldown(campaign.id)) {
    logger.info(`Campaign ${campaign.id} is in cooldown period, skipping...`);
    return;
  }

  const activityLogId = await logActivity(campaign.id, 'running');
  
  try {
    // Get profiles that need checking
    const fourHoursAgo = new Date(Date.now() - CHECK_SCHEDULE.minTimeBetweenChecks).toISOString();
    const sevenDaysAgo = new Date(Date.now() - CHECK_SCHEDULE.maxCheckAge).toISOString();
    
    const { data: profiles, error: fetchError } = await withTimeout(
      supabase
        .from('scraped_profiles')
        .select('*')
        .eq('campaign_id', campaign.id.toString())
        .eq('connection_status', 'pending')
        .or(`last_checked.is.null,last_checked.lt.${fourHoursAgo}`)
        .gt('connection_requested_at', sevenDaysAgo)
        .order('last_checked', { nullsFirst: true })
        .limit(CHECK_SCHEDULE.maxProfilesPerRun),
      10000,
      'Timeout while fetching profiles'
    );

    if (fetchError) {
      throw new Error(`Failed to fetch profiles: ${fetchError.message}`);
    }

    if (!profiles || profiles.length === 0) {
      logger.info(`No profiles to check for campaign ${campaign.id}`);
      await logActivity(campaign.id, 'success', 
        { total: 0 }, 
        null, 
        { message: 'No profiles to check' }
      );
      return;
    }

    logger.info(`Found ${profiles.length} profiles to check for campaign ${campaign.id}`);

    // Send check request
    const response = await fetch('http://localhost:8080/api/check-connection-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId: campaign.id,
        maxProfiles: profiles.length,
        batchSize: CHECK_SCHEDULE.batchSize
      })
    });

    const result = await response.json();

    if (!result.success) {
      // If we detect LinkedIn resistance, set cooldown
      if (result.error?.includes('LinkedIn')) {
        setCampaignCooldown(campaign.id);
      }
      throw new Error(result.error || 'Failed to check connection requests');
    }

    // Log success
    await logActivity(campaign.id, 'success', {
      total: result.totalProcessed || 0,
      successful: result.successfulChecks || 0,
      failed: result.failedChecks || 0
    }, null, {
      accepted: result.acceptedConnections || 0,
      pending: result.stillPending || 0,
      notFound: result.notFound || 0
    });

    // Send Telegram notification
    const message = `✅ Connection checks completed for campaign ${campaign.id} (${campaign.name})\n` +
                   `📊 Results:\n` +
                   `- Total checked: ${result.totalProcessed || 0}\n` +
                   `- Accepted: ${result.acceptedConnections || 0}\n` +
                   `- Still pending: ${result.stillPending || 0}\n` +
                   `- Not found: ${result.notFound || 0}`;
    
    await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, message);

  } catch (error) {
    logger.error(`Error checking connections for campaign ${campaign.id}: ${error.message}`);
    
    await logActivity(campaign.id, 'failed', 
      { total: 0, successful: 0, failed: 0 }, 
      error.message
    );

    // Send error notification
    const errorMessage = `⚠️ Failed to check connections for campaign ${campaign.id} (${campaign.name})\n` +
                        `Error: ${error.message}`;
    await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, errorMessage);
  }
}

// Main scheduler function
async function checkAndProcessCampaigns() {
  if (isProcessing) {
    logger.warn('Another connection check process is already running. Skipping this run.');
    return;
  }

  const currentHour = new Date().getHours();
  if (!CHECK_SCHEDULE.runHours.includes(currentHour)) {
    logger.info(`Current hour (${currentHour}) is not in schedule, skipping...`);
    return;
  }

  isProcessing = true;
  try {
    // Get all active campaigns
    const { data: campaigns, error } = await withTimeout(
      supabase
        .from('campaigns')
        .select('*')
        .eq('status', 'active'),
      10000,
      'Timeout while fetching active campaigns'
    );

    if (error) {
      throw error;
    }

    if (!campaigns || campaigns.length === 0) {
      logger.info('No active campaigns found');
      return;
    }

    // Process each campaign
    for (const campaign of campaigns) {
      logger.info(`Processing connection checks for campaign ${campaign.id}`);
      await processConnectionChecks(campaign);
      
      // Add delay between campaigns
      await delay(5000);
    }

  } catch (error) {
    logger.error(`Error in connection check scheduler: ${error.message}`);
    await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, 
      `⚠️ Error in connection check scheduler: ${error.message}`);
  } finally {
    isProcessing = false;
  }
}

// Schedule the task to run every hour
logger.info('Starting connection check scheduler...');
cron.schedule('0 * * * *', async () => {
  await checkAndProcessCampaigns();
});

// Export for testing
module.exports = {
  checkAndProcessCampaigns,
  processConnectionChecks,
  CHECK_SCHEDULE
}; 