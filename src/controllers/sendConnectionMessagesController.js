const createLogger = require('../utils/logger');
const { withTimeout } = require('../utils/databaseUtils');
const { hasDelayPassed } = require('../utils/dateUtils');
const messageConnectionModule = require('../modules/messageConnection');
const { bot } = require('../telegramBot');

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

/**
 * Personalizes a message template with lead data and custom fields
 * @param {string} template - The message template
 * @param {Object} lead - The lead object
 * @param {string} landingPageURL - The landing page URL
 * @param {string} cpdLandingPageURL - The CPD landing page URL
 * @returns {string} - The personalized message
 */
const personalizeMessage = (template, lead, landingPageURL, cpdLandingPageURL) => {
  const logger = createLogger();
  
  // Replace basic placeholders
  let personalizedMessage = template
    .replace(/{first_name}/g, lead.first_name || 'there')
    .replace(/{last_name}/g, lead.last_name || '')
    .replace(/{company}/g, lead.company || 'your company')
    .replace(/{position}/g, lead.position || 'professional')
    .replace(/{landingpage}/g, landingPageURL)
    .replace(/{cpdlanding}/g, cpdLandingPageURL);
  
  // Parse personalization JSON safely
  let customFields = {};
  try {
    if (typeof lead.personalization === 'string' && lead.personalization) {
      logger.info(`Parsing personalization JSON for lead ${lead.id}: ${lead.personalization}`);
      customFields = JSON.parse(lead.personalization);
    } else if (typeof lead.personalization === 'object' && lead.personalization !== null) {
      logger.info(`Using personalization object for lead ${lead.id}`);
      customFields = lead.personalization;
    }
    
    // Log the parsed custom fields
    logger.info(`Custom fields for lead ${lead.id}: ${JSON.stringify(customFields)}`);
  } catch (error) {
    logger.error(`Error parsing personalization JSON for lead ${lead.id}: ${error.message}`);
  }
  
  // Replace custom field placeholders using the same pattern as your working code
  personalizedMessage = personalizedMessage.replace(/\{custom\.(.*?)\}/g, (match, key) => {
    return customFields[key] ?? match;
  });
  
  // Ensure \n renders as newlines
  personalizedMessage = personalizedMessage.replace(/\\n/g, '\n');
  
  return personalizedMessage;
};

// Random delay between min and max milliseconds
const randomDelay = (min, max) =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

// Process the job asynchronously
const processJob = async (currentJobId, supabase) => {
  const logger = createLogger();
  let messageSender = null;

  try {
    // Fetch job data
    const { data: jobData, error: jobFetchError } = await withTimeout(
      supabase
        .from('jobs')
        .select('*')
        .eq('job_id', currentJobId)
        .single(),
      10000,
      'Timeout while fetching job data'
    );

    if (jobFetchError || !jobData) {
      logger.error(`Failed to fetch job ${currentJobId}: ${jobFetchError?.message}`);
      return;
    }

    const campaignId = parseInt(jobData.campaign_id);
    const messageStage = jobData.result?.message_stage;
    if (!messageStage) {
      const msg = `Message stage not found in job ${currentJobId} result`;
      logger.error(msg);
      await withTimeout(
        supabase
          .from('jobs')
          .update({
            status: 'failed',
            error: msg,
            error_category: 'missing_message_stage',
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', currentJobId),
        10000,
        'Timeout while updating job status'
      );
      return;
    }

    const totalMessages = jobData.max_profiles;
    const batchSize = jobData.batch_size;

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

    // Get delay_days for the previous stage (if applicable)
    let delayDays = null;
    if (messageStage > 1) {
      const previousMessage = messages.find((msg) => msg.stage === messageStage - 1);
      delayDays = previousMessage?.delay_days || 0;
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
      .eq('connection_level', '1st') // Use connection_level instead of connection_status
      .eq('status', 'not_replied')
      .limit(totalMessages);

    if (messageStage === 1) {
      leadsQuery = leadsQuery
        .eq('message_sent', false)
        .is('message_stage', null);
    } else {
      leadsQuery = leadsQuery.eq('message_stage', messageStage);
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
      : leads.filter((lead) => hasDelayPassed(lead.last_contacted, delayDays));

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

            // Update the lead
            const { error: updateLeadError } = await withTimeout(
              supabase
                .from('leads')
                .update({
                  message_sent: true,
                  message_stage: messageStage + 1,
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
    const { error: updateJobError } = await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'completed',
          progress: messagesSent / totalLeads,
          result: {
            message: messagesSent > 0 ? 'Messages sent successfully' : 'No messages sent',
            message_stage: messageStage,
            total_messages: totalLeads,
            messages_sent: messagesSent,
            failed_messages: failedMessages,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', currentJobId),
      10000,
      'Timeout while updating job status'
    );

    if (updateJobError) {
      logger.error(`Failed to update job ${currentJobId} to completed: ${updateJobError.message}`);
    }
  } catch (error) {
    logger.error(`Failed to process job ${currentJobId}: ${error.message}`);
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'failed',
          error: error.message,
          error_category: 'job_processing_failed',
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', currentJobId),
      10000,
      'Timeout while updating job status'
    );
  }
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
      setImmediate(() => {
        processJob(jobId, supabase).catch((err) => {
          const logger = createLogger();
          logger.error(`Background processing failed for job ${jobId}: ${err.message}`);
        });
      });
    } catch (error) {
      const logger = createLogger();
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
      return res.status(500).json({ success: false, error: error.message });
    }
  };
};