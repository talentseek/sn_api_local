const createLogger = require('./logger');
const { URL } = require('url');

const logger = createLogger();

// Utility to add timeouts to database operations
const withTimeout = (promise, timeoutMs, errorMessage) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    }),
  ]);
};

// Function to normalize LinkedIn profile URL (remove query params and trailing slash)
const normalizeLinkedInUrl = (urlString) => {
  if (!urlString) return null;
  try {
    const url = new URL(urlString);
    url.search = ''; // Remove query parameters
    let pathname = url.pathname;
    // Remove trailing slash if present
    if (pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    // Reconstruct the URL without query params and trailing slash
    return `${url.origin}${pathname}`;
  } catch (error) {
    logger.warn(`Failed to parse or normalize URL: ${urlString}. Error: ${error.message}`);
    // Return original string or null if parsing fails badly
    return urlString;
  }
};

// Insert profiles into the leads table, skipping duplicates
const insertLeads = async (supabase, profiles, clientId) => {
  const leadsToInsert = [];
  for (const profile of profiles) {
    const { data: existingLead, error: leadCheckError } = await withTimeout(
      supabase
        .from('leads')
        .select('id')
        .eq('client_id', clientId)
        .eq('linkedin', profile.linkedin)
        .single(),
      10000,
      'Timeout while checking for existing lead'
    );

    if (leadCheckError && leadCheckError.code !== 'PGRST116') { // PGRST116 means no rows found
      throw new Error(`Failed to check for existing lead for ${profile.linkedin}: ${leadCheckError.message}`);
    }

    if (!existingLead) {
      const [firstName, ...lastNameParts] = profile.full_name.split(' ');
      const lastName = lastNameParts.join(' ');

      // Log the value of is_open_profile before insertion
      logger.info(`Inserting lead for ${profile.linkedin}, is_open_profile: ${profile.is_open_profile}`);

      leadsToInsert.push({
        client_id: clientId,
        search_url_id: null,
        message_sequence_step_id: null,
        first_name: firstName || '',
        last_name: lastName || '',
        company: profile.company,
        linkedin: profile.linkedin,
        website: profile.website || null,
        position: profile.job_title,
        connection_level: profile.connection_level,
        companyLink: profile.companyLink,
        status: 'not_replied',
        is_duplicate: false,
        is_open_profile: profile.is_open_profile,
        is_premium_profile: true,
        message_sent: false,
        initial_message_sent_at: null,
        company_data: null,
        personalization: null,
        created_at: new Date().toISOString(),
      });
    } else {
      logger.info(`Skipping duplicate lead for ${profile.linkedin} (client_id: ${clientId})`);
    }
  }

  if (leadsToInsert.length > 0) {
    const { error: leadsInsertError } = await withTimeout(
      supabase.from('leads').insert(leadsToInsert),
      10000,
      'Timeout while inserting into leads'
    );

    if (leadsInsertError) {
      throw new Error(`Failed to insert into leads: ${leadsInsertError.message}`);
    }

    logger.info(`Inserted ${leadsToInsert.length} profiles into leads`);
  } else {
    logger.info('No new profiles to insert into leads (all were duplicates)');
  }

  return leadsToInsert.length;
};

/**
 * Inserts scraped profiles into the database, handling duplicates and normalizing URLs.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase - Supabase client instance
 * @param {Array<Object>} profiles - Array of profile objects scraped
 * @param {number} campaignId - The ID of the campaign
 * @returns {Promise<{savedCount: number, dbDuplicatesSkipped: number, errorCount: number, insertionError: Error|null}>} - Result counts
 */
const insertScrapedProfiles = async (supabase, profiles, campaignId) => {
  if (!profiles || profiles.length === 0) {
    logger.info('No profiles provided to insert into scraped_profiles.');
    return 0;
  }
  if (!campaignId) {
      logger.error('Campaign ID is required for inserting scraped profiles.');
      throw new Error('Campaign ID is required for inserting scraped profiles.');
  }

  logger.info(`Attempting to insert ${profiles.length} profiles for campaign ${campaignId} into scraped_profiles.`);

  const profilesToInsert = [];
  const seenLinks = new Set(); // Track links within this batch to avoid duplicates in the insert itself

  // Normalize URLs before checking duplicates and inserting
  const normalizedProfiles = profiles.map(profile => ({
      ...profile,
      linkedin: normalizeLinkedInUrl(profile.linkedin) // Normalize the URL
  })).filter(profile => profile.linkedin); // Filter out any profiles where normalization failed badly

  if (normalizedProfiles.length !== profiles.length) {
      logger.warn(`Filtered out ${profiles.length - normalizedProfiles.length} profiles due to invalid/unnormalizable profile links.`);
  }

  if (normalizedProfiles.length === 0) {
      logger.info('No valid profiles remaining after normalization.');
      return 0;
  }


  // Check for existing profiles in the database for this campaign
  const profileLinks = normalizedProfiles.map(p => p.linkedin);
  const { data: existingProfiles, error: fetchError } = await withTimeout(
      supabase
          .from('scraped_profiles')
          .select('linkedin')
          .eq('campaign_id', campaignId)
          .in('linkedin', profileLinks),
      15000, // Slightly longer timeout for potentially large IN query
      'Timeout while checking for existing scraped profiles'
  );

  if (fetchError) {
      logger.error(`Failed to check for existing scraped profiles: ${fetchError.message}`);
      throw new Error(`Database error checking duplicates: ${fetchError.message}`);
  }

  const existingLinks = new Set(existingProfiles.map(p => p.linkedin));
  logger.info(`Found ${existingLinks.size} existing profiles in DB for this batch.`);

  for (const profile of normalizedProfiles) {
    // Check if already exists in DB for this campaign OR already seen in this batch
    if (!existingLinks.has(profile.linkedin) && !seenLinks.has(profile.linkedin)) {
      // Map to the database schema - ensure field names match your table columns
      profilesToInsert.push({
        campaign_id: campaignId,
        linkedin: profile.linkedin, // Already normalized
        first_name: profile.first_name?.trim() || null,
        last_name: profile.last_name?.trim() || null,
        job_title: profile.job_title?.trim() || null,
        company: profile.company?.trim() || null,
        companylink: profile.companylink || null,
        connection_level: profile.connection_level || null,
        connection_status: 'not sent',
        scraped_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      });
      seenLinks.add(profile.linkedin); // Add to seen set for this batch
    } else {
       logger.info(`Skipping duplicate profile (already in DB or batch): ${profile.linkedin} for campaign ${campaignId}`);
    }
  }

  if (profilesToInsert.length > 0) {
    logger.info(`Attempting to insert ${profilesToInsert.length} new unique profiles into scraped_profiles.`);
    // Insert in smaller chunks if necessary, Supabase might have limits
    const chunkSize = 100; // Adjust as needed
    let insertedCount = 0;
    for (let i = 0; i < profilesToInsert.length; i += chunkSize) {
        const chunk = profilesToInsert.slice(i, i + chunkSize);
        const { error: insertError } = await withTimeout(
            supabase.from('scraped_profiles').insert(chunk),
            20000, // Timeout per chunk insert
           `Timeout while inserting chunk ${i / chunkSize + 1} into scraped_profiles`
        );

        if (insertError) {
            logger.error(`Failed to insert chunk into scraped_profiles: ${insertError.message}`);
            // Decide if you want to stop or continue with other chunks
            throw new Error(`Database insert error: ${insertError.message}`);
        }
        insertedCount += chunk.length;
    }

    logger.info(`Successfully inserted ${insertedCount} new profiles into scraped_profiles for campaign ${campaignId}.`);
    return insertedCount; // Return the count of successfully inserted profiles
  } else {
    logger.info('No new profiles to insert into scraped_profiles (all were duplicates or invalid).');
    return 0;
  }
};

// Insert profiles into the premium_profiles table, skipping duplicates
const insertPremiumProfiles = async (supabase, profiles) => {
  const profilesToInsert = [];
  for (const profile of profiles) {
    const campaignId = profile.campaign_id.toString(); // Ensure campaign_id is a string for premium_profiles
    const { data: existingProfile, error: profileCheckError } = await withTimeout(
      supabase
        .from('premium_profiles')
        .select('id')
        .eq('campaign_id', campaignId)
        .eq('linkedin', profile.linkedin)
        .single(),
      10000,
      'Timeout while checking for existing premium profile'
    );

    if (profileCheckError && profileCheckError.code !== 'PGRST116') {
      throw new Error(`Failed to check for existing premium profile for ${profile.linkedin}: ${profileCheckError.message}`);
    }

    if (!existingProfile) {
      profilesToInsert.push({
        campaign_id: campaignId,
        linkedin: profile.linkedin,
        full_name: profile.full_name,
        job_title: profile.job_title,
        company: profile.company,
        companyLink: profile.companyLink,
        connection_level: profile.connection_level,
        website: profile.website || null,
        company_data: profile.company_data || null,
        scraped_at: profile.scraped_at || new Date().toISOString(),
        is_open_profile: profile.is_open_profile || false,
        is_checked: profile.is_checked || false,
        moved_to_leads: profile.moved_to_leads || false,
        moved_to_scraped: profile.moved_to_scraped || false,
        error: profile.error || null,
      });
    } else {
      logger.info(`Skipping duplicate premium profile for ${profile.linkedin} (campaign_id: ${campaignId})`);
    }
  }

  if (profilesToInsert.length > 0) {
    const { error: profilesInsertError } = await withTimeout(
      supabase.from('premium_profiles').insert(profilesToInsert),
      10000,
      'Timeout while inserting into premium_profiles'
    );

    if (profilesInsertError) {
      throw new Error(`Failed to insert into premium_profiles: ${profilesInsertError.message}`);
    }

    logger.info(`Inserted ${profilesToInsert.length} profiles into premium_profiles`);
  } else {
    logger.info('No new profiles to insert into premium_profiles (all were duplicates)');
  }

  return profilesToInsert.length;
};

/**
 * Gets scraped profiles from the database for a specific campaign
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase - Supabase client instance
 * @param {number} campaignId - The ID of the campaign
 * @param {number} maxProfiles - Maximum number of profiles to fetch
 * @returns {Promise<Array>} Array of scraped profiles
 */
const getScrapedProfiles = async (supabase, campaignId, maxProfiles = 20) => {
  const { data: profiles, error } = await withTimeout(
    supabase
      .from('scraped_profiles')
      .select('*')
      .eq('campaign_id', campaignId.toString())
      .eq('connection_status', 'not sent')
      .limit(maxProfiles),
    10000,
    'Timeout while fetching scraped profiles'
  );

  if (error) {
    throw new Error(`Failed to fetch scraped profiles: ${error.message}`);
  }

  return profiles || [];
};

/**
 * Updates the connection status of a scraped profile
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase - Supabase client instance
 * @param {number} profileId - The ID of the profile to update
 * @param {string} status - The new connection status
 * @returns {Promise<void>}
 */
const updateScrapedProfile = async (supabase, profileId, status) => {
  const { error } = await withTimeout(
    supabase
      .from('scraped_profiles')
      .update({ connection_status: status })
      .eq('id', profileId),
    10000,
    'Timeout while updating scraped profile'
  );

  if (error) {
    throw new Error(`Failed to update scraped profile: ${error.message}`);
  }
};

/**
 * Updates the daily connection count for a campaign with proper validation
 * @param {string|number} campaignId - Campaign ID
 * @param {number} connectionsToAdd - Number of connections to add
 * @returns {Promise<Object>} Updated record
 */
const updateDailyConnectionCount = async (campaignId, connectionsToAdd = 0) => {
  const logger = createLogger();
  
  // Input validation
  if (!campaignId) throw new Error('Campaign ID is required');
  
  // Ensure campaignId is a number
  const campaignIdNum = parseInt(campaignId, 10);
  if (isNaN(campaignIdNum)) {
    throw new Error('Invalid campaign ID format');
  }
  
  // Validate connectionsToAdd
  if (typeof connectionsToAdd !== 'number' || connectionsToAdd < 0) {
    logger.warn(`Invalid connectionsToAdd value for campaign ${campaignId}: ${connectionsToAdd}`);
    connectionsToAdd = 0;
  }

  const today = new Date().toISOString().split('T')[0];
  
  try {
    // Use upsert to handle both insert and update cases
    const { data, error } = await withTimeout(
      supabase
        .from('daily_connection_tracking')
        .upsert(
          {
            campaign_id: campaignIdNum,
            date: today,
            connections_sent: connectionsToAdd,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          },
          {
            onConflict: 'campaign_id,date',
            target: ['connections_sent'],
            update: `connections_sent = COALESCE(daily_connection_tracking.connections_sent, 0) + EXCLUDED.connections_sent`
          }
        )
        .select()
        .single(),
      10000,
      'Timeout while updating daily connection count'
    );

    if (error) throw error;

    logger.info(`Updated daily connection count for campaign ${campaignIdNum}: ${data.connections_sent}`);
    return data;
  } catch (error) {
    logger.error(`Failed to update daily connection count for campaign ${campaignIdNum}: ${error.message}`);
    throw error;
  }
};

module.exports = {
  insertLeads,
  insertScrapedProfiles,
  insertPremiumProfiles,
  withTimeout,
  normalizeLinkedInUrl,
  getScrapedProfiles,
  updateScrapedProfile,
  updateDailyConnectionCount,
};