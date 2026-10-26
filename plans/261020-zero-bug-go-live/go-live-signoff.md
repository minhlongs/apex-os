# Founder Go-Live Sign-Off Record

This document records founder authorization and verification results for the ApexOS production deployment.
Both decisions (D1 and D2) have been evaluated, confirmed, and executed across the codebase.

## Architectural & Governance Decisions

- **D1 (Multi-Chain Resolution)**: `D1=stellar-mainnet-fail-closed`
  - Stellar USDC runs on real Stellar mainnet (`STELLAR_NETWORK=mainnet`).
  - Solana and Ethereum chain adapters remain strictly fail-closed (`success: false`) until hardware key management and on-chain signing infrastructure are provisioned in Phase 07.
- **D2 (Single Settlement Authority)**: `D2=batch-settlement-service-single-authority`
  - `BatchSettlementService.executeBatch()` is the sole authorized payout settlement engine.
  - All scheduled and manual payout triggers (`worker-wrapper.js`, `/api/cron?job=payouts`, `POST /api/payouts`) delegate to `BatchSettlementService`. Inline unconfirmed SQL and float fee math are decommissioned.

## Verification Sign-Off Summary

- **Sign-Off Date**: 2026-10-26
- **Target Branch**: `feat/phase-04-05-06-unified-go-live`
- **Release Target**: Production (Staging Isolation Verified)
- **Status**: APPROVED

## Phase 07 Pre-Flight Historical Payout Reconciliation Record (2026-10-26)

- **Audit Command**: `bash scripts/reconcile-historical-payouts.sh --remote --config wrangler.jsonc`
- **D1 Database**: `apex-os-db` (`3436aa7d-3065-4103-96e1-ddbd8b372246`)
- **Migration Applied**: `src/database/migrations/023_multichain_payouts.sql` (following full D1 export backup)
- **Orphaned Paid Earnings (`is_paid=1` without completed payout)**: `0 rows`
- **Flagged Historical Payouts**: `1 row`
  - `id`: `payout-001`
  - `affiliate_id`: `user-001`
  - `amount` / `net_amount`: `2.175 USDC`
  - `chain`: `stellar`
  - `transaction_id`: `txn_abc123def456` (Reason: `malformed_stellar_tx_hash` — synthetic seed record from initial database bootstrap on 2026-06-14)
- **Founder Remediation Decision**:
  - **Preservation**: Retain `payout-001` unmodified in D1 (`0` rows deleted or overwritten, preserving ledger audit history).
  - **Classification**: Recorded as a synthetic pre-launch test seed (`user-001`, `2.175 USDC`). Note that all 3 existing `earnings` rows (`earn-001`, `earn-004`, `earn-006`) remain `is_paid = 0` (`payout_id = null`), confirming zero customer earnings were falsely retired.
  - **Sign-Off**: `RECONCILIATION_APPROVED=true` (Authorized by Founder on 2026-10-26).
