---
title: "Phase 07 — Production Cutover Readiness, Historical Payout Reconciliation & G0 Root Hygiene"
description: "Deliver Phase 07 historical payout reconciliation audit module and CLI script, docs/cutover-runbook.md, docs/project-changelog.md, docs/operational-runbook.md gate doctrine, and clean G0 root workspace."
status: completed
priority: P1
effort: 4h
issue: 5
branch: feat/phase-07-cutover-readiness
tags: [go-live, phase-07, reconciliation, cutover, runbook, hygiene]
created: 2026-10-26
---

# Phase 07 — Production Cutover Readiness, Historical Payout Reconciliation & G0 Root Hygiene

## Guiding Thesis & Decisions

1. **Mandatory Pre-Flight Historical Payout Reconciliation (F1)**: Before any production cutover, all existing `payouts` and `earnings` rows must be audited read-only for fabricated transaction IDs (such as `MOCK_SIGNED_TX_PAYLOAD`, synthetic deterministic hashes from legacy Solana/EVM adapters, or completed payouts missing a valid `transaction_id`, as well as `earnings` rows with `is_paid = 1` and `payout_id IS NULL`).
2. **Read-Only Audit Guarantee**: The reconciliation engine (`src/lib/payouts/reconcile-historical-payouts.ts` and `scripts/reconcile-historical-payouts.ts`) never mutates or deletes payout or earnings rows — it classifies anomalies and outputs a structured report for founder sign-off.
3. **Cutover & Gate Doctrine (F2–F6)**:
   - `docs/cutover-runbook.md` documents the T-1h → T+first-payout sequence, mandatory reconciliation pre-flight, manual-first `AUTO_SETTLE_PAYOUTS=false` verification, and abort/rollback criteria.
   - `docs/operational-runbook.md` adds the mandatory "Gate on Every Production Deploy" (`npm run gate`) doctrine and pinned `wrangler` (`./node_modules/.bin/wrangler`) deployment/rollback commands.
   - `docs/project-changelog.md` records the `v1.5.0` Go-Live release, SHA, and G0–G5 gate verification.
4. **Root Workspace G0 Hygiene**:
   - Synchronize `/Users/macbook/apex-os` with `origin/master`, archive untracked root `.md` files (`ORIGINAL_REQUEST.md`, `AGENTS.md`, `design-system/*.md`) into `docs/`, and prune merged temporary worktrees.

## Milestones

- [x] **Milestone 1: Historical Payout Reconciliation Engine & Unit Tests**
  - Create `src/lib/payouts/reconcile-historical-payouts.ts` with pure classification + read-only D1/SQLite query runner.
  - Create `src/lib/payouts/__tests__/reconcile-historical-payouts.test.ts` testing detection of `MOCK_SIGNED_TX_PAYLOAD`, missing `transaction_id` on completed payouts, non-Stellar completed payouts from legacy mock adapters, and orphaned `is_paid = 1` earnings with `payout_id IS NULL`.
  - Create `scripts/reconcile-historical-payouts.ts` CLI wrapper and add `"reconcile:payouts"` script to `package.json`.
- [x] **Milestone 2: Phase 07 Documentation (`cutover-runbook.md`, `operational-runbook.md`, `project-changelog.md`)**
  - Create `docs/cutover-runbook.md` (bilingual VN/EN).
  - Create `docs/project-changelog.md` recording `v1.5.0` Go-Live release.
  - Update `docs/operational-runbook.md` with Gate-on-Every-Deploy doctrine and updated OpenNext Cloudflare Workers commands.
  - Update `plans/261020-zero-bug-go-live/phase-07-production-cutover-and-post-launch-watch.md` and `plans/261020-zero-bug-go-live/plan.md` statuses.
- [x] **Milestone 3: Verification, PR & Merge (`--ship`)**
  - Run `npm run typecheck`, `npm run lint`, `CI=true npm test`, `npm run build:worker`, and `GATE_SHA=$(git rev-parse HEAD) npm run gate`.
  - Open PR, verify CI green, merge into `master`, and close the tracking GitHub issue.
- [x] **Milestone 4: Root `/Users/macbook/apex-os` Synchronization & G0 Hygiene**
  - Archive untracked `.md` files outside `plans/` and `docs/` in `/Users/macbook/apex-os`, fast-forward `master` to `origin/master`, and clean up merged worktrees.
