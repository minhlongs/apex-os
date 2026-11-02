---
title: "Staging Rehearsal Live Telemetry Remediation & Reset-Rehearsal"
status: completed
branch: feat/staging-live-telemetry-remediation
created: 2026-11-02
source_advisory: plans/reports/advise-261102-0807-staging-rehearsal-live-telemetry.md
---

# Plan: Staging Rehearsal Live Telemetry Remediation & Reset-Rehearsal

## 1. Objective & Outcome

Remediate the 3 live telemetry blockers discovered during the 48-hour staging rehearsal on `apex-os-staging` and add a clean `reset-rehearsal` lifecycle action while keeping Production (`apex-os` / `apex-os-db`) strictly **NO_GO**:

1. **Blocker 1 — Bybit Spot L2 `FEED_DESYNC` loop (`src/lib/paper/live-collector.ts`, `src/lib/paper/worker-do.ts`):**
   - Process incoming WebSocket snapshots (`book.isDelta === false`) via `applySnapshotAndDrainBuffer(key, book)` immediately inside `ingestOrBufferWsBook(book)` **before** checking `this.bootstrappingKeys.has(key)`.
   - Never overwrite active Bybit Spot WS streams (`u ≈ 7.6M`) with REST `/v5/market/orderbook?category=spot` (`u ≈ 68.3M`) inside `startWebSocketStreams()`, `bootstrapSnapshots()`, `scheduleReconnect()`, `worker-do.ts` `onBook`, or `alarm()`.
   - Add `resyncBybitWsStream(pair, marketType)` (with 2000ms per-stream cooldown) that sends WS `unsubscribe` + `subscribe` on `orderbook.50.${symbol}` (or reconnects the socket if not open) so Bybit WS emits a fresh native `"type": "snapshot"` in the WS sequence space.

2. **Blocker 2 — Binance Linear Perp `DISCONNECTED` on Cloudflare Edge (`src/lib/paper/live-collector.ts`, `wrangler.staging.jsonc`):**
   - Rotate across multiple USD-M Perp WS endpoints (`wss://fstream.binance.com/stream`, `wss://fstream.binance.me/stream`, `wss://fstream1.binance.com/stream`, `wss://fstream2.binance.com/stream`, `wss://fstream-auth.binance.com/stream`) and REST bases (`https://fapi.binance.com`, `https://www.binance.com`, `https://fapi.binance.me`, `https://fapi1.binance.com`, `https://fapi2.binance.com`) with sticky best-endpoint memoization (`preferredBinancePerpRestIdx`, `preferredBinancePerpWsIdx`).
   - Decouple `/fapi/v1/premiumIndex` from `/fapi/v1/depth` with an independent 5–10s TTL per-pair cache and `try/catch` so funding fetch errors never fail orderbook snapshots.
   - Run a high-frequency (`400ms`) REST snapshot fallback pump (`isDelta: false`) whenever `binance:linear_perp:{BTC/USDT, ETH/USDT}` is not WS-connected or has not received a frame within `450ms`, keeping `status === 'SYNCED'` and `feedAgeMs <= 500ms < 1000ms`.
   - Enable `"placement": { "mode": "smart" }` in `wrangler.staging.jsonc`.

3. **Blocker 3 — Inventory-Neutral Arbitrage Accounting (`src/lib/paper/strategy-engine.ts`, `src/lib/paper/types.ts`):**
   - Initialize `spot-perp` with 100% USDT at `t = 0` (`5,000 USDT` free collateral per venue, `baseInventory = { 'BTC/USDT': 0, 'ETH/USDT': 0 }`, `baseInventoryCostBasisUsdt = 0`, `initialInventoryCostBasisUsdt = 0`).
   - Retain `$4,000 USDT` operational base inventory (`$1,000` per pair per venue, `$3,000` free USDT per venue) for `spot-2exch`, add `reanchorSeedInventoryToLivePrice(pair, liveMidPrice)` on first live mark when `openCycles.size === 0 && closedCycles.length === 0`, and compute `standingInventoryMarkToMarketUsdt()` using `effectiveStandingQty` (adjusting for open spot legs so open cycles are never double-counted and 0-cycle price moves produce zero passive beta drawdown).
   - Add optional `seedBaseInventory?` to `PaperSerializedStrategyState` (`src/lib/paper/types.ts`) for 100% backward compatibility with `PaperReplayEngine` / N2 artifacts.

4. **`reset-rehearsal` Action (`src/lib/paper/worker-do.ts`, `src/app/api/admin/paper/overview/route.ts`):**
   - Support `POST /api/admin/paper/overview` with `{"action": "reset-rehearsal"}` forwarding to `http://internal/reset-rehearsal` on `PaperTradingDurableObject` to clear persisted `haltedByDrawdown: true`, re-initialize both engines at `10,000 USDT` (`maxDrawdownPct = 0`), reset `continuous_coverage_ms`, deactivate old D1 runs, and restart the 8-stream collector cleanly.

## 2. Phases

| Phase | Scope | Status |
|---|---|---|
| Phase 1 | `src/lib/paper/types.ts` & `src/lib/paper/strategy-engine.ts` — Inventory-neutral NAV formula (`effectiveStandingQty`), `spot-perp` 100% USDT init, `spot-2exch` live seed re-anchor, serialized state backward compatibility | completed |
| Phase 2 | `src/lib/paper/live-collector.ts` & `wrangler.staging.jsonc` — Bybit Spot native WS snapshot & `resyncBybitWsStream`, Binance Perp multi-endpoint rotation + decoupled funding cache + 400ms REST fallback pump + Smart Placement | completed |
| Phase 3 | `src/lib/paper/worker-do.ts` & `src/app/api/admin/paper/overview/route.ts` — Bybit Spot WS resync on `FEED_DESYNC` / `alarm()`, `resetRehearsal()` & `POST /reset-rehearsal` | completed |
| Phase 4 | `src/lib/paper/__tests__/paper-engine-and-replay.test.ts` — Update `V1` (line 1171) & `V7` (line 1614), add regression tests `R1`–`R4`, run full test suite & production build on Node 26.7.0 | completed |
| Phase 5 | Ship PR, review/merge, deploy to `apex-os-staging`, trigger `reset-rehearsal` + `start-collector`, verify 8/8 `SYNCED` + `LIVE_VERIFIED` on staging, and verify `scripts/verify-paper-economic-gate.cjs` remains `NO_GO` (`EXIT_CODE=1`) | completed |

## 3. Acceptance Criteria & Red-Team Verification

- [x] **AC1 (Blocker 1):** `bybit:spot:BTC/USDT` and `bybit:spot:ETH/USDT` ingest WS `"type": "snapshot"` (`isDelta: false`) directly via `applySnapshotAndDrainBuffer` even while in `bootstrappingKeys`, never get overwritten by REST `u ≈ 68.3M` when WS is active, and recover from sequence gaps via `resyncBybitWsStream` (with 2000ms cooldown).
- [x] **AC2 (Blocker 2):** `binance:linear_perp:BTC/USDT` and `ETH/USDT` rotate across `BINANCE_PERP_WS_ENDPOINTS` and `BINANCE_PERP_REST_BASES` (including `https://www.binance.com`), cache `premiumIndex` independently, and run a `400ms` REST snapshot fallback pump when WS is disconnected or stale, maintaining `SYNCED` (`feedAgeMs <= 1000ms`).
- [x] **AC3 (Blocker 3):** At 0 cycles, `spot-perp` holds `5,000 USDT` free collateral per venue and `0` base inventory (`equityUsdt = 10000`, `maxDrawdownPct = 0`, `haltedByDrawdown = false`); `spot-2exch` holds `3,000 USDT` free collateral per venue + `$4,000` operational seed inventory re-anchored to live price with `ΔstandingQty = 0` (`equityUsdt = 10000`, `maxDrawdownPct = 0`, `haltedByDrawdown = false` across arbitrary BTC/ETH price moves at 0 open cycles, and zero double-counting during open cycles).
- [x] **AC4 (`reset-rehearsal`):** `POST /api/admin/paper/overview` `{"action": "reset-rehearsal"}` resets DO storage + D1 runs and transitions `windowMetrics[*].baselineProvenance` to `"LIVE_VERIFIED"` once 8/8 streams are `SYNCED`.
- [x] **AC5 (Tests & Build):** Updated `V1` & `V7` plus new regression tests `R1`–`R4` pass on Node 26.7.0; `npm run build` passes with 0 errors; `PAPER_FROZEN_CONFIG_HASH` remains `03aa4c7a0928d368f026962f7fcf40f643ee8e14b8db87144e527f0222ca76ad`.
- [x] **AC6 (Production Safety Gate):** `node scripts/verify-paper-economic-gate.cjs` exits with `EXIT_CODE=1` (`NO_GO`), and zero changes are deployed to production Worker `apex-os` or production D1 `apex-os-db`.
