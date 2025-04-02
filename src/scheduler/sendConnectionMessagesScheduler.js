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
const MESSAGE_STAGES = {
  FIRST_MESSAGE: {
    stage: 1,
    delay: 0,
    maxPerDay: 20,
    description: 'first message'
  },
  SECOND_MESSAGE: {
    stage: 2,
    delay: 3 * 24 * 60 * 60 * 1000, // 3 days
    maxPerDay: 15,
    description: 'second message'
  },
  THIRD_MESSAGE: {
    stage: 3,
    delay: 4 * 24 * 60 * 60 * 1000, // 4 days
    maxPerDay: 10,
    description: 'third message'
  }
};

const SCHEDULE_WINDOWS = {
  'Europe': [
    { start: 7, end: 8 },
    { start: 8, end: 9 },
    { start: 9, end: 10 }
  ],
  'North America': [
    { start: 13, end: 14 },
    { start: 14, end: 15 },
    { start: 15, end: 16 }
  ],
  'Asia': [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
    { start: 3, end: 4 }
  ]
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
  campaignCooldowns.set(campaignId, Date.now() + (2 * 60 * 60 * 1000)); // 2 hour cooldown
};

// Function to check if current time is within window
const isWithinTimeWindow = (timezone) => {
  const now = new Date();
  const currentHour = now.getHours();
  return SCHEDULE_WINDOWS[timezone].some(window => 
    currentHour >= window.start && currentHour < window.end
  );
};

// Function to get daily message count
async function getDailyMessageCount(campaignId, stage) {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data, error } = await supabase
      .from('campaign_activity_logs')
      .select('successful_count')
      .eq('campaign_id', campaignId)
      .eq('activity_type', 'message_send')
      .eq('details->message_stage', stage)
      .gte('created_at', today)
      .sum('successful_count');

    if (error) throw error;
    return data?.[0]?.sum || 0;
  } catch (error) {
    logger.error(`Error getting daily message count: ${error.message}`);
    return 0;
  }
}

// Function to log activity
async function logActivity(campaignId, stage, status, counts = {}, error = null, details = {}) {
  try {
    const { data, error: logError } = await supabase
      .from('campaign_activity_logs')
      .insert({
        campaign_id: campaignId,
        activity_type: 'message_send',
        status: status,
        total_processed: counts.total || 0,
        successful_count: counts.successful || 0,
        failed_count: counts.failed || 0,
        error_message: error,
        details: {
          ...details,
          message_stage: stage
        },
        completed_at: status !== 'running' ? new Date().toISOString() : null
      });

    if (logError) {
      logger.error(`Error logging activity: ${logError.message}`);
    }
  } catch (err) {
    logger.error(`Failed to log activity: ${err.message}`);
  }
}

// Function to process messages for a specific stage
async function processMessageStage(campaign, messageStage) {
  if (isInCooldown(campaign.id)) {
    logger.info(`Campaign ${campaign.id} is in cooldown period, skipping...`);
    return;
  }

  // Check daily limit
  const dailyCount = await getDailyMessageCount(campaign.id, messageStage.stage);
  if (dailyCount >= messageStage.maxPerDay) {
    logger.info(`Daily limit reached for campaign ${campaign.id} stage ${messageStage.stage}`);
    return;
  }

  const remainingDaily = messageStage.maxPerDay - dailyCount;
  const batchSize = Math.min(5, remainingDaily); // Process up to 5 at a time

  const activityLogId = await logActivity(campaign.id, messageStage.stage, 'running');
  
  try {
    // Send message request
    const response = await fetch('http://localhost:8080/api/send-connection-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId: campaign.id,
        messageStage: messageStage.stage,
        batchSize: batchSize
      })
    });

    const result = await response.json();

    if (!result.success) {
      // If we detect LinkedIn resistance, set cooldown
      if (result.error?.includes('LinkedIn')) {
        setCampaignCooldown(campaign.id);
      }
      throw new Error(result.error || 'Failed to send messages');
    }

    // Log success
    await logActivity(campaign.id, messageStage.stage, 'success', {
      total: result.totalProcessed || 0,
      successful: result.successfulMessages || 0,
      failed: result.failedMessages || 0
    }, null, {
      remainingDaily: remainingDaily - (result.successfulMessages || 0),
      skippedResponded: result.skippedResponded || 0
    });

    // Send Telegram notification
    const message = `✅ Sent ${messageStage.description} for campaign ${campaign.id} (${campaign.name})\n` +
                   `📊 Results:\n` +
                   `- Messages sent: ${result.successfulMessages || 0}\n` +
                   `- Failed: ${result.failedMessages || 0}\n` +
                   `- Skipped (responded): ${result.skippedResponded || 0}\n` +
                   `- Remaining daily limit: ${remainingDaily - (result.successfulMessages || 0)}`;
    
    await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, message);

    return result.successfulMessages || 0;

  } catch (error) {
    logger.error(`Error sending ${messageStage.description} for campaign ${campaign.id}: ${error.message}`);
    
    await logActivity(campaign.id, messageStage.stage, 'failed', 
      { total: 0, successful: 0, failed: 0 }, 
      error.message
    );

    // Send error notification
    const errorMessage = `⚠️ Failed to send ${messageStage.description} for campaign ${campaign.id} (${campaign.name})\n` +
                        `Error: ${error.message}`;
    await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, errorMessage);

    return 0;
  }
}

// Main scheduler function
async function processMessaging() {
  if (isProcessing) {
    logger.warn('Another messaging process is already running. Skipping this run.');
    return;
  }

  isProcessing = true;
  try {
    // Get all active campaigns
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
      logger.info('No active campaigns found');
      return;
    }

    // Process each campaign
    for (const campaign of campaigns) {
      if (!isWithinTimeWindow(campaign.timezone)) {
        logger.info(`Skipping campaign ${campaign.id} - outside of time window for ${campaign.timezone}`);
        continue;
      }

      logger.info(`Processing messages for campaign ${campaign.id}`);

      // Process each message stage
      for (const stage of Object.values(MESSAGE_STAGES)) {
        await processMessageStage(campaign, stage);
        // Add delay between stages
        await delay(5000);
      }
      
      // Add delay between campaigns
      await delay(5000);
    }

  } catch (error) {
    logger.error(`Error in messaging scheduler: ${error.message}`);
    await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, 
      `⚠️ Error in messaging scheduler: ${error.message}`);
  } finally {
    isProcessing = false;
  }
}

// Schedule the task to run every hour
logger.info('Starting connection messaging scheduler...');
cron.schedule('0 * * * *', async () => {
  await processMessaging();
});

// Export for testing
module.exports = {
  processMessaging,
  processMessageStage,
  MESSAGE_STAGES,
  SCHEDULE_WINDOWS
}; 