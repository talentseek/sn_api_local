/**
 * Main application entry point for LinkedIn Sales Navigator Automation System
 * @module app
 */
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const createLogger = require('./utils/logger');
const scrapeController = require('./controllers/scrapeController');
const scrapePremiumProfilesController = require('./controllers/scrapePremiumProfilesController');
const checkOpenProfilesController = require('./controllers/checkOpenProfilesController');
const checkCookiesController = require('./controllers/checkCookiesController');
const sendConnectionRequestsController = require('./controllers/sendConnectionRequestsController');
const sendOpenProfileMessagesController = require('./controllers/sendOpenProfileMessagesController');
const checkConnectionRequestsController = require('./controllers/checkConnectionRequestsController');
const sendConnectionMessagesController = require('./controllers/sendConnectionMessagesController');
const { initializeBot } = require('./telegramBot');
require('./scheduler/checkCookiesScheduler');
const jobQueueManager = require('./utils/jobQueueManager');

const app = express();
const logger = createLogger();

// Log environment variables for debugging
console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log('TELEGRAM_NOTIFICATION_CHAT_ID:', process.env.TELEGRAM_NOTIFICATION_CHAT_ID);
console.log('TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN);
console.log('PORT:', process.env.PORT);

// Validate Supabase credentials
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  logger.error('Missing Supabase credentials. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your .env file.');
  process.exit(1);
}

/**
 * Initialize Supabase client for database operations
 * @type {import('@supabase/supabase-js').SupabaseClient}
 */
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Log the supabase instance to confirm it's initialized
logger.info(`Supabase client after initialization: ${supabase ? 'defined' : 'undefined'}`);
if (!supabase || typeof supabase.from !== 'function') {
  logger.error('Supabase client failed to initialize properly');
  process.exit(1);
}

// Initialize Telegram bot with the supabase instance
initializeBot(supabase);

app.use(express.json());

/**
 * API Routes for LinkedIn automation operations
 * @see {@link ./docs/api.yaml} for OpenAPI specification
 */

/**
 * Scrape profiles from LinkedIn Sales Navigator search results
 * @route POST /api/scrape
 */
app.post('/api/scrape', scrapeController(supabase, jobQueueManager));

/**
 * Scrape detailed information from premium profiles
 * @route POST /api/scrape-premium-profiles
 */
app.post('/api/scrape-premium-profiles', scrapePremiumProfilesController(supabase));

/**
 * Check which profiles allow open messaging without a connection
 * @route POST /api/check-open-profiles
 */
app.post('/api/check-open-profiles', checkOpenProfilesController(supabase));

/**
 * Verify that LinkedIn cookies are still valid
 * @route POST /api/check-cookies
 */
app.post('/api/check-cookies', checkCookiesController(supabase));

/**
 * Send connection requests to specified profiles
 * @route POST /api/send-connection-requests
 */
app.post('/api/send-connection-requests', sendConnectionRequestsController(supabase));

/**
 * Send messages to open profiles that don't require a connection
 * @route POST /api/send-open-profile-messages
 */
app.post('/api/send-open-profile-messages', sendOpenProfileMessagesController(supabase));

/**
 * Check the status of previously sent connection requests
 * @route POST /api/check-connection-requests
 */
app.post('/api/check-connection-requests', checkConnectionRequestsController(supabase));

/**
 * Send messages to accepted connections
 * @route POST /api/send-connection-messages
 */
app.post('/api/send-connection-messages', sendConnectionMessagesController(supabase));

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});