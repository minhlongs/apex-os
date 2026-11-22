---
title: "G16 Treasury Remediation"
description: "Close treasury cold-proof, live safety fencing, and exposure-cap gaps with red-first tests and gated verification."
status: in_progress
priority: P1
effort: 40h
branch: feat/ascendancy-phase2-verified
tags: [bugfix, backend, database, api, critical]
blockedBy: []
blocks: []
created: 2026-11-19
---

# G16 Treasury Remediation

## Overview

Remediate the full confirmed G16.0–G16.7 treasury scope, starting with the separately owned failing regressions; retain global hot-wallet exposure controls, prove cold settlement from canonical chain evidence, fence every irreversible effect against current safety state, and audit dust/reserves without weakening existing policy. No deployment, real RPC, live signing keys, remote migration, or production flag change is authorized.

## Phases

| Phase | Name | Status | Dependency |
|---|---|---|---|
| 1 | [Red regressions and evidence handoff](./phase-01-red-regressions-and-evidence.md) | Completed: initial 13-case baseline, 10 failed / 3 passed; full case mapping still required | Baseline report 24 and preserved source/log |
| 2 | [Cold proof and durable claims](./phase-02-cold-proof-and-claims.md) | Schema and dispatch source reviews complete. Integrated runs: 92 focused cases passed, 7 filtered; Track A and adjacent suites passed 26 cases after fixture alignment. Shared-file handoff complete; final mandate gates still open. / Đã kiểm chứng bộ kiểm thử tập trung và bàn giao tệp dùng chung; chưa đạt toàn bộ điều kiện. | [Schema disposition](./reports/review-A-schema-disposition.md), [dispatch disposition](./reports/review-A-dispatch-disposition.md) |
| 3 | [Live safety fencing](./phase-03-live-safety-fencing.md) | Integrated locally: 188/191 adjacent checks passed; all three failures are T‑03. Verified EVM failure requires canonical finality; Stellar expiry alone stays unresolved. Historical terminal refund eligibility and the absolute provider-call criterion remain open. / Đã tích hợp cục bộ, chưa nghiệm thu dừng tuyệt đối hoặc hoàn tiền cho các bản ghi lịch sử. | Shared files handed to T‑03; final review pending |
| 4 | [Exposure cap, dust, and reserve audits](./phase-04-exposure-cap-and-reserve-audits.md) | Dust lifecycle expanded: 24/24 locally; offline unsigned Stellar XDR: 4/4 locally; independent Review D follow-up: 28/28 passed. Reserve/multisig remain open; T‑03 awaits shared-file handoff. / Đạt vòng đời mô phỏng và XDR chưa ký; chưa đóng G16.4. | Phase 3; preserve global aggregate cap and historical ambiguity conservatively |
| 5 | [Independent review, CI, and draft PR handoff](./phase-05-independent-verification-and-handoff.md) | Pending | Phases 1–4; five independent reviewer reports |

## Acceptance Criteria

- Cold resolution for Stellar and EVM is based on canonical, successful transaction evidence containing the exact expected USDC asset, recipient, and amount; each on-chain operation can be claimed exactly once durably, with recovery from partial D1/ledger completion.
- Every new signing, first broadcast, rebroadcast, and RBF effect has a fail-closed current safety fence. Passive cold-proof reads/recording continue under pause; freeze-blocked ledger mutation remains recoverable. Document residual D1-to-external-effect races honestly; do not claim a final read makes D1 and Turnkey/RPC atomic.
- Exposure is bounded by an additive-schema, durable global outstanding-plus-confirmed policy that does not make unresolved transactions disappear with age. Existing ambiguous confirmed rows count conservatively. Dust and chain reserve behavior is auditable and tested.
- Required test-first red evidence passes after remediation. All five independent reviews have dispositioned findings. Exact CI-equivalent checks pass: `npm run typecheck`, `npm run lint`, `CI=true npm test`, `npm run build:worker` under Node 26.7.0.
- No new payout route or live operation is introduced. Existing API contracts, `AUTO_SETTLE_PAYOUTS=false`, and `V1_STELLAR_ONLY_PAYOUTS=true` remain unchanged. No production PASS, deployment, or real-money authorization is implied.

## Evidence and Sequencing

Baseline and defect evidence: [report 24](../reports/ascendancy-p2/24-TREASURY-P0-BASELINE.md). Use isolated SQLite fixtures and mocked signing/RPC only. The existing test-only agent owns red tests and its execution log; implementation waits for those fail-before-fix cases. Then implement cold claims, live fencing, and cap/reserve changes in sequence because the recovery machine and signer are shared hot paths. Reports 25–29 are the user-mandated remediation/owner packets, not reviewer reports; five independent A–E reviews use separate named files. Preserve the existing draft PR #56 and its trigger-safety boundary; after local verification and trigger safety checks, commit/push narrowly to that existing draft, then require remote CI at the final pushed SHA before handoff/merge. Do not dispatch deployment workflows.

## Rollback

No remote migration is authorized. Local rollback means reverting application code while leaving the additive migration/schema objects in place; never drop claims or exposure data as rollback. If any safety, uniqueness, evidence, ledger-recovery, or cap invariant fails, stop the sequence, keep all payout/deploy flags disabled, preserve evidence, and do not push. Production remains untouched by this plan.
