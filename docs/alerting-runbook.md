# Alerting System Runbook

**Last Updated:** 2026-06-23  
**Version:** 1.0.0  
**Audience:** Operations team, Admin users, On-call engineers

---

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Alert Rules Reference](#alert-rules-reference)
4. [Notification Channels](#notification-channels)
5. [Response Procedures](#response-procedures)
6. [Escalation Matrix](#escalation-matrix)
7. [Snooze Management](#snooze-management)
8. [Configuration Management](#configuration-management)
9. [Troubleshooting](#troubleshooting)
10. [Maintenance](#maintenance)
11. [Testing and Validation](#testing-and-validation)
12. [Incident Review](#incident-review)

---

## Overview

The ApexOS alerting system provides real-time monitoring of database performance, business metrics, and system health. It supports multi-channel notifications, snooze management, and comprehensive alert lifecycle tracking.

### Key Features

- **Multi-source monitoring:** D1 database, business metrics, system health
- **Three severity levels:** Critical, Warning, Info
- **Four alert states:** Active, Acknowledged, Resolved, Snoozed
- **Multiple notification channels:** Email (Resend), Slack, Telegram
- **Admin dashboard:** Full alert management UI
- **Cron-based evaluation:** Every 5 minutes

### Alert Lifecycle

```
┌─────────────┐
│  Evaluation │ ──┐
└─────────────┘   │
                  ▼
            ┌─────────────┐
            │   Triggered │
            └──────┬──────┘
                   │
            ┌──────▼────────────────┐
            │      ACTIVE           │
            │   (notification sent) │
            └──────┬────────────────┘
         Acknowledge│  │Resolve
                   │  │
                   ▼  ▼
            Snooze    Resolved ──┐
                   │              │
                   ▼              │
            ┌─────────────┐      │
            │   SNOOZED   │◀─────┘
            │ (duration)  │
            └──────┬──────┘
                   │ expiry
                   ▼
            ┌─────────────┐
            │   RE-ACTIVE │
            └─────────────┘
```

---

## System Architecture

### Components

| Component | Path | Purpose |
|-----------|------|---------|
| Alert Engine | `src/lib/monitoring/alert-engine.ts` | Evaluates metrics against rules, triggers alerts |
| D1 Monitor | `src/lib/monitoring/d1-monitor.ts` | Collects D1 database metrics |
| Notification Service | `src/lib/notifications/index.ts` | Routes alerts to configured channels |
| Storage Layer | `src/lib/monitoring/alert-storage.ts` | Persists alerts and snoozes in D1 |
| API Routes | `src/app/api/monitoring/` | REST endpoints for alert management |
| Types | `src/types/business-alerting.ts` | TypeScript definitions |

### Data Flow

1. **Metrics Collection** (on-demand or cron)
   - `d1-monitor.ts` queries D1 for performance metrics
   - Business metrics from aggregated data
   - System health from Cloudflare Workers API

2. **Alert Evaluation**
   - `alert-engine.ts` loads enabled alert configs
   - Evaluates each rule against current metrics
   - Creates new alerts when thresholds breached

3. **Notification Dispatch**
   - Checks if alert is snoozed
   - Sends to all enabled notification channels
   - Implements rate limiting and retry logic

4. **Alert Storage**
   - Persists alerts to D1 `monitoring_alerts` table
   - Records notification delivery status
   - Supports historical analysis

### Database Schema

```sql
-- Alert configurations
CREATE TABLE alert_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  metric_name TEXT NOT NULL,
  condition TEXT NOT NULL, -- 'gt', 'lt', 'eq', 'gte', 'lte'
  threshold REAL NOT NULL,
  severity TEXT NOT NULL, -- 'critical', 'warning', 'info'
  is_enabled BOOLEAN DEFAULT true,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Active alerts
CREATE TABLE monitoring_alerts (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  metric_value REAL,
  threshold_value REAL,
  status TEXT DEFAULT 'active', -- 'active', 'acknowledged', 'resolved', 'snoozed'
  acknowledged_by TEXT,
  resolved_at DATETIME,
  acknowledged_at DATETIME,
  snoozed_until DATETIME,
  snooze_reason TEXT,
  notification_sent BOOLEAN DEFAULT false,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (config_id) REFERENCES alert_configs(id)
);

-- Snooze overrides
CREATE TABLE alert_snoozes (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (config_id) REFERENCES alert_configs(id)
);

-- Notification delivery tracking
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  channel TEXT NOT NULL, -- 'email', 'slack', 'telegram'
  status TEXT NOT NULL, -- 'pending', 'sent', 'failed'
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  sent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (alert_id) REFERENCES monitoring_alerts(id)
);
```

---

## Alert Rules Reference

### D1 Database Alerts

#### alert-slow-query

| Property | Value |
|----------|-------|
| **ID** | `alert-slow-query` |
| **Name** | Slow Query |
| **Description** | Average query duration exceeds 1 second |
| **Metric** | `avg_query_duration_ms` |
| **Condition** | Greater than 1000ms |
| **Severity** | Warning |
| **Typical Causes** | Missing indexes, full table scans, complex joins |
| **Investigation** | Run `EXPLAIN QUERY PLAN` on slow queries, check `slow_query_log` |
| **Resolution** | Add composite indexes, optimize query, consider materialized views |

#### alert-storage

| Property | Value |
|----------|-------|
| **ID** | `alert-storage` |
| **Name** | High Storage |
| **Description** | D1 database storage usage exceeds threshold |
| **Metric** | `storage_usage_percent` |
| **Condition** | Greater than or equal to 80% |
| **Severity** | Critical |
| **Typical Causes** | Data growth, log accumulation, missing cleanup jobs |
| **Investigation** | Check largest tables: `SELECT name FROM sqlite_master ORDER BY length(sql) DESC` |
| **Resolution** | Archive old data, increase D1 quota, implement data retention policies |

#### alert-slow-count

| Property | Value |
|----------|-------|
| **ID** | `alert-slow-count` |
| **Name** | Excessive Slow Queries |
| **Description** | More than 10 slow queries in the evaluation period |
| **Metric** | `slow_query_count` |
| **Condition** | Greater than 10 |
| **Severity** | Warning |
| **Typical Causes** | Multiple queries degrading simultaneously |
| **Investigation** | Query `slow_query_log` for patterns, identify hotspots |
| **Resolution** | Address root queries, add missing indexes, optimize batch operations |

#### alert-rows-scanned

| Property | Value |
|----------|-------|
| **ID** | `alert-rows-scanned` |
| **Name** | High Row Scan |
| **Description** | Average rows scanned per query exceeds threshold |
| **Metric** | `avg_rows_scanned` |
| **Condition** | Greater than 10000 |
| **Severity** | Warning |
| **Typical Causes** | Queries without proper WHERE clauses, missing indexes |
| **Investigation** | Enable D1 query diagnostics, identify high-scan queries |
| **Resolution** | Add indexes, rewrite queries, use covering indexes |

### Business Alerts

#### biz-revenue-drop

| Property | Value |
|----------|-------|
| **ID** | `biz-revenue-drop` |
| **Name** | Revenue Drop |
| **Description** | Daily revenue falls below $100 |
| **Metric** | `daily_revenue` |
| **Condition** | Less than 100 |
| **Severity** | Warning |
| **Typical Causes** | Low trading volume, conversion issues, exchange API problems |
| **Investigation** | Check conversion counts, verify exchange webhooks, review deal performance |
| **Resolution** | Restore webhook connectivity, verify exchange status, contact exchange support |

#### biz-conversion-rate-low

| Property | Value |
|----------|-------|
| **ID** | `biz-conversion-rate-low` |
| **Name** | Low Conversion Rate |
| **Description** | Conversion rate below 2% |
| **Metric** | `conversion_rate` |
| **Condition** | Less than 0.02 |
| **Severity** | Warning |
| **Typical Causes** | Poor deal quality, tracking issues, user experience problems |
| **Investigation** | Analyze click-to-conversion funnel, check deal click-through rates |
| **Resolution** | Improve deal listings, fix tracking bugs, enhance user onboarding |

#### biz-zero-conversions

| Property | Value |
|----------|-------|
| **ID** | `biz-zero-conversions` |
| **Name** | No Conversions |
| **Description** | Zero conversions recorded in the evaluation period |
| **Metric** | `total_conversions` |
| **Condition** | Equals 0 |
| **Severity** | Critical |
| **Typical Causes** | Webhook failures, exchange API issues, conversion pipeline broken |
| **Investigation** | Check webhook logs, test exchange connectivity, verify conversion processing |
| **Resolution** | Fix webhook endpoints, restore API credentials, restart cron jobs |

#### biz-high-commission-liability

| Property | Value |
|----------|-------|
| **ID** | `biz-high-commission-liability` |
| **Name** | High Commission Liability |
| **Description** | Pending commission exceeds $10,000 |
| **Metric** | `pending_commission` |
| **Condition** | Greater than or equal to 10000 |
| **Severity** | Warning |
| **Typical Causes** | High conversion volume, delayed payouts, cash flow management |
| **Investigation** | Review pending earnings table, verify payout schedule |
| **Resolution** | Process payouts promptly, adjust commission rates, plan cash reserves |

#### biz-stellar-balance-low

| Property | Value |
|----------|-------|
| **ID** | `biz-stellar-balance-low` |
| **Name** | Low Stellar Balance |
| **Description** | Stellar USDC balance below 100 tokens |
| **Metric** | `stellar_balance` |
| **Condition** | Less than 100 |
| **Severity** | Critical |
| **Typical Causes** | Insufficient funding, failed top-ups, payout errors |
| **Investigation** | Check Stellar wallet balance, review recent transactions |
| **Resolution** | Top up balance, investigate payout failures, verify wallet access |

---

## Notification Channels

### Configuration

All notification channels are configured via environment variables. See [Environment Variables](#environment-variables) section for complete list.

### Email (Resend)

**Prerequisites:**
- Resend API key with credits
- Verified sender domain

**Setup:**
1. Get API key from [resend.com](https://resend.com)
2. Set `RESEND_API_KEY` in Cloudflare Pages environment
3. Verify domain and set `RESEND_FROM_EMAIL`
4. Configure recipients in `NOTIFICATION_EMAIL_RECIPIENTS`

**Email Template:**
```
Subject: [ApexOS Alert] {severity} - {alert_name}

Alert: {alert_name}
Severity: {severity}
Status: {status}
Triggered: {triggered_at}

Details:
{details}

View Dashboard: https://your-app.com/admin/alerts

---
This is an automated message from ApexOS monitoring.
```

### Slack

**Prerequisites:**
- Slack workspace with incoming webhook
- Channel for alerts

**Setup:**
1. Create Slack app at [api.slack.com](https://api.slack.com)
2. Add "Incoming Webhooks" feature
3. Create webhook for `#alerts` channel
4. Set `SLACK_WEBHOOK_URL` environment variable
5. Optional: Set `SLACK_CHANNEL` for channel override

**Slack Message Format:**
```json
{
  "channel": "#alerts",
  "username": "ApexOS Bot",
  "icon_emoji": ":rocket:",
  "attachments": [
    {
      "color": "danger",
      "fields": [
        { "title": "Alert", "value": "Slow Query", "short": true },
        { "title": "Severity", "value": "Critical", "short": true },
        { "title": "Metric", "value": "avg_query_duration_ms: 2500ms", "short": false }
      ]
    }
  ]
}
```

### Telegram

**Prerequisites:**
- Telegram bot with API token
- Chat IDs for recipients

**Setup:**
1. Create bot via [@BotFather](https://t.me/botfather)
2. Get bot token
3. Add bot to target chat/group
4. Get chat ID (use @getidsbot or API)
5. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_IDS`

**Telegram Message Format:**
```
🚨 *ApexOS Alert*

*Alert:* Slow Query
*Severity:* 🔴 Critical
*Metric:* avg_query_duration_ms = 2500ms
*Threshold:* > 1000ms
*Time:* 2026-06-23 14:30:00 UTC

[View Dashboard](https://your-app.com/admin/alerts)
```

### Channel Priority

All enabled channels receive alerts simultaneously. There is no priority ordering.

**Rate Limiting:**
- Default: 1 notification per minute per channel
- Configurable via `NOTIFICATION_RATE_LIMIT`
- Burst handling: Exponential backoff with `NOTIFICATION_RETRY_BACKOFF`
- Max retries: `NOTIFICATION_MAX_RETRIES` (default: 3)

---

## Response Procedures

### Standard Response Workflow

1. **Acknowledge** - Mark alert as acknowledged in dashboard
2. **Investigate** - Use diagnostic tools and runbooks
3. **Remediate** - Apply fix or workaround
4. **Resolve** - Mark alert resolved in system
5. **Document** - Add notes about cause and resolution

### Investigation Checklist

- [ ] Check monitoring dashboard for related metrics
- [ ] Review recent deployments/changes (`git log --oneline -10`)
- [ ] Examine logs for errors/warnings (`wrangler tail`)
- [ ] Query database for performance issues (`EXPLAIN QUERY PLAN`)
- [ ] Verify external dependencies (exchanges, APIs)
- [ ] Test user-facing functionality
- [ ] Check alert history for recurrence

### Severity-Specific Procedures

#### Critical Alerts

1. **Immediate Actions (0-15 min):**
   - Acknowledge alert in dashboard
   - Check incident runbook for known issues
   - Notify engineering lead
   - Begin incident response protocol
   - Provide status updates every 30 minutes

2. **Investigation:**
   - Determine scope of impact
   - Check if automated rollback possible
   - Review recent deployments for correlation
   - Examine system logs for error patterns

3. **Resolution:**
   - Apply fix or rollback
   - Verify fix resolves issue
   - Monitor for recurrence (minimum 30 min)
   - Resolve alert with detailed notes

#### Warning Alerts

1. **Actions (within 4 business hours):**
   - Acknowledge alert
   - Schedule investigation during business hours
   - Create follow-up task if root cause not immediately fixable

2. **Investigation:**
   - Analyze trend data
   - Identify contributing factors
   - Plan mitigation or fix

3. **Resolution:**
   - Apply configuration changes or code fixes
   - Document findings
   - Resolve alert with notes

#### Info Alerts

1. **Review (next business day):**
   - Review for emerging patterns
   - Adjust thresholds if needed
   - Document if recurring

---

## Escalation Matrix

| Alert Type | Time Without Acknowledge | Escalation Action |
|------------|-------------------------|-------------------|
| Critical | 15 minutes | Page on-call engineer |
| Critical | 1 hour | Notify CTO via SMS/Phone |
| Warning | 4 hours | Notify engineering lead |
| Warning | 24 hours | Create ticket, schedule review meeting |
| Recurring (3+ of same type in 24h) | Any | Escalate to CTO regardless of severity |

### On-Call Responsibilities

- **Availability:** On-call engineer must respond within SLA
- **Documentation:** All actions logged in incident tracker
- **Handoff:** Proper shift change documentation
- **Knowledge:** Maintain current runbook access and familiarity

---

## Snooze Management

### When to Snooze

✅ **Appropriate:**
- Planned maintenance window (with advance notice)
- Known issue with ETA for fix (document reason with ticket link)
- Staging environment testing
- Temporary capacity constraints with planned expansion
- Third-party service outage beyond your control

❌ **Inappropriate:**
- Ignoring recurring problems
- Avoiding necessary investigations
- Hiding systemic issues
- Snoozing without a documented reason
- Extending snooze beyond 24 hours repeatedly

### Creating Snoozes

**Via Dashboard:**
1. Go to `/admin/alerts`
2. Click snooze button (1h/6h/24h) on alert row
3. Enter reason (required)
4. Confirm

**Via API:**
```bash
curl -X POST https://your-app.com/api/monitoring/d1/snoozes \
  -H "Content-Type: application/json" \
  -H "Cookie: __session=YOUR_SESSION" \
  -d '{
    "alertConfigId": "alert-slow-query",
    "durationMinutes": 360,
    "reason": "Deploying index optimization, ETA 4 hours - TICKET-123"
  }'
```

### Snooze Durations

| Duration | Use Case |
|----------|----------|
| **1 hour** | Quick fixes, temporary workarounds, testing |
| **6 hours** | Maintenance windows, multi-hour deployments |
| **24 hours** | Extended incidents, resource constraints with known ETA |

### Managing Snoozes

**List Active Snoozes:**
```bash
# API
curl https://your-app.com/api/monitoring/d1/snoozes

# Dashboard
/admin/alerts → "Silenced Alerts" section
```

**Cancel Snooze Early:**
```bash
# API
curl -X DELETE https://your-app.com/api/monitoring/d1/snoozes/SNOOZE_ID

# Dashboard
Click "Cancel" on snoozed alert row
```

### Snooze Best Practices

1. **Always provide a reason** - Include ticket link or brief explanation
2. **Monitor expiry** - Set calendar reminders for long snoozes
3. **Document in incident** - Include snooze actions in post-mortem
4. **Review active snoozes** - Check daily for stale snoozes
5. **Don't snooze recurring** - If same alert snoozed repeatedly, fix root cause

---

## Configuration Management

### Environment Variables

#### Core Configuration

```bash
# Notification System
NOTIFICATIONS_ENABLED=true
NOTIFICATION_DEFAULT_PRIORITY=normal
NOTIFICATION_RATE_LIMIT=60          # seconds between notifications
NOTIFICATION_MAX_RETRIES=3
NOTIFICATION_RETRY_BACKOFF=1000     # ms

# Alert Engine
ALERT_ENGINE_ENABLED=true
ALERT_EVALUATION_INTERVAL=300       # seconds (5 minutes)
ALERT_HISTORY_RETENTION_DAYS=90
```

#### Email (Resend)

```bash
RESEND_API_KEY=re_your_key_here
RESEND_FROM_EMAIL=noreply@your-domain.com
RESEND_FROM_NAME=ApexOS Monitoring
NOTIFICATION_EMAIL_RECIPIENTS=admin@example.com,ops@example.com
```

#### Slack

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
SLACK_ENABLED=true
SLACK_CHANNEL=#alerts
SLACK_USERNAME=ApexOS Bot
SLACK_ICON_EMOJI=:rocket:
```

#### Telegram

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234567890
TELEGRAM_CHAT_IDS=-1001234567890,-1009876543210
TELEGRAM_ENABLED=true
TELEGRAM_PARSE_MODE=HTML
```

### Managing Alert Configurations

**List all alert configs:**
```bash
# Direct D1 query
wrangler d1 execute apex-os-db --command "
  SELECT id, name, severity, is_enabled FROM alert_configs ORDER BY severity;
"
```

**Enable/Disable alert:**
```sql
UPDATE alert_configs
SET is_enabled = true/false
WHERE id = 'alert-slow-query';
```

**Modify threshold:**
```sql
UPDATE alert_configs
SET threshold = 2000  -- new threshold
WHERE id = 'alert-slow-query';
```

**View alert history:**
```sql
SELECT
  c.name,
  a.status,
  a.metric_value,
  a.created_at
FROM monitoring_alerts a
JOIN alert_configs c ON a.config_id = c.id
WHERE a.created_at > datetime('now', '-7 days')
ORDER BY a.created_at DESC;
```

### Cron Configuration

**Cloudflare Pages** (`wrangler.toml`):
```toml
[triggers]
crons = ["*/5 * * * *"]  # Every 5 minutes
```

**Manual Trigger (for testing):**
```bash
curl -X POST https://your-app.com/api/monitoring/alert-engine/run \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

---

## Troubleshooting

### Common Issues

#### No Alerts Triggering

**Check:**
1. Are alert configs enabled?
   ```sql
   SELECT id, is_enabled FROM alert_configs;
   ```
2. Do metrics exist for evaluation?
   ```bash
   curl https://your-app.com/api/monitoring/d1
   ```
3. Is the alert engine running?
   ```bash
   # Check cron logs in Cloudflare dashboard
   wrangler pages deployment list
   ```
4. Review alert engine logs:
   ```bash
   wrangler tail --format=json
   ```

**Resolution:**
- Enable disabled configs
- Verify cron is configured and running
- Check that metrics API is returning data

#### Notifications Not Sending

**Check:**
1. Channel enabled flags:
   ```bash
   # Check env vars
   echo $SLACK_ENABLED $TELEGRAM_ENABLED
   ```
2. Webhook/API credentials valid
   - Test Slack webhook manually
   - Verify Resend API key has credits
   - Confirm Telegram bot is active
3. Rate limit not exceeded:
   ```sql
   SELECT COUNT(*) FROM notification_deliveries
   WHERE created_at > datetime('now', '-1 minute');
   ```

**Resolution:**
- Re-enter webhook URLs
- Renew API keys
- Wait for rate limit to reset
- Check notification delivery table for errors

#### Alerts Still Firing After Snooze

**Check:**
1. Snooze exists and is valid:
   ```sql
   SELECT * FROM alert_snoozes
   WHERE config_id = 'alert-slow-query'
     AND expires_at > CURRENT_TIMESTAMP;
   ```
2. Alert evaluation logic properly checks snoozes:
   ```typescript
   // In alert-engine.ts, ensure snooze check before creating alert
   const isSnoozed = await storage.isAlertSnoozed(configId);
   if (isSnoozed) return;
   ```

**Resolution:**
- Extend snooze duration if needed
- Create new snooze if expired
- Fix alert engine if snooze check is missing

#### High False Positive Rate

**Check:**
1. Thresholds appropriate for normal load?
   - Review historical metrics
   - Check alert firing frequency
2. Alert conditions too sensitive?
   ```sql
   -- Analyze metric values
   SELECT
     metric_name,
     MIN(metric_value),
     MAX(metric_value),
     AVG(metric_value),
     PERCENTILE(metric_value, 95)
   FROM metrics_history
   WHERE collected_at > datetime('now', '-30 days');
   ```

**Resolution:**
- Adjust thresholds based on P95/P99 metrics
- Add hysteresis (require N consecutive violations)
- Add suppression window for known maintenance

### Database Issues

**Check D1 status:**
```bash
wrangler d1 execute apex-os-db --command "SELECT name FROM sqlite_master WHERE type='table';"
```

**Check table sizes:**
```sql
SELECT
  name,
  (page_count * page_size) / 1024 / 1024 as size_mb
FROM pragma_page_count(), pragma_page_size()
JOIN sqlite_master ON name NOT LIKE 'sqlite_%';
```

**Clear old alerts (if needed):**
```sql
-- Keep last 90 days
DELETE FROM monitoring_alerts
WHERE created_at < datetime('now', '-90 days');

-- Or archive first
INSERT INTO monitoring_alerts_archive
SELECT * FROM monitoring_alerts
WHERE created_at < datetime('now', '-90 days');
```

---

## Maintenance

### Daily Tasks

- [ ] Review active alerts dashboard
- [ ] Acknowledge or resolve old alerts
- [ ] Check notification delivery status
- [ ] Review snoozed alerts for validity

### Weekly Tasks

- [ ] Analyze alert trends
- [ ] Review false positives and adjust thresholds
- [ ] Check storage usage growth
- [ ] Verify alert engine cron is running
- [ ] Review notification channel health

### Monthly Tasks

- [ ] Post-incident reviews for critical alerts
- [ ] Alert effectiveness audit
- [ ] Threshold calibration based on metrics
- [ ] Documentation updates
- [ ] Runbook drill/test

### Quarterly Tasks

- [ ] Full alert system audit
- [ ] Review all alert configurations for relevance
- [ ] Update escalation contacts
- [ ] Test all notification channels
- [ ] Capacity planning based on metrics trends

---

## Testing and Validation

### Automated Tests

```bash
# Run full alerting test suite
pnpm test:alerting

# Test specific notification channel
pnpm test:channel slack
pnpm test:channel email
pnpm test:channel telegram

# Test alert engine
pnpm test:alert-engine

# Test storage layer
pnpm test:alert-storage
```

### Manual Testing

**Test alert creation:**
```bash
# Force evaluation
curl -X POST https://your-app.com/api/monitoring/alert-engine/run

# Check alerts created
curl https://your-app.com/api/monitoring/d1
```

**Test notification:**
```bash
# Send test message to each channel
curl -X POST https://your-app.com/api/monitoring/test-notification \
  -H "Content-Type: application/json" \
  -d '{"channel": "slack"}'
```

**Test snooze:**
```bash
# Create snooze
curl -X POST https://your-app.com/api/monitoring/d1/snoozes \
  -H "Content-Type: application/json" \
  -d '{
    "alertConfigId": "alert-slow-query",
    "durationMinutes": 60,
    "reason": "Testing snooze functionality"
  }'

# Verify snooze active
curl https://your-app.com/api/monitoring/d1/snoozes

# Trigger evaluation - should NOT create alert
curl -X POST https://your-app.com/api/monitoring/alert-engine/run
```

### Test Checklist

- [ ] All notification channels configured and tested
- [ ] Alert engine evaluates metrics correctly
- [ ] Snooze functionality working
- [ ] Rate limiting operational
- [ ] Retry logic handling failures
- [ ] Dashboard displays alerts accurately
- [ ] API endpoints authenticated and secure

---

## Incident Review

### Post-Incident Template

For all critical alerts and recurring warnings (3+ in 24h):

**1. Summary**
- What happened, when, impact duration
- Which users/services affected
- Severity level

**2. Timeline**
- Time of first alert
- Acknowledgment time
- Investigation milestones
- Resolution time
- Full recovery time

**3. Root Cause**
- Technical root cause (5 Whys)
- Contributing factors
- Why existing alerts/fail-safes didn't prevent

**4. Impact**
- Users affected (count and percentage)
- Revenue impact (if applicable)
- SLA breaches

**5. Actions Taken**
- Immediate fixes applied
- Workarounds implemented
- System restored

**6. Follow-ups**
- [ ] Task: Permanent fix implementation
- [ ] Task: Alert threshold adjustment
- [ ] Task: Monitoring enhancement
- [ ] Task: Runbook update
- [ ] Task: Post-mortem review meeting

**7. Alert Review**
- Were alerts triggered appropriately?
- Were SLAs met?
- Was escalation followed correctly?
- Could alerts have detected earlier?

### Alert Effectiveness Metrics

Track monthly:

| Metric | Target |
|--------|--------|
| Alert acknowledgment time (critical) | < 15 min |
| Alert resolution time (warning) | < 4 hours |
| False positive rate | < 10% |
| Snooze misuse incidents | 0 |
| Recurring alerts (same root cause) | < 5% |

---

## Appendix

### API Reference

#### Get Alert Status

```http
GET /api/monitoring/d1
```

Response:
```json
{
  "alerts": [
    {
      "id": "alert_123",
      "configId": "alert-slow-query",
      "name": "Slow Query",
      "severity": "warning",
      "message": "Average query duration exceeded threshold",
      "metricValue": 2500,
      "thresholdValue": 1000,
      "status": "active",
      "triggeredAt": "2026-06-23T14:30:00Z"
    }
  ],
  "summary": {
    "total": 5,
    "critical": 1,
    "warning": 3,
    "info": 1
  }
}
```

#### Acknowledge Alert

```http
POST /api/monitoring/d1
Content-Type: application/json

{
  "action": "acknowledge",
  "alertId": "alert_123"
}
```

#### Resolve Alert

```http
POST /api/monitoring/d1
Content-Type: application/json

{
  "action": "resolve",
  "alertId": "alert_123"
}
```

#### Create Snooze

```http
POST /api/monitoring/d1/snoozes
Content-Type: application/json

{
  "alertConfigId": "alert-slow-query",
  "durationMinutes": 60,
  "reason": "Deploying optimization patch"
}
```

#### List Snoozes

```http
GET /api/monitoring/d1/snoozes
```

#### Delete Snooze

```http
DELETE /api/monitoring/d1/snoozes/{id}
```

### Database Reference

**Tables:**
- `alert_configs` - Alert rule definitions
- `monitoring_alerts` - Active and historical alerts
- `alert_snoozes` - Active snooze overrides
- `notification_deliveries` - Delivery tracking

**Indexes:**
```sql
CREATE INDEX idx_alerts_status ON monitoring_alerts(status);
CREATE INDEX idx_alerts_created ON monitoring_alerts(created_at);
CREATE INDEX idx_snoozes_expires ON alert_snoozes(expires_at);
CREATE INDEX idx_deliveries_alert ON notification_deliveries(alert_id);
```

### Useful Queries

**Top recurring alerts:**
```sql
SELECT
  config_id,
  COUNT(*) as occurrence_count,
  MIN(created_at) as first_seen,
  MAX(created_at) as last_seen
FROM monitoring_alerts
WHERE created_at > datetime('now', '-30 days')
GROUP BY config_id
ORDER BY occurrence_count DESC
LIMIT 10;
```

**Alert resolution time:**
```sql
SELECT
  config_id,
  AVG(
    julianday(resolved_at) - julianday(created_at)
  ) * 24 * 60 as avg_resolution_minutes
FROM monitoring_alerts
WHERE resolved_at IS NOT NULL
  AND created_at > datetime('now', '-30 days')
GROUP BY config_id;
```

**Notification delivery success rate:**
```sql
SELECT
  channel,
  COUNT(*) as total,
  SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as delivered,
  ROUND(
    SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) * 100.0 / COUNT(*),
    2
  ) as success_rate_pct
FROM notification_deliveries
WHERE created_at > datetime('now', '-7 days')
GROUP BY channel;
```

---

**End of Runbook**

For questions or issues with the alerting system, contact the engineering team or refer to:
- [Alert Response Procedures](./alert-response-procedures.md)
- [Alerting Quick Reference](./alerting-quick-reference.md)
- [Admin Dashboards Guide](./admin-dashboards.md)
- [Operational Runbook](./operational-runbook.md)
