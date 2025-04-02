# LinkedIn Automation Documentation

This documentation covers the automated schedulers that manage LinkedIn connections and messaging.

## Schedulers

- [Send Connections Scheduler](send-connections-scheduler.md) - Sends connection requests to LinkedIn profiles
- [Check Connections Scheduler](check-connections-scheduler.md) - Monitors acceptance status of sent connection requests
- [Send Messages Scheduler](send-messages-scheduler.md) - Sends staged messages to accepted connections

## Common Features

All schedulers share these core features:

### Safety Measures
- Rate limiting and delays between actions
- Timezone-based scheduling
- Automatic cooldown on LinkedIn resistance
- Campaign-specific daily limits

### Activity Tracking
- Detailed logging in `campaign_activity_logs`
- Success/failure counts
- Error messages
- Timestamp information

### Telegram Notifications
- Real-time status updates
- Error reporting
- Daily limit notifications
- Resistance detection alerts

### Prerequisites
- Active campaign status
- Automation enabled
- Valid LinkedIn cookies
- Appropriate timezone settings

## Architecture

Each scheduler operates independently but shares common infrastructure:

1. **Job Queue**
   - Prevents overlapping runs
   - Manages resource contention
   - Handles retries and failures

2. **Activity Logger**
   - Centralized logging
   - Performance metrics
   - Error tracking
   - Audit trail

3. **Notification System**
   - Real-time Telegram updates
   - Configurable alert levels
   - Status reporting

4. **Safety Controls**
   - Rate limiting
   - Cooldown periods
   - Daily limits
   - Error backoff 