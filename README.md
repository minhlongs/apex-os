# ApexOS — Auditable Proof-of-Rebate & B2B Crypto Fee Ledger (v1.5.0)

[![Version](https://img.shields.io/badge/version-1.5.0-blue.svg)](./package.json)
[![Tests](https://img.shields.io/badge/tests-180%20suites%20%7C%203%2C643%2B%20passed-brightgreen.svg)](./src/__tests__/sandbox)
[![TypeCheck](https://img.shields.io/badge/typescript-0%20errors-brightgreen.svg)](#testing--quality-verification)
[![Bundle Size](https://img.shields.io/badge/mobile%20bundle-5.4%20MB%20(%3C50MB)-success.svg)](./apex-os-mobile)
[![License](https://img.shields.io/badge/license-Private-red.svg)](#contributing--license)

ApexOS is a non-custodial, cryptographically auditable Proof-of-Rebate platform (Hệ thống Đối soát Hoàn phí B2B Khả Kiểm toán) built on Cloudflare Workers, D1, and R2. It reconciles verified partner commissions (`CASH_COLLECTED`) from official **Bybit Affiliate v5**, **OKX Affiliate / FD Broker v5**, and **Bitget Broker v2** feeds (`ACTIVE`), stages **KuCoin UTA v2** and **Gate.io v4** in `SHADOW_ONLY` mode behind a 30-day clean shadow gate, and hard-blocks **Binance** (`BLOCKED` due to missing customer UIDs in standard Referral Pro auto-attribution). Postings are held in an atomic `10^-8` USD double-entry D1 ledger for **T+7 days**, distributed via the **Safe-Spread Waterfall I4** (`5%` clawback reserve, `47.5%` trader rebate, `14.25%` L1 direct partner, `<=4.75%` L2 B2B agency override under executed contract only / `0%` retail, and `0%` L3+ hard-locked per Vietnam Decree 40/2018/ND-CP), and settled as `$10+` **Circle Native USDC** across **Stellar (Protocol 30, 7dp)**, **Arbitrum One (6dp)**, and **Base (6dp)** (`Ethereum L1` and `Solana` are `DISABLED_PHASE1`) behind **Turnkey HSM** enclave signing (zero raw `STELLAR_SECRET_KEY` in Cloudflare Worker memory), hot-wallet caps (`<=$250/tx`, `<=$1,500/24h`), **Safe 2-of-3** cold multisig reserves, and `AUTO_SETTLE_PAYOUTS = "false"`.

ApexOS combines a Next.js 16 web application running on Cloudflare Workers (OpenNext), D1, KV, and R2 edge infrastructure with a cross-platform React Native / Expo mobile application.

- **Production Worker URL:** [https://apex-os.agencyos-openclaw.workers.dev](https://apex-os.agencyos-openclaw.workers.dev)
- **Staging Worker URL:** [https://apex-os-staging.agencyos-openclaw.workers.dev](https://apex-os-staging.agencyos-openclaw.workers.dev)
- **API Directory:** [docs/api-endpoints.md](./docs/api-endpoints.md)
- **Mobile Guide:** [docs/mobile/README.md](./docs/mobile/README.md)
- **Fraud Engine Guide:** [docs/fraud/README.md](./docs/fraud/README.md)
- **Payments & Billing Guide (Legacy):** [docs/payments/README.md](./docs/payments/README.md)
- **Email Lifecycle Guide:** [docs/email/README.md](./docs/email/README.md)

---

## Table of Contents

1. [Key Features](#key-features)
2. [Architecture Overview](#architecture-overview)
3. [Tech Stack](#tech-stack)
4. [Quick Start](#quick-start)
5. [Environment Configuration](#environment-configuration)
6. [Database & Migrations](#database--migrations)
7. [ApexOS Mobile Application](#apexos-mobile-application)
8. [Multi-Exchange Ingestion & Attribution Matrix](#multi-exchange-ingestion--attribution-matrix)
9. [Fraud Detection & Anomaly Engine](#fraud-detection--anomaly-engine)
10. [Legacy Billing & NOWPayments (Deprecated)](#legacy-billing--nowpayments-deprecated)
11. [Advanced Analytics Engine](#advanced-analytics-engine)
12. [Transactional Email Automation](#transactional-email-automation)
13. [Testing & Quality Verification](#testing--quality-verification)
14. [Deployment Runbook](#deployment-runbook)
15. [Project Structure](#project-structure)
16. [Contributing & License](#contributing--license)

---

## Key Features

- **UID-Only Non-Custodial Exchange Attribution:** Zero exchange API keys required. Reconciles verified `CASH_COLLECTED` partner commissions across **Bybit, OKX, and Bitget** (`ACTIVE`), with **KuCoin UTA v2** and **Gate.io v4** gated in `SHADOW_ONLY` (30-day clean shadow gate) and **Binance** hard-blocked (`BLOCKED`). Includes HMAC-SHA256 verification, 5-minute timestamp windows, and KV replay protection.
- **Safe-Spread Waterfall I4 & Atomic `10^-8` USD Ledger:** Signed-integer double-entry accounting with **T+7 maturity hold** and verified `CASH_COLLECTED` gating:
  - **5%** clawback reserve
  - **47.5%** gross trader fee rebate (`50%` of post-5%-reserve distributable commission)
  - **14.25%** gross L1 direct partner (`30%` of platform spread)
  - **<=4.75%** gross L2 B2B agency override (`<=10%` of platform spread, executed B2B contract only; `0%` retail)
  - **0%** L3+ hard-locked (Vietnam Decree 40/2018/ND-CP anti-MLM compliance)
- **Multi-Chain Self-Custody USDC Settlement & HSM Treasury:** Direct payouts (`$10.00` minimum) in **Circle Native USDC** on **Stellar (7dp)**, **Arbitrum One (6dp)**, and **Base (6dp)** (`Ethereum L1` and `Solana` are `DISABLED_PHASE1`). Signed exclusively inside **Turnkey HSM** enclaves (zero raw `STELLAR_SECRET_KEY` in Worker memory) with **Safe 2-of-3** cold multisig reserves, 48-hour wallet-change timelock, and `AUTO_SETTLE_PAYOUTS = "false"`.
- **Fraud Detection & Velocity Anomaly Engine:** Real-time click protection featuring dual-window rate limiting (**100 clicks/hr**, **1,000 clicks/day**), persistent D1 rate-limit storage, repeat offender auto-blocking (**150 clicks/hr**), velocity burst detection (<2s), conversion ratio skew (>10:1), active IP blocklist (HTTP 403), edge geo-fencing (HTTP 451 + `BLOCK_VN_SIGNUPS` circuit breaker), and immutable admin audit logging (`fraud_reviews`).
- **Advanced Analytics Dashboard:** Materialized D1 views for daily deals, affiliates, exchanges, and lifecycle funnel. Edge cached with Cloudflare KV (5-minute TTL, `X-Cache: HIT|MISS`) and interactive Recharts visualizations.
- **Lifecycle Transactional Email Automation:** 5 responsive React Email templates (`Welcome`, `ConversionEarned`, `PayoutSent`, `WeeklySummary`, `DealExpiring`) paired with a resilient D1 queue, priority scheduling, and automated retry processor (<3 retries) via Resend.
- **ApexOS Mobile (iOS & Android):** Built with React Native 0.86 and Expo SDK 52 (`apex-os-mobile`), Hermes AOT bytecode engine, 5.4MB production bundle (<50MB ceiling), EAS Build profiles, App Store / TestFlight readiness, root `ErrorBoundary`, safe area handling, and deep link scheme `apex-os://`.
- **Legacy Billing (Deprecated):** NOWPayments checkout/IPN routes remain in the codebase for historical compatibility only; production Ascendancy v1.5.0 is 100% non-custodial fee-rebate.
- **Internationalization & Localization:** Full English and Vietnamese localization via `next-intl`.

---

## Architecture Overview

```
                                  ApexOS Ascendancy v1.5.0 Architecture

      Mobile Client (iOS & Android)               Web Browser (Desktop / Mobile)
     [React Native / Expo 52 / Hermes]              [Next.js 16 App Router]
                    │                                          │
                    │         https / JSON                     │
                    └──────────────────┬───────────────────────┘
                                       │
                                       ▼
                       Cloudflare Edge Network / Workers
                 ┌───────────────────────────────────────────┐
                 │  - OpenNext Runtime / Serverless Workers  │
                 │  - Cloudflare KV Cache (5m TTL)           │
                 │  - Edge Geo-Fence (HTTP 451) & Rate Limit │
                 └─────────────────────┬─────────────────────┘
                                       │
           ┌───────────────────────────┼───────────────────────────┐
           ▼                           ▼                           ▼
   Exchange Partner Feeds     Legacy Billing (Deprecated)   Core Application
  Bybit / OKX / Bitget [LIVE]  NOWPayments IPN (Legacy)     Better Auth (^1.7.23),
  KuCoin / Gate.io [SHADOW]    HMAC-SHA512 Verification     Waterfall I4, Fraud,
  Binance [BLOCKED]                                         Proof-of-Rebate (R2)
           │                           │                           │
           └───────────────────────────┼───────────────────────────┘
                                       │
                                       ▼
                         Cloudflare D1 Database (SQLite)
             - 47 SQL Migrations (up to 032_persistent_d1_rate_limits.sql)
             - Atomic 10^-8 USD double-entry ledger + T+7 maturity hold
             - CASH_COLLECTED verification & B2B agency contracts
             - Immutable fraud_reviews triggers (INSERT-only)
                                       │
                                       ▼
                           External Service Gateways
             - Turnkey HSM Enclave + Safe 2-of-3 Cold Multisig
               -> Circle Native USDC: Stellar (7dp), Arbitrum (6dp), Base (6dp)
               -> Ethereum L1 & Solana: DISABLED_PHASE1 | AUTO_SETTLE_PAYOUTS="false"
             - Cloudflare R2 (Immutable 5-year SHA-256 Proof-of-Rebate evidence)
             - Resend API (Transactional Email Queue Worker)
```

---

## Tech Stack

| Layer | Technology | Details |
|---|---|---|
| **Web Framework** | Next.js 16 (App Router) | React 18, Server Components, TypeScript 5.x |
| **Authentication** | Better Auth (`^1.7.23`) | Custom D1 adapter, WebAuthn ES256 passkey step-up |
| **Edge Platform** | Cloudflare Workers & Pages | OpenNext adapter, zero-cold-start edge functions |
| **Database** | Cloudflare D1 | Distributed SQLite with 47 SQL migrations & triggers |
| **Evidence Storage** | Cloudflare R2 | Immutable 5-year SHA-256 Proof-of-Rebate archive |
| **Edge Cache** | Cloudflare KV | 5-minute TTL caching layer & webhook replay nonces |
| **Mobile Runtime** | React Native 0.86 / Expo 52 | Managed workflow, Hermes bytecode, EAS Build |
| **Mobile State** | Zustand 5.x / SecureStore | Encrypted JWT & credentials persistence |
| **Settlement Rails** | Turnkey HSM + Safe 2-of-3 | Circle Native USDC on Stellar (7dp), Arbitrum (6dp), Base (6dp); ETH L1 & Solana `DISABLED_PHASE1` |
| **Legacy Billing** | NOWPayments API & IPN | Deprecated legacy routes (production Ascendancy is 100% fee-rebate) |
| **Email** | Resend & React Email | 5 lifecycle templates, D1 priority queue, hourly cron |
| **Styling** | Tailwind CSS 3.4 | Responsive dark-mode first design tokens |
| **Testing** | Jest 29 + Vitest 4 | **183 suites / 3,676 tests** passing |

---

## Quick Start

### 1. Prerequisites
- **Node.js** 26.x (verified on **26.7.0**, ABI 147 required for `better-sqlite3`; see `.nvmrc`)
- **npm** or **pnpm** (v8+)
- **Wrangler CLI** (`npm install -g wrangler`)
- **Git**

### 2. Clone & Install
```bash
# Clone repository with submodules
git clone --recurse-submodules https://github.com/minhlongs/apex-os.git
cd apex-os

# Install root dependencies
npm install

# Install mobile dependencies
cd apex-os-mobile && npm install && cd ..
```

### 3. Configure Local Environment
```bash
cp .env.local.example .env.local
# Populate necessary secrets (see Environment Configuration section)
```

### 4. Initialize Local Database
```bash
# Apply migrations to local SQLite/D1 state
npm run seed
# Initialize fraud rate limiter tables
npm run rate-limit:init
```

### 5. Start Development Servers
```bash
# Start Web application (Next.js)
npm run dev
# Running at http://localhost:3000

# In a separate terminal, start Mobile development server (Expo)
cd apex-os-mobile
npx expo start
```

---

## Environment Configuration

Store these credentials in `.env.local` for local execution, or in Cloudflare Workers Secrets for production. Never place raw signing private keys (`STELLAR_SECRET_KEY`) in Cloudflare Worker memory — production signing is delegated exclusively to **Turnkey HSM** enclaves.

```bash
# --- Authentication (Better Auth ^1.7.23) ---
BETTER_AUTH_SECRET=your-32-character-random-secret
BETTER_AUTH_URL=http://localhost:3000

# --- Exchange Partner Credentials (ACTIVE: Bybit, OKX, Bitget | SHADOW_ONLY: KuCoin, Gate.io | BLOCKED: Binance) ---
BYBIT_WEBHOOK_SECRET=your-bybit-webhook-secret
OKX_WEBHOOK_SECRET=your-okx-webhook-secret
BITGET_WEBHOOK_SECRET=your-bitget-webhook-secret
KUCOIN_WEBHOOK_SECRET=your-kucoin-shadow-secret
GATEIO_WEBHOOK_SECRET=your-gateio-shadow-secret

# --- Turnkey HSM & Multi-Chain USDC Settlement (Zero Raw Keys in Worker Memory) ---
TURNKEY_ORGANIZATION_ID=your-turnkey-org-id
TURNKEY_API_PUBLIC_KEY=your-turnkey-public-key
TURNKEY_API_PRIVATE_KEY=your-turnkey-private-key
AUTO_SETTLE_PAYOUTS="false"
STELLAR_NETWORK=public # Circle Native USDC (7dp)
STELLAR_USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN

# --- Email Automation (Resend) ---
RESEND_API_KEY=re_your_resend_api_key
NEXT_PUBLIC_SENDER_EMAIL=ApexOS <noreply@apexos.app>
NEXT_PUBLIC_SUPPORT_EMAIL=support@apexos.app
CRON_SECRET=your-internal-cron-bearer-token

# --- Legacy Billing (Deprecated — NOWPayments routes disabled in fee-rebate production) ---
NOWPAYMENTS_API_KEY=legacy-only
NOWPAYMENTS_IPN_SECRET=legacy-only
```

---

## Database & Migrations

ApexOS schema is managed via **47 SQL migration files** in `src/database/migrations/` (latest: `032_persistent_d1_rate_limits.sql`):

```bash
# Execute local database schema
wrangler d1 execute apex-os-db --local --file=src/database/schema-complete.sql

# Execute latest production database migration
wrangler d1 execute apex-os-db --remote --file=src/database/migrations/032_persistent_d1_rate_limits.sql
```

Key tables:
- `deals`, `deal_clicks`: Deals and click tracking with `is_suspicious` flags.
- `conversions`, `earnings`, `payouts`: Atomic `10^-8` USD double-entry accounting ledger with `T+7` maturity holds and `CASH_COLLECTED` gating.
- `b2b_agency_contracts`: Executed B2B L2 agency override contracts (`<=10%` of platform spread / `<=4.75%` gross, `tier3_spread_bps = 0` hard-locked).
- `blocked_ips`, `fraud_reviews`, `d1_rate_limits`: IP blocklist, persistent D1 rate limiting, and immutable admin review audit trail.
- `email_queue`, `email_events`: Transactional email lifecycle and delivery event logs.
- `payments`, `tier_activations`: Legacy/deprecated NOWPayments billing history.
- `device_tokens`, `deep_link_analytics`: Mobile client push notification and routing analytics.

---

## ApexOS Mobile Application

Located in `apex-os-mobile/`, the mobile client provides non-custodial crypto fee-rebate access for iOS and Android.

- **Architecture Guide:** [docs/mobile/README.md](./docs/mobile/README.md)
- **Bundle Optimization:** Total production bundle size is **5.4 MB** (iOS Hermes bytecode: 2.6 MB, Android Hermes bytecode: 2.6 MB), well below the 50 MB budget limit (89.2% headroom).
- **Deep Linking:** Custom scheme `apex-os://` routes cold starts and push taps (`apex-os://billing/result`, `apex-os://wallet-connected`).
- **Resilience:** Wrapped in a root `ErrorBoundary` component with user-friendly retry diagnostics and responsive safe-area insets.

```bash
cd apex-os-mobile

# Run mobile test suite
npm test

# Typecheck mobile TypeScript
npm run type-check

# Export production bundle to dist/
npx expo export

# Trigger EAS cloud builds
eas build --profile preview --platform all
eas build --profile production --platform all
```

---

## Multi-Exchange Ingestion & Attribution Matrix

| Exchange | Status | Feed / Gate |
|---|---|---|
| **Bybit** | `ACTIVE` | Official Bybit Affiliate v5 (`CASH_COLLECTED` verified) |
| **OKX** | `ACTIVE` | Official OKX Affiliate / FD Broker v5 (`CASH_COLLECTED` verified) |
| **Bitget** | `ACTIVE` | Official Bitget Broker v2 (`CASH_COLLECTED` verified) |
| **KuCoin** | `SHADOW_ONLY` | KuCoin UTA v2 — gated behind 30-day clean shadow gate |
| **Gate.io** | `SHADOW_ONLY` | Gate.io v4 — gated behind 30-day clean shadow gate |
| **Binance** | `BLOCKED` | Hard-blocked (standard Referral Pro lacks customer UIDs for auto-attribution) |

Endpoints:
- `POST /api/webhooks/exchange` (Auto-routing unified endpoint)
- `POST /api/webhooks/exchange/okx` (Dedicated OKX handler)
- `POST /api/webhooks/exchange/kucoin` (Dedicated KuCoin shadow handler)

### Verification Controls
1. **HMAC Signatures:** Computes SHA-256 digests over incoming timestamp, HTTP method, request path, and raw body.
2. **Timestamp Window:** Enforces a strict 5-minute validity window (`DEFAULT_TIMESTAMP_WINDOW_MS = 300,000`).
3. **KV Replay Protection:** Replay nonces cached with 24-hour TTL in Cloudflare KV.
4. **CASH_COLLECTED & T+7 Hold:** Postings require verified partner settlement (`CASH_COLLECTED`) and clear a `T+7` clawback hold before USDC disbursement eligibility.
5. **Idempotency:** Unique index on `conversions(exchange_trade_id, exchange_name)`.

---

## Fraud Detection & Anomaly Engine

Comprehensive click protection preventing affiliate fraud:
- **Full Guide:** [docs/fraud/README.md](./docs/fraud/README.md)
- **Dual-Window Rate Limiting:** 100 clicks/hr and 1,000 clicks/day per IP backed by persistent D1 rate-limit storage (`032_persistent_d1_rate_limits.sql`). Exceeding limits returns RFC 6585 HTTP 429.
- **Repeat Offender Auto-Block:** IPs exceeding 150 clicks in 1 hour are auto-blocked into `blocked_ips`.
- **Velocity Burst Detection:** Rapid clicks (<2s delta) from the same IP/session trigger `BURST_CLICK` anomaly flags.
- **Conversion Ratio Skew:** Clicks exceeding a 10:1 ratio on deals with >=10 clicks trigger `HIGH_CLICK_CONVERSION_RATIO`.
- **Edge Geo-Fencing:** Deterministic `cf-ipcountry` HTTP 451 gate plus runtime `BLOCK_VN_SIGNUPS` circuit breaker (blocks new signups/onboarding/attribution while preserving existing user sign-in and withdrawals).
- **IP Blocklist:** Active blocked IPs are rejected with HTTP 403 Forbidden without logging affiliate clicks.
- **Admin Dashboard & Audit:** Inspect suspicious clicks at `/admin/fraud` and record immutable review decisions in `fraud_reviews`.

```bash
# Manage rate limiting via CLI
npm run rate-limit:stats
npm run rate-limit:cleanup
```

---

## Legacy Billing & NOWPayments (Deprecated)

> **Deprecation Notice:** Production ApexOS Ascendancy v1.5.0 is **100% non-custodial fee-rebate**. Subscription billing and NOWPayments checkout/IPN routes are retained solely as legacy/deprecated paths for historical data continuity.

- **Legacy Guide:** [docs/payments/README.md](./docs/payments/README.md)
- **Legacy Checkout (Deprecated):** `POST /api/payments`
- **Legacy IPN Webhook (Deprecated):** `POST /api/webhooks/ipn` (HMAC-SHA512 verification)
- **Active Wallet Binding:** `POST /api/profile/wallet` binds self-custody payout addresses for **Stellar (7dp)**, **Arbitrum One (6dp)**, and **Base (6dp)** with checksum validation and a mandatory 48-hour wallet-change timelock (`Ethereum L1` and `Solana` are `DISABLED_PHASE1`).

---

## Advanced Analytics Engine

- **Database Views (`018_analytics_views.sql`):** Pre-aggregated daily reporting on deals, affiliates, exchanges, and conversion funnels.
- **KV Caching:** API responses cached for 5 minutes (`Cache-Control: public, s-maxage=300`, `X-Cache: HIT|MISS`).
- **Dashboard UI:** Administrative analytics at `/[locale]/admin/analytics` featuring revenue trends, conversion breakdowns, top affiliate leaderboards, and CSV exports.

---

## Transactional Email Automation

- **Full Guide:** [docs/email/README.md](./docs/email/README.md)
- **5 React Email Templates:** `WelcomeEmail`, `ConversionEarnedEmail`, `PayoutSentEmail`, `WeeklySummaryEmail`, `DealExpiringEmail`.
- **Queue Architecture:** Priority queue in D1 (`email_queue`) with deduplication keys preventing accidental duplicate dispatches.
- **Retry Processor:** Automatically retries failed dispatches up to 3 times before dead-lettering.
- **Cron Worker:** `POST /api/cron/process-email-queue` processes queued batches hourly.

---

## Testing & Quality Verification

ApexOS maintains a comprehensive automated testing pipeline (**183 suites / 3,676 tests** verified on Node 26.7.0):

```bash
# 1. Run all Web application tests (Jest: 183 suites / 3,676 tests)
npm test

# 2. Run all Mobile application tests (Vitest)
cd apex-os-mobile && npm test && cd ..

# 3. Typecheck entire web repository (0 errors)
npm run typecheck

# 4. Typecheck entire mobile repository (0 errors)
cd apex-os-mobile && npm run type-check && cd ..

# 5. Verify Web production build
npm run build

# 6. Verify Mobile production bundle export (<50MB)
cd apex-os-mobile && npx expo export && cd ..
```

---

## Deployment Runbook

### Deploy Web to Cloudflare Workers (OpenNext)
```bash
# Build OpenNext Worker distribution
npm run build:worker

# Deploy Staging or Production Worker via Wrangler
npx wrangler deploy --config wrangler.staging.jsonc
npx wrangler deploy --config wrangler.jsonc
```

### Deploy Mobile to App Store & Google Play
```bash
cd apex-os-mobile

# Build and submit iOS to TestFlight / App Store
eas build --platform ios --profile production --auto-submit

# Build and submit Android to Google Play Internal Testing
eas build --platform android --profile production --auto-submit
```

---

## Project Structure

```
apex-os/
├── apex-os-mobile/                 # Mobile client (React Native / Expo 52)
│   ├── App.tsx                     # ErrorBoundary & Navigation root
│   ├── app.json                    # Bundle ID (com.apexos.app), schemes, icons
│   ├── eas.json                    # EAS build profiles (dev, preview, prod)
│   ├── metadata/                   # App Store & Google Play metadata
│   └── src/                        # Screens, navigation, stores, api
├── src/
│   ├── app/
│   │   ├── [locale]/               # Next.js localized app router
│   │   │   ├── admin/              # Deals, Analytics, Fraud, Treasury dashboards
│   │   │   ├── dashboard/          # Trader & Partner rebate portal
│   │   │   ├── legal/              # Terms, Non-Custodial Disclosure, Geo-Restriction
│   │   │   └── ...
│   │   └── api/                    # API route handlers
│   │       ├── admin/              # Fraud, B2B contracts, analytics, health
│   │       ├── analytics/          # Deals, affiliates, exchanges, funnel
│   │       ├── payments/           # Legacy/deprecated NOWPayments routes
│   │       ├── profile/wallet/     # Self-custody USDC wallet binding (48h timelock)
│   │       ├── tracking/click/     # Click tracking with inline fraud & geo gate
│   │       ├── webhooks/           # Multi-exchange, legacy IPN, and Resend webhooks
│   │       └── cron/               # Scheduled workers (emails, analytics, reconciliation)
│   ├── components/                 # React UI components & admin widgets
│   ├── database/                   # 47 SQL migrations (up to 032_persistent_d1_rate_limits.sql)
│   ├── emails/                     # React Email component templates
│   ├── lib/
│   │   ├── analytics/              # Query builder & view materializer
│   │   ├── compliance/             # Edge geo-fencing (HTTP 451) & sanctions checks
│   │   ├── emails/                 # Queue service & retry scheduler
│   │   ├── fraud/                  # Rate limiter, velocity engine, IP blocker
│   │   ├── ledger/                 # Atomic 10^-8 USD double-entry & Safe-Spread Waterfall I4
│   │   ├── payouts/                # Turnkey HSM & Circle Native USDC settlement
│   │   └── webhooks/               # Replay protection & HMAC verifiers
│   └── types/                      # TypeScript type declarations
├── docs/                           # Architecture guides & documentation
│   ├── api-endpoints.md            # Comprehensive API directory
│   ├── mobile/README.md            # Mobile architecture & EAS release guide
│   ├── fraud/README.md             # Fraud engine & rate limiting guide
│   ├── payments/README.md          # Legacy NOWPayments & IPN webhook guide
│   ├── email/README.md             # Transactional email & queue guide
│   └── deployment-runbook.md       # Operational deployment runbook
├── plans/                          # Roadmap & sprint plan archives
├── package.json                    # Root version 1.5.0 & npm scripts
└── README.md                       # This documentation
```

---

## Contributing & License

Private repository — All rights reserved © 2026 ApexOS Team.
