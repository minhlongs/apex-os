# 20 — G17 Monetary Precision & Conservation Attestation

**Date:** 2026-11-22  
**Branch / SHA:** `feat/ascendancy-phase2-verified` @ `7da0d84c15d69e947699cbf98ed4744ab95cc335`  
**Audit Question:** Reconcile PDF G3 (`10^-8 USD`), closure report prose (`10^-6` micro-units), and payout code (`residualDust1e8`).  
**Verdict:** `PASS` — **Zero code precision defects.** The codebase and D1 schema strictly enforce `10^-8 USD` (`bigint`) everywhere in the ledger; earlier closure reports (`07`, `08`, `13`) contained a prose terminology error calling ledger units "`10^-6` micro-units".

---

## 1. Resolution of Terminology Discrepancy

| Artifact | Unit Stated / Implemented | Verdict |
|----------|--------------------------|---------|
| **Research PDF G3** | `10^-8 USD` integer ledger precision | Authoritative specification |
| **Source Code (`src/lib/ledger/units.ts:25-27`)** | `LEDGER_DECIMALS = 8`, `LEDGER_SCALE = 100_000_000n` (`10^-8 USD`) | **Matches PDF G3 exactly** |
| **D1 Schema (`028_ascendancy_audit_core.sql:74`)** | `INTEGER` storing `10^-8 USD` minor units | **Matches PDF G3 exactly** |
| **Prior Closure Reports (`07`, `08`, `13`)** | Erroneously wrote "micro-units (`10^-6`)" in prose | **Documentation wording error only** (superseded by this attestation) |

---

## 2. Canonical Monetary-Unit Map (All 10 Surfaces)

| # | Surface | Storage / Runtime Type | Authoritative Scale | Exact Source Reference |
|---|---------|------------------------|---------------------|------------------------|
| 1 | **D1 Ledger Postings** (`ledger_postings.amount_units`) | SQLite `INTEGER` / TS `bigint` | `10^-8 USD` | `028_ascendancy_audit_core.sql:135`, `src/lib/ledger/units.ts:26` |
| 2 | **Account Balances** (`ledger_accounts.settled_balance_units`, `inflight_balance_units`) | SQLite `INTEGER` / TS `bigint` | `10^-8 USD` | `028_ascendancy_audit_core.sql:82-83`, `src/lib/ledger/double-entry-ledger.ts` |
| 3 | **Partner Commission Records** (`partner_cash_reconciliations.*_units`, `partner_reconciliation_items.gross_units`) | SQLite `INTEGER` / TS `bigint` | `10^-8 USD` | `028_ascendancy_audit_core.sql:55-59`, `031_ascendancy_phase2_ui_and_poller.sql:140` |
| 4 | **Affiliate Splits** (`computeSafeSpreadWaterfall`) | TS `bigint` (`PPM = 1_000_000n`) | `10^-8 USD` | `src/lib/ledger/waterfall.ts:185-309` |
| 5 | **Clawback Reserve** (`reserveUnits`, rounded UP `ceil`) | TS `bigint` / SQLite `INTEGER` | `10^-8 USD` | `src/lib/ledger/waterfall.ts:233-245` |
| 6 | **Payout Liabilities** (`settlement_broadcasts.amount_units_1e8`) | SQLite `INTEGER` / TS `bigint` (`>= 10^9` = `$10.00`) | `10^-8 USD` | `028_ascendancy_audit_core.sql:163`, `src/lib/ledger/units.ts:36` |
| 7 | **Stellar USDC Wire** (`chain_token_units`, `chain_decimals = 7`) | SQLite `TEXT` / TS `bigint` stroops | `10^-7 USDC` (`divisor = 10n`) | `src/lib/ledger/units.ts:41,228-231`, `src/lib/payouts/stellar-service.ts:47,380` |
| 8 | **EVM USDC Wire** (Arbitrum One / Base, `chain_decimals = 6`) | SQLite `TEXT` / TS `bigint` base units | `10^-6 USDC` (`divisor = 100n`) | `src/lib/ledger/units.ts:42,232-235`, `src/lib/payouts/adapters/arbitrum-base-usdc-adapter.ts:255` |
| 9 | **Transaction Receipts & Cold Claims** (`cold_settlement_claims.amount_token_units`) | SQLite `TEXT` (chain-native integer string) | Chain-native (`10^-7` Stellar / `10^-6` EVM) | `033_cold_settlement_claims.sql:14`, `src/lib/payouts/cold-payment-evidence.ts:66-67` |
| 10 | **Dust & Residual Balances** (`residualDust1e8`) | TS `bigint` (`0..9` Stellar, `0..99` EVM) | `10^-8 USD` | `src/lib/ledger/units.ts:51,240-257` |

---

## 3. Explicit Conversion Functions & Invariants

- **`parseUsdToLedgerUnits(rawDecimalString: string): bigint`** (`units.ts:76-112`): Parses decimal USD via `Decimal(precision: 28, ROUND_DOWN)` into `10^-8` `bigint`; enforces `<= SQLITE_MAX_INT64`.
- **`toSafeSqlInteger(units: bigint): number` / `fromSqlInteger(...)`** (`units.ts:148-198`): Enforces `Number.isSafeInteger` (`<= $90,071,992.54740991`), throwing `LedgerOverflowError` on overflow.
- **`ledgerUnitsToChainUnits(units1e8: bigint, chain): ChainUnitConversion`** (`units.ts:210-258`):
  - Stellar: `chainUnits = units1e8 / 10n`, `residualDust1e8 = units1e8 % 10n`, verified by `chainUnits * 10n + residualDust1e8 === units1e8`.
  - Arbitrum / Base: `chainUnits = units1e8 / 100n`, `residualDust1e8 = units1e8 % 100n`, verified by `chainUnits * 100n + residualDust1e8 === units1e8`.
- **Zero Float Drift / Zero Silent Dust Write-Off:** All ledger posting, waterfall allocation, and chain unit conversions execute exclusively in `bigint` + `Decimal(precision: 28)`. Sub-chain remainders (`residualDust1e8`) remain in the user's `settled_balance_units` and accumulate cleanly across withdrawals.

---

## 4. Deterministic Conservation Test Evidence

**Suite:** `src/lib/ledger/__tests__/monetary-precision-conservation.test.ts` — **4/4 PASS** (`VERIFIED_BY_EXECUTION` on Node `v26.7.0`).

| Test Case | Verified Assertion | Result |
|-----------|--------------------|--------|
| `1` unit of `10^-8 USD` | `chainUnits = 0n`, `residualDust1e8 = 1n` on both Stellar & EVM; exact sum preserved | `PASS` |
| `1` unit of `10^-7 USDC` | `1` stroop (`0` dust) on Stellar; `0` units (`10` dust) on EVM | `PASS` |
| `1` unit of `10^-6 USDC` | `10` stroops (`0` dust) on Stellar; `1` micro-USDC (`0` dust) on EVM | `PASS` |
| Unrepresentable destination amounts (`1..24_999_999_999`) | `chainUnits * divisor + residualDust1e8 === units1e8` | `PASS` |
| Safe-Spread Waterfall split-rounding remainders (12 edge values incl. BEAR/BASE/BULL) | `R + E_trader + E_L1 + E_L2 + E_L3 + platformNet === C`, `E_L3 === 0n` | `PASS` |
| Partial withdrawals + dust accumulation + cross-chain (Stellar/Arbitrum/Base) + clawback reversal | `ORIGINAL_LIABILITY === VERIFIED_SETTLEMENT + REMAINING_LIABILITY + VALID_REVERSALS` (0-unit tolerance) | `PASS` |
