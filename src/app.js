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

// Initialize Supabase client
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

// Routes
app.post('/api/scrape', scrapeController(supabase));
app.post('/api/scrape-premium-profiles', scrapePremiumProfilesController(supabase));
app.post('/api/check-open-profiles', checkOpenProfilesController(supabase));
app.post('/api/check-cookies', checkCookiesController(supabase));
app.post('/api/send-connection-requests', sendConnectionRequestsController(supabase));
app.post('/api/send-open-profile-messages', sendOpenProfileMessagesController(supabase));
app.post('/api/check-connection-requests', checkConnectionRequestsController(supabase));
app.post('/api/send-connection-messages', sendConnectionMessagesController(supabase));

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});