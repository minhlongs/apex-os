# 02 — Cold Settlement Critical Fix (T-01 / GATE B1)

**Finding:** `T-01 CRITICAL` — Cold settlement proof binding insufficient.  
**Status:** `CLOSED` (`VERIFIED_BY_EXECUTION`, Independent Reviewer A: 0 Critical / 0 High).

---

## 1. Root Cause Fixed

Previously, cold Safe confirmations could accept tx-hash-only outcomes or partial transfer metadata without binding a specific canonical on-chain token transfer operation (`(network, tx_hash, operation_id)`) to a single payout obligation, creating risk of:
- Confirming a payout on a transaction that transferred no USDC to the recipient.
- Reusing one on-chain transfer operation across multiple payout IDs.
- Accepting wrong token contract/issuer, wrong source Safe, wrong amount, or unfinalized receipts.

## 2. Implemented Remediation

- **Durable Unique Operation Claim Schema:** `src/database/migrations/033_cold_settlement_claims.sql` creates `cold_settlement_claims` with `UNIQUE (network, tx_hash, operation_id)` and atomic claim linkage to `payout_id`, `lock_batch_id`, canonical `asset_contract_or_issuer`, `from_address`, `to_address`, and exact `amount_micros`.
- **EVM Verification (`src/lib/payouts/adapters/arbitrum-base-usdc-adapter.ts` & `broadcast-recovery-machine.ts`):**
  - Requires finalized successful receipt (`status === 1`, `finalized === true`, `blockNumber > 0`).
  - Validates exact `chainId` and canonical USDC ERC-20 contract address.
  - Decodes ERC-20 `Transfer(address,address,uint256)` event logs, distinguishing token `from` (Cold Safe) from tx relayer/sender, verifying recipient and exact micro-unit amount, and binding `operationId = log:<logIndex>`.
- **Stellar Verification (`src/lib/payouts/stellar-horizon-transport.ts` & `broadcast-recovery-machine.ts`):**
  - Verifies finalized successful transaction (`successful === true`, `ledger > 0`), canonical USDC asset code + issuer, exact source/destination/amount, and binds unique Horizon payment `operationId`.
  - Enforces 15-second `AbortSignal.timeout(15_000)` on `readColdHorizon` and forwards configured `network` + normalized `usdcIssuer` from `settlement-reconciler.ts`.
- **Atomic Claim & Recovery:** `resumeColdPaymentClaim` resumes verified durable claims if D1 ledger posting fails after claim creation, while rejecting duplicate reuse across payouts and allowing multi-transfer batch transactions with distinct `operation_id`s.

## 3. Mandatory Regression Matrix (COLD-01 .. COLD-12)

| Case | Scenario | Verification Location | Result |
|------|----------|-----------------------|--------|
| **COLD-01** | Successful tx with no customer transfer | `src/__tests__/sandbox/g16-treasury-regressions.test.ts` | `PASS` |
| **COLD-02** | Wrong source treasury address | `g16-treasury-regressions.test.ts` | `PASS` |
| **COLD-03** | Wrong recipient | `g16-treasury-regressions.test.ts` | `PASS` |
| **COLD-04** | Wrong USDC contract / Stellar issuer | `g16-treasury-regressions.test.ts` | `PASS` |
| **COLD-05** | Wrong amount | `g16-treasury-regressions.test.ts` | `PASS` |
| **COLD-06** | Wrong chain / network | `g16-treasury-regressions.test.ts` | `PASS` |
| **COLD-07** | Missing transfer metadata | `g16-treasury-regressions.test.ts` | `PASS` |
| **COLD-08** | One transfer operation reused by two payout IDs | `g16-treasury-regressions.test.ts` | `PASS` |
| **COLD-09** | Concurrent settlement attempts using same operation evidence | `g16-treasury-regressions.test.ts` | `PASS` |
| **COLD-10** | Valid batch tx with two distinct transfers for two payouts | `g16-treasury-regressions.test.ts` | `PASS` |
| **COLD-11** | Retry after D1 ledger write fails (`resumeColdPaymentClaim`) | `g16-treasury-regressions.test.ts` + `settlement-reconciler.test.ts` | `PASS` (verified via durable claim resume) |
| **COLD-12** | Exact replay of already-confirmed payout | `g16-treasury-regressions.test.ts` + `g7-settlement-simulation.test.ts` | `PASS` (idempotent no-op, zero double-post) |

**Suite Evidence:** Reviewer A verified 86/86 tests across T-01 suites (`g16-treasury-regressions.test.ts`, `g7-settlement-simulation.test.ts`, `settlement-reconciler.test.ts`); Reviewer A Medium #1 (`AbortSignal.timeout(15_000)` on `readColdHorizon`) and Medium #2 (explicit `network` + empty-string `usdcIssuer` normalization) were fixed and re-verified.
