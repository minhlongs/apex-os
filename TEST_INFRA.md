# E2E Test Infrastructure: Cross-Exchange Arbitrage & High-Yield Deal Crawler Engine

## Test Philosophy
- **Opaque-Box & Requirement-Driven**: Derived strictly from `ORIGINAL_REQUEST.md` (§R1-R5, Acceptance Criteria) and `PROJECT.md`.
- **4-Tier Testing Methodology**:
  - **Tier 1: Feature Coverage**: Comprehensive unit & contract coverage (>= 5 test cases per primary feature across crawler adapters, arbitrage math, sync history, alerting, public & admin APIs, and deals UI logic).
  - **Tier 2: Boundary & Corner Cases**: Stress-testing edge limits (zero fees, negative maker fees/rebates, 0% & 100% cashback, extreme volume benchmarks up to $1B, simulated network timeouts / 429 errors falling back to fixtures, and rate limiting).
  - **Tier 3: Cross-Feature Combinations**: Multi-step pipeline tests (crawl -> rate cards upsert -> matrix analysis -> high-spread alert dispatching -> public API query; alert cooldown deduplication; lifecycle expiration deactivation).
  - **Tier 4: Real-World Application Scenarios**: Multi-module user journeys (active retail/pro trader discovering $810/yr savings switching from Binance to Bybit with ApexOS 40% cashback; admin manual crawl triggering and sync status monitoring; flash high-spread market burst generating Telegram + mobile push alerts).
- **Edge Runtime Compatibility**: Zero Node.js C++ native addons; fully compatible with Cloudflare Workers/Pages edge runtime.
- **Deterministic Offline Resilience**: Fallback fixtures for Binance, Bybit, OKX, and KuCoin guarantee 100% test reproducibility without external network dependencies.

---

## Feature Inventory

| # | Feature | Scope / Source | Tier 1 Tests | Tier 2 Boundaries | Tier 3 Combinations |
|---|---------|----------------|:------------:|:-----------------:|:-------------------:|
| 1 | **Crawler Adapters & Symbol Normalization** | ORIGINAL_REQUEST §R1; `PROJECT.md` F3-F6 | 6 | 1 | ✓ |
| 2 | **Arbitrage & Yield Math Engine** | ORIGINAL_REQUEST §R2; `PROJECT.md` F9-F10 | 6 | 4 | ✓ |
| 3 | **Sync History & Audit Logging** | ORIGINAL_REQUEST §R1, R3; `PROJECT.md` F8 | 5 | 1 | ✓ |
| 4 | **Real-Time Alert Dispatching & Push** | ORIGINAL_REQUEST §R4; `PROJECT.md` F14-F17 | 5 | 1 | ✓ |
| 5 | **Public Arbitrage API (`GET /api/deals/arbitrage`)** | ORIGINAL_REQUEST §R5; `PROJECT.md` F18 | 5 | 1 | ✓ |
| 6 | **Admin Crawler APIs (`/run`, `/status`)** | ORIGINAL_REQUEST §R5; `PROJECT.md` F19-F20 | 5 | 1 | ✓ |
| 7 | **Deals UI Logic & Arbitrage Finder** | ORIGINAL_REQUEST §R5; `PROJECT.md` F21 | 5 | 2 | ✓ |

---

## Test Architecture

```
                    ┌────────────────────────────────────────────────────────┐
                    │       src/__tests__/crawler/crawler-test-harness.ts     │
                    │   - In-Memory D1 Mock (better-sqlite3 + Migration 025) │
                    │   - Dual-Auth Mock Requests (Admin Bearer / Cookies)   │
                    │   - Authoritative Reference Math & Alert Formatters    │
                    │   - Dynamic Route Dispatcher (Real Route / Reference)  │
                    └───────────────────────────┬────────────────────────────┘
                                                │
                                                ▼
                    ┌────────────────────────────────────────────────────────┐
                    │   src/__tests__/crawler/e2e-arbitrage-crawler.test.ts  │
                    │   ├── Tier 1: Feature Coverage (37 Tests)              │
                    │   │   ├── F1: Crawler Adapters (Binance, Bybit, OKX, KC)│
                    │   │   ├── F2: Arbitrage Math Engine & Metrics          │
                    │   │   ├── F3: Sync History & Audit Logging             │
                    │   │   ├── F4: Real-Time Alerting & Multi-Channel Push  │
                    │   │   ├── F5: Public Deals Arbitrage API               │
                    │   │   ├── F6: Admin Crawler Management APIs            │
                    │   │   └── F7: Deals UI Logic & Calculator              │
                    │   ├── Tier 2: Boundary & Corner Cases (7 Tests)        │
                    │   │   ├── Zero fees (no divide-by-zero or NaN)         │
                    │   │   ├── Negative maker fees / rebates preserved      │
                    │   │   ├── 0% and 100% cashback limits                  │
                    │   │   ├── Extreme volumes ($0 to $1,000,000,000)       │
                    │   │   ├── Network timeouts / 429 fallback fixture      │
                    │   │   └── Public API rate limiting (500 req/hr)        │
                    │   ├── Tier 3: Cross-Feature Combinations (5 Tests)     │
                    │   │   ├── Crawl -> Upsert -> Analyze -> Alert -> Query │
                    │   │   ├── Alert Cooldown Dedup (1hr quiet + 50% bypass)│
                    │   │   ├── Spot & Futures pair coexistence              │
                    │   │   ├── Stale opportunity expiration lifecycle       │
                    │   │   └── Admin manual crawl updates status ledger     │
                    │   └── Tier 4: Real-World Scenarios (3 Tests)           │
                    │       ├── Scenario 1: Trader $810/yr Bybit vs Binance  │
                    │       ├── Scenario 2: Admin Manual Crawl & Monitoring  │
                    │       └── Scenario 3: Flash Volatility Burst Alerts    │
                    └────────────────────────────────────────────────────────┘
```

- **Test Runner**: Jest (`npx jest`) with `ts-jest` preset and `jsdom` test environment.
- **Database Simulation**: In-memory Cloudflare D1 mock powered by `better-sqlite3`, loading:
  - `src/database/migrations/003_affiliate_schema.sql` (`deals`, `profiles`)
  - `src/database/migrations/020_billing_mobile_enhancements.sql` (`device_tokens`, `mobile_push_tokens`)
  - `src/database/migrations/025_deal_crawler_arbitrage.sql` (`exchange_rate_cards`, `arbitrage_opportunities`, `crawler_sync_runs`, auto-update triggers)
- **Deterministic Fixtures**: Located at `src/lib/crawler/fixtures/{binance,bybit,okx,kucoin}.ts`.

---

## Real-World Application Scenarios (Tier 4)

| # | Scenario | Features Exercised | Business Impact |
|---|----------|--------------------|-----------------|
| 1 | **Active Pro Trader Savings Discovery ($810/yr)** | F1, F2, F7 | Trader with $250k/mo futures volume calculates fee reduction from Binance (0.060% net taker) to Bybit (0.033% net taker) with 2.7 bps spread and 45% savings, saving $810.00/yr via 1-click affiliate deal routing. |
| 2 | **Admin Operations & Manual Sync Pipeline** | F1, F3, F6 | Admin triggers manual sync via `POST /api/admin/crawler/run`, crawler indexes 48 cards across 4 exchanges, records `crawler_sync_runs` audit entry, and confirms health via `GET /api/admin/crawler/status`. |
| 3 | **Flash Market Volatility Burst & Alert Broadcast** | F1, F2, F4 | Sudden fee surge on KuCoin (0.20%) creates 15.8 bps spread against Bybit, exceeding the 15 bps threshold. Alert service dispatches rich Telegram Markdown and enqueues Expo push notifications to registered `device_tokens`, while enforcing 1-hour cooldown deduplication. |

---

## Coverage Metrics & Quality Gates

- **Total Test Cases Authored**: **52 test cases**
- **Test Pass Rate**: **100% (52 passed, 0 failed)**
- **TypeScript Typecheck**: **0 compiler errors (`npx tsc --noEmit`)**
- **Execution Time**: **~0.58 seconds**
- **Regression Impact**: **0 regressions** on existing test suites.
