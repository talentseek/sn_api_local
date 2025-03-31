require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const createLogger = require('./utils/logger');

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

// Utility function to add a timeout to Supabase queries
const withTimeout = async (promise, timeoutMs, errorMessage) => {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeout]);
};

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

    // Define the command regex with the bot's username
    const commandRegex = new RegExp(`^/campaignstats(?:@${botUsername})?(?:\\s|$)`);

    // Handle /campaignstats command (with or without @BotUsername)
    bot.onText(commandRegex, async (msg) => {
      const chatId = msg.chat.id.toString();
      logger.info(`Received /campaignstats command from chat ID ${chatId}`);

      // Log the msg.from value for debugging
      const fromId = msg.from?.id || 'unknown';
      const fromUsername = msg.from?.username || 'unknown';
      logger.info(`Command sent by user ID ${fromId} (${fromUsername})`);

      // Log the supabase instance inside the handler
      logger.info(`Supabase instance inside /campaignstats handler: ${supabase ? 'defined' : 'undefined'}`);
      if (!supabase || typeof supabase.from !== 'function') {
        logger.error('Supabase client is not available in /campaignstats handler');
        await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, '❌ Error: Supabase client not initialized. Please contact the administrator.');
        return;
      }

      // Only respond to the authorized chat ID
      if (chatId !== TELEGRAM_CHAT_ID.trim()) {
        logger.warn(`Unauthorized chat ID ${chatId} attempted to use /campaignstats (expected ${TELEGRAM_CHAT_ID})`);
        return;
      }

      try {
        // Log before the Supabase query
        logger.info('Attempting to fetch campaigns from Supabase...');
        const { data: campaigns, error: campaignError } = await withTimeout(
          supabase
            .from('campaigns')
            .select('id, name, client_id')
            .eq('status', 'active'),
          10000,
          'Timeout while fetching campaigns'
        );

        // Log the result of the Supabase query
        logger.info(`Supabase query result: ${campaigns ? `${campaigns.length} campaigns found` : 'No campaigns'}`);
        if (campaignError) {
          logger.error(`Failed to fetch campaigns: ${JSON.stringify(campaignError, null, 2)}`);
          await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, '❌ Error fetching campaign statistics. Please try again later.');
          return;
        }

        if (!campaigns || campaigns.length === 0) {
          await bot.sendMessage(TELEGRAM_CHAT_ID, 'ℹ️ No active campaigns found.');
          return;
        }

        // Build the response message with better formatting and emojis
        let readyCampaigns = [];
        let needMoreLeadsCampaigns = [];
        let inactiveCampaigns = [];

        for (const campaign of campaigns) {
          // Format the campaign info with emojis and better spacing
          let campaignInfo = `${campaign.name} (ID: ${campaign.id})`;
          
          // Count leads available to message using client_id
          let leadsCount = 0;
          try {
            logger.info(`Counting leads for campaign ${campaign.id} (client_id: ${campaign.client_id})...`);
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

            if (leadsError) {
              throw new Error(JSON.stringify(leadsError, null, 2));
            }
            leadsCount = count || 0;
            logger.info(`Found ${leadsCount} leads for campaign ${campaign.id}`);
          } catch (error) {
            logger.error(`Failed to count leads for campaign ${campaign.id} (client_id: ${campaign.client_id}): ${error.message}`);
            campaignInfo += ' ❌ Error fetching leads';
            inactiveCampaigns.push(campaignInfo);
            continue;
          }

          // Count premium profiles to check
          let premiumCount = 0;
          try {
            logger.info(`Counting premium profiles for campaign ${campaign.id}...`);
            const { count, error: premiumError } = await withTimeout(
              supabase
                .from('premium_profiles')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', campaign.id.toString())
                .eq('is_checked', false)
                .eq('moved_to_leads', false),
              5000,
              `Timeout while counting premium profiles for campaign ${campaign.id}`
            );

            if (premiumError) {
              throw new Error(JSON.stringify(premiumError, null, 2));
            }
            premiumCount = count || 0;
            logger.info(`Found ${premiumCount} premium profiles for campaign ${campaign.id}`);
          } catch (error) {
            logger.error(`Failed to count premium profiles for campaign ${campaign.id}: ${error.message}`);
            campaignInfo += ' ❌ Error fetching premium profiles';
            inactiveCampaigns.push(campaignInfo);
            continue;
          }

          // Count scraped profiles awaiting connection requests
          let awaitingConnectionCount = 0;
          try {
            logger.info(`Checking scraped profiles for campaign ${campaign.id} with connection_status null or 'not sent'`);
            const { count: nullCount, error: nullError } = await withTimeout(
              supabase
                .from('scraped_profiles')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', campaign.id.toString())
                .is('connection_status', null),
              5000,
              `Timeout while counting scraped profiles with null status for campaign ${campaign.id}`
            );

            const { count: notSentCount, error: notSentError } = await withTimeout(
              supabase
                .from('scraped_profiles')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', campaign.id.toString())
                .eq('connection_status', 'not sent'),
              5000,
              `Timeout while counting scraped profiles with 'not sent' status for campaign ${campaign.id}`
            );

            if (nullError) {
              throw new Error(JSON.stringify(nullError, null, 2));
            }
            if (notSentError) {
              throw new Error(JSON.stringify(notSentError, null, 2));
            }

            awaitingConnectionCount = (nullCount || 0) + (notSentCount || 0);
            logger.info(`Found ${nullCount || 0} profiles with null status and ${notSentCount || 0} with 'not sent' status for campaign ${campaign.id}`);

            // If count is still 0, let's do a sample query to see what values exist
            if (awaitingConnectionCount === 0) {
              try {
                const { data: sampleData } = await withTimeout(
                  supabase
                    .from('scraped_profiles')
                    .select('id, connection_status')
                    .eq('campaign_id', campaign.id.toString())
                    .limit(5),
                  5000,
                  `Timeout while sampling scraped profiles for campaign ${campaign.id}`
                );
                
                if (sampleData && sampleData.length > 0) {
                  logger.info(`Sample scraped profiles for campaign ${campaign.id}: ${JSON.stringify(sampleData)}`);
                } else {
                  logger.info(`No scraped profiles found for campaign ${campaign.id}`);
                }
              } catch (error) {
                logger.error(`Error sampling scraped profiles: ${error.message}`);
              }
            }
          } catch (error) {
            logger.error(`Failed to count scraped profiles for campaign ${campaign.id}: ${error.message}`);
            campaignInfo += ' ❌ Error fetching scraped profiles';
            // Don't continue here, we still want to show the campaign with the data we have
          }

          // Count leads awaiting 2nd follow-up (message_sent true, message_stage 2)
          let awaitingSecondFollowupCount = 0;
          try {
            logger.info(`Counting leads awaiting 2nd follow-up for campaign ${campaign.id} (client_id: ${campaign.client_id})...`);
            const { count, error: secondFollowupError } = await withTimeout(
              supabase
                .from('leads')
                .select('id', { count: 'exact', head: true })
                .eq('client_id', campaign.client_id)
                .eq('message_sent', true)
                .eq('message_stage', 2),
              5000,
              `Timeout while counting leads awaiting 2nd follow-up for campaign ${campaign.id}`
            );

            if (secondFollowupError) {
              throw new Error(JSON.stringify(secondFollowupError, null, 2));
            }
            awaitingSecondFollowupCount = count || 0;
            logger.info(`Found ${awaitingSecondFollowupCount} leads awaiting 2nd follow-up for campaign ${campaign.id}`);
          } catch (error) {
            logger.error(`Failed to count leads awaiting 2nd follow-up for campaign ${campaign.id}: ${error.message}`);
            // Don't continue here, we still want to show the campaign with the data we have
          }

          // Count leads awaiting 3rd follow-up (message_sent true, message_stage 3)
          let awaitingThirdFollowupCount = 0;
          try {
            logger.info(`Counting leads awaiting 3rd follow-up for campaign ${campaign.id} (client_id: ${campaign.client_id})...`);
            const { count, error: thirdFollowupError } = await withTimeout(
              supabase
                .from('leads')
                .select('id', { count: 'exact', head: true })
                .eq('client_id', campaign.client_id)
                .eq('message_sent', true)
                .eq('message_stage', 3),
              5000,
              `Timeout while counting leads awaiting 3rd follow-up for campaign ${campaign.id}`
            );

            if (thirdFollowupError) {
              throw new Error(JSON.stringify(thirdFollowupError, null, 2));
            }
            awaitingThirdFollowupCount = count || 0;
            logger.info(`Found ${awaitingThirdFollowupCount} leads awaiting 3rd follow-up for campaign ${campaign.id}`);
          } catch (error) {
            logger.error(`Failed to count leads awaiting 3rd follow-up for campaign ${campaign.id}: ${error.message}`);
            // Don't continue here, we still want to show the campaign with the data we have
          }

          // Add the counts to the campaign info
          campaignInfo += `\n   📨 ${leadsCount} leads available to message`;
          if (premiumCount > 0) {
            campaignInfo += `\n   🔍 ${premiumCount} premium profiles to check`;
          }
          if (awaitingConnectionCount > 0) {
            campaignInfo += `\n   🔗 ${awaitingConnectionCount} leads awaiting connection`;
          }
          if (awaitingSecondFollowupCount > 0) {
            campaignInfo += `\n   📬 ${awaitingSecondFollowupCount} leads awaiting 2nd follow-up`;
          }
          if (awaitingThirdFollowupCount > 0) {
            campaignInfo += `\n   📭 ${awaitingThirdFollowupCount} leads awaiting 3rd follow-up`;
          }

          // Update the categorization logic to include campaigns with follow-ups
          if (leadsCount >= 40) {
            readyCampaigns.push(campaignInfo);
          } else if (leadsCount > 0 || premiumCount > 0 || awaitingConnectionCount > 0 || 
                     awaitingSecondFollowupCount > 0 || awaitingThirdFollowupCount > 0) {
            needMoreLeadsCampaigns.push(campaignInfo);
          } else {
            inactiveCampaigns.push(campaignInfo);
          }
        }

        // Build the final response with sections
        let response = '📊 *Campaign Statistics*\n\n';

        if (readyCampaigns.length > 0) {
          response += '✅ *Ready Campaigns* (40+ leads available):\n';
          readyCampaigns.forEach((campaign, index) => {
            response += `${index + 1}. ${campaign}\n\n`;
          });
        }

        if (needMoreLeadsCampaigns.length > 0) {
          if (readyCampaigns.length > 0) response += '\n';
          response += '⏳ *Campaigns Needing More Leads*:\n';
          needMoreLeadsCampaigns.forEach((campaign, index) => {
            response += `${index + 1}. ${campaign}\n\n`;
          });
        }

        if (inactiveCampaigns.length > 0) {
          if (readyCampaigns.length > 0 || needMoreLeadsCampaigns.length > 0) response += '\n';
          response += '💤 *Inactive Campaigns* (no leads or profiles):\n';
          inactiveCampaigns.forEach((campaign, index) => {
            response += `${index + 1}. ${campaign}\n\n`;
          });
        }

        // Send the formatted message with Markdown parsing
        await bot.sendMessage(TELEGRAM_CHAT_ID, response, { parse_mode: 'Markdown' });
        logger.info('Sent campaign statistics to Telegram');
      } catch (error) {
        logger.error(`Error handling /campaignstats command: ${error.message}`);
        await bot.sendMessage(TELEGRAM_NOTIFICATION_CHAT_ID, '❌ Error fetching campaign statistics. Please try again later.');
      }
    });
  }).catch((error) => {
    logger.error(`Failed to fetch bot info: ${error.message}`);
  });

  // Log polling errors
  bot.on('polling_error', (error) => {
    logger.error(`Telegram bot polling error: ${error.message}`);
  });

  logger.info('Telegram bot initialized and polling for commands');
};

// Export the bot instance and initialization function
module.exports = {
  bot,
  initializeBot,
};