# Alert Response Procedures

This document outlines the procedures for responding to monitoring alerts in the ApexOS platform. It covers alert classification, response workflows, and best practices for managing alert fatigue while ensuring system reliability.

## Table of Contents

1. [Alert System Overview](#alert-system-overview)
2. [Alert Severity Levels](#alert-severity-levels)
3. [Response Procedures](#response-procedures)
4. [Snooze Guidelines](#snooze-guidelines)
5. [Escalation Matrix](#escalation-matrix)
6. [Post-Incident Review](#post-incident-review)
7. [Monitoring Dashboard Guide](#monitoring-dashboard-guide)

---

## Alert System Overview

The ApexOS monitoring system tracks key performance and health metrics for the D1 database and application infrastructure. Alerts are configured with thresholds that trigger notifications via email, Slack, or webhook.

### Alert Sources

- **D1 Database Metrics** - Storage usage, query performance, slow queries
- **Business Metrics** - Conversion rates, payout health, revenue tracking
- **System Health** - API response times, error rates, availability

### Alert States

| State | Description | Action Required |
|-------|-------------|-----------------|
| **Active** | Alert triggered, needs attention | Acknowledge, investigate, resolve |
| **Acknowledged** | Someone is working on it | Continue investigation |
| **Resolved** | Issue resolved, monitoring continues | Document resolution |
| **Snoozed** | Temporarily silenced | Will re-activate after snooze period |

---

## Alert Severity Levels

### 🔴 Critical

**Definition:** System is down or severely degraded. Immediate action required.

**Examples:**
- Storage usage ≥ 80% quota
- Database connection failures
- Payout system failures
- Authentication service down

**Response Time:** Immediate (within 15 minutes)

**Notification Channels:**
- Email to all admins
- Slack #alerts-critical channel
- SMS/PagerDuty for 24/7 on-call

**Response Actions:**
1. Acknowledge alert immediately
2. Check incident runbook
3. Notify engineering lead
4. Begin incident response protocol
5. Provide status updates every 30 minutes

---

### 🟡 Warning

**Definition:** System degraded but still functional. Action required within business hours.

**Examples:**
- Query duration > 1 second average
- More than 10 slow queries in 1 hour
- High row scan counts
- Conversion rate dropping > 20%

**Response Time:** 4 business hours

**Notification Channels:**
- Email to ops team
- Slack #alerts-warnings channel

**Response Actions:**
1. Acknowledge alert
2. Investigate root cause
3. Create follow-up task if needed
4. Document findings
5. Resolve when fixed

---

### 🔵 Info

**Definition:** Informational, may not require immediate action.

**Examples:**
- Unusual but expected traffic patterns
- Maintenance notifications
- Configuration changes

**Response Time:** Next business day

**Notification Channels:**
- Email digest
- Slack #alerts-info channel

**Response Actions:**
1. Review for trends
2. Adjust thresholds if needed
3. Document if pattern emerges

---

## Response Procedures

### Standard Response Workflow

1. **Acknowledge** - Mark alert as acknowledged in dashboard
2. **Investigate** - Use provided diagnostic tools and runbooks
3. **Remediate** - Apply fix or workaround
4. **Resolve** - Mark alert resolved in system
5. **Document** - Add notes about cause and resolution

### Investigation Checklist

- [ ] Check monitoring dashboard for related metrics
- [ ] Review recent deployments/changes
- [ ] Examine logs for errors/warnings
- [ ] Query database for performance issues
- [ ] Verify external dependencies (exchanges, APIs)
- [ ] Test user-facing functionality

### Resolution Guidelines

- **Fix Applied:** Resolve alert and note the fix
- **False Positive:** Document why threshold needs adjustment
- **Temporary Workaround:** Create ticket for permanent fix
- **External Issue:** Document impact and monitor status page

---

## Snooze Guidelines

Snoozing allows temporarily suppressing alerts that are known and being addressed, or during planned maintenance.

### When to Snooze

✅ **Appropriate:**
- Planned maintenance window (with advance notice)
- Known issue with ETA for fix (document reason)
- Testing in staging that may trigger alerts
- Temporary capacity constraints with planned expansion

❌ **Inappropriate:**
- Ignoring recurring problems
- Avoiding necessary investigations
- Hiding systemic issues
- Without documenting a reason

### Snooze Durations

| Duration | Use Case |
|----------|----------|
| **1 hour** | Quick fixes, temporary workarounds, testing |
| **6 hours** | Maintenance windows, multi-hour deployments |
| **24 hours** | Extended incidents, resource constraints with known ETA |

### Snooze Best Practices

1. **Always provide a reason** - Include ticket link or brief explanation
2. **Monitor snooze expiry** - Alerts will re-trigger if issue persists
3. **Don't over-snooze** - If snoozing same alert repeatedly, fix root cause
4. **Document in incident** - Include snooze actions in post-mortem

### Creating a Snooze

```bash
# Via Dashboard
1. Go to Admin > Monitoring
2. Click "1h", "6h", or "24h" on alert config
3. Add optional reason
4. Confirm

# Via API
curl -X POST https://api.apex-os.com/api/monitoring/d1/snoozes \
  -H "Content-Type: application/json" \
  -d '{
    "alertConfigId": "alert-slow-query",
    "durationMinutes": 360,
    "reason": "Deploying query optimization, ETA 4 hours"
  }'
```

### Canceling a Snooze

- Click "Cancel Snooze" in the "Silenced Alerts" section
- Or use API: `DELETE /api/monitoring/d1/snoozes/[id]`

---

## Escalation Matrix

| Alert Type | Time Without Response | Escalation Action |
|------------|----------------------|-------------------|
| Critical | 15 minutes | Page on-call engineer |
| Critical | 1 hour | Notify CTO |
| Warning | 4 hours | Notify engineering lead |
| Warning | 24 hours | Create ticket, schedule review |
| Recurring (3+ in 24h) | Any | Escalate to CTO regardless of severity |

### On-Call Responsibilities

- Respond to critical alerts within SLA
- Maintain runbook access
- Document all actions in incident log
- Handoff properly during shift changes

---

## Post-Incident Review

For all critical alerts and recurring warnings:

### Post-Mortem Template

1. **Summary** - What happened, when, impact
2. **Timeline** - Chronology of detection → response → resolution
3. **Root Cause** - Technical and process factors
4. **Impact** - Users affected, duration, metrics
5. **Actions Taken** - Immediate fixes applied
6. **Follow-ups** - Tasks to prevent recurrence
7. **Alert Review** - Were alerts appropriate? Snooze decisions?

### Alert Effectiveness Review

Monthly review of alert patterns:
- Which alerts triggered most frequently?
- Which were false positives?
- Are thresholds set correctly?
- Are snoozes being misused?

Adjust alert configurations based on findings.

---

## Monitoring Dashboard Guide

### Access

- URL: `/admin/monitoring`
- Requires admin role
- Auto-refresh every 60 seconds

### Sections

1. **Metrics Overview** - Current storage, query performance, counts
2. **Active Alerts** - Alerts needing attention
   - Acknowledge button (mark as seen)
   - Resolve button (mark fixed)
3. **Silenced Alerts** - Currently snoozed configurations
   - Shows expiry time
   - Cancel Snooze to re-enable early
4. **Alert Configurations** - Table of all alert rules
   - Quick snooze buttons (1h/6h/24h)
   - Status indicator (enabled/snoozed)

### Keyboard Shortcuts

- `R` - Refresh data
- `A` - Acknowledge selected alert
- `S` - Snooze selected alert (prompts for duration)
- `ESC` - Deselect

---

## API Reference

### Snooze Management

```typescript
// List active snoozes
GET /api/monitoring/d1/snoozes

// Create snooze
POST /api/monitoring/d1/snoozes
Body: {
  alertConfigId: string,
  durationMinutes: 60 | 360 | 1440,
  reason?: string
}

// Cancel snooze
DELETE /api/monitoring/d1/snoozes/[id]

// Cleanup expired (cron)
POST /api/monitoring/d1/snoozes/cleanup
```

### Alert Management

```typescript
// Acknowledge alert
POST /api/monitoring/d1
Body: { action: 'acknowledge', alertId: string }

// Resolve alert
POST /api/monitoring/d1
Body: { action: 'resolve', alertId: string }

// Run monitoring cycle
POST /api/monitoring/d1
(no body)

// Get current status
GET /api/monitoring/d1?run=true
```

---

## Runbook References

- [Admin Dashboards Guide](../admin-dashboards.md)
- [Operational Runbook](../operational-runbook.md)
- [Deployment Runbook](../deployment-runbook.md)
- [Alerting Quick Reference](./alerting-quick-reference.md)
- [Monitoring Setup](./monitoring-setup.md)

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2026-06-22 | 1.0 | Initial alert response procedures |
