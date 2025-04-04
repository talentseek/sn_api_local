const createLogger = require('../utils/logger');
const logger = createLogger();
const { withTimeout } = require('../utils/databaseUtils');
const { hasDelayPassed } = require('../utils/dateUtils');
const messageConnectionModule = require('../modules/messageConnection');
const { bot, sendJobStatusReport } = require('../telegramBot');
const jobQueueManager = require('../utils/jobQueueManager');
const { personalizeMessage } = require('../utils/messageUtils');
const { logActivity } = require('../utils/activityLogger');

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

    // Fetch campaign data
    const { data: campaignData, error: campaignError } = await withTimeout(
      supabase
        .from('campaigns')
        .select('client_id, cookies, connection_messages')
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

    // Fetch leads
    let leadsQuery = supabase
      .from('leads')
      .select('id, first_name, last_name, company, linkedin, position, client_id, message_stage, last_contacted, personalization')
      .eq('client_id', campaignData.client_id)
      .eq('connection_level', '1st')
      .eq('status', 'not_replied')
      .limit(totalMessages);

    if (messageStage === 1) {
      leadsQuery = leadsQuery
        .eq('message_sent', false)
        .is('message_stage', null);
      logger.info(`Fetching Stage 1 leads with no previous messages sent`);
    } else {
      leadsQuery = leadsQuery.eq('message_stage', messageStage - 1);
      logger.info(`Fetching leads for Stage ${messageStage} (looking for leads with message_stage=${messageStage - 1})`);
    }

    const { data: leads, error: fetchError } = await withTimeout(
      leadsQuery,
      10000,
      'Timeout while fetching leads'
    );

    if (fetchError) {
      logger.error(`Failed to fetch leads: ${fetchError.message}`);
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            status: 'failed',
            error: fetchError.message,
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

    // Filter leads based on delay (for stages > 1)
    const filteredLeads = messageStage === 1
      ? leads
      : leads.filter((lead) => {
          // Additional validation for lead stage progression
          if (lead.message_stage !== messageStage - 1) {
            logger.warn(`Lead ${lead.id} has incorrect message_stage ${lead.message_stage}, expected ${messageStage - 1}`);
            return false;
          }
          
          // Use hasDelayPassed to check working days delay with the delay passed from scheduler
          const hasDelay = hasDelayPassed(lead.last_contacted, delayDays);
          if (!hasDelay) {
            logger.info(`Lead ${lead.id} hasn't met the ${delayDays} working days delay requirement (last contacted: ${lead.last_contacted})`);
          }
          return hasDelay;
        });

    logger.info(`Found ${leads.length} total leads, ${filteredLeads.length} ready for messaging after delay check`);
    if (messageStage > 1) {
      logger.info(`Filtered out ${leads.length - filteredLeads.length} leads that haven't met the ${delayDays}-working-day delay requirement`);
    }

    if (filteredLeads.length === 0) {
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

    logger.info(`Found ${filteredLeads.length} leads to message for campaign ${campaignId}, stage ${messageStage}`);

    // Initialize the message sender
    messageSender = messageConnectionModule();
    await messageSender.initializeBrowser(campaignData.cookies);

    const totalLeads = filteredLeads.length;
    let processedLeads = 0;
    let messagesSent = 0;
    const failedMessages = [];
    let consecutiveFailures = 0;

    // Process leads in batches
    for (let i = 0; i < filteredLeads.length; i += batchSize) {
      const batch = filteredLeads.slice(i, i + batchSize);
      logger.info(`Processing batch ${Math.floor(i / batchSize) + 1} (${batch.length} leads)`);

      for (const lead of batch) {
        logger.info(`Sending message to ${lead.first_name} at ${lead.company}`);
        processedLeads++;

        // Construct landing page URLs
        const landingPageURL = constructURLWithSubdomain(lead, clientData);
        const cpdLandingPageURL = constructCPDLandingPageURL(lead);
        
        // Personalize the message
        const personalizedMessage = personalizeMessage(
          messageTemplate.content,
          lead,
          landingPageURL,
          cpdLandingPageURL
        );

        // Add validation before sending the message
        if (!lead.linkedin || typeof lead.linkedin !== 'string' || !lead.linkedin.includes('linkedin.com')) {
          logger.error(`Invalid LinkedIn URL for lead ${lead.id}: ${lead.linkedin}`);
          failedMessages.push({ leadId: lead.id, error: 'Invalid LinkedIn URL' });
          continue; // Skip this lead
        }

        try {
          // Ensure the message content is properly formatted as a string
          if (!personalizedMessage || typeof personalizedMessage !== 'string') {
            logger.warn(`Invalid message format for lead ${lead.id}: ${typeof personalizedMessage}`);
            personalizedMessage = personalizedMessage?.toString() || "Hi, I'd like to connect with you.";
          }

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

// Error handling middleware
const handleError = async (err, jobId, supabase) => {
  logger.error(`Queue processing failed for job ${jobId}: ${err.message}`);
  try {
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'failed',
          error: err.message,
          error_category: 'queue_processing_failed',
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', jobId),
      10000,
      'Timeout while updating job status'
    );
  } catch (updateError) {
    logger.error(`Failed to update job status: ${updateError.message}`);
  }
  return {
    success: false,
    error: err.message
  };
};

module.exports = (supabase) => {
  return async (req, res) => {
    let jobId = null;
    try {
      // Validate request body
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
          success: false,
          error: 'Request body is missing or invalid',
        });
      }

      const { campaignId, messageStage = 1, batchSize = 10 } = req.body;

      if (!campaignId) {
        return res.status(400).json({
          success: false,
          error: 'campaignId is required',
        });
      }

      // Create a job record
      const { data: jobData, error: jobError } = await withTimeout(
        supabase
          .from('jobs')
          .insert({
            status: 'started',
            type: 'send_connection_messages',
            error: null,
            result: { message_stage: messageStage },
            campaign_id: campaignId.toString(),
            batch_size: batchSize,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select('job_id')
          .single(),
        10000,
        'Timeout while creating job in database'
      );

      if (jobError || !jobData) {
        return res.status(500).json({ success: false, error: 'Failed to create job' });
      }

      jobId = jobData.job_id;
      
      res.json({ success: true, jobId });

      // Process the job asynchronously
      jobQueueManager.addJob(
        () => processJob(jobId, supabase),
        { jobId, type: 'send_connection_messages', campaignId }
      ).catch(err => {
        handleError(err, jobId, supabase);
      });

    } catch (error) {
      logger.error(`Error in /send-connection-messages route: ${error.message}`);
      if (jobId) {
        await withTimeout(
          supabase
            .from('jobs')
            .update({
              status: 'failed',
              error: error.message,
              error_category: 'request_validation_failed',
              updated_at: new Date().toISOString(),
            })
            .eq('job_id', jobId),
          10000,
          'Timeout while updating job status'
        );
      }

      // Log failed activity
      await logActivity(supabase, campaignId, 'message_sent', 'failed', 
        { total: 0, successful: 0, failed: 0 }, 
        error.message,
        { startTime: new Date().toISOString(), messageStage, jobId }
      );

      return res.status(500).json({ success: false, error: error.message });
    }
  };
};