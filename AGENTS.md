# AGENTS.md

This file provides guidance to Codex (claude.ai/code) when working with code in this repository.

## Project Overview

**ApexOS** — Global crypto cashback + affiliate hub. Next.js 16 application deployed to Cloudflare Pages with D1 database. Users earn cashback on crypto exchange trades; affiliates earn multi-tier commissions (30/10/5%).

**Tech Stack:**
- Next.js 16 (App Router) + TypeScript + Tailwind CSS
- Better Auth with custom D1 adapter
- Cloudflare Workers + D1 (SQLite)
- next-intl for i18n (Vietnamese/English)
- Stellar USDC for payouts
- Zustand for state management (available, not yet used)

**Deployment Target:** Cloudflare Pages (via OpenNext)

## Required Runtime

**Node.js 26.x is required.** The test suite and production build were proven on **26.7.0**; `.nvmrc` records the exact version and `package.json` `engines.node` declares the accepted range.

`better-sqlite3` ships a native binding compiled for Node 26's ABI (147). On an older runtime the binding fails to load, and the symptom is ~443 test failures that look like product bugs but are a toolchain mismatch. `npm test` runs `scripts/verify-node-version.cjs` first and refuses to start Jest rather than producing those misleading failures.

If `npm test` stops with a Node version error, switch runtimes and re-run:

```bash
fnm use 26                                          # or: nvm use 26
export PATH=/opt/homebrew/opt/node@26/bin:$PATH     # Homebrew keg on this machine
node --version                                      # expect v26.x
```

Dependency installs use `pnpm-lock.yaml` (the tree was installed with pnpm, visible as the `node_modules/.pnpm` store layout). pnpm itself is not currently available in this environment; `npm install` works with the same tree.

**Project Root:** `/Users/macbook/apex-os`

**Operational Runbook:** `docs/operational-runbook.md`

---

## Common Development Commands

All commands require Node 26 (see "Required Runtime" above). `npm test` refuses to run on an incompatible runtime rather than emitting hundreds of false failures.

```bash
# Development
npm run dev                    # Start local dev server at localhost:3000
npm run build                 # Production build (outputs to .next)
npm start                     # Start production server
npm run lint                  # ESLint check (eslint . --ext .ts,.tsx)

# Testing
npm test                      # Run all Jest tests once (verifies Node first)
npm run test:watch           # Run tests in watch mode
npm run test:coverage        # Run tests with coverage report
npm test path/to/file.test.ts    # Single test file
npm test -t "test name"          # Single test by name pattern

# Database (D1)
wrangler d1 execute apex-os-db --file src/database/migrations/003_affiliate_schema.sql   # Apply schema
wrangler d1 execute apex-os-db --file src/database/migrations/008_composite_indexes.sql   # Apply performance indexes
wrangler d1 execute apex-os-db --command "SELECT name FROM sqlite_master WHERE type='table'"  # List tables
wrangler d1 export apex-os-db --output dump.sql                                             # Export data

# Query performance analysis
tsx scripts/analyze-query-performance.ts   # Run EXPLAIN QUERY PLAN on slow queries
tsx scripts/apply-indexes-migration.ts     # Apply and verify composite indexes

# Local dev (Cloudflare Workers)
wrangler dev              # Local Workers dev with D1 binding

# Run migration script
bash scripts/migrate-to-affiliate.sh

# Send mock webhook for testing
tsx scripts/send-mock-webhook.ts --exchange binance --volume 1000

# Payouts (run manually or via cron)
curl -X POST http://localhost:3000/api/payouts/run -H "Authorization: Bearer ADMIN_TOKEN"
```

---

## Architecture

### Core Domain: Affiliate Cashback System

**Users & Roles:**
- `shopper` — end user who clicks deals and earns cashback on trades
- `affiliate` — promoter who shares referral links, earns commissions from downline
- `admin` — manages deals, views all data, monitors system

**Attribution Flow:**
1. User clicks deal → `POST /api/tracking/click` records `deal_clicks`, sets `ref` cookie (30d)
2. User trades on exchange → webhook from Binance/Bybit to `POST /api/webhooks/exchange`
3. System matches trade to click (wallet/email + 30d window) → resolves referral tree
4. Commissions calculated (Tier1: 30%, Tier2: 10%, Tier3: 5%)
5. Weekly Stellar USDC payout to eligible users

### Database Schema (D1)

Key tables (see `src/database/migrations/003_affiliate_schema.sql`):

- `profiles` — extended with `wallet_address`, `preferred_chain`, `role`
- `affiliate_codes` — unique code per user for referral tracking
- `referral_tree` — multi-level relationships (up to 3 levels)
- `deals` — affiliate offers from exchanges (Binance, Bybit, OKX, KuCoin)
- `deal_clicks` — click attribution with IP/UA hashing
- `conversions` — verified trades with commission amounts
- `earnings` — double-entry ledger (source_type: direct/affiliate/tier2/tier3)
- `payouts` — Stellar transaction records

**Performance Optimization:**

Migration `008_composite_indexes.sql` adds composite indexes for fast query performance:
- `idx_deal_clicks_deal_created` (deal_id, created_at)
- `idx_deal_clicks_affiliate_created` (affiliate_id, created_at)
- `idx_conversions_affiliate_convert` (affiliate_id, converted_at)
- `idx_conversions_affiliate_status` (affiliate_id, status)
- `idx_earnings_affiliate_is_paid` (affiliate_id, is_paid)
- `idx_earnings_is_paid_affiliate` (is_paid, affiliate_id)
- `idx_earnings_conversion_affiliate` (conversion_id, affiliate_id)
- `idx_payouts_affiliate_status` (affiliate_id, status)

These indexes target the Profile API endpoints to achieve ≤200ms response times.

### Routing & i18n
- Locale-based: `[locale]` segment (`/vi`, `/en`)
- Supported locales: `vi`, `en` (`src/i18n/request.ts`)
- Layout: `[locale]/layout.tsx` wraps with `NextIntlClientProvider`
- Messages: `src/i18n/messages/{locale}.json`

### Authentication
- Better Auth v0.8.7-beta.5 with custom D1 adapter
- Factory: `src/lib/auth/auth-factory.ts`
- API: `src/app/api/auth/[...all]/route.ts`
- Client: `src/contexts/auth-context.tsx` → `useAuth()` hook

---

## Critical Path (Implementation Order)

**Phase 1 (DB)** → **Phase 2 (Deals)** → **Phase 3 (Tracking)** → **Phase 4 (Conversions)** → **Phase 5 (Payouts)** → **Phase 6 (Testing)**

Dependencies:
- Phase 2 needs Phase 1 schema
- Phase 3 needs Phase 2 deals
- Phase 4 needs Phase 3 click tracking
- Phase 5 needs Phase 4 earnings
- Phase 6 needs all above

---

## Key Modules

### API Routes (`src/app/api/`)

**Authentication:**
- `auth/[...all]/route.ts` - Better Auth endpoints (signin, signup, callback, session)

**Core Business Logic:**
- `deals/` - Admin CRUD for affiliate offers
- `tracking/click/route.ts` - Click attribution, sets 30-day cookie
- `webhooks/exchange/route.ts` - Binance/Bybit trade verification
- `webhooks/polar/route.ts` - Subscription payment events
- `webhooks/resend/route.ts` - Email delivery events

**User-facing:**
- `affiliate/` - Affiliate stats, referral tree data
- `profile/` - User profile management
- `payouts/route.ts` - Payout history and execution
- `public/` - Public deals listing, exchange rates

**Operations:**
- `health/route.ts` - System health check (monitoring)
- `monitoring/` - Metrics collection and alerting
  - `alert-engine/route.ts` - Alert engine control and evaluation metrics
  - `evaluation/route.ts` - Evaluation state metrics and statistics
  - `d1/` - Database metrics
  - `dispatcher/` - Notification dispatcher status
  - `retention/` - Data retention management
- `cron/route.ts` - Scheduled jobs (weekly payouts, D1 metrics)

**Admin APIs (`/api/admin/*`):**
- `admin/affiliates/` - Affiliate management endpoints
- `admin/alerts/` - Alert query and management
- `admin/analytics/` - Traffic analytics, device stats, geographic data
- `admin/deals/` - Deal CRUD operations
- `admin/health/` - System health and database metrics
- `admin/metrics/` - Business metrics (see `docs/api/metrics-api.md`)
- `admin/notifications/` - Notification channel configuration

### Affiliate System (`src/lib/`)

- `tracking/matcher.ts` - Core matching algorithm
  - Finds user by wallet address or email
  - Lookup click within 30d window
  - Resolve referral tree (3 levels)
  - Calculate commission (30%/10%/5%)

- `earnings/calculator.ts` - Aggregate pending conversions

- `payouts/`
  - `stellar-service.ts` - Stellar USDC blockchain transactions
  - `batch-builder.ts` - Batch payout construction

- `monitoring/`
  - `metrics-cache.ts` - KV-based caching layer (5-minute TTL)
  - `alert-engine.ts` - Alert rule evaluation and triggering (enhanced with state persistence)
  - `d1-monitor.ts` - D1 database metrics collection
  - `dispatcher.ts` - Notification batching and retry
  - `circuit-breaker.ts` - Circuit breaker pattern for resilience
  - `evaluation-state-storage.ts` - State persistence layer
  - `notification-channels.ts` - Email/Slack/Polar integrations

### Frontend (`src/app/[locale]/`)

**Admin Pages:**
- `admin/metrics/page.tsx` - Business metrics dashboard with charts
- `admin/alerts/page.tsx` - Alert management and monitoring
- `admin/analytics/page.tsx` - Traffic and user behavior analytics
- `admin/deals/page.tsx` - Deal CRUD and management
- `admin/affiliates/page.tsx` - Affiliate user management
- `admin/health/page.tsx` - System health monitoring

**User Pages:**
- `deals/` - Public listing with filters, detail pages with tracking redirect
- `dashboard/` - Shopper earnings, conversion history
- `affiliate/` - Affiliate code, downline tree, commission stats
- `profile/` - User settings, wallet configuration

### Middleware

- `middleware.ts` - Locale detection with API bypass
  - Excludes `/api/*` from next-intl locale handling
  - Critical for health endpoint to work on Cloudflare Pages

---

## Alerting System

ApexOS includes a comprehensive alerting system that monitors D1 database performance, business metrics, and system health. Alerts trigger notifications via email, Slack, or Telegram and are managed through the admin dashboard.

### Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Metrics API   │───▶│  Alert Engine    │───▶│  Notification   │
│  (D1, Business) │    │  (evaluation)    │    │   Channels      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │  Email/Slack/   │
                                               │   Telegram      │
                                               └─────────────────┘
```

**Components:**
- `src/lib/monitoring/alert-engine.ts` - Alert rule evaluation and triggering
- `src/lib/monitoring/d1-monitor.ts` - D1 database metrics collection
- `src/lib/notifications/` - Multi-channel notification service
- `src/app/api/monitoring/` - API routes for alert management
- `src/types/business-alerting.ts` - Type definitions

### Alert Rules

| Rule ID | Name | Metric | Threshold | Severity |
|---------|------|--------|-----------|----------|
| `alert-slow-query` | Slow Query | avg_query_duration_ms > 1000ms | > 1s | warning |
| `alert-storage` | High Storage | storage_usage_percent ≥ 80% | ≥ 80% | critical |
| `alert-slow-count` | Excessive Slow Queries | slow_query_count > 10 | > 10 | warning |
| `alert-rows-scanned` | High Row Scan | avg_rows_scanned > 10000 | > 10k | warning |
| `biz-revenue-drop` | Revenue Drop | daily_revenue < $100 | < $100 | warning |
| `biz-conversion-rate-low` | Low Conversion Rate | conversion_rate < 2% | < 2% | warning |
| `biz-zero-conversions` | No Conversions | total_conversions = 0 | = 0 | critical |
| `biz-high-commission-liability` | High Commission Liability | pending_commission ≥ $10k | ≥ $10k | warning |
| `biz-stellar-balance-low` | Low Stellar Balance | stellar_balance < 100 | < 100 USDC | critical |

### Alert States

| State | Description | Action Required |
|-------|-------------|-----------------|
| **Active** | Alert triggered, needs attention | Acknowledge, investigate, resolve |
| **Acknowledged** | Someone is working on it | Continue investigation |
| **Resolved** | Issue resolved, monitoring continues | Document resolution |
| **Snoozed** | Temporarily silenced | Will re-activate after snooze period |

### Severity Response SLAs

- **🔴 Critical:** Respond within 15 minutes, immediate escalation to on-call
- **🟡 Warning:** Respond within 4 business hours
- **🔵 Info:** Review next business day

### Notification Channels

**Slack:**
```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_ENABLED=true
SLACK_CHANNEL=#alerts
```

**Email (Resend):**
```bash
RESEND_API_KEY=re_your_key
RESEND_FROM_EMAIL=noreply@apex-os.com
NOTIFICATION_EMAIL_RECIPIENTS=admin@example.com,alerts@example.com
```

**Telegram:**
```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_IDS=-1001234567890
TELEGRAM_ENABLED=true
```

### Admin Dashboard

- **Route:** `/admin/alerts`
- Manage alert lifecycle (acknowledge, resolve, snooze)
- Filter by status, severity, type
- View alert history and trends
- Configure notification channels

### Cron Configuration

The alert engine runs every 5 minutes via Cloudflare Pages cron:

```toml
[[triggers]]
crons = ["*/5 * * * *"]
```

### Enhanced Evaluation System

The alert engine includes comprehensive evaluation state persistence and resilience features:

**Evaluation State Persistence**
- `evaluation_runs` - Tracks each evaluation cycle with timing and status
- `rule_evaluation_history` - Historical record of every rule evaluation
- `evaluation_errors` - Detailed error tracking with classification
- `alert_engine_metrics` - Performance metrics for the alert engine itself

**Circuit Breaker Protection**
Protects against cascading failures:
- `metrics-api` - Business metrics fetching
- `d1-database` - Database operations
- `notification-email` - Resend email service
- `notification-slack` - Slack webhooks
- `notification-webhook` - Generic webhooks

Circuit states: `closed` (normal) → `open` (failing, blocks calls) → `half_open` (testing recovery)

**Error Classification**
Errors are automatically classified:
- Transient: `timeout`, `network_error`, `rate_limit` (auto-retry)
- Permanent: `config_missing`, `auth_failed`, `data_not_found` (immediate escalation)

**API Endpoints**
- `GET /api/monitoring/alert-engine?stats=true` - Include evaluation stats
- `GET /api/monitoring/alert-engine?errors=true` - Include error statistics
- `GET /api/monitoring/alert-engine?circuit-breakers=true` - Circuit breaker status
- `POST /api/monitoring/alert-engine?action=reset-breaker&name=metrics-api` - Reset breaker
- `GET /api/monitoring/evaluation` - Dedicated evaluation metrics endpoint
- `POST /api/monitoring/evaluation?action=cleanup` - Clean up old evaluation data

**Database Schema**
Migration: `src/database/migrations/009_evaluation_state_schema.sql`

**Key Types**
- `EvaluationRun` - Complete evaluation cycle record
- `RuleEvaluationHistory` - Individual rule evaluation result
- `EvaluationError` - Error with classification and context
- `CircuitBreakerEntry` - Circuit breaker state
- `AlertEngineMetrics` - Engine performance metrics

### Documentation

- [Alert Response Procedures](./alert-response-procedures.md) - Response workflows and escalation
- [Alerting Quick Reference](./alerting-quick-reference.md) - Commands and configuration
- [Alerting Runbook](./alerting-runbook.md) - Comprehensive operational guide
- [Monitoring Setup](./monitoring-setup.md) - Initial setup guide
- [Admin Dashboards Guide](./admin-dashboards.md) - Using the alert dashboard
- [Operational Runbook](./operational-runbook.md) - Day-to-day operations

---

## Environment Variables

Create `.env.local`:

```bash
# Auth
BETTER_AUTH_SECRET=random-32-char-secret

# Cloudflare
CF_ACCOUNT_ID=your-account
CF_API_TOKEN=your-api-token
D1_DATABASE=apex-os-db

# Stellar Payouts (USDC)
STELLAR_SECRET_KEY=G... (testnet or mainnet)
STELLAR_NETWORK=testnet  # or 'mainnet'
STELLAR_USDC_ISSUER=GA...  # USDC issuer address
STELLAR_USDC_CODE=USDC

# Webhook Secrets (from exchanges)
BINANCE_WEBHOOK_SECRET=your-binance-secret
BYBIT_WEBHOOK_SECRET=your-bybit-secret

# Email (Resend)
RESEND_API_KEY=re_...
```

---

## Testing Strategy

- **Unit:** Matching algorithm, earnings calculator, Stellar service
- **Integration:** Click → conversion flow, webhook handling
- **Coverage target:** 70% on `src/lib/`
- **Mock webhook:** `scripts/send-mock-webhook.ts` for local testing

---

## Security Notes

- **Webhook HMAC:** All exchange webhooks verify signature using secret
- **Rate limiting:** Implement on `/api/tracking/click` (prevent spam)
- **Admin routes:** Check `user.role === 'admin'` via Better Auth middleware
- **SQL injection:** Already safe (parameterized D1 queries)
- **Payout authorization:** Only admin can trigger `/api/payouts/run`

---

## File Structure (Post-Transformation)

```
src/
├── app/
│   ├── [locale]/
│   │   ├── admin/
│   │   │   ├── affiliates/page.tsx    # Affiliate management
│   │   │   ├── alerts/page.tsx       # Alert dashboard
│   │   │   ├── analytics/page.tsx    # Traffic & user analytics
│   │   │   ├── deals/page.tsx        # Deal CRUD
│   │   │   ├── health/page.tsx       # System health
│   │   │   └── metrics/page.tsx      # Business metrics dashboard
│   │   ├── dashboard/
│   │   │   ├── page.tsx              # Shopper earnings overview
│   │   │   ├── affiliates/page.tsx  # Affiliate stats & referral tree
│   │   │   ├── conversions/page.tsx # Conversion history
│   │   │   ├── payouts/page.tsx     # Payout records
│   │   │   └── dashboard-overview.tsx
│   │   ├── deals/
│   │   │   ├── page.tsx              # Public listing with filters
│   │   │   └── [slug]/page.tsx      # Detail + tracking redirect
│   │   ├── login/page.tsx
│   │   ├── signup/page.tsx
│   │   ├── landing/page.tsx
│   │   └── layout.tsx
│   ├── api/
│   │   ├── auth/[...all]/route.ts
│   │   ├── admin/
│   │   │   ├── affiliates/route.ts
│   │   │   ├── alerts/route.ts
│   │   │   ├── analytics/
│   │   │   │   ├── overview/route.ts
│   │   │   │   ├── countries/route.ts
│   │   │   │   ├── devices/route.ts
│   │   │   │   ├── referrers/route.ts
│   │   │   │   ├── timeseries/route.ts
│   │   │   │   └── top-pages/route.ts
│   │   │   ├── deals/route.ts
│   │   │   ├── health/route.ts
│   │   │   ├── metrics/route.ts
│   │   │   └── notifications/route.ts
│   │   ├── affiliate/
│   │   │   ├── conversions/route.ts
│   │   │   ├── dashboard/route.ts
│   │   │   └── payouts/route.ts
│   │   ├── deals/
│   │   │   ├── route.ts              # GET list, POST create
│   │   │   └── [id]/route.ts        # GET one, PATCH, DELETE
│   │   ├── tracking/click/route.ts
│   │   ├── webhooks/exchange/route.ts
│   │   ├── webhooks/polar/route.ts
│   │   ├── webhooks/resend/route.ts
│   │   ├── monitoring/
│   │   │   ├── alert-engine/route.ts
│   │   │   ├── d1/route.ts
│   │   │   └── d1/snoozes/
│   │   ├── metrics/
│   │   │   ├── business/route.ts    # Business metrics API
│   │   │   └── timeseries/route.ts  # Time-series data
│   │   ├── health/route.ts
│   │   ├── payouts/route.ts
│   │   ├── profile/route.ts
│   │   └── public/
│   │       └── deals/route.ts
│   ├── layout.tsx
│   └── page.tsx (redirect)
├── components/
│   ├── WalletConnect.tsx             # MetaMask/Phantom/xPortal
│   ├── admin/
│   │   ├── admin-nav.tsx            # Admin navigation sidebar
│   │   ├── BusinessKpiCards.tsx     # KPI card components
│   │   └── analytics/               # Analytics chart components
│   └── dashboard/
│       ├── dashboard-header.tsx
│       ├── dashboard-layout.tsx
│       ├── dashboard-sidebar.tsx
├── contexts/
│   └── auth-context.tsx
├── database/migrations/
│   ├── 001_initial_schema_d1.sql    # Auth tables (Better Auth)
│   ├── 002_auth_tables.sql
│   └── 003_affiliate_schema.sql     # Affiliate tables
├── i18n/
│   ├── request.ts
│   └── messages/vi.json, en.json
├── lib/
│   ├── auth/
│   │   ├── auth-factory.ts
│   │   └── adapters/d1-adapter.ts
│   ├── deals/                        # Deal CRUD logic
│   ├── tracking/
│   │   ├── cookie-manager.ts
│   │   └── matcher.ts               # Core matching algorithm
│   ├── earnings/calculator.ts
│   ├── payouts/stellar-service.ts
│   ├── monitoring/
│   │   ├── metrics-cache.ts         # KV-based caching
│   │   ├── alert-engine.ts          # Alert evaluation
│   │   └── notification-channels.ts # Email/Slack/Polar
│   └── emails/notifier.ts
├── types/
│   ├── profile.ts
│   ├── deal.ts
│   ├── metrics.ts                   # Business metrics types
│   └── alerts.ts                    # Alert configuration types
├── __tests__/
│   ├── matching.test.ts
│   ├── earnings.test.ts
│   └── integration/
└── scripts/
    ├── migrate-to-affiliate.sh
    ├── send-mock-webhook.ts
    └── setup-monitoring.sh
```

---

## Deployment Runbook

See `docs/deployment-runbook.md` and `docs/operational-runbook.md` for:
- Cloudflare Pages setup
- D1 database provisioning
- Environment variables checklist
- Cron job configuration (weekly payouts)
- Monitoring & alerts setup
- Incident response procedures
- Daily operations tasks
- Admin dashboards usage guide (`docs/admin-dashboards.md`)

---

## Git Workflow

Conventional commits:
```bash
git commit -m "feat: add deal listing page with filters"
git commit -m "fix: correct cookie domain in tracking"
git commit -m "refactor: split matcher into separate module"
```

---

## Notes

- **Multi-chain support:** `preferred_chain` in profiles stores EVM/Solana/Stellar address
- **Exchange integrations:** Binance, Bybit (current). OKX/KuCoin integration planned for Q3 2026 (see `q3-2026-roadmap.md`)
- **Fraud prevention:** IP hashing, rate limiting, alert engine with circuit breaker protection
- **Compliance:** KYC required at $500+ payout threshold (not implemented yet)
- **Admin Dashboards:** See `docs/admin-dashboards.md` for comprehensive user guide
- **Metrics API:** See `docs/api/metrics-api.md` for API documentation
- **Alert Procedures:** See `docs/alert-response-procedures.md` for incident response
- **Q3 2026:** Active sprints: OKX integration, KuCoin integration, Analytics engine, Email automation, Mobile app foundation. See `plans/q3-2026-roadmap.md` and individual sprint plans.
