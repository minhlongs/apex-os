# Phase 3: CI Pipeline & Gate Hardening (Block C)

## Context
`scripts/go-live-gate.sh` currently runs G0 through G5. We need to expand it to cover:
- G2: Comprehensive KV, R2, and D1 isolation verification.
- G6: Deterministic Replay and Paper Trading Engine verification.
- G7: Release SHA & Environment deployment verification.

## Tasks
1. Update `scripts/go-live-gate.sh`:
   - Incorporate KV/R2 isolation checks into G2.
   - Retain G5 (Operational readiness runbook & historical payout reconciliation).
   - Add G6 (Paper trading replay test verification & simulator tests).
   - Add G7 (Production Deployment & SHA verification).
2. Ensure clean git status check (G0) passes when tree is committed.
3. Test full gate script execution locally.

## Verification
- `bash scripts/go-live-gate.sh` runs cleanly.
