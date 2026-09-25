# Project: ApexOS Sprint 7 - Billing & Wallet Connect

## Architecture
- **Framework**: Next.js App Router API Routes running on Cloudflare Workers runtime.
- **Database**: Cloudflare D1 SQL database accessed via `@/lib/db` (`getDB()`) with prepared statements and batch execution (`db.batch`).
- **Authentication**: Better Auth v0.8.7 (`@/lib/auth/auth-factory`) supporting dual session extraction: Bearer token (mobile client) and Cookie header (web dashboard).
- **Payment Provider**: NOWPayments crypto checkout integration with HMAC-SHA512 IPN webhook verification using secret `NOWPAYMENTS_IPN_SECRET`.
- **Notifications**: `EmailQueueService` (`@/lib/emails/email-queue`) targeting Cloudflare D1 `email_queue` and `email_events`.
- **Test Framework**: Jest with `ts-jest` and `jsdom` runner (`node ./node_modules/jest/bin/jest.js`).
- **Code Layout**:
  - `src/database/migrations/020_billing_mobile_enhancements.sql` (schema updates)
  - `src/lib/auth/session-helper.ts` (shared auth session extractor supporting Cookie and Bearer)
  - `src/app/api/payments/route.ts` (payment creation & checkout)
  - `src/app/api/payments/status/route.ts` (status query fix)
  - `src/app/api/payments/history/route.ts` (payment history query)
  - `src/app/api/webhooks/ipn/route.ts` (NOWPayments IPN handler)
  - `src/app/api/profile/wallet/route.ts` (wallet binding & validation)
  - `src/app/api/notifications/register/route.ts` (push token registration)
  - `src/app/api/profile/deep-link-analytics/route.ts` (deep-link analytics batch ingestion)
  - `src/__tests__/billing/` (unit and E2E integration test suites)

## Feature Inventory
Every feature from the Survey phase appears here with its assigned milestone.
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Payment Initiation | `POST /api/payments` creates NOWPayments checkout for BASIC ($9), PREMIUM ($29), ENTERPRISE ($99), MASTER ($299), inserts pending row in `payments` | M2 | Survey 1 & ORIGINAL_REQUEST R1 |
| F2 | Payment History | `GET /api/payments/history` queries user payments sorted by `created_at DESC` with pagination | M2 | Survey 1 & ORIGINAL_REQUEST R1 |
| F3 | IPN Signature Verification | `POST /api/webhooks/ipn` verifies HMAC-SHA512 lowercase hex using `NOWPAYMENTS_IPN_SECRET` with sorted keys and constant-time compare, rejecting invalid with HTTP 401 | M3 | Survey 1, Survey 3 & ORIGINAL_REQUEST R2 |
| F4 | IPN Idempotency | Duplicate webhook callbacks return `{ received: true, deduped: true }` without duplicate updates or double tier increments | M3 | Survey 1 & ORIGINAL_REQUEST R2 |
| F5 | Tier Upgrade & Audit Logging | Confirmed payment updates `profiles.tier` & `profiles.plan` and inserts record into `tier_activations` | M3 | Survey 1 & ORIGINAL_REQUEST R2 |
| F6 | Notification Enqueue | Confirmed payment enqueues receipt/confirmation notification via `EmailQueueService` | M3 | Survey 3 & ORIGINAL_REQUEST R2 |
| F7 | Wallet Profile Association | `POST /api/profile/wallet` validates address format (Ethereum, Solana, Stellar) and updates `profiles` | M4 | Survey 2 & ORIGINAL_REQUEST R3 |
| F8 | Mobile Push Registration | `POST /api/notifications/register` and `DELETE` handles APNs, FCM, Expo push tokens tied to user | M4 | Survey 2 & ORIGINAL_REQUEST R4 |
| F9 | Deep-Link Analytics | `POST /api/profile/deep-link-analytics` ingests batched analytics events without throwing unhandled exceptions | M4 | Survey 2 & ORIGINAL_REQUEST R4 |
| F10 | Infrastructure & Type Safety | Cloudflare D1 migrations (020 migration), fixing TS error in payments status route, 0 TS errors across all files | M1 | Survey 1, Survey 2, Survey 3 & ORIGINAL_REQUEST R5 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Database Schema & Shared Foundation | D1 migration `020_billing_mobile_enhancements.sql`, fix `src/app/api/payments/status/route.ts` DB import, implement `src/lib/auth/session-helper.ts` | none | DONE |
| M2 | Payment Initiation & History (R1) | `POST /api/payments` and `GET /api/payments/history` routes, unit tests | M1 | DONE |
| M3 | IPN Webhook & Tier Lifecycle (R2) | `POST /api/webhooks/ipn` HMAC-SHA512 verification, deduping, tier upgrade, audit log, notification enqueue | M1 | DONE |
| M4 | Mobile Wallet, Push, & Analytics (R3, R4) | `/api/profile/wallet`, `/api/notifications/register`, `/api/profile/deep-link-analytics` | M1 | DONE |
| M5 | E2E Integration Pass & Coverage Hardening (R5) | Pass 100% of E2E tests (Tiers 1-4) published in `TEST_READY.md`, Tier 5 adversarial hardening, 0 TS errors | M2, M3, M4 | DONE |

## Interface Contracts
### Auth Session Helper ↔ API Routes
- Function: `getAuthenticatedUser(request: Request): Promise<{ id: string; email?: string } | null>`
- Behavior: Extracts token from `Authorization: Bearer <token>` or `cookie: session_token=...` / Better Auth headers. Returns null if invalid or unauthenticated.

### Payment Initiation ↔ Database
- `payments` table schema: `(id TEXT PRIMARY KEY, payment_id TEXT UNIQUE NOT NULL, status TEXT, plan TEXT, user_id TEXT, amount REAL, currency TEXT, txn_id TEXT, confirmed_at TEXT, created_at TEXT, updated_at TEXT)`

### IPN Webhook ↔ Database & Queue
- Batch operation:
  1. `UPDATE payments SET status = 'confirmed', confirmed_at = datetime('now'), updated_at = datetime('now') WHERE payment_id = ?`
  2. `UPDATE profiles SET tier = ?, plan = ?, updated_at = datetime('now') WHERE id = ?`
  3. `INSERT INTO tier_activations (id, user_id, payment_id, old_tier, new_tier, activated_by, created_at) VALUES (?, ?, ?, ?, ?, 'ipn', datetime('now'))`
- Queue enqueue:
  - `emailQueueService.enqueue({ templateId: 'payment-receipt', recipientEmail, data: { plan, paymentId, amount, currency } })`

### Wallet Validation ↔ Profile Route
- Ethereum: `/^0x[0-9a-fA-F]{40}$/`
- Solana: `/^[1-9A-HJ-NP-Za-km-z]{32,44}$/`
- Stellar: `/^G[A-Z2-7]{55}$/`
- Supported chains: `'ethereum' | 'solana' | 'stellar'` (case-insensitive normalized to lowercase).

### Push Registration Contract
- Body: `{ expoToken?: string; apnsToken?: string; fcmToken?: string; platform?: 'ios' | 'android' }`
- Persistence: Stored in `device_tokens` table with user association.

### Deep-Link Analytics Contract
- Body: `{ events: Array<{ kind: string; route: string; timestamp: string; source: 'notification' | 'direct' }> }`
- Persistence: Ingested into `deep_link_analytics` table.
