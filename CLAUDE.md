# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ApexOS (Ascendancy v1.5.0)** — Non-custodial, cryptographically auditable crypto fee-rebate and B2B Proof-of-Rebate platform (`package.json` version `1.5.0`). Next.js 16 application deployed to Cloudflare Workers (OpenNext) with D1, KV, and R2. Users earn non-custodial trading fee rebates via UID-only attribution (zero exchange API keys); partners earn commissions under the **Safe-Spread Waterfall I4** (`5%` clawback reserve, `47.5%` trader rebate, `14.25%` L1 direct partner, `<=4.75%` L2 B2B agency override under executed contract only / `0%` retail, `0%` L3+ hard-locked per Vietnam Decree 40/2018/ND-CP) after `CASH_COLLECTED` verification and a `T+7` maturity hold.

**Tech Stack:**
- Next.js 16 (App Router) + TypeScript + Tailwind CSS
- Better Auth (`^1.7.23`) with custom D1 adapter & WebAuthn ES256 passkey step-up
- Cloudflare Workers (OpenNext) + D1 (SQLite) + KV + R2 (5-year SHA-256 Proof-of-Rebate archive)
- next-intl for i18n (Vietnamese/English)
- Turnkey HSM enclave signing (zero raw `STELLAR_SECRET_KEY` in Worker memory) + Safe 2-of-3 cold multisig
- Circle Native USDC payouts on **Stellar (7dp)**, **Arbitrum One (6dp)**, and **Base (6dp)** (`Ethereum L1` & `Solana` are `DISABLED_PHASE1`; `AUTO_SETTLE_PAYOUTS = "false"`)
- Legacy billing: NOWPayments routes (`/api/payments`, `/api/webhooks/ipn`) are legacy/deprecated (production Ascendancy is 100% fee-rebate)

**Deployment Target:** Cloudflare Workers (via OpenNext)

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
npm run build                  # Production build (outputs to .next)
npm start                      # Start production server
npm run typecheck              # TypeScript type-check (0 errors)
npm run lint                   # ESLint check

# Testing (183 suites / 3,676 tests verified on Node 26.7.0)
npm test                       # Run all Jest tests once (verifies Node first)
npm run test:watch             # Run tests in watch mode
npm run test:coverage          # Run tests with coverage report
npm test path/to/file.test.ts  # Single test file
npm test -t "test name"        # Single test by name pattern

# Database (D1 — 47 SQL files in src/database/migrations/, up to 032_persistent_d1_rate_limits.sql)
wrangler d1 execute apex-os-db --file src/database/migrations/032_persistent_d1_rate_limits.sql
wrangler d1 execute apex-os-db --command "SELECT name FROM sqlite_master WHERE type='table'"
wrangler d1 export apex-os-db --output dump.sql

# Query performance analysis
tsx scripts/analyze-query-performance.ts   # Run EXPLAIN QUERY PLAN on slow queries
tsx scripts/apply-indexes-migration.ts     # Apply and verify composite indexes

# Local dev (Cloudflare Workers)
wrangler dev                   # Local Workers dev with D1 binding

# Send mock webhook for testing (use an ACTIVE exchange: bybit, okx, or bitget)
tsx scripts/send-mock-webhook.ts --exchange bybit --volume 1000

# Payouts (manual / admin-gated; AUTO_SETTLE_PAYOUTS="false" in production)
curl -X POST http://localhost:3000/api/payouts/run -H "Authorization: Bearer ADMIN_TOKEN"
```

---

## Architecture

### Core Domain: Non-Custodial Fee-Rebate & Safe-Spread Waterfall I4

**Users & Roles:**
- `shopper` / trader — end user who binds an exchange UID (zero API keys) and earns non-custodial USDC fee rebates
- `affiliate` / partner — L1 direct partner (`14.25%` gross / `30%` of platform spread) or contracted B2B L2 agency (`<=4.75%` gross / `<=10%` of platform spread; `0%` retail; L3+ hard-locked at `0%`)
- `admin` — manages deals, B2B contracts, fraud reviews, treasury controls, and system monitoring

**Exchange Ingestion Matrix:**
- **`ACTIVE`:** Bybit (Affiliate v5), OKX (Affiliate / FD Broker v5), Bitget (Broker v2)
- **`SHADOW_ONLY`:** KuCoin UTA v2, Gate.io v4 (gated behind 30-day clean shadow gate)
- **`BLOCKED`:** Binance (hard-blocked due to missing customer UIDs in standard Referral Pro auto-attribution)

**Attribution & Settlement Flow:**
1. User links exchange UID (zero API keys) or clicks attribution link → `POST /api/tracking/click` records `deal_clicks` after edge geo-fence (HTTP 451 / `BLOCK_VN_SIGNUPS`) and fraud gate
2. Official partner feed / webhook from active exchanges (`Bybit`, `OKX`, `Bitget`) is verified via HMAC-SHA256 + KV replay protection and reconciled to `CASH_COLLECTED`
3. Atomic `10^-8` USD double-entry ledger applies **Safe-Spread Waterfall I4**:
   - `5%` clawback reserve
   - `47.5%` gross trader fee rebate (`50%` of post-5%-reserve distributable commission)
   - `14.25%` gross L1 direct partner (`30%` of platform spread)
   - `<=4.75%` gross L2 B2B agency override (`<=10%` of platform spread, B2B contract only; `0%` retail)
   - `0%` L3+ hard-locked (Vietnam Decree 40/2018/ND-CP anti-MLM compliance)
4. Postings clear the **T+7 maturity hold** before becoming withdrawable
5. `$10+` **Circle Native USDC** payouts settle on **Stellar (7dp)**, **Arbitrum One (6dp)**, or **Base (6dp)** (`Ethereum L1` & `Solana` are `DISABLED_PHASE1`), signed via **Turnkey HSM** enclaves (zero raw `STELLAR_SECRET_KEY` in Cloudflare Worker memory) backed by **Safe 2-of-3** cold multisig (`AUTO_SETTLE_PAYOUTS = "false"`)

### Database Schema (D1)

Schema is managed across **47 SQL migration files** in `src/database/migrations/` (latest: `032_persistent_d1_rate_limits.sql`).

Key tables:
- `profiles` — extended with `wallet_address`, `preferred_chain`, `role`, 48h wallet-change timelock fields
- `affiliate_codes` — unique code per partner for UID/link attribution
- `referral_tree` — partner relationships (strictly capped at L1 + contracted B2B L2; L3+ hard-locked at `0%`)
- `b2b_agency_contracts` — executed B2B L2 agency override contracts (`tier2_spread_bps <= 1000`, `tier3_spread_bps = 0 CHECK`)
- `deals` — exchange rebate schedules (Bybit, OKX, Bitget active; KuCoin, Gate.io shadow; Binance blocked)
- `deal_clicks` — click attribution with IP/UA hashing and fraud scoring
- `conversions`, `earnings`, `payouts` — atomic `10^-8` USD double-entry ledger, `CASH_COLLECTED` gating, `T+7` holds, and USDC settlement records
- `d1_rate_limits`, `blocked_ips`, `fraud_reviews` — persistent D1 rate limiting (`032_persistent_d1_rate_limits.sql`) and immutable fraud audit log
- `payments`, `tier_activations` — legacy/deprecated NOWPayments billing tables

**Performance Optimization:**

Migration `008_composite_indexes.sql` and subsequent index migrations add composite indexes for fast query performance (`<=200ms` profile API target):
- `idx_deal_clicks_deal_created` (deal_id, created_at)
- `idx_deal_clicks_affiliate_created` (affiliate_id, created_at)
- `idx_conversions_affiliate_convert` (affiliate_id, converted_at)
- `idx_conversions_affiliate_status` (affiliate_id, status)
- `idx_earnings_affiliate_is_paid` (affiliate_id, is_paid)
- `idx_earnings_is_paid_affiliate` (is_paid, affiliate_id)
- `idx_earnings_conversion_affiliate` (conversion_id, affiliate_id)
- `idx_payouts_affiliate_status` (affiliate_id, status)

### Routing & i18n
- Locale-based: `[locale]` segment (`/vi`, `/en`)
- Supported locales: `vi`, `en` (`src/i18n/request.ts`)
- Layout: `[locale]/layout.tsx` wraps with `NextIntlClientProvider`
- Messages: `src/i18n/messages/{locale}.json` (100% key parity enforced by Jest)

### Authentication
- Better Auth `^1.7.23` with custom D1 adapter and WebAuthn ES256 passkey step-up
- Factory: `src/lib/auth/auth-factory.ts`
- API: `src/app/api/auth/[...all]/route.ts`
- Client: `src/contexts/auth-context.tsx` → `useAuth()` hook

---

## Key Modules

### API Routes (`src/app/api/`)

**Authentication:**
- `auth/[...all]/route.ts` - Better Auth (`^1.7.23`) endpoints (signin, signup, callback, session)

**Core Business Logic:**
- `deals/` - Admin CRUD for exchange rebate schedules
- `tracking/click/route.ts` - Click attribution with edge geo-fence and fraud gate
- `webhooks/exchange/route.ts` - Exchange trade/commission verification (`Bybit`, `OKX`, `Bitget` active; `KuCoin`/`Gate.io` shadow; `Binance` blocked)
- `webhooks/resend/route.ts` - Email delivery events
- `payments/` & `webhooks/ipn/route.ts` - **Legacy / deprecated** NOWPayments billing routes (production Ascendancy is 100% fee-rebate)

**User-facing:**
- `affiliate/` - Partner stats, attribution tree, and commission data
- `profile/` - User profile and self-custody USDC wallet management (48h timelock)
- `payouts/route.ts` - Payout history and admin-gated settlement execution (`AUTO_SETTLE_PAYOUTS = "false"`)
- `public/` - Public deals listing, exchange rates

**Operations:**
- `health/route.ts` - System health check (monitoring)
- `monitoring/` - Metrics collection and alerting
  - `alert-engine/route.ts` - Alert engine control and evaluation metrics
  - `evaluation/route.ts` - Evaluation state metrics and statistics
  - `d1/` - Database metrics
  - `dispatcher/` - Notification dispatcher status
  - `retention/` - Data retention management
- `cron/route.ts` - Scheduled jobs (email queue, D1 metrics, reconciliation)

**Admin APIs (`/api/admin/*`):**
- `admin/affiliates/` - Partner management endpoints
- `admin/b2b-contracts/` - B2B L2 agency override contract management (`tier3SpreadBps === 0` hard-locked)
- `admin/alerts/` - Alert query and management
- `admin/analytics/` - Traffic analytics, device stats, geographic data
- `admin/deals/` - Deal CRUD operations
- `admin/fraud/` - Fraud review actions, stats, blocked IPs
- `admin/health/` - System health and database metrics
- `admin/metrics/` - Business metrics (see `docs/api/metrics-api.md`)
- `admin/notifications/` - Notification channel configuration

### Core Libraries (`src/lib/`)

- `ledger/`
  - `waterfall.ts` - Canonical Safe-Spread Waterfall I4 (`10^-8` USD integer math; 5% reserve, 47.5% trader, 14.25% L1, <=4.75% B2B L2, 0% L3+)
  - `b2b-agency-contracts.ts` - B2B L2 contract enforcement (`tier3SpreadBps === 0` hard-locked)

- `compliance/`
  - `geo-fence.ts` - Deterministic `cf-ipcountry` HTTP 451 gate + `BLOCK_VN_SIGNUPS` circuit breaker

- `tracking/matcher.ts` - Attribution matching and partner tree resolution

- `earnings/calculator.ts` - Aggregate verified `CASH_COLLECTED` conversions and `T+7` holds

- `payouts/`
  - `stellar-service.ts` & multi-chain USDC rails — Turnkey HSM enclave signing for Circle Native USDC on Stellar (7dp), Arbitrum (6dp), Base (6dp); ETH L1 & Solana `DISABLED_PHASE1`
  - `batch-builder.ts` - Batch payout construction

- `monitoring/`
  - `metrics-cache.ts` - KV-based caching layer (5-minute TTL)
  - `alert-engine.ts` - Alert rule evaluation and triggering (enhanced with state persistence)
  - `d1-monitor.ts` - D1 database metrics collection
  - `dispatcher.ts` - Notification batching and retry
  - `circuit-breaker.ts` - Circuit breaker pattern for resilience
  - `evaluation-state-storage.ts` - State persistence layer
  - `notification-channels.ts` - Email/Slack/Telegram integrations

### Frontend (`src/app/[locale]/`)

**Admin Pages:**
- `admin/metrics/page.tsx` - Business metrics dashboard with charts
- `admin/alerts/page.tsx` - Alert management and monitoring
- `admin/analytics/page.tsx` - Traffic and user behavior analytics
- `admin/deals/page.tsx` - Deal CRUD and management
- `admin/affiliates/page.tsx` - Partner user management
- `admin/health/page.tsx` - System health monitoring

**User & Public Pages:**
- `landing/` - Non-custodial positioning & Safe-Spread Rebate Calculator
- `legal/` - Terms of Service, Non-Custodial Disclosure, Geo-Restriction Notice (HTTP 451)
- `deals/` - Public listing with filters, detail pages with attribution redirect
- `dashboard/` - Trader & partner rebate overview, conversion history, payout records
- `profile/` - User settings, self-custody USDC wallet configuration

### Middleware

- `middleware.ts` - Locale detection with API bypass and edge geo-fence enforcement
  - Excludes `/api/*` from next-intl locale handling
  - Critical for health endpoint to work on Cloudflare Workers

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
| `alert-storage` | High Storage | storage_usage_percent >= 80% | >= 80% | critical |
| `alert-slow-count` | Excessive Slow Queries | slow_query_count > 10 | > 10 | warning |
| `alert-rows-scanned` | High Row Scan | avg_rows_scanned > 10000 | > 10k | warning |
| `biz-revenue-drop` | Revenue Drop | daily_revenue < $100 | < $100 | warning |
| `biz-conversion-rate-low` | Low Conversion Rate | conversion_rate < 2% | < 2% | warning |
| `biz-zero-conversions` | No Conversions | total_conversions = 0 | = 0 | critical |
| `biz-high-commission-liability` | High Commission Liability | pending_commission >= $10k | >= $10k | warning |
| `biz-stellar-balance-low` | Low Stellar Balance | stellar_balance < 100 | < 100 USDC | critical |

### Alert States

| State | Description | Action Required |
|-------|-------------|-----------------|
| **Active** | Alert triggered, needs attention | Acknowledge, investigate, resolve |
| **Acknowledged** | Someone is working on it | Continue investigation |
| **Resolved** | Issue resolved, monitoring continues | Document resolution |
| **Snoozed** | Temporarily silenced | Will re-activate after snooze period |

### Severity Response SLAs

- **Critical:** Respond within 15 minutes, immediate escalation to on-call
- **Warning:** Respond within 4 business hours
- **Info:** Review next business day

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

The alert engine runs every 5 minutes via Cloudflare Workers cron:

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

- [Alert Response Procedures](./docs/alert-response-procedures.md) - Response workflows and escalation
- [Alerting Quick Reference](./docs/alerting-quick-reference.md) - Commands and configuration
- [Alerting Runbook](./docs/alerting-runbook.md) - Comprehensive operational guide
- [Monitoring Setup](./docs/monitoring-setup.md) - Initial setup guide
- [Admin Dashboards Guide](./docs/admin-dashboards.md) - Using the alert dashboard
- [Operational Runbook](./docs/operational-runbook.md) - Day-to-day operations

---

## Environment Variables

Create `.env.local` (never place raw `STELLAR_SECRET_KEY` in Cloudflare Worker memory; signing is delegated exclusively to Turnkey HSM enclaves):

```bash
# Auth (Better Auth ^1.7.23)
BETTER_AUTH_SECRET=random-32-char-secret

# Cloudflare
CLOUDFLARE_ACCOUNT_ID=your-account
CLOUDFLARE_API_TOKEN=your-api-token
D1_DATABASE=apex-os-db

# Turnkey HSM & Multi-Chain USDC Payouts (Zero Raw Keys in Worker Memory)
TURNKEY_ORGANIZATION_ID=your-turnkey-org-id
TURNKEY_API_PUBLIC_KEY=your-turnkey-public-key
TURNKEY_API_PRIVATE_KEY=your-turnkey-private-key
AUTO_SETTLE_PAYOUTS="false"
STELLAR_NETWORK=public  # Circle Native USDC (7dp)
STELLAR_USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
STELLAR_USDC_CODE=USDC

# Exchange Webhook Secrets (ACTIVE: Bybit, OKX, Bitget | SHADOW_ONLY: KuCoin, Gate.io | BLOCKED: Binance)
BYBIT_WEBHOOK_SECRET=your-bybit-secret
OKX_WEBHOOK_SECRET=your-okx-secret
BITGET_WEBHOOK_SECRET=your-bitget-secret
KUCOIN_WEBHOOK_SECRET=your-kucoin-shadow-secret
GATEIO_WEBHOOK_SECRET=your-gateio-shadow-secret

# Email (Resend)
RESEND_API_KEY=re_...
```

---

## Testing Strategy

- **Suite size:** **183 suites / 3,676 tests** verified on Node 26.7.0
- **Unit:** Safe-Spread Waterfall I4 (`10^-8` USD integer math), B2B agency contracts, matching algorithm, earnings calculator, Turnkey HSM / USDC settlement rails, geo-fencing
- **Integration:** Click → conversion flow, `CASH_COLLECTED` reconciliation, `T+7` maturity holds, webhook HMAC & replay protection
- **Coverage target:** 70% on `src/lib/`
- **Mock webhook:** `scripts/send-mock-webhook.ts` for local testing

---

## Security Notes

- **Zero Raw Private Keys in Worker Memory:** Production payout signing runs inside Turnkey HSM enclaves behind hot-wallet caps (`<=$250/tx`, `<=$1,500/24h`), Safe 2-of-3 cold multisig reserves, and `AUTO_SETTLE_PAYOUTS = "false"`
- **Webhook HMAC & Replay Protection:** All exchange webhooks verify HMAC-SHA256 signatures, 5-minute timestamp windows, and 24h KV replay nonces
- **Rate Limiting:** Persistent D1 rate limits (`032_persistent_d1_rate_limits.sql`) on `/api/tracking/click` and auth endpoints
- **Edge Geo-Fencing:** Deterministic `cf-ipcountry` HTTP 451 gate + `BLOCK_VN_SIGNUPS` circuit breaker (blocks new signups/onboarding/attribution while allowing existing user sign-in and withdrawals)
- **Admin Routes:** Check `user.role === 'admin'` via Better Auth middleware and WebAuthn passkey step-up for sensitive treasury actions
- **SQL Injection:** Parameterized D1 queries throughout
- **Payout Authorization:** Only admin can trigger `/api/payouts/run`

---

## File Structure

```
src/
├── app/
│   ├── [locale]/
│   │   ├── admin/
│   │   │   ├── affiliates/page.tsx    # Partner management
│   │   │   ├── alerts/page.tsx        # Alert dashboard
│   │   │   ├── analytics/page.tsx     # Traffic & user analytics
│   │   │   ├── deals/page.tsx         # Deal CRUD
│   │   │   ├── health/page.tsx        # System health
│   │   │   └── metrics/page.tsx       # Business metrics dashboard
│   │   ├── dashboard/
│   │   │   ├── page.tsx               # Trader & partner rebate overview
│   │   │   ├── affiliates/page.tsx    # Partner stats, Safe-Spread I4 & tree
│   │   │   ├── conversions/page.tsx   # Conversion history
│   │   │   ├── payouts/page.tsx       # Payout records
│   │   │   └── dashboard-overview.tsx
│   │   ├── deals/
│   │   │   ├── page.tsx               # Public listing with filters
│   │   │   └── [slug]/page.tsx        # Detail + attribution redirect
│   │   ├── legal/
│   │   │   ├── terms/page.tsx
│   │   │   ├── non-custodial-disclosure/page.tsx
│   │   │   └── geo-restriction/page.tsx
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
│   │   │   ├── b2b-contracts/route.ts
│   │   │   ├── deals/route.ts
│   │   │   ├── fraud/
│   │   │   ├── health/route.ts
│   │   │   ├── metrics/route.ts
│   │   │   └── notifications/route.ts
│   │   ├── affiliate/
│   │   │   ├── conversions/route.ts
│   │   │   ├── dashboard/route.ts
│   │   │   └── payouts/route.ts
│   │   ├── deals/
│   │   │   ├── route.ts               # GET list, POST create
│   │   │   └── [id]/route.ts          # GET one, PATCH, DELETE
│   │   ├── payments/                  # Legacy/deprecated NOWPayments routes
│   │   ├── tracking/click/route.ts
│   │   ├── webhooks/exchange/route.ts
│   │   ├── webhooks/ipn/route.ts      # Legacy/deprecated NOWPayments IPN
│   │   ├── webhooks/resend/route.ts
│   │   ├── monitoring/
│   │   │   ├── alert-engine/route.ts
│   │   │   ├── d1/route.ts
│   │   │   └── d1/snoozes/
│   │   ├── metrics/
│   │   │   ├── business/route.ts      # Business metrics API
│   │   │   └── timeseries/route.ts    # Time-series data
│   │   ├── health/route.ts
│   │   ├── payouts/route.ts
│   │   ├── profile/route.ts
│   │   └── public/
│   │       └── deals/route.ts
│   ├── layout.tsx
│   └── page.tsx (redirect)
├── components/
│   ├── WalletConnect.tsx              # Self-custody wallet connect
│   ├── admin/
│   │   ├── admin-nav.tsx              # Admin navigation sidebar
│   │   ├── BusinessKpiCards.tsx       # KPI card components
│   │   ├── analytics/                 # Analytics chart components
│   │   └── treasury/                  # B2B contracts & treasury controls
│   ├── dashboard/
│   │   ├── dashboard-header.tsx
│   │   ├── dashboard-layout.tsx
│   │   └── dashboard-sidebar.tsx
│   └── landing/
│       └── rebate-calculator.tsx      # Safe-Spread Waterfall I4 calculator
├── contexts/
│   └── auth-context.tsx
├── database/migrations/               # 47 SQL files (001 through 032_persistent_d1_rate_limits.sql)
├── i18n/
│   ├── request.ts
│   └── messages/vi.json, en.json
├── lib/
│   ├── auth/
│   │   ├── auth-factory.ts
│   │   └── adapters/d1-adapter.ts
│   ├── compliance/
│   │   └── geo-fence.ts               # HTTP 451 geo-fence & BLOCK_VN_SIGNUPS
│   ├── deals/                         # Deal CRUD logic
│   ├── ledger/
│   │   ├── waterfall.ts               # Safe-Spread Waterfall I4 (10^-8 USD)
│   │   └── b2b-agency-contracts.ts    # B2B L2 contract enforcement
│   ├── tracking/
│   │   ├── cookie-manager.ts
│   │   └── matcher.ts                 # Attribution matcher
│   ├── earnings/calculator.ts
│   ├── payouts/                       # Turnkey HSM & Circle Native USDC settlement
│   ├── monitoring/
│   │   ├── metrics-cache.ts           # KV-based caching
│   │   ├── alert-engine.ts            # Alert evaluation
│   │   └── notification-channels.ts   # Email/Slack/Telegram
│   └── emails/notifier.ts
├── types/
│   ├── profile.ts
│   ├── deal.ts
│   ├── metrics.ts                     # Business metrics types
│   └── alerts.ts                      # Alert configuration types
├── __tests__/                         # 183 suites / 3,676 tests
└── scripts/
    ├── migrate-to-affiliate.sh
    ├── send-mock-webhook.ts
    └── setup-monitoring.sh
```

---

## Deployment Runbook

See `docs/deployment-runbook.md` and `docs/operational-runbook.md` for:
- Cloudflare Workers (OpenNext) setup
- D1 database & R2 evidence bucket provisioning
- Environment variables & Turnkey HSM checklist
- Cron job configuration
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

- **Multi-chain settlement:** Circle Native USDC on **Stellar (7dp)**, **Arbitrum One (6dp)**, and **Base (6dp)**; **Ethereum L1 & Solana** are `DISABLED_PHASE1`; `AUTO_SETTLE_PAYOUTS = "false"`
- **Exchange integrations:** **Bybit, OKX, Bitget** (`ACTIVE`); **KuCoin UTA v2 & Gate.io v4** (`SHADOW_ONLY`, 30-day clean shadow gate); **Binance** (`BLOCKED`)
- **Compliance:** Vietnam Decree 40/2018/ND-CP (L3+ hard-locked at `0%`), Vietnam Resolution 05/2025/NQ-CP (`BLOCK_VN_SIGNUPS` circuit breaker), OFAC/sanctions HTTP 451 edge geo-fencing, 48-hour wallet-change timelock
- **Fraud prevention:** IP hashing, persistent D1 rate limiting (`032_persistent_d1_rate_limits.sql`), alert engine with circuit breaker protection
- **Admin Dashboards:** See `docs/admin-dashboards.md` for comprehensive user guide
- **Metrics API:** See `docs/api/metrics-api.md` for API documentation
- **Alert Procedures:** See `docs/alert-response-procedures.md` for incident response
