require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const createLogger = require('./utils/logger');

// Import the scheduler
const { checkCookiesForActiveCampaigns } = require('./scheduler/checkCookiesScheduler');

const logger = createLogger();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

// Import controllers as factory functions and pass supabase
const scrapeController = require('./controllers/scrapeController')(supabase);
const checkOpenProfilesController = require('./controllers/checkOpenProfilesController')(supabase);
const scrapePremiumProfilesController = require('./controllers/scrapePremiumProfilesController')(supabase);
const sendConnectionRequestsController = require('./controllers/sendConnectionRequestsController')(supabase);
const checkCookiesController = require('./controllers/checkCookiesController')(supabase);

// Define routes using the controller functions directly
router.post('/scrape-profiles', scrapeController);
router.post('/check-open-profiles', checkOpenProfilesController);
router.post('/scrape-premium-profiles', scrapePremiumProfilesController);
router.post('/send-connection-requests', sendConnectionRequestsController);
router.post('/check-cookies', checkCookiesController);

const app = express();
app.use(express.json());
app.use('/api', router);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

module.exports = app;