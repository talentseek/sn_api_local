# Send Connections Scheduler

The send connections scheduler automates the process of sending connection requests to LinkedIn profiles. It operates on a timezone-based schedule to ensure requests are sent during appropriate business hours.

## Prerequisites

For a campaign to be processed by the scheduler:
- Campaign status must be `active`
- `automation_enabled` must be `true`
- `timezone` must be set to one of: 'Europe', 'North America', or 'Asia'
- Valid LinkedIn cookies must be present

## Time Windows

Requests are sent during specific time windows based on the campaign's timezone (all times in UK time):

- **Europe**: 7:00-10:00
- **North America**: 13:00-16:00
- **Asia**: 00:00-04:00

## Daily Limits and Safety

- Maximum 20 connection requests per campaign per day
- Requests are sent in batches of 5 profiles
- 5-second delay between batches
- 5-second delay between campaigns
- 2-hour cooldown period if LinkedIn resistance is detected

## Activity Tracking

All activities are logged in the `campaign_activity_logs` table with:
- `activity_type`: 'connection_request'
- Detailed success/failure counts
- Error messages if any
- Timestamp information

## Telegram Notifications

Notifications are sent for:
- Successful connection request batches
- Errors or failures
- Daily limit reached
- LinkedIn resistance detected

Example success notification:
```
✅ Connection requests sent for campaign 123 (Campaign Name)
📊 Results:
- Total processed: 5
- Successful: 4
- Failed: 1
- Remaining daily limit: 16
```

## Error Handling

- Automatic cooldown if LinkedIn resistance is detected
- Detailed error logging
- Campaign-specific cooldown periods
- Automatic retries on next scheduled run

## Schedule

The scheduler runs every hour but only processes campaigns if:
1. Current time is within the campaign's timezone window
2. Campaign is not in cooldown
3. Daily limit hasn't been reached
4. Previous run has completed 