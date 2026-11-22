# 03 — Recovery & RBF Emergency Freeze Fence (T-02 / GATE B2)

**Finding:** `T-02 HIGH` — Recovery/RBF emergency freeze enforcement insufficient.  
**Status:** `CLOSED` (`VERIFIED_BY_EXECUTION`, Independent Reviewer B re-verified).

---

## 1. Root Cause Fixed

Previously, emergency pause/freeze checks lived primarily at HTTP route entry points, leaving direct `BroadcastRecoveryMachine` invocations, scheduled jobs, RBF bump paths, and post-expiry re-execution paths exposed to TOCTOU races or missing policy enforcement.

## 2. Implemented Remediation

- **D1 Write-Boundary Freeze (`034_withdrawal_freeze_at_write.sql`):** Enforces `EMERGENCY_PAUSE` and `EMERGENCY_LEDGER_FREEZE` at the database write boundary for withdrawal locks and safety-epoch transitions.
- **One-Shot Effect Grants & Safety Epoch Fencing (`035_payout_effect_grants.sql`, `src/lib/payouts/payout-effect-fence.ts`):**
  - Maintains monotonic `system_safety_epoch` incremented whenever `EMERGENCY_PAUSE` or `EMERGENCY_LEDGER_FREEZE` activates.
  - Every money-moving side effect (`HSM_SIGN`, `STELLAR_SUBMIT`, `EVM_BROADCAST`, `EVM_REBROADCAST`, `EVM_RBF_BROADCAST`) requires minting a fresh one-shot `payout_effect_grants` row atomically checked against the current non-paused, non-frozen safety epoch immediately prior to the irreversible operation.
  - Fail-closed policy reads: unreadable or missing safety state aborts the effect.
- **Passive Reconciliation Preserved During Emergency Freeze:**
  - Read-only status polling (`recoverUncertainBroadcast(..., { passiveOnly: true, bumpGasRbf: false, reexecuteExpired: false })`) and `promoteUnverifiedHotConfirmation(payoutId)` remain operational while paused/frozen so previously broadcast transactions can confirm on-chain and settle accurately without emitting any new signature, broadcast, or RBF transaction.

## 3. Negative Test Coverage

Verified in `src/__tests__/sandbox/g16-emergency-control-contracts.test.ts`, `src/__tests__/sandbox/g8-uncertain-broadcast-recovery.test.ts`, and `src/lib/payouts/__tests__/durable-hot-exposure.test.ts`:
- Pause before recovery / signing / broadcast / RBF — **BLOCKED** (0 HSM calls, 0 broadcasts).
- Pause during pending recovery — **BLOCKED** for active side effects.
- `EMERGENCY_LEDGER_FREEZE` independent of `EMERGENCY_PAUSE` — **BLOCKED**.
- Policy-store read failure — **FAIL-CLOSED**.
- Concurrent recovery during emergency activation — **FENCED** by `system_safety_epoch`.
- Signed tx exists but not yet broadcast when paused — **BLOCKED** from broadcasting.
- Previously broadcast tx confirms while system remains paused — **RECONCILED PASSIVELY** with 0 new signatures/broadcasts.

## 4. Documented Residual Distributed-Race Boundary

In a distributed Cloudflare Workers environment, a Worker that already dispatched an outbound HTTP request to Turnkey/RPC microseconds before `EMERGENCY_PAUSE` commits in D1 cannot retroactively cancel an in-flight TCP packet. The `payout_effect_grants` epoch check minimizes this window to the single HTTP round-trip immediately after the D1 grant write and prevents any retry, rebroadcast, or RBF from proceeding after the epoch increments.
