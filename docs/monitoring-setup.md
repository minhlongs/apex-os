# Uptime Monitoring Setup Guide

**Last Updated:** 2026-06-22
**Target Endpoint:** `/api/health`
**Check Interval:** 1 minute
**Alert Threshold:** >5 minutes downtime (5 consecutive failures)
**Services:** UptimeRobot, Pingdom, Cloudflare Analytics

---

## Table of Contents

1. [Overview](#overview)
2. [Health Endpoint Specification](#health-endpoint-specification)
3. [UptimeRobot Setup](#uptimerobot-setup)
4. [Pingdom Setup](#pingdom-setup)
5. [Cloudflare Analytics Setup](#cloudflare-analytics-setup)
6. [Alert Configuration](#alert-configuration)
7. [Alert Escalation Matrix](#alert-escalation-matrix)
8. [Dashboard & Reporting](#dashboard--reporting)
9. [Maintenance & Testing](#maintenance--testing)
10. [Troubleshooting](#troubleshooting)

---

## Overview

ApexOS uses multiple monitoring layers for comprehensive uptime visibility:

| Service | Purpose | Interval | Cost |
|---------|---------|----------|------|
| **UptimeRobot** | Primary external monitoring | 1 minute | Free (50 monitors) |
| **Pingdom** | Synthetic transaction monitoring | 1 minute | Paid (trial available) |
| **Cloudflare Analytics** | Built-in edge monitoring | 1 minute | Free (included) |

### Downtime Definition

- **Down:** Health endpoint returns non-200 status OR fails to respond within 10 seconds
- **Degraded:** Status returns 200 but `checks.database !== "connected"`
- **Alert Trigger:** 5 consecutive failures = ~5 minutes downtime

---

## Health Endpoint Specification

### Endpoint

```
GET https://your-app.pages.dev/api/health
```

### Expected Response (200 OK)

```json
{
  "status": "ok",
  "timestamp": "2026-06-22T12:00:00.000Z",
  "environment": "production",
  "uptime": 86400,
  "version": "1.0.0",
  "responseTime": 45,
  "checks": {
    "database": "connected",
    "kv": "connected"
  },
  "memory": {
    "rss": "45MB",
    "heapUsed": "23MB"
  }
}
```

### Status Values

| Field | Values | Meaning |
|-------|--------|---------|
| `status` | `ok` | All systems operational |
| | `degraded` | Database or KV connection issue |
| | `error` | Critical failure |
| `checks.database` | `connected` | D1 database accessible |
| | `error` | Database connection failed |
| | `not_configured` | DB binding missing |
| | `unknown` | Check not executed |
| `checks.kv` | `connected` | KV cache accessible |
| | `error` | KV connection failed |
| | `not_configured` | KV binding missing |

### Response Codes

| Code | Meaning | Action |
|------|---------|--------|
| `200` | Healthy | Normal operation |
| `503` | Service Unavailable | Alert triggered |

---

## UptimeRobot Setup

### 1. Create Account

1. Go to [UptimeRobot.com](https://uptimerobot.com)
2. Sign up (free tier available)
3. Verify email address

### 2. Add Monitor

**Steps:**

1. Click **+ Add New Monitor**
2. Select **HTTP(s)**
3. Configure:
   ```
   Monitor Name:     ApexOS - Health Check
   Monitor URL:      https://your-app.pages.dev/api/health
   Monitor Type:     HTTP(s)
   Monitoring Region: US East (N. Virginia)
   ```

4. **Advanced Settings:**
   ```
   Check Interval:   1 minute
   Alert Contacts:   [Add email, Slack, SMS, etc.]
   HTTP Method:      GET
   Expected Status:  200
   Expected String:  "status":"ok"
   Timeout:          10 seconds
   ```

5. **Alert Escalation:**
   - Set **Alert Confirmation**: 5 failures (5 minutes)
   - This means: Alert fires only after 5 consecutive failures
   - Downtime definition: 5+ minute interruption

6. Click **Create Monitor**

### 3. Configure Alert Contacts

**Email Alerts:**
1. Go to **My Settings** → **Alert Contacts**
2. Add email addresses for:
   - Primary on-call: `devops@yourdomain.com`
   - Secondary: `alerts@yourdomain.com`
   - Team distribution: `infra-team@yourdomain.com`

**Slack Integration:**
1. Go to **Alert Contacts** → **Add Alert Contact**
2. Select **Webhook**
3. Use Slack incoming webhook URL:
   ```
   https://hooks.slack.com/services/XXXXX/XXXXX/XXXXX
   ```
4. Set message format (JSON):
   ```json
   {
     "text": "🚨 ApexOS is DOWN\nMonitor: {{monitorname}}\nURL: {{url}}\nDuration: {{downsince}}\nStatus: {{statuscode}}",
     "channel": "#infra-alerts",
     "username": "UptimeRobot"
   }
   ```

### 4. Status Page (Optional)

Create public status page:
1. Go to **Status Pages** → **Add New Status Page**
2. Configure:
   - Name: "ApexOS Status"
   - URL: `https://status.your-domain.com`
   - Monitors: Select your health check
   - Branding: Add logo, customize colors
3. Share URL with users during incidents

### 5. Monitor Configuration Summary

| Setting | Value |
|---------|-------|
| Monitor Type | HTTP(s) |
| URL | `https://apex-os.pages.dev/api/health` |
| Interval | 1 minute |
| Timeout | 10 seconds |
| Expected Status Code | 200 |
| Alert Confirmation | 5 failures |
| Alert Contacts | Email, Slack webhook |
| Status Page | Optional (public) |

---

## Pingdom Setup

### 1. Create Account

1. Go to [Pingdom.com](https://pingdom.com)
2. Sign up for free trial (14 days) or paid plan
3. Verify account

### 2. Add Check

**Steps:**

1. Click **Add Check** → **HTTP Check**
2. Configure:
   ```
   Name:             ApexOS - Health API
   URL:              https://your-app.pages.dev/api/health
   Check every:      1 minute
   Probe servers:    US East (Ashburn)
   ```

3. **Advanced Settings:**
   ```
   Connection timeout:     10 seconds
   SSL certificate check:  Enabled
   Follow redirects:       No
   Store historical data:  365 days
   ```

4. **Alerting:**
   ```
   Send notification when:  Down (non-200 response)
   Confirm before alerting: 5 minutes
   ```

### 3. Configure Alert Notifications

**Email Alerts:**
1. Go to **Alerting** → **Notifications**
2. Click **Add Notification**
3. Select **Email**
4. Add recipients:
   - `devops@yourdomain.com`
   - `alerts@yourdomain.com`
5. Set **Alert threshold** to:
   - **Warning:** 3 minutes (optional)
   - **Error:** 5 minutes

**Slack Integration:**
1. Go to **Alerting** → **Integrations**
2. Click **Slack**
3. Follow OAuth flow to authorize
4. Select Slack channel: `#infra-alerts`
5. Message template:
   ```
   🚨 *{{checkname}}* is *DOWN*
   URL: {{url}}
   Status: {{statuscode}}
   Duration: {{downsince}}
   Response time: {{responsetime}}ms
   ```

**SMS/PagerDuty (for critical):**
1. Add **PagerDuty** integration for escalation
2. Configure PagerDuty service: `apex-os-production`
3. Set escalation policy: 5min → 10min → 30min → SMS

### 4. Transaction Monitoring (Optional)

Pingdom offers synthetic transaction monitoring for critical user flows:

**Example: Complete Purchase Flow**
1. Create **Transaction Check**
2. Add steps:
   - Step 1: Visit homepage (`GET /`)
   - Step 2: Click deal (`GET /deals/[slug]`)
   - Step 3: Health check (`GET /api/health`)
3. Set threshold: Fail if any step >10 seconds
4. Alert: Same as health check

### 5. Reports & Dashboard

1. Go to **Reports**
2. Create weekly uptime report
3. Set recipients: `team@yourdomain.com`
4. Include: Uptime %, response time trends, downtime incidents

### 6. Pingdom Configuration Summary

| Setting | Value |
|---------|-------|
| Check Type | HTTP |
| URL | `https://apex-os.pages.dev/api/health` |
| Interval | 1 minute |
| Timeout | 10 seconds |
| Alert Confirmation | 5 minutes |
| Notifications | Email, Slack, PagerDuty (critical) |
| Reports | Weekly summary |

---

## Cloudflare Analytics Setup

Cloudflare provides built-in monitoring through Pages Analytics and Workers metrics.

### 1. Enable Analytics in Cloudflare Dashboard

1. Go to **Cloudflare Dashboard** → **Pages** → Your project (`apex-os`)
2. Click **Analytics** tab
3. Enable:
   - **Requests**: Track all incoming requests
   - **Error rate**: 4xx and 5xx responses
   - **Response time**: P50, P95, P99
   - **Bandwidth**: In/Out traffic

### 2. Configure Notifications

**Cloudflare Notifications:**

1. Go to **Notifications** (bell icon in top right)
2. Click **Create notification**
3. Configure:
   ```
   Name: ApexOS - High Error Rate
   Type: Analytics
   Condition: Error rate > 5% over 5 minutes
   Destination: Email, Slack webhook
   ```

4. Create additional notification:
   ```
   Name: ApexOS - Response Time Degradation
   Type: Analytics
   Condition: P95 response time > 2000ms over 5 minutes
   ```

### 3. Edge Analytics (Real-time)

Enable Workers Analytics Engine for custom metrics:

**wrangler.toml addition:**
```toml
[[analytics_engine_datasets]]
binding = "HEALTH_METRICS"
dataset = "health_metrics"
```

**Log to analytics from health endpoint:**
```typescript
// In src/app/api/health/route.ts
if (HEALTH_METRICS) {
  await HEALTH_METRICS.writeDataPoint({
    status: health.status,
    responseTime: health.responseTime,
    database: health.checks.database,
    timestamp: Date.now(),
  });
}
```

### 4. Logpush to R2 (Audit Trail)

Create R2 bucket for logs:
```bash
wrangler r2 bucket create apex-os-monitoring-logs
```

Configure logpush in Cloudflare Dashboard:
1. Go to **Pages** → Your project → **Logs**
2. Click **Configure logpush**
3. Destination: `apex-os-monitoring-logs`
4. Filter: `status >= 500 OR status = 503`
5. Retention: 90 days

### 5. Cloudflare Configuration Summary

| Feature | Setting |
|---------|---------|
| Analytics | Enabled (requests, errors, response time) |
| Error Rate Alert | >5% over 5 minutes |
| Response Time Alert | P95 > 2s over 5 minutes |
| Logpush | Enabled for 5xx errors |
| Retention | 90 days |

---

## Alert Configuration

### Alert Threshold Logic

All monitoring services use this pattern:

```
IF (status !== 200) FOR 5 consecutive checks
THEN trigger ALERT
```

**Why 5 minutes?**

- Prevents false positives from transient network glitches
- 1-minute interval × 5 checks = 5 minutes
- Industry standard for production systems
- Gives auto-recovery mechanisms time to activate (Cloudflare auto-restart)

### Alert States

| State | Condition | Action |
|-------|-----------|--------|
| **OK** | Status 200, database connected | Send recovery notification |
| **WARNING** | Status 200, database degraded | Notify but don't escalate |
| **CRITICAL** | Status non-200 for 5+ minutes | Escalate to on-call, SMS/PagerDuty |

### Alert Templates

**UptimeRobot Webhook Template:**
```json
{
  "attachments": [
    {
      "title": "🚨 ApexOS is DOWN",
      "color": "danger",
      "fields": [
        { "title": "Monitor", "value": "{{monitorname}}" },
        { "title": "URL", "value": "{{url}}" },
        { "title": "Status Code", "value": "{{statuscode}}" },
        { "title": "Down Since", "value": "{{downsince}}" },
        { "title": "Response Time", "value": "{{responsetime}}ms" }
      ]
    }
  ]
}
```

**Pingdom Webhook Template:**
```json
{
  "text": "*{{checkname}}* is *{{state}}*\nURL: {{url}}\nStatus: {{statuscode}}\nDuration: {{downsince}}\nResponse: {{responsetime}}ms",
  "attachments": [
    {
      "color": "{{#isDown}}danger{{/isDown}}{{#isUp}}good{{/isUp}}"
    }
  ]
}
```

---

## Alert Escalation Matrix

### Tier 1: Initial Alert (0-5 minutes)

| Channel | Who | Action |
|---------|-----|--------|
| Slack (#infra-alerts) | On-call engineer | Acknowledge alert |
| Email | DevOps team | Awareness |

### Tier 2: Escalation (5-15 minutes)

| Channel | Who | Action |
|---------|-----|--------|
| SMS | Primary on-call | Immediate attention required |
| PagerDuty | Secondary on-call | Escalation if no ack in 5min |
| Slack (@oncall) | Team lead | Status update needed |

### Tier 3: Management (15+ minutes)

| Channel | Who | Action |
|---------|-----|--------|
| SMS | Engineering manager | Incident commander |
| Email | CTO office | Executive awareness |
| Slack (#ceo-alerts) | Founder | Business impact assessment |

### Runbook Links in Alerts

Include runbook URL in every alert:
```
https://github.com/your-org/apex-os/wiki/Incident-Runbook
```

---

## Dashboard & Reporting

### 1. Grafana Dashboard (Optional)

Create Grafana dashboard with Cloudflare API metrics:

**Panels:**
- Uptime % (last 24h, 7d, 30d)
- Request rate (RPS)
- Error rate (4xx, 5xx)
- Response time (P50, P95, P99)
- Database connection health

**Data Source:** Cloudflare API (Prometheus endpoint)

### 2. Weekly Reports

**UptimeRobot Weekly Summary:**
- Sent automatically to subscribed emails
- Shows: Total uptime, downtime incidents, response time

**Pingdom Reports:**
- Configure weekly email report (Monday 9 AM)
- Include: Performance grade, uptime %, recommendations

### 3. Status Page

Public status page shows:
- System status (Operational/Degraded/Down)
- Incident history (last 90 days)
- Maintenance announcements
- Subscribe for updates

---

## Maintenance & Testing

### Regular Maintenance

| Task | Frequency | Owner |
|------|-----------|-------|
| Test alert notifications | Monthly | DevOps |
| Review and update contacts | Quarterly | DevOps |
| Update escalation matrix | Quarterly | Engineering Manager |
| Audit monitoring costs | Monthly | CFO |
| Review false positives | Weekly | On-call |

### Testing Alerts

**Simulate downtime:**
```bash
# Option 1: Deploy failing health endpoint
# Temporarily return 503 from /api/health
# Verify alerts trigger after 5 minutes

# Option 2: Use maintenance mode
# Set NEXT_PUBLIC_MAINTENANCE_MODE=true
# Health returns 503

# Option 3: Network block
# Block /api/health in Cloudflare firewall rules
```

**Test procedure:**
1. Announce test to team: "Monitoring test in 5 minutes"
2. Simulate failure (maintenance mode)
3. Wait for alerts to trigger
4. Verify all channels received alert
5. Acknowledge in PagerDuty/UptimeRobot
6. Restore service
7. Verify recovery notification sent
8. Document test results

### Monitoring Health Check

Run self-test script:
```bash
curl -f https://your-app.pages.dev/api/health \
  -H "Accept: application/json" \
  -w "\nHTTP: %{http_code}\nTime: %{time_total}s\n" \
  -o /dev/null
```

Expected output:
```
HTTP: 200
Time: 0.045s
```

---

## Troubleshooting

### Health Endpoint Returns HTML Instead of JSON

**Symptom:** `curl https://your-app.pages.dev/api/health` returns HTML (homepage) instead of JSON.

**Root Cause:** Next.js locale middleware (from next-intl) may be redirecting or intercepting `/api/*` requests, or Cloudflare Pages routing configuration issue.

**Solution:**

1. **Add middleware to exclude API routes from locale handling**

   Create `src/middleware.ts` with the following content:
   ```typescript
   import { NextResponse } from 'next/server'
   import type { NextRequest } from 'next/server'

   const SKIP_PATHS = [
     '/api/health',
     '/api/auth',
     '/api/deals',
     '/api/tracking',
     '/api/webhooks',
     '/api/affiliate',
     '/api/public',
   ]

   function shouldSkipLocale(pathname: string): boolean {
     return SKIP_PATHS.some((prefix) => pathname.startsWith(prefix))
   }

   export async function middleware(request: NextRequest) {
     const { pathname } = request.nextUrl
     if (shouldSkipLocale(pathname)) {
       return NextResponse.next()
     }
     // Locale detection for pages (optional - keep if using next-intl)
     return NextResponse.next()
   }

   export const config = {
     matcher: [
       '/((?!_next|favicon.ico|.*\\..*|api|public).*)',
       '/(vi|en)/((?!_next|favicon.ico|.*\\..*).*)',
     ],
   }
   ```

2. **Rebuild and redeploy**
   ```bash
   pnpm build
   wrangler pages deploy .open-next --project-name apex-os
   ```

3. **Verify the fix**
   ```bash
   curl https://your-app.pages.dev/api/health
   # Should return: {"status":"ok",...}
   ```

**Alternative:** If the middleware approach doesn't work, check Cloudflare Pages dashboard for any custom routing rules that might override `_routes`. The `_routes` file should have `/api/* cloudflare_workers` before the catch-all `/*` rule.

### Local Verification

Test the health endpoint locally to confirm it works:
```bash
wrangler dev
curl http://localhost:8787/api/health
```
Expected: JSON response with `"status":"ok"`

If local works but production doesn't, the issue is with Pages routing configuration, not the endpoint code.

---

## Appendix

### Environment Variables

```bash
# Monitoring URLs
NEXT_PUBLIC_APP_URL=https://apex-os.pages.dev
HEALTH_CHECK_URL=${NEXT_PUBLIC_APP_URL}/api/health

# Alert webhooks (optional, for custom integrations)
UPTIMEROBOT_WEBHOOK_URL=https://hooks.slack.com/services/...
PINGDOM_WEBHOOK_URL=https://events.pagerduty.com/v2/enqueue

# Notification templates (JSON files)
NOTIFICATION_TEMPLATES_DIR=./scripts/alert-templates
```

### Cost Estimates

| Service | Tier | Monthly Cost |
|---------|------|--------------|
| UptimeRobot | Free | $0 (50 monitors) |
| Pingdom | Standard | ~$20/month |
| Cloudflare Analytics | Included | $0 |
| **Total** | | **~$20/month** |

### Security Considerations

- Health endpoint exposes internal status → ensure it's not cached publicly
- Do not include sensitive data (API keys, DB credentials) in response
- Consider IP whitelisting for internal monitoring only (optional)
- Alert webhooks should use HTTPS with valid certificates

### Incident Response Playbook

1. **Acknowledge** alert within 5 minutes
2. **Check** health endpoint manually
3. **Review** Cloudflare Pages dashboard for recent deployments
4. **Check** recent database operations (D1 logs)
5. **Rollback** if deployment caused issue
6. **Restore** from backup if data corruption
7. **Communicate** via status page and team Slack
8. **Post-mortem** after incident resolution

---

## Quick Reference

| Item | Value |
|-----|-------|
| Health Endpoint | `/api/health` |
| Check Interval | 1 minute |
| Alert Threshold | 5 consecutive failures |
| Expected Response | `{"status":"ok",...}` with HTTP 200 |
| Maintenance Mode | Set `NEXT_PUBLIC_MAINTENANCE_MODE=true` |
| Runbook | `docs/deployment-runbook.md` |
| Incident Channel | `#infra-alerts` on Slack |
