/**
 * Controller for scraping LinkedIn Sales Navigator search results
 * @module controllers/scrapeController
 */
const { v4: uuidv4 } = require('uuid');
const createLogger = require('../utils/logger');
const scraperModule = require('../modules/scraper'); // Use the simplified scraper
const cookieLoader = require('../modules/cookieLoader');
const { insertScrapedProfiles, withTimeout } = require('../utils/databaseUtils'); // Use the existing insert function
const jobQueueManager = require('../utils/jobQueueManager');
const { sendJobStatusReport } = require('../telegramBot');

// Process the job asynchronously
const processJob = async (currentJobId, supabase, jobParams) => {
  const logger = createLogger();
  const scraperInstance = scraperModule(); // Create an instance of the simplified scraper
  let jobStatus = 'failed'; // Default to failed
  let jobResult = null;
  let errorCategory = 'unknown';
  let errorMessage = '';
  let totalScraped = 0;
  let totalValid = 0;
  let totalInserted = 0;
  const { lastPage, searchUrl } = jobParams || {}; // Use default empty object to avoid errors if jobParams is undefined

  try {
    logger.info(`Processing scrape job ${currentJobId}...`);

    // 1. Fetch Job Details (we still need campaign_id from here)
    const { data: jobData, error: jobFetchError } = await withTimeout(
      supabase.from('jobs').select('campaign_id').eq('job_id', currentJobId).single(), // Only select necessary fields
      10000, 'Timeout fetching job data'
    );

    if (jobFetchError || !jobData) {
      errorMessage = `Failed to fetch job ${currentJobId}: ${jobFetchError?.message || 'Not found'}`;
      errorCategory = 'job_fetch_failed';
      logger.error(errorMessage);
      // No need to update job here, finally block will handle it if jobData is null
      return; // Exit early
    }

    const { campaign_id } = jobData; // Only get campaign_id from jobData
    const campaignId = parseInt(campaign_id); // Ensure campaignId is a number

    if (!campaignId || !searchUrl || !lastPage) {
        errorMessage = `Job ${currentJobId} is missing required parameters: campaignId=${campaignId}, searchUrl=${searchUrl}, lastPage=${lastPage}.`;
        errorCategory = 'job_data_invalid';
        logger.error(errorMessage);
        // Update job status in finally block
        return;
    }

    logger.info(`Processing scrape job ${currentJobId} for campaign ${campaignId}, requested lastPage: ${lastPage}`);

    // Update job status to processing
    await withTimeout(
      supabase.from('jobs').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('job_id', currentJobId),
      10000, 'Timeout updating job status to processing'
    );

    // 2. Load Cookies
    const { cookies, error: cookieError } = await cookieLoader(supabase, { campaignId });
    if (cookieError || !cookies) {
      errorMessage = `Failed to load cookies for campaign ${campaignId}: ${cookieError || 'No valid cookies found'}`;
      errorCategory = 'cookie_load_failed';
      logger.error(errorMessage);
      // Update job status in finally block
      return;
    }

    // 3. Initialize Browser
    await scraperInstance.initializeBrowser(cookies);

    // 4. Perform Scraping
    const scrapeResult = await scraperInstance.scrapeSearchResults(searchUrl, lastPage);

    // Check if scraping returned an error object
    if (scrapeResult && scrapeResult.error) {
        errorMessage = `Scraping failed: ${scrapeResult.error}`;
        errorCategory = 'scraping_failed';
        logger.error(errorMessage);
        // Use the leads collected so far, if any
        totalScraped = scrapeResult.leads ? scrapeResult.leads.length : 0;
        // Don't return yet, proceed to insert what was collected and then fail in finally block
    } else if (!scrapeResult || !Array.isArray(scrapeResult)) {
        // Handle cases where scrapeResult is not as expected (e.g., null, undefined, not an array)
        errorMessage = 'Scraping did not return valid results.';
        errorCategory = 'scraping_failed';
        logger.error(errorMessage);
        totalScraped = 0;
        // Don't return yet, fail in finally block
    } else {
        // Scraping succeeded (or partially succeeded without throwing an error object)
        totalScraped = scrapeResult.length;
        logger.info(`Scraped ${totalScraped} raw profiles for job ${currentJobId}.`);

        // 5. Data Cleaning & Validation
        const validProfiles = scrapeResult.filter(profile => {
            // Check for required fields
            if (!profile || !profile.name || !profile.profileLink) {
                logger.warn(`Invalid profile found: ${JSON.stringify(profile)}`);
                return false;
            }
            return true;
        });
        totalValid = validProfiles.length;
        logger.info(`Validated ${totalValid} profiles.`);

        if (totalValid > 0) {
            // Add campaign_id before inserting
            const profilesToInsert = validProfiles.map(p => {
                // Split full name into first and last name
                const [firstName = '', ...lastNameParts] = p.name.split(' ');
                const lastName = lastNameParts.join(' ');

                return {
                    campaign_id: campaignId,
                    linkedin: p.profileLink,
                    first_name: firstName,
                    last_name: lastName,
                    job_title: p.jobTitle,
                    company: p.company,
                    companylink: p.companyLink,
                    connection_level: p.connectionLevel,
                    connection_status: 'not_sent',
                    scraped_at: new Date().toISOString(),
                    created_at: new Date().toISOString()
                };
            });

            // 6. Insert into Database
            totalInserted = await insertScrapedProfiles(supabase, profilesToInsert, campaignId);
            logger.info(`Inserted ${totalInserted} new profiles into scraped_profiles for job ${currentJobId}.`);
        } else {
            logger.info(`No valid profiles to insert for job ${currentJobId}.`);
        }

        // If scraping didn't explicitly return an error, mark as completed
        if (!errorMessage) {
            jobStatus = 'completed';
            jobResult = {
                message: `Scraping completed. Scraped: ${totalScraped}, Valid: ${totalValid}, Inserted: ${totalInserted}.`,
                totalScraped,
                totalValid,
                totalInserted
            };
            logger.success(`Scrape job ${currentJobId} completed successfully.`);
        }
    }

  } catch (error) {
    // Catch errors from initializeBrowser, insertScrapedProfiles, or other unexpected issues
    errorMessage = `Unexpected error during scrape job ${currentJobId}: ${error.message}`;
    errorCategory = 'processing_error';
    logger.error(errorMessage, error); // Log the full error object
    jobStatus = 'failed'; // Ensure status is failed
  } finally {
    // 7. Close Browser
    await scraperInstance.closeBrowser();

    // 8. Update Final Job Status
    logger.info(`Updating job ${currentJobId} with final status: ${jobStatus}`);
    const finalUpdate = {
      status: jobStatus,
      progress: 100, // Mark as 100% done regardless of status
      error: errorMessage || null, // Store error message if any
      error_category: jobStatus === 'failed' ? errorCategory : null,
      result: jobResult, // Store success results if any
      updated_at: new Date().toISOString(),
    };

    try {
      await withTimeout(
        supabase.from('jobs').update(finalUpdate).eq('job_id', currentJobId),
        10000, 'Timeout updating final job status'
      );

      // Send Telegram notification for both success and failure
      await sendJobStatusReport(
        currentJobId,
        'scrape',
        jobStatus,
        {
          campaignId: jobParams?.campaignId,
          message: errorMessage || (jobResult ? jobResult.message : 'Job finished.'),
          savedCount: totalInserted,
          totalScraped,
          totalValid
        }
      );
    } catch (updateError) {
      logger.error(`Failed to update final status for job ${currentJobId}: ${updateError.message}`);
    }

    logger.info(`Finished processing job ${currentJobId}. Status: ${jobStatus}`);
  }
};


// Function to add a job to the queue
const addScrapeJob = async (req, res, supabase) => {
    const logger = createLogger();
    const { campaignId, searchUrl, lastPage } = req.body;

    if (!campaignId || !searchUrl || !lastPage) {
        return res.status(400).json({ success: false, error: 'Missing required fields: campaignId, searchUrl, or lastPage' });
    }
    if (!Number.isInteger(Number(lastPage)) || Number(lastPage) < 1) {
        return res.status(400).json({ success: false, error: 'lastPage must be a positive integer' });
    }

    const jobId = uuidv4();

    try {
        logger.info(`Received scrape request for campaignId: ${campaignId}, lastPage: ${lastPage}. Assigning Job ID: ${jobId}`);

        // Insert initial job record
        const { error: insertError } = await withTimeout(
            supabase.from('jobs').insert({
                job_id: jobId,
                type: 'scrape',
                status: 'queued',
                progress: 0,
                error: null,
                result: null,
                campaign_id: campaignId.toString(), // Ensure campaign_id is string
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            }),
            10000, 'Timeout creating initial job record'
        );

        if (insertError) {
            throw new Error(`Failed to create job record: ${insertError.message}`);
        }

        // Add job to the queue manager, passing jobParams correctly
        jobQueueManager.addJob(
            () => processJob(jobId, supabase, { lastPage, searchUrl, campaignId }), // Add campaignId to jobParams
            { jobId, type: 'scrape', campaignId }
        ).catch(err => {
             logger.error(`Queue processing failed for job ${jobId}: ${err.message}`);
             // Optionally update job status to failed here if queueing fails
        });

        logger.info(`Successfully created and queued job ${jobId} for campaign ${campaignId}.`);
        res.status(202).json({ success: true, message: 'Scrape job accepted and queued.', jobId });

    } catch (error) {
        logger.error(`Error adding scrape job for campaign ${campaignId}: ${error.message}`);
        res.status(500).json({ success: false, error: `Failed to queue scrape job: ${error.message}` });
    }
};

module.exports = { addScrapeJob }; // Only export addScrapeJob