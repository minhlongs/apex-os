# Test Infrastructure Architecture & Reference Guide
**ApexOS Sprint 7: Billing & Wallet Connect**
*Author: `teamwork_preview_test_writer_e2e_1` (E2E Test Writer)*
*Target Directory: `/Users/macbook/apex-os`*
*Date: 2026-09-24 / 2026-09-25*

---

## 1. Overview & Objectives

This document specifies the end-to-end (E2E) testing infrastructure, mocking engines, polyfills, cryptographic verification tools, and execution harnesses for **ApexOS Sprint 7: Billing & Wallet Connect**.

The testing framework enables opaque-box, requirement-driven verification across all 10 features defined in `PROJECT.md` and `ORIGINAL_REQUEST.md`:
1. **F1: Payment Initiation** (`POST /api/payments`)
2. **F2: Payment History** (`GET /api/payments/history`)
3. **F3: IPN Signature Verification** (`POST /api/webhooks/ipn` HMAC-SHA512)
4. **F4: IPN Idempotency** (`POST /api/webhooks/ipn` deduplication)
5. **F5: Tier Upgrade & Audit Logging** (`profiles.tier`, `tier_activations`)
6. **F6: Notification Enqueue** (`email_queue`)
7. **F7: Wallet Profile Association** (`POST /api/profile/wallet` - ETH, SOL, XLM)
8. **F8: Device Push Token Registration** (`POST & DELETE /api/notifications/register` - APNs, FCM, Expo)
9. **F9: Batched Deep-Link Analytics Ingestion** (`POST /api/profile/deep-link-analytics`)
10. **F10: Controlled Infrastructure & DB Migrations** (D1 tables, 0 TS errors)

---

## 2. Test Execution Commands

```bash
# Run the complete Sprint 7 Billing & Wallet Connect E2E test suite
node ./node_modules/jest/bin/jest.js src/__tests__/billing/

# Run individual test tiers
node ./node_modules/jest/bin/jest.js src/__tests__/billing/e2e-tier1-features.test.ts
node ./node_modules/jest/bin/jest.js src/__tests__/billing/e2e-tier2-boundaries.test.ts
node ./node_modules/jest/bin/jest.js src/__tests__/billing/e2e-tier3-combinations.test.ts
node ./node_modules/jest/bin/jest.js src/__tests__/billing/e2e-tier4-scenarios.test.ts

# Run tests by name / pattern
node ./node_modules/jest/bin/jest.js -t "Payment Initiation"
node ./node_modules/jest/bin/jest.js -t "IPN Signature"
node ./node_modules/jest/bin/jest.js -t "Wallet Address"
```

---

## 3. Directory Layout & Test Suite Hierarchy

```
src/__tests__/billing/
├── billing-test-harness.ts        # Shared mock D1 DB, auth request factory, HMAC generator, route dispatcher
├── e2e-tier1-features.test.ts     # Tier 1: Core Feature Coverage (>=5 tests per feature, 51 tests)
├── e2e-tier2-boundaries.test.ts   # Tier 2: Boundary & Corner Cases (>=5 tests per feature, 50 tests)
├── e2e-tier3-combinations.test.ts # Tier 3: Pairwise Cross-Feature Interactions (10 tests)
└── e2e-tier4-scenarios.test.ts    # Tier 4: Real-World End-to-End User Journeys (5 tests)
```

**Total Tests**: 116 tests across 4 suites.

---

## 4. Test Infrastructure Components

### 4.1. In-Memory D1 Mock Database (`MockBillingDatabase`)
Located in `src/__tests__/billing/billing-test-harness.ts`:
- Emulates Cloudflare D1 SQLite database binding `globalThis.DB` and `@/lib/db`.
- Supports statement preparation: `db.prepare(sql).bind(...params).first()`, `.all()`, `.run()`.
- Supports atomic batch transactions: `db.batch([stmt1, stmt2, stmt3])`.
- In-memory tables:
  - `payments`: `id, payment_id, status, plan, user_id, amount, currency, txn_id, confirmed_at, created_at, updated_at`
  - `profiles`: `id, email, full_name, role, plan, tier, wallet_address, preferred_chain, notification_settings, created_at, updated_at`
  - `tier_activations`: `id, user_id, payment_id, old_tier, new_tier, activated_by, created_at`
  - `wallet_connections`: `id, profile_id, wallet_address, preferred_chain, is_primary, connected_at, last_used_at`
  - `device_tokens`: `id, user_id, expo_token, platform, apns_token, fcm_token, created_at, updated_at`
  - `deep_link_analytics`: `id, user_id, kind, route, source, event_timestamp, metadata, created_at`
  - `email_queue`: `id, user_id, email, type, subject, html, text, priority, status, metadata, created_at, updated_at`

### 4.2. Cryptographic HMAC-SHA512 Signature Engine
- `sortObjectKeys(obj)`: Recursively sorts all JSON payload keys in alphabetical order, complying with NOWPayments standard webhook canonicalization.
- `generateIpnSignature(payload, secret)`: Computes lowercase hexadecimal HMAC-SHA512 digest matching the authoritative NOWPayments specification transmitted in `x-nowpayments-sig`.

### 4.3. Dual Authentication & Request Builders
- `createTestRequest(urlPath, options)`: Creates Next.js `NextRequest` objects with:
  - Standard headers (`content-type: application/json`).
  - Mobile client Bearer token (`Authorization: Bearer token-<userId>`).
  - Web client Better Auth session cookie (`Cookie: better-auth.session_token=token-<userId>`).
  - Support for unauthenticated and customized headers.

### 4.4. Upstream NOWPayments API Interceptor
- Intercepts `globalThis.fetch` calls targeting `api.nowpayments.io`.
- Configurable via `configureMockNowPayments({ status, response, shouldThrow, throwError })`.
- Records outbound payload bodies, headers, and endpoints in `recordedUpstreamRequests`.

### 4.5. Progressive Testability Route Dispatcher
- `dispatchRoute(routeRelativePath, method, request)`:
  - Safely inspects file existence via `fs.existsSync`.
  - If route exists, dynamically requires the route module and invokes the exported HTTP verb (`POST`, `GET`, `DELETE`).
  - If route is pending implementation by builder agents, returns `{ status: 501, implemented: false }`.
  - Prevents Jest module resolution crashes when running before milestone route files are merged.

---

## 5. Global Web API Polyfills (`jest.setup.ts`)

To ensure standard Next.js App Router API Routes run seamlessly in Jest without Node runtime divergence:
- `global.crypto.subtle`: Mapped to `nodeCrypto.webcrypto.subtle` for WebCrypto HMAC operations.
- `global.Headers`: Case-insensitive header implementation supporting `.get()`, `.set()`, `.has()`, `.forEach()`, and iteration.
- `global.Request`: NextRequest-compatible request class with `headers`, `method`, `url`, `json()`, and `text()`.
- `global.Response`: Complete Response class with `status`, `headers`, `ok` boolean getter (`status >= 200 && status < 300`), and static `Response.json(data, init)`.
