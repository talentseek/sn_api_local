/**
 * Utility for consistent activity logging across the application
 */

const { withTimeout } = require('./databaseUtils');
const createLogger = require('./logger');

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

/**
 * Sleep for specified milliseconds
 * @param {number} ms Milliseconds to sleep
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Validates activity log parameters
 * @param {Object} params Parameters to validate
 * @throws {Error} If validation fails
 */
const validateActivityParams = ({ campaignId, activityType, status, counts }) => {
  if (!campaignId || typeof campaignId !== 'number') {
    throw new Error('Invalid campaign ID');
  }

  const validActivityTypes = ['connection_request', 'connection_check', 'message_sent'];
  if (!validActivityTypes.includes(activityType)) {
    throw new Error(`Invalid activity type: ${activityType}`);
  }

  const validStatuses = ['running', 'success', 'failed'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  if (counts && typeof counts === 'object') {
    ['total', 'successful', 'failed'].forEach(key => {
      if (key in counts && (typeof counts[key] !== 'number' || counts[key] < 0)) {
        throw new Error(`Invalid ${key} count: ${counts[key]}`);
      }
    });
  }
};

/**
 * Log an activity in the campaign_activity_logs table with retries and validation
 * @param {Object} supabase - Supabase client instance
 * @param {number} campaignId - Campaign ID
 * @param {string} activityType - Type of activity ('connection_request', 'connection_check', 'message_sent')
 * @param {string} status - Status of the activity ('running', 'success', 'failed')
 * @param {Object} counts - Count metrics for the activity
 * @param {number} counts.total - Total items processed
 * @param {number} counts.successful - Number of successful operations
 * @param {number} counts.failed - Number of failed operations
 * @param {string|null} error - Error message if any
 * @param {Object} details - Additional details about the activity
 * @returns {Promise<Object>} Logged activity data
 * @throws {Error} If logging fails after all retries
 */
async function logActivity(supabase, campaignId, activityType, status, counts = {}, error = null, details = {}) {
  const logger = createLogger();
  
  try {
    // Validate parameters
    validateActivityParams({ campaignId, activityType, status, counts });

    const now = new Date().toISOString();
    const isRunning = status === 'running';
    
    let lastError = null;
    
    // Implement retry logic
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { data, error: logError } = await withTimeout(
          supabase
            .from('campaign_activity_logs')
            .insert({
              campaign_id: campaignId,
              activity_type: activityType,
              started_at: isRunning ? now : details.startTime || now,
              completed_at: isRunning ? null : now,
              status: status,
              total_processed: counts.total || 0,
              successful_count: counts.successful || 0,
              failed_count: counts.failed || 0,
              error_message: error,
              details: {
                ...details,
                performance: isRunning ? undefined : {
                  start_time: details.startTime || now,
                  end_time: now,
                  processing_time_ms: details.startTime ? 
                    new Date(now).getTime() - new Date(details.startTime).getTime() : null,
                  attempt: attempt
                }
              }
            })
            .select()
            .single(),
          10000,
          'Timeout while logging activity'
        );

        if (logError) {
          throw logError;
        }

        logger.info(`Successfully logged activity for campaign ${campaignId} (attempt ${attempt})`);
        return data;
      } catch (err) {
        lastError = err;
        logger.warn(`Activity logging attempt ${attempt} failed: ${err.message}`);
        
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY * attempt); // Exponential backoff
          continue;
        }
      }
    }

    // If we get here, all retries failed
    throw new Error(`Failed to log activity after ${MAX_RETRIES} attempts: ${lastError?.message}`);
  } catch (error) {
    logger.error(`Critical error in activity logging: ${error.message}`);
    throw error;
  }
}

module.exports = logActivity; 