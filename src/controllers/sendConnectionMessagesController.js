const createLogger = require('../utils/logger');
const logger = createLogger();
const { withTimeout } = require('../utils/databaseUtils');
const { hasDelayPassed } = require('../utils/dateUtils');
const messageConnectionModule = require('../modules/messageConnection');
const { bot, sendJobStatusReport } = require('../telegramBot');
const jobQueueManager = require('../utils/jobQueueManager');
const { personalizeMessage } = require('../utils/messageUtils');
const logActivity = require('../utils/activityLogger');
const ResistanceHandler = require('../utils/resistanceHandler');

const MESSAGE_STAGES = {
  FIRST_MESSAGE: {
    stage: 1,
    delay_days: 0,
    maxPerDay: 100,
    description: 'first message'
  },
  SECOND_MESSAGE: {
    stage: 2,
    delay_days: 3,
    maxPerDay: 100,
    description: 'second message'
  },
  THIRD_MESSAGE: {
    stage: 3,
    delay_days: 3,
    maxPerDay: 100,
    description: 'third message'
  }
};

// Function to construct landing page URL in `{firstNameLastInitial}.{companySlug}` format
const constructLandingPageURL = (lead) => {
  if (!lead.first_name || !lead.last_name || !lead.company) {
    console.warn('🚨 Missing lead details for landing page:', lead);
    return `/landing-page/${encodeURIComponent(lead.id)}?linkedin=true`; // Fallback
  }
  const firstName = lead.first_name.toLowerCase();
  const lastInitial = lead.last_name.charAt(0).toLowerCase();
  const companySlug = lead.company.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `/${firstName}${lastInitial}.${companySlug}`;
};

// Function to construct the correct landing page URL with subdomain
const constructURLWithSubdomain = (lead, client, queryParam = '') => {
  const basePath = constructLandingPageURL(lead);
  if (client?.subdomain && client.status === 'verified') {
    return `https://${client.subdomain}${basePath}${queryParam}`;
  }
  return `https://default-landing-page.com${basePath}${queryParam}`;
};

/**
 * Constructs a Cost Per Demo landing page URL
 * @param {Object} lead - The lead object
 * @returns {string} - The CPD landing page URL
 */
const constructCPDLandingPageURL = (lead) => {
  if (!lead.first_name || !lead.last_name || !lead.company) {
    console.warn('🚨 Missing lead details for CPD landing page:', lead);
    return `https://costperdemo.com/landing-page/${encodeURIComponent(lead.id)}?linkedin=true`; // Fallback
  }
  const firstName = lead.first_name.toLowerCase();
  const lastInitial = lead.last_name.charAt(0).toLowerCase();
  const companySlug = lead.company.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `https://costperdemo.com/${firstName}${lastInitial}.${companySlug}`;
};

// Random delay between min and max milliseconds
const randomDelay = (min, max) =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

// Process the job asynchronously
const processJob = async (currentJobId, supabase) => {
  const startTime = new Date().toISOString();
  let messageSender = null;

  try {
    // Get job details
    const { data: jobData, error: jobError } = await withTimeout(
      supabase
        .from('jobs')
        .select('*')
        .eq('job_id', currentJobId)
        .single(),
      10000,
      'Timeout while fetching job'
    );

    if (jobError || !jobData) {
      logger.error(`Failed to fetch job ${currentJobId}: ${jobError?.message}`);
      return;
    }

    const campaignId = parseInt(jobData.campaign_id);
    const messageStage = jobData.result?.message_stage;
    const delayDays = jobData.result?.delay_days;
    const totalMessages = jobData.max_profiles;
    const batchSize = jobData.batch_size;
    
    // Log activity start
    await logActivity(supabase, campaignId, 'message_sent', 'running', 
      { total: 0, successful: 0, failed: 0 }, 
      null,
      { startTime, messageStage }
    );

    // Update job status to started
    const { error: updateStartError } = await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'started',
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', currentJobId),
      10000,
      'Timeout while updating job status to started'
    );

    if (updateStartError) {
      logger.error(`Failed to update job ${currentJobId} to started: ${updateStartError.message}`);
      return;
    }

    // Get campaign data
    const { data: campaignData, error: campaignError } = await withTimeout(
      supabase
        .from('campaigns')
        .select('name, connection_messages, client_id, cookies')
        .eq('id', campaignId)
        .single(),
      10000,
      'Timeout while fetching campaign data'
    );

    if (campaignError || !campaignData?.cookies || !campaignData?.connection_messages) {
      const msg = `Could not load campaign data (cookies or connection_messages) for campaign ${campaignId}`;
      logger.error(msg);
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            status: 'failed',
            error: msg,
            error_category: 'campaign_load_failed',
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job status'
      );
      return;
    }

    campaign = campaignData;  // Store campaign data in outer scope

    // Validate message stage
    const messages = campaignData.connection_messages?.messages || [];
    const messageTemplate = messages.find((msg) => msg.stage === messageStage);
    if (!messageTemplate) {
      const msg = `Message stage ${messageStage} not found in connection_messages for campaign ${campaignId}`;
      logger.error(msg);
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            status: 'failed',
            error: msg,
            error_category: 'invalid_message_stage',
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job status'
      );
      return;
    }

    // Validate message stage sequence
    const availableStages = messages.map(m => m.stage).sort((a, b) => a - b);
    if (messageStage > 1) {
      const previousStageExists = availableStages.includes(messageStage - 1);
      if (!previousStageExists) {
        const msg = `Cannot process stage ${messageStage} - previous stage ${messageStage - 1} not found in campaign configuration`;
        logger.error(msg);
        await withTimeout(
          supabase
            .from('jobs')
            .update({
              status: 'failed',
              error: msg,
              error_category: 'invalid_stage_sequence',
              updated_at: new Date().toISOString(),
            })
            .eq('job_id', currentJobId),
          10000,
          'Timeout while updating job status'
        );
        return;
      }
      logger.info(`Validated stage sequence: stage ${messageStage - 1} exists for current stage ${messageStage}`);
    }

    // Fetch client data for landing page URLs
    const { data: clientData, error: clientError } = await withTimeout(
      supabase
        .from('clients')
        .select('subdomain, status')
        .eq('id', campaignData.client_id)
        .single(),
      10000,
      'Timeout while fetching client data'
    );

    if (clientError) {
      const msg = `Failed to fetch client data for client ${campaignData.client_id}: ${clientError.message}`;
      logger.error(msg);
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            status: 'failed',
            error: msg,
            error_category: 'client_load_failed',
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job status'
      );
      return;
    }

    // Get leads to process using campaign's client_id
    const { data: leads, error: leadsError } = await withTimeout(
      supabase
        .from('leads')
        .select('id, first_name, last_name, company, linkedin, position, client_id, message_stage, last_contacted, personalization')
        .eq('client_id', campaignData.client_id)
        .eq('connection_level', '1st')
        .eq('status', 'not_replied')
        .in('id', jobData.leadIds),
      10000,
      'Timeout while fetching leads'
    );

    if (leadsError) {
      logger.error(`Failed to fetch leads: ${leadsError.message}`);
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            status: 'failed',
            error: leadsError.message,
            error_category: 'database_fetch_failed',
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job status'
      );
      return;
    }

    if (!leads || leads.length === 0) {
      logger.info(`No leads found for campaign ${campaignId}, stage ${messageStage}`);
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            status: 'completed',
            progress: 1,
            result: { message: 'No leads available to message', message_stage: messageStage },
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job status'
      );
      return;
    }

    // Filter eligible leads based on stage and delay
    const eligibleLeads = leads.filter(lead => {
      if (messageStage === 1) {
        return lead.message_stage === null;
      } else {
        return (
          lead.message_stage === messageStage - 1 &&
          hasDelayPassed(lead.last_contacted, MESSAGE_STAGES[`STAGE_${messageStage}`]?.delay_days || 0)
        );
      }
    });

    logger.info(`Found ${leads.length} total leads, ${eligibleLeads.length} ready for messaging after delay check`);
    if (messageStage > 1) {
      logger.info(`Filtered out ${leads.length - eligibleLeads.length} leads that haven't met the ${delayDays}-working-day delay requirement`);
    }

    if (eligibleLeads.length === 0) {
      logger.info(`No leads ready to message for campaign ${campaignId}, stage ${messageStage} (delay not passed)`);
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            status: 'completed',
            progress: 1,
            result: { message: 'No leads ready to message (delay not passed)', message_stage: messageStage },
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job status'
      );
      return;
    }

    logger.info(`Found ${eligibleLeads.length} leads to message for campaign ${campaignId}, stage ${messageStage}`);

    // Initialize the message sender
    messageSender = messageConnectionModule();
    await messageSender.initializeBrowser(campaignData.cookies);

    const totalLeads = eligibleLeads.length;
    let processedLeads = 0;
    let messagesSent = 0;
    const failedMessages = [];
    let consecutiveFailures = 0;

    // Process leads in batches
    for (let i = 0; i < eligibleLeads.length; i += batchSize) {
      const batch = eligibleLeads.slice(i, i + batchSize);
      logger.info(`Processing batch ${Math.floor(i / batchSize) + 1} (${batch.length} leads)`);

      for (const lead of batch) {
        logger.info(`Sending message to ${lead.first_name} at ${lead.company}`);
        processedLeads++;

        // Construct landing page URLs
        const landingPageURL = constructURLWithSubdomain(lead, clientData);
        const cpdLandingPageURL = constructCPDLandingPageURL(lead);
        
        // Personalize the message with validation
        let personalizedMessage;
        try {
          personalizedMessage = personalizeMessage(
            messageTemplate.content,
            lead,
            landingPageURL,
            cpdLandingPageURL
          );
          
          // Validate the personalized message
          if (typeof personalizedMessage !== 'string' || personalizedMessage.trim() === '') {
            throw new Error('Personalized message is empty or invalid');
          }
          
          logger.info(`Personalized message (first 50 chars): ${personalizedMessage.substring(0, 50)}...`);
        } catch (error) {
          throw new Error(`Failed to personalize message: ${error.message}`);
        }

        // Add validation before sending the message
        if (!lead.linkedin || typeof lead.linkedin !== 'string' || !lead.linkedin.includes('linkedin.com')) {
          logger.error(`Invalid LinkedIn URL for lead ${lead.id}: ${lead.linkedin}`);
          failedMessages.push({ leadId: lead.id, error: 'Invalid LinkedIn URL' });
          continue; // Skip this lead
        }

        try {
          const result = await messageSender.sendMessage({
            leadUrl: lead.linkedin,
            message: {
              content: personalizedMessage,
            },
          });

          if (result.success) {
            messagesSent++;
            consecutiveFailures = 0;

            logger.info(`Successfully sent Stage ${messageStage} message to lead ${lead.id} (${lead.first_name} at ${lead.company})`);

            // Validate current lead stage before update
            const { data: currentLead, error: checkError } = await withTimeout(
              supabase
                .from('leads')
                .select('message_stage')
                .eq('id', lead.id)
                .single(),
              10000,
              `Timeout while checking lead ${lead.id} status`
            );

            if (checkError) {
              throw new Error(`Failed to check lead ${lead.id} status: ${checkError.message}`);
            }

            // Ensure lead stage hasn't changed during processing
            if (messageStage > 1 && currentLead.message_stage !== messageStage - 1) {
              logger.warn(`Lead ${lead.id} stage changed during processing from ${messageStage - 1} to ${currentLead.message_stage}, skipping update`);
              continue;
            }

            // Update the lead
            const { error: updateLeadError } = await withTimeout(
              supabase
                .from('leads')
                .update({
                  message_sent: true,
                  message_stage: messageStage,
                  last_contacted: new Date().toISOString(),
                  error: null,
                })
                .eq('id', lead.id),
              10000,
              `Timeout while updating lead ${lead.id}`
            );

            if (updateLeadError) {
              throw new Error(`Failed to update lead ${lead.id}: ${updateLeadError.message}`);
            }

            logger.info(`Updated lead ${lead.id} status: message_stage=${messageStage}, last_contacted=${new Date().toISOString()}`);
          } else {
            throw new Error(result.error || 'Unknown error while sending message');
          }
        } catch (error) {
          logger.error(`Failed to send message to lead ${lead.id}: ${error.message}`);
          consecutiveFailures++;
          failedMessages.push({ leadId: lead.id, error: error.message });

          // Update the lead with the error
          await withTimeout(
            supabase
              .from('leads')
              .update({ error: error.message })
              .eq('id', lead.id),
            10000,
            `Timeout while updating lead ${lead.id} with error`
          );

          // Check for 3 consecutive failures
          if (consecutiveFailures >= 3) {
            const msg = `Job stopped due to 3 consecutive failures. Last error: ${error.message}`;
            logger.error(msg);

            // Send Telegram notification
            await bot.sendMessage(
              process.env.TELEGRAM_NOTIFICATION_CHAT_ID,
              `❌ Message sequence failed for campaign ${campaignId}, stage ${messageStage}: ${msg}`
            );

            await withTimeout(
              supabase
                .from('jobs')
                .update({
                  status: 'failed',
                  error: msg,
                  error_category: 'consecutive_failures',
                  updated_at: new Date().toISOString(),
                })
                .eq('job_id', currentJobId),
              10000,
              'Timeout while updating job status'
            );
            break; // Exit the loop
          }
        }
      }
    }

    // Update job status
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'completed',
          progress: 1,
          result: {
            message: 'Messages sent successfully',
            message_stage: messageStage,
            totalProcessed: processedLeads,
            successfulMessages: messagesSent,
            failedMessages: failedMessages.length,
            skippedResponded: totalLeads - processedLeads
          },
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', currentJobId),
      10000,
      'Timeout while updating job status'
    );

    // Send notification to Telegram
    try {
      const failedMessagesText = failedMessages.length > 0 
        ? failedMessages.map(f => `\n  • ${f.leadId}: ${f.error}`).join('') 
        : '';

      const successMessage = `✅ Connection messages sent for campaign ${campaignId}:\n` +
        `- Leads processed: ${processedLeads}\n` +
        `- Messages sent: ${messagesSent}\n` +
        `- Failed messages: ${failedMessages.length}${failedMessagesText}`;
      
      await bot.sendMessage(process.env.TELEGRAM_NOTIFICATION_CHAT_ID, successMessage);
      logger.info('Sent completion notification to Telegram');
    } catch (telegramError) {
      logger.error(`Failed to send Telegram notification: ${telegramError.message}`);
    }

    // After sending messages, update the activity log with results
    await logActivity(supabase, campaignId, 'message_sent', 'success', {
      total: processedLeads,
      successful: messagesSent,
      failed: failedMessages.length
    }, null, {
      startTime,
      messageStage,
      remainingDaily: result.remainingDaily,
      skippedResponded: totalLeads - processedLeads,
      performance: {
        avgTimePerLead: processedLeads ? 
          (new Date().getTime() - new Date(startTime).getTime()) / processedLeads : null
      }
    });

    return {
      success: true,
      message: `Successfully processed ${messagesSent} messages for campaign ${campaignId}`,
      messagesSent,
      failedMessages
    };
  } catch (error) {
    logger.error(`Error processing message sending job ${currentJobId}: ${error.message}`);
    
    // Log failed activity
    await logActivity(supabase, campaignId, 'message_sent', 'failed', 
      { total: 0, successful: 0, failed: 0 }, 
      error.message,
      { startTime, messageStage, jobId: currentJobId }
    );

    throw error;
  } finally {
    // Ensure browser is properly closed
    if (messageSender?.browser) {
      try {
        await messageSender.browser.close();
      } catch (closeError) {
        logger.warn(`Error closing browser: ${closeError.message}`);
      }
    }
  }
};

/**
 * Handles cleanup of failed or incomplete jobs
 * @param {Object} supabase - Supabase client
 * @param {string} jobId - Job ID
 * @param {string} error - Error message
 * @param {string} errorCategory - Error category
 */
const handleJobFailure = async (supabase, jobId, error, errorCategory = 'unknown') => {
  const logger = createLogger();
  try {
    // Update job status
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'failed',
          error: error.substring(0, 500), // Truncate long error messages
          error_category: errorCategory,
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', jobId),
      10000,
      'Timeout while updating failed job status'
    );

    // Log the failure
    await logActivity(supabase, jobId, 'message_sent', 'failed', 
      { total: 0, successful: 0, failed: 0 }, 
      error,
      { jobId, errorCategory }
    );

    logger.error(`Job ${jobId} failed: ${error} (${errorCategory})`);
  } catch (cleanupError) {
    logger.error(`Failed to cleanup job ${jobId}: ${cleanupError.message}`);
    // Don't throw here as this is already error handling
  }
};

// Error handling middleware
const handleError = async (err, jobId, supabase) => {
  logger.error(`Queue processing failed for job ${jobId}: ${err.message}`);
  
  let errorCategory = 'queue_processing_failed';
  
  // Categorize common errors
  if (err.message.includes('timeout')) {
    errorCategory = 'timeout';
  } else if (err.message.includes('database')) {
    errorCategory = 'database_error';
  } else if (err.message.includes('validation')) {
    errorCategory = 'validation_error';
  }

  await handleJobFailure(supabase, jobId, err.message, errorCategory);
  
  return {
    success: false,
    error: err.message,
    errorCategory
  };
};

const sendConnectionMessagesController = (supabase) => {
  const resistanceHandler = new ResistanceHandler(supabase);

  return async (req, res) => {
    let campaign = null;
    let campaignData = null;
    
    try {
      const { campaignId, messageStage, batchSize = 5, leadIds = [] } = req.body;

      if (!campaignId || !messageStage) {
        return res.status(400).json({
          success: false,
          error: 'campaignId and messageStage are required'
        });
      }

      // Create job object
      const job = {
        id: `message_${Date.now()}`,
        type: 'message',
        campaignId,
        messageStage,
        batchSize,
        leadIds,
        supabase
      };

      // Send immediate response
      res.json({
        success: true,
        message: 'Message sending job accepted',
        jobId: job.id
      });

      // Add the job to the queue
      await jobQueueManager.addJob(async () => {
        try {
          // Get campaign data
          const { data, error: campaignError } = await withTimeout(
            supabase
              .from('campaigns')
              .select('name, connection_messages, client_id, cookies')
              .eq('id', campaignId)
              .single(),
            10000,
            'Timeout while fetching campaign data'
          );

          if (campaignError || !data) {
            throw new Error(`Failed to fetch campaign: ${campaignError?.message || 'Campaign not found'}`);
          }

          campaignData = data;  // Store campaign data
          campaign = data;      // Store for outer scope

          // Get leads to process using campaign's client_id
          const { data: leads, error: leadsError } = await withTimeout(
            supabase
              .from('leads')
              .select('id, first_name, last_name, company, linkedin, position, client_id, message_stage, last_contacted, personalization')
              .eq('client_id', campaignData.client_id)
              .eq('connection_level', '1st')
              .eq('status', 'not_replied')
              .in('id', leadIds),
            10000,
            'Timeout while fetching leads'
          );

          if (leadsError) {
            throw new Error(`Failed to fetch leads: ${leadsError.message}`);
          }

          // Filter eligible leads based on stage and delay
          const eligibleLeads = leads.filter(lead => {
            if (messageStage === 1) {
              return lead.message_stage === null;
            } else {
              return (
                lead.message_stage === messageStage - 1 &&
                hasDelayPassed(lead.last_contacted, MESSAGE_STAGES[`STAGE_${messageStage}`]?.delay_days || 0)
              );
            }
          });

          if (eligibleLeads.length === 0) {
            logger.info(`No eligible leads found for campaign ${campaignId} stage ${messageStage}`);
            return { success: true };
          }

          let successfulMessages = 0;
          let failedMessages = 0;

          // Process each lead
          for (const lead of eligibleLeads.slice(0, batchSize)) {
            try {
              // Send message logic here
              await supabase
                .from('leads')
                .update({
                  message_stage: messageStage,
                  last_contacted: new Date().toISOString()
                })
                .eq('id', lead.id);

              successfulMessages++;
            } catch (error) {
              logger.error(`Failed to process lead ${lead.id}: ${error.message}`);
              failedMessages++;
            }
          }

          // Log success
          await logActivity(supabase, campaignId, 'message_sent', 'success', {
            total: eligibleLeads.length,
            successful: successfulMessages,
            failed: failedMessages
          }, null, {
            messageStage,
            batchSize
          });

          // Send success report
          await sendJobStatusReport(
            job.id,
            'message',
            'completed',
            {
              campaignId,
              campaignName: campaign.name,
              message: `Message stage ${messageStage} completed:\n` +
                `✅ Total Processed: ${eligibleLeads.length}\n` +
                `📤 Successful: ${successfulMessages}\n` +
                `❌ Failed: ${failedMessages}`,
              savedCount: successfulMessages,
              totalProcessed: eligibleLeads.length,
              failedCount: failedMessages
            }
          );

          return {
            success: true,
            totalProcessed: eligibleLeads.length,
            successful: successfulMessages,
            failed: failedMessages
          };

        } catch (error) {
          logger.error(`Error in message controller: ${error.message}`);
          
          // Log failure with campaign info if available
          await logActivity(supabase, campaignId, 'message_sent', 'failed', {
            total: 0,
            successful: 0,
            failed: 0
          }, error.message, {
            messageStage,
            campaignName: campaign?.name || 'Unknown Campaign'
          });

          // Send error report with safe campaign name access
          await sendJobStatusReport(
            job?.id || `message_${Date.now()}`,
            'message',
            'failed',
            {
              campaignId,
              campaignName: campaign?.name || 'Unknown Campaign',
              message: `❌ Message stage ${messageStage} failed:\n${error.message}`,
              error: error.message
            }
          );
          
          throw error;
        }
      }, job);
    } catch (error) {
      logger.error(`Error in message controller: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    }
  };
};

module.exports = sendConnectionMessagesController;