# Project: ApexOS Fraud Detection & Anomaly Engine

## Architecture
- **Framework**: Next.js 15 App Router with Edge / Cloudflare Workers runtime support.
- **Database**: Cloudflare D1 SQL database accessed via `@/lib/db` (`getDB()`) with prepared statements, parameter binding, and atomic batch execution (`db.batch`).
- **Authentication & Authorization**: Better Auth session extraction and admin authorization via `requireAdmin(request)` (`@/lib/admin-auth` and `@/app/api/admin/actions.ts`).
- **Fraud Engine Architecture**:
  - Dual-window sliding/fixed IP rate limiter (100 clicks/hour, 1,000 clicks/day per IP).
  - IP blocklist validator (`blocked_ips`) returning HTTP 403 Forbidden before logging valid affiliate clicks.
  - Velocity detector (<2s burst clicks, >10:1 click-to-conversion ratio) writing `is_suspicious = 1` and `flag_reasons` to `deal_clicks`.
  - Conversion attribution safeguard: `Matcher.resolveClick` in `@/lib/tracking/matcher.ts` filters unapproved suspicious clicks (`AND (is_suspicious = 0 OR is_suspicious IS NULL)`).
  - Admin review dashboard at `/admin/fraud` with inspection filters, anomaly breakdown, and actions (approve, reject, block IP, bulk resolve).
  - Immutable audit trail in `fraud_reviews` capturing every administrative action and IP block/unblock.
- **Test Framework**: Jest with `ts-jest` and `jsdom` runner (`node ./node_modules/jest/bin/jest.js`), with in-memory `MockFraudDatabase` for D1 simulation.

## Feature Inventory
Every feature from the Survey phase appears here with its assigned milestone.
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | D1 Database Schema Extension | Migration `021_fraud_detection_schema.sql` adding `is_suspicious`, `flag_reasons` to `deal_clicks`; creating `blocked_ips`, `fraud_reviews` with immutability trigger; and query indexes | M1 | Survey 2 & ORIGINAL_REQUEST R5 |
| F2 | Core Types & Interface Contracts | Comprehensive TypeScript definitions in `src/types/fraud.ts` for reason codes, review actions, anomaly records, and API contracts | M1 | Survey 1, Survey 2, Survey 3 |
| F3 | Dual-Window IP Rate Limiter | IP rate limiter enforcing 100 clicks/hour and 1,000 clicks/day per IP, returning RFC 6585-compliant HTTP 429 with `Retry-After` headers | M2 | Survey 1 & ORIGINAL_REQUEST R1 |
| F4 | IP Blocklist & Auto-Blocking | Check `blocked_ips` table rejecting requests with HTTP 403 Forbidden without logging valid clicks; auto-block repeated offenders exceeding limits | M2 | Survey 1 & ORIGINAL_REQUEST R1 |
| F5 | Click Ingestion Route Protection | Wrap `src/app/api/deals/[id]/click/route.ts` and `src/app/api/tracking/click/route.ts` with IP extraction, rate limiting, and IP blocklist checks | M2 | Survey 1 & ORIGINAL_REQUEST R1, R5 |
| F6 | Conversion Attribution Compatibility | Update `Matcher.resolveClick` in `src/lib/tracking/matcher.ts` to ignore unapproved suspicious clicks while preserving legitimate attribution and existing test mocks | M2 | Survey 1, Survey 2 & ORIGINAL_REQUEST R5 |
| F7 | Rapid Burst Anomaly Detection | Detect multi-click bursts (<2s between clicks from same IP/session) and flag with `is_suspicious = 1` and reason code `BURST_CLICK` | M3 | Survey 2 & ORIGINAL_REQUEST R2 |
| F8 | Click-to-Conversion Ratio Velocity | Detect abnormal click-to-conversion velocity (>10:1 ratio) per affiliate/deal and flag with `is_suspicious = 1` and reason code `HIGH_CLICK_CONVERSION_RATIO` | M3 | Survey 2 & ORIGINAL_REQUEST R2 |
| F9 | Flag Reasons & Score Persistence | Atomic storage of detection flags, anomaly scores, and JSON array of reason codes on `deal_clicks` records | M3 | Survey 2 & ORIGINAL_REQUEST R2 |
| F10 | Admin Fraud Dashboard UI | Create `/admin/fraud` page and components (`FraudDashboard.tsx`, KPI cards, filter toolbar, clicks table, anomaly breakdown drawer, bulk action bar) | M4 | Survey 3 & ORIGINAL_REQUEST R3 |
| F11 | Admin Fraud API Endpoints | Implement authenticated routes (`/api/admin/fraud/clicks`, `/api/admin/fraud/stats`, `/api/admin/fraud/actions`, `/api/admin/fraud/blocked-ips`) guarded by `requireAdmin` | M4 | Survey 3 & ORIGINAL_REQUEST R3 |
| F12 | Immutable Audit Logging | Atomic persistence of review decisions (approve, reject, block IP, bulk resolve) in `fraud_reviews` with reviewer ID, timestamp, action type, and reason | M4 | Survey 3 & ORIGINAL_REQUEST R4 |
| F13 | Full E2E Test Suite & Typecheck | 100% passing E2E tests (Tiers 1-4), Tier 5 adversarial hardening, 0 TS compiler errors (`tsc --noEmit`), and forensic integrity audit | M5 | Survey 3 & ORIGINAL_REQUEST Quality |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Database Schema & Core Foundation | D1 migration `021_fraud_detection_schema.sql`, core types in `src/types/fraud.ts`, test harness foundation | none | DONE |
| M2 | Click Rate-Limiting, IP Blocking & Route Protection | Dual-window rate limiter (100/hr, 1000/day), `blocked_ips` check, route integration (`/api/deals/[id]/click`, `/api/tracking/click`), attribution compatibility in `matcher.ts` | M1 | DONE |
| M3 | Anomaly Velocity Engine & Click Flagging | Rapid burst detection (<2s), click-to-conversion anomaly (>10:1), flagging persistence (`is_suspicious = 1`, `flag_reasons`) | M1 | DONE |
| M4 | Admin Fraud Dashboard, APIs & Audit Trail | `/admin/fraud` UI page and components, admin nav integration, admin API endpoints, immutable audit logging in `fraud_reviews` | M1, M2, M3 | DONE |
| M5 | E2E Integration Pass & Coverage Hardening | Pass 100% of E2E tests (Tiers 1-4) published in `TEST_READY.md`, Tier 5 adversarial hardening, 0 TS errors, forensic audit | M2, M3, M4 | DONE |

## Interface Contracts
### Fraud Detection & Rate Limiter ↔ API Routes
- Function: `checkIpRateLimit(db: D1Database, ip: string): Promise<{ allowed: boolean; retryAfter?: number; reason?: string }>`
- Function: `isIpBlocked(db: D1Database, ip: string): Promise<boolean>`
- Function: `recordFraudDecision(db: D1Database, params: ReviewDecisionParams): Promise<{ success: boolean; reviewId: string }>`

### Anomaly Velocity Engine ↔ Deal Clicks Ingestion
- Function: `evaluateClickVelocity(db: D1Database, click: IncomingClickData): Promise<{ isSuspicious: boolean; flagReasons: string[]; anomalyScore: number }>`
- Burst threshold: `< 2,000ms` between consecutive clicks for same IP or session.
- Ratio threshold: `> 10.0` click-to-conversion ratio where clicks >= 10.

### Admin Action Payload ↔ `/api/admin/fraud/actions`
- Body: `{ action: 'approve' | 'reject' | 'block_ip' | 'bulk_resolve'; clickIds?: string[]; ip?: string; reason: string }`
- Response: `{ success: true, affectedCount: number, auditIds: string[] }`

### Code Layout
- `src/database/migrations/021_fraud_detection_schema.sql` (schema updates)
- `src/types/fraud.ts` (shared type definitions)
- `src/lib/fraud/fraud-engine.ts` (rate limiting, IP blocking, and velocity checks)
- `src/lib/tracking/matcher.ts` (attribution matching safeguard)
- `src/app/api/deals/[id]/click/route.ts` (deal click ingestion protection)
- `src/app/api/tracking/click/route.ts` (tracking click ingestion protection)
- `src/app/[locale]/admin/fraud/page.tsx` & components in `src/components/admin/fraud/` (admin UI)
- `src/app/api/admin/fraud/` (admin API endpoints)
- `src/__tests__/fraud/` (unit, integration, and E2E test suites)
