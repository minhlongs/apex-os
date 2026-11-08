# D1 Metrics Monitoring & Alerting

## Overview

The D1 Metrics Monitoring system provides real-time visibility into Cloudflare D1 database performance, storage usage, and query patterns with automated alerting.

## Features

- **Storage Monitoring**: Track database file size, page count, and WAL size
- **Query Performance**: Monitor query duration, detect slow queries (>1s)
- **Row Scan Analysis**: Track rows scanned per query to identify inefficient queries
- **Automated Alerts**: Configurable thresholds with email/webhook notifications
- **Admin Dashboard**: Real-time monitoring dashboard at `/admin/monitoring`
- **Historical Data**: Store metrics history for trend analysis

## Metrics Collected

| Metric | Description | Threshold |
|--------|-------------|-----------|
| Storage Usage | Database size vs 10GB quota | >80% (critical) |
| Avg Query Duration | Average query execution time | >1000ms (warning) |
| Slow Query Count | Queries exceeding 1s | >10 per window (warning) |
| Avg Rows Scanned | Average rows scanned per query | >10000 (warning) |

## Setup

### 1. Run Database Migration

```bash
wrangler d1 execute apex-os-db --file src/database/migrations/005_d1_monitoring.sql
wrangler d1 execute apex-os-db --file src/database/migrations/009_evaluation_state_schema.sql
wrangler d1 execute apex-os-db --file src/database/migrations/012_alert_snoozes.sql
wrangler d1 execute apex-os-db --file src/database/migrations/012_alert_engine.sql
wrangler d1 execute apex-os-db --file src/database/migrations/012_business_alerting.sql
wrangler d1 execute apex-os-db --file src/database/migrations/013_alert_is_read.sql
wrangler d1 execute apex-os-db --file src/database/migrations/013_alert_history_fix.sql
wrangler d1 execute apex-os-db --file src/database/migrations/014_alerts_table.sql
```

This creates:
- `d1_metrics_history` - stored metrics snapshots
- `d1_slow_queries` - logged slow queries
- `d1_alert_configs` - alert rule configurations
- `d1_alert_history` - triggered alert records
- `alert_rules`, `circuit_breaker_state`, `evaluation_runs`, `rule_evaluation_history`, `evaluation_errors`, `alert_engine_metrics` - alert engine state and resilience tables
- `alerts`, `alert_snoozes`, `alert_history` - unified alert storage and snooze management
- `business_alert_configs`, `business_alert_history`, `alert_notification_log`, `webhook_failure_stats`, `payout_failure_stats`, `stellar_balance_history` - business alerting and telemetry tables

> **Cloudflare D1 Authorizer Note:** Remote Cloudflare D1 blocks `PRAGMA page_count`, `PRAGMA page_size`, and `PRAGMA wal_checkpoint(TRUNCATE)` with `SQLITE_AUTH`. `collectStorageMetrics` automatically falls back to reading `D1Result.meta.size_after` from `SELECT 1` (assuming 4096-byte SQLite pages).

### 2. Environment Variables

Configure alert notifications:

```bash
# Email alerts via Resend
RESEND_API_KEY=re_your_api_key
ALERT_EMAIL=admin@yourdomain.com

# Optional: Webhook alerts
ALERT_WEBHOOK_URL=https://your-webhook-url.com/alerts

# Optional: Slack alerts
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

### 3. Cron Schedule

The monitoring runs automatically every 30 minutes via cron:

```
*/30 * * * *
```

Configured in `wrangler.toml`:

```toml
[[triggers]]
crons = ["0 0 * * 0", "*/30 * * * *"]
```

## API Endpoints

### `GET /api/monitoring/d1`

Get current metrics and active alerts. Optionally trigger collection with `?run=true`.

```bash
# Fetch current status
curl https://apex-os.pages.dev/api/monitoring/d1

# Trigger manual collection
curl https://apex-os.pages.dev/api/monitoring/d1?run=true
```

Response:

```json
{
  "success": true,
  "data": {
    "storagePercentage": 45.2,
    "recentMetricsCount": 168,
    "activeAlertsCount": 0
  },
  "alerts": [
    {
      "id": "alert-id",
      "configName": "High Storage Usage",
      "severity": "critical",
      "metricType": "storage_usage",
      "currentValue": 85.5,
      "thresholdValue": 80,
      "triggeredAt": "2026-06-22T10:30:00Z"
    }
  ]
}
```

### `POST /api/monitoring/d1`

Run monitoring cycle or manage alerts.

```bash
# Run monitoring
curl -X POST https://apex-os.pages.dev/api/monitoring/d1

# Acknowledge alert
curl -X POST -H "Content-Type: application/json" \
  -d '{"action": "acknowledge", "alertId": "alert-id"}' \
  https://apex-os.pages.dev/api/monitoring/d1

# Resolve alert
curl -X POST -H "Content-Type: application/json" \
  -d '{"action": "resolve", "alertId": "alert-id"}' \
  https://apex-os.pages.dev/api/monitoring/d1
```

### `GET /api/monitoring/d1/config`

Get alert configurations.

### `GET /api/monitoring/d1/history?hours=24&limit=100`

Get historical metrics data.

### `GET /api/monitoring/d1/slow-queries?hours=24&limit=50`

Get recent slow queries log.

## Admin Dashboard

Access the monitoring dashboard at: `/admin/monitoring`

Features:
- Real-time metrics display
- Active alerts with acknowledge/resolve actions
- Alert configuration overview
- Auto-refresh every 60 seconds

## Instrumenting Queries

The monitoring system automatically collects query metrics through the global `queryMetricsCollector`. To instrument your API routes:

```typescript
import { executeMonitoredQuery, queryMetricsCollector } from '@/lib/monitoring';

// In your API handler:
const { result, metrics } = await executeMonitoredQuery<YourResultType>(
  DB,
  'SELECT * FROM your_table WHERE id = ?',
  [id],
  { endpointPath: request.url, userId: user?.id }
);

console.log(`Query took ${metrics.durationMs}ms, scanned ${metrics.rowsScanned} rows`);
```

Slow queries (default >1000ms) are automatically logged to `d1_slow_queries`.

## Alert Configurations

Default alerts are created on first run. View and manage configs:

```sql
SELECT * FROM d1_alert_configs WHERE is_enabled = 1;
```

Update thresholds:

```sql
UPDATE d1_alert_configs
SET threshold_value = 2000, -- 2 seconds
    updated_at = datetime('now')
WHERE id = 'alert-slow-query';
```

## Troubleshooting

### Migration already applied
If the migration fails because tables exist:
```bash
wrangler d1 execute apex-os-db --command "DROP TABLE IF EXISTS d1_metrics_history;"
# Re-run migration
```

### No alerts being sent
1. Check `RESEND_API_KEY` and `ALERT_EMAIL` are set
2. Verify cron is running: Check Cloudflare dashboard > Workers & Pages > Triggers
3. Check logs: `wrangler tail apex-os`

### High storage usage
Check current storage:
```bash
curl https://apex-os.pages.dev/api/monitoring/d1 | jq '.data'
```

Clean up metrics history (retain last 90 days):
```sql
DELETE FROM d1_metrics_history
WHERE timestamp < datetime('now', '-90 days');
```

## Maintenance

### Clearing Old Metrics

```sql
-- Keep last 90 days of metrics
DELETE FROM d1_metrics_history WHERE timestamp < datetime('now', '-90 days');

-- Archive old slow queries
-- (Consider exporting to R2 before deletion)
DELETE FROM d1_slow_queries WHERE logged_at < datetime('now', '-30 days');
```

### Resolving Stuck Alerts

If an alert condition clears but the alert remains active:

```sql
UPDATE d1_alert_history
SET status = 'resolved', resolved_at = datetime('now')
WHERE status = 'active' AND alert_config_id = 'alert-id';
```

## Architecture

```
┌─────────────────┐
│   Cron (30min)  │
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│  worker-wrapper.js  │
│  handleMonitoring   │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  d1-monitor.ts      │
│  - collectStorage() │───► PRAGMA page_count/page_size (local SQLite)
│                     │───► SELECT 1 + meta.size_after (remote D1 / SQLITE_AUTH)
│  - computeMetrics() │───► Query d1_slow_queries table
│  - evaluateAlerts() │
│  - sendNotifications│
└─────────┬───────────┘
          │
          ├─────────┬────────────┐
          ▼         ▼            ▼
    ┌─────────┐ ┌─────────┐ ┌─────────┐
    │ metrics │ │  slow   │ │ alerts │
    │ history │ │ queries │ │ history │
    └─────────┘ └─────────┘ └─────────┘

┌─────────────────────┐
│  executeMonitoredQuery │ (use in API routes)
│  - times queries     │
│  - logs slow (>1s)  │─────► d1_slow_queries
└─────────────────────┘
```

### Instrumenting API Routes

To capture slow query metrics, wrap your D1 queries:

```typescript
import { executeMonitoredQuery } from '@/lib/monitoring';

export async function GET() {
  const { result, metrics } = await executeMonitoredQuery(
    DB,
    'SELECT * FROM deals WHERE id = ?',
    [dealId],
    { endpointPath: request.url }
  );

  return NextResponse.json(result);
}
```

Slow queries (>1s) are automatically logged to `d1_slow_queries` and included in metrics.

## File Structure

```
src/
├── app/
│   ├── admin/
│   │   ├── layout.tsx          # Admin layout with auth
│   │   └── monitoring/
│   │       └── page.tsx        # Dashboard UI
│   └── api/
│       └── monitoring/
│           └── d1/
│               └── route.ts    # Monitoring API
├── lib/
│   └── monitoring/
│       └── d1-monitor.ts       # Core monitoring logic
├── database/
│   └── migrations/
│       └── 005_d1_monitoring.sql  # DB schema
└── types/
    └── d1.ts                   # D1 type definitions
```

## Next Steps

1. Consider adding alert suppression during maintenance windows
2. Add metrics export to external monitoring (Prometheus, Grafana)
3. Implement query pattern analysis for automatic index recommendations
4. Add storage growth forecasting
5. Integrate with Sentry for alert aggregation
