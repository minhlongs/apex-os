---
title: "Zero-Bug Go-Live — ApexOS"
description: "Risk-first phased plan to take ApexOS from green-tests-but-unshipable to a verified, irreversible-safe production go-live."
status: in_progress
priority: P1
effort: 48h
branch: master
tags: [go-live, ci, type-safety, deploy, money-movement, compliance]
created: 2026-10-20
---

## Guiding Thesis

> **Progress (2026-10-21):** Phase 03 complete — working tree committed in 5 commits. **P0-6 and P0-7 fixed.** The weekly payout cron never fired at all (three disagreeing cron strings; Cloudflare's Quartz rules made both the old forms wrong), and the cron routes failed open when the secret was missing. Schedules are now defined once and shared, and the worker's cron dispatch is authenticated. `wrangler.toml` deleted in favour of the JSON config that OpenNext requires, with a deploy-time guard. Gates: `tsc` 0, `eslint` 0, **129 suites / 3189 passed / 0 failed**.

> **Progress (2026-10-20):** Phase 01 complete — Node 26 pinned via `.nvmrc` + `engines` + a `pretest` guard; `npm test` now refuses to run on an incompatible runtime instead of producing 443 false failures. Phase 02 complete — all three type bypasses removed (`package.json`, `next.config.js`, `tsconfig.json` `strict: true`), `src/lib/earnings/**` brought inside the gate, the dead `src/app/api/admin/health` exclusion dropped, and 113 strict errors fixed to **0**. Gates now: `tsc --noEmit` exit 0, `eslint --max-warnings 0` exit 0, **128/128 suites / 3185 passed / 0 failed**. Hygiene held: `:any` 221→220, suppressions 61→61.

ApexOS is NOT merely unverified — it contains **five P0 defects that make money move incorrectly**. 128 suites / 3186 tests are green, which is precisely why this is dangerous: the suite has already proven it cannot catch these.

1. **The type gate is inert in THREE places.** `build` = `NEXT_DISABLE_TYPE_CHECK=1 next build` (`package.json:7`) AND `next.config.js:7` `typescript.ignoreBuildErrors: true` AND `tsconfig.json:16` `"strict": false`. Measured: `tsc` passes today but `tsc --strict` reports **113 errors**. Additionally `src/lib/earnings/**` is excluded from type-checking (`tsconfig.json:61`).
2. **The build artifact on disk is stale — it proves nothing about today's code.** `.open-next/worker.js` (2.3 KB) and `.open-next/.build/` bundles *do* exist, so the project has been built before. But they date to **Aug 10 2026** (some parcels Jul 20) while `batch-settlement-service.ts` and `solana-adapter.ts` are **Sep 28** — ~8 weeks of divergence. Proof, not just age: the stale bundle lacks `MOCK_SIGNED_TX_PAYLOAD`, which today's `solana-adapter.ts:214` contains. The current tree has never been built; regenerate before treating the bundle as evidence.
3. **Seven P0 defects (see below).** Five move money incorrectly; two more silently stop money moving (a cron that never matches, and a publicly-callable cron endpoint). All seven hard-block Phase 06.
4. **Two wrangler configs coexist** (`wrangler.toml` vs `wrangler.jsonc`) with conflicting `compatibility_date`/flags; only `.jsonc` has the required `assets` block. Staging and prod D1 are bound in the *same* config.
5. **Money is float end-to-end** (D1 `REAL` columns; float `reduce` accumulation; `toFixed` fees) and **Sentry is dead** (no `instrumentation.ts`, zero import sites).

Phases are ordered **maximum risk reduction first**: environment determinism → type integrity → work committed → money/compliance hardening → deploy pipeline + rehearsal → final gate → cutover.

## The Five P0 Money Defects

Each makes money move incorrectly. All five are the top of `phase-04`'s worklist and hard-block `phase-06` (G4a–G4e). Two further P0s (P0-6, P0-7) live in the deploy/config surface and also hard-block the gate. Each is additionally a **regression-testability gap**: the current suite already proved it cannot catch P0-1, because its tests never import the real route handler and the `Request` mock allows repeatable body reads. Detail, file:line, and fix order are in `phase-04`.

- **P0-1 Webhook double body-read** — `request.json()` before `request.text()`, so HMAC is verified over an empty stream. All three exchange routes. Result: 100% of exchange webhooks rejected, i.e. zero conversions/earnings/payouts. Correct reference already in-repo at `src/app/api/webhooks/ipn/route.ts:123` (read text, verify, then parse).
- **P0-2 Solana adapter broadcasts a constant string** — the literal `'MOCK_SIGNED_TX_PAYLOAD'`, and on RPC throw it fabricates a base58 signature from payout metadata. No signer, no keypair, `buildSPLTransferData` exported but never called. Returns `success: true`.
- **P0-3 Ethereum adapter fabricates a transaction hash** — the `catch` block computes `keccak256(metadata)` as `transactionHash` and returns `success: true`. The configured `privateKey` is read once and never used, so this catch is the *expected* production path.
- **P0-4 "submitted" treated as "confirmed"** — earnings are flipped to `is_paid = 1` on `execRes.success` alone, with no `router.verifyTransaction` call. `retryPayout:1403` does verify; only `executeBatch` does not. This is what turns P0-2/P0-3 from cosmetic into money-losing.
- **P0-5 Raw float money at ingestion** — IEEE-754 written straight to `earnings.amount` across the exchange webhook and the parser module, plus a third hardcoded tier split (`0.30`) and a hardcoded `fee = 0.0`.
- **P0-6 The weekly payout cron never fires** — `wrangler.jsonc:41` schedules `"0 0 * * 7"`, but `worker-wrapper.js:52` dispatches on the literal string `'0 0 * * 0'`. Cloudflare passes the *configured* schedule via the `cf-cron-schedule` header (`worker-wrapper.js:41`), so the strings never match and the payout branch falls through to `'Unknown cron schedule'`. `wrangler.toml:37` disagrees again (`0 0 * * 0`), so the config files conflict with each other *and* with the dispatcher. Net effect: payouts silently never run — no error, no alert. Fix: one canonical schedule constant shared by config and dispatcher, plus a test that dispatches on every configured schedule string.
- **P0-7 `/api/cron` fails open when `CRON_SECRET` is unset** — `src/app/api/cron/route.ts:346` is `if (cronSecret && authHeader !== ...)`, so with the secret absent the guard is skipped and the endpoint — including `job=payouts` — is publicly callable. Same fail-open at `src/app/api/monitoring/retention/route.ts:18`. `CRON_SECRET` appears in neither `.env` example, which is exactly how production would end up fail-open. Fix: fail closed (reject when unset or mismatched) and document the variable.

## Phase Index

| # | Phase File | Priority | Effort | Blocks |
|---|------------|----------|--------|--------|
| 01 | [phase-01-environment-pin-and-determinism.md](./phase-01-environment-pin-and-determinism.md) | P1 | 3h | 02, 03 |
| 02 | [phase-02-restore-type-check-gate.md](./phase-02-restore-type-check-gate.md) | P1 | 5h | 06 |
| 03 | [phase-03-commit-uncommitted-work-and-collapse-config-drift.md](./phase-03-commit-uncommitted-work-and-collapse-config-drift.md) | P1 | 2h | 05 |
| 04 | [phase-04-money-movement-and-compliance-correctness.md](./phase-04-money-movement-and-compliance-correctness.md) | **P0** | 16h | 06, 07 |
| 05 | [phase-05-deploy-pipeline-staging-rehearsal-and-rollback.md](./phase-05-deploy-pipeline-staging-rehearsal-and-rollback.md) | P1 | 10h | 06 |
| 06 | [phase-06-final-go-live-gate-and-verification.md](./phase-06-final-go-live-gate-and-verification.md) | P1 | 8h | 07 |
| 07 | [phase-07-production-cutover-and-post-launch-watch.md](./phase-07-production-cutover-and-post-launch-watch.md) | P2 | 4h | — |

All phases: status `pending`.

## Phase Summaries

- **01** — Pin Node 26.7.0 (`.nvmrc` + `engines` + `pretest` guard). Kills the 443 false test failures and makes the green baseline reproducible.
- **02** — Remove all three type bypasses; fix 113 strict errors; un-exclude `src/lib/earnings/**`; run the first real `next build`.
- **03** — Commit the 14 uncommitted entries; untrack `tsconfig.tsbuildinfo`; delete `wrangler.toml` (keep `.jsonc`, which alone has the required `assets` block).
- **04** — **Five P0 money defects** (webhook body-read, Solana mock broadcast, Ethereum fabricated hash, unverified payment, float ingestion) top of worklist, then `src/lib/money/*` minor-unit module, tier-split conservation, payout idempotency, KYC gate.
- **05** — Build the first deploy pipeline (`opennextjs-cloudflare build`/`deploy`); pin `wrangler` and regenerate the stale `.open-next` bundle; isolate staging D1; add `/api/version`; smoke-test protected routes; **rehearse rollback**.
- **06** — `scripts/go-live-gate.sh`: one verdict, G0–G5, with **G4a–G4g hard-blocking on the five P0s and on unanswered decisions**.
- **07** — Execute cutover outside the weekly payout window; **reconcile pre-existing fabricated payouts**; watch; manually verify the first payout run.

## Decisions Requiring The User (Phase 06 G4f HARD-FAILS if unanswered)

These are product calls with money consequences. The plan does not assume them.

- **D1 — Is Solana/EVM payout LIVE at go-live, or fail-closed / feature-gated?** Current state is the worst of both: mock broadcast + fabricated hash, both returning `success: true`, so users are marked paid for transfers that never happened.
  - **(a) Fail closed / feature-gate now**, ship Stellar only. Recommended for a zero-bug go-live; real signing follows.
  - **(b) Implement real signing** for both chains before go-live. Substantial effort + new key management.
  - **(c) Keep live as-is** — not recommended; guarantees unpaid "paid" users.
- **D2 — Is `src/lib/payouts/payouts-service.ts` a second, live payout service, or dead code?** Reachable via `payouts/index.ts:9` and the `worker-wrapper.js` cron; `batch-settlement-service.ts` appears to be the real engine. Two divergent money services is a standing reconciliation hazard. Consolidate / document an ownership boundary / delete.
- **D3 — `ORIGINAL_REQUEST.md`** (repo root): delete or relocate to `docs/`. Phase 03, unresolved.

## Key Dependencies

- **02 needs 01**: flipping `strict` on with Node ABI drift active yields unreadable error cascades.
- **04 needs 02 + 03**: types must be visible (money defects live in type-blind code) and the tree must be clean before a 8h refactor.
- **05 needs 03**: config collapse (`wrangler.toml` vs `wrangler.jsonc`) is a prerequisite — deploying against dual config is non-deterministic.
- **06 needs 02 + 04 + 05**: the gate is the AND of three green pipelines.
- **07 needs 06**: cutover is irreversible in effect (money moves); fully rehearsed rollback must exist first.

## Key Risks

| Risk | Likelihood × Impact | Mitigation |
|------|--------------------|------------|
| **Webhook defect is "fixed" but its regression stays undetectable (maskers unclosed)** | **High × Critical** | Phase 04 closes both maskers (real-handler test + single-read mock); Phase 06 G4g asserts this, and Validation proves the gate FAILs when fixes are reverted. |
| **Fabricated payouts already exist in prod — users paid nothing while marked paid** | **Medium × Critical** | Phase 07 pre-flight reconciles `payouts.transaction_id` against chain state; founder signs remediation. Not silently rewritten. |
| Solana/EVM stays live unverified (D1 unanswered) → ships the "worst of both" | **Medium × Critical** | Phase 06 G4f treats an unanswered D1 as a hard FAIL. No waiver exists. |
| Exchange webhooks reject 100% of trades post-fix (verification order wrong) | Medium × Critical | Verification-before-parse mirrors `ipn/route.ts:123-151`; Phase 05 rehearses with real signed test vectors on staging. |
| Staging deploy binds **prod D1** (both bound in one wrangler config) → writes to prod | **Medium × Critical** | Phase 05 creates `wrangler.staging.jsonc` with prod id *removed*, distinct Worker name, plus a hard pre-deploy isolation assertion. |
| Stale `.open-next` bundle is trusted instead of regenerated → deploys 8-week-old code | **High × High** | Phase 05 mandates a clean rebuild before rehearsal; the stale bundle provably differs (lacks `MOCK_SIGNED_TX_PAYLOAD`, present in today's source). |
| First-ever `next build` fails (`worker-wrapper.js:71` imports TS via `.js` specifier; dead `mobile/` alias) | **High × High** | Phase 05 proves it during staging rehearsal — surfaced before go-live, not at it. |
| Fixing 113 strict errors changes runtime behavior on a protected route | Medium × Critical | Types-only discipline; control-flow changes get regression tests. `ratelimit/middleware.ts` + cron flagged. |
| Money math change alters already-deployed payout semantics | **Medium × Critical** | Phase 04 forbids DB migration; quantifies delta and escalates any material change. |
| One of three type bypasses is missed → gate stays half-open | **High × Critical** | Phase 02 owns two, Phase 05 owns the third; Phase 06 G2 asserts *absence* of all three. |
| Double-pay on payout cron re-run | Low × Critical | Phase 04 transactional unit + explicit double-run test; Phase 05 staging dry-run. |
| Server-side errors invisible (Sentry dead during the transition) | Medium × High | Phase 04 resolves wire-or-delete; Cloudflare worker logs + alerts as interim signal. |
| Protected flow regression (ipn/telegram/kyc/exchange/cron/terminal/auth) | Low × Critical | Every phase names protected routes; Phase 05/07 run live contract smoke. |
| CI green on Node 22 (broken-sqlite3 default) while prod runs 26 | Medium × High | Phase 01 pins Node 26; Phase 06 G0 asserts version and refuses otherwise. |
| `wrangler` undeclared → deploy/rollback resolves a different version per machine (global 4.100.0 vs transitive 4.103.0) | **High × High** | Phase 05 pins `wrangler` as an explicit devDependency, closing the drift. |

5. **`wrangler` is a peerDependency of `@opennextjs/cloudflare` (`^4.86.0`) that is declared nowhere.** `node_modules/.bin/wrangler` is absent; only a **global** Homebrew `wrangler@4.100.0` (`/opt/homebrew/bin/wrangler`) and a transitive store `wrangler@4.103.0` are reachable, with `npx --no-install` resolving to a third different version. Since `wrangler rollback`, `wrangler deployments list`, and `wrangler d1 execute` carry the entire rollback + migration surface, **"rollback is a one-command operation" is currently false** — it only works if the operator happens to have a compatible global install. Phase 05 pins it before any of those commands is relied upon.

## Constitutional Invariants (all phases)

- **Protected flows, never broken**: `/api/webhooks/ipn`, `/api/webhooks/telegram`, `/api/webhooks/kyc`, `/api/webhooks/exchange{,/kucoin,/okx}`, `/api/terminal/snapshot`, `/api/terminal/actions`, `/api/cron*`, `/api/auth/*`.
- **No `:any`** in code this plan adds. **Zod** on every API input touched. **No hardcoded secrets** — env only.
- **Decimals**: USDC is 6dp. Money is `BigInt` minor units internally; float only at final render.
- **Rollback per phase** is defined and must be mechanical (git revert / config flag), never "re-deploy fixed forward" for money paths.
- Node 26 path used in every command: `export PATH=/opt/homebrew/opt/node@26/bin:$PATH`.

## Validation Commands (canonical, reused across phases)

```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
node --version                        # expect v26.7.0
npx tsc --noEmit && echo TS_OK
npx eslint . --ext .ts,.tsx --max-warnings 0 && echo LINT_OK
CI=true npx jest 2>&1 | tail -8       # expect 0 failed, 128 suites
```

## Reports

- `reports/researcher-dependency-risk-report.md` — [pending]; `reports/researcher-quality-tests-report.md` — [pending]. Phases cite these where present; where absent, findings are from direct verification in this session (file:line in each phase).
