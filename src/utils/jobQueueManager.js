/**
 * Job Queue Manager for sequential job processing
 * @module utils/jobQueueManager
 */

const createLogger = require('./logger');
const debugJobs = process.env.DEBUG_JOBS === 'true';

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
    this.logger = createLogger();
    this.logger.info('Job Queue Manager initialized');

    // Add a lock mechanism to prevent duplicate job execution
    this.jobLocks = new Map();
  }

  /**
   * Add a job to the queue
   * @param {Function} jobFunction - The job function to execute
   * @param {Object} jobData - Data about the job (for logging)
   * @param {boolean} bypassQueue - Whether to bypass the queue (for cookie checks)
   * @returns {Promise} - Resolves when the job is completed
   */
  addJob(jobFunction, jobData, bypassQueue = false) {
    const jobType = jobData.type || 'unknown';
    const jobId = jobData.jobId || `job_${Date.now()}`;
    
    this.logger.info(`Adding job to queue: ${jobId} (${jobType}), bypassQueue: ${bypassQueue}`);
    
    if (debugJobs) {
      this.logger.debug(`Job Queue State before adding ${jobId}:`);
      this.logger.debug(`- isProcessing: ${this.isProcessing}`);
      this.logger.debug(`- Queue length: ${this.queue.length}`);
      this.logger.debug(`- Active locks: ${Array.from(this.jobLocks.keys()).join(', ')}`);
    }
    
    // Check if this job is already being processed
    if (this.jobLocks.has(jobId)) {
      this.logger.warn(`Job ${jobId} (${jobType}) is already being processed. Skipping duplicate execution.`);
      return;
    }
    
    // Set a lock for this job
    this.jobLocks.set(jobId, true);
    
    return new Promise((resolve, reject) => {
      const job = {
        id: jobId,
        type: jobType,
        execute: jobFunction,
        resolve,
        reject,
        data: jobData,
      };

      // Cookie checks bypass the queue
      if (bypassQueue || jobType === 'check_cookies') {
        this.logger.info(`Bypassing queue for job ${job.id} (${job.type})`);
        this.executeJob(job);
      } else {
        this.queue.push(job);
        this.logger.info(`Job ${job.id} (${job.type}) added to queue. Queue length: ${this.queue.length}`);
        
        // Start processing if not already processing
        if (!this.isProcessing) {
          this.processNextJob();
        } else {
          this.logger.info(`Queue is already processing. Job ${job.id} will wait.`);
        }
      }
    });
  }

  /**
   * Process the next job in the queue
   */
  processNextJob() {
    if (this.queue.length === 0) {
      this.logger.info('No more jobs in queue');
      this.isProcessing = false;
      return;
    }

    if (this.isProcessing) {
      this.logger.info('Already processing a job, will process next job when current job completes');
      return;
    }

    this.isProcessing = true;
    const job = this.queue.shift();
    this.logger.info(`Processing job ${job.id} (${job.type}). Remaining jobs in queue: ${this.queue.length}`);
    
    this.executeJob(job)
      .finally(() => {
        // Add a small buffer time between jobs
        setTimeout(() => {
          this.isProcessing = false;
          this.logger.info(`Job ${job.id} (${job.type}) processing completed. Setting isProcessing to false.`);
          this.processNextJob();
        }, 2000); // 2 second buffer between jobs
      });
  }

  /**
   * Execute a job and handle its completion
   * @param {Object} job - The job to execute
   */
  async executeJob(job) {
    try {
      this.logger.info(`Executing job ${job.id} (${job.type})`);
      const result = await job.execute();
      this.logger.info(`Job ${job.id} (${job.type}) completed successfully`);
      job.resolve(result);
    } catch (error) {
      this.logger.error(`Job ${job.id} (${job.type}) failed: ${error.message}`);
      job.reject(error);
    } finally {
      // Wait a bit before processing the next job to ensure clean state
      setTimeout(() => {
        this.logger.info(`Job ${job.id} (${job.type}) processing completed. Setting isProcessing to false.`);
        this.isProcessing = false;
        
        // Release the lock
        this.jobLocks.delete(job.id);
        
        this.processNextJob();
      }, 2000);
    }
  }
}

// Singleton instance
const jobQueueManager = new JobQueueManager();

module.exports = jobQueueManager; 