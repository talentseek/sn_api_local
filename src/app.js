/**
 * Main application entry point for LinkedIn Sales Navigator Automation System
 * @module app
 */
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const createLogger = require('./utils/logger');

// Import controller FACTORIES
const checkCookiesControllerFactory = require('./controllers/checkCookiesController');
const sendConnectionRequestsControllerFactory = require('./controllers/sendConnectionRequestsController');
const sendOpenProfileMessagesControllerFactory = require('./controllers/sendOpenProfileMessagesController');
const checkConnectionRequestsControllerFactory = require('./controllers/checkConnectionRequestsController');
const sendConnectionMessagesControllerFactory = require('./controllers/sendConnectionMessagesController');

// Other necessary imports
const { initializeBot } = require('./telegramBot');
// Simply require the scheduler file to execute it and start the cron job
require('./scheduler/checkCookiesScheduler');
// Start the connection requests scheduler
require('./scheduler/sendConnectionsScheduler');
// Start the check connection requests scheduler
require('./scheduler/checkConnectionRequestsScheduler');
// Start the connection messages scheduler
require('./scheduler/sendConnectionMessagesScheduler');
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

// Initialize controllers with supabase instance
const checkCookiesController = checkCookiesControllerFactory(supabase);
const sendConnectionRequestsController = sendConnectionRequestsControllerFactory(supabase);
const sendOpenProfileMessagesController = sendOpenProfileMessagesControllerFactory(supabase);
const checkConnectionRequestsController = checkConnectionRequestsControllerFactory(supabase);
const sendConnectionMessagesController = sendConnectionMessagesControllerFactory(supabase);

/**
 * API Routes for LinkedIn automation operations
 * @see {@link ./docs/api.yaml} for OpenAPI specification
 */

/**
 * Verify that LinkedIn cookies are still valid
 * @route POST /api/check-cookies
 */
app.post('/api/check-cookies', async (req, res, next) => {
  try {
    await checkCookiesController(req, res);
  } catch (error) {
    next(error);
  }
});

/**
 * Send connection requests to specified profiles
 * @route POST /api/send-connection-requests
 */
app.post('/api/send-connection-requests', async (req, res, next) => {
  try {
    await sendConnectionRequestsController(req, res);
  } catch (error) {
    next(error);
  }
});

/**
 * Send messages to open profiles that don't require a connection
 * @route POST /api/send-open-profile-messages
 */
app.post('/api/send-open-profile-messages', async (req, res, next) => {
  try {
    await sendOpenProfileMessagesController(req, res);
  } catch (error) {
    next(error);
  }
});

/**
 * Check the status of previously sent connection requests
 * @route POST /api/check-connection-requests
 */
app.post('/api/check-connection-requests', async (req, res, next) => {
  try {
    await checkConnectionRequestsController(req, res);
  } catch (error) {
    next(error);
  }
});

/**
 * Send messages to accepted connections
 * @route POST /api/send-connection-messages
 */
app.post('/api/send-connection-messages', async (req, res, next) => {
  try {
    await sendConnectionMessagesController(req, res);
  } catch (error) {
    next(error);
  }
});

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check database connection
    const { data, error } = await supabase
      .from('campaigns')
      .select('id')
      .limit(1);
    
    if (error) {
      return res.status(500).json({
        status: 'error',
        database: 'error',
        message: 'Database connection failed',
        timestamp: new Date().toISOString()
      });
    }

    // Check job queue status
    const queueStatus = jobQueueManager.getStatus();

    res.status(200).json({
      status: 'healthy',
      database: 'connected',
      jobQueue: queueStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
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

module.exports = app;