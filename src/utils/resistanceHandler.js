const createLogger = require('./logger');
const { withTimeout } = require('./databaseUtils');

const logger = createLogger();

class ResistanceHandler {
  constructor(supabase) {
    this.supabase = supabase;
    this.resistancePatterns = {
      CAPTCHA: /captcha|challenge|security check/i,
      RATE_LIMIT: /too many requests|rate limit|try again later/i,
      AUTHENTICATION: /sign in|login|authenticate|invalid cookie/i,
      SUSPICIOUS: /unusual activity|suspicious|automated/i
    };
  }

  /**
   * Calculate cooldown duration based on resistance type and history
   * @param {string} campaignId - Campaign ID
   * @param {string} resistanceType - Type of resistance detected
   * @returns {Promise<number>} Cooldown duration in milliseconds
   */
  async calculateCooldownDuration(campaignId, resistanceType) {
    try {
      // Get resistance history for the campaign in the last 24 hours
      const { data: history, error } = await withTimeout(
        this.supabase
          .from('campaign_activity_logs')
          .select('error_message, created_at')
          .eq('campaign_id', campaignId)
          .like('error_message', '%LinkedIn%')
          .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
          .order('created_at', { ascending: false }),
        10000,
        'Timeout while fetching resistance history'
      );

      if (error) {
        logger.error(`Error fetching resistance history: ${error.message}`);
        return 2 * 60 * 60 * 1000; // Default 2 hours
      }

      const incidentsLast24h = history?.length || 0;
      let baseDuration = 2 * 60 * 60 * 1000; // Base: 2 hours

      // Adjust duration based on resistance type
      switch (resistanceType) {
        case 'CAPTCHA':
          baseDuration = 3 * 60 * 60 * 1000; // 3 hours
          break;
        case 'RATE_LIMIT':
          baseDuration = 4 * 60 * 60 * 1000; // 4 hours
          break;
        case 'AUTHENTICATION':
          baseDuration = 1 * 60 * 60 * 1000; // 1 hour (might need manual intervention)
          break;
        case 'SUSPICIOUS':
          baseDuration = 6 * 60 * 60 * 1000; // 6 hours
          break;
      }

      // Increase duration based on incident frequency
      if (incidentsLast24h > 1) {
        baseDuration *= Math.min(incidentsLast24h, 4); // Max 4x multiplier
      }

      return baseDuration;
    } catch (error) {
      logger.error(`Error calculating cooldown duration: ${error.message}`);
      return 2 * 60 * 60 * 1000; // Default 2 hours
    }
  }

  /**
   * Detect resistance type from error message
   * @param {string} errorMessage - Error message to analyze
   * @returns {string|null} Resistance type or null if not detected
   */
  detectResistanceType(errorMessage) {
    for (const [type, pattern] of Object.entries(this.resistancePatterns)) {
      if (pattern.test(errorMessage)) {
        return type;
      }
    }
    return null;
  }

  /**
   * Handle LinkedIn resistance detection
   * @param {string} campaignId - Campaign ID
   * @param {string} errorMessage - Error message from LinkedIn
   * @returns {Promise<{cooldownDuration: number, cooldownUntil: Date}>}
   */
  async handleResistance(campaignId, errorMessage) {
    const resistanceType = this.detectResistanceType(errorMessage);
    if (!resistanceType) {
      return null;
    }

    const cooldownDuration = await this.calculateCooldownDuration(campaignId, resistanceType);
    const cooldownUntil = new Date(Date.now() + cooldownDuration);

    try {
      // Set cooldown in database
      await withTimeout(
        this.supabase
          .from('campaign_cooldowns')
          .upsert({
            campaign_id: campaignId,
            cooldown_until: cooldownUntil.toISOString(),
            resistance_type: resistanceType,
            updated_at: new Date().toISOString()
          }),
        10000,
        'Timeout while setting campaign cooldown'
      );

      logger.info(`Set ${cooldownDuration/3600000}h cooldown for campaign ${campaignId} due to ${resistanceType}`);
      
      return {
        cooldownDuration,
        cooldownUntil,
        resistanceType
      };
    } catch (error) {
      logger.error(`Error setting cooldown: ${error.message}`);
      throw error;
    }
  }
}

module.exports = ResistanceHandler; 