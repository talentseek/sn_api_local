/**
 * Job Queue Manager for sequential job processing
 * @module utils/jobQueueManager
 */

const createLogger = require('./logger');
const debugJobs = process.env.DEBUG_JOBS === 'true';

// Job types that can bypass the queue and run concurrently
const BYPASS_QUEUE_TYPES = ['check_cookies', 'telegram_command', 'system_task'];

/**
 * Manages a queue of jobs to be processed sequentially
 * @class JobQueueManager
 */
class JobQueueManager {
  /**
   * Create a new JobQueueManager
   */
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.activeJob = null; // Track only the currently active job
    this.logger = createLogger();
    this.logger.info('Job Queue Manager initialized');
  }

  /**
   * Add a job to the queue
   * @param {Function} jobFunction - The job function to execute
   * @param {Object} metadata - Metadata about the job (for logging and tracking)
   * @param {boolean} bypassQueue - Whether to bypass the queue (for system tasks)
   * @returns {Promise} - Resolves when the job is completed
   */
  addJob(jobFunction, metadata = {}, bypassQueue = false) {
    const { jobId = `job_${Date.now()}`, type = 'unknown', campaignId } = metadata;
    
    // Check if this job type should bypass the queue
    const shouldBypassQueue = bypassQueue || BYPASS_QUEUE_TYPES.includes(type);
    
    if (shouldBypassQueue) {
      this.logger.info(`Job ${jobId} of type ${type} is bypassing the queue`);
      // Execute immediately without queueing
      return Promise.resolve().then(() => jobFunction());
    }
    
    return new Promise((resolve, reject) => {
      // Check if a job is currently running
      if (this.isProcessing) {
        this.logger.info(`Job ${jobId} of type ${type} added to queue. Queue length: ${this.queue.length + 1}`);
        this.queue.push({
          jobFunction,
          metadata: { jobId, type, campaignId },
          resolve,
          reject
        });
      } else {
        // No job is running, start processing immediately
        this.logger.info(`No active job, starting job ${jobId} of type ${type} immediately`);
        this.queue.push({
          jobFunction,
          metadata: { jobId, type, campaignId },
          resolve,
          reject
        });
        this.processNextJob();
      }
    });
  }

  /**
   * Process the next job in the queue
   */
  async processNextJob() {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      this.activeJob = null;
      return;
    }

    this.isProcessing = true;
    const { jobFunction, metadata, resolve, reject } = this.queue.shift();
    const { jobId, type, campaignId } = metadata;
    
    try {
      // Mark this job as active
      this.activeJob = { jobId, type, campaignId };
      this.logger.info(`Processing job ${jobId} of type ${type} for campaign ${campaignId}. Remaining in queue: ${this.queue.length}`);
      
      // Execute the job
      const result = await jobFunction();
      resolve(result);
    } catch (error) {
      this.logger.error(`Error processing job ${jobId}: ${error.message}`);
      reject(error);
    } finally {
      // Clear active job
      this.activeJob = null;
      
      // Process the next job after a delay
      setTimeout(() => this.processNextJob(), 1000);
    }
  }

  getQueueStatus() {
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      activeJob: this.activeJob
    };
  }
}

// Singleton instance
const jobQueueManager = new JobQueueManager();

module.exports = jobQueueManager; 