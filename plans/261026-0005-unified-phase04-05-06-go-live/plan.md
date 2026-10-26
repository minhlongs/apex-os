---
title: "ApexOS Unified Phase 04+05+06 Go-Live Pipeline"
description: "Unify BatchSettlementService as single payout authority, fix executeBatch unconfirmed transaction_id loss, wire AUTO_SETTLE_PAYOUTS manual-first gate, integrate fail-closed Stellar mainnet guard, deploy pipeline with staging D1 isolation, clean tree G0, and verify G0..G5 gates."
status: completed
priority: P0
effort: 8h
issue: 3
branch: feat/phase-04-05-06-unified-go-live
tags: [go-live, money-movement, deploy, pipeline, security, compliance]
created: 2026-10-26
---

# ApexOS Unified Phase 04+05+06 Go-Live Pipeline

## Guiding Thesis & Decisions

1. **Single Payout Authority**: `BatchSettlementService.executeBatch()` is the sole settlement engine across `/api/cron?job=payouts`, `POST /api/payouts`, and `worker-wrapper.js` (which delegates via authenticated fetch with `CRON_SECRET`).
2. **Double-Spend Prevention**: In `src/lib/payouts/batch-settlement-service.ts`, the unconfirmed `!isSettled(verdict)` branch records `transaction_id = ?` (`execRes.transactionId ?? null`) so `retryPayout` re-verifies on-chain instead of broadcasting duplicate transfers.
3. **Rollout Control**: Default `AUTO_SETTLE_PAYOUTS=false` prevents auto-broadcast during initial deployment. First payout is triggered manually by admin (`POST /api/payouts`) and verified.
4. **Fail-Closed Chains**: Solana and Ethereum remain fail-closed (`success: false`). Stellar USDC fails closed if `STELLAR_NETWORK` is unset in production (`NODE_ENV === 'production'` or `APP_ENV === 'production'`).
5. **Accurate Explorer URLs**: `src/lib/payouts/receipts.ts` dynamically resolves `STELLAR_NETWORK` (Mainnet uses `public`, Testnet uses `testnet`).
6. **Deploy Pipeline & Staging Isolation**: `wrangler.staging.jsonc` isolates `apex-os-staging-db` (`be4ed659-c877-4820-ae6e-9747bc7ee316`) with zero references to prod D1 (`3436aa7d-3065-4103-96e1-ddbd8b372246`). `scripts/assert-staging-isolation.sh` asserts this pre-deploy.
7. **Tree Hygiene (G0)**: Untracked `.md` files outside `plans/` and `docs/` are archived or cleaned.

## Phases & Milestones

- [x] **Milestone 1: Money Core & BatchSettlementService Fixes**
  - Fix `executeBatch` in `src/lib/payouts/batch-settlement-service.ts`: bind `transaction_id = ?` on `!isSettled(verdict)`.
  - Fix `src/lib/payouts/batch-settlement-service.ts:432`: replace float `const fee = 0.0` with exact minor units.
  - Consolidate `UPDATE earnings SET is_paid = 1` into a single private helper inside `batch-settlement-service.ts` callable only when `isSettled(verdict) === true`.
  - Fix `src/lib/payouts/receipts.ts` to read `STELLAR_NETWORK` and generate `public` explorer URLs for mainnet.
  - Add `AUTO_SETTLE_PAYOUTS` manual-first check to `/api/cron?job=payouts`.
- [x] **Milestone 2: Worker-Wrapper Delegation & Stellar Guard**
  - Refactor `worker-wrapper.js` `handlePayoutCron` to delegate to `/api/cron?job=payouts` with `Authorization: Bearer ${env.CRON_SECRET}` instead of running inline raw SQL loops.
  - Implement `resolveStellarNetwork()` in `src/lib/payouts/stellar-service.ts` and integrate into `StellarAdapter`.
  - Set `STELLAR_NETWORK=mainnet` and `AUTO_SETTLE_PAYOUTS=false` in `.env.production.example`.
- [x] **Milestone 3: Deploy Pipeline, Staging Isolation & /api/version**
  - Integrate `/api/version` (`src/app/api/version/route.ts` & unit test).
  - Clean `next.config.js` dead `expo-router` alias.
  - Pin `"wrangler": "4.152.0"` in `package.json` with `build:worker`, `deploy:staging`, `deploy:production`, `verify:deploy` scripts.
  - Add `wrangler.staging.jsonc`, `scripts/assert-staging-isolation.sh`, `scripts/smoke-protected-routes.sh`, `scripts/verify-deployment.sh`, and `.github/workflows/{ci,deploy}.yml`.
  - Add `scripts/go-live-gate.sh` with G0..G5 checks.
- [x] **Milestone 4: Verification & Shipping**
  - Run Node 26.7.0 quality gates: `tsc --noEmit`, `eslint`, `CI=true npm test`, `npm run build:worker`.
  - Run `bash scripts/go-live-gate.sh`.
  - Push branch `feat/phase-04-05-06-unified-go-live`, open PR linked to issue #3, and execute `--ship`.
