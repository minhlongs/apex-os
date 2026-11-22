---
title: "Phase 3: Live Safety Fencing"
status: todo
---

# Phase 3: Live Safety Fencing

## Overview

Recheck emergency pause/freeze immediately before every irreversible new external effect across settlement, recovery, rebroadcast, RBF, and cold resolution. Treat D1 and Turnkey/RPC as separate systems; a D1 safety read cannot be atomic with a later external call.

## Verified Path and Failure Boundary

Initial `executeSettlement` safety validation occurs before the cross-isolate D1 signing claim (`src/lib/payouts/broadcast-recovery-machine.ts:932-956`). Direct EVM/Stellar signing enforcement performs amount/rolling cap reads before Turnkey transport calls (`src/lib/payouts/turnkey-signer.ts:1069-1132`) but does not currently reread emergency flags. The machine later broadcasts via EVM (`broadcast-recovery-machine.ts:1316-1320`) and submits Stellar (`:1436-1443`). Recovery and RBF paths include Turnkey signing and EVM rebroadcasts (`:1505+`, `:2024`, `:2200`, `:2255`); cold resolution makes chain read and D1 state change (`:2450-2532`). Pause/freeze reads query both flags at `src/lib/payouts/usdc-safety-guards.ts:133-150`. No amount of D1 check can atomically prevent a flag change after the check but before an already-started Turnkey/RPC operation.

## Requirements and Boundary Decision

- Build an explicit call/effect inventory for each direct route, scheduled reconciler and machine method; include signing, first submit, repeat submit, same-nonce rebroadcast, RBF signing/broadcast, and cold-resolution finalization.
- Fail closed on missing/unreadable safety flags immediately before each new Turnkey signing request and each new transaction submission/rebroadcast. Checks must include `EMERGENCY_PAUSE` and `EMERGENCY_LEDGER_FREEZE`. A safe failure leaves durable state and signed payload recoverable; it must not allocate a new signature/nonce or refund uncertain funds.
- Do not split the shared recovery machine or signer file ownership. Implement this phase only after phase 2 has finished these same files.
- Use one durable workflow attempt from signing through submission and recovery, with separate one-shot effect admissions under that attempt. Bind workflow ownership to the actual withdrawal lock, business owner, chain, signer, nonce/sequence when assigned, and the initial safety epoch. Do not retire the workflow merely because one callback returns. Serialize each effect admission against the primary D1 pause/freeze writes; all flag writers, including depeg and resume, must advance the epoch atomically with a safety-state change. Revalidate both flags, the original epoch, lock and workflow ownership at the final local boundary. If admission cannot be confirmed, do not issue the request. Pause/resume must not revive an old workflow through a newly sampled epoch. A claim orders application work; it cannot revoke externally submitted requests or signed bytes.
- If a Turnkey policy-side stop or equivalent is not observable/configurable in repository scope, do not assume it exists. Report the race boundary and preserve an explicit operational limitation; do not assert a complete atomic pause guarantee.
- Separate passive cold-proof reads/recording from new external effects. A pause/freeze must never suppress or falsify evidence that an already-executed cold transfer succeeded. Under freeze, preserve canonical proof and make the broadcast/ledger partial state explicit and recoverable; defer only the ledger mutation the freeze is intended to stop. A new transaction submit is an external effect and remains fenced.

## Files and Ownership

- `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/payouts/usdc-safety-guards.ts`: safety read helper/error behavior.
- `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/payouts/turnkey-signer.ts`: signing-boundary checks (shared with phase 2; serial).
- `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/payouts/broadcast-recovery-machine.ts`: all new external-effect fences (shared with phase 2; serial).
- `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/payouts/settlement-reconciler.ts`: reconciliation effects only if effect inventory finds uncovered paths.
- Existing narrow treasury tests; no concurrent edits to these files.

## Implementation Steps

1. Enumerate each effect site and its caller/control flow; record whether it signs, sends, re-sends cached bytes, performs chain-read only, or mutates ledger state.
2. Add/compose a single fail-closed pause+freeze gate invoked at the last safe local boundary before signing or new submit/rebroadcast, covering initial settlement, recovery, and RBF; avoid duplicate policy implementations.
3. Preserve cold proof and the unique proof claim under freeze; do not rewrite confirmed transfers as cancelled or treat a missing receipt as proof of cancellation. Fence each entire applicable D1 ledger batch (lock/finalize/revert) atomically against freeze, not just one statement: if freeze commits first, no postings persist. Keep a confirmed withdrawal `INFLIGHT` until thaw, then reconcile exactly once.
4. Disable implicit retries for external sends or require independent admission for every real retry. Inspect the retry default (`src/lib/payouts/rpc/json-rpc-client.ts:104,123`) and EVM send site (`src/lib/payouts/adapters/arbitrum-base-usdc-adapter.ts:761-766`), and verify transport-internal retries in the other rails. Preserve late results for the owning attempt without authorizing another effect or letting them overwrite newer state. If surfacing operational stop status, distinguish committed admission closure from drained application sends; do not report drained until atomically proven. Expiry or missing responses do not prove a worker stopped. Never re-sign, reassign a nonce/sequence, release exposure or refund uncertain funds on that basis.
5. Add deterministic tests that flip pause/freeze at each async boundary (after initial validation, after claim, before signer, during signer, after signer/before broadcast, after send, during cold evidence/claim/ledger finalize) and assert accurate state/retry outcomes.
6. Record residual race windows and any provider/Turnkey enforcement not proven in source as limitations, not closed criteria.

## Data Flow

Request/recovery record → policy and chain checks → durable workflow ownership pinned to the initial safety epoch → conditional one-shot D1 admission for each signing or submission effect → Turnkey or RPC call → persist the outcome and reconcile chain truth and ledger separately. Missing or unconfirmed admission denies the effect. A stop committed after admission cannot revoke an in-flight request and may not stop an admitted request that has not yet reached the provider. Admission closure therefore does not satisfy the original absolute no-new-provider-call criterion. Passive receipt and cold-proof handling do not use new-effect admission.

## Test Matrix

Unit: pause/freeze true, false, absent, duplicated, malformed and D1 read failure; every effect boundary; no new Turnkey/RPC invocation when blocked. Integration: interleave async hooks to raise flag between steps; recovery preserves same nonce/payload; no duplicate send/refund; pause after send records uncertain state; reconcile confirmed chain truth with ledger freeze. E2E: route dispatch/recovery and passive reconciler on mock transports with operation call counters; all flags remain isolated fixture data.

## Success Criteria

- For every external invocation, prove pause-before-grant denies admission and pause→resume does not revive stale claims. Explicitly test that a previously admitted request can reach the provider after the final check, without authorizing a later send or retry. Prove passive proof persists during freeze while no ledger postings commit.
- Gate failures are observable and leave a retryable, non-duplicating state.
- Plan, code, tests and reports explicitly state no D1-to-Turnkey/RPC atomicity and no claim that last-read eliminates the race.
- No changes to live pause/freeze flags or production systems.

## Risk, Rollback, and Dependencies

High likelihood/impact: a listed effect path is missed or durable signed bytes bypass new signing guard. Mitigation: grep all `sign*`, `broadcastSignedTransaction`, `submitSignedTransaction`, and cached signed-transaction send sites after change, then trace each caller; tests assert transport call counts. High: overly broad gating can strand funds whose chain transaction already succeeded. Mitigation: distinguish new external effect from read-only confirmation/reconciliation and preserve chain truth. Roll back application changes only if invariants regress; keep additive migration data, retain pause settings and stop payout actions.

## Next Steps

Phase 4 starts only after all production effect paths and safety races have been reviewed and focused regressions pass.
