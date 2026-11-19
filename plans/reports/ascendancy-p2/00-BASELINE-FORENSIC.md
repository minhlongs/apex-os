# Gate G0 — Baseline Forensic & Environment Verification

## Executive Outcome

Clean worktree `/Users/macbook/apex-os-worktrees/phase2-ascendancy` on branch `feat/ascendancy-phase2-verified` was created directly from `origin/master` (`f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d`) without modifying the dirty primary checkout (`/Users/macbook/apex-os`) or any pre-existing worktree (`/Users/macbook/apex-os-worktrees/ascendancy-audit`, `fix-deploy-secrets`, `go-live-pipeline`). Fresh execution on Node.js `v26.7.0` confirmed `npm run typecheck` (`exit 0`), `npm run lint` (`exit 0`), `bash scripts/assert-staging-isolation.sh` (`STAGING_ISOLATED`, `exit 0`), `CI=true npx jest --silent` (`169/169` suites passed, `3,537` tests passed, `1` pre-existing skipped test, `0` failures in `15.802s`), and `npm run build:worker` (`OpenNext build complete`, `.open-next/worker.js` generated). Next.js was then patched from `16.4.3` to `16.4.6` to close two moderate cache-leak security advisories (`GHSA-mfr8-8qww-v76h`, `GHSA-vc7v-qv4w-wrv8`), and `typecheck`, `lint`, and `build:worker` were re-verified green.

---

## 1. Runtime & Toolchain Measurements (Freshly Executed on 2026-11-18)

| Check | Command | Measured Result | Verdict |
|---|---|---|---|
| Node.js runtime | `node -v` | `v26.7.0` (matches `.nvmrc` and `engines.node >=26.0.0 <27`) | PASS |
| npm version | `npm -v` | `11.19.0` | PASS |
| SQLite CLI | `sqlite3 --version` | `3.54.0` (64-bit Darwin) | PASS |
| Native SQLite binding | `node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1 as x').get()"` | `{ x: 1 }` (ABI 147 loaded cleanly) | PASS |
| Submodule `apex-os-mobile` | `git submodule status` | `6848726311d795086df682f36636202f138c5008` (`heads/master`) | PASS |
| Disk headroom | `df -h /Users/macbook` | `967 GiB` free (`48%` capacity used) | PASS |
| Local dev ports (`3000`, `3100`, `8787`) | `lsof -iTCP:3000,3100,8787 -sTCP:LISTEN` | All free | PASS |

---

## 2. Git, Worktree & GitHub Repository Forensics

### 2.1 Worktree Inventory & Non-Destructive Isolation

All pre-existing checkouts were inspected strictly read-only and left completely untouched:

| Worktree Path | Branch | Commit SHA | Working Tree Status | Action Taken |
|---|---|---|---|---|
| `/Users/macbook/apex-os` | `fix/ci-convergence-and-submodules` | `a6c77114` | `27` dirty porcelain entries | Preserved untouched |
| `/Users/macbook/apex-os-worktrees/ascendancy-audit` | `feat/ascendancy-phase2-portal-poller` | `a0d663b8` (`11` commits ahead of `origin/master`) | `42` dirty/untracked porcelain entries (including unfinished `032` migration & poller edits) | Preserved untouched; audited read-only as reference |
| `/Users/macbook/apex-os-worktrees/fix-deploy-secrets` | `master` | `c715a0e0` | Historical worktree | Preserved untouched |
| `/Users/macbook/apex-os-worktrees/go-live-pipeline` | `fix/paper-fixture-monotonic-sequence-and-cron-scheduled` | `17ee2a3b` | Historical worktree | Preserved untouched |
| `/Users/macbook/apex-os-worktrees/phase2-ascendancy` | `feat/ascendancy-phase2-verified` | Branched from `f4285c5d` | Clean isolated workspace | Active Phase 2 implementation worktree |

### 2.2 GitHub Remote, Default Branch Drift, PRs & CI Status

- **`origin/master` HEAD:** `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d` (`2026-11-15 07:27:13 +0700`, `feat(audit): re-architect affiliate ledger, multichain Turnkey settlement, and compliance boundaries (#54)`).
- **Default branch drift finding:** GitHub repository metadata (`gh api repos/minhlongs/apex-os --jq .default_branch`) currently sets `default_branch` to `feature/sprint4-email-automation-complete` (`03a0db96`, dated `2026-11-07`), whereas Phase 1 PR #54 merged into `master` (`f4285c5d`). Therefore, `gh pr create` for Phase 2 **must explicitly pass `--base master`** so the Draft PR targets `master` rather than the stale default branch.
- **Latest `master` CI run:** Run `43658238886` (`CI` workflow on `master` push `f4285c5d`) completed with `success` in `3m37s` on `2026-11-15T00:27:17Z`.
- **Issue #55 status:** `OPEN`, labeled `in progress`, title `feat(ascendancy-p2): Non-Custodial Trader Rebate Portal, Admin Passkey Console, 5-Exchange HTTP Poller & Legal Boundaries`, no existing open PRs targeting `master` for Issue #55.
- **CI vs Deploy workflow safety:**
  - `.github/workflows/ci.yml` triggers on `push` (`feat/**`, `master`, etc.) and `pull_request` (`master`), running only non-destructive checks (`npm ci`, `assert-staging-isolation.sh`, `npm run typecheck`, `npm run lint`, `CI=true npm test`, `npm run build:worker`).
  - `.github/workflows/deploy.yml` triggers **exclusively** on manual `workflow_dispatch` (`deploy-staging`, `deploy-production`, `rollback-staging`, `rollback-production`). Pushing a feature branch or opening a Draft PR cannot trigger any staging or production deployment.

---

## 3. Fresh Baseline Verification Gates on Unmodified `origin/master` (`f4285c5d`)

| Gate | Command Executed | Fresh Output Summary | Exit Code |
|---|---|---|---|
| Staging D1 isolation | `bash scripts/assert-staging-isolation.sh` | `STAGING_ISOLATED` (`wrangler.jsonc` binds `apex-os-db` `3436aa7d-...`; `wrangler.staging.jsonc` binds `apex-os-staging-db` `be4ed659-...`, distinct KV and R2 buckets, `AUTO_SETTLE_PAYOUTS="false"` in both) | `0` |
| TypeScript check | `npm run typecheck` | `tsc --noEmit` — 0 errors | `0` |
| ESLint check | `npm run lint` | `eslint . --ext .ts,.tsx --max-warnings 0` — 0 errors, 0 warnings | `0` |
| Full Jest suite | `CI=true npx jest --silent` | `Test Suites: 169 passed, 169 total` / `Tests: 1 skipped, 3537 passed, 3538 total` / `Time: 15.802 s` | `0` |
| Cloudflare Worker bundle | `npm run build:worker` | `opennextjs-cloudflare build` → `Worker saved in .open-next/worker.js` (`2.2 KB` entry wrapper + `.open-next/server-functions/default`) | `0` |

### 3.1 Pre-Existing Skipped Test Documentation

Exactly one skipped test exists on baseline `origin/master`:
- `__tests__/lib/notifications/notification-channels.test.ts:368` — `it.skip('should send email via Resend when channel is email', ...)` (pre-existing external Resend transport test from Sprint 4 alerting suite). No new `.skip` or `.todo` tests will be introduced in Phase 2.

### 3.2 Next.js Security Patch (`16.4.3` → `16.4.6`)

`npm audit` on baseline `f4285c5d` reported two moderate cache-leak advisories in `next@16.4.3` (`GHSA-mfr8-8qww-v76h` and `GHSA-vc7v-qv4w-wrv8`, affecting `16.2.0`–`16.4.4`). Upgrading `next` to exact `16.4.6` eliminated all `next` advisories (`next vuln after 16.4.6: NONE`), and `npm run typecheck`, `npm run lint`, and `npm run build:worker` all re-ran with exit code `0`.

---

## 4. Baseline Database Migration Inventory (`001`–`030`)

`src/database/migrations/` on `origin/master` contains `45` SQL files spanning prefixes `001` through `030`, ending with:
- `028_ascendancy_audit_core.sql` (Phase 1 double-entry ledger, `ledger_accounts`, `ledger_transactions`, `ledger_postings`, `settlement_batches`, `payout_items`, `runtime_flags`, `admin_webauthn_credentials`, `admin_webauthn_challenges`, `partner_evidence_artifacts`)
- `028_paper_trading_journal.sql`
- `029_paper_trading_outbox_and_runs.sql`
- `030_paper_trading_triggers_and_outbox_sync.sql`

No `031_*` migration exists on `origin/master`. Phase 2 schema additions will be consolidated into the single additive migration `src/database/migrations/031_ascendancy_phase2_ui_and_poller.sql`.

---

## Unresolved Questions

None for Gate G0. All baseline runtime, git, CI, isolation, and build facts are empirically verified.
