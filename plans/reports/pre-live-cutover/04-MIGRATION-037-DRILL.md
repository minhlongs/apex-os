# 04 — G23.4 Migration 037 Trigger & Finality Local Drill

**Date:** 2026-11-22  
**Branch:** `fix/apex-pre-live-cutover-hardening`  
**Migration File:** `src/database/migrations/037_hardening_trigger_and_exposure.sql`  
**Remote Execution Status:** **NOT EXECUTED** (local SQLite drill only; remote D1 migrations `031–037` remain blocked until Founder authorization).

---

## 1. Schema & Runtime Changes

### Target A — Withdrawal Proof Identity Binding
- **`src/database/migrations/037_hardening_trigger_and_exposure.sql`:**
  - Replaced `trg_payout_effect_retain_withdrawal` to block `WITHDRAWAL_REVERTED` when an active `payout_effect_attempts` row exists matching `lock_batch_id`, `NEW.payout_id`, or `lock.payout_id`.
  - Replaced `trg_withdrawal_require_terminal_proof` to enforce on every `WITHDRAWAL_REVERTED` insert:
    1. `json_extract(NEW.metadata, '$.lockBatchId')` resolves to an existing `INFLIGHT` `WITHDRAWAL_LOCK` with exact `lock.gross_commission_units = NEW.gross_commission_units` and matching `payout_id` (when supplied).
    2. Every `settlement_broadcasts` row associated with `lock.id`, `lock.payout_id`, or `NEW.payout_id` exists in `settlement_verified_exposure_releases`, matches `lock.id` / `lock.payout_id`, and matches `b.amount_units_1e8 = lock.gross_commission_units`.
- **`src/lib/ledger/double-entry-ledger.ts`:**
  - Mapped `payout_id` onto `LedgerJournalBatchRecord` (`getBatchById`, `getBatchByIdempotencyKey`, `mapBatchRow`) and bound `lockBatch.payoutId` directly into `WITHDRAWAL_REVERTED` inserts so reversals carry explicit payout identity.

### Target B — Finality Timestamps (`UNVERIFIED_HOT → HOT`) & Fail-Closed Cron Flag
- **`src/lib/payouts/broadcast-recovery-machine.ts`:**
  - Updated `promoteUnverifiedHotConfirmation` to stamp `confirmation_observed_at = unixepoch('now')` unconditionally instead of `COALESCE(confirmation_observed_at, unixepoch('now'))`, preventing stale unverified timestamps from prematurely aging out 24h rolling exposure.
- **`src/database/migrations/037_hardening_trigger_and_exposure.sql`:**
  - Added `trg_settlement_enforce_hot_finality_promotion`: rejects `UNVERIFIED_HOT → HOT` unless `state = 'CONFIRMED'`, `safe_multisig_tx_hash IS NULL`, non-empty `tx_hash`, integer `confirmation_observed_at` within `[unixepoch('now') - 300, unixepoch('now')]`.
  - Added `trg_settlement_preserve_confirmed_finality`: makes confirmed `state`, `payout_id`, `tx_hash`, `lock_batch_id`, `amount_units_1e8`, and finalized `HOT` `confirmation_lane` + `confirmation_observed_at` immutable.
- **`worker-wrapper.js:247`:**
  - Tightened `AUTO_SETTLE_PAYOUTS` check from `=== 'false'` to `!== 'true'` so unset/empty/malformed values fail closed.

---

## 2. Local Migration Drill Evidence

Command:
```bash
npx jest __tests__/database/migration-037-drill.test.ts \
  src/lib/payouts/__tests__/migration-031-036-release-drill.test.ts \
  src/lib/payouts/__tests__/durable-hot-exposure.test.ts \
  src/lib/payouts/__tests__/payout-effect-fence.test.ts --no-coverage
```
Result: **4 suites passed, 89 tests passed, 0 failed**.

All 10 required local drill scenarios verified:
1. Fresh database (`028..037`) + idempotent re-execution of `037`: **PASS**
2. Existing `028..036` database upgraded in-place to `037` with zero mutation of historical rows: **PASS**
3. Pending transaction (`BROADCAST_PENDING`) at migration time preserved & reversal blocked: **PASS**
4. Confirmed `UNVERIFIED_HOT` with stale timestamp promoted with fresh `unixepoch('now')`; backdated/future promotion rejected; confirmed lineage immutable: **PASS**
5. Unknown terminal state (`FAILED_ABORTED` without verified proof) reversal blocked: **PASS**
6. Historical `NULL` lane/timestamp/lock rows preserved untouched and fail closed: **PASS**
7. Cross-payout identity binding & duplicate reversal prevention (payout A proof cannot release payout B or mismatched amount): **PASS**
8. Foreign key integrity (`PRAGMA foreign_key_check` = 0 violations; invalid FK inserts aborted): **PASS**
9. Atomic transaction rollback on trigger abort: **PASS**
10. File-based pre-037 backup, apply 037, restore backup, verify row/trigger state, re-apply 037: **PASS**

---

## 3. Separate Remote Rollout Procedure (DO NOT EXECUTE IN PR A)

> **Authorization Notice:** Local verification of Migration 037 does **not** authorize applying migrations `031–037` to staging or production D1.

1. Confirm `AUTO_SETTLE_PAYOUTS="false"`, `EMERGENCY_PAUSE="true"`, `EMERGENCY_LEDGER_FREEZE="true"` on target environment.
2. Export full pre-migration D1 backup (`wrangler d1 export <db> --remote --output backup-pre-037.sql`) and record SHA-256 checksum.
3. Apply `031..037` sequentially on **staging D1 first** using the dedicated staging-scoped D1 migration token (see `05-CLOUDFLARE-TOKEN-SEGMENTATION-PLAN.md`).
4. Run read-only verification queries: `SELECT name FROM sqlite_master WHERE type='trigger'`, `PRAGMA foreign_key_check`, and row-count parity check on `settlement_broadcasts` and `ledger_journal_batches`.
5. Only after Founder sign-off on staging soak, repeat steps 1–4 for production D1 during a maintenance window.
6. Rollback trigger: if any trigger creation or verification check fails, drop only the newly added triggers from `037` (or restore from the pre-migration export if prior DDL failed) before lifting `EMERGENCY_LEDGER_FREEZE`.
