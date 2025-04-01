# LinkedIn Connection Requests

## Overview
The connection request system allows automated sending of connection requests to LinkedIn profiles with personalized messages. The system handles various scenarios including pending requests, already connected profiles, and failed attempts.

## Features
- Batch processing of connection requests
- Personalized messages using profile data
- Rate limiting and delays between requests
- Status tracking and reporting
- Telegram notifications for job status
- Error handling and recovery

## Database Status Values
The system uses three status values for profiles in the database:
- `not sent`: Initial state or failed attempts
- `pending`: Connection request sent and awaiting response
- `connected`: Connection request accepted

## Message Personalization
Connection messages can be personalized using the following placeholders:
- `{first_name}`: Profile's first name
- `{last_name}`: Profile's last name
- `{company}`: Profile's company name
- `{job_title}`: Profile's job title
- `{linkedin}`: Profile's LinkedIn URL

## API Endpoint
```http
POST /api/send-connection-requests
```

### Request Parameters
```json
{
  "campaignId": "integer (required)",
  "maxProfiles": "integer (default: 20)",
  "batchSize": "integer (default: 5)",
  "delayBetweenBatches": "integer (default: 5000)",
  "delayBetweenProfiles": "integer (default: 5000)",
  "sendMessage": "boolean (default: true)"
}
```

### Response
```json
{
  "success": true,
  "message": "Connection requests job accepted and queued",
  "jobId": "string"
}
```

## Job Processing Flow
1. **Initialization**
   - Fetch campaign data and connection message template
   - Initialize browser with LinkedIn cookies
   - Get profiles to process from database

2. **Profile Processing**
   - Process profiles in batches
   - For each profile:
     - Validate LinkedIn URL
     - Personalize message if template exists
     - Send connection request
     - Update profile status in database
     - Apply delay between profiles

3. **Status Updates**
   - Track counts for:
     - Total processed
     - New sent
     - Already pending
     - Already connected
     - Following
     - Failed

4. **Reporting**
   - Send Telegram notification with job status
   - Include detailed statistics
   - Log completion or failure

## Error Handling
- Missing connection message template: Proceeds without message
- Invalid profile URLs: Marks as failed
- Browser errors: Closes browser and reports failure
- Database errors: Logs error and continues processing
- Network issues: Retries with delays

## Rate Limiting
- Delay between profiles: Configurable (default 5 seconds)
- Delay between batches: Configurable (default 5 seconds)
- Random delays added to prevent detection

## Example Usage
```bash
curl -X POST http://localhost:8080/api/send-connection-requests \
-H "Content-Type: application/json" \
-d '{
  "campaignId": 16,
  "maxProfiles": 3,
  "batchSize": 5,
  "delayBetweenBatches": 5000,
  "delayBetweenProfiles": 5000,
  "sendMessage": true
}'
```

## Telegram Notifications
The system sends notifications for:
- Job completion with statistics
- Job failures with error details
- Status updates during processing

## Best Practices
1. Start with small batches (3-5 profiles)
2. Use appropriate delays between requests
3. Monitor Telegram notifications for status
4. Check job logs for detailed information
5. Verify campaign has connection message template 