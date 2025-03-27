require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const createLogger = require('./utils/logger');
const scrapeController = require('./controllers/scrapeController');
const scrapePremiumProfilesController = require('./controllers/scrapePremiumProfilesController');
const checkOpenProfilesController = require('./controllers/checkOpenProfilesController');
const checkCookiesController = require('./controllers/checkCookiesController');
const sendConnectionRequestsController = require('./controllers/sendConnectionRequestsController');
const { initializeBot } = require('./telegramBot'); // Import the bot initialization function
require('./scheduler/checkCookiesScheduler'); // Import the scheduler to start it

const app = express();
const logger = createLogger();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Telegram bot with Supabase dependency
initializeBot(supabase);

// Middleware to parse JSON bodies
app.use(express.json());

// Define routes
app.post('/api/scrape', scrapeController(supabase));
app.post('/api/scrape-premium-profiles', scrapePremiumProfilesController(supabase));
app.post('/api/check-open-profiles', checkOpenProfilesController(supabase));
app.post('/api/check-cookies', checkCookiesController(supabase));
app.post('/api/send-connection-requests', sendConnectionRequestsController(supabase));

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});