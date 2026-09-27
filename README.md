# ApexOS — Global Crypto Cashback & Affiliate Platform (v1.1.0)

[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)](./package.json)
[![Tests](https://img.shields.io/badge/tests-120%20suites%20%7C%202%2C893%20passed-brightgreen.svg)](./tests)
[![TypeCheck](https://img.shields.io/badge/typescript-0%20errors-brightgreen.svg)](#testing)
[![Bundle Size](https://img.shields.io/badge/mobile%20bundle-5.4%20MB%20(%3C50MB)-success.svg)](./apex-os-mobile)
[![License](https://img.shields.io/badge/license-Private-red.svg)](#license)

ApexOS is an enterprise-grade crypto cashback and affiliate platform enabling traders to earn cash rebates on cryptocurrency trades across major global exchanges (**Binance, Bybit, OKX, KuCoin**) and empowering affiliate networks with automated 3-level referral commissions (30% / 10% / 5%). 

ApexOS combines a Next.js 16 web application running on Cloudflare Pages & D1 edge infrastructure with a cross-platform React Native / Expo 52 mobile application.

- **Production URL:** [https://apexos.app](https://apexos.app)
- **Live Demo / Staging:** [https://apex-os.pages.dev](https://apex-os.pages.dev)
- **API Directory:** [docs/api-endpoints.md](./docs/api-endpoints.md)
- **Mobile Guide:** [docs/mobile/README.md](./docs/mobile/README.md)
- **Fraud Engine Guide:** [docs/fraud/README.md](./docs/fraud/README.md)
- **Payments & Billing Guide:** [docs/payments/README.md](./docs/payments/README.md)
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
8. [Multi-Exchange Webhook Ingestion](#multi-exchange-webhook-ingestion)
9. [Fraud Detection & Anomaly Engine](#fraud-detection--anomaly-engine)
10. [Billing, NOWPayments & Tier Upgrades](#billing-nowpayments--tier-upgrades)
11. [Advanced Analytics Engine](#advanced-analytics-engine)
12. [Transactional Email Automation](#transactional-email-automation)
13. [Testing & Quality Verification](#testing--quality-verification)
14. [Deployment Runbook](#deployment-runbook)
15. [Project Structure](#project-structure)
16. [Contributing & License](#contributing--license)

---

## Key Features

- **Multi-Exchange Trade Attribution:** Seamless trade and cashback tracking across **Binance, Bybit, OKX, and KuCoin**. Webhook endpoints feature cryptographic HMAC-SHA256 signature validation (including KuCoin Base64 encoding), 5-minute timestamp validation windows, and KV replay protection.
- **3-Tier Referral Downline:** Automated multi-level affiliate commission engine allocating 30% (Tier 1 direct), 10% (Tier 2 sub-referral), and 5% (Tier 3 network referral) with instant ledger tracking.
- **NOWPayments Crypto Billing:** Self-service membership tier upgrades (`BASIC`, `PREMIUM`, `ENTERPRISE`, `MASTER`) via NOWPayments crypto checkout. HMAC-SHA512 IPN webhook verification with idempotent tier activations.
- **Non-Custodial Multi-Chain Wallet Binding:** Securely bind payout addresses for Ethereum (EIP-55 checksum), Solana (Base58), and Stellar (StrKey).
- **Fraud Detection & Velocity Anomaly Engine:** Real-time click protection featuring dual-window rate limiting (**100 clicks/hr**, **1,000 clicks/day**), repeat offender auto-blocking (**150 clicks/hr**), velocity burst detection (<2s), conversion ratio skew (>10:1), active IP blocklist (HTTP 403), and immutable admin audit logging (`fraud_reviews`).
- **Advanced Analytics Dashboard:** 5 materialized D1 views for daily deals, affiliates, exchanges, and lifecycle funnel. Edge cached with Cloudflare KV (5-minute TTL, `X-Cache: HIT|MISS`) and interactive Recharts visualizations.
- **Lifecycle Transactional Email Automation:** 5 responsive React Email templates (`Welcome`, `ConversionEarned`, `PayoutSent`, `WeeklySummary`, `DealExpiring`) paired with a resilient D1 queue, priority scheduling, and automated retry processor (<3 retries) via Resend.
- **ApexOS Mobile (iOS & Android):** Built with React Native 0.86 and Expo SDK 52 (`apex-os-mobile`), Hermes AOT bytecode engine, 5.4MB production bundle (<50MB ceiling), EAS Build profiles, App Store / TestFlight readiness, root `ErrorBoundary`, safe area handling, and deep link scheme `apex-os://`.
- **Automated Payout Engine:** Weekly batch payouts in Stellar USDC with on-chain cryptographic receipts.
- **Internationalization & Localization:** Full English and Vietnamese localization via `next-intl`.

---

## Architecture Overview

```
                                  ApexOS Architecture
  
      Mobile Client (iOS & Android)               Web Browser (Desktop / Mobile)
     [React Native / Expo 52 / Hermes]              [Next.js 16 App Router]
                    │                                          │
                    │         https / JSON                     │
                    └──────────────────┬───────────────────────┘
                                       │
                                       ▼
                       Cloudflare Edge Network / Pages
                 ┌───────────────────────────────────────────┐
                 │  - OpenNext Runtime / Serverless Workers  │
                 │  - Cloudflare KV Cache (5m TTL)           │
                 │  - IP Geolocation & Rate Limiting Gate    │
                 └─────────────────────┬─────────────────────┘
                                       │
           ┌───────────────────────────┼───────────────────────────┐
           ▼                           ▼                           ▼
    Exchange Webhooks          Payment & Billing             Core Application
   Binance / Bybit / OKX      NOWPayments IPN Webhook       Auth, Deals, Tracking,
   HMAC-SHA256 Verification   HMAC-SHA512 Verification      Analytics, Fraud Engine
           │                           │                           │
           └───────────────────────────┼───────────────────────────┘
                                       │
                                       ▼
                         Cloudflare D1 Database (SQLite)
             - 22 SQL Migrations (Schema Complete)
             - Double-entry commission & payment ledger
             - Materialized daily analytics reporting views
             - Immutable fraud_reviews triggers (INSERT-only)
                                       │
                                       ▼
                           External Service Gateways
             - Resend API (Transactional Email Queue Worker)
             - Stellar Network (Weekly USDC Payout Engine)
             - Apple Push Notification & Firebase Cloud Messaging
```

---

## Tech Stack

| Layer | Technology | Details |
|---|---|---|
| **Web Framework** | Next.js 16 (App Router) | React 18, Server Components, TypeScript 5.4 |
| **Edge Platform** | Cloudflare Pages & Workers | OpenNext adapter, zero-cold-start edge functions |
| **Database** | Cloudflare D1 | Distributed SQLite with SQL migrations & triggers |
| **Edge Cache** | Cloudflare KV | 5-minute TTL caching layer & webhook replay nonces |
| **Mobile Runtime** | React Native 0.86 / Expo 52 | Managed workflow, Hermes bytecode, EAS Build |
| **Mobile State** | Zustand 5.x / SecureStore | Encrypted JWT & credentials persistence |
| **Crypto Billing** | NOWPayments API & IPN | Multi-currency crypto checkout & HMAC-SHA512 verification |
| **Payouts** | Stellar SDK | USDC settlement, batch transaction builder |
| **Email** | Resend & React Email | 5 lifecycle templates, D1 priority queue, hourly cron |
| **Styling** | Tailwind CSS 3.4 | Responsive dark-mode first design tokens |
| **Testing** | Jest 29 + Vitest 4 | 120 total test suites, 2,893 tests passing 100% |

---

## Quick Start

### 1. Prerequisites
- **Node.js** 20.x (LTS recommended)
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

Store these credentials in `.env.local` for local execution, or in Cloudflare Pages Dashboard for production:

```bash
# --- Authentication (Better Auth) ---
BETTER_AUTH_SECRET=your-32-character-random-secret
BETTER_AUTH_URL=http://localhost:3000

# --- Exchange Webhook Secrets ---
BINANCE_WEBHOOK_SECRET=your-binance-webhook-secret
BYBIT_WEBHOOK_SECRET=your-bybit-webhook-secret
OKX_WEBHOOK_SECRET=your-okx-webhook-secret
KUCOIN_WEBHOOK_SECRET=your-kucoin-webhook-secret

# --- Billing & Crypto Checkout (NOWPayments) ---
NOWPAYMENTS_API_KEY=your-nowpayments-api-key
NOWPAYMENTS_IPN_SECRET=your-nowpayments-ipn-hmac-secret

# --- Email Automation (Resend) ---
RESEND_API_KEY=re_your_resend_api_key
NEXT_PUBLIC_SENDER_EMAIL=ApexOS <noreply@apexos.app>
NEXT_PUBLIC_SUPPORT_EMAIL=support@apexos.app
CRON_SECRET=your-internal-cron-bearer-token

# --- Stellar Blockchain Payouts ---
STELLAR_SECRET_KEY=S...your-stellar-signing-secret
STELLAR_NETWORK=testnet # or 'public'
STELLAR_USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

---

## Database & Migrations

ApexOS schema is managed via 22 forward migrations in `src/database/migrations/`:

```bash
# Execute local database migration
wrangler d1 execute apex-os-db --local --file=src/database/schema-complete.sql

# Execute production database migration
wrangler d1 execute apex-os-db --remote --file=src/database/migrations/022_performance_optimization_indexes.sql
```

Key tables:
- `deals`, `deal_clicks`: Core deals and click tracking with `is_suspicious` flags.
- `conversions`, `earnings`, `payouts`: Double-entry accounting ledger.
- `payments`, `tier_activations`: NOWPayments billing and subscription tier history.
- `blocked_ips`, `fraud_reviews`: IP blocklist and immutable admin review audit trail.
- `email_queue`, `email_events`: Transactional email lifecycle and delivery event logs.
- `device_tokens`, `deep_link_analytics`: Mobile client push notification and routing analytics.

---

## ApexOS Mobile Application

Located in `apex-os-mobile/`, the mobile client provides non-custodial crypto cashback access for iOS and Android.

- **Architecture Guide:** [docs/mobile/README.md](./docs/mobile/README.md)
- **Bundle Optimization:** Total production bundle size is **5.4 MB** (iOS Hermes bytecode: 2.6 MB, Android Hermes bytecode: 2.6 MB), well below the 50 MB budget limit (89.2% headroom).
- **Deep Linking:** Custom scheme `apex-os://` routes cold starts and push taps (`apex-os://billing/result`, `apex-os://wallet-connected`).
- **Resilience:** Wrapped in a root `ErrorBoundary` component with user-friendly retry diagnostics and responsive safe-area insets.

```bash
cd apex-os-mobile

# Run test suite (12 suites, 210 tests passing)
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

## Multi-Exchange Webhook Ingestion

ApexOS supports Binance, Bybit, OKX, and KuCoin through a unified ingestion router and dedicated endpoints:
- `POST /api/webhooks/exchange` (Auto-routing unified endpoint)
- `POST /api/webhooks/exchange/okx` (Dedicated OKX handler)
- `POST /api/webhooks/exchange/kucoin` (Dedicated KuCoin handler)

### Verification Controls
1. **HMAC Signatures:** Computes sha256 digests over incoming timestamp, HTTP method, request path, and raw body.
2. **Timestamp Window:** Enforces a strict 5-minute validity window (`DEFAULT_TIMESTAMP_WINDOW_MS = 300,000`).
3. **KV Replay Protection:** Replay nonces cached with 24-hour TTL in Cloudflare KV.
4. **Idempotency:** Unique index on `conversions(exchange_trade_id, exchange_name)`.

---

## Fraud Detection & Anomaly Engine

Comprehensive click protection preventing affiliate fraud:
- **Full Guide:** [docs/fraud/README.md](./docs/fraud/README.md)
- **Dual-Window Rate Limiting:** 100 clicks/hr and 1,000 clicks/day per IP. Exceeding limits returns RFC 6585 HTTP 429.
- **Repeat Offender Auto-Block:** IPs exceeding 150 clicks in 1 hour are auto-blocked into `blocked_ips`.
- **Velocity Burst Detection:** Rapid clicks (<2s delta) from the same IP/session trigger `BURST_CLICK` anomaly flags.
- **Conversion Ratio Skew:** Clicks exceeding a 10:1 ratio on deals with >=10 clicks trigger `HIGH_CLICK_CONVERSION_RATIO`.
- **IP Blocklist:** Active blocked IPs are rejected with HTTP 403 Forbidden without logging affiliate clicks.
- **Admin Dashboard & Audit:** Inspect suspicious clicks at `/admin/fraud` and record immutable review decisions in `fraud_reviews`.

```bash
# Manage rate limiting via CLI
npm run rate-limit:stats
npm run rate-limit:cleanup
```

---

## Billing, NOWPayments & Tier Upgrades

- **Full Guide:** [docs/payments/README.md](./docs/payments/README.md)
- **Hosted Checkout:** `POST /api/payments` creates invoices for `BASIC` ($9), `PREMIUM` ($29), `ENTERPRISE` ($99), and `MASTER` ($299).
- **IPN Webhook:** `POST /api/webhooks/ipn` verifies HMAC-SHA512 signatures with canonical payload key sorting.
- **Idempotent Activations:** Upgrades user profile tiers upon payment confirmation, logs to `tier_activations`, and enqueues receipt emails.
- **Wallet Binding:** `POST /api/profile/wallet` binds EVM, Solana, and Stellar addresses with checksum validation.

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

ApexOS maintains a comprehensive automated testing pipeline with 100% pass rate:

```bash
# 1. Run all Web application tests (Jest: 108 suites, 2,683 passed, 0 failed)
npm test

# 2. Run all Mobile application tests (Vitest: 12 suites, 210 passed, 0 failed)
cd apex-os-mobile && npm test && cd ..

# 3. Typecheck entire web repository (0 errors)
npx tsc --noEmit

# 4. Typecheck entire mobile repository (0 errors)
cd apex-os-mobile && npm run type-check && cd ..

# 5. Verify Web production build
npm run build

# 6. Verify Mobile production bundle export (<50MB)
cd apex-os-mobile && npx expo export && cd ..
```

---

## Deployment Runbook

### Deploy Web to Cloudflare Pages
```bash
# Build OpenNext distribution
npm run build

# Deploy to Cloudflare Pages via Wrangler
wrangler pages deploy .open-next --project-name apex-os
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
│   │   │   ├── admin/              # Deals, Analytics, and Fraud dashboards
│   │   │   ├── affiliate/          # Affiliate portal & referral tools
│   │   │   └── ...
│   │   └── api/                    # 67 API route handlers
│   │       ├── admin/fraud/        # Fraud review actions, stats, blocked IPs
│   │       ├── analytics/          # Deals, affiliates, exchanges, funnel
│   │       ├── payments/           # NOWPayments checkout & history
│   │       ├── profile/wallet/     # Multi-chain crypto wallet binding
│   │       ├── tracking/click/     # Click tracking with inline fraud gate
│   │       ├── webhooks/           # Multi-exchange, IPN, and Resend webhooks
│   │       └── cron/               # Scheduled workers (emails, analytics)
│   ├── components/                 # React UI components & admin widgets
│   ├── database/                   # 22 SQL migrations & baseline schema
│   ├── emails/                     # React Email component templates
│   ├── lib/
│   │   ├── analytics/              # Query builder & view materializer
│   │   ├── emails/                 # Queue service & retry scheduler
│   │   ├── fraud/                  # Rate limiter, velocity engine, IP blocker
│   │   ├── payouts/                # Stellar USDC settlement engine
│   │   └── webhooks/               # Replay protection & HMAC verifiers
│   └── types/                      # TypeScript type declarations
├── docs/                           # Architecture guides & documentation
│   ├── api-endpoints.md            # Comprehensive API directory
│   ├── mobile/README.md            # Mobile architecture & EAS release guide
│   ├── fraud/README.md             # Fraud engine & rate limiting guide
│   ├── payments/README.md          # NOWPayments & IPN webhook guide
│   ├── email/README.md             # Transactional email & queue guide
│   └── deployment-runbook.md       # Operational deployment runbook
├── plans/                          # Q3 2026 roadmap & sprint plan archives
├── package.json                    # Root version 1.1.0 & npm scripts
└── README.md                       # This documentation
```

---

## Contributing & License

Private repository — All rights reserved © 2026 ApexOS Team.
