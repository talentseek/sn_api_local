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

        // Build the response message
        let response = '📊 Campaign Statistics:\n';
        for (const campaign of campaigns) {
          let campaignStats = `- Campaign ${campaign.id} (${campaign.name}): `;

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
            campaignStats += 'Error fetching leads';
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
            campaignStats += (campaignStats.endsWith(': ') ? '' : ', ') + 'Error fetching premium profiles';
          }

          // Only add counts if there were no errors
          if (!campaignStats.includes('Error')) {
            campaignStats += `${leadsCount} leads available to message, ${premiumCount} premium profiles to check`;
          }

          response += `${campaignStats}\n`;
        }

        await bot.sendMessage(TELEGRAM_CHAT_ID, response);
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