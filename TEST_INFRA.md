# Test Infrastructure Architecture & Reference Guide
**ApexOS Fraud Detection & Anomaly Engine**
*Author: `teamwork_preview_test_writer_e2e_1` (E2E Test Writer)*
*Target Directory: `/Users/macbook/apex-os`*
*Date: 2026-09-25*

---

## 1. Overview & Objectives

This document specifies the opaque-box end-to-end (E2E) testing infrastructure, database mocks, request simulation engines, and execution harnesses for the **ApexOS Fraud Detection & Anomaly Engine**.

The testing framework enables requirement-driven, opaque-box verification across all 12 features (F1..F12) defined in `PROJECT.md` and `ORIGINAL_REQUEST.md` (Sprint requirement `## 2026-09-25T09:04:14Z`):
1. **F1: D1 Database Schema Extension** (`021_fraud_detection_schema.sql`, `deal_clicks` columns, `blocked_ips`, `fraud_reviews`, immutability triggers)
2. **F2: Core Types & Interface Contracts** (`src/types/fraud.ts`)
3. **F3: Dual-Window IP Rate Limiter** (100 clicks/hour, 1,000 clicks/day per IP, RFC 6585 HTTP 429)
4. **F4: IP Blocklist & Auto-Blocking** (`blocked_ips` table check, HTTP 403 Forbidden)
5. **F5: Click Ingestion Route Protection** (`/api/deals/[id]/click`, `/api/tracking/click`)
6. **F6: Conversion Attribution Compatibility** (`Matcher.resolveClick` safeguard in `src/lib/tracking/matcher.ts`)
7. **F7: Rapid Burst Anomaly Detection** (< 2,000ms interval, `BURST_CLICK`)
8. **F8: Click-to-Conversion Ratio Velocity** (> 10:1 ratio, `HIGH_CLICK_CONVERSION_RATIO`)
9. **F9: Flag Reasons & Score Persistence** (atomic persistence on `deal_clicks`)
10. **F10: Admin Fraud Dashboard UI** (`/admin/fraud` page & components)
11. **F11: Admin Fraud API Endpoints** (`/api/admin/fraud/*` guarded by `requireAdmin`)
12. **F12: Immutable Audit Logging** (`fraud_reviews` table, immutable triggers, audit trails)

---

## 2. Test Execution Commands

```bash
# Run the complete Fraud Detection & Anomaly Engine E2E test suite
node ./node_modules/jest/bin/jest.js src/__tests__/fraud/

# Run individual test tiers
node ./node_modules/jest/bin/jest.js src/__tests__/fraud/e2e-tier1-features.test.ts
node ./node_modules/jest/bin/jest.js src/__tests__/fraud/e2e-tier2-boundaries.test.ts
node ./node_modules/jest/bin/jest.js src/__tests__/fraud/e2e-tier3-combinations.test.ts
node ./node_modules/jest/bin/jest.js src/__tests__/fraud/e2e-tier4-scenarios.test.ts

# Run tests by feature pattern
node ./node_modules/jest/bin/jest.js -t "Rate Limiter"
node ./node_modules/jest/bin/jest.js -t "Blocklist"
node ./node_modules/jest/bin/jest.js -t "Burst"
node ./node_modules/jest/bin/jest.js -t "Conversion Ratio"
node ./node_modules/jest/bin/jest.js -t "Admin Fraud"
node ./node_modules/jest/bin/jest.js -t "Audit Logging"
```

---

## 3. Directory Layout & Test Suite Hierarchy

```
src/__tests__/fraud/
├── fraud-test-harness.ts          # Shared mock D1 DB, request factory, auth emulator, route dispatcher
├── e2e-tier1-features.test.ts       # Tier 1: Core Feature Coverage (>=5 tests per feature, F1..F12)
├── e2e-tier2-boundaries.test.ts     # Tier 2: Boundary & Corner Cases (>=5 tests per feature, F1..F12)
├── e2e-tier3-combinations.test.ts   # Tier 3: Pairwise Cross-Feature Interactions (12+ tests)
└── e2e-tier4-scenarios.test.ts      # Tier 4: Real-World Complex Multi-Step Scenarios (5+ tests)
```

---

## 4. Test Infrastructure Components

### 4.1. In-Memory D1 Mock Database (`MockFraudDatabase`)
Located in `src/__tests__/fraud/fraud-test-harness.ts`:
- Emulates Cloudflare D1 SQLite database binding `globalThis.DB` and `@/lib/db`.
- Supports statement preparation: `db.prepare(sql).bind(...params).first()`, `.all()`, `.run()`.
- Supports atomic batch transactions: `db.batch([stmt1, stmt2, stmt3])`.
- Immutability trigger simulation: intercepts `UPDATE` or `DELETE` on `fraud_reviews` and raises an SQLite immutability error.
- In-memory tables:
  - `deal_clicks`: `id, deal_id, affiliate_code, affiliate_id, session_id, ip_address, user_agent, referrer_url, country_code, device_type, click_type, is_unique, is_suspicious, flag_reasons, anomaly_score, created_at`
  - `deals`: `id, url, title, is_active, default_commission_rate, default_commission_type, fixed_commission_amount, created_at`
  - `conversions`: `id, deal_id, affiliate_code, affiliate_id, user_id, amount, status, created_at`
  - `blocked_ips`: `id, ip_address, reason, blocked_by, blocked_at, expires_at, created_at, updated_at`
  - `fraud_reviews`: `id, click_id, reviewer_id, action, reason, notes, metadata, created_at`
  - `profiles`: `id, email, full_name, role, plan, tier, referral_code, created_at, updated_at`
  - `wallet_connections`: `id, profile_id, wallet_address, preferred_chain, is_primary, connected_at, last_used_at`
  - `referral_tree`: `id, affiliate_id, parent_id, path, created_at, updated_at`

### 4.2. Request Simulation & IP Extraction Engine
- `createFraudTestRequest(urlPath, options)`: Creates Next.js `NextRequest` objects with:
  - Flexible IP headers: `cf-connecting-ip`, `x-forwarded-for` (with multi-hop proxy chains), and `x-real-ip`.
  - Session tracking cookie: `apex_tracking_id`.
  - Browser headers: `User-Agent`, `Referer`, `cf-ipcountry`.
  - Admin authentication: Session cookie `better-auth.session_token=admin-session` and Authorization Bearer tokens.
  - Active test request tracking for `next/headers` integration.

### 4.3. Dynamic Route Dispatcher & Progressive Testability
- `dispatchRoute(routeRelativePath, method, request, routeParams)`:
  - Safely checks route file presence using `fs.existsSync`.
  - Dynamically imports route module and executes requested HTTP verb (`GET`, `POST`, `PATCH`, `DELETE`).
  - Forwards route parameters promise `{ params: Promise.resolve(routeParams) }`.
  - Returns structured `RouteInvocationResult`:
    - `status`: HTTP response status code
    - `data`: Parsed JSON body
    - `implemented`: Boolean flag indicating module presence (returns `status: 501` if pending builder milestone)
    - `headers`: Response headers wrapper (`get(key)`)

### 4.4. Dynamic Fraud Engine Loader
- `getFraudEngine()`: Dynamically imports `src/lib/fraud/fraud-engine.ts` if present.
- `isFraudEngineImplemented()`: Checks if the fraud engine module exists.
- Enables progressive contract verification without module resolution failures during early milestones.

---

## 5. Feature Inventory & Mapping

| Feature ID | Description | Primary Code Artifact | Milestone | Verification Target |
|---|---|---|---|---|
| **F1** | D1 Schema Extension | `src/database/migrations/021_fraud_detection_schema.sql` | M1 | Schema presence, column definitions, index creation, trigger definitions |
| **F2** | Core Types & Contracts | `src/types/fraud.ts` | M1 | Type exports, reason codes, action enums, interface contracts |
| **F3** | Dual-Window Rate Limiter | `src/lib/fraud/fraud-engine.ts` (`checkIpRateLimit`) | M2 | 100 clicks/hr, 1000 clicks/day, HTTP 429, `Retry-After` header |
| **F4** | IP Blocklist & Auto-Block | `src/lib/fraud/fraud-engine.ts` (`isIpBlocked`) | M2 | `blocked_ips` query, HTTP 403 Forbidden, auto-blocking repeated offenders |
| **F5** | Click Route Protection | `deals/[id]/click/route.ts`, `tracking/click/route.ts` | M2 | IP extraction, early rejection before click write, redirect protection |
| **F6** | Conversion Safeguard | `src/lib/tracking/matcher.ts` (`Matcher.resolveClick`) | M2 | Ignores `is_suspicious = 1`, allows approved clicks and clean traffic |
| **F7** | Burst Anomaly Detection | `src/lib/fraud/fraud-engine.ts` (`evaluateClickVelocity`) | M3 | Consecutive clicks < 2,000ms interval, flags `BURST_CLICK` |
| **F8** | Conversion Ratio Velocity | `src/lib/fraud/fraud-engine.ts` (`evaluateClickVelocity`) | M3 | Click-to-conversion > 10.0 with >= 10 clicks, flags `HIGH_CLICK_CONVERSION_RATIO` |
| **F9** | Flag Persistence | `src/lib/fraud/fraud-engine.ts` / click ingestion | M3 | Atomic persistence of `is_suspicious`, `flag_reasons`, and `anomaly_score` |
| **F10** | Admin Fraud Dashboard | `src/app/[locale]/admin/fraud/page.tsx` & components | M4 | Dashboard render, KPI indicators, reason filters, clicks list |
| **F11** | Admin Fraud APIs | `src/app/api/admin/fraud/*` | M4 | `clicks`, `stats`, `actions`, `blocked-ips`, guarded by `requireAdmin` |
| **F12** | Immutable Audit Logging | `src/lib/fraud/fraud-engine.ts` (`recordFraudDecision`) | M4 | Immutable audit insert into `fraud_reviews`, immutability trigger protection |

---

## 6. Coverage Thresholds

| Test Tier | Focus & Scope | Minimum Requirement | Authored Target |
|---|---|---|---|
| **Tier 1: Feature Coverage** | Comprehensive primary path and specification behavior across F1..F12 | >= 5 per feature (>= 60) | 65 tests |
| **Tier 2: Boundary & Corner Cases** | Rate limits (100th vs 101st, 1000th vs 1001st), 2000ms boundary, IPv6, empty/spoofed headers, triggers | >= 5 per feature (>= 60) | 65 tests |
| **Tier 3: Pairwise Combinations** | Cross-feature interactions (Rate Limit + Burst, Blocked IP + Audit, Suspicious Click + Matcher) | >= 10 tests | 12 tests |
| **Tier 4: Real-World Scenarios** | Multi-step end-to-end user journeys & security simulations (Bot flood, bulk mitigation, legitimate traffic) | >= 5 tests | 5 tests |
| **Total** | | **>= 135 tests** | **147 tests** |

---

## 7. Pass/Fail Semantics & Progressive Verification

1. **Progressive Testability**:
   - Tests evaluate routes and engine functions dynamically.
   - For pending milestones (e.g., M2 routes or M4 admin APIs before implementation), `dispatchRoute` safely detects unwritten files and returns `status: 501, implemented: false`.
   - Once a milestone is implemented by the builder agent, the exact same test file immediately validates full behavioral assertions (status 200/403/429, payload schemas, DB writes).

2. **Opaque-Box Requirement Verification**:
   - Tests assert on observable HTTP responses (status, headers, body) and database mutations in Cloudflare D1.
   - No internals of the engine are mocked during execution; tests exercise actual business logic end-to-end.

3. **Escalation Protocol**:
   - Implementation bugs discovered during test execution are recorded in `handoff.md` and escalated to the orchestrator and builder agents without altering test expectations.
