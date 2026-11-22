# 21 — G17 Migration 031–036 Release Drill

**Date:** 2026-11-22  
**Branch / SHA:** `feat/ascendancy-phase2-verified` @ `7da0d84c15d69e947699cbf98ed4744ab95cc335`  
**Execution Engine:** Isolated local SQLite (`better-sqlite3` on Node `v26.7.0`, Cloudflare D1 SQLite semantics, `PRAGMA foreign_keys = ON`)  
**Remote D1 Touched:** **NONE** (strictly local rehearsal)  
**Verdict:** `PASS` (with explicit operational requirement: sequential once-only execution of `036` + mandatory pre-migration remote backup).

---

## 1. Migration Inventory & SHA-256 Checksums

| # | File | SHA-256 Checksum | Objects Created / Altered | Re-run Idempotency |
|---|------|------------------|---------------------------|--------------------|
| **031** | `031_ascendancy_phase2_ui_and_poller.sql` | `ea53812465981de92200b30e96baf5b47307d689df959604ffe4551ace23bf63` | 7 tables (`trader_exchange_uids`, `short_link_clicks`, `partner_shadow_reconciliations`, `partner_poller_runs`, `partner_reconciliation_deposits`, `partner_reconciliation_items`, `b2b_agency_contracts`) + 8 indexes | Idempotent (`IF NOT EXISTS`) |
| **032** | `032_persistent_d1_rate_limits.sql` | `46832feb63150d44a06738c852b7ad5bfecf017c03b767cc59c5844cf5e5d762` | 2 tables (`rate_limits`, `rate_limit_configs`) + 3 indexes + `INSERT OR IGNORE` seeds | Idempotent |
| **033** | `033_cold_settlement_claims.sql` | `c77a98c1f1238a9bea64e3e08cf84af5ffed28b07e06bc2192d791aa6fbf12b9` | 1 table (`cold_settlement_claims`) with `PK (network, tx_hash, operation_id)`, `UNIQUE(payout_id)`, `UNIQUE(lock_batch_id)` | Idempotent |
| **034** | `034_withdrawal_freeze_at_write.sql` | `1bf3d3d5cd773a4d2cf04f10dc880ac40365a76530275a256401a8b5a63052bf` | 1 trigger (`trg_withdrawal_journal_requires_unfrozen_ledger`) | Idempotent |
| **035** | `035_payout_effect_grants.sql` | `7fe97fbdada8a347ea35664224133bf5181c8b8be4d67bf8a6f325da1933c703` | 3 tables (`system_safety_epoch`, `payout_effect_attempts`, `payout_effect_grants`), 2 indexes, 6 triggers | Idempotent |
| **036** | `036_durable_hot_exposure.sql` | `fcbeef4fbea96b8f6a01d8a9a847986a437400bcd1f03002ed4d68cf410b3b5c` | 7 `ALTER TABLE ADD COLUMN` statements (6 on `settlement_broadcasts`, 1 on `payout_effect_attempts`), 1 index, 1 replaced trigger, 1 view (`settlement_verified_exposure_releases`), 1 new trigger (`trg_withdrawal_require_terminal_proof`) | **Once-only** (SQLite `ALTER TABLE ADD COLUMN` fails fast on duplicate column) |

---

## 2. Rehearsal Matrix & Observed Results

**Suite:** `src/lib/payouts/__tests__/migration-031-036-release-drill.test.ts` — **3/3 PASS** (`VERIFIED_BY_EXECUTION`).

| Scenario | What Was Tested | Observed Outcome |
|----------|-----------------|------------------|
| **Fresh DB (`028` → `031..036`)** | Sequential apply, `PRAGMA foreign_key_check`, verify all tables/views/triggers present | `PASS` (0 FK errors) |
| **Snapshot-Equivalent Upgraded DB** | Seeded pre-existing `system_runtime_flags`, `ledger_accounts`, `ledger_journal_batches`, `ledger_postings`, 48h-old `BROADCAST_PENDING` and 72h-old `CONFIRMED` `settlement_broadcasts` before applying `031..036` | `PASS` (0 data loss; legacy rows preserved with `confirmation_lane = NULL`, retaining fail-closed cap exposure) |
| **Unproven Refund Guard (`036`)** | Attempt `INSERT` of `WITHDRAWAL_REVERTED` against historical `BROADCAST_PENDING` row without verified terminal proof | `PASS` — Rejected with `Withdrawal refund requires exact durable terminal proof` |
| **Freeze-at-Write Guard (`034` + `035`)** | Set `EMERGENCY_LEDGER_FREEZE = 'true'`; verify `system_safety_epoch.epoch` auto-increments (`>= 2`) and `WITHDRAWAL_LOCK` insert aborts | `PASS` — Rejected with `Withdrawal ledger mutation denied by emergency freeze control` |
| **Duplicate Cold Claim Guard (`033`)** | Insert second `cold_settlement_claims` row reusing `(network, tx_hash, operation_id)` for a different `payout_id` | `PASS` — Rejected with `UNIQUE constraint failed` |
| **Idempotency & Partial Failure** | Re-apply `031..035` twice; re-apply `036` twice | `PASS` — `031..035` idempotent; `036` fails fast (`duplicate column name: signing_lane`), proving why operator must track applied migrations |
| **Backup & Restore Drill** | Binary serialize pre-upgrade DB (`db.serialize()`), restore into fresh SQLite instance, verify row counts, cleanly reapply `031..036` | `PASS` — 100% lossless restore + clean re-upgrade |

---

## 3. Remote Execution Runbook (Blocked Until Founder Approval)

`wrangler.jsonc` does not configure auto-migrations; remote D1 upgrades must be executed manually after explicit Founder approval:

1. **Pre-flight backup:** `wrangler d1 export <DB_NAME> --remote --output backup-pre-031-$(date -u +%Y%m%dT%H%M%SZ).sql` (verify non-empty file + SHA-256).
2. **Precondition & Legacy Cap Audit:** Verify `028_ascendancy_audit_core.sql` tables (`settlement_broadcasts`, `ledger_journal_batches`, `system_runtime_flags`) exist, `signing_lane` does not yet exist on `settlement_broadcasts`, **and** query `SELECT state, COUNT(*), COALESCE(SUM(amount_units_1e8), 0) FROM settlement_broadcasts GROUP BY state`. Because `036` intentionally leaves `confirmation_lane` and `signing_lane` `NULL` (fail-closed), any pre-existing `CONFIRMED` or `QUEUED_COLD_SAFE` rows totaling `>= $1,500` will permanently consume the hot-wallet rolling cap until an audited one-time backfill is executed.
3. **Sequential application:** Apply `031` → `032` → `033` → `034` → `035` → `036` one file at a time, verifying exit code `0` after each.
4. **Post-migration verification:** Confirm `settlement_verified_exposure_releases` view, `system_safety_epoch` singleton row (`epoch >= 1`), and `AUTO_SETTLE_PAYOUTS = 'false'`.
5. **Rollback path:** Restore from the Step 1 SQL export if `036` fails mid-flight (SQLite does not support transactional DDL rollback across partial `ALTER TABLE` statements in D1 batch scripts).
