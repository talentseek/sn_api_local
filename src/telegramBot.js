require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const createLogger = require('./utils/logger');
const { withTimeout } = require('./utils/databaseUtils');
const jobQueueManager = require('./utils/jobQueueManager');

const logger = createLogger();

// Initialize Telegram Bot
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_NOTIFICATION_CHAT_ID = process.env.TELEGRAM_NOTIFICATION_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !TELEGRAM_NOTIFICATION_CHAT_ID) {
  logger.error('Missing Telegram configuration: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and TELEGRAM_NOTIFICATION_CHAT_ID must be set in .env');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Factory function to initialize the bot with Supabase dependency
const initializeBot = (supabase) => {
  // Log all incoming messages for debugging
  bot.on('message', (msg) => {
    const chatId = msg.chat.id.toString();
    const fromId = msg.from?.id || 'unknown';
    const fromUsername = msg.from?.username || 'unknown';
    logger.info(`Received message from chat ID ${chatId}, from user ID ${fromId} (${fromUsername}): ${msg.text}`);
  });

  // Log the Supabase instance to confirm it's passed correctly
  logger.info(`Supabase instance in initializeBot: ${supabase ? 'defined' : 'undefined'}`);
  if (!supabase || typeof supabase.from !== 'function') {
    logger.error('Supabase client is not properly initialized in telegramBot.js');
    return;
  }

  // Get the bot's username dynamically to handle commands in groups
  bot.getMe().then((botInfo) => {
    const botUsername = botInfo.username;
    logger.info(`Bot username: @${botUsername}`);

    // Create regex patterns for each command
    const campaignStatsOpenRegex = new RegExp(`^/campaignstatsopen(?:@${botUsername})?$`);
    const campaignStatsConnectionsRegex = new RegExp(`^/campaignstatsconnections(?:@${botUsername})?$`);

    // Handler for open profile stats
    bot.onText(campaignStatsOpenRegex, async (msg) => {
      const chatId = msg.chat.id.toString();
      
      // Check against both chat IDs
      if (chatId !== process.env.TELEGRAM_NOTIFICATION_CHAT_ID && chatId !== process.env.TELEGRAM_CHAT_ID) {
        logger.warn(`Unauthorized chat ID ${chatId} attempted to use /campaignstatsopen`);
        bot.sendMessage(chatId, '⚠️ Unauthorized chat');
        return;
      }

      try {
        // Fetch active campaigns
        const { data: campaigns, error } = await withTimeout(
          supabase
            .from('campaigns')
            .select('id, name, client_id')
            .eq('status', 'active')
            .order('name'),
          10000,
          'Timeout while fetching campaigns'
        );

        if (error) throw new Error(JSON.stringify(error, null, 2));
        if (!campaigns || campaigns.length === 0) {
          bot.sendMessage(chatId, '❌ No active campaigns found');
          return;
        }

        let activeCampaigns = [];
        let inactiveCampaigns = [];

        for (const campaign of campaigns) {
          let campaignInfo = `${campaign.name} (ID: ${campaign.id})`;
          
          // Count leads available to message
          let leadsCount = 0;
          try {
            const { count, error: leadsError } = await withTimeout(
              supabase
                .from('leads')
                .select('id', { count: 'exact', head: true })
                .eq('client_id', campaign.client_id)
                .eq('message_sent', false)
                .eq('is_open_profile', true)
                .eq('status', 'not_replied'),
              5000,
              `Timeout while counting leads for campaign ${campaign.id}`
            );
            if (leadsError) throw new Error(JSON.stringify(leadsError, null, 2));
            leadsCount = count || 0;
          } catch (error) {
            logger.error(`Failed to count leads for campaign ${campaign.id}: ${error.message}`);
            campaignInfo += ' ❌ Error fetching leads';
            inactiveCampaigns.push(campaignInfo);
            continue;
          }

          // Count premium profiles
          let premiumCount = 0;
          try {
            const { count, error: premiumError } = await withTimeout(
              supabase
                .from('premium_profiles')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', campaign.id.toString())
                .eq('is_checked', false)
                .eq('moved_to_leads', false),
              5000,
              `Timeout while counting premium profiles`
            );
            if (premiumError) throw new Error(JSON.stringify(premiumError, null, 2));
            premiumCount = count || 0;
          } catch (error) {
            logger.error(`Failed to count premium profiles: ${error.message}`);
            campaignInfo += ' ❌ Error fetching premium profiles';
            inactiveCampaigns.push(campaignInfo);
            continue;
          }

          // Count leads awaiting 2nd follow-up
          let awaitingSecondFollowupCount = 0;
          try {
            const { count, error: secondFollowupError } = await withTimeout(
              supabase
                .from('leads')
                .select('id', { count: 'exact', head: true })
                .eq('client_id', campaign.client_id)
                .eq('message_sent', true)
                .eq('is_open_profile', true)
                .eq('message_stage', 2),
              5000,
              `Timeout while counting leads awaiting 2nd follow-up`
            );
            if (secondFollowupError) throw new Error(JSON.stringify(secondFollowupError, null, 2));
            awaitingSecondFollowupCount = count || 0;
          } catch (error) {
            logger.error(`Failed to count leads awaiting 2nd follow-up: ${error.message}`);
          }

          // Count leads awaiting 3rd follow-up
          let awaitingThirdFollowupCount = 0;
          try {
            const { count, error: thirdFollowupError } = await withTimeout(
              supabase
                .from('leads')
                .select('id', { count: 'exact', head: true })
                .eq('client_id', campaign.client_id)
                .eq('message_sent', true)
                .eq('is_open_profile', true)
                .eq('message_stage', 3),
              5000,
              `Timeout while counting leads awaiting 3rd follow-up`
            );
            if (thirdFollowupError) throw new Error(JSON.stringify(thirdFollowupError, null, 2));
            awaitingThirdFollowupCount = count || 0;
          } catch (error) {
            logger.error(`Failed to count leads awaiting 3rd follow-up: ${error.message}`);
          }

          // Add stats to campaign info
          campaignInfo += `\n   📨 ${leadsCount} leads available to message`;
          if (premiumCount > 0) {
            campaignInfo += `\n   🔍 ${premiumCount} premium profiles to check`;
          }
          if (awaitingSecondFollowupCount > 0) {
            campaignInfo += `\n   📬 ${awaitingSecondFollowupCount} leads awaiting 2nd follow-up`;
          }
          if (awaitingThirdFollowupCount > 0) {
            campaignInfo += `\n   📭 ${awaitingThirdFollowupCount} leads awaiting 3rd follow-up`;
          }

          if (leadsCount > 0 || premiumCount > 0 || awaitingSecondFollowupCount > 0 || awaitingThirdFollowupCount > 0) {
            activeCampaigns.push(campaignInfo);
          } else {
            inactiveCampaigns.push(campaignInfo);
          }
        }

        // Send the report
        let message = '📊 *Open Profile Campaign Stats*\n\n';
        
        if (activeCampaigns.length > 0) {
          message += '*Active Campaigns:*\n' + activeCampaigns.join('\n\n');
        }
        
        if (inactiveCampaigns.length > 0) {
          if (activeCampaigns.length > 0) message += '\n\n';
          message += '*Inactive Campaigns:*\n' + inactiveCampaigns.join('\n\n');
        }

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Error in campaignstatsopen command:', error);
        bot.sendMessage(chatId, `❌ Error fetching campaign stats: ${error.message}`);
      }
    });

    // Handler for connection stats
    bot.onText(campaignStatsConnectionsRegex, async (msg) => {
      const chatId = msg.chat.id.toString();
      
      // Check against both chat IDs
      if (chatId !== process.env.TELEGRAM_NOTIFICATION_CHAT_ID && chatId !== process.env.TELEGRAM_CHAT_ID) {
        logger.warn(`Unauthorized chat ID ${chatId} attempted to use /campaignstatsconnections`);
        bot.sendMessage(chatId, '⚠️ Unauthorized chat');
        return;
      }

      try {
        // Fetch active campaigns
        const { data: campaigns, error } = await withTimeout(
          supabase
            .from('campaigns')
            .select('id, name, client_id')
            .eq('status', 'active')
            .order('name'),
          10000,
          'Timeout while fetching campaigns'
        );

        if (error) throw new Error(JSON.stringify(error, null, 2));
        if (!campaigns || campaigns.length === 0) {
          bot.sendMessage(chatId, '❌ No active campaigns found');
          return;
        }

        let activeCampaigns = [];
        let inactiveCampaigns = [];

        for (const campaign of campaigns) {
          let campaignInfo = `${campaign.name} (ID: ${campaign.id})`;
          
          // Count leads awaiting connection
          let awaitingConnectionCount = 0;
          try {
            const { count: nullCount, error: nullError } = await withTimeout(
              supabase
                .from('scraped_profiles')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', campaign.id.toString())
                .is('connection_status', null),
              5000,
              `Timeout while counting profiles with null status`
            );

            const { count: notSentCount, error: notSentError } = await withTimeout(
              supabase
                .from('scraped_profiles')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', campaign.id.toString())
                .eq('connection_status', 'not sent'),
              5000,
              `Timeout while counting profiles with 'not sent' status`
            );

            if (nullError) throw new Error(JSON.stringify(nullError, null, 2));
            if (notSentError) throw new Error(JSON.stringify(notSentError, null, 2));

            awaitingConnectionCount = (nullCount || 0) + (notSentCount || 0);
          } catch (error) {
            logger.error(`Failed to count awaiting connections: ${error.message}`);
            campaignInfo += ' ❌ Error fetching connection requests';
            inactiveCampaigns.push(campaignInfo);
            continue;
          }

          // Count pending connection requests
          let pendingConnectionCount = 0;
          try {
            const { count, error: pendingError } = await withTimeout(
              supabase
                .from('scraped_profiles')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', campaign.id.toString())
                .eq('connection_status', 'pending'),
              5000,
              `Timeout while counting pending connections`
            );
            if (pendingError) throw new Error(JSON.stringify(pendingError, null, 2));
            pendingConnectionCount = count || 0;
          } catch (error) {
            logger.error(`Failed to count pending connections: ${error.message}`);
          }

          // Count connections available to message
          let connectionsToMessageCount = 0;
          try {
            const { count, error: connectionsError } = await withTimeout(
              supabase
                .from('leads')
                .select('id', { count: 'exact', head: true })
                .eq('client_id', campaign.client_id)
                .eq('message_sent', false)
                .eq('is_open_profile', false)
                .eq('connection_level', '1st')
                .eq('status', 'not_replied'),
              5000,
              `Timeout while counting connections to message`
            );
            if (connectionsError) throw new Error(JSON.stringify(connectionsError, null, 2));
            connectionsToMessageCount = count || 0;
          } catch (error) {
            logger.error(`Failed to count connections to message: ${error.message}`);
          }

          // Count connections awaiting 2nd follow-up
          let connectionsSecondFollowupCount = 0;
          try {
            const { count, error: secondFollowupError } = await withTimeout(
              supabase
                .from('leads')
                .select('id', { count: 'exact', head: true })
                .eq('client_id', campaign.client_id)
                .eq('message_sent', true)
                .eq('is_open_profile', false)
                .eq('connection_level', '1st')
                .eq('message_stage', 2),
              5000,
              `Timeout while counting connections awaiting 2nd follow-up`
            );
            if (secondFollowupError) throw new Error(JSON.stringify(secondFollowupError, null, 2));
            connectionsSecondFollowupCount = count || 0;
          } catch (error) {
            logger.error(`Failed to count connections awaiting 2nd follow-up: ${error.message}`);
          }

          // Count connections awaiting 3rd follow-up
          let connectionsThirdFollowupCount = 0;
          try {
            const { count, error: thirdFollowupError } = await withTimeout(
              supabase
                .from('leads')
                .select('id', { count: 'exact', head: true })
                .eq('client_id', campaign.client_id)
                .eq('message_sent', true)
                .eq('is_open_profile', false)
                .eq('connection_level', '1st')
                .eq('message_stage', 3),
              5000,
              `Timeout while counting connections awaiting 3rd follow-up`
            );
            if (thirdFollowupError) throw new Error(JSON.stringify(thirdFollowupError, null, 2));
            connectionsThirdFollowupCount = count || 0;
          } catch (error) {
            logger.error(`Failed to count connections awaiting 3rd follow-up: ${error.message}`);
          }

          // Add stats to campaign info
          campaignInfo += `\n   🔗 ${awaitingConnectionCount} leads awaiting connection`;
          if (pendingConnectionCount > 0) {
            campaignInfo += `\n   ⏳ ${pendingConnectionCount} pending connection requests`;
          }
          if (connectionsToMessageCount > 0) {
            campaignInfo += `\n   📨 ${connectionsToMessageCount} connections available to message`;
          }
          if (connectionsSecondFollowupCount > 0) {
            campaignInfo += `\n   📬 ${connectionsSecondFollowupCount} connections awaiting 2nd follow-up`;
          }
          if (connectionsThirdFollowupCount > 0) {
            campaignInfo += `\n   📭 ${connectionsThirdFollowupCount} connections awaiting 3rd follow-up`;
          }

          if (awaitingConnectionCount > 0 || pendingConnectionCount > 0 || 
              connectionsToMessageCount > 0 || connectionsSecondFollowupCount > 0 || 
              connectionsThirdFollowupCount > 0) {
            activeCampaigns.push(campaignInfo);
          } else {
            inactiveCampaigns.push(campaignInfo);
          }
        }

        // Send the report
        let message = '📊 *Connection Campaign Stats*\n\n';
        
        if (activeCampaigns.length > 0) {
          message += '*Active Campaigns:*\n' + activeCampaigns.join('\n\n');
        }
        
        if (inactiveCampaigns.length > 0) {
          if (activeCampaigns.length > 0) message += '\n\n';
          message += '*Inactive Campaigns:*\n' + inactiveCampaigns.join('\n\n');
        }

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Error in campaignstatsconnections command:', error);
        bot.sendMessage(chatId, `❌ Error fetching campaign stats: ${error.message}`);
      }
    });

    // Log polling errors
    bot.on('polling_error', (error) => {
      logger.error(`Telegram bot polling error: ${error.message}`);
    });

    logger.info('Telegram bot initialized and polling for commands');
  }).catch((error) => {
    logger.error(`Failed to fetch bot info: ${error.message}`);
  });
};

// Add or update the job status reporting function
/**
 * Send a job status report to the Telegram chat
 * @param {string} jobId - The job ID
 * @param {string} jobType - The type of job
 * @param {string} status - The job status
 * @param {Object} details - Additional details about the job
 */
const sendJobStatusReport = async (jobId, jobType, status, details = {}) => {
  const logger = createLogger();
  
  try {
    let emoji = '🔄';
    if (status === 'completed') emoji = '✅';
    if (status === 'failed') emoji = '❌';
    if (status === 'started') emoji = '🚀';
    
    let message = `${emoji} Job ${jobId} (${jobType}) ${status}\n`;
    
    if (details.campaignId) {
      message += `Campaign: ${details.campaignId}\n`;
    }

    // Use the summary field if available
    if (details.summary) {
      message += `\n${details.summary}`;
    } else {
      // Fallback to old format
      if (details.message) {
        message += `Message: ${details.message}\n`;
      }
      
      if (details.totalLeads !== undefined) {
        message += `Total leads: ${details.totalLeads}\n`;
      }
      
      if (details.savedCount !== undefined) {
        message += `Saved: ${details.savedCount}\n`;
      }
      
      if (details.duplicateCount !== undefined) {
        message += `Duplicates: ${details.duplicateCount}\n`;
      }
      
      if (details.errorCount !== undefined) {
        message += `Errors: ${details.errorCount}\n`;
      }
      
      if (details.error) {
        message += `Error: ${details.error}\n`;
      }
    }
    
    await bot.sendMessage(process.env.TELEGRAM_NOTIFICATION_CHAT_ID, message);
    logger.info(`Sent job status report to Telegram: ${status}`);
  } catch (error) {
    logger.error(`Failed to send job status report to Telegram: ${error.message}`);
  }
};

// Export the bot instance and initialization function
module.exports = {
  bot,
  initializeBot,
  sendJobStatusReport
};