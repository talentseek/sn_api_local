/**
 * Main application entry point for LinkedIn Sales Navigator Automation System
 * @module app
 */
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const createLogger = require('./utils/logger');
// Import controller FACTORIES (except scrapeController)
const scrapeController = require('./controllers/scrapeController'); // Import directly
const scrapePremiumProfilesControllerFactory = require('./controllers/scrapePremiumProfilesController');
const checkOpenProfilesControllerFactory = require('./controllers/checkOpenProfilesController');
const checkCookiesControllerFactory = require('./controllers/checkCookiesController');
const sendConnectionRequestsControllerFactory = require('./controllers/sendConnectionRequestsController');
const sendOpenProfileMessagesControllerFactory = require('./controllers/sendOpenProfileMessagesController');
const checkConnectionRequestsControllerFactory = require('./controllers/checkConnectionRequestsController');
const sendConnectionMessagesControllerFactory = require('./controllers/sendConnectionMessagesController');
const scrapeCompanyDataControllerFactory = require('./controllers/scrapeCompanyDataController');
// Other necessary imports
const { initializeBot } = require('./telegramBot');
// Simply require the scheduler file to execute it and start the cron job
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

// --- Create Controller Instances by calling the factories ---
// REMOVE line 59 as scrapeController is imported directly
// const scrapeController = scrapeControllerFactory(supabase);
const scrapePremiumProfilesController = scrapePremiumProfilesControllerFactory(supabase);
const checkOpenProfilesController = checkOpenProfilesControllerFactory(supabase); // Assuming direct export - VERIFY
const checkCookiesController = checkCookiesControllerFactory(supabase); // Assuming direct export - VERIFY
const sendConnectionRequestsController = sendConnectionRequestsControllerFactory(supabase); // Assuming direct export - VERIFY
const sendOpenProfileMessagesController = sendOpenProfileMessagesControllerFactory(supabase); // Assuming direct export - VERIFY
const checkConnectionRequestsController = checkConnectionRequestsControllerFactory(supabase); // Assuming direct export - VERIFY
const sendConnectionMessagesController = sendConnectionMessagesControllerFactory(supabase); // Assuming direct export - VERIFY
const scrapeCompanyDataController = scrapeCompanyDataControllerFactory(supabase);

/**
 * API Routes for LinkedIn automation operations
 * @see {@link ./docs/api.yaml} for OpenAPI specification
 */

/**
 * Scrape profiles from LinkedIn Sales Navigator search results
 * @route POST /api/scrape
 */
// Wrap the handler to explicitly pass the supabase instance
app.post('/api/scrape', (req, res) => {
  // Now we call addScrapeJob with the correct arguments: req, res, and the supabase client
  scrapeController.addScrapeJob(req, res, supabase);
});

/**
 * Scrape detailed information from premium profiles
 * @route POST /api/scrape-premium-profiles
 */
// Uses the controller instance created via factory
app.post('/api/scrape-premium-profiles', scrapePremiumProfilesController);

/**
 * Check which profiles allow open messaging without a connection
 * @route POST /api/check-open-profiles
 */
app.post('/api/check-open-profiles', checkOpenProfilesController);

/**
 * Verify that LinkedIn cookies are still valid
 * @route POST /api/check-cookies
 */
app.post('/api/check-cookies', checkCookiesController);

/**
 * Send connection requests to specified profiles
 * @route POST /api/send-connection-requests
 */
app.post('/api/send-connection-requests', sendConnectionRequestsController);

/**
 * Send messages to open profiles that don't require a connection
 * @route POST /api/send-open-profile-messages
 */
app.post('/api/send-open-profile-messages', sendOpenProfileMessagesController);

/**
 * Check the status of previously sent connection requests
 * @route POST /api/check-connection-requests
 */
app.post('/api/check-connection-requests', checkConnectionRequestsController);

/**
 * Send messages to accepted connections
 * @route POST /api/send-connection-messages
 */
app.post('/api/send-connection-messages', sendConnectionMessagesController);

/**
 * Scrape company data from LinkedIn
 * @route POST /api/scrape-company-data
 */
// Uses the controller instance created via factory
app.post('/api/scrape-company-data', scrapeCompanyDataController);

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  // Add cleanup logic here if needed (e.g., close database connections)
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT signal received: closing HTTP server');
  // Add cleanup logic here if needed
  process.exit(0);
});