# Phase 05 — Deploy Pipeline, Staging Rehearsal & Rollback

## Overview
- **Priority**: P1
- **Status**: pending
- **Effort**: 10h (+2h: declare/pin `wrangler`, purge and regenerate the stale bundle, and prove toolchain reproducibility before any deploy command is trusted)
- **Blocks**: Phase 06
- **Depends on**: Phase 03 (single wrangler config), Phase 04 (money correctness)

This phase creates the project's **first deploy pipeline**. Verified backdrop: the build artifact on disk is eight weeks stale, `wrangler` is undeclared, there is no `deploy:*` npm script, and there is no `.github/`. A production go-live without a rehearsed deploy + rollback is not a plan, it is a hope.

## Key Insights
**A. The real deploy adapter is installed, but the package it delegates to is not declared.** `@opennextjs/cloudflare` is installed (`node_modules/.bin/opennextjs-cloudflare`, resolved `1.19.11`). Its CLI (verified via `--help`):
```
opennextjs-cloudflare build      # builds the Worker into .open-next/
opennextjs-cloudflare preview    # local wrangler dev preview
opennextjs-cloudflare deploy     # deploy to Cloudflare Workers
```
So the deploy graph is: `next build` → `opennextjs-cloudflare build` → `opennextjs-cloudflare deploy` → **`wrangler` underneath**.

Critically, `wrangler` is a **peerDependency** (`^4.86.0`) of the adapter — reachable only transitively, **not declared in `package.json`**. Verified state:
- `node_modules/.bin/wrangler` — **absent**.
- `node_modules/.pnpm/wrangler@4.103.0` — present (transitive).
- `/opt/homebrew/bin/wrangler` — **4.100.0**, a global Homebrew install, unrelated to this project's lockfile.
- `npx --no-install wrangler --version` → `4.129.0`, resolving to yet another location.

That is a three-way version drift, and `wrangler` carries the **entire rollback and migration surface**: `wrangler rollback`, `wrangler deployments list`, `wrangler d1 execute --file=…`. Until it is pinned as a workspace dependency, **"rollback is a one-command operation" is false on this machine** — it only works if the operator happens to have a compatible global wrangler.

**B. The `.open-next/` artifact on disk is stale — do not treat it as evidence.** `.open-next/worker.js` (2.3 KB) and `.open-next/.build/` bundles **do exist** and are dated **Aug 10 2026** (some parcels as old as Jul 20), so the project *has* been built with `@opennextjs/cloudflare` before. But `src/lib/payouts/batch-settlement-service.ts` is **Sep 28** and `solana-adapter.ts` Sep 28 — ~8 weeks of source divergence.

Proof the bundle is out of date, not merely old: the stale bundle **does not contain** `MOCK_SIGNED_TX_PAYLOAD`, which today's `solana-adapter.ts:214` does. So the bundle predates the current Solana adapter. It answers no question about today's code and must be regenerated from scratch before rehearsal proves anything.

**C. A SECOND type-bypass exists, independent of Phase 02's.**
```js
typescript: { ignoreBuildErrors: true },
```
Phase 02 removes `NEXT_DISABLE_TYPE_CHECK=1` from the `build` script. **That is insufficient** — `ignoreBuildErrors: true` in `next.config.js` independently suppresses Next's type errors during `next build`. Both must be removed or the gate stays half-open. This is the most easily-missed item in the entire plan.

**D. `next.config.js` has a broken alias.** It references `mobile/node_modules/expo-router`, but **there is no `mobile/` directory** — the mobile project is at `apex-os-mobile/` (verified: no `mobile/` dir exists; `apex-os-mobile/` contains `app.json`, `App.tsx`, etc.). This alias is dead config that will resolve to a non-existent path during build. It must be removed or corrected; it is a probable **first-build failure**.

**E. `@opennextjs/cloudflare` is declared `"latest"` but locked.** `package.json:38` declares `"latest"`; the pnpm lockfile resolves `1.19.11`. This is non-reproducible: a fresh install next month could pull a different major and change the build output. Must be pinned to `1.19.11` (or the lockfile-honored exact version).

**F. `wrangler.jsonc` has the `assets` block; the old `wrangler.toml` did not.**

**G. There is no `/api/version` endpoint.** Historical plan `plans/reports/260801-1901-week1-closure-gate-report.md:27` notes "no `deploy:full` script or `/api/version` endpoint exists yet". Without a version endpoint, **post-deploy verification has nothing to read** — you cannot prove which revision is live. Must be created here.

**H. Two D1 databases, one binding name.** `wrangler.jsonc` binds both `DB` (prod `3436aa7d…`) and `apex_os_staging_db` (staging `be4ed659…`) simultaneously. A staging deploy therefore has **live production credentials in scope**. This is the highest-consequence config hazard in the phase.

**I. Migrations are unmanaged.** 26 migration files exist in `src/database/migrations/` with two clashing numbering series (`005_*` twice, `007_*` twice, `009_*` twice, `018_*` twice) and a duplicate schema pair (`001_initial_schema_d1.sql` vs `001_initial_schema.sql`; `002_auth_tables.sql` vs `002_deals_schema_d1.sql`). There is no applied-migration ledger visible. **Do not attempt migration ordering in this phase** — verify the *current* prod/staging schema state and record it; a full migration system is Phase 07+.

## Requirements
### Functional
- F0. **`wrangler` is an explicit, pinned devDependency**, and the workspace binary — not a global install — is the one that executes deploy/rollback/migration commands.
- F1. A single, repeatable deploy entry point. It may be an npm script, but it must be created — nothing exists today.
- F2. **Staging rehearsal** against a freshly generated bundle (not the stale Aug 10 artifact), exercised against protected routes, before any production deploy.
- F3. **Green-production verification**: after deploy, an automated check proves the intended revision is live *and* protected routes respond correctly.
- F4. **Rollback**: a documented, mechanical path back to the previous revision — *runnable from this repo* — and rehearsed, not theorized.
- F5. Protected flows smoke-tested in the rehearsal: ipn, telegram, kyc, exchange (kucoin/okx signature verification), terminal snapshot + actions, cron, auth.
- F6. Secrets come from CI secrets / Cloudflare, never the repo.

### Non-Functional
- NF1. Deploy is deterministic: same commit → same artifact.
- NF2. CI runs type-check + lint + test on every push; deploy only from `master`.
- NF3. No manual console clicks in the happy path.

## Architecture
**Pipeline shape:**
```
push/PR ──► CI: [typecheck │ lint │ test] ──(all green)──► merge to master
                                                               │
master ───────────────────────────────────► deploy-staging job
                                             1. next build
                                             2. opennextjs-cloudflare build
                                             3. opennextjs-cloudflare deploy  (staging)
                                             4. smoke test protected routes (staging)
                                             5. PASS ─► manual-approval gate
                                                           │
                                                deploy-production job
                                                 1..3 same, prod target
                                                 4. verify /api/version + protected routes
                                                 5. watch 10 min (error-rate/d1 metrics)
                                                 6. FAIL ─► rollback job (previous revision)
```

**Why a manual gate between staging and prod:** money movement. `biz-high-commission-liability` and payout cron are real. An automatic staging→prod promotion is fast but removes the human checkpoint at the exact moment a $ mistake becomes unrecoverable. YAGNI would say automate it; risk says gate it. Gate is a single approval click, cheap.

**Staging DB isolation — the critical safety rule.** Because `wrangler.jsonc` binds prod D1 in the same worker config, staging deploys **must not use prod env values**. Therefore:
- Staging deploy uses a **separate wrangler config** (e.g. `wrangler.staging.jsonc`) that contains **only** the staging D1 `be4ed659…`, plus non-production secrets.
- Production deploy uses `wrangler.jsonc` with prod bindings.
- The staging job asserts, before deploy, that no prod `database_id` string appears in the config it is deploying with:
  ```bash
  test ! -grep -q "3436aa7d-3065-4103-96e1-ddbd8b372246" wrangler.staging.jsonc && echo STAGING_ISOLATED
  ```
This one assertion prevents the single worst deploy accident available in this repo.

**`/api/version` contract** (new): returns commit SHA, build timestamp, and environment. Must read from a build-time injected env (e.g. `NEXT_PUBLIC_COMMIT_SHA` set in CI), not from a hardcoded value. Unauthenticated is acceptable — a commit SHA is not a secret; it confirms the deployed revision. Do **not** leak internal paths, DB ids, or secrets in it.

## Related Code Files
### Create
- `.github/workflows/deploy.yml` — staging + gated prod + rollback jobs.
- `.github/workflows/ci.yml` — **extended here** (blueprint created in Phase 02) to full matrix incl. build.
- `wrangler.staging.jsonc` — staging-only config (staging D1 only, no prod ids).
- `scripts/verify-deployment.sh` — post-deploy verification: version + protected-route smoke.
- `scripts/smoke-protected-routes.sh` — protected-flow contract checks against a given base URL.
- `src/app/api/version/route.ts` — deployed-revision endpoint.
- `docs/rollback-runbook.md` — mechanical rollback steps + decision criteria.
- `docs/deploy-architecture.md` — **extended** (created in Phase 03) with the pipeline graph and prerequisites.

### Modify
- `package.json` — add `deploy:*` scripts (build + opennext build + deploy variants), `build` confidence, pin `@opennextjs/cloudflare`, and **add `wrangler` as a pinned devDependency**.
- `.open-next/` — **deleted and regenerated** (stale Aug 10 bundle must not be trusted).
- `next.config.js` — **remove `typescript: { ignoreBuildErrors: true }`** (the second bypass) and remove/fix the broken `mobile/node_modules/expo-router` alias.
- `.gitignore` — ensure `.open-next/` and staging artifacts ignored (`.gitignore:4` already covers `/.open-next/`).
- `docs/api/metrics-api.md` — document `/api/version`.

### Delete
- *(the Phase 03 `wrangler.toml` deletion is already done; here only confirm)*
- Dead `turbopack.resolveAlias` block in `next.config.js` if `mobile/` truly absent.

## Implementation Steps
1. **Declare `wrangler` explicitly (blocker — do this first).** Add it to `devDependencies` pinned to a version compatible with the adapter's peer range `^4.86.0`. Use the transitive version already resolved by the lockfile (`wrangler@4.103.0`) so the lockfile does not churn: declare `"wrangler": "4.103.0"` (or `"^4.103.0"`). Then **prove the workspace binary is what runs**, not the global one:
   ```bash
   export PATH=/opt/homebrew/opt/node@26/bin:$PATH
   node_modules/.bin/wrangler --version      # MUST print 4.103.0, and MUST exist
   which wrangler                            # must resolve inside this repo, not /opt/homebrew/bin
   ```
   Record in the phase report that the global `/opt/homebrew/bin/wrangler` (4.100.0) is **out of scope** for deployment and must not be relied upon. Rationale: `wrangler rollback`, `wrangler deployments list`, and `wrangler d1 execute` are the entire rollback + migration surface; leaving them to an undeclared transitive/global binary means "rollback works" is true only on one machine.
2. **Purge the stale bundle.** Delete the entire stale artifact so no rehearsal can accidentally trust it:
   ```bash
   rm -rf .open-next
   ```
   It is git-ignored (`.gitignore` `/.open-next/`) and its regenerated form is a build output, so deletion is safe and reversible by rebuilding. This is a deliberate step, not cleanup — the existing bundle is Aug 10 and provably predates the current Solana adapter.
3. **Remove both type bypasses.** Edit `next.config.js`: delete `typescript: { ignoreBuildErrors: true },` entirely, and delete the `experimental.turbopack.resolveAlias` block (or repoint it to `apex-os-mobile/node_modules/expo-router` **only if** that path actually contains the module — verify with `ls apex-os-mobile/node_modules/expo-router`; if absent, delete the block outright).
4. **Pin the adapter.** `package.json` `"latest"` → the lockfile-resolved `"1.19.11"`. Confirm with `node -e "console.log(require('./node_modules/@opennextjs/cloudflare/package.json').version)"` *after* the edit (expect `1.19.11`).
5. **Add `/api/version`** (`src/app/api/version/route.ts`): export a `GET` handler returning `{ sha, builtAt, environment }`. `sha` from `process.env.NEXT_PUBLIC_COMMIT_SHA ?? 'unknown'`, `environment` from `process.env.NODE_ENV`/a sanitized `APP_ENV`. Zod-validate nothing (no inputs), but **whitelist the fields returned** — do not spread env. Zero secrets.
6. **Create `wrangler.staging.jsonc`.** Copy the structure of `wrangler.jsonc`, but:
   - Keep only `apex_os_staging_db` (`be4ed659…`) — **remove the prod `DB` `3436aa7d…` binding entirely**.
   - Keep KV/R2 (or staging-specific if created later — do not invent ids).
   - Same `main`, `compatibility_date` (`2026-03-17`), flags, `assets` block, crons.
   - Use a distinct `name` (e.g. `apex-os-staging`) so the deployed Worker cannot collide with prod.
   - Point non-secret vars at staging values.
7. **Add deploy scripts** to `package.json` (creating, not assuming existing):
   ```json
   "build:worker": "next build && opennextjs-cloudflare build",
   "deploy:staging": "npm run build:worker && opennextjs-cloudflare deploy --config wrangler.staging.jsonc",
   "deploy:production": "npm run build:worker && opennextjs-cloudflare deploy --config wrangler.jsonc",
   "verify:deploy": "bash scripts/verify-deployment.sh"
   ```
   Use `node_modules/.bin/wrangler` explicitly (via the scripts) so the pinned workspace binary is the one that executes.
8. **Verify a clean, current build works locally.** This is the first build reflecting today's source:
   ```bash
   export PATH=/opt/homebrew/opt/node@26/bin:$PATH
   npm run build:worker
   ls -la .open-next/worker.js && echo WORKER_BUILT_OK
   ```
   **This is the moment of truth for the `worker-wrapper.js:71` `.js`-specifier-imports-TS question.** Confirm the built worker actually bundles `payouts-service`, `d1-monitor`, and `alert-engine` — inspect the `.open-next/` parcels for the symbols, or run `preview` and observe the cron handlers not throwing `Module not found`. If resolution fails, fix the specifiers to `.ts`/extensionless as the bundler requires. **Log this outcome explicitly in the phase report.**
9. **Local preview smoke** — `opennextjs-cloudflare preview` and hit the protected routes locally (see step 10 script). This catches 404/500 issues before any remote deploy.
10. **Create `scripts/smoke-protected-routes.sh`** taking `$1 = base_url`. For each protected route, assert HTTP status and a structural invariant (not deep business logic):
   - `/api/version` → 200, JSON has `sha`
   - `/api/health` → 200
   - `/api/webhooks/ipn` POST → 401/400 (auth/rejection), **not 500** — a crash means broken verification
   - `/api/webhooks/telegram` POST → 400/401, not 500
   - `/api/webhooks/kyc` POST → 400/401, not 500
   - `/api/webhooks/exchange/kucoin` POST with **no/invalid signature** → 401/400, not 500 and not 200 (proves signature enforcement)
   - `/api/webhooks/exchange/okx` → same
   - `/api/terminal/snapshot` GET → 200 or 401, not 500
   - `/api/terminal/actions` POST → 400/401, not 500
   - `/api/cron` protected path → 401 (not 200 unauthenticated — a 200 means the cron is publicly callable)
   - `/api/auth/session` GET → 200 or 401
   Log `PASS/FAIL` per route; exit non-zero on any FAIL. **The core assertion is "no 500s and no unauthenticated 200s on protected routes."**
11. **Create `scripts/verify-deployment.sh`**: run `smoke-protected-routes.sh` against `$1`, plus assert `/api/version`'s `sha` equals `$EXPECTED_SHA` (passed in, sourced from `$GITHUB_SHA`).
12. **Create `.github/workflows/deploy.yml`** with jobs: `deploy-staging` (build → deploy staging → verify, with the prod-id isolation assertion before deploy), `gated-check` (manual approval via `environment:` protection or equivalent), `deploy-production` (build → deploy prod → verify → 10-min watch), `rollback` (re-deploy previous known-good revision; triggered manually). Set Node 26 via `actions/set-node@v4` with `node-version: 26.7.0`, export the Node 26 PATH, and install deps so the declared `wrangler` resolves (never the runner's global).
13. **Extend `.github/workflows/ci.yml`**: `typecheck`, `lint`, `test`, `build` jobs; all must pass before `deploy-staging` runs. Node 26.7.0 pinned everywhere.
14. **Staging rehearsal (the gate).** Execute, in order, and record each result:
    1. Deploy to staging (isolated config).
    2. `verify:deploy <staging-url> $GITHUB_SHA` — all protected routes pass.
    3. Trigger the alert-engine cron path via a staging cron invocation; confirm no `Module not found` and no double-payout.
    4. Trigger a payout dry-run against staging D1 (money path) and confirm the ledger moves exactly once and totals reconcile.
    5. **Rehearse rollback**: deploy the previous revision over staging, confirm verification passes on the old SHA. Use the declared `wrangler` binary — prove `node_modules/.bin/wrangler rollback`/deploy is the command that works, record the exact invocation. Rollback must be proven, not described.
15. **Record the migration/schema baseline** for prod and staging (row counts per table, list of tables) into `docs/deploy-architecture.md`. Do not migrate.

## Todo List
- [ ] `wrangler` declared as pinned devDependency; `node_modules/.bin/wrangler --version` works and `which` resolves in-repo (not `/opt/homebrew/bin`)
- [ ] Stale `.open-next/` deleted and regenerated (no Aug 10 bundle survives)
- [ ] `next.config.js` `ignoreBuildErrors: true` removed (second bypass)
- [ ] `next.config.js` dead `mobile/` alias removed or corrected
- [ ] `@opennextjs/cloudflare` pinned off `"latest"`
- [ ] `/api/version` created and returns whitelisted fields only
- [ ] `wrangler.staging.jsonc` created with **no prod D1 id**, distinct Worker name
- [ ] Deploy npm scripts created (`build:worker`, `deploy:staging`, `deploy:production`, `verify:deploy`)
- [ ] `npm run build:worker` succeeds; `.open-next/worker.js` produced **from current source**
- [ ] `worker-wrapper.js` `.js`-imports-TS resolution **proven in the bundle** and logged
- [ ] `smoke-protected-routes.sh` + `verify-deployment.sh` created and run locally
- [ ] Staging deploy + verification passes all protected routes
- [ ] Payout dry-run + cron exercised on staging; ledger moves exactly once
- [ ] Rollback rehearsed on staging with an older revision **using the pinned `wrangler`**
- [ ] `ci.yml` + `deploy.yml` written with Node 26.7.0 pinned and declared-wrangler install
- [ ] Prod/staging schema baseline recorded

## Success Criteria
**Definition of done**: `wrangler` is a pinned workspace dependency; the bundle is regenerated from current source; a commit can go from merge to staging with zero manual steps, be verified automatically against protected routes, be promoted to production through a gated job, be verified again, and be rolled back mechanically — and every one of those steps has actually been executed at least once.

**Validation commands**:
```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
# F0: pinned workspace wrangler, not the global one
node_modules/.bin/wrangler --version            # must exist; must equal the declared version
which wrangler                                   # must resolve inside this repo
node -e "console.log(require('./package.json').devDependencies.wrangler)"  # must be non-empty

# local build from CURRENT source (after rm -rf .open-next)
rm -rf .open-next
npm run build:worker && ls -la .open-next/worker.js && echo BUILT_OK
find .open-next -type f -newermt "2026-10-01" | head -3   # bundle must be fresh, not Aug 10
grep -rl "MOCK_SIGNED_TX_PAYLOAD" .open-next/ | wc -l     # must be >0: proves current source is bundled

# staging isolation assertion — must be silent/success
test ! -grep -q "3436aa7d-3065-4103-96e1-ddbd8b372246" wrangler.staging.jsonc && echo STAGING_ISOLATED
# deploy + verify
npm run deploy:staging
bash scripts/verify-deployment.sh https://apex-os-staging.<subdomain>.workers.dev "$GITHUB_SHA"
# protected routes — expect NO 500s, NO unauthenticated 200s
bash scripts/smoke-protected-routes.sh https://apex-os-staging.<subdomain>.workers.dev
# prod
npm run deploy:production && bash scripts/verify-deployment.sh https://apex-os.<subdomain>.workers.dev "$GITHUB_SHA"
# rollback rehearsal (staging), using the pinned binary
git checkout <previous-good-sha> && npm run deploy:staging && bash scripts/verify-deployment.sh <staging-url> "<previous-good-sha>"
node_modules/.bin/wrangler deployments list --config wrangler.staging.jsonc --name apex-os-staging   # rollback target must be listable
```

## Risk Assessment
| Risk | Likelihood × Impact | Mitigation |
|------|--------------------|------------|
| **`wrangler` left undeclared → deploy/rollback/migration run against whatever binary happens to be on PATH** | **High × Critical** | Step 1 pins it as a devDependency and Success Criteria asserts `which wrangler` resolves in-repo. The global 4.100.0 is explicitly out of scope. |
| **Stale Aug 10 bundle shipped instead of current code** | **High × Critical** | Step 2 deletes it; Success Criteria proves freshness by date *and* by asserting a current-source-only symbol is present in the new bundle. |
| **`ignoreBuildErrors` + `NEXT_DISABLE_TYPE_CHECK` — one missed, gate stays open** | **High × Critical** | Step 3 explicitly removes the `next.config.js` one that Phase 02 does not cover; Success Criteria asserts `next build` fails on a deliberate type error. |
| **Staging deploy binds prod D1 → payouts/earnings written to prod during test** | **Medium × Critical** | Isolation assertion (`test ! -grep prod-id`) is a hard gate before any staging deploy; staging Worker has a distinct name. |
| `worker-wrapper.js` `.js`→TS dynamic imports fail in the real bundle | Medium × High | Step 8 proves this against a fresh bundle during rehearsal, not go-live. If it fails, cron money movement is broken — a showstopper surfaced safely on staging. |
| First `next build` fails on the `mobile/` alias / env vars | **High × Medium** | Step 3 removes the dead alias; remaining failures are captured in the rehearsal and fixed before the gate. Unrelated app defects → fix with test; env → add to CI secrets. |
| Smoke test too shallow to catch a real protected-flow break | Medium × High | Assertions are status-class based (no 500, no unauth 200) plus signature enforcement; supplement with `__tests__` for business logic. Deep e2e checks belong in CI `test`, not a shell smoke. |
| Deploy succeeds but `/api/version` reports the wrong SHA → false confidence | Low × High | `verify-deployment.sh` compares against `$GITHUB_SHA` exactly; mismatch = FAIL. |
| Unmanaged migrations drift between prod and staging | **High × Medium** | Step 15 records baselines; a full migration ledger is explicitly Phase 07+ (do not build it here — YAGNI, and building it risks an unrehearsed schema change at go-live). |

## Security Considerations
- Secrets (Stellar key, webhook secrets, Resend, CF token) come from CI secrets/Cloudflare env, injected at deploy time. **Never** in `wrangler*.jsonc` — config files are tracked.
- `/api/version` must not expose D1 ids, binding names, internal paths, or env. Whitelist `sha`/`builtAt`/`environment` only.
- The smoke test proving `/api/cron` returns **401 unauthenticated** is a security assertion, not just a health check: a `200` there means anyone can trigger payouts.
- Protected webhook routes must reject invalid signatures with 401 **before** any business logic — verify code order, not just the status.
- Cloudflare API token for deploy must be a scoped, short-lived secret with Workers edit scope only; never a global account key.
- `deploy.yml` must not use `pull_request_target` (that exposes secrets to forks); use `push` on `master` + `workflow_dispatch`.

## Next Steps
- **Unblocks Phase 06**: the gate can now assert "a known SHA deployed, verified, and is rollbackable."
- **Feeds Phase 07**: `docs/rollback-runbook.md` is the cutover-day companion.
- **Phase 07+ follow-ups**: migration ledger/applied-migration tracking; staging KV namespace creation; D1 column-type migration for money (from Phase 04).
- Cross-ref `reports/researcher-dependency-risk-report.md` (pending) for deploy-target and env-drift specifics that must be folded into the env manifest.
