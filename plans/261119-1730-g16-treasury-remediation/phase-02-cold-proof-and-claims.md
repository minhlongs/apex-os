---
title: "Phase 2: Cold Proof and Durable Claims"
status: todo
---

# Phase 2: Cold Proof and Durable Claims

## Overview

Make manual Safe 2-of-3 cold settlement verifiable and idempotent across Stellar and EVM, including partial recovery between on-chain evidence, broadcast state, and ledger finalization. Start only after phase 1 red evidence.

## Verified Context and Data Flow

`resolveColdSafeBroadcast` gets a cold queued broadcast row, queries Stellar Horizon or the chain adapter, runs `verifyColdSafeTransferDetails`, and updates `settlement_broadcasts` to confirmed (`src/lib/payouts/broadcast-recovery-machine.ts:2450-2532`). The existing check permits absent metadata unless optional strictness is true (`broadcast-recovery-machine.ts:480-518`). EVM adapter receipts currently return status/block/gas fields but no decoded Transfer logs (`src/lib/payouts/adapters/arbitrum-base-usdc-adapter.ts:772-800`). Stellar lookup returns only found/successful (`src/lib/payouts/stellar-horizon-transport.ts:220-229`). The dispatch API then finalizes the ledger separately (`src/app/api/admin/settlement/dispatch/route.ts:297-320`), so a crash or D1 error can leave a confirmed broadcast and inflight withdrawal lock; the passive reconciler already searches such terminal/inflight mismatches (`src/lib/payouts/settlement-reconciler.ts:213-265`).

## Requirements and Design

- Never equate successful transaction status with payout proof. Parse authoritative operation/log data from the chain's canonical transaction/receipt APIs; require exact configured USDC asset, destination, raw chain units, chain identity and successful status.
- EVM: decode all relevant receipt logs; reject missing, malformed, duplicate/ambiguous or mismatching transfers. Verify expected token contract as well as exact recipient/amount. Logs must correspond to the specific confirmed transaction, not merely an address balance delta.
- Stellar: fetch successful transaction operations (including pagination/operation result semantics if exposed by chosen Horizon API); require the exact USDC payment operation/asset/recipient/amount. Reject failed operation results even if transaction envelope lookup exists.
- Persist a unique network/chain + transaction hash + operation/log identity claim before or atomically with state/ledger resolution. The claim must prevent one on-chain transfer satisfying two payout IDs and make retry after process interruption safe. Use an additive migration after live migrations; do not edit historical migration 028. Define canonical identity per chain and handle transaction-level hash with multiple payment operations without blocking legitimate distinct operations.
- Cold flow has no Turnkey signing from this worker; preserve its admin authentication, existing routes and Safe workflow. Keep behavior fail-closed even if old optional strictness flag is omitted.
- Recovery must converge from each partial state: proof fetched but D1 unavailable; claim inserted but broadcast update failed; broadcast confirmed but ledger still inflight; ledger finalized but HTTP response lost. Do not mark funds settled before unique proof and ledger idempotency key persist.

## Files to Inspect/Change (implementation owner)

- Modify `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/payouts/broadcast-recovery-machine.ts` for strict canonical proof and claim ordering.
- Modify `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/payouts/adapters/arbitrum-base-usdc-adapter.ts` and its RPC/receipt types for decoded logs, preserving generic transaction receipt callers.
- Modify `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/payouts/stellar-horizon-transport.ts` for operation-level lookup.
- Modify `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/app/api/admin/settlement/dispatch/route.ts` only if needed to return truthful partial-recovery outcomes without changing route contract.
- Modify `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/payouts/settlement-reconciler.ts` only if needed to heal the identified confirmed-broadcast/inflight-lock partial state.
- Add one additive migration in `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/database/migrations/` with proper ignore allowlist tracking; do not apply remotely.
- Tests are owned by phase 1 test agent and then implementation owner after explicit handoff. Shared-file concurrency is prohibited.

## Implementation Steps

1. Define chain-canonical operation identity and a persisted claim schema with unique constraints and indexed payout lookup.
2. Extend EVM receipt decoding to return raw log identity and decoded Transfer fields for expected contract address; reject receipt success without parsed transfer data.
3. Extend Stellar lookup to return successful operation details for exact asset and payment amount; do not fall back to transaction-level success.
4. Validate payout row and evidence; insert/claim unique operation identity with conditional state transition. A conflict tied to another payout is a hard reject and auditable recovery case.
5. Ensure confirmed broadcast and ledger finalization/reconciliation can be retried idempotently after any D1 or response interruption. Define how to resolve claim-without-confirm and confirm-without-ledger cases without allowing reuse.
6. Remove reliance on caller-supplied strictness while retaining compatible request shape; never break the existing dispatch API route.
7. Run focused deterministic fixtures/mocked transports and migration application against isolated SQLite before proceeding.

## Data Flow

Chain RPC/Horizon canonical receipt or transaction operations → parse status + exact operation identity + USDC asset + recipient + integer units → validate against queued payout row → durable unique operation claim and conditional broadcast transition → idempotent ledger finalize/reconciliation → API result. Any missing/ambiguous evidence or D1 failure stops confirmation and leaves claims/state recoverable, never releases or finalizes funds on an unsupported claim.

## Test Matrix

Unit: EVM log decode including indexed recipient, exact contract, transfer with adjacent unrelated logs, malformed topics/data, duplicate matches, reverted receipt and absent logs; Stellar operation parsing, pagination, trustline/native asset vs issued USDC distinctions, failed operation and multiple payments; canonical identity stability. Integration: same transfer presented for two payouts, same tx with separate operations, duplicate retries, claim conflict, each interruption point, migration on empty/current fixture. End-to-end: authenticated cold resolution request through mocked canonical transport and ledger reconciler; response lost/retry; existing route shape unchanged.

## Success Criteria

- Every cold `CONFIRMED` transition has exact canonical payment proof and one durable globally unique operation claim.
- No missing/mismatching proof can confirm even with strictness option omitted.
- Injected D1/process interruption converges without double settle, double refund, duplicate claim, or stuck ledger after retry/reconciler.
- No remote DB/RPC, live credentials, or production setting is used.

## Risk, Rollback, and Dependencies

High likelihood/impact: provider/RPC payload omissions or unstable chain identity could produce false rejects or duplicate claims. Fail closed, test real payload shapes from fixtures/checked-in types only; do not query live chain. High: claim-before-state creates recoverable orphan claims; retain them and reconcile only against same canonical proof, never delete to retry. Migration rollback is forward-compatible: leave additive claim table/index in place and revert application code; do not drop claim evidence. Block on phase 1 red suite and read-only migration consistency.

## Next Steps

Only after this phase's focused proof, migration, and partial-recovery tests pass may phase 3 alter the same recovery machine and signer files.
