# ApexOS Operational Runbook

**Version:** 1.0
**Last Updated:** 2026-06-22
**Application:** ApexOS - Global Crypto Cashback & Affiliate Hub
**Platform:** Cloudflare Pages + D1 + Workers

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Health Checks](#health-checks)
3. [Monitoring](#monitoring)
4. [Incident Response](#incident-response)
5. [Daily Operations](#daily-operations)
6. [Maintenance Procedures](#maintenance-procedures)
7. [Backup & Restore](#backup--restore)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Deployment Procedures](#deployment-procedures)
10. [Emergency Contacts](#emergency-contacts)

---

## System Overview

### Architecture

ApexOS is a full-stack SaaS platform built with:

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Frontend** | Next.js 16 (App Router) + React 18 | User interface, i18n support |
| **Backend** | Cloudflare Workers (via OpenNext) | Serverless API endpoints |
| **Database** | Cloudflare D1 (SQLite) | User data, affiliate tracking, earnings |
| **Cache** | Cloudflare KV | Session data, rate limiting |
| **Storage** | Cloudflare R2 | File uploads (deal images, avatars) |
| **Auth** | Better Auth 0.8.7 | Authentication with custom D1 adapter |
| **Email** | Resend API | Transactional emails |
| **Payments** | Stellar USDC, Polar, SePay | Payouts and subscriptions |
| **i18n** | next-intl | Vietnamese & English localization |

### Core Features

- Multi-level affiliate system (3 tiers: 30%/10%/5%)
- Exchange trade webhook processing (Binance, Bybit)
- Click attribution with 30-day cookie window
- Automated weekly Stellar USDC payouts
- Admin dashboard for deal management
- Real-time earnings tracking

### Key URLs

| Environment | URL |
|-------------|-----|
| Production | https://apex-os.pages.dev |
| Staging | (configured separately) |
| Health Endpoint | `/api/health` (GET) |

---

## Health Checks

### Health Endpoint Specification

**Endpoint:** `GET /api/health`

**Expected Response (200 OK):**

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

**Status Values:**

| Status | Meaning | Action |
|--------|---------|--------|
| `ok` | All systems operational | Normal operation |
| `degraded` | Database or KV connection issue | Investigate, may affect functionality |
| `error` | Critical failure | Immediate investigation required |

**Response Codes:**

| Code | Meaning |
|------|---------|
| 200 | Healthy |
| 503 | Service Unavailable |

### Health Check Commands

```bash
# Quick check
curl -f https://apex-os.pages.dev/api/health

# Detailed check with timing
curl -w "\nHTTP: %{http_code}\nTime: %{time_total}s\n" \
  https://apex-os.pages.dev/api/health

# Local check with Wrangler
wrangler dev &
curl http://localhost:8787/api/health
```

### Automated Health Monitoring

Health checks are configured via:

| Service | Interval | Alert Threshold |
|---------|----------|-----------------|
| UptimeRobot | 1 minute | 5 consecutive failures |
| Pingdom | 1 minute | 5 minutes |
| Cloudflare Analytics | 1 minute | Error rate >5% |

---

## Monitoring

### Monitoring Stack

1. **UptimeRobot** (primary) - Free, 1-minute intervals
2. **Pingdom** (secondary) - Synthetic transactions
3. **Cloudflare Analytics** - Built-in edge metrics
4. **D1 Monitoring** - Database-specific metrics via cron

### Key Metrics to Monitor

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Uptime | 99.9% | <99% over 24h |
| Response Time (P95) | <1000ms | >2000ms |
| Error Rate | <1% | >5% over 5min |
| Database Connection | Healthy | Any failure |
| KV Connection | Healthy | Any failure |
| Payout Queue Size | <100 | >500 pending |

### Setting Up Monitoring

Refer to `docs/monitoring-setup.md` for detailed setup instructions.

### Quick Setup

```bash
# Run the interactive setup script
./scripts/setup-monitoring.sh --all

# Test health endpoint
./scripts/test-health.sh --iterations 10
```

### Dashboards

| Dashboard | Purpose | Access |
|-----------|---------|--------|
| Cloudflare Analytics | Request rate, errors, response time | Cloudflare Dashboard → Pages → Analytics |
| UptimeRobot | Uptime %, downtime history | UptimeRobot.com |
| D1 Metrics | Database query performance | See `docs/d1-monitoring.md` |

---

## Incident Response

### Incident Severity Levels

| Level | Definition | Response Time | Notification |
|-------|------------|---------------|--------------|
| **P0** | Service completely down, all users affected | Immediate (0-5 min) | All channels, PagerDuty |
| **P1** | Core functionality degraded, major impact | 15 minutes | Slack, SMS |
| **P2** | Non-critical feature down, limited impact | 30 minutes | Email, Slack |
| **P3** | Minor issues, no user impact | 2 hours | Email |

### Incident Response Playbook

#### P0/P1 Incident (Service Down)

1. **Acknowledge** alert within 5 minutes
2. **Assess** impact:
   ```bash
   curl -f https://apex-os.pages.dev/api/health
   wrangler pages deployment list --project-name apex-os
   ```
3. **Check** recent deployments - rollback if suspect:
   ```bash
   wrangler pages deployment rollback --project-name apex-os <deployment-id>
   ```
4. **Verify** database connectivity:
   ```bash
   wrangler d1 execute apex-os-db --command "SELECT 1"
   ```
5. **Check** Cloudflare status page for platform issues
6. **Communicate**:
   - Post to `#infra-alerts` Slack
   - Update status page if available
   - Notify stakeholders for P0
7. **Resolve** and verify recovery
8. **Post-mortem** within 24 hours for P0

#### P2 Incident (Degraded Performance)

1. Check health endpoint status (`degraded` vs `error`)
2. Review Cloudflare Analytics for traffic spikes
3. Check D1 query performance (slow queries)
4. Consider scaling or optimization
5. Document findings

### Common Incident Scenarios

| Scenario | Likely Cause | First Action |
|----------|--------------|--------------|
| Health endpoint returns HTML | Pages routing issue | Check `_routes` and middleware |
| Database connection errors | D1 outage or misconfiguration | Verify D1 binding in wrangler.toml |
| High error rate | Recent deployment bug | Rollback to previous deployment |
| Slow response times | Cold start or query issues | Check logs, add warmup requests |
| Webhook failures | Exchange API changes | Check webhook logs, verify signature |

---

## Daily Operations

### Daily Health Checks

**Morning Checklist (9 AM local):**

- [ ] Review overnight alerts
- [ ] Check uptime statistics (last 24h)
- [ ] Verify payout cron executed (if Sunday)
- [ ] Review D1 storage usage
- [ ] Check error logs for patterns

```bash
# Get yesterday's uptime from UptimeRobot API
# Check D1 size
wrangler d1 execute apex-os-db --command "PRAGMA page_count;"

# Review recent errors
wrangler pages deployment tail --project-name apex-os --since 24h
```

### Weekly Tasks

**Monday:**

- Review weekly monitoring reports
- Check payout batch status (if ran Sunday)
- Review user feedback and support tickets

**Wednesday:**

- Test alert notifications (simulate failure)
- Review database growth trends
- Check R2 storage usage

**Friday:**

- Review week's deployments
- Update incident runbook with any new scenarios
- Plan weekend on-call coverage

### Monthly Tasks

- Test full incident response drill
- Review and update monitoring thresholds
- Audit environment variables for rotation needs
- Check Cloudflare billing and usage limits
- Review and prune old KV entries
- Verify backup integrity

---

## Maintenance Procedures

### Database Maintenance

#### Check Database Size

```bash
# Get database stats
wrangler d1 execute apex-os-db --command "
  SELECT
    (page_count * page_size) / 1024 / 1024 as size_mb
  FROM pragma_page_count(), pragma_page_size();
"
```

#### Run VACUUM (if needed)

```bash
# Export, recreate, and import for size optimization
wrangler d1 export apex-os-db --output backup-full.sql
# Manual: recreate DB and import
```

#### Check for Slow Queries

```bash
# Enable SQLite stats (requires schema changes)
# Add query log table if not present
```

### KV Maintenance

#### List and Cleanup Old Keys

```bash
# List all keys (paginated)
wrangler kv:key list --binding=KV --limit 1000

# Delete expired session keys (example pattern)
# Note: KV doesn't have TTL deletion API, must track expiration in app
```

#### Monitor KV Usage

```bash
# Check KV namespace details
wrangler kv namespace list
```

### R2 Maintenance

#### Check Storage Usage

```bash
# List objects with size
wrangler r2 object list apex-os-uploads --json | jq 'map(.size) | add'
```

#### Cleanup Orphaned Files

```bash
# List and delete old uploads (>90 days)
# Implement application-level cleanup job
```

### Cache Invalidation

```bash
# Clear KV cache (use cautiously)
wrangler kv:key delete --binding=KV session:*

# Clear specific cache keys
wrangler kv:key delete --binding=KV deals:list:*
```

---

## Backup & Restore

### Database Backups

#### Automated Daily Backup

Configure cron to run daily:

```bash
# In Cloudflare Dashboard → Pages → Cron (or wrangler.toml)
# Daily at 2 AM UTC
0 2 * * * wrangler d1 export apex-os-db --output s3://backups/apex-os-$(date +\%Y\%m\%d).sql
```

#### Manual Backup

```bash
# Full export
wrangler d1 export apex-os-db --output backup-$(date +%Y%m%d-%H%M%S).sql

# Export with schema only
wrangler d1 execute apex-os-db --command ".schema" > schema-$(date +%Y%m%d).sql
```

#### Restore from Backup

```bash
# Create new database from backup
wrangler d1 create apex-os-restore-$(date +%Y%m%d)

# Import backup
wrangler d1 execute apex-os-restore-$(date +%Y%m%d) --file backup-20260622.sql

# Verify and swap if good
# Update wrangler.toml database_id and redeploy
```

### KV Backups

KV uses durable storage with automatic replication. For critical data:

```bash
# Export all keys (requires app logic as KV has no bulk export)
# Consider storing critical KV data in D1 instead
```

### R2 Backups

```bash
# Sync to another bucket (cross-region)
wrangler r2 bucket create apex-os-backups-eu
wrangler r2 sync apex-os-uploads apex-os-backups-eu

# Or copy specific objects
wrangler r2 object cp apex-os-uploads/path/file.jpg apex-os-backups/path/file.jpg
```

---

## Troubleshooting Guide

### Health Endpoint Issues

#### Symptom: Returns HTML instead of JSON

**Cause:** Next.js locale middleware intercepting API routes.

**Fix:**
1. Ensure `src/middleware.ts` exists with API bypass
2. Verify middleware config:
   ```bash
   cat src/middleware.ts
   ```
3. Redeploy:
   ```bash
   pnpm build
   wrangler pages deploy .open-next
   ```

#### Symptom: 404 Not Found

**Cause:** API route missing or Pages routing misconfiguration.

**Fix:**
1. Check route exists:
   ```bash
   ls src/app/api/health/
   ```
2. Verify `_routes` file in `.open-next/`:
   ```
   /api/*    cloudflare_workers
   ```
3. Redeploy

### Database Issues

#### Symptom: "D1 database not found"

**Fix:**
```bash
# Check database exists
wrangler d1 list

# If missing, recreate
wrangler d1 create apex-os-db
# Update wrangler.toml with new database_id
```

#### Symptom: "Table does not exist"

**Fix:**
```bash
# Run migrations
wrangler d1 execute apex-os-db --file src/database/migrations/003_affiliate_schema.sql
```

#### Symptom: Slow queries

**Diagnosis:**
```bash
# Enable query logging (requires code change)
# Add EXPLAIN to queries in development
```

**Fix:**
- Add indexes for frequently queried columns
- Review query patterns in `src/lib/tracking/matcher.ts`

### Webhook Failures

#### Symptom: Webhook endpoint returns 404

**Fix:**
1. Verify route exists: `src/app/api/webhooks/exchange/route.ts`
2. Check Pages routing doesn't block the path
3. Test locally:
   ```bash
   wrangler dev
   curl -X POST http://localhost:8787/api/webhooks/exchange/binance \
     -H "Content-Type: application/json" \
     -d '{"test": true}'
   ```

#### Symptom: HMAC verification fails

**Fix:**
1. Verify webhook secret matches exchange configuration
2. Check signature header name (Binance: `X-Binance-Signature`, Bybit: `X-Bybit-Signature`)
3. Ensure raw body is used for HMAC (don't parse JSON first)

### Authentication Issues

#### Symptom: "BETTER_AUTH_SECRET must be 32+ characters"

**Fix:**
```bash
openssl rand -base64 32
# Update .env.local and Cloudflare Pages env vars
```

#### Symptom: OAuth redirect URI mismatch

**Fix:** Add to OAuth provider:
```
https://apex-os.pages.dev/api/auth/callback/[provider]
```

### Build/Deployment Issues

#### Symptom: Build fails with OpenNext errors

**Fix:**
```bash
# Clean and reinstall
rm -rf node_modules .next .open-next
pnpm install

# Verify Node version
node --version  # Should be 18 or 20

# Build
pnpm build
```

#### Symptom: Images not loading

**Fix:** Ensure `next.config.js` has:
```javascript
images: {
  unoptimized: true,
}
```

---

## Deployment Procedures

### Gate-on-Every-Deploy Doctrine (Mandatory)

Every staging and production deployment **must** pass `npm run gate` (`scripts/go-live-gate.sh`, gates `G0`–`G5`) before and after deployment. Never bypass TypeScript checks (`tsc --noEmit`), ESLint (`--max-warnings 0`), or Staging D1 isolation (`scripts/assert-staging-isolation.sh`). Always invoke the repository-pinned `wrangler` binary (`./node_modules/.bin/wrangler`) under Node `26.7.0`.

See also:
- `docs/cutover-runbook.md` — T-1h to T+first-payout production cutover & historical payout reconciliation (`npm run reconcile:payouts`)
- `docs/rollback-runbook.md` — 1-command instant Worker rollback
- `docs/go-live-checklist.md` — G0–G5 audit matrix

### Pre-Deployment Checklist

```bash
export PATH=/opt/homebrew/opt/node@26/bin:$(pwd)/node_modules/.bin:$PATH
node --version                                # Expect v26.7.0

# 1. Run the unified G0-G5 Go-Live Gate (includes tsc, eslint, staging D1 isolation, money invariants)
GATE_SHA=$(git rev-parse HEAD) npm run gate

# 2. Run full test suite
CI=true npm test

# 3. Build Cloudflare Worker bundle via OpenNext
npm run build:worker
ls -la .open-next/worker.js
```

### Deployment Methods

#### Method 1: Pinned OpenNext + Wrangler Scripts (Recommended)

```bash
# Deploy to Staging (runs assert-staging-isolation.sh + build:worker + deploy)
npm run deploy:staging
bash scripts/verify-deployment.sh https://staging.apex-os.com $(git rev-parse HEAD)

# Deploy to Production
npm run deploy:production
GATE_SHA=$(git rev-parse HEAD) GATE_URL=https://apex-os.com npm run gate
bash scripts/verify-deployment.sh https://apex-os.com $(git rev-parse HEAD)
```

#### Method 2: GitHub Actions CI/CD (`.github/workflows/deploy.yml`)

1. Push to `main`/`master` or trigger `workflow_dispatch` on `.github/workflows/deploy.yml`.
2. Staging deploys first (`apex-os-staging`), runs `scripts/verify-deployment.sh`, and gates Production (`apex-os`).

### Post-Deployment Verification

```bash
# 1. Verify live SHA and protected-route smoke tests
bash scripts/verify-deployment.sh https://apex-os.com $(git rev-parse HEAD)

# 2. Check /api/version and /api/health
curl -fsSL https://apex-os.com/api/version
curl -fsSL https://apex-os.com/api/health
```

### Rollback Procedures

```bash
# List recent Worker deployments using the pinned wrangler binary
./node_modules/.bin/wrangler deployments list --config wrangler.jsonc

# Instant rollback to previous Worker deployment
./node_modules/.bin/wrangler rollback --config wrangler.jsonc -y

# Verify post-rollback health and protected routes
bash scripts/verify-deployment.sh https://apex-os.com
```

---

## Emergency Contacts

### Internal

| Role | Contact | Escalation |
|------|---------|------------|
| DevOps On-Call | devops@apex-os.com | P0 → SMS/Phone |
| Engineering Manager | em@apex-os.com | P1+ |
| CTO | cto@apex-os.com | P0 only |
| Founder | founder@apex-os.com | P0 only |

### External Support

| Service | Support | URL |
|---------|---------|-----|
| Cloudflare | 24/7 support (enterprise) | https://support.cloudflare.com/ |
| OpenNext | GitHub Issues | https://github.com/opennextjs/opennext/issues |
| Better Auth | Discord | https://discord.gg/better-auth |

### Communication Channels

- **Primary:** `#infra-alerts` on Slack
- **Secondary:** `#general` for status updates
- **Incident:** `#incident-response` for active incidents
- **Status Page:** https://status.apex-os.com (if configured)

---

## Quick Reference

### Essential Commands

```bash
# Development
pnpm dev                    # Start dev server
pnpm build                 # Production build
pnpm lint                  # Lint check
pnpm test                  # Run tests

# Wrangler
wrangler dev              # Local Workers dev
wrangler pages deploy     # Deploy to Pages
wrangler d1 list          # List databases
wrangler d1 execute DB --command "SQL"  # Run SQL

# Monitoring
curl https://apex-os.pages.dev/api/health
./scripts/test-health.sh
./scripts/setup-monitoring.sh --all

# Logs
wrangler pages deployment tail --project-name apex-os
```

### Important URLs

| Resource | URL |
|----------|-----|
| Production App | https://apex-os.pages.dev |
| Cloudflare Dashboard | https://dash.cloudflare.com/pages |
| UptimeRobot | https://uptimerobot.com/dashboard |
| Status Page | (to be configured) |
| Runbooks | `docs/deployment-runbook.md`, `docs/operational-runbook.md`, `docs/admin-dashboards.md` |

### Environment Variables Checklist

| Variable | Required | Purpose |
|----------|----------|---------|
| BETTER_AUTH_SECRET | Yes | Auth encryption |
| NEXT_PUBLIC_APP_URL | Yes | OAuth callbacks |
| RESEND_API_KEY | Yes | Email delivery |
| STELLAR_SECRET_KEY | Yes | Payouts |
| BINANCE_WEBHOOK_SECRET | Yes | Trade verification |
| BYBIT_WEBHOOK_SECRET | Yes | Trade verification |
| POLAR_ACCESS_TOKEN | Optional | Subscriptions |
| SEPAY_MERCHANT_ID | Optional | Vietnam payments |

---

## Appendix

### Runbook Maintenance

This runbook should be reviewed:

- **Weekly:** Verify health endpoint accessibility and monitoring alerts
- **Monthly:** Update contact information, test alert channels
- **Quarterly:** Review and update procedures based on incidents
- **After each incident:** Document new scenarios and update playbooks

### Document Versions

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-06-22 | Initial operational runbook |

---

**Remember:** When in doubt, check the health endpoint first, review recent deployments, and communicate early.
