# 08 — Dust Lifecycle & Stellar Wire Precision

**Status:** `VERIFIED_BY_EXECUTION`

---

## 1. Verified Behaviors

- **Dust Lifecycle (`__tests__/payouts/g16-dust-lifecycle.test.ts`):**
  - Sub-minimum payouts remain safely accumulated in user available balances without generating uneconomical on-chain transfers or stranding micro-unit remainders.
  - Dust accumulation respects integer micro-unit precision (`10^-6` USDC) with zero truncation loss.
- **Stellar 7-Decimal Wire Precision (`__tests__/payouts/g16-stellar-wire-precision.test.ts`):**
  - Ledger 6-decimal USDC micro-units convert cleanly and reversibly to Stellar stroops (7 decimals) and canonical string representations without IEEE-754 floating-point drift.
  - Exact matching enforced during Horizon payment verification (`stellar-horizon-transport.ts`).

## 2. Executed Evidence

- Both `__tests__/payouts/g16-dust-lifecycle.test.ts` and `__tests__/payouts/g16-stellar-wire-precision.test.ts` executed inside the full 190-suite Jest run (**PASS**, 0 failures).
