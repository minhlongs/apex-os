---
title: "Phase 1: Red Regressions and Evidence Handoff"
status: todo
---

# Phase 1: Red Regressions and Evidence Handoff

## Overview

Do not author or execute tests in the primary worktree. The already-running test-only agent owns this phase in `/Users/macbook/apex-os-worktrees/g16-red-tests`; wait for its report and verify its changed paths/results before implementation. This phase blocks every production-code change.

## Requirements

- Preserve isolated SQLite and mocked signer/RPC boundaries from baseline report 24.
- Confirm each regression fails on audited baseline `262b070a0f07eeb3367415bb192ed2bf717f5867` for the unsafe outcome, not because setup/tooling fails.
- Capture exact command and exit status without `tail` pipelines that mask failures.
- Include all provisional case IDs in the later phase 5 map. Use the original user case definitions held by the coordinator; bind each exact requirement to test names and expected outcomes before calling any mapping complete.

## Files and Ownership

- Test files under `/Users/macbook/apex-os-worktrees/g16-red-tests/`: owned only by the test agent; do not duplicate or edit.
- Execution evidence: owned only by the test agent in its isolated worktree.
- Main worktree: no source or test changes in this phase.

## Implementation Steps

1. Wait for the test agent completion; do not spawn a second scout or duplicate the test work.
2. Read its exact test diff and execution log; confirm the base SHA and failure cause for each red case.
3. Record missing mapping or untested failure mode honestly; block phase 2 if cold operation identity, race boundaries, or cap-history cases lack meaningful red coverage.
4. Transfer only reviewed test changes/evidence into the implementation sequence under explicit ownership; never merge by overwriting concurrent work.

## Test Matrix

| Domain | Required red behavior |
|---|---|
| Cold EVM and Stellar | Success status without matching canonical transfer/operation cannot confirm; wrong asset, recipient, or amount fails closed; exact proof is claimed once; retries and ledger partial recovery are idempotent. |
| Pause/freeze | Pause/freeze raised between initial validation and each irreversible signing/broadcast/rebroadcast/recovery path blocks new effects; D1, signer, and RPC failure windows are explicit. |
| Exposure | Unresolved old rows remain counted; cross-chain/signer admission remains global; concurrency cannot over-admit; confirmed-history ambiguity is conservative. |
| Dust/reserve | Stellar/EVM precision residue and native reserve/balance boundaries remain visible and are not silently lost or spent. |

## Success Criteria

- Test-agent evidence is reproducible, has independent exit status and audited baseline SHA, and is available to the implementation owner.
- Every case ID is accounted for in phase 5; unmatched IDs are explicitly marked missing, not fabricated.
- No source implementation begins before red evidence is accepted.

## Risk and Rollback

High likelihood/impact: red tests can pass for the wrong reason or miss one irreversible effect. Mitigate by tracing each failure to the expected unsafe behavior and requiring phase 3's explicit effect inventory. Rollback is simply to discard this phase's isolated test-only work if it is invalid; do not alter primary-worktree code or shared stash.

## Next Steps

Phase 2 starts only after red evidence is reviewed and missing critical proof/claim cases are resolved.
