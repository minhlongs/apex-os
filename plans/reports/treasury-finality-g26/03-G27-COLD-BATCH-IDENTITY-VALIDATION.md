# G27.C1 — Cold Batch Identity Model Validation

**Date:** 2026-11-23  
**Branch:** `fix/apex-treasury-finality-secret-boundary`  
**Worktree:** `/Users/macbook/apex-os-worktrees/track-c-treasury`  
**Determination:** **Case A Confirmed** (1:1 `safe_multisig_tx_hash` per payout; multi-op shared on-chain `tx_hash` via `cold_settlement_claims(network, tx_hash, operation_id)`).

---

## 1. Exhaustive Production Caller Audit

Every production reference to `safe_multisig_tx_hash`, `enqueueColdSafeMultisig`, `resolveColdSafeBroadcast`, `finalizeColdClaim`, and `cold_settlement_claims` in `src/` was audited:

| Component | File | Behavior |
|---|---|---|
| `TurnkeySigner.enqueueColdSafeMultisig` | `src/lib/payouts/turnkey-signer.ts:1829-1934` | **Sole production writer** of `safe_multisig_tx_hash`. Derives a deterministic per-payout hash via `keccak256('SAFE_2OF3_PROPOSAL_V1|chain|safeAddress|payoutId|idempotencyKey|recipientAddress|chainTokenUnits')` prefixed with `safe_2of3_`. Because `payoutId` and `idempotencyKey` are included, every payout has a unique `safe_multisig_tx_hash`. |
| `BroadcastRecoveryMachine` (enqueue sites) | `src/lib/payouts/broadcast-recovery-machine.ts:806, 967, 1144` | All three production call sites enqueue one `payoutId` at a time into `QUEUED_COLD_SAFE`. Zero callers write a shared Safe MultiSend proposal hash across multiple `settlement_broadcasts` rows. |
| `BroadcastRecoveryMachine.resolveColdSafeBroadcast` & `finalizeColdClaim` | `src/lib/payouts/broadcast-recovery-machine.ts:2275-2489` | Validates `WITHDRAWAL_LOCK`, verifies exact on-chain transfer via `selectColdPaymentTransfer`, atomically inserts `(network, tx_hash, operation_id)` into `cold_settlement_claims`, finalizes ledger batch `wd_cold_fin:<payoutId>`, and transitions `settlement_broadcasts` to `state = 'CONFIRMED'`, `confirmation_lane = 'COLD'`, `tx_hash = claim.tx_hash`. |
| `selectColdPaymentTransfer` | `src/lib/payouts/cold-payment-evidence.ts:24-70` | Enforces exact `network`, `txHash`, `blockReference`, `source`, `recipient`, `asset`, `amountUnits`, and unique `operationId` matching. Rejects ambiguous multi-match transfers when `operationId` is omitted. |
| `reconcilePendingSettlementBroadcasts` | `src/lib/payouts/settlement-reconciler.ts:227-384` | Resumes `QUEUED_COLD_SAFE` rows that already have a durable `cold_settlement_claims` row via `resumeColdPaymentClaim`, and treats already-confirmed cold rows with settled locks as no-ops. |
| Admin dispatch route | `src/app/api/admin/settlement/dispatch/route.ts:297, 370` | Delegates cold resolution to `machine.resolveColdSafeBroadcast(...)`; read-only guard on `existingSettlement.safe_multisig_tx_hash`. |
| Schema & Triggers | `src/database/migrations/033_cold_settlement_claims.sql`, `038_cold_finality_parity.sql` | `cold_settlement_claims` enforces `PRIMARY KEY (network, tx_hash, operation_id)`, `payout_id UNIQUE`, `lock_batch_id UNIQUE`. Migration `038` scopes `idx_settlement_broadcasts_unique_tx_hash` to HOT/non-COLD rows (permitting multi-op batched COLD `tx_hash`es) while preserving `idx_settlement_broadcasts_unique_safe_tx_hash` (enforcing Case A 1:1 proposal uniqueness). |

---

## 2. Explicit Case A Determination

- **Safe MultiSend shared proposal hashes are NOT currently supported** and are intentionally rejected fail-closed by `idx_settlement_broadcasts_unique_safe_tx_hash` in `038_cold_finality_parity.sql`.
- **`safe_multisig_tx_hash` is strictly 1:1 per payout** (`payout_id`).
- **Multi-op batched on-chain `tx_hash` IS supported** for both Stellar multi-operation transactions and EVM ERC-20 multi-log `Transfer` batches, with operation-level exclusivity enforced atomically by `cold_settlement_claims PRIMARY KEY (network, tx_hash, operation_id)`.
- `idx_settlement_broadcasts_unique_safe_tx_hash` is **preserved intact** in `038_cold_finality_parity.sql` with updated documentation comments clarifying the Case A invariant.

---

## 3. Mandatory Test Matrix Results

Suite: `__tests__/payouts/g27-track-c-cold-batch-identity.test.ts` (full migrations `001–038`)

| # | Scenario | Result |
|---|---|---|
| 1 | Two payouts sharing on-chain `tx_hash` with distinct `operation_id`s (Stellar multi-op + EVM Arbitrum ERC-20 multi-log Transfer) | PASS — both settle to `CONFIRMED` (`confirmation_lane = 'COLD'`) with distinct `safe_multisig_tx_hash`es and 4 distinct `cold_settlement_claims` rows; `verifyLedgerInvariants` valid. |
| 2 | Two payouts attempting to share both `tx_hash` and `safe_multisig_tx_hash` (including case/whitespace variants) | PASS — rejected fail-closed by `idx_settlement_broadcasts_unique_safe_tx_hash`. |
| 3 | Same `(network, tx_hash, operation_id)` reused across different `payout_id` liabilities | PASS — rejected; second payout stays `QUEUED_COLD_SAFE`, `tx_hash = NULL`, `WITHDRAWAL_FINALIZED` count = 1. |
| 4 | Duplicate evidence claims against an already-claimed payout | PASS — rejected with exact 1 `cold_settlement_claims` row and 1 `WITHDRAWAL_FINALIZED` batch. |
| 5 | Incorrect recipient address or incorrect `amountUnits1e8` | PASS — rejected before claim insert; broadcast remains `QUEUED_COLD_SAFE`, 0 claims, 0 finalized batches. |
| 6 | Parallel confirmation across two isolates (`BroadcastRecoveryMachine` + `SqliteD1Adapter` pairs) | PASS — zero double-finalization; exact 1 claim, 1 `WITHDRAWAL_FINALIZED` batch, `verifyLedgerInvariants` valid. |
| 7 | Migration `038` on pre-038 DB with duplicate `safe_multisig_tx_hash` vs valid historical batched cold rows | PASS — fails loudly with `UNIQUE constraint failed` on duplicate `safe_multisig_tx_hash`; upgrades valid shared-`tx_hash` / distinct-`safe_multisig_tx_hash` rows cleanly. |
| 8 | Idempotent reconciliation (`resolveColdSafeBroadcast` + `reconcilePendingSettlementBroadcasts` on confirmed cold payout) | PASS — safe no-op with zero duplicate ledger batches and zero trigger errors. |
