# ApexOS Deployment Runbook

**Last Updated:** 2026-06-21
**Target Platform:** Cloudflare Pages
**Application:** Next.js 16 + TypeScript + OpenNext Adapter

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Cloudflare Account Setup](#cloudflare-account-setup)
4. [Environment Variables](#environment-variables)
5. [Database Provisioning (D1)](#database-provisioning-d1)
6. [KV Namespace Setup](#kv-namespace-setup)
7. [R2 Bucket Setup](#r2-bucket-setup)
8. [wrangler.toml Configuration](#wranglertoml-configuration)
9. [Build Configuration](#build-configuration)
10. [Deployment Steps](#deployment-steps)
11. [Cron Jobs Configuration](#cron-jobs-configuration)
12. [Webhook Configuration](#webhook-configuration)
13. [Monitoring & Health Checks](#monitoring--health-checks)
14. [Troubleshooting](#troubleshooting)
15. [Rollback Procedures](#rollback-procedures)
16. [Security Checklist](#security-checklist)

---

## Overview

ApexOS is a global crypto cashback and affiliate hub built with Next.js 16 App Router. The application uses Cloudflare Workers for serverless execution, D1 (SQLite) for database, KV for caching, and R2 for file storage.

**Architecture:**
- Frontend: Next.js 16 (App Router) + React 18 + Tailwind CSS
- Auth: Better Auth with custom D1 adapter
- i18n: next-intl (Vietnamese/English)
- Database: Cloudflare D1 (SQLite)
- Cache: Cloudflare KV
- Storage: Cloudflare R2
- Email: Resend API
- Payouts: Stellar USDC (stellar-sdk)
- Payments: Polar (international), SePay (Vietnam)

---

## Prerequisites

### Required Tools

```bash
# Install Node.js 18+ (LTS recommended)
node --version  # should be >= 18.x

# Install pnpm
npm install -g pnpm

# Install Wrangler CLI
npm install -g wrangler

# Verify installations
node --version
pnpm --version
wrangler --version
```

### Cloudflare Account

- Active Cloudflare account with Pages enabled
- API token with appropriate permissions (see Cloudflare Account Setup)
- Domain configured for Pages deployment (optional for initial deployment)

---

## Cloudflare Account Setup

### 1. Create API Token

Navigate to: `https://dash.cloudflare.com/profile/api-tokens`

Create a new token with the following permissions:

| Resource | Permissions |
|-----------|-------------|
| Account | `Account.Info` (Read) |
| Pages | `Pages.Read`, `Pages.Write`, `Pages.Delete` |
| Worker & Pages | `Worker & Pages Scripts.Modify`, `Worker & Pages Scripts.Read` |
| D1 | `D1.Read`, `D1.Write` |
| R2 | `R2.Read`, `R2.Write`, `R2.List` |
| KV | `KV.Read`, `KV.Write` |

Save the token as `CLOUDFLARE_API_TOKEN` in your environment.

### 2. Get Account ID

```bash
# Option 1: From Wrangler
wrangler whoami

# Option 2: From Cloudflare Dashboard
# URL pattern: https://dash.cloudflare.com/{account-id}
```

Save as `CLOUDFLARE_ACCOUNT_ID`.

---

## Environment Variables

### Required Variables

Create `.env.local` in the project root with the following variables:

#### Authentication

```bash
# Better Auth secret (generate: openssl rand -base64 32)
BETTER_AUTH_SECRET=your-32-char-base64-secret

# Optional: Better Auth encryption key (for sensitive data)
BETTER_AUTH_ENCRYPTION_KEY=your-32-char-base64-key
```

#### App Configuration

```bash
# Base URL of your deployed app (required for OAuth callbacks, email links)
NEXT_PUBLIC_APP_URL=https://your-app.pages.dev

# Site URL (for SEO, canonical links)
NEXT_PUBLIC_SITE_URL=https://your-domain.com
```

#### Database

```bash
# D1 database binding (auto-configured by wrangler, not needed in .env.local)
# Used only for local development if needed
D1_DATABASE=apex-os-db
```

#### Email (Resend)

```bash
# Resend API key (from https://resend.com/api-keys)
RESEND_API_KEY=re_your_resend_key_here

# From email address (must be verified in Resend)
NEXT_PUBLIC_SENDER_EMAIL=noreply@yourdomain.com

# Support email (displayed to users)
NEXT_PUBLIC_SUPPORT_EMAIL=support@yourdomain.com
```

#### Payments - Polar (International)

```bash
# Polar access token (from https://polar.sh/settings/api)
POLAR_ACCESS_TOKEN=polar_your_token_here

# Polar webhook secret (set in Polar webhook config)
POLAR_WEBHOOK_SECRET=your_polar_webhook_secret

# Polar organization ID
POLAR_ORGANIZATION_ID=org_your_id
```

#### Payments - SePay (Vietnam)

```bash
# SePay merchant ID (from SePay merchant dashboard)
SEPAY_MERCHANT_ID=your_sepay_merchant_id

# SePay secret key (from SePay API settings)
SEPAY_SECRET_KEY=your_sepay_secret_key

# SePay API base URL (sandbox or production)
SEPAY_API_URL=https://api.sepay.vn  # or sandbox URL
```

#### Exchange Webhooks

```bash
# Binance webhook secret (configured in Binance API settings)
BINANCE_WEBHOOK_SECRET=your_binance_webhook_secret

# Bybit webhook secret (configured in Bybit API settings)
BYBIT_WEBHOOK_SECRET=your_bybit_webhook_secret

# Optional: OKX webhook secret
OKX_WEBHOOK_SECRET=your_okx_webhook_secret

# Optional: KuCoin webhook secret
KUCOIN_WEBHOOK_SECRET=your_kucoin_webhook_secret
```

#### AI/ML Services

```bash
# Anthropic Claude API (for AI features)
ANTHROPIC_API_KEY=sk-ant-your-key-here

# OpenAI API (optional, for alternative AI features)
OPENAI_API_KEY=sk-your-openai-key-here
```

#### Redis (Optional - for production caching)

```bash
# Redis connection URL (Cloudflare Workers does not need this locally)
# If using external Redis for dev: REDIS_URL=redis://localhost:6379
# On Cloudflare Pages, KV is used instead
```

#### Stellar Payouts

```bash
# Stellar secret key (for USDC payouts)
# Generate from Stellar wallet - keep secure!
STELLAR_SECRET_KEY=Gyour_stellar_secret_key_here

# Stellar network: 'testnet' or 'mainnet'
STELLAR_NETWORK=testnet

# USDC issuer address (varies by network)
# Testnet: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGZX3UJFD3D5KKTO234QQ
STELLAR_USDC_ISSUER=Gyour_usdc_issuer_here

# USDC asset code
STELLAR_USDC_CODE=USDC

# Horizon server URL (optional - defaults based on network)
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
```

#### Analytics & Monitoring

```bash
# Optional: PostHog analytics
NEXT_PUBLIC_POSTHOG_KEY=your_posthog_key
NEXT_PUBLIC_POSTHOG_HOST=https://us.posthog.com

# Optional: Sentry error tracking
NEXT_PUBLIC_SENTRY_DSN=https://your_sentry_dsn

# Optional: Google Analytics
NEXT_PUBLIC_GA_ID=G-XXXXXXXXXX
```

#### Feature Flags

```bash
# Enable/disable features (comma-separated list or 'true' for all)
NEXT_PUBLIC_ENABLED_FEATURES=affiliate-cashback,payouts,admin-panel

# Maintenance mode
NEXT_PUBLIC_MAINTENANCE_MODE=false
```

### Production Secrets (Cloudflare Dashboard)

For production, set these in the Cloudflare Pages dashboard under **Project Settings > Environment Variables**:

- Set `NODE_VERSION` to `18` or `20`
- Mark all secrets as **Sensitive** (encrypted)
- Production environment: all variables above except development-specific ones

---

## Database Provisioning (D1)

### 1. Create D1 Database

```bash
# Create the database
wrangler d1 create apex-os-db

# Expected output:
# {
#   "account_id": "your-account-id",
#   "database_id": "xxxx-xxxx-xxxx-xxxx",
#   "database_name": "apex-os-db"
# }
```

### 2. Update wrangler.toml

Replace the `database_id` in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "apex-os-db"
database_id = "xxxx-xxxx-xxxx-xxxx"  # Replace with actual ID
```

### 3. Apply Database Schema

```bash
# Run initial schema migrations
wrangler d1 execute apex-os-db --file src/database/migrations/001_initial_schema.sql
wrangler d1 execute apex-os-db --file src/database/migrations/002_auth_tables.sql
wrangler d1 execute apex-os-db --file src/database/migrations/003_affiliate_schema.sql

# Or run all migrations in order
for file in src/database/migrations/*.sql; do
  echo "Running $file..."
  wrangler d1 execute apex-os-db --file "$file"
done
```

### 4. Verify Schema

```bash
# List all tables
wrangler d1 execute apex-os-db --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

# Expected output includes:
# - profiles
# - accounts (Better Auth)
# - sessions (Better Auth)
# - verification_tokens (Better Auth)
# - affiliate_codes
# - referral_tree
# - deals
# - deal_clicks
# - conversions
# - earnings
# - payouts
```

### 5. Seed Initial Data (Optional)

```bash
# Create admin user
wrangler d1 execute apex-os-db --command "
  INSERT INTO profiles (id, email, role, created_at)
  VALUES ('admin-uuid', 'admin@yourdomain.com', 'admin', datetime('now'));
"
```

---

## KV Namespace Setup

KV is used for caching session data, rate limiting, and temporary tokens.

### 1. Create KV Namespace

```bash
wrangler kv namespace create apex-os-cache

# Expected output:
# {
#   "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
#   "title": "apex-os-cache"
# }
```

### 2. Update wrangler.toml

```toml
[[kv_namespaces]]
binding = "KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### 3. Test KV Access

```bash
# Write a test value
wrangler kv:key put --binding=KV test-key "test-value"

# Read the value
wrangler kv:key get --binding=KV test-key

# Delete the test key
wrangler kv:key delete --binding=KV test-key
```

---

## R2 Bucket Setup

R2 is used for storing uploaded files (deal images, user avatars, documents).

### 1. Create R2 Bucket

```bash
wrangler r2 bucket create apex-os-uploads

# Optional: Set CORS for public access
cat > cors.json << EOF
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST"],
    "AllowedOrigins": ["https://your-domain.com"],
    "ExposeHeaders": [],
    "MaxAgeSeconds": 3000
  }
]
EOF

wrangler r2 bucket cors add apex-os-uploads -- cors.json
```

### 2. Update wrangler.toml

```toml
[[r2_buckets]]
binding = "STORAGE"
bucket_name = "apex-os-uploads"
```

### 3. Test R2 Access

```bash
# Upload a test file
echo "test content" > test.txt
wrangler r2 object put apex-os-uploads test.txt --file test.txt

# List objects
wrangler r2 object list apex-os-uploads

# Delete test object
wrangler r2 object delete apex-os-uploads test.txt
```

---

## wrangler.toml Configuration

Complete reference for `wrangler.toml`:

```toml
# ApexOS - Cloudflare Workers Configuration
# Generated for Cloudflare Pages with OpenNext adapter

name = "apex-os"
main = ".open-next/worker.js"
compatibility_date = "2024-04-10"
compatibility_flags = ["nodejs_compat"]

# Build configuration
[build]
command = "pnpm build"
# Output directory from OpenNext
# Contains: worker.js, static/, functions/, _routes

# Environment variables for build
[build.environment]
NODE_VERSION = "20"
NEXT_TELEMETRY_DISABLED = "1"

# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "apex-os-db"
database_id = "YOUR_DATABASE_ID_HERE"

# KV Namespace (caching, rate limiting)
[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_NAMESPACE_ID_HERE"

# R2 Bucket (file storage)
[[r2_buckets]]
binding = "STORAGE"
bucket_name = "apex-os-uploads"

# Cron Triggers
[triggers]
crons = [
  "0 0 * * 0",    # Weekly payouts: Sunday at 00:00 UTC
  "*/30 * * * *", # Health check every 30 minutes
]

# Route configuration (for Pages)
# Pages automatically routes all requests to worker.js
# Customize with _routes file if needed

# Pages deployment configuration
[site]
bucket = ".open-next/static"
```

### _routes File (Optional)

Create `.open-next/_routes` to control routing behavior:

```
# Static assets are cached
/static/*  cache_override
/assets/*  cache_override
/_next/static/*  cache_override

# API routes go to worker
/api/*    cloudflare_workers

# All other routes (SPA fallback) go to worker
/*        cloudflare_workers
```

---

## Build Configuration

### OpenNext Configuration (`open-next.config.ts`)

```typescript
import { defineCloudflareConfig } from '@opennextjs/cloudflare'

export default defineCloudflareConfig({
  // Optional: Configure asset prefix for CDN
  // assetPrefix: '/_next',

  // Optional: Override default output directory
  // outDir: '.open-next',

  // Optional: Exclude routes from static generation
  // exclude: ['/admin/*', '/api/admin/*'],

  // Optional: Set max workers for build
  // maxWorkers: 4,
})
```

### Next.js Configuration (`next.config.js`)

Current configuration:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true, // Required for Cloudflare Pages
  },
  async redirects() {
    return [
      { source: '/', destination: '/vi', permanent: false },
    ]
  },
}

module.exports = nextConfig
```

**Important Notes:**
- `images.unoptimized: true` is required because Cloudflare does not support Next.js image optimization
- For external images, use `<Image src="https://..." unoptimized />` or configure `remotePatterns`

---

## Deployment Steps

### 1. Pre-Deployment Checklist

```bash
# Verify all environment variables are set
cat .env.local | grep -v '^#' | grep '='

# Run linting
pnpm lint

# Run tests
pnpm test

# Build locally to verify
pnpm build

# Verify build output exists
ls -la .next/static/
```

### 2. Deploy via Wrangler (Direct)

```bash
# Deploy to production (requires Cloudflare Pages project)
wrangler pages deploy .open-next --project-name apex-os

# Or with branch name (preview deployment)
wrangler pages deploy .open-next --branch feature-branch
```

### 3. Deploy via Git (Recommended)

1. Push code to GitHub repository
2. In Cloudflare Dashboard:
   - Navigate to **Pages** → **Create a project** or select existing
   - Connect your GitHub repository
   - Configure build settings:
     - **Build command:** `pnpm build`
     - **Build output directory:** `.open-next`
     - **Environment variables:** Add all required variables from above
   - Click **Save and Deploy**

3. Cloudflare will:
   - Install dependencies (`pnpm install`)
   - Run build command (`pnpm build`)
   - Deploy the `.open-next` directory

### 4. Post-Deployment Verification

```bash
# 1. Check deployment status
wrangler pages deployment list --project-name apex-os

# 2. Get deployment URL
wrangler pages deployment show-latest --project-name apex-os

# 3. Test health endpoint
curl https://your-app.pages.dev/api/health

# Expected: {"status":"ok","timestamp":"..."}

# 4. Test admin login
curl -X POST https://your-app.pages.dev/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@yourdomain.com","password":"test"}'
```

### 5. Admin Dashboard Setup

After deployment, configure admin access and dashboards:

#### Create Admin User

If no admin user exists, create one via D1 CLI:

```bash
# First, create a regular user account via signup
# Then assign admin role:
wrangler d1 execute apex-os-db --command "
  UPDATE profiles
  SET role = 'admin'
  WHERE email = 'admin@yourdomain.com';
"
```

Or via API (with existing admin session):

```bash
curl -X POST https://your-app.pages.dev/api/admin/users/[user-id]/role \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}' \
  --cookie "__session=YOUR_SESSION_COOKIE"
```

#### Verify Admin Access

1. Log in at `https://your-app.pages.dev/vi/login`
2. Navigate to admin dashboards:
   - Metrics: `/vi/admin/metrics`
   - Alerts: `/vi/admin/alerts`
   - Analytics: `/vi/admin/analytics`
   - Deals: `/vi/admin/deals`
   - Affiliates: `/vi/admin/affiliates`
   - Health: `/vi/admin/health`

**Documentation:** See [`docs/admin-dashboards.md`](./admin-dashboards.md) for complete user guide.

#### Configure Alert Notification Channels

The alert system supports multiple notification channels. Configure in Cloudflare Pages environment variables:

**Email Notifications (Resend):**

```bash
# In Cloudflare Dashboard → Pages → Project → Settings → Environment Variables
ALERT_EMAIL_ENABLED=true
ALERT_EMAIL_SENDER=noreply@yourdomain.com
RESEND_API_KEY=re_your_resend_key
```

**Slack Notifications:**

```bash
ALERT_SLACK_ENABLED=true
ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
ALERT_SLACK_CHANNEL=#alerts-critical
```

**Polar Notifications (for subscription alerts):**

```bash
ALERT_POLAR_ENABLED=true
POLAR_ACCESS_TOKEN=your_polar_token
POLAR_WEBHOOK_SECRET=your_webhook_secret
```

After setting environment variables, redeploy the application.

**Test Alert Notifications:**

```bash
# Trigger test alert via API
curl -X POST https://your-app.pages.dev/api/monitoring/alert-engine/test \
  -H "Content-Type: application/json" \
  -d '{"severity": "warning", "type": "test", "message": "Test alert notification"}'
```

#### View Metrics Dashboard

The Metrics Dashboard (`/admin/metrics`) provides business intelligence:

- Date range selection (last 30 days default)
- KPI cards: revenue, conversions, conversion rate, active affiliates
- Revenue trend chart (line chart)
- Conversion funnel visualization
- Top deals table

**Data Source:** `GET /api/metrics/business` (cached for 5 minutes)

For API documentation, see [`docs/api/metrics-api.md`](../api/metrics-api.md).

#### Set Up Alert Monitoring

The built-in alert engine monitors:

- Database storage usage (>80% threshold)
- Slow queries (>1s average)
- High error rates (>5%)
- Payout queue size (>500 pending)

Access the Alerts Dashboard at `/admin/alerts` to:
- View active, acknowledged, and resolved alerts
- Filter by severity, type, status
- Acknowledge alerts (mark as seen)
- Snooze alerts (1h/6h/24h with reason)
- Resolve alerts after fix

For alert response procedures, see [`docs/alert-response-procedures.md`](../alert-response-procedures.md).

### 6. Configure Custom Domain (Optional)

```bash
# Add custom domain via Dashboard or CLI
wrangler pages project update apex-os \
  --production-branch main \
  --custom-domain your-domain.com

# Verify DNS configuration
# Add CNAME: your-domain.com → your-app.pages.dev
```

---

## Cron Jobs Configuration

### Payouts Cron

The payout job runs weekly to process all pending earnings and send Stellar USDC payouts.

**Schedule:** Sunday 00:00 UTC (`0 0 * * 0`)

**wrangler.toml:**

```toml
[triggers]
crons = ["0 0 * * 0"]
```

### Health Check Cron

Run health checks every 30 minutes:

```toml
[triggers]
crons = ["0 0 * * 0", "*/30 * * * *"]
```

### Cron Handler

Cron jobs are handled by the `src/app/api/cron/route.ts` endpoint, which:

1. Validates the `CF-Triggers` header to ensure request is from Cloudflare
2. Executes the appropriate job based on `task` query parameter
3. Logs results to KV for monitoring

**Manual Trigger:**

```bash
curl -X GET "https://your-app.pages.dev/api/cron?task=payouts" \
  -H "CF-Access-Jwt-Assertion: dummy"  # Bypass for local testing
```

---

## Webhook Configuration

### Exchange Webhooks

#### Binance

1. In Binance API management, create a listen key:
```
POST https://api.binance.com/api/v3/userDataStream
```

2. Configure webhook endpoint:
```
URL: https://your-app.pages.dev/api/webhooks/exchange/binance
```

3. Set webhook secret in Binance → Use `BINANCE_WEBHOOK_SECRET`

4. Test with mock webhook:

```bash
tsx scripts/send-mock-webhook.ts --exchange binance --volume 1000 --email user@example.com
```

#### Bybit

1. In Bybit API settings, set webhook URL:
```
https://your-app.pages.dev/api/webhooks/exchange/bybit
```

2. Set webhook secret = `BYBIT_WEBHOOK_SECRET`

3. Test:
```bash
tsx scripts/send-mock-webhook.ts --exchange bybit --volume 500
```

### Polar Webhooks (Subscription Payments)

1. In Polar dashboard → Settings → Webhooks:
   - URL: `https://your-app.pages.dev/api/webhooks/polar`
   - Signing secret: `POLAR_WEBHOOK_SECRET`
   - Events: `subscription.created`, `subscription.cancelled`, `payment.succeeded`

### Resend Webhooks (Email Events)

1. In Resend → Domains → Settings → Webhooks:
   - URL: `https://your-app.pages.dev/api/webhooks/resend`
   - Events: `email.sent`, `email.delivered`, `email.bounced`

---

## Monitoring & Health Checks

### Health Check Endpoint

`GET /api/health`

Returns:

```json
{
  "status": "ok",
  "timestamp": "2026-06-21T12:00:00.000Z",
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

**Health Status Values:**
- `ok` - All systems operational
- `degraded` - Database or KV connection issue
- `error` - Critical failure

**Response Codes:**
- `200` - Healthy
- `503` - Service Unavailable

**Prerequisite:** The health endpoint must be accessible before setting up external monitoring. Verify with:
```bash
curl https://your-app.pages.dev/api/health
```

If the endpoint returns HTML instead of JSON, see **Troubleshooting** section below.

### Set Up Alerts

For comprehensive uptime monitoring with 1-minute intervals and >5 minute downtime alerts, refer to the complete guide:

📖 **[Monitoring Setup Guide](./monitoring-setup.md)**

This guide covers:
- UptimeRobot configuration (free tier)
- Pingdom setup (synthetic monitoring)
- Cloudflare Analytics integration
- Alert escalation matrix
- Testing and maintenance

#### Quick Start - UptimeRobot (Recommended)

1. Sign up at [UptimeRobot.com](https://uptimerobot.com)
2. Add HTTP(s) monitor:
   - URL: `https://your-app.pages.dev/api/health`
   - Interval: 1 minute
   - Expected status: 200
   - Expected string: `"status":"ok"`
3. Set alert confirmation: **5 failures** (5 minutes)
4. Add alert contacts: email, Slack webhook
5. Test the monitor

See [Monitoring Setup](./monitoring-setup.md) for full instructions.

### Cloudflare Analytics (Built-in)

Enable in Cloudflare Dashboard → Pages → Your Project → Analytics:
- Request rate monitoring
- Error rate (4xx, 5xx)
- Response time (P50, P95, P99)
- Set up notifications for error rate >5% over 5 minutes

### Troubleshooting Health Endpoint

**Issue:** `/api/health` returns HTML instead of JSON

**Common Causes:**
1. **Next.js locale middleware redirecting API routes**  
   Solution: Add `src/middleware.ts` to exclude API routes from locale handling.

2. **_routes file not deployed correctly**  
   Solution: Ensure `.open-next/_routes` contains:
   ```
   /api/*    cloudflare_workers
   /*        cloudflare_workers
   ```
   Then redeploy.

3. **Pages caching old configuration**  
   Solution: Clear Pages cache or trigger fresh deployment.

**Local Verification:**
```bash
# Test with wrangler (bypasses Pages routing)
wrangler dev
curl http://localhost:8787/api/health
# Should return JSON with "status":"ok"
```

If local works but production doesn't, the issue is with Pages routing configuration.

#### 2. Logpush to R2 (for audit logs)

```bash
# Configure logpush in wrangler.toml
[[logpush]]
destination = "apex-os-logs"  # R2 bucket name
# Optional filters
filter = "status >= 400"
```

#### 3. Analytics (PostHog)

If `NEXT_PUBLIC_POSTHOG_KEY` is set, automatic event tracking includes:
- Page views
- API calls (errors tracked)
- User signups/signins
- Deal clicks
- Conversion completions
- Payout executions

#### 4. Error Tracking (Sentry)

If `NEXT_PUBLIC_SENTRY_DSN` is set:
- Unhandled errors captured
- Performance monitoring enabled
- Source maps uploaded during build

```bash
# Build with Sentry source maps
SENTRY_AUTH_TOKEN=your_token \
SENTRY_ORG=your_org \
SENTRY_PROJECT=apex-os \
npx sentry-upload-sourcemaps .next
```

---

## Troubleshooting

### Build Failures

**Issue:** `Error: Cannot find module '@opennextjs/cloudflare'`

**Solution:**
```bash
pnpm add -D @opennextjs/cloudflare
```

**Issue:** `Error: The 'images' config cannot be used with Cloudflare`

**Solution:** Ensure `images.unoptimized = true` in `next.config.js`.

**Issue:** `Error: Route (pages) is not compatible with App Router`

**Solution:** Remove any `pages/` directory. ApexOS uses App Router only.

### Database Issues

**Issue:** `Error: D1 database not found`

**Solution:**
```bash
# Verify database exists
wrangler d1 list

# If missing, recreate and update wrangler.toml
wrangler d1 create apex-os-db
```

**Issue:** `Error: Table "profiles" does not exist`

**Solution:** Run migrations:
```bash
wrangler d1 execute apex-os-db --file src/database/migrations/003_affiliate_schema.sql
```

### KV/R2 Binding Issues

**Issue:** `Error: Environment variable not found: KV`

**Solution:** Ensure KV namespace is defined in `wrangler.toml` and deployed:
```bash
wrangler pages deploy .open-next
```

**Issue:** `403 Forbidden` on R2 operations

**Solution:** Check R2 bucket permissions and binding name matches code.

### Authentication Issues

**Issue:** `BETTER_AUTH_SECRET must be a 32+ character string`

**Solution:** Generate proper secret:
```bash
openssl rand -base64 32
```

**Issue:** OAuth redirect URI mismatch

**Solution:** Add to OAuth provider:
```
https://your-app.pages.dev/api/auth/callback/[provider]
```

### Webhook Failures

**Issue:** Webhooks returning 404

**Solution:** Verify route exists:
```bash
# Check deployed routes
wrangler pages project show apex-os
# Ensure /api/webhooks/* routes are not excluded
```

**Issue:** HMAC signature verification fails

**Solution:** Ensure `*_WEBHOOK_SECRET` matches provider configuration exactly.

### Cold Start Issues

**Issue:** First request takes >5 seconds

**Solution:**
1. Enable **Argo Smart Routing** in Cloudflare dashboard
2. Configure **Cache Everything** page rule for static routes
3. Consider **Workers KV** for session data to reduce D1 queries

### Environment Variable Issues

**Issue:** Variables not available in production

**Solution:**
1. In Cloudflare Pages dashboard → Project → Settings → Environment variables
2. Add all required variables marked as **Production**
3. Redeploy

---

## Rollback Procedures

### 1. Rollback to Previous Deployment

```bash
# List recent deployments
wrangler pages deployment list --project-name apex-os

# Rollback to specific deployment (by ID)
wrangler pages deployment rollback --project-name apex-os <deployment-id>

# Or use alias rollback
wrangler pages project deployment-rollback apex-os --branch main
```

### 2. Quick Rollback via Dashboard

1. Go to Cloudflare Dashboard → Pages → Your Project
2. Click **Deployments** tab
3. Find the previous stable deployment
4. Click **Promote to production**

### 3. Database Rollback

If migration causes issues:

```bash
# Restore from backup
wrangler d1 restore apex-os-db \
  --file backup-YYYY-MM-DD.sql \
  --database-name apex-os-db

# Or execute manual rollback SQL
wrangler d1 execute apex-os-db --command "
  BEGIN TRANSACTION;
  -- Rollback statements
  ROLLBACK;
"
```

### 4. KV/R2 Rollback

KV namespaces are versioned automatically. To rollback:

```bash
# List KV namespace backups (if configured)
wrangler kv namespace list

# Restore from snapshot (if using durability)
wrangler kv namespace restore apex-os-cache --snapshot-id <id>
```

---

## Security Checklist

### Pre-Deployment

- [ ] `BETTER_AUTH_SECRET` is a random 32+ character string
- [ ] All `*_WEBHOOK_SECRET` values are unique and stored securely
- [ ] `STELLAR_SECRET_KEY` is never committed to version control
- [ ] `.env.local` is in `.gitignore`
- [ ] No hardcoded API keys in source code
- [ ] Admin routes protected with role checks
- [ ] Rate limiting enabled on `/api/tracking/click`
- [ ] CORS properly configured for API routes
- [ ] SSL/TLS enforced (Pages provides automatically)

### Post-Deployment

- [ ] Environment variables marked as **Sensitive** in Cloudflare
- [ ] Custom domain has SSL/TLS enabled
- [ ] WAF rules configured (optional but recommended)
- [ ] Access logs enabled for audit trail
- [ ] D1 backups scheduled daily:
  ```bash
  # Add to cron or Cloudflare Triggers
  wrangler d1 export apex-os-db --output backup-$(date +%Y%m%d).sql
  ```
- [ ] Webhook signature verification tested
- [ ] API keys rotated regularly (90 days)
- [ ] Admin access reviewed quarterly

---

## Support & Resources

### Documentation

- [Cloudflare Pages Docs](https://developers.cloudflare.com/pages/)
- [OpenNext GitHub](https://github.com/opennextjs/opennext)
- [D1 Documentation](https://developers.cloudflare.com/d1/)
- [Wrangler CLI Reference](https://developers.cloudflare.com/workers/wrangler/)

### Commands Reference

```bash
# Login to Cloudflare
wrangler login

# View current config
wrangler whoami

# Deploy
wrangler pages deploy .open-next

# Tail logs
wrangler pages deployment tail --project-name apex-os

# List databases
wrangler d1 list

# Execute SQL
wrangler d1 execute apex-os-db --command "SELECT * FROM profiles LIMIT 10;"

# KV operations
wrangler kv:key put --binding=KV key value
wrangler kv:key get --binding=KV key
wrangler kv:key delete --binding=KV key

# R2 operations
wrangler r2 object list apex-os-uploads
wrangler r2 object put apex-os-uploads path --file local-file
```

### Emergency Contacts

- Cloudflare Support: https://support.cloudflare.com/
- OpenNext Issues: https://github.com/opennextjs/opennext/issues
- ApexOS Team: See internal Slack channel `#infra-alerts`

---

## Appendix

### Environment Variable Validation

```typescript
// src/lib/config/env.ts
export const env = {
  betterAuthSecret: assertEnv('BETTER_AUTH_SECRET'),
  appUrl: assertEnv('NEXT_PUBLIC_APP_URL'),
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  // ... etc
} as const;

function assertEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}
```

### Database Backup Schedule

```bash
# Daily backup at 2 AM UTC
0 2 * * * wrangler d1 export apex-os-db --output s3://backups/apex-os-$(date +\%Y\%m\%d).sql

# Weekly full dump to local (for offsite backup)
0 3 * * 0 wrangler d1 export apex-os-db > /backups/apex-os-$(date +\%Y\%m\%d).sql
```

### Performance Tuning

1. **KV Cache TTL:** Set appropriate TTLs (session: 24h, rate limit: 1min)
2. **D1 Indexes:** Add indexes for frequent queries:
   ```sql
   CREATE INDEX idx_deal_clicks_affiliate_code ON deal_clicks(affiliate_code);
   CREATE INDEX idx_earnings_user_id ON earnings(user_id);
   ```
3. **R2 Public Cache:** Configure cache-control headers for static assets

### Cost Monitoring

Set up Cloudflare billing alerts:
- Go to Dashboard → Billing → Alerts
- Set thresholds at 50%, 80%, 100% of plan limit
- Monitor D1 storage, R2 egress, KV operations
