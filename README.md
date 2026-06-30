# ApexOS

**Global Crypto Cashback & Affiliate Hub**

ApexOS is a full-stack platform that enables users to earn cashback on crypto exchange trades and allows affiliates to earn multi-tier commissions (30%/10%/5%). Built with Next.js 16 and deployed on Cloudflare Pages.

**Live Demo:** https://apex-os.pages.dev  
**Documentation:** See [docs/](./docs/) folder  
**Deployment Runbook:** [docs/deployment-runbook.md](./docs/deployment-runbook.md)

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Detailed Setup](#detailed-setup)
- [Database Setup](#database-setup)
- [Running the Application](#running-the-application)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Deployment](#deployment)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Multi-tenant Affiliate System**: 3-level referral tree with automatic commission tracking
- **Exchange Integrations**: Binance, Bybit webhook processing for trade verification
- **Real-time Attribution**: Cookie-based click tracking with 30-day attribution window
- **Automated Payouts**: Weekly Stellar USDC payout processing
- **International Payments**: Polar (global) + SePay (Vietnam) integration
- **Multi-language**: Vietnamese & English (next-intl)
- **Admin Dashboard**: Deal management, user oversight, earnings review
- **Comprehensive Alerting**: D1 monitoring, business metrics alerts, multi-channel notifications (email/Slack/Telegram)
- **Performance Monitoring**: Real-time health checks, query performance analysis, circuit breaker protection

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Framework** | Next.js 16 (App Router) |
| **Language** | TypeScript 5.4 |
| **Styling** | Tailwind CSS 3.4 |
| **Authentication** | Better Auth 0.8.7 (custom D1 adapter) |
| **Database** | Cloudflare D1 (SQLite) |
| **Cache** | Cloudflare KV |
| **Storage** | Cloudflare R2 |
| **Deployment** | Cloudflare Pages + OpenNext |
| **Email** | Resend API |
| **Payments** | Stellar SDK (USDC), Polar, SePay |
| **State Management** | Zustand (ready), React Context |
| **i18n** | next-intl |
| **Testing** | Jest + Testing Library |

---

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** 18.x or 20.x (LTS recommended)
- **pnpm** 8.x or newer
- **Wrangler CLI** (Cloudflare Workers CLI)
- **Git**

Verify installations:

```bash
node --version    # Should be >= 18.x
pnpm --version    # Should be >= 8.x
wrangler --version
```

Install Wrangler if not present:

```bash
npm install -g wrangler
wrangler login  # Authenticate with Cloudflare
```

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-org/apex-os.git
cd apex-os

# 2. Install dependencies
pnpm install

# 3. Set up environment variables
cp .env.local.example .env.local
# Edit .env.local with your credentials (see Environment Variables section)

# 4. Create Cloudflare D1 database
wrangler d1 create apex-os-db

# 5. Update wrangler.toml with the database_id from step 4

# 6. Apply database schema
wrangler d1 execute apex-os-db --file src/database/migrations/001_initial_schema_d1.sql
wrangler d1 execute apex-os-db --file src/database/migrations/002_auth_tables.sql
wrangler d1 execute apex-os-db --file src/database/migrations/003_affiliate_schema.sql
wrangler d1 execute apex-os-db --file src/database/migrations/004_add_deals_filters.sql

# 7. Run development server
pnpm dev
# Open http://localhost:3000 in your browser
```

---

## Detailed Setup

### 1. Cloudflare Account Setup

You need a Cloudflare account with access to:
- **Pages** (for hosting)
- **D1** (database)
- **KV** (caching)
- **R2** (file storage)
- **Workers** (serverless functions)

#### Create API Token

Go to [Cloudflare Dashboard > Profile > API Tokens](https://dash.cloudflare.com/profile/api-tokens):

Create a token with these permissions:

| Resource | Permissions |
|-----------|-------------|
| Account | `Account.Info` (Read) |
| Pages | `Pages.Read`, `Pages.Write`, `Pages.Delete` |
| Worker & Pages | `Worker & Pages Scripts.Modify`, `Worker & Pages Scripts.Read` |
| D1 | `D1.Read`, `D1.Write` |
| R2 | `R2.Read`, `R2.Write`, `R2.List` |
| KV | `KV.Read`, `KV.Write` |

Save the token as `CLOUDFLARE_API_TOKEN` in your shell profile:

```bash
export CLOUDFLARE_API_TOKEN="your-token-here"
```

#### Get Account ID

```bash
wrangler whoami
# Output includes your account ID
```

Save as `CF_ACCOUNT_ID`:

```bash
export CF_ACCOUNT_ID="your-account-id"
```

---

### 2. Environment Variables

Copy `.env.local.example` to `.env.local` and fill in all required values:

```bash
cp .env.local.example .env.local
```

#### Required Variables

**Authentication:**

```bash
# Generate with: openssl rand -base64 32
BETTER_AUTH_SECRET=your-32-char-base64-secret

# Optional: Also generate for encryption
BETTER_AUTH_ENCRYPTION_KEY=your-32-char-base64-key
```

**Application:**

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SITE_URL=https://your-domain.com
```

**Email (Resend):**

```bash
RESEND_API_KEY=re_your_resend_key
NEXT_PUBLIC_SENDER_EMAIL=noreply@yourdomain.com
NEXT_PUBLIC_SUPPORT_EMAIL=support@yourdomain.com
```

**Stellar Payouts:**

```bash
STELLAR_SECRET_KEY=Gyour_stellar_secret_key
STELLAR_NETWORK=testnet  # or 'mainnet'
STELLAR_USDC_ISSUER=G...  # issuer address for your network
STELLAR_USDC_CODE=USDC
```

**Exchange Webhooks:**

```bash
BINANCE_WEBHOOK_SECRET=your-binance-secret
BYBIT_WEBHOOK_SECRET=your-bybit-secret
```

**Payments:**

```bash
# Polar (international subscriptions)
POLAR_ACCESS_TOKEN=your-polar-token
POLAR_WEBHOOK_SECRET=your-polar-webhook-secret
POLAR_ORGANIZATION_ID=org_your_id

# SePay (Vietnam QR payments)
SEPAY_MERCHANT_ID=your-sepay-merchant-id
SEPAY_SECRET_KEY=your-sepay-secret-key
SEPAY_API_URL=https://api.sepay.vn
```

**AI Services (optional):**

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

---

### 3. Database Setup

#### Create D1 Database

```bash
wrangler d1 create apex-os-db
```

Copy the `database_id` from the output and update `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "apex-os-db"
database_id = "your-database-id-here"
```

#### Apply Migrations

Run migrations in order:

```bash
# Core schema with auth tables
wrangler d1 execute apex-os-db --file src/database/migrations/001_initial_schema_d1.sql

# Better Auth tables
wrangler d1 execute apex-os-db --file src/database/migrations/002_auth_tables.sql

# Affiliate system schema
wrangler d1 execute apex-os-db --file src/database/migrations/003_affiliate_schema.sql

# Deal filters indexes
wrangler d1 execute apex-os-db --file src/database/migrations/004_add_deals_filters.sql
```

Or run all at once:

```bash
for file in src/database/migrations/*.sql; do
  echo "Running $file..."
  wrangler d1 execute apex-os-db --file "$file"
done
```

#### Verify Schema

```bash
wrangler d1 execute apex-os-db --command "
  SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
"
```

Expected tables:
- `profiles`, `accounts`, `sessions`, `verification_tokens` (auth)
- `affiliate_codes`
- `referral_tree`
- `deals`
- `deal_clicks`
- `conversions`
- `earnings`
- `payouts`

---

### 4. KV Namespace Setup (Optional for local)

```bash
wrangler kv namespace create apex-os-cache
```

Update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "your-kv-namespace-id"
```

---

### 5. R2 Bucket Setup (Optional for local)

```bash
wrangler r2 bucket create apex-os-uploads
```

Update `wrangler.toml` (already included):

```toml
[[r2_buckets]]
binding = "STORAGE"
bucket_name = "apex-os-uploads"
```

---

## Running the Application

### Development Mode

```bash
pnpm dev
```

The app will be available at `http://localhost:3000`. It automatically redirects to `/vi` (Vietnamese).

**Hot reload**: Changes to files automatically trigger a rebuild.

**Local D1**: The app uses your local `.wrangler/` state for D1 bindings when running `wrangler dev`.

### Production Build

```bash
# Build the application
pnpm build

# Start production server
pnpm start
# Runs at http://localhost:3000
```

Build output is in `.next/` directory.

---

## Testing

```bash
# Run all tests once
pnpm test

# Watch mode (for development)
pnpm test:watch

# With coverage report
pnpm test:coverage

# Run specific test file
pnpm test __tests__/matching.test.ts

# Run tests matching a pattern
pnpm test -t "should calculate commission correctly"
```

Test files are co-located with source in `__tests__/` or alongside files with `.test.ts` extension.

---

## Project Structure

```
apex-os/
├── src/
│   ├── app/
│   │   ├── [locale]/           # Locale-based routing (vi/en)
│   │   │   ├── admin/
│   │   │   │   ├── deals/      # Admin deal management CRUD
│   │   │   │   └── analytics/  # Admin analytics dashboard
│   │   │   ├── affiliate/      # Affiliate dashboard & stats
│   │   │   ├── deals/          # Public deal listing & details
│   │   │   ├── dashboard/      # User dashboard (earnings, referrals)
│   │   │   ├── health/         # Health check endpoint
│   │   │   ├── login/          # Authentication pages
│   │   │   ├── monitoring/     # System monitoring endpoints
│   │   │   ├── payouts/        # Payout history & management
│   │   │   ├── profile/        # User profile settings
│   │   │   ├── public/         # Public pages (landing, about)
│   │   │   ├── signup/
│   │   │   ├── tracking/       # Click tracking redirect
│   │   │   └── layout.tsx      # Locale wrapper
│   │   ├── api/
│   │   │   ├── admin/          # Admin-only API routes
│   │   │   ├── affiliate/      # Affiliate stats & referral data
│   │   │   ├── auth/[...all]/  # Better Auth routes
│   │   │   ├── cron/           # Scheduled jobs (payouts, monitoring)
│   │   │   ├── deals/          # CRUD for deals
│   │   │   ├── health/         # Health check API
│   │   │   ├── monitoring/     # Metrics & alerts
│   │   │   ├── payouts/        # Payout execution
│   │   │   ├── profile/        # User profile API
│   │   │   ├── public/         # Public data endpoints
│   │   │   ├── tracking/click/ # Click attribution
│   │   │   ├── webhooks/
│   │   │   │   ├── exchange/   # Binance, Bybit trade webhooks
│   │   │   │   ├── polar/      # Polar subscription webhooks
│   │   │   │   └── resend/     # Resend email webhooks
│   │   │   └── layout.tsx
│   │   ├── layout.tsx
│   │   └── page.tsx            # Redirects to locale
│   ├── components/
│   │   ├── dashboard/          # Dashboard UI components
│   │   └── WalletConnect.tsx   # Wallet connection component
│   ├── contexts/
│   │   └── auth-context.tsx    # Auth provider + useAuth hook
│   ├── database/
│   │   └── migrations/         # SQL schema files
│   │       ├── 001_initial_schema.sql
│   │       ├── 001_initial_schema_d1.sql
│   │       ├── 002_auth_tables.sql
│   │       ├── 002_deals_schema_d1.sql
│   │       ├── 003_affiliate_schema.sql
│   │       ├── 004_add_deals_filters.sql
│   │       ├── 005_alert_history.sql
│   │       └── 005_d1_monitoring.sql
│   ├── i18n/
│   │   ├── request.ts          # Locale detection
│   │   └── messages/           # Translation JSONs (vi.json, en.json)
│   ├── lib/
│   │   ├── auth/
│   │   │   ├── auth-factory.ts
│   │   │   └── adapters/d1-adapter.ts
│   │   ├── deals/              # Deal CRUD logic
│   │   ├── earnings/
│   │   │   └── calculator.ts   # Commission calculation
│   │   ├── emails/
│   │   │   └── notifier.ts     # Email notifications
│   │   ├── payouts/
│   │   │   ├── stellar-service.ts  # Stellar USDC integration
│   │   │   └── batch-builder.ts    # Payout batch processing
│   │   ├── tracking/
│   │   │   ├── cookie-manager.ts   # 30-day cookie handling
│   │   │   └── matcher.ts          # Core referral matching
│   │   └── treasury/               # Multi-sig treasury management
│   ├── middleware.ts            # Locale bypass for API routes
│   ├── types/
│   │   ├── profile.ts
│   │   ├── deal.ts
│   │   ├── earning.ts
│   │   └── payout.ts
│   └── __tests__/
│       ├── integration/
│       ├── matching.test.ts
│       └── earnings.test.ts
├── public/                      # Static assets
├── docs/                        # Project documentation
│   ├── deployment-runbook.md
│   ├── operational-runbook.md  # Day-to-day operations guide
│   ├── monitoring-setup.md
│   └── ...
├── scripts/
│   ├── migrate-to-affiliate.sh
│   ├── send-mock-webhook.ts
│   ├── setup-monitoring.sh
│   └── test-health.sh
├── .env.local.example           # Environment template
├── wrangler.toml               # Cloudflare configuration
├── open-next.config.ts         # OpenNext adapter config
├── next.config.js              # Next.js configuration
├── tailwind.config.js          # Tailwind CSS config
├── jest.config.js              # Jest configuration
├── package.json
├── pnpm-lock.yaml
└── README.md                    # This file
```

---

## Deployment

### Build for Cloudflare Pages

```bash
# Production build (generates .open-next/)
pnpm build
```

The OpenNext adapter produces `.open-next/` containing:
- `worker.js` - Main Cloudflare Worker entry
- `static/` - Static assets
- `functions/` - Serverless functions
- `_routes` - Routing configuration

### Deploy via Wrangler CLI

```bash
# First deployment (creates Pages project)
wrangler pages deploy .open-next --project-name apex-os

# Subsequent deployments
wrangler pages deploy .open-next

# Deploy a specific branch (preview)
wrangler pages deploy .open-next --branch feature-branch
```

### Deploy via GitHub (Recommended)

1. Push code to GitHub
2. Go to [Cloudflare Pages](https://pages.cloudflare.com)
3. **Create a project** → Connect GitHub repository
4. Configure build settings:
   - **Build command**: `pnpm build`
   - **Build output directory**: `.open-next`
   - **Node version**: `18` or `20`
   - **Package manager**: `pnpm`
5. Add all environment variables (see Environment Variables)
6. Click **Save and Deploy**

### Post-Deployment

1. Verify health endpoint:
   ```bash
   curl https://your-app.pages.dev/api/health
   ```

2. Test authentication flow
3. Configure webhooks (see Webhook Configuration below)
4. Set up monitoring (see deployment-runbook.md)

---

## Environment Variables

See `.env.local.example` for complete list.

### Production Setup (Cloudflare Dashboard)

1. Go to **Pages** → Your Project → **Settings** → **Environment variables**
2. Add all variables from `.env.local`
3. Mark sensitive values as **Sensitive** (encrypted)
4. Set for **Production** environment
5. Redeploy for changes to take effect

---

## Webhook Configuration

### Binance

1. Create API key with `Enable Futures` and `Enable Margin` permissions
2. Set webhook URL: `https://your-app.pages.dev/api/webhooks/exchange/binance`
3. Configure webhook secret as `BINANCE_WEBHOOK_SECRET`
4. Enable webhook events: `ORDER_TRADE_UPDATE`

Test locally:
```bash
tsx scripts/send-mock-webhook.ts --exchange binance --volume 1000 --email user@example.com
```

### Bybit

1. In Bybit API settings, create API key with `Order` and `Trade` permissions
2. Set webhook URL: `https://your-app.pages.dev/api/webhooks/exchange/bybit`
3. Set webhook secret = `BYBIT_WEBHOOK_SECRET`

---

## Testing Locally with Wrangler

For full-stack local testing with D1 bindings:

```bash
# Start local Workers dev server
wrangler dev

# Access at http://localhost:8787
```

This runs the Cloudflare Worker locally with all bindings (D1, KV, R2).

---

## Common Issues

### D1 Database Not Found

```bash
# Check if database exists
wrangler d1 list

# If missing, recreate
wrangler d1 create apex-os-db
# Update wrangler.toml with new database_id
```

### Better Auth Secret Error

```bash
# Generate a proper 32+ character secret
openssl rand -base64 32
```

### Build Fails with OpenNext

```bash
# Ensure correct Node version (18 or 20)
node --version

# Clean and reinstall
rm -rf node_modules .next .open-next
pnpm install
pnpm build
```

### Images Not Loading

Cloudflare Pages doesn't support Next.js image optimization. Ensure `next.config.js` has:

```javascript
images: {
  unoptimized: true,
}
```

---

## Development Workflow

### Git Workflow

We use [Conventional Commits](https://www.conventionalcommits.org/):

```bash
git commit -m "feat: add deal filtering by exchange"
git commit -m "fix: resolve cookie domain in tracking"
git commit -m "refactor: split matcher into separate module"
git commit -m "test: add unit tests for earnings calculator"
```

### Code Quality

```bash
# Lint
pnpm lint

# Type check (if using tsc)
npx tsc --noEmit

# Run all tests before committing
pnpm test
```

---

## Architecture Notes

### Attribution Flow

1. **Click**: User clicks deal → `POST /api/tracking/click` records `deal_clicks`, sets 30-day `ref` cookie
2. **Trade**: Exchange sends webhook to `POST /api/webhooks/exchange`
3. **Match**: System finds user by wallet/email + click within 30d → gets `affiliate_code`
4. **Commission**: Resolves referral tree (3 levels) → calculates tiers (30%/10%/5%)
5. **Payout**: Weekly cron aggregates `earnings` → Stellar USDC batch payout

### Database Design

Double-entry ledger pattern:
- `earnings` table records all commission allocations
- `source_type`: `direct` | `affiliate` | `tier2` | `tier3`
- `payouts` table groups earnings into batch transactions

---

## Documentation

- [Deployment Runbook](./docs/deployment-runbook.md) - Complete deployment guide
- [Operational Runbook](./docs/operational-runbook.md) - Day-to-day operations, monitoring, incident response
- [Monitoring Setup](./docs/monitoring-setup.md) - Detailed monitoring configuration
- [Security Audit](./SECURITY-AUDIT.md) - Security review findings
- [CLAUDE.md](./CLAUDE.md) - Development guidelines for Claude Code

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting
5. Submit a pull request

For major changes, please open an issue first to discuss.

---

## License

Private - All rights reserved
