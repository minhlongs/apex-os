# 03 — G23.3 BigInt & Dust Boundary Conservation Hardening

**Date:** 2026-11-22  
**Branch:** `fix/apex-pre-live-cutover-hardening`  
**Workstream:** G23.3 (Deferred Highs H2 + H3)

---

## 1. Root Causes Addressed
1. **Unchecked `Number(bigint)` conversions in `TurnkeySigner` (`src/lib/payouts/turnkey-signer.ts`):**
   - `claimHotWalletSigningSlot` used raw `Number(params.amountUnits1e8)` and `Number(HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8)`.
   - `enqueueColdSafeMultisig` used raw `Number(proposal.amountUnits1e8)` when binding to D1 `INTEGER`.
   - Values exceeding `Number.MAX_SAFE_INTEGER` (`2^53 - 1`, `$90,071,992.54740991` at `10^-8` scale) or negative values could silently lose precision instead of failing closed.
2. **Sub-chain dust conversion boundaries:**
   - `ledgerUnits1e8ToStellarStroops` (`src/lib/payouts/stellar-service.ts`) and `ledgerUnits1e8ToEvmUsdcUnits` (`src/lib/payouts/adapters/arbitrum-base-usdc-adapter.ts`) previously returned `0n` for sub-stroop (`< 10`) or sub-micro-USDC (`< 100`) positive ledger units rather than rejecting zero-value chain transfer instructions.
   - `ChainUnitConversion` (`src/lib/ledger/units.ts`) now explicitly returns `disbursableUnits1e8` and `divisor` alongside `residualDust1e8`, plus `toSafeNonNegativeSqlInteger()` and `splitChainSettlementAndDust(units, chain, { requireZeroDust? })`.

---

## 2. Hardening Implemented
- **`src/lib/ledger/units.ts`:**
  - Extended `ChainUnitConversion` with `disbursableUnits1e8` and `divisor`, verifying `disbursableUnits1e8 + residualDust1e8 === units1e8`.
  - Added `toSafeNonNegativeSqlInteger(units, label)` enforcing `typeof === 'bigint'`, `units >= 0n`, `units <= JS_MAX_SAFE_BIGINT`, and `Number.isSafeInteger`.
  - Added `splitChainSettlementAndDust(requestedUnits1e8, chain, { requireZeroDust })` allowing legitimate partial settlements while enforcing zero-dust only at explicit opt-in boundaries.
- **`src/lib/payouts/turnkey-signer.ts`:**
  - Replaced all monetary `Number(bigint)` conversions in `claimHotWalletSigningSlot` and `enqueueColdSafeMultisig` with `toSafeNonNegativeSqlInteger(...)`.
- **`src/lib/payouts/stellar-service.ts` & `src/lib/payouts/adapters/arbitrum-base-usdc-adapter.ts`:**
  - Hardened `ledgerUnits1e8ToStellarStroops` and `ledgerUnits1e8ToEvmUsdcUnits` to reject non-bigint, non-positive, and sub-chain dust (`< 10n` / `< 100n`) inputs before any chain transfer instruction can be constructed.

---

## 3. 16-Case Regression Matrix (`__tests__/ledger/bigint-dust-conservation.test.ts`)

Command:
```bash
npx jest __tests__/ledger/bigint-dust-conservation.test.ts --no-coverage
```
Result: **16 passed, 0 failed**.

All 16 required cases verified:
1. Zero (`0n`)
2. One `10^-8` unit (`1n`) — 100% dust on Stellar & EVM; chain adapters reject zero-transfer
3. One `10^-7` unit (`10n`) — 1 stroop on Stellar, 100% dust on EVM
4. One `10^-6` unit (`100n`) — exact on both Stellar (10 stroops) and EVM (1 micro-USDC)
5. Directly below $10 withdrawal threshold (`$9.99999999`) — rejected by `lockSettledForWithdrawal`
6. Exactly `$10.00` — accepted with zero dust on all chains
7. Exactly `$250.00` — exact hot-wallet single-tx ceiling & safe SQL integer
8. Above `$250.00` (`$250.00000001`) — exceeds hot-wallet cap, splits dust cleanly
9. Safe Number boundary (`2^53 - 1` succeeds; `2^53` throws `LedgerOverflowError`; `-1n` throws `LedgerUnitValidationError`)
10. Invalid 64-bit integer (`> SQLITE_MAX_INT64`, unsafe float, and `enqueueColdSafeMultisig` overflow) — throws `LedgerOverflowError`
11. Maximum valid configured ledger amount (`JS_MAX_SAFE_BIGINT` = `$90,071,992.54740991`) — exact conservation
12. Multiple partial withdrawals — `ORIGINAL_LIABILITY = VERIFIED_SETTLEMENT + REMAINING_LIABILITY + VALID_REVERSALS`
13. Cross-chain conversion (Stellar 7dp vs EVM 6dp) — exact remainder preservation
14. Dust accumulation across multiple payouts — every `10^-8` unit retained as customer liability
15. Reversal after partial settlement — exact conservation + `verifyLedgerInvariants.valid === true`
16. Concurrent repeated withdrawal — single winner, second fails with `InsufficientSettledBalanceError`, zero negative balance

---

## 4. Acceptance Verification
- Zero precision loss: **PASS**
- Zero unexplained dust loss: **PASS**
- Zero paid status without verified transfer: **PASS**
- Zero unsafe integer conversion: **PASS**
