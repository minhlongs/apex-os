# 04 — Durable Rolling Hot-Wallet Cap Accounting (T-03 / GATE B3)

**Finding:** `T-03 HIGH` — Rolling 24-hour $1,500 hot-wallet cap excluded unresolved old reservations.  
**Status:** `CLOSED` (`VERIFIED_BY_EXECUTION`, including post-audit fix for `UNVERIFIED_HOT` → `HOT` promotion).

---

## 1. Root Cause Fixed

1. **Original T-03 Defect:** Admission and balance queries filtered hot exposure with `created_at >= datetime('now', '-24 hours')`, causing unresolved `SIGNING` / `BROADCAST_PENDING` / unproven terminal rows older than 24h to silently drop out of the rolling cap and permit exceeding the $1,500 hot-wallet ceiling.
2. **Audit-Caught Follow-Up Defect (Reviewer B High #1):** Rows confirmed via fast broadcast (`confirmation_lane = 'UNVERIFIED_HOT'`) lacked a passive finality promotion path to `'HOT'`, which would have caused normal confirmed hot payouts to permanently retain cap exposure beyond 24h and eventually saturate the $1,500 hot lane.

## 2. Implemented Remediation

- **Migration `036_durable_hot_exposure.sql` (idempotent DDL):**
  - Adds `signing_lane`, `confirmation_lane`, `confirmation_observed_at`, `exposure_release_kind`, `exposure_released_at`, `exposure_release_attempt_id` to `settlement_broadcasts` and `failed_finality_ledger` to `payout_effect_attempts`.
  - Creates view `settlement_verified_exposure_releases` and trigger `trg_withdrawal_require_terminal_proof` enforcing exact durable proof (`PRE_SUBMISSION_ABORT` or `CHAIN_FINALIZED_FAILURE`) before any withdrawal refund or exposure release.
  - Preserves legacy/unverified rows without backfill so unresolved historical obligations retain exposure fail-closed.
- **Hot Exposure SQL (`src/lib/payouts/turnkey-signer.ts`):**
  - `HOT_EXPOSURE_SQL` counts all unresolved hot rows regardless of age, and only ages out `CONFIRMED` rows once `confirmation_lane = 'HOT'` AND `confirmation_observed_at` is older than 24 hours.
  - `enqueueColdSafeMultisig` now verifies `enqueueRes.success && Number(enqueueRes.meta?.changes ?? 0) === 1`, failing loudly instead of returning false success if a conditional upsert refuses to overwrite an active hot row.
- **Passive Finality Upgrade (`broadcast-recovery-machine.ts` & `settlement-reconciler.ts`):**
  - `BroadcastRecoveryMachine.promoteUnverifiedHotConfirmation(payoutId)` performs a strictly read-only chain finality check (EVM `getTransactionReceipt` with `finalized === true && blockNumber > 0`; Stellar `lookupTransaction` with `successful === true && ledger > 0`) and upgrades `confirmation_lane` from `'UNVERIFIED_HOT'` to `'HOT'` with `confirmation_observed_at = unixepoch('now')`.
  - Runs safely even while `EMERGENCY_PAUSE` or `EMERGENCY_LEDGER_FREEZE` is active (zero signing, zero broadcasts).
  - `selectReconciliationCandidates` selects `state = 'CONFIRMED' AND confirmation_lane = 'UNVERIFIED_HOT' AND safe_multisig_tx_hash IS NULL` so normal confirmed payouts automatically age out after 24h once finality is observed.

## 3. Verification Evidence

- `src/lib/payouts/__tests__/durable-hot-exposure.test.ts`: **37/37 tests PASS**, including:
  - Old (>24h) `SIGNING` / `BROADCAST_PENDING` / unverified `FAILED_ABORTED` rows still count against the $1,500 cap.
  - `promoteUnverifiedHotConfirmation` upgrades `UNVERIFIED_HOT` → `HOT` under `EMERGENCY_PAUSE` and frees cap after 24h.
  - Real `HorizonStellarBroadcastTransport.lookupTransaction` propagates `ledger_attr` to promote `UNVERIFIED_HOT` → `HOT`.
  - `selectReconciliationCandidates` prioritizes `BROADCAST_PENDING` ahead of `UNVERIFIED_HOT` so lagging finality never starves active recovery.
  - `enqueueColdSafeMultisig` rejects overwriting an active `BROADCAST_PENDING` row.
