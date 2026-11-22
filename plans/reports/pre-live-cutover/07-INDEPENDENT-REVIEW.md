# G23.7 — Independent 5-Domain Read-Only Review & Remediation Report

**Sprint:** Post-Merge PR A — Pre-Live-Cutover Hardening (`fix/apex-pre-live-cutover-hardening`)  
**Baseline:** `master` @ `0ffa2c027d0f0afdffac1c08b285e88a96464945` (PR #56 merged)  
**Date:** 2026-11-22  

---

## 1. Review Methodology

Five independent read-only `code-reviewer` agents were dispatched in parallel across disjoint financial and security domains, followed by fresh independent re-verification agents for the two domains that surfaced confirmed High/Critical findings (Reviewer A — HSM Security; Reviewer D — Migration 037). Every finding was verified against actual source code and deterministic tests.

---

## 2. Final Independent Verdict Matrix

| Reviewer | Domain | Initial Verdict | Confirmed Critical/High | Remediation Status | Final Verdict |
|---|---|---|---|---|---|
| **Reviewer A** | Turnkey HSM Security & Unknown-Outcome State Machine | `HOLD` (4 actionable findings) | 2 High / 2 Medium | All 4 fixed + 1 re-verification catch (`last_error` → `error_reason` on Stellar line 1119) fixed + 4 new regression tests (`18/18` PASS) | **PASS_WITH_NITS** |
| **Reviewer B** | Ledger, BigInt Overflow & Dust Conservation | `PASS_WITH_NITS` (1 TS2339 in test) | 0 Critical / 0 High | Test `TS2339` fixed; all 4 financial invariants verified | **PASS** |
| **Reviewer C** | Legacy Money-Moving Path Isolation | `PASS_WITH_NITS` | 0 Critical / 0 High | `LEGACY_PAYOUT_EXECUTION = 0`; `worker-wrapper.js:247` fail-closed verified | **PASS_WITH_NITS** |
| **Reviewer D** | Migration 037 Triggers & Finality Bookkeeping | `HOLD` (6 trigger bypasses/gaps) | 2 Critical / 4 High | All 6 fixed in `037_hardening_trigger_and_exposure.sql` + Test 11 added; re-verified by fresh agent | **PASS_WITH_NITS** |
| **Reviewer E** | Governance, CI Safety & Scope Compliance | `PASS_WITH_NITS` | 0 Critical / 0 High | Added `deploy.yml` secret-wiring prerequisite to `05-CLOUDFLARE-TOKEN-SEGMENTATION-PLAN.md` | **PASS_WITH_NITS** |

**Unresolved Critical/High Findings:** **0**

---

## 3. Detailed Remediation Log

### Reviewer A — Turnkey HSM Security (`src/lib/payouts/turnkey-signer.ts`, `payout-effect-fence.ts`, `broadcast-recovery-machine.ts`)
1. **HTTP 5xx misclassification (`turnkey-signer.ts`):** `classifyProviderError` checked generic error keywords before HTTP status, risking a 500/502/503 with an ambiguous message being classified as `DEFINITE_REJECTED`. Fixed by checking `status >= 500` → `UNCERTAIN_OUTCOME` first and `status === 404` → `CONFIGURATION_ERROR`.
2. **Non-completed Turnkey activity status (`turnkey-signer.ts`):** Added `status?: string` to `TurnkeyRawPayloadApiResponse.activity`; `executeBoundedRawSign` now fails closed as `UNCERTAIN_OUTCOME` whenever `activity.status` is present and not `'ACTIVITY_STATUS_COMPLETED'`.
3. **Invalid EVM `vHex` during activity lookup (`turnkey-signer.ts`):** `lookupSigningActivity` now catches malformed signature / invalid `vHex` and classifies as `UNCERTAIN_OUTCOME` with `requiresHumanReview: true` instead of throwing an unclassified error.
4. **Lost `turnkey_activity_id` & `error_reason` across `withPayoutEffect` (`payout-effect-fence.ts`, `broadcast-recovery-machine.ts`):** `PayoutEffectBlockedError` now preserves `readonly cause?: unknown` while keeping `owner.unresolved = true`. Both EVM and Stellar catch blocks in `broadcast-recovery-machine.ts` unwrap `TurnkeyHsmOutcomeError` (direct or via `PayoutEffectBlockedError.cause`) and persist `turnkey_activity_id = COALESCE(turnkey_activity_id, ?)` and `error_reason = COALESCE(error_reason, ?)`.
5. **Re-verification catch (Stellar SQL column name):** Fresh re-verification caught `last_error` (non-existent column) on the Stellar catch block (`line 1119`); corrected to `error_reason` (matching `028_ascendancy_audit_core.sql:185`) and locked in with a dedicated Stellar persistence regression test (`__tests__/payouts/turnkey-hsm-unknown-outcome.test.ts`, `18/18` PASS).

### Reviewer D — Migration 037 (`src/database/migrations/037_hardening_trigger_and_exposure.sql`)
1. **SQLite NULL three-valued logic bypass:** Replaced `!=` with NULL-safe `IS NOT` / `IS` across `trg_withdrawal_require_terminal_proof` and `trg_settlement_preserve_confirmed_finality` so `NEW.payout_id IS NULL` or `confirmation_lane = NULL` cannot bypass trigger guards.
2. **Duplicate `WITHDRAWAL_REVERTED` / `WITHDRAWAL_FINALIZED` against same `lockBatchId`:** Added explicit `EXISTS` check rejecting any duplicate terminal journal against the same `lockBatchId`.
3. **Two-step `UNVERIFIED_HOT` → `NULL` → `HOT` bypass:** Hardened `trg_settlement_enforce_hot_finality_promotion` to guard ANY transition `OLD.confirmation_lane IS NOT 'HOT' AND NEW.confirmation_lane = 'HOT'`, requiring `CONFIRMED`, non-empty `tx_hash`, no `safe_multisig_tx_hash`, and fresh integer `confirmation_observed_at` within `[unixepoch('now') - 300, unixepoch('now')]`.
4. **Fake `COLD` promotion without Safe multisig hash:** Added guard requiring non-empty `safe_multisig_tx_hash` for any transition into `COLD`, and locked `UNVERIFIED_HOT` rows against transitioning to `NULL` or `COLD`.
5. **`DELETE` tampering on `CONFIRMED` rows:** Added `trg_settlement_prevent_confirmed_delete` (`BEFORE DELETE ON settlement_broadcasts WHEN OLD.state = 'CONFIRMED'`).
6. **Re-verification:** Fresh `code-reviewer` agent re-audited `037_hardening_trigger_and_exposure.sql` and `__tests__/database/migration-037-drill.test.ts` and returned `PASS_WITH_NITS` (0 Critical, 0 High).

### Reviewer E — Governance & Token Plan (`plans/reports/pre-live-cutover/05-CLOUDFLARE-TOKEN-SEGMENTATION-PLAN.md`)
- Documented the explicit prerequisite that `.github/workflows/deploy.yml` must be updated to consume the segmented deploy token secret names before revoking the legacy `CLOUDFLARE_API_TOKEN`.
