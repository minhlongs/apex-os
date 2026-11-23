# Track C Independent Security & Quality Review (G26.C5)

**Date:** 2026-11-23
**Worktree:** `/Users/macbook/apex-os-worktrees/track-c-treasury`
**Branch:** `fix/apex-treasury-finality-secret-boundary`
**Baseline SHA:** `eb2e1e55015458a3b6d14358cb2f8e42f29cbaf7`
**Final Re-Review Verdict:** `PASS` (0 unresolved Critical, High, or Medium findings)

---

## 1. Round 1 Independent Adversarial Review Panel (4 Roles)

| Reviewer | Scope | Round 1 Verdict | Blocking / Actionable Findings |
|----------|-------|-----------------|--------------------------------|
| **Reviewer A** | Migration 038 & SQL Finality | `FAIL` | Confirmed `001–037` untouched. Caught C1: global `tx_hash` uniqueness broke multi-op Stellar cold batches; C2: unconditional `signing_lane` immutability broke legitimate `HOT -> COLD` `enqueueColdSafeMultisig` escalation; H3: SQLite `trim()` only strips `0x20` (allowing tab/LF); H4: `NULL` `signing_lane` bypass; H5: `UNVERIFIED_HOT` bypass; H6: pre-038 non-`CONFIRMED` `confirmation_lane = 'COLD'` promotion bypass; M7: additional confirmed columns (`chain_token_units`, `chain_decimals`, `signer_address`, `idempotency_key`) mutable |
| **Reviewer B** | Stellar Raw-Secret Elimination | `PASS_WITH_NOTES` | Confirmed zero raw-secret Stellar signing paths in production `src/`, unconditional `LegacyPayoutPathDisabledError` on `submitTransaction`/`sendPayout`/`processBatchPayouts`, and all read-only Horizon paths intact; M2: `StellarAdapter.getService()` caught/swallowed `Invalid Stellar senderPublicKey` errors; L1: unused `logError` import; L2: `StellarAdapter.sendPayout()` called `hasUsdcTrustline` before failing closed |
| **Reviewer C** | Payout Recovery & Exposure Integrity | `FAIL` | Independently confirmed C1 (multi-op batched cold settlements) and C2 (`HOT -> COLD` Turnkey policy-hard-block escalation stranding `SIGNING` rows); confirmed `exposure_released_at`, emergency safety epoch, and Turnkey-only boundaries intact; H3: add end-to-end integration tests exercising `BroadcastRecoveryMachine` + `TurnkeySigner` under migration 038 |
| **Reviewer D** | Regression Test Quality | `FAIL` | Confirmed existing modified tests preserved/strengthened assertions; flagged C1: 50-case recovery test needed real `BroadcastRecoveryMachine` + `DoubleEntryLedgerService` + `verifyLedgerInvariants`; C2: migration rehearsal needed full `001–038` fresh install + `001–037 -> 038` upgrade; H3: use valid 56-char Ed25519 seed fixture; H4: expand negative trigger matrix for HOT parity, COLD UPDATE, DELETE, and immutability |

---

## 2. Remediation Applied

1. **`src/database/migrations/038_cold_finality_parity.sql`** (migrations `001–037` remain 100% untouched):
   - Scoped `idx_settlement_broadcasts_unique_tx_hash` to non-COLD / HOT rows so multi-op batched cold settlements sharing a `tx_hash` (with per-operation uniqueness enforced by `cold_settlement_claims` from migration 033) succeed.
   - Switched `trg_settlement_enforce_hot_finality_promotion` to `BEFORE UPDATE ON settlement_broadcasts`; permitted `HOT -> COLD` `signing_lane` escalation strictly from `SIGNING`/`FAILED_ABORTED`/`EXPIRED_RECOVERED` -> `QUEUED_COLD_SAFE` with `NULL` `tx_hash`, `signed_raw_tx`, and `confirmation_lane`, blocking all other `signing_lane` mutations.
   - Trimmed `' ' || char(9) || char(10) || char(13)` and rejected embedded whitespace (`GLOB`) on `payout_id`, `tx_hash`, `lock_batch_id`, and `safe_multisig_tx_hash`.
   - Required non-NULL matching `signing_lane` (`'HOT'` / `'COLD'`) on INSERT and UPDATE promotions, enforced explicit `UNVERIFIED_HOT` invariants, and guarded pre-038 non-`CONFIRMED` rows via `OLD.state IS NOT 'CONFIRMED'`.
   - Extended `trg_settlement_preserve_confirmed_finality` to protect `chain_token_units`, `chain_decimals`, `signer_address`, and `idempotency_key` while preserving `exposure_released_at` updates and `UNVERIFIED_HOT -> HOT` promotions.
2. **`src/lib/payouts/adapters/stellar-adapter.ts` & `src/lib/payouts/stellar-service.ts`**:
   - Re-threw `LegacyPayoutPathDisabledError` and `/Invalid Stellar senderPublicKey/i` in `StellarAdapter.getService()`.
   - Failed closed immediately with `LegacyPayoutPathDisabledError` in `StellarAdapter.sendPayout()` before any Horizon network call.
   - Removed unused `error as logError` import in `stellar-service.ts`.
3. **`__tests__/payouts/g26-track-c-treasury-finality.test.ts` & related payout suites**:
   - Added full `001–038` fresh install and `001–037 -> 038` upgrade rehearsal (including batched multi-op cold rows, idempotency, and SQLite backup/restore).
   - Added complete HOT/COLD/UNVERIFIED_HOT negative trigger matrix with post-throw rollback checks.
   - Replaced 52-char fixture with valid 56-char Ed25519 StrKey seed (`/^S[A-Z2-7]{55}$/`).
   - Wired real 50-case concurrent `BroadcastRecoveryMachine` + `DoubleEntryLedgerService` + `verifyLedgerInvariants` recovery under 30% deterministic RPC failure (35 confirmed, 15 `BROADCAST_PENDING`, zero double settlement, exact conservation).
   - Added real end-to-end `TurnkeyPolicyHardBlockError` `HOT -> COLD` escalation and multi-op batched `resolveColdSafeBroadcast` tests under migration 038.

---

## 3. Round 2 Isolated Re-Review Verdict

- **Verdict:** `PASS`
- **Remaining Critical / High / Medium Findings:** None.
- **Verification:** `typecheck` PASS, `lint` PASS, `assert-staging-isolation.sh` (`STAGING_ISOLATED`), `g26-track-c-treasury-finality.test.ts` 12/12 passed, 30/30 payout/sandbox suites (359/359 tests) passed, full suite `CI=true npm test` 201/201 suites (4,005 passed, 1 pre-existing Track B skip, 0 failed), `build:worker` PASS.
- **Release Gate Preserved:** `LIVE_SETTLEMENT=HOLD`, `REMOTE_D1_MIGRATION=NOT_AUTHORIZED`, `STAGING_DEPLOY=HOLD`, `PRODUCTION_DEPLOY=HOLD`, `PUBLIC_GA=HOLD`.
