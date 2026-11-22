# 07 — Double-Entry Ledger Conservation & Safe-Spread Waterfall

**Status:** `VERIFIED_BY_EXECUTION` (Independent Reviewer E: 0 Critical / 0 High, 47/47 tests PASS).

---

## 1. Verified Invariants

- **Zero-Sum Double-Entry Conservation:** Every `ledger_journal_batches` posting balances debits and credits identically in integer micro-units (`1e6`), enforced at both application (`src/lib/ledger/double-entry-ledger.ts`) and D1 trigger layers.
- **No Unproven `WITHDRAWAL_REVERTED` Refunds:** Migration `036_durable_hot_exposure.sql` installs `trg_withdrawal_require_terminal_proof`, rejecting any direct or indirect `WITHDRAWAL_REVERTED` insert unless a matching verified proof exists in `settlement_verified_exposure_releases`.
- **No `is_paid = 1` Without Finalized On-Chain Proof:** `ledger.finalizeWithdrawal` requires verified `txHash` and durable `CONFIRMED` state (or durable `cold_settlement_claims` for Cold Safe).
- **Safe-Spread Waterfall:** Affiliate tier splits (30% / 10% / 5%) and cashback allocation are computed in integer micro-units with deterministic rounding and zero float drift.

## 2. Documented Follow-Up (Non-Blocking)

- Reviewer E Medium #1: Pre-cutover legacy fingerprint rows (prior to migration `036`) remain intentionally un-backfilled and fail closed (retaining exposure / requiring manual reconciliation rather than auto-releasing funds). Documented in operational cutover runbook before live activation.
