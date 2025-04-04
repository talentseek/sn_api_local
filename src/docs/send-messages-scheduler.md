# Send Messages Scheduler

The send messages scheduler automates the process of sending messages to 1st-level connections. It handles multiple message stages with different delays and limits, operating on a timezone-based schedule.

## Prerequisites

For a campaign to be processed by the scheduler:
- Campaign status must be `active`
- `automation_enabled` must be `true`
- `timezone` must be set to one of: 'Europe', 'North America', or 'Asia'
- Must have valid message templates for each stage

## Message Stages

### Stage 1 (First Message)
- Sent immediately after connection is accepted
- Maximum 20 messages per day
- No minimum delay required

### Stage 2 (Follow-up)
- Sent 3 working days after first message (excludes weekends)
- Maximum 15 messages per day
- Only sent if no response received

### Stage 3 (Final Follow-up)
- Sent 3 working days after second message (excludes weekends)
- Maximum 10 messages per day
- Only sent if no response received

## Time Windows

Messages are sent during specific windows based on the campaign's timezone (all times in UK time):

**Europe**:
- 7:00-8:00
- 8:00-9:00
- 9:00-10:00

**North America**:
- 13:00-14:00
- 14:00-15:00
- 15:00-16:00

**Asia**:
- 00:00-1:00
- 2:00-3:00
- 3:00-4:00

## Batch Processing

- Messages are sent in batches of 5
- 5-second delay between batches
- 5-second delay between message stages
- 5-second delay between campaigns
- 2-hour cooldown period if LinkedIn resistance is detected

## Activity Tracking

All activities are logged in the `campaign_activity_logs` table with:
- `activity_type`: 'message_send'
- `message_stage`: 1, 2, or 3
- Detailed success/failure counts
- Number of skipped leads (those who responded)
- Remaining daily limits
- Error messages if any

## Telegram Notifications

Notifications are sent for:
- Successful message batches
- Errors or failures
- Daily limits reached
- LinkedIn resistance detected

Example success notification:
```
✅ Sent first message for campaign 123 (Campaign Name)
📊 Results:
- Messages sent: 5
- Failed: 0
- Skipped (responded): 2
- Remaining daily limit: 15
```

## Error Handling

- Automatic cooldown if LinkedIn resistance is detected
- Detailed error logging
- Campaign-specific cooldown periods
- Automatic retries on next scheduled run

## Safety Measures

1. **Daily Limits**:
   - Stage 1: 20 messages
   - Stage 2: 15 messages
   - Stage 3: 10 messages
   - Prevents overwhelming LinkedIn's systems

2. **Response Checking**:
   - Skips leads who have responded
   - Prevents sending follow-ups unnecessarily
   - Maintains conversation authenticity

3. **Delay Enforcement**:
   - Strict minimum delays between message stages using working days (Monday-Friday)
   - Delays skip weekends and ensure next message falls on a working day
   - Helps maintain natural conversation flow
   - Reduces risk of being flagged as automated

4. **Overlapping Prevention**:
   - Lock mechanism prevents multiple instances
   - Ensures consistent state
   - Prevents duplicate messages

## Message Selection Logic

For each stage, the scheduler:
1. Checks if minimum delay has passed
2. Verifies no response has been received
3. Ensures daily limit hasn't been reached
4. Processes leads in order of connection acceptance
5. Skips leads marked as responded or invalid

## Schedule

The scheduler runs every hour but only processes campaigns if:
1. Current time is within a timezone window
2. Campaign is not in cooldown
3. Daily stage limits haven't been reached
4. Previous run has completed
5. There are eligible leads to message 