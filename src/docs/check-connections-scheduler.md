# Check Connections Scheduler

The check connections scheduler automates the process of checking the status of pending connection requests. It runs at fixed intervals throughout the day to monitor acceptance status.

## Prerequisites

For a campaign to be processed by the scheduler:
- Campaign status must be `active`
- `automation_enabled` must be `true`
- Must have pending connection requests to check

## Schedule Windows

Checks run at specific hours throughout the day (UK time):
- 06:00
- 09:00
- 12:00
- 15:00
- 18:00
- 21:00

## Profile Selection Logic

The scheduler prioritizes checking:
1. Profiles that have never been checked
2. Profiles not checked in the last 4 hours
3. Profiles with connection requests sent within the last 7 days
4. Maximum 20 profiles per run

## Batch Processing

- Processes profiles in batches of 5
- 5-second delay between batches
- 5-second delay between campaigns
- 2-hour cooldown period if LinkedIn resistance is detected

## Activity Tracking

All activities are logged in the `campaign_activity_logs` table with:
- `activity_type`: 'connection_check'
- Total profiles checked
- Number of accepted connections
- Number still pending
- Number not found
- Error messages if any

## Telegram Notifications

Notifications are sent for:
- Completed check batches
- Errors or failures
- LinkedIn resistance detected

Example success notification:
```
✅ Connection checks completed for campaign 123 (Campaign Name)
📊 Results:
- Total checked: 20
- Accepted: 5
- Still pending: 14
- Not found: 1
```

## Error Handling

- Automatic cooldown if LinkedIn resistance is detected
- Detailed error logging
- Campaign-specific cooldown periods
- Automatic retries on next scheduled run

## Safety Measures

1. **Minimum Check Interval**:
   - Won't check the same profile more than once every 4 hours
   - Helps prevent LinkedIn from detecting automated behavior

2. **Maximum Check Age**:
   - Only checks connection requests sent in the last 7 days
   - Older requests are considered expired

3. **Overlapping Prevention**:
   - Lock mechanism prevents multiple instances running simultaneously
   - Ensures consistent state and prevents resource conflicts

4. **Graceful Error Recovery**:
   - Failed checks are retried in the next scheduled run
   - Progressive backoff for problematic profiles 