# LinkedIn Connection Messages

## Overview
The connection messages system automatically sends follow-up messages to 1st-degree connections on LinkedIn. It supports multi-stage messaging sequences with configurable delays between stages, ensuring proper timing and personalization of each message.

## Features
- Multi-stage message sequences
- Configurable delays between message stages
- Personalized messages using profile data
- Batch processing with rate limiting
- Status tracking and reporting
- Telegram notifications for job status
- Error handling and recovery

## Message Stages
The system supports multiple message stages with configurable delays:
- Stage 1: Initial follow-up after connection (message_stage = null)
- Stage 2: First follow-up (message_stage = 1, indicating Stage 1 message was sent)
- Stage 3: Final follow-up (message_stage = 2, indicating Stage 2 message was sent)
- Each stage can have unique message templates
- Delays are enforced between stages using working days (Monday-Friday)
- A 3 working day delay means the next message will be sent after 3 business days, excluding weekends
- If a delay would end on a weekend, the message is scheduled for the next working day (Monday)

## Message Stage Progression
1. New lead starts with message_stage = null
2. After Stage 1 message sent → message_stage = 1
3. After Stage 2 message sent → message_stage = 2
4. After Stage 3 message sent → message_stage = 3

The message_stage value indicates the most recently sent message stage.

## API Endpoint
```http
POST /api/send-connection-messages
```

### Request Parameters
```json
{
  "campaignId": "integer (required)",
  "messageStage": "integer (default: 1)",
  "batchSize": "integer (default: 5)"
}
```

### Response
```json
{
  "success": true,
  "jobId": "string"
}
```

## Job Processing Flow
1. **Initialization**
   - Create job record in database
   - Fetch campaign data and message templates
   - Initialize browser with LinkedIn cookies
   - Validate message template for specified stage

2. **Lead Selection**
   - Query leads based on:
     - Connection level (1st connections only)
     - Message stage
     - Last contacted date (respecting delay_days)
     - Reply status (not_replied)

3. **Message Processing**
   - Process leads in batches
   - For each lead:
     - Navigate to profile
     - Click message button
     - Type personalized message
     - Send message
     - Update lead status and last_contacted
     - Apply delay between messages

4. **Status Updates**
   - Track counts for:
     - Total leads processed
     - Messages sent
     - Failed messages
   - Update job progress

## Message Personalization
Messages can include the following placeholders:
- `{first_name}`: Lead's first name
- `{last_name}`: Lead's last name
- `{company}`: Lead's company name
- `{job_title}`: Lead's job title
- `{landing_page}`: Personalized landing page URL
- `{cpd_landing_page}`: CPD landing page URL

## Error Handling
- Invalid message template: Job fails with template_error
- Browser/navigation errors: Retry with delays
- Message sending failures: Logged and reported
- Rate limiting: Built-in delays between actions
- Three consecutive failures: Stop job and notify

## Rate Limiting
- Delay between messages: 2-4 seconds
- Delay between batches: 5-10 seconds
- Random delays to prevent detection
- Configurable batch sizes

## Example Usage
```bash
curl -X POST http://localhost:8080/api/send-connection-messages \
-H "Content-Type: application/json" \
-d '{
  "campaignId": 31,
  "messageStage": 1,
  "batchSize": 5
}'
```

## Telegram Notifications
The system sends detailed notifications including:
```
✅ Connection messages sent for campaign [campaign_id]:
- Leads processed: [number]
- Messages sent: [number]
- Failed messages: [number]
  • [lead_id]: [error_message] (if any failures)
```

## Best Practices
1. Start with small batches (3-5 leads)
2. Use appropriate delays between stages (remember these are working days)
3. Test message templates before running jobs
4. Monitor Telegram notifications
5. Check job logs for detailed information
6. Keep message content professional and relevant
7. Respect LinkedIn's messaging guidelines
8. Regular monitoring of response rates
9. Plan message sequences considering working day delays (e.g., a 3-day delay sent on Wednesday will be delivered on Monday)

## Troubleshooting
### Common Issues
1. **Message Button Not Found**
   - System will retry with different selectors
   - Logs will show actual page state
   - May indicate profile UI changes

2. **Rate Limiting**
   - Built-in delays prevent most cases
   - System backs off on consecutive failures
   - Job stops after three consecutive failures

3. **Message Verification**
   - System verifies message sent successfully
   - Checks for textarea state changes
   - Logs detailed page state information

### Debug Information
The system logs detailed information about:
- Page state before/after actions
- Element presence and state
- Message sending attempts
- Lead processing status

## Database Schema Requirements
The system requires the following in the leads table:
- `last_contacted`: TIMESTAMP WITH TIME ZONE
- `message_stage`: INTEGER
- `status`: TEXT (not_replied/replied)
- `connection_level`: TEXT (must be '1st') 