# 06 — G23.6 Adversarial Financial Verification & R11 Treasury Chaos Suite

**Date:** 2026-11-22  
**Branch:** `fix/apex-pre-live-cutover-hardening`  
**Test Suite:** `__tests__/payouts/g23-adversarial-treasury-chaos.test.ts`  
**Result:** **PASS — 6/6 Groups (A–F), 0 failures, 0 double-settlements, 0 balance drift**

---

## 1. Test Groups Executed

| Group | Focus | Key Assertion Verified | Result |
|---|---|---|---|
| **Group A** | Turnkey HSM Unknown Outcome | Bounded signing timeout classifies `UNCERTAIN_OUTCOME` with `retryAllowed === false` and exactly `1` upstream HSM call (zero blind retries) | **PASS** |
| **Group B** | Legacy Payout Isolation | Direct `StellarService.processBatchPayouts` invocation throws `LegacyPayoutPathDisabledError` with zero DB prepare/batch calls (`LEGACY_PAYOUT_EXECUTION = 0`) | **PASS** |
| **Group C** | BigInt & Dust Conservation | `Number.MAX_SAFE_INTEGER + 1n` throws `LedgerOverflowError`; Arbitrum split preserves `disbursableUnits1e8 + residualDust1e8 === original` (`1_000_000_000n + 77n`) | **PASS** |
| **Group D** | Migration 037 Triggers | Backdated `UNVERIFIED_HOT → HOT` promotion aborted at SQLite trigger boundary; reversal on confirmed payout aborted for missing terminal proof | **PASS** |
| **Group E** | Emergency Ledger Freeze | Setting `EMERGENCY_LEDGER_FREEZE = 'true'` blocks new `WITHDRAWAL_LOCK` writes at the SQL trigger boundary | **PASS** |
| **Group F (R11)** | 50-Case Concurrent Chaos (30% RPC Failure) | 50 concurrent $20 Stellar payouts ($1,000 total against $2,500 initial liability) with deterministic Mulberry32 PRNG (`0xa9e52026`) injecting ~30% RPC `504` failures (17/50 failed RPCs, 33/50 confirmed via passive on-chain recovery) | **PASS** |

---

## 2. R11 Concurrent Chaos Accounting Proof (Group F)

- **Seeded initial liability:** `50 × $50.00 = $2,500.00` (`250_000_000_000` units at `10^-8` USD).
- **Concurrent dispatches:** `50 × $20.00 = $1,000.00` (within `$1,500` 24h hot-wallet cap).
- **Deterministic RPC failures injected:** `17` (`~34%`, within expected 30% band).
- **Duplicate on-chain submissions:** `0` (`sub.count === 1` for every submitted `payoutId`).
- **Negative user balances:** `0`.
- **Exact conservation equation:** `totalFinalized + totalRemainingSettled + totalInflightLocks === totalInitialLiability` (0 units drift).
- **Uncertain-RPC preservation:** All `17` RPC-failed payouts remained locked (`WITHDRAWAL_LOCK` `INFLIGHT`) and `settlement_broadcasts.state = 'BROADCAST_PENDING'` (zero premature auto-refunds).
- **Global trial-balance check (`verifyLedgerInvariants`):** `valid === true`, `unbalancedBatchIds = []`, `negativeUserAccountCodes = []`, `accountPostingDriftCodes = []`, `periodEquation.driftUnits = 0n`.

---

## 3. Verification Command

```bash
npx jest __tests__/payouts/g23-adversarial-treasury-chaos.test.ts --no-coverage
```
