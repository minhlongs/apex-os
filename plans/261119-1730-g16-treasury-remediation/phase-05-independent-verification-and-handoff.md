---
title: "Phase 5: Independent Verification and Handoff"
status: todo
---

# Phase 5: Independent Verification and Handoff

## Overview

Complete five independent, non-implementing reviews, the distinct G16 owner packets 25–29, exact local CI-equivalent checks, honest case/evidence accounting, and a safe handoff to the existing draft PR #56 only after verified trigger safety. This phase performs no deployment or live treasury operation.

## Requirements and Dependencies

- Depends on complete phases 1–4 and all red regressions green.
- Five independent reviewers produce separate files `review-A-cold-proof.md`, `review-B-safety-fencing.md`, `review-C-exposure-migration.md`, `review-D-ledger-dust-reserves.md`, and `review-E-security-trigger-safety.md` in this plan’s `reports/` subdirectory, with distinct lenses: (A) canonical chain proof/uniqueness; (B) pause/freeze effect fencing and race limits; (C) exposure cap/migration/data; (D) ledger partial recovery, dust and reserves; (E) security, route compatibility, deployment trigger safety and scope. Reviewers do not implement.
- Resolve every blocker with code/test evidence, or leave explicitly blocking status. Do not suppress review disagreement.
- The original user request is authoritative for COLD01–10, PAUSE01–10 and CAP01–14 definitions. The coordinator has that contract; transfer its exact wording into the case ledger and map every assertion to red/green evidence before signoff. Absence from report 24 is not evidence that requirements are missing. Do not invent numbered meanings from abbreviated context.
- Exact checks mirror `.github/workflows/ci.yml:21-57`: Node 26.7.0, `npm ci`, `bash scripts/assert-staging-isolation.sh`, `npm run typecheck`, `npm run lint`, `CI=true npm test`, and `npm run build:worker` with documented non-secret build inputs. Preserve each command's true exit status. No deploy workflow (`deploy.yml:1-19` is `workflow_dispatch`) is run.

## File Ownership

- Preserve report 24 baseline. Produce the separately scoped G16 owner packets 25–29 under `/Users/macbook/apex-os-worktrees/phase2-ascendancy/plans/reports/ascendancy-p2/` as dictated by the original task; keep their packet identities distinct from the five named A–E reviews in this plan’s `reports/`. Do not create or label reviews as report numbers 25–29. Each A–E reviewer owns only its separately named review in the plan `reports/` and no implementation files.
- Final plan updates are limited to this plan directory.
- Implementation/report changes are not parallelized against shared source.

## Case Mapping Checklist

For every identifier below, fill in only when source test contract/evidence verifies the exact behavior; otherwise mark the evidence mapping as pending and block G16 verification signoff.

| Family | IDs to map | Required evidence |
|---|---|---|
| Cold proof/claims | COLD01–COLD10 | Test name, asserted chain proof/claim/retry behavior, red baseline result, green post-fix result |
| Pause/freeze | PAUSE01–PAUSE10 | Exact effect boundary, flag/read failure interleave, no-effect or recoverable-state assertion, red and green result |
| Exposure/cap | CAP01–CAP14 | Exact state/age/window/concurrency/legacy/dust/reserve behavior, numeric boundary, red and green result |

### Individual case evidence ledger

Nguồn / Sources: [baseline](../reports/ascendancy-p2/g16-baseline-regressions.txt), [integrated run: 117 passed, 7 filtered](../reports/ascendancy-p2/g16-dust-cold-combined.txt), and [cold test source map](../reports/ascendancy-p2/25-COLD-SETTLEMENT-PROOF-BINDING.md). Distinguish an original red regression from a passing baseline control or a new post-fix check; none of the latter are represented as pre-fix failures. / Phân biệt ca đỏ gốc, ca đối chứng đã đạt trước sửa và ca chỉ chạy sau sửa.

| Ca / Case | Trước sửa / Baseline | Sau sửa / Integrated evidence |
|---|---|---|
| COLD-01 | Missing-transfer regression failed. | Successful receipt with no logs and wrong-recipient checks deny confirmation. |
| COLD-02 | No exact $300 unrelated-transaction case in the initial run. | `rejects unrelated transaction without consuming a proof or changing the lock` uses the $300 fixture and preserves the lock. |
| COLD-03 | Same transaction accepted for a second payout; baseline could not identify operations. | `does not allow one confirmed operation to settle two cold payouts across service instances`. |
| COLD-04 | Wrong-asset control passed. | `rejects wrong USDC asset without consuming a proof or changing the lock`. |
| COLD-05 | Wrong-amount control passed. | `rejects wrong amount without consuming a proof or changing the lock`, also Stellar `one extra stroop`. |
| COLD-06 | Not in the initial run. | `rejects wrong source despite correct recipient without consuming a proof or changing the lock`. |
| COLD-07 | Not in the initial run. | Distinct log IDs in EVM; `attributes distinct Stellar operations in one hash and rejects reusing an operation for another $300 payout`. |
| COLD-08 | Not in the initial run. | `rejects another network without consuming a proof or changing the lock`, also wrong Horizon network. |
| COLD-09 | Recipient-only regression failed. | Recipient-only metadata, missing indices and duplicate log IDs are denied. |
| COLD-10 | Not in the initial run. | `coalesces concurrent confirmations for the same payout across service instances` and `resumes after ledger commit before broadcast confirmation and replays a lost response without duplicate postings`. |


### PAUSE evidence checkpoint / Đối chiếu bằng chứng PAUSE

[Candidate log](../reports/ascendancy-p2/g16-t02-adjacent-aligned.txt) records the isolated helper suite passing. The counterpart test names are in [the candidate patch](../reports/ascendancy-p2/g16-t02-incremental.patch). This is not an integrated result or an absolute provider-side stop guarantee. / Đây là bằng chứng ở worktree riêng, chưa phải nghiệm thu bản tích hợp hoặc bằng chứng đã dừng được tác vụ phía nhà cung cấp.

| Ca / Case | Bằng chứng hiện có và phần thiếu / Current evidence and remaining gap |
|---|---|
| PAUSE-01 | Active pause before recovery blocks raw rebroadcast and retains the signed nonce in the candidate. |
| PAUSE-02 | A pause between recovery start and signing admits no Turnkey call in the test. The original red direct-signer tests did not establish this exact interleave. |
| PAUSE-03 | A signature completing before the pause does not authorize initial submission afterward in the test. |
| PAUSE-04 | A flag flip while building the replacement blocks admission to RBF signing. |
| PAUSE-05 | The completed RBF signature can be recorded; a new submission is denied when pause precedes its admission. |
| PAUSE-06 | The raw rebroadcast already admitted returns late without a second request. **Open:** denial of provider calls already admitted when the stop is committed. |
| PAUSE-07 | Ledger freeze alone blocks direct signing and submission; the independent journal-control checks used the integrated pre-fence baseline. |
| PAUSE-08 | The helper deadline and production-path unreadable-control tests deny admission; final path verification is pending. |
| PAUSE-09 | Passive receipt reconciliation during pause is exercised. The ledger lifecycle fixture separately verifies no ledger refund write before freeze is lifted. |
| PAUSE-10 | Concurrent direct-signer case admits one request before pause. **Open:** the absolute no-new-provider-call requirement, including contenders and an admitted callback. |

Each unchecked entry means its **red→green evidence mapping is pending**, not that the user requirement is missing or that a test passed. The user request is authoritative for case intent; attach the matching test name and red/green logs before checking it.

- [ ] COLD01
- [ ] COLD02
- [ ] COLD03
- [ ] COLD04
- [ ] COLD05
- [ ] COLD06
- [ ] COLD07
- [ ] COLD08
- [ ] COLD09
- [ ] COLD10
- [ ] PAUSE01
- [ ] PAUSE02
- [ ] PAUSE03
- [ ] PAUSE04
- [ ] PAUSE05
- [ ] PAUSE06
- [ ] PAUSE07
- [ ] PAUSE08
- [ ] PAUSE09
- [ ] PAUSE10
- [ ] CAP01
- [ ] CAP02
- [ ] CAP03
- [ ] CAP04
- [ ] CAP05
- [ ] CAP06
- [ ] CAP07
- [ ] CAP08
- [ ] CAP09
- [ ] CAP10
- [ ] CAP11
- [ ] CAP12
- [ ] CAP13
- [ ] CAP14

## Implementation Steps

1. Confirm branch is `feat/ascendancy-phase2-verified`, PR #56 remains the existing draft and source changes are limited to G16. Recheck current git status, HEAD, PR head, and CI/deployment trigger configuration at handoff time.
2. Run exact CI checks with unmasked exit status and capture report/command/Node version. Do not deploy, run workflow_dispatch, access remote D1, use live RPC, enable flags, or use live keys.
3. Have five reviewers inspect the final source diff, tests, additive migration and data-flow invariants independently; create separate A–E review files, complete the distinct remediation/owner packets 25–29, and disposition every finding.
4. Populate the case map from the user-provided case contract and test-agent log; enumerate missing test/evidence mappings without labeling requirements absent from report 24 as missing requirements.
5. Verify migration is additive and tracked under repository ignore allowlist if required; inspect SQL against local fixture only. Preserve manual D1 migration/deployment separation.
6. Re-grep and trace every signer, broadcast, rebroadcast, RBF, cold proof and ledger-finalization call site. Confirm no pause/freeze atomicity assertion exceeds actual guarantee.
7. Recheck CI and deploy triggers; do not dispatch deploy. If and only if all local tests/reviews/evidence/trigger checks pass, hand verified changes to the owner for a focused conventional commit and push to existing draft #56; subsequently require remote CI at that exact final SHA before handoff/merge. No new branch/PR or merge authorization is implied.
8. Record unresolved production-side evidence: multisig/reserve attestations, real-provider payload confirmation, remote schema status and operational approval remain outside authorized scope and prevent declaring production readiness.

## Test Matrix

- Unit: all red regressions, cap/dust/reserve boundaries, exact proof parsers, unique claim and safety gates.
- Integration: isolated D1 migration and writes, cross-isolate-style concurrent claims, each partial recovery checkpoint, mocked external transport call counts, canonical chain evidence fixtures.
- End-to-end: authenticated dispatch and recovery route contract, passive reconciler outcomes, retry after response loss, flag freeze, existing workflow/API compatibility.
- CI: all seven commands above pass with normal output and true exit status; no skipped treasury tests.

## Success Criteria

- Five independent A–E reviews and distinct user-mandated packets 25–29 exist, evidence-linked, with blocking findings resolved or explicitly blocking.
- Every numbered case COLD01–10, PAUSE01–10, CAP01–14 is listed; exact expected behavior is either mapped to evidence or honestly marked missing. No G16 PASS with missing case contract.
- Typecheck, lint, tests, worker build and staging-isolation check all pass on Node 26.7.0; reproducible command logs exist.
- Draft PR #56 is updated only after all gates pass; deploy workflow remains undispatched, remote/real-money systems untouched and treasury production PASS/attestation absent.

## Risk, Rollback, and Stop Conditions

High likelihood/impact: CI green while a failure case is missing, test status masked, or a reviewer shares implementer assumptions. Mitigate with exact case ledger, independent reviewers, unpiped exit status and source/flow trace. High: deploy may be mistakenly triggered from a draft push; verify current workflow events and refs, and stop rather than push if trigger safety cannot be proven. High: migration or route behavior may diverge from production; no remote apply or production claim. On any failed gate, do not push. Roll back only application source if required, keep additive schema/claims intact, and keep flags/deployment state unchanged.

## Next Steps

Once verified handoff is accepted, the next actor may review and approve the existing draft PR through repository governance. Deployment and operational production attestation require separate explicit authorization.
