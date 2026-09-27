# Project: ApexOS Sprint 10 — Q3 2026 Final Go-Live Readiness & Master Release Consolidation

## Architecture
- **Web Application**: Next.js 14 App Router, TypeScript, TailwindCSS, Cloudflare Pages/Workers runtime.
- **Database & Storage**: Cloudflare D1 (SQLite) with Drizzle ORM / parameterized queries, Cloudflare KV namespace for caching and replay protection.
- **Exchange Integration**: Unified multi-exchange webhook router supporting Binance, Bybit, OKX, and KuCoin with HMAC-SHA256 signature verification, 5-minute timestamp validation windows, and KV replay protection.
- **Billing & Payments**: NOWPayments crypto checkout integration for tier upgrades (BASIC, PREMIUM, ENTERPRISE, MASTER), HMAC-SHA512 IPN webhook verification, idempotent tier activations.
- **Fraud Detection Engine**: Multi-tier defense on click tracking: dual-window rate limiting (100 clicks/hr, 1,000 clicks/day), velocity burst detection (<2s), click-to-conversion anomaly scoring (>10:1), IP blocklisting, and immutable admin review audit logging.
- **Mobile Application**: React Native 0.86 with Expo SDK 52 in `apex-os-mobile` submodule, Hermes bytecode engine, EAS Build profiles (development, preview, production), bundle size strictly <50MB (5.4MB current).
- **Master Release**: Fast-forward branch consolidation onto `master`, submodule tracking via `.gitmodules`, and semantic release `v1.1.0`.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | KV Analytics Deserialization Fix | Eliminate redundant `JSON.parse` on parsed KV objects in `/api/analytics/{deals,affiliates,exchanges,funnel}` and `/api/affiliate/team` | M1 | Survey 2 |
| F2 | Webhook Replay Protection KV Compatibility | Update `src/lib/webhooks/replay-protection.ts` to use standard Cloudflare KV `get`/`put` instead of unsupported `kv.add` | M1 | Survey 2 |
| F3 | Database Composite Indexes Migration | Add migration `022_performance_optimization_indexes.sql` for `deals(is_active, created_at DESC)` and `payments(user_id, created_at DESC)` | M1 | Survey 2 |
| F4 | Click Velocity Query Optimization | Refactor `deal_clicks` burst query in `src/lib/fraud/fraud-engine.ts` from `OR` to `UNION ALL` to utilize composite indexes | M1 | Survey 2 |
| F5 | Schema Complete Synchronization | Synchronize `src/database/schema-complete.sql` with migrations 012, 018, and 020 (`payments`, `tier_activations`, `device_tokens`, `deep_link_analytics`, `email_queue`) | M1 | Survey 2 |
| F6 | Version Bump to 1.1.0 | Increment `"version": "1.1.0"` in root `package.json` | M2 | Survey 3 |
| F7 | Q3 Completed Documentation Sync | Update `README.md` and `CHANGELOG.md` with complete Q3 features and v1.1.0 release notes | M2 | Survey 3 |
| F8 | Roadmap & Go/No-Go Status Update | Update `plans/q3-2026-roadmap.md` and `plans/README-Q3-ROADMAP.md` to `status: completed` and check all 6 criteria `[x]` | M2 | Survey 1, Survey 3 |
| F9 | Architecture & Integration Guides | Create `docs/mobile/README.md`, `docs/fraud/README.md`, `docs/payments/README.md`, `docs/email/README.md`, and update `docs/api-endpoints.md` | M2 | Survey 3 |
| F10 | Submodule `.gitmodules` Restoration | Create root `.gitmodules` mapping `apex-os-mobile` to remote repository, push mobile commits, verify clean submodule status | M3 | Survey 2, Survey 3 |
| F11 | Master Branch Linear Consolidation | Fast-forward merge `feature/sprint-09-mobile-store-prep` into `master` and tag release `v1.1.0` | M3 | Survey 2 |
| F12 | Full System E2E Regression Verification | Execute 100% of web test suites (108 suites) and mobile test suites (12 suites) with 0 failures | M4 | Survey 1, Survey 3 |
| F13 | TypeScript Zero-Error Verification | Verify `tsc --noEmit` exits with code 0 across both web and mobile repositories | M4 | Survey 1, Survey 3 |
| F14 | Clean Production Builds Verification | Verify `npm run build` succeeds (69/69 pages) and `npx expo export` produces <50MB bundle | M4 | Survey 1, Survey 3 |
| F15 | Cross-Cutting Go/No-Go Final Sign-off | Evaluate and publish final verification sign-off across all 6 roadmap Go/No-Go criteria | M4 | Survey 1, Survey 2, Survey 3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | API Performance, Caching & Database Schema Hardening | F1, F2, F3, F4, F5 | none | DONE |
| M2 | Comprehensive Documentation & Roadmap Synchronization | F6, F7, F8, F9 | none | DONE |
| M3 | Master Branch Consolidation & Submodule Hygiene | F10, F11 | M1, M2 | DONE |
| M4 | Final Go/No-Go Audit, Full E2E Test & Production Build Verification | F12, F13, F14, F15 | M1, M2, M3 | DONE |

## Interface Contracts

### Cloudflare KV Cache Contract (`src/lib/cache/kv-cache.ts`)
- `getCached<T>(key: string): Promise<T | null>`
- Behavior: calls `KV.get(key, 'json')`. If result is string, calls `JSON.parse(result)`. If result is object, returns directly.
- TTL: 300s (5 minutes) for analytics and affiliate statistics.
- Headers: `Cache-Control: public, s-maxage=300, stale-while-revalidate=60`, `X-Cache: HIT | MISS`.

### Webhook Replay Protection Contract (`src/lib/webhooks/replay-protection.ts`)
- `checkAndRecordNonce(nonce: string, timestamp: number, ttlSeconds?: number): Promise<boolean>`
- Key format: `replay:${nonce}`
- Method: `const existing = await kv.get(key); if (existing) return false; await kv.put(key, '1', { expirationTtl: ttlSeconds }); return true;`

### Database Composite Index Contract (`src/database/migrations/022_performance_optimization_indexes.sql`)
- `CREATE INDEX IF NOT EXISTS idx_deals_active_created ON deals(is_active, created_at DESC);`
- `CREATE INDEX IF NOT EXISTS idx_payments_user_created ON payments(user_id, created_at DESC);`

### Git Submodule Contract (`.gitmodules`)
```ini
[submodule "apex-os-mobile"]
	path = apex-os-mobile
	url = git@github.com:minhlongs/apex-os-mobile.git
```

## Code Layout
- `src/app/api/analytics/` (Deals, Affiliates, Exchanges, Funnel analytics routes)
- `src/app/api/affiliate/team/route.ts` (Affiliate team downline route)
- `src/lib/webhooks/replay-protection.ts` (KV replay protection)
- `src/lib/fraud/fraud-engine.ts` (Fraud velocity detection engine)
- `src/database/migrations/022_performance_optimization_indexes.sql` (Performance indexes)
- `src/database/schema-complete.sql` (Canonical baseline schema)
- `package.json` (Root package metadata & version 1.1.0)
- `README.md` (Project overview & Q3 feature documentation)
- `CHANGELOG.md` (Consolidated 1.1.0 release notes)
- `plans/q3-2026-roadmap.md` & `plans/README-Q3-ROADMAP.md` (Completed roadmap records)
- `docs/mobile/README.md` (Mobile architecture & build guide)
- `docs/fraud/README.md` (Fraud anomaly engine guide)
- `docs/payments/README.md` (NOWPayments & IPN webhook guide)
- `docs/email/README.md` (Email templates & queue guide)
- `docs/api-endpoints.md` (Synchronized API directory)
- `.gitmodules` (Submodule tracking configuration)
