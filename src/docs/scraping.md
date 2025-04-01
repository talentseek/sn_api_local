# LinkedIn Sales Navigator Scraping Documentation

## Overview
The scraping system is designed to extract profile information from LinkedIn Sales Navigator search results in a controlled, sequential manner. It uses Puppeteer for browser automation and implements a queue system to manage scraping jobs.

## Key Components

### 1. Job Queue Manager (`src/utils/jobQueueManager.js`)
- Manages a sequential queue of scraping jobs
- Ensures only one job runs at a time to prevent system overload
- Implements a 1-second buffer between jobs
- Bypasses queue for system tasks (check_cookies, telegram_command, system_task)

```javascript
// Example job addition
jobQueueManager.addJob(
    () => processJob(jobId, supabase, { lastPage, searchUrl, campaignId }),
    { jobId, type: 'scrape', campaignId }
);
```

### 2. Scraper Module (`src/modules/scraper.js`)
- Handles browser automation using Puppeteer
- Implements viewport and zoom settings for optimal scraping
- Extracts profile information from search results
- Validates scraped data before insertion

Key settings:
```javascript
viewport: {
    width: 3800,
    height: 4200,
    deviceScaleFactor: 4.5
},
zoom: {
    scale: 0.12,
    widthMultiplier: 1000,
    heightMultiplier: 1000
}
```

### 3. Database Integration
- Stores scraped profiles in the `scraped_profiles` table
- Handles duplicate detection and URL normalization
- Updates job status and statistics

## Workflow

1. **Job Initiation**
   - User submits scrape request
   - System creates job record in database
   - Job is added to queue manager

2. **Queue Processing**
   - Jobs are processed sequentially
   - Each job runs to completion before next starts
   - 1-second buffer between jobs

3. **Scraping Process**
   - Browser initialization with configured viewport/zoom
   - Navigation to search URL
   - Profile extraction from search results
   - Data validation and normalization

4. **Data Storage**
   - Valid profiles are inserted into database
   - Duplicate profiles are handled
   - Job statistics are updated

5. **Notification**
   - Telegram notifications for job completion/failure
   - Includes job statistics and error messages

## Database Schema

### scraped_profiles Table
```sql
- campaign_id (integer)
- linkedin (text)
- first_name (text)
- last_name (text)
- job_title (text)
- company (text)
- companylink (text)
- connection_level (text)
- connection_status (text)
- scraped_at (timestamp)
- created_at (timestamp)
```

## Error Handling
- Failed jobs are marked in database
- Error messages are logged
- Telegram notifications include error details
- Browser cleanup on failure

## Performance Considerations
- Sequential job processing prevents system overload
- Viewport and zoom settings optimized for data extraction
- Duplicate detection prevents redundant data
- Browser instance cleanup after each job

## Monitoring
- Job status tracking in database
- Queue status available via `getQueueStatus()`
- Telegram notifications for job events
- Detailed logging of scraping process

## Future Improvements
- Consider implementing retry mechanism for failed jobs
- Add rate limiting for API calls
- Implement proxy rotation if needed
- Add more detailed job statistics 