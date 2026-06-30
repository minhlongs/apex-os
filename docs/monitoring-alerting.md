# Error Monitoring & Alerting

This document describes the error tracking setup and alert configuration for ApexOS.

## Overview

**Error Tracking:** Sentry (sentry.io)
- Captures client-side JavaScript errors
- Captures server-side API exceptions
- Performance monitoring with traces
- Source maps for production debugging

**Infrastructure Monitoring:** Cloudflare Pages Analytics
- Edge runtime metrics
- Request rate and error rate
- Latency percentiles

## Setup

### 1. Create Sentry Project

1. Go to [sentry.io](https://sentry.io) and create an account
2. Create a new project: **Next.js** platform
3. Copy the DSN (Data Source Name)

### 2. Configure Environment Variables

Set these in Cloudflare Pages Dashboard → Project → Settings → Environment Variables:

```bash
# Required
NEXT_PUBLIC_SENTRY_DSN=https://your-key@o0.ingest.sentry.io/0
SENTRY_ORG=your-org-slug
SENTRY_PROJECT=apex-os
SENTRY_ENVIRONMENT=production

# Optional
NEXT_PUBLIC_SENTRY_ENABLED=true
```

### 3. Deploy with Source Maps

Sentry is configured in `next.config.js` to:
- Upload source maps during production build
- Set `productionBrowserSourceMaps: true`
- Enable JavaScript and Web Vitals instrumentation

Source maps allow Sentry to show original TypeScript code instead of minified bundle.

## Alert Configuration

### Error Rate Alert (>1%)

1. In Sentry, go to your project → **Alerts** → **Create Alert Rule**
2. Select **Metric Alert**
3. Configure:
   - **Name:** `High Error Rate (>1%)`
   - **Threshold:** `greater than 1%`
   - **Time window:** `5 minutes`
   - **Environment:** `production`
   - **Filters:**
     - `event.type:error`
   - **Aggregation:** `percentage of events that are errors`

4. Notification channels:
   - Email (primary)
   - Slack/Discord webhook (optional)
   - PagerDuty for critical (optional)

### Additional Recommended Alerts

| Alert Name | Threshold | Description |
|------------|-----------|-------------|
| Spike in Errors | 10 errors in 5 min | Sudden increase in error count |
| New Error Type | Any new `type` | Detect new error patterns |
| Performance Degradation | P95 > 2s | Slow transactions |
| Unhandled Promise Rejections | > 5/min | Client-side issues |
| 5xx Rate | > 5% of requests | Server failures |

## Manual Error Capture

```typescript
import { captureException, captureMessage, addBreadcrumb } from '@/lib/error-tracking';

// Capture an error with context
try {
  await processPayouts();
} catch (error) {
  captureException(error, {
    userId: user.id,
    payoutBatch: batchId,
  });
}

// Log a message
captureMessage('Payout batch completed', 'info');

// Add breadcrumb for debugging
addBreadcrumb('payout', 'Starting weekly payout run', { batchSize: 150 });
```

## User Context

Set user info for better error grouping:

```typescript
import { setUserContext, clearUserContext } from '@/lib/error-tracking';

// After login
setUserContext({
  id: user.id,
  email: user.email,
  walletAddress: user.walletAddress,
});

// On logout
clearUserContext();
```

## API Route Integration

Wrap API handlers with `withErrorTracking`:

```typescript
import { withErrorTracking, createErrorResponse } from '@/lib/error-tracking';

export const GET = withErrorTracking(async (req: NextRequest) => {
  const data = await fetchSomething();
  return NextResponse.json(data);
});

export const POST = withErrorTracking(async (req: NextRequest) => {
  const body = await req.json();
  if (!body.amount) {
    return createErrorResponse('Amount required', 400);
  }
  // ... handler logic
});
```

## Performance Monitoring

Sentry automatically tracks:
- Page load performance (Web Vitals)
- API request durations
- Database queries (when instrumented)

To add custom spans:

```typescript
import { startSpan } from '@/lib/error-tracking';

const result = await startSpan('calculate-earnings', 'earnings.calculator', (span) => {
  // Your computation
  span.setData('conversions', 150);
  span.setData('commission', 1234.56);
  return earnings;
});
```

## Cloudflare Analytics Integration

For infrastructure-level metrics, configure Cloudflare Pages Analytics:

1. Enable Pages Analytics in Cloudflare dashboard
2. Use API token with `Account.Cloudflare Pages Read` and `Account.Analytics Read`
3. Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`

## Monitoring Dashboard

Create a dashboard combining:
- Sentry error rate and volume
- Cloudflare Pages metrics (requests, errors, latency)
- Application-specific metrics (payouts, conversions, active users)

## Incident Response

When an alert triggers:

1. **Check Sentry** for the specific error
2. **Identify the deployment** (Sentry tags: environment, release)
3. **Rollback** if needed via Cloudflare Pages
4. **Create incident** in your tracking system
5. **Post-mortem** after resolution

## Data Retention

- Sentry: Free tier keeps data for 90 days
- Cloudflare Analytics: 30 days standard

Consider exporting critical metrics for long-term storage if needed.
