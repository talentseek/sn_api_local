require('dotenv').config();
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const createLogger = require('../utils/logger');
const { withTimeout } = require('../utils/databaseUtils');
const { bot } = require('../telegramBot');
const { logActivity } = require('../utils/activityLogger');

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

// Time windows for different regions (in UK time)
const TIME_WINDOWS = {
  'Europe': { start: 7, end: 13 },
  'North America': { start: 13, end: 19 },
  'Asia': { start: 0, end: 6 }
};

// Utility function to add a delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Lock variable to prevent overlapping runs
let isProcessing = false;

// Function to get random time within a window
const getRandomTimeInWindow = (startHour, endHour) => {
  const randomHour = Math.floor(Math.random() * (endHour - startHour)) + startHour;
  const randomMinute = Math.floor(Math.random() * 60);
  return { hour: randomHour, minute: randomMinute };
};

// Function to check if current time is within window
const isWithinTimeWindow = (timezone) => {
  const now = new Date();
  const currentHour = now.getHours();
  const window = TIME_WINDOWS[timezone];
  return currentHour >= window.start && currentHour < window.end;
};

// Function to update daily connection count
async function updateDailyConnectionCount(campaignId, connectionsToAdd) {
  const today = new Date().toISOString().split('T')[0];
  
  try {
    // First try to update existing record
    const { data: existing, error: selectError } = await supabase
      .from('daily_connection_tracking')
      .select('connections_sent')
      .eq('campaign_id', campaignId)
      .eq('date', today)
      .single();

    if (selectError && selectError.code !== 'PGRST116') { // PGRST116 is "not found"
      throw selectError;
    }

    if (existing) {
      // Update existing record
      const { error: updateError } = await supabase
        .from('daily_connection_tracking')
        .update({ connections_sent: existing.connections_sent + connectionsToAdd })
        .eq('campaign_id', campaignId)
        .eq('date', today);

      if (updateError) throw updateError;
    } else {
      // Insert new record
      const { error: insertError } = await supabase
        .from('daily_connection_tracking')
        .insert({
          campaign_id: campaignId,
          date: today,
          connections_sent: connectionsToAdd
        });

      if (insertError) throw insertError;
    }
  } catch (error) {
    logger.error(`Failed to update daily connection count for campaign ${campaignId}: ${error.message}`);
    throw error;
  }
}

// Function to check remaining daily limit
async function getRemainingDailyLimit(campaignId, dailyLimit) {
  const today = new Date().toISOString().split('T')[0];
  
  try {
    const { data, error } = await supabase
      .from('daily_connection_tracking')
      .select('connections_sent')
      .eq('campaign_id', campaignId)
      .eq('date', today)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
      throw error;
    }

    const sentToday = data?.connections_sent || 0;
    return Math.max(0, dailyLimit - sentToday);
  } catch (error) {
    logger.error(`Failed to get remaining daily limit for campaign ${campaignId}: ${error.message}`);
    throw error;
  }
}

// Main function to process connection requests for a campaign
async function processConnectionRequests(campaign) {
  const startTime = new Date().toISOString();
  
  // Log start of activity
  await logActivity(supabase, campaign.id, 'connection_request', 'running', 
    { total: 0, successful: 0, failed: 0 }, 
    null,
    { startTime }
  );
  
  try {
    // Check remaining daily limit
    const remainingLimit = await getRemainingDailyLimit(campaign.id, campaign.daily_connection_limit);
    if (remainingLimit <= 0) {
      logger.info(`Daily limit reached for campaign ${campaign.id}`);
      await logActivity(supabase, campaign.id, 'connection_request', 'success', 
        { total: 0, successful: 0, failed: 0 }, 
        null, 
        { 
          message: 'Daily limit reached',
          startTime
        }
      );
      return;
    }

    // Adjust maxProfiles based on remaining limit
    const config = campaign.connection_request_config;
    const maxProfiles = Math.min(remainingLimit, 20); // Never send more than 20 at once

    // Send connection requests
    const response = await fetch('http://localhost:8080/api/send-connection-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId: campaign.id,
        maxProfiles,
        batchSize: config.batchSize,
        delayBetweenBatches: config.delayBetweenBatches,
        delayBetweenProfiles: config.delayBetweenProfiles,
        sendMessage: config.sendMessage
      })
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || 'Failed to send connection requests');
    }

    // Update daily count and last request time
    await updateDailyConnectionCount(campaign.id, result.sentCount);
    await supabase
      .from('campaigns')
      .update({ last_connection_request_at: new Date().toISOString() })
      .eq('id', campaign.id);

    // Log success
    await logActivity(supabase, campaign.id, 'connection_request', 'success', {
      total: result.totalProcessed,
      successful: result.sentCount,
      failed: result.failedRequests
    }, null, {
      startTime,
      remainingLimit: remainingLimit - result.sentCount,
      config: campaign.connection_request_config
    });

  } catch (error) {
    logger.error(`Error processing connection requests for campaign ${campaign.id}: ${error.message}`);
    
    await logActivity(supabase, campaign.id, 'connection_request', 'failed', 
      { total: 0, successful: 0, failed: 0 }, 
      error.message,
      { startTime }
    );
  }
}

// Main scheduler function
async function checkAndProcessCampaigns() {
  if (isProcessing) {
    logger.warn('Another connection request process is already running. Skipping this run.');
    return;
  }

  isProcessing = true;
  try {
    // Get all active campaigns with automation enabled
    const { data: campaigns, error } = await withTimeout(
      supabase
        .from('campaigns')
        .select('*')
        .eq('status', 'active')
        .eq('automation_enabled', true),
      10000,
      'Timeout while fetching active campaigns'
    );

    if (error) {
      throw error;
    }

    if (!campaigns || campaigns.length === 0) {
      logger.info('No active campaigns found with automation enabled');
      return;
    }

    // Process each campaign that's within its time window
    for (const campaign of campaigns) {
      if (!isWithinTimeWindow(campaign.timezone)) {
        logger.info(`Skipping campaign ${campaign.id} - outside of time window for ${campaign.timezone}`);
        continue;
      }

      logger.info(`Processing connection requests for campaign ${campaign.id}`);
      await processConnectionRequests(campaign);
      
      // Add delay between campaigns
      await delay(5000);
    }

  } catch (error) {
    logger.error(`Error in connection request scheduler: ${error.message}`);
    // Only notify on critical scheduler-level errors
    await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, 
      `⚠️ Critical error in connection request scheduler: ${error.message}\nScheduler may need attention.`);
  } finally {
    isProcessing = false;
  }
}

// Schedule the task to run every hour
logger.info('Starting connection request scheduler...');
cron.schedule('0 * * * *', async () => {
  await checkAndProcessCampaigns();
});

// Export for testing
module.exports = {
  checkAndProcessCampaigns,
  processConnectionRequests,
  getRemainingDailyLimit,
  updateDailyConnectionCount
}; 