# Phase 4: Greenfield Paper Trading Engine (Block D)

## Context
Build an honest, real-market Paper Trading simulator powered by Cloudflare Workers and Durable Objects:
- Binance & Bybit L2 WebSocket feed parsing with sequence gap detection (`FEED_DESYNC`).
- Two independent 10,000 USDT strategies:
  1. `spot-2exch`: Cross-Exchange Spot (Binance spot vs Bybit spot).
  2. `spot-perp`: Same-Exchange Spot-Perpetual Basis / Funding.
- Real fee calculation (~0.2% round-trip) and book depth VWAP execution.
- Immutable Journal logging to D1 (`paper_trade_journal`) and compressed replay references to R2.
- Admin Console: Realtime Terminal, Closed-Cycle Table, CSV/PDF Export with prominent `PAPER` watermark.

## Tasks
1. Scaffold `src/lib/paper/` domain modules:
   - `types.ts`: Paper trading models, orderbook schemas, cycle events, replay records.
   - `orderbook-sequencer.ts`: L2 orderbook management, gap detection, depth calculation.
   - `strategies/spot-2exch.ts`: Cross-exchange spot strategy with 10k USDT ledger.
   - `strategies/spot-perp.ts`: Spot-perpetual basis/funding strategy with 10k USDT ledger.
   - `journal.ts`: Immutable journal with SHA-256 idempotency key and D1 persistence.
   - `replay.ts`: Deterministic replay engine loading tick sequence from R2/memory.
2. Implement Durable Object classes in `src/worker/paper-trading-do.ts`.
3. Add API routes:
   - `GET /api/admin/paper/status`: Engine health, active feeds, sequence status.
   - `GET /api/admin/paper/cycles`: Closed cycles with P&L and fees.
   - `GET /api/admin/paper/export`: CSV and PDF exports stamped `PAPER`.
4. Build Admin Console UI components:
   - `src/components/admin/paper/PaperTerminal.tsx`: Realtime streaming spreads.
   - `src/components/admin/paper/PaperCyclesTable.tsx`: Closed trades table.
   - `src/app/[locale]/admin/paper/page.tsx`: Full Paper Trading console.

## Verification
- Unit tests for orderbook sequencer, gap detection, strategies, fee math, and journal.
