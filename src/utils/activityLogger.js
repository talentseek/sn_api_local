/**
 * Utility for consistent activity logging across the application
 */

/**
 * Log an activity in the campaign_activity_logs table
 * @param {Object} supabase - Supabase client instance
 * @param {number} campaignId - Campaign ID
 * @param {string} activityType - Type of activity ('connection_request', 'connection_check', 'message_send')
 * @param {string} status - Status of the activity ('running', 'success', 'failed')
 * @param {Object} counts - Count metrics for the activity
 * @param {number} counts.total - Total items processed
 * @param {number} counts.successful - Number of successful operations
 * @param {number} counts.failed - Number of failed operations
 * @param {string|null} error - Error message if any
 * @param {Object} details - Additional details about the activity
 */
async function logActivity(supabase, campaignId, activityType, status, counts = {}, error = null, details = {}) {
  try {
    const now = new Date().toISOString();
    const isRunning = status === 'running';

    const { data, error: logError } = await supabase
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
              new Date(now).getTime() - new Date(details.startTime).getTime() : null
          }
        }
      });

    if (logError) {
      console.error(`Error logging activity: ${logError.message}`);
    }

    return data;
  } catch (err) {
    console.error(`Failed to log activity: ${err.message}`);
    return null;
  }
}

module.exports = {
  logActivity
}; 