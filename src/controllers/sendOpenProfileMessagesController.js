const createLogger = require('../utils/logger');
const { withTimeout } = require('../utils/databaseUtils');
const { hasDelayPassed } = require('../utils/dateUtils');
const messageOpenModule = require('../modules/messageOpen');
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
    // Retrieve message_stage from the result JSON
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

    const totalMessages = jobData.max_profiles; // Using max_profiles as totalMessages
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
        .select('client_id, cookies, open_profile_messages')
        .eq('id', campaignId)
        .single(),
      10000,
      'Timeout while fetching campaign data'
    );

    if (campaignError || !campaignData?.cookies || !campaignData?.open_profile_messages) {
      const msg = `Could not load campaign data (cookies or open_profile_messages) for campaign ${campaignId}`;
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
    const messages = campaignData.open_profile_messages?.messages || [];
    const messageTemplate = messages.find((msg) => msg.stage === messageStage);
    if (!messageTemplate) {
      const msg = `Message stage ${messageStage} not found in open_profile_messages for campaign ${campaignId}`;
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
      .select('id, first_name, last_name, company, linkedin, position, client_id, message_stage, last_contacted')
      .eq('client_id', campaignData.client_id)
      .eq('is_open_profile', true)
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
    messageSender = messageOpenModule();
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

        // Personalize the message
        const landingPageURL = constructURLWithSubdomain(lead, clientData, '?linkedin=true');
        let personalizedSubject = messageTemplate.subject
          .replace('{first_name}', lead.first_name ?? 'there')
          .replace('{last_name}', lead.last_name ?? '')
          .replace('{position}', lead.position ?? '')
          .replace('{company}', lead.company ?? 'your company')
          .replace('{landingpage}', landingPageURL);

        let personalizedContent = messageTemplate.content
          .replace('{first_name}', lead.first_name ?? 'there')
          .replace('{last_name}', lead.last_name ?? '')
          .replace('{position}', lead.position ?? '')
          .replace('{company}', lead.company ?? 'your company')
          .replace('{landingpage}', landingPageURL)
          .replace(/\\n/g, '\n');

        try {
          const result = await messageSender.sendMessage({
            leadUrl: lead.linkedin,
            message: {
              subject: personalizedSubject,
              content: personalizedContent,
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
                  result: {
                    totalMessagesRequested: totalMessages,
                    messagesSent,
                    failedMessages,
                    message_stage: messageStage,
                  },
                  updated_at: new Date().toISOString(),
                })
                .eq('job_id', currentJobId),
              10000,
              'Timeout while updating job status'
            );
            return;
          }
        }

        processedLeads++;
        const progress = processedLeads / totalLeads;
        await withTimeout(
          supabase
            .from('jobs')
            .update({
              status: 'in_progress',
              progress,
              updated_at: new Date().toISOString(),
            })
            .eq('job_id', currentJobId),
          10000,
          'Timeout while updating job progress'
        );

        // Small delay between messages within a batch
        if (batch.indexOf(lead) < batch.length - 1) {
          logger.info(`Waiting 1-2 seconds before the next message...`);
          await randomDelay(1000, 2000);
        }
      }

      // Delay between batches
      if (i + batchSize < filteredLeads.length) {
        logger.info(`Waiting 5-10 seconds before the next batch...`);
        await randomDelay(5000, 10000);
      }
    }

    logger.success(`Message sequence completed for job ${currentJobId}.`);
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'completed',
          progress: 1,
          result: {
            totalMessagesRequested: totalMessages,
            messagesSent,
            failedMessages,
            message_stage: messageStage,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', currentJobId),
      10000,
      'Timeout while updating job status'
    );
  } catch (error) {
    logger.error(`Error in job ${currentJobId}: ${error.message}`);
    let errorCategory = 'unknown';
    if (error.message.includes('Message button not found')) {
      errorCategory = 'message_button_not_found';
    } else if (error.message.includes('waitForSelector')) {
      errorCategory = 'selector_timeout';
    }
    await withTimeout(
      supabase
        .from('jobs')
        .update({
          status: 'failed',
          error: error.message,
          error_category: errorCategory,
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', currentJobId),
      10000,
      'Timeout while updating job status'
    );

    // Send Telegram notification for general failure
    await bot.sendMessage(
      process.env.TELEGRAM_NOTIFICATION_CHAT_ID,
      `❌ Message sequence failed for job ${currentJobId}: ${error.message}`
    );
  } finally {
    if (messageSender) {
      await messageSender.closeBrowser();
    }
  }
};

// Factory function pattern
module.exports = (supabase) => {
  return async (req, res) => {
    const logger = createLogger();

    let jobId = null;

    try {
      if (!req.body || typeof req.body !== 'object') {
        logger.warn('Request body is missing or invalid');
        return res.status(400).json({
          success: false,
          error: 'Request body is missing or invalid',
        });
      }

      const {
        campaignId,
        messageStage,
        totalMessages,
        batchSize = 5,
      } = req.body;

      if (!campaignId || !messageStage || !totalMessages) {
        logger.warn('Missing required fields: campaignId, messageStage, or totalMessages');
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: campaignId, messageStage, or totalMessages',
        });
      }

      if (!Number.isInteger(messageStage) || messageStage < 1) {
        logger.warn('Invalid messageStage: must be a positive integer');
        return res.status(400).json({
          success: false,
          error: 'Invalid messageStage: must be a positive integer',
        });
      }

      if (!Number.isInteger(totalMessages) || totalMessages < 1) {
        logger.warn('Invalid totalMessages: must be a positive integer');
        return res.status(400).json({
          success: false,
          error: 'Invalid totalMessages: must be a positive integer',
        });
      }

      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > totalMessages) {
        logger.warn('Invalid batchSize: must be a positive integer less than or equal to totalMessages');
        return res.status(400).json({
          success: false,
          error: 'Invalid batchSize: must be a positive integer less than or equal to totalMessages',
        });
      }

      logger.info(`Received request to send open profile messages for campaignId: ${campaignId}, stage: ${messageStage}`);

      // Create a job, storing message_stage in the result JSON
      const { data: jobData, error: jobError } = await withTimeout(
        supabase
          .from('jobs')
          .insert({
            type: 'send_open_profile_messages',
            status: 'started',
            progress: 0,
            error: null,
            result: { message_stage: messageStage }, // Store message_stage in result
            campaign_id: campaignId.toString(),
            max_profiles: totalMessages, // Using max_profiles as totalMessages
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
        logger.error(`Failed to create job: ${jobError?.message}`);
        return res.status(500).json({ success: false, error: 'Failed to create job' });
      }

      jobId = jobData.job_id;
      logger.info(`Created job with ID: ${jobId} with status: started`);

      res.json({ success: true, jobId });

      // Process the job asynchronously
      setImmediate(() => {
        processJob(jobId, supabase).catch((err) => {
          logger.error(`Background processing failed for job ${jobId}: ${err.message}`);
        });
      });
    } catch (error) {
      logger.error(`Error in /send-open-profile-messages route: ${error.message}`);
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