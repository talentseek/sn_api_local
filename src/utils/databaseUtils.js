const createLogger = require('./logger');

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

// Insert profiles into the scraped_profiles table, skipping duplicates
const insertScrapedProfiles = async (supabase, profiles) => {
  const scrapedToInsert = [];
  for (const profile of profiles) {
    const campaignId = parseInt(profile.campaign_id);
    const { data: existingScraped, error: scrapedCheckError } = await withTimeout(
      supabase
        .from('scraped_profiles')
        .select('id')
        .eq('campaign_id', campaignId)
        .eq('linkedin', profile.linkedin)
        .single(),
      10000,
      'Timeout while checking for existing scraped profile'
    );

    if (scrapedCheckError && scrapedCheckError.code !== 'PGRST116') {
      throw new Error(`Failed to check for existing scraped profile for ${profile.linkedin}: ${scrapedCheckError.message}`);
    }

    if (!existingScraped) {
      const [firstName, ...lastNameParts] = profile.full_name ? profile.full_name.split(' ') : ['', ''];
      const lastName = lastNameParts.join(' ');

      scrapedToInsert.push({
        campaign_id: campaignId,
        linkedin: profile.linkedin,
        first_name: firstName || '',
        last_name: lastName || '',
        job_title: profile.job_title,
        company: profile.company,
        companylink: profile.companyLink || profile.companylink,
        connection_level: profile.connection_level,
        connection_status: profile.connection_status || null,
        scraped_at: profile.scraped_at || new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
    } else {
      logger.info(`Skipping duplicate scraped profile for ${profile.linkedin} (campaign_id: ${campaignId})`);
    }
  }

  if (scrapedToInsert.length > 0) {
    const { error: scrapedInsertError } = await withTimeout(
      supabase.from('scraped_profiles').insert(scrapedToInsert),
      10000,
      'Timeout while inserting into scraped_profiles'
    );

    if (scrapedInsertError) {
      throw new Error(`Failed to insert into scraped_profiles: ${scrapedInsertError.message}`);
    }

    logger.info(`Inserted ${scrapedToInsert.length} profiles into scraped_profiles`);
  } else {
    logger.info('No new profiles to insert into scraped_profiles (all were duplicates)');
  }

  return scrapedToInsert.length;
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

module.exports = {
  insertLeads,
  insertScrapedProfiles,
  insertPremiumProfiles,
  withTimeout,
};