# 12 — Database Migrations & Schema Integrity (001–036)

**Status:** `VERIFIED_BY_EXECUTION` (all migrations apply cleanly on fresh isolated SQLite/D1 fixtures; idempotency hardened).

---

## 1. Phase 2 & Treasury Remediation Migrations

| Migration | Purpose | Idempotency / Verification |
|-----------|---------|----------------------------|
| `031_ascendancy_phase2_ui_and_poller.sql` | Phase 2 admin console & partner reconciliation poller tables | `VERIFIED_BY_EXECUTION` |
| `032_persistent_d1_rate_limits.sql` | Persistent D1 rate-limiting store | `VERIFIED_BY_EXECUTION` |
| `033_cold_settlement_claims.sql` | Durable unique `(network, tx_hash, operation_id)` Cold Safe claims (T-01) | `VERIFIED_BY_EXECUTION` |
| `034_withdrawal_freeze_at_write.sql` | Write-boundary `EMERGENCY_PAUSE` / `EMERGENCY_LEDGER_FREEZE` enforcement (T-02) | `VERIFIED_BY_EXECUTION` |
| `035_payout_effect_grants.sql` | `system_safety_epoch` + one-shot `payout_effect_grants` fencing (T-02) | `VERIFIED_BY_EXECUTION` |
| `036_durable_hot_exposure.sql` | Durable hot exposure columns, `settlement_verified_exposure_releases` view, `trg_withdrawal_require_terminal_proof` trigger (T-03); `IF EXISTS` / `IF NOT EXISTS` DDL guards added (Reviewer F Medium #3) | `VERIFIED_BY_EXECUTION` |

## 2. Remote Execution Boundary

- **Zero remote D1 migrations executed** (strictly prohibited by Supreme Command #07). All schema tests ran exclusively on isolated in-memory / local SQLite fixtures.
