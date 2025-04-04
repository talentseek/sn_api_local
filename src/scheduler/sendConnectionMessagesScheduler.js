require('dotenv').config();
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const createLogger = require('../utils/logger');
const { withTimeout } = require('../utils/databaseUtils');
const { bot } = require('../telegramBot');
const ResistanceHandler = require('../utils/resistanceHandler');
const { hasDelayPassed } = require('../utils/dateUtils');

const logger = createLogger();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize resistance handler
const resistanceHandler = new ResistanceHandler(supabase);

// Validate Telegram configuration
const TELEGRAM_NOTIFICATION_CHAT_ID = process.env.TELEGRAM_NOTIFICATION_CHAT_ID;
if (!TELEGRAM_NOTIFICATION_CHAT_ID) {
  logger.error('Missing Telegram configuration: TELEGRAM_NOTIFICATION_CHAT_ID must be set in .env');
  process.exit(1);
}

/**
 * Message stages configuration with fixed working day delays
 * TODO: Future enhancement - Make delays configurable:
 * - Per campaign basis
 * - Via environment variables
 * - Through database configuration
 * This would allow for more flexible messaging strategies per campaign/client
 */
const MESSAGE_STAGES = {
  FIRST_MESSAGE: {
    stage: 1,
    delay_days: 0,
    maxPerDay: 100, // High safety limit for 1st-degree connections
    description: 'first message'
  },
  SECOND_MESSAGE: {
    stage: 2,
    delay_days: 3, // 3 working days delay
    maxPerDay: 100, // High safety limit for 1st-degree connections
    description: 'second message'
  },
  THIRD_MESSAGE: {
    stage: 3,
    delay_days: 3, // 3 working days delay from second message
    maxPerDay: 100, // High safety limit for 1st-degree connections
    description: 'third message'
  }
};

const SCHEDULE_WINDOWS = {
  'Europe': [
    { start: 7, end: 8 },
    { start: 8, end: 9 },
    { start: 9, end: 10 },
    { start: 10, end: 11 },
    { start: 11, end: 12 },
    { start: 12, end: 13 }
  ],
  'North America': [
    { start: 13, end: 14 },
    { start: 14, end: 15 },
    { start: 15, end: 16 },
    { start: 16, end: 17 },
    { start: 17, end: 18 },
    { start: 18, end: 19 }
  ],
  'Asia': [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
    { start: 3, end: 4 },
    { start: 4, end: 5 },
    { start: 5, end: 6 },
    { start: 6, end: 7 }
  ]
};

// Utility function to add a delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Lock variable to prevent overlapping runs
let isProcessing = false;

// Function to check if campaign is in cooldown
const isInCooldown = async (campaignId) => {
  try {
    const { data, error } = await supabase
      .from('campaign_cooldowns')
      .select('cooldown_until')
      .eq('campaign_id', campaignId)
      .order('cooldown_until', { ascending: false })
      .limit(1);

    if (error) {
      logger.error(`Error checking cooldown: ${error.message}`);
      return false;
    }

    if (!data || data.length === 0) {
      return false;
    }

    return data[0].cooldown_until && new Date(data[0].cooldown_until) > new Date();
  } catch (error) {
    logger.error(`Failed to check cooldown: ${error.message}`);
    return false;
  }
};

// Function to set campaign cooldown
const setCampaignCooldown = async (campaignId) => {
  const cooldownUntil = new Date(Date.now() + (2 * 60 * 60 * 1000)); // 2 hour cooldown

  try {
    const { error } = await supabase
      .from('campaign_cooldowns')
      .upsert({
        campaign_id: campaignId,
        cooldown_until: cooldownUntil.toISOString(),
        updated_at: new Date().toISOString()
      });

    if (error) {
      logger.error(`Error setting cooldown: ${error.message}`);
    }
  } catch (error) {
    logger.error(`Failed to set cooldown: ${error.message}`);
  }
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
    const { count, error } = await supabase
      .from('campaign_activity_logs')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('activity_type', 'message_sent')
      .eq('details->>message_stage', stage)
      .gte('created_at', today);

    if (error) throw error;
    return count || 0;
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
        activity_type: 'message_sent',
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

// Function to validate message templates
async function validateMessageTemplates(campaign) {
  const { data: campaignData } = await supabase
    .from('campaigns')
    .select('connection_messages')
    .eq('id', campaign.id)
    .single();

  if (!campaignData?.connection_messages?.messages) {
    logger.warn(`Campaign ${campaign.id} has no message templates configured`);
    return false;
  }

  const messages = campaignData.connection_messages.messages;
  const requiredStages = [1, 2, 3];
  const configuredStages = messages.map(m => m.stage);

  // Check if all required stages are configured
  const missingStages = requiredStages.filter(stage => !configuredStages.includes(stage));
  if (missingStages.length > 0) {
    logger.warn(`Campaign ${campaign.id} is missing message templates for stages: ${missingStages.join(', ')}`);
    return false;
  }

  // Validate each message template
  for (const message of messages) {
    if (!message.content || typeof message.content !== 'string' || message.content.trim().length === 0) {
      logger.warn(`Campaign ${campaign.id} has invalid message template for stage ${message.stage}`);
      return false;
    }
  }

  return true;
}

// Function to process messages for a specific stage
async function processMessageStage(campaign, messageStage) {
  if (await isInCooldown(campaign.id)) {
    logger.info(`Campaign ${campaign.id} is in cooldown period, skipping...`);
    return;
  }

  // Validate message templates first
  if (!await validateMessageTemplates(campaign)) {
    logger.warn(`Skipping campaign ${campaign.id} due to invalid message templates`);
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
    // Get leads with their last_contacted dates, ordered by connection date
    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('id, message_stage, last_contacted, connected_at')
      .eq('campaign_id', campaign.id)
      .eq('connection_level', '1st')
      .eq('status', 'not_replied')
      .order('connected_at', { ascending: true })
      .limit(100);

    if (leadsError) {
      throw new Error(`Failed to fetch leads: ${leadsError.message}`);
    }

    // Filter eligible leads based on stage and delay
    const eligibleLeads = leads.filter(lead => {
      if (messageStage.stage === 1) {
        return lead.message_stage === null;
      } else {
        return (
          lead.message_stage === messageStage.stage - 1 &&
          hasDelayPassed(lead.last_contacted, messageStage.delay_days)
        );
      }
    });

    if (eligibleLeads.length === 0) {
      logger.info(`No eligible leads found for campaign ${campaign.id} stage ${messageStage.stage}`);
      return;
    }

    // Send message request
    const response = await fetch('http://localhost:8080/api/send-connection-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId: campaign.id,
        messageStage: messageStage.stage,
        batchSize: batchSize,
        delayDays: messageStage.delay_days,
        leadIds: eligibleLeads.slice(0, batchSize).map(l => l.id)
      })
    });

    const result = await response.json();

    if (!result.success) {
      if (result.error) {
        const resistanceResult = await resistanceHandler.handleResistance(campaign.id, result.error);
        if (resistanceResult) {
          logger.warn(`LinkedIn resistance detected (${resistanceResult.resistanceType}). Campaign ${campaign.id} in cooldown until ${resistanceResult.cooldownUntil}`);
        }
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

    return result.successfulMessages || 0;

  } catch (error) {
    logger.error(`Error sending ${messageStage.description} for campaign ${campaign.id}: ${error.message}`);
    
    await logActivity(campaign.id, messageStage.stage, 'failed', 
      { total: 0, successful: 0, failed: 0 }, 
      error.message
    );

    // Implement retry mechanism for non-resistance errors
    if (!error.message.toLowerCase().includes('resistance') && 
        !error.message.toLowerCase().includes('captcha')) {
      logger.info(`Scheduling retry for campaign ${campaign.id} in 5 minutes`);
      setTimeout(() => processMessageStage(campaign, messageStage), 5 * 60 * 1000);
    }

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

    // Process each campaign
    for (const campaign of campaigns) {
      if (!isWithinTimeWindow(campaign.timezone)) {
        logger.info(`Skipping campaign ${campaign.id} - outside of time window for ${campaign.timezone}`);
        continue;
      }

      logger.info(`Processing messages for campaign ${campaign.id}`);

      // Get leads with their last_contacted dates to determine which stages to process
      const { data: leadStats, error: statsError } = await withTimeout(
        supabase
          .from('leads')
          .select('message_stage, last_contacted')
          .eq('client_id', campaign.client_id)
          .eq('status', 'not_replied')
          .eq('connection_level', '1st'),
        10000,
        'Timeout while fetching lead statistics'
      );

      if (statsError) {
        logger.error(`Error fetching lead statistics for campaign ${campaign.id}: ${statsError.message}`);
        continue;
      }

      // Determine which stages have eligible leads
      const eligibleStages = new Set();
      
      // Stage 1 is always eligible if there are leads with no messages
      if (leadStats.some(lead => lead.message_stage === null)) {
        eligibleStages.add(1);
      }

      // Check other stages
      for (const lead of leadStats) {
        if (!lead.message_stage || !lead.last_contacted) continue;
        
        const nextStage = lead.message_stage + 1;
        if (nextStage > 3) continue; // We only have 3 stages
        
        const stageConfig = Object.values(MESSAGE_STAGES).find(s => s.stage === nextStage);
        if (!stageConfig) continue;
        
        if (hasDelayPassed(lead.last_contacted, stageConfig.delay_days)) {
          eligibleStages.add(nextStage);
        }
      }

      // Process only the eligible stages
      for (const stage of Object.values(MESSAGE_STAGES)) {
        if (eligibleStages.has(stage.stage)) {
          logger.info(`Processing stage ${stage.stage} for campaign ${campaign.id} - eligible leads found`);
          await processMessageStage(campaign, stage);
          await delay(5000); // 5 second delay between stages
        } else {
          logger.info(`Skipping stage ${stage.stage} for campaign ${campaign.id} - no eligible leads`);
        }
      }
      
      await delay(5000); // 5 second delay between campaigns
    }

  } catch (error) {
    logger.error(`Error in messaging scheduler: ${error.message}`);
    // Only notify on critical scheduler-level errors
    await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, 
      `⚠️ Critical error in messaging scheduler: ${error.message}\nScheduler may need attention.`);
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