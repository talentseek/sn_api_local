# LinkedIn Connection Request Status Checker

## Overview
The connection request status checker automatically verifies the status of previously sent connection requests on LinkedIn. It identifies which requests have been accepted, are still pending, or need to be resent. When connections are accepted, profiles are automatically moved to the leads table for further engagement.

## Features
- Prioritized checking based on last check timestamp
- Batch processing with configurable sizes
- Automatic lead creation/update for accepted connections
- Status tracking and detailed reporting
- Rate limiting with intelligent delays
- Error handling and recovery
- Telegram notifications for job status

## Database Status Values
The system uses the following status values in the `scraped_profiles` table:
- `pending`: Connection request sent and awaiting response
- `connected`: Connection request accepted
- `not sent`: Connection request needs to be resent

## Priority System
Profiles are checked in the following order:
1. Never checked profiles (`last_checked` is NULL)
2. Oldest checked profiles (ordered by `last_checked` ascending)
3. Limited by `maxProfiles` parameter

## API Endpoint
```http
POST /api/check-connection-requests
```

### Request Parameters
```json
{
  "campaignId": "integer (required)",
  "maxProfiles": "integer (default: 20)",
  "batchSize": "integer (default: 5)"
}
```

### Response
```json
{
  "success": true,
  "jobId": "uuid"
}
```

## Job Processing Flow
1. **Initialization**
   - Create job record in database
   - Fetch campaign data and cookies
   - Initialize browser with LinkedIn cookies

2. **Profile Selection**
   - Query pending profiles with priority ordering:
     - Profiles never checked (NULL last_checked)
     - Oldest checked profiles
   - Limit to specified maxProfiles

3. **Profile Processing**
   - Process profiles in batches
   - For each profile:
     - Check connection level on LinkedIn
     - Update status based on connection level:
       - 1st degree → 'connected'
       - 2nd degree → 'pending'
       - Other → 'not sent'
     - Update last_checked timestamp
     - Handle lead creation/update for accepted connections

4. **Lead Management**
   When a connection is accepted:
   - Check if lead exists
   - If exists: Update lead information
   - If new: Create lead record
   - Update scraped profile status to 'connected'

5. **Status Updates**
   - Track counts for:
     - Total profiles checked
     - Newly connected
     - Still pending
     - Failed checks
   - Update job progress

## Error Handling
- Invalid cookies: Mark job as failed with 'authentication_failed'
- Selector timeout: Mark job as failed with 'selector_timeout'
- Duplicate leads: Update existing lead information
- Network issues: Retry with delays
- Three consecutive failures: Stop job and notify

## Rate Limiting
- Delay between profiles: 1-2 seconds
- Delay between batches: 5-10 seconds
- Random delays to prevent detection

## Example Usage
```bash
curl -X POST http://localhost:8080/api/check-connection-requests \
-H "Content-Type: application/json" \
-d '{
  "campaignId": 16,
  "maxProfiles": 20,
  "batchSize": 5
}'
```

## Telegram Notifications
The system sends detailed notifications including:
```
✅ Job [job_id] (check_connection_requests) completed
Campaign: [campaign_id]

📊 Connection Check Results for Campaign [campaign_id]:
• Total Profiles Checked: [number]
• Still Pending: [number]
• Newly Connected: [number]
• Moved to Leads: [number]
[• Failed Checks: [number]
• Failed Profiles: [profile_ids]] (only if failures occurred)
```

## Best Practices
1. Start with small batches (5-10 profiles)
2. Use appropriate delays between checks
3. Monitor Telegram notifications
4. Check job logs for detailed information
5. Regular checking (e.g., every 24 hours)
6. Keep maxProfiles reasonable (20-50) to prevent rate limiting

## Database Schema Updates
The system requires the following columns in the `scraped_profiles` table:
- `last_checked`: TIMESTAMP WITH TIME ZONE
- `connection_status`: TEXT (not sent/pending/connected)
- `error`: TEXT (for storing error messages) 