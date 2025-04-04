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

// Connection request configuration
const CONNECTION_CONFIG = {
  requestsPerDay: 20,
  batchSize: 5,
  minBatchesPerWindow: 4, // Spread 20 requests across at least 4 batches
  delayBetweenBatches: 5000,
  delayBetweenProfiles: 5000,
  maxRetriesPerProfile: 3
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
  if (!connectionsToAdd || typeof connectionsToAdd !== 'number') {
    logger.warn(`Invalid connectionsToAdd value for campaign ${campaignId}: ${connectionsToAdd}`);
    connectionsToAdd = 0;
  }

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
      // Update existing record, ensure we're not adding to null
      const currentCount = existing.connections_sent || 0;
      const { error: updateError } = await supabase
        .from('daily_connection_tracking')
        .update({ connections_sent: currentCount + connectionsToAdd })
        .eq('campaign_id', campaignId)
        .eq('date', today);

      if (updateError) throw updateError;
    } else {
      // Insert new record, initialize with connectionsToAdd
      const { error: insertError } = await supabase
        .from('daily_connection_tracking')
        .insert({
          campaign_id: campaignId,
          date: today,
          connections_sent: connectionsToAdd,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (insertError) throw insertError;
    }

    // Verify the update/insert was successful
    const { data: verification, error: verifyError } = await supabase
      .from('daily_connection_tracking')
      .select('connections_sent')
      .eq('campaign_id', campaignId)
      .eq('date', today)
      .single();

    if (verifyError) {
      throw verifyError;
    }

    if (verification.connections_sent === null) {
      logger.error(`Connections sent is still null for campaign ${campaignId} after update`);
      // Fix the null value
      await supabase
        .from('daily_connection_tracking')
        .update({ connections_sent: connectionsToAdd })
        .eq('campaign_id', campaignId)
        .eq('date', today);
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

// Function to calculate optimal batch size
function calculateOptimalBatchSize(remainingLimit, timeWindow, currentHour) {
  // Calculate time position in window
  let hoursRemaining;
  if (currentHour >= timeWindow.start && currentHour < timeWindow.end) {
    hoursRemaining = timeWindow.end - currentHour;
  } else if (currentHour < timeWindow.start) {
    hoursRemaining = timeWindow.end - timeWindow.start;
  } else {
    return 0; // Outside window
  }

  // Calculate runs remaining in the window (2 runs per hour)
  const runsRemaining = Math.max(1, hoursRemaining * 2);
  
  // Calculate ideal batch size
  const idealBatchSize = Math.ceil(remainingLimit / runsRemaining);
  
  // Return the smaller of ideal batch size, configured batch size, and remaining limit
  return Math.min(
    idealBatchSize,
    CONNECTION_CONFIG.batchSize,
    remainingLimit
  );
}

// Function to process connection requests for a campaign
async function processConnectionRequests(campaign) {
  const startTime = new Date().toISOString();
  const logger = createLogger();
  
  try {
    // Check if campaign is in cooldown
    const { data: cooldown } = await supabase
      .from('campaign_cooldowns')
      .select('cooldown_until')
      .eq('campaign_id', campaign.id)
      .single();

    if (cooldown && new Date(cooldown.cooldown_until) > new Date()) {
      logger.info(`Campaign ${campaign.id} is in cooldown until ${cooldown.cooldown_until}`);
      return;
    }

    // Get daily tracking record
    const { data: tracking } = await supabase
      .from('daily_connection_tracking')
      .select('connections_sent')
      .eq('campaign_id', campaign.id)
      .eq('date', new Date().toISOString().split('T')[0])
      .single();

    const sentToday = tracking?.connections_sent || 0;
    const remainingLimit = Math.max(0, CONNECTION_CONFIG.requestsPerDay - sentToday);

    if (remainingLimit <= 0) {
      logger.info(`Daily limit reached for campaign ${campaign.id} (sent: ${sentToday})`);
      return;
    }

    // Calculate optimal batch size
    const timeWindow = TIME_WINDOWS[campaign.timezone];
    const currentHour = new Date().getHours();
    const optimalBatchSize = calculateOptimalBatchSize(remainingLimit, timeWindow, currentHour);

    if (optimalBatchSize === 0) {
      logger.info(`No connections to send for campaign ${campaign.id} at this time`);
      return;
    }

    logger.info(`Processing campaign ${campaign.id} with batch size ${optimalBatchSize} (${remainingLimit} remaining)`);

    // Send connection requests
    const response = await fetch('http://localhost:8080/api/send-connection-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId: campaign.id,
        maxProfiles: optimalBatchSize,
        batchSize: CONNECTION_CONFIG.batchSize,
        delayBetweenBatches: CONNECTION_CONFIG.delayBetweenBatches,
        delayBetweenProfiles: CONNECTION_CONFIG.delayBetweenProfiles,
        maxRetries: CONNECTION_CONFIG.maxRetriesPerProfile
      })
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || 'Failed to send connection requests');
    }

    // Update tracking and campaign status
    await Promise.all([
      // Update daily tracking
      updateDailyConnectionCount(campaign.id, result.sentCount),
      
      // Update campaign status - First get current total
      (async () => {
        const { data: currentCampaign } = await supabase
          .from('campaigns')
          .select('total_connections_sent')
          .eq('id', campaign.id)
          .single();
        
        const newTotal = (currentCampaign?.total_connections_sent || 0) + result.sentCount;
        
        await supabase
          .from('campaigns')
          .update({
            last_connection_request_at: new Date().toISOString(),
            total_connections_sent: newTotal
          })
          .eq('id', campaign.id);
      })(),
      
      // Log activity
      logActivity(campaign.id, 'connection_request', 'success', {
        total: result.totalProcessed,
        successful: result.sentCount,
        failed: result.failedCount
      }, null, {
        batchMetrics: {
          optimalBatchSize,
          remainingLimit,
          sentToday
        }
      })
    ]);

    logger.success(`Successfully processed ${result.sentCount} connection requests for campaign ${campaign.id}`);

  } catch (error) {
    logger.error(`Error processing campaign ${campaign.id}: ${error.message}`);
    
    // Log failure activity
    await logActivity(campaign.id, 'connection_request', 'failed', {
      total: 0,
      successful: 0,
      failed: 0
    }, error.message);
    
    throw error;
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
      // Additional validation
      if (!campaign.timezone || !TIME_WINDOWS[campaign.timezone]) {
        logger.warn(`Campaign ${campaign.id} has invalid timezone: ${campaign.timezone}`);
        continue;
      }

      if (!isWithinTimeWindow(campaign.timezone)) {
        logger.info(`Skipping campaign ${campaign.id} - outside of time window for ${campaign.timezone}`);
        continue;
      }

      // Check if campaign has required configuration
      if (!campaign.connection_request_config) {
        logger.warn(`Campaign ${campaign.id} missing connection request configuration`);
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

// Schedule the task to run every 30 minutes
logger.info('Starting connection request scheduler...');
cron.schedule('*/30 * * * *', checkAndProcessCampaigns);

// Export for testing
module.exports = {
  checkAndProcessCampaigns,
  processConnectionRequests,
  getRemainingDailyLimit,
  updateDailyConnectionCount,
  // Export constants for testing
  CONNECTION_CONFIG,
  TIME_WINDOWS
}; 