# 15 — Release Candidate Baseline & Source Truth Reconstruction (Gate G13-A)

- **Date:** 2026-11-18 (`Asia/Saigon`)
- **Worktree:** `/Users/macbook/apex-os-worktrees/phase2-ascendancy`
- **Branch:** `feat/ascendancy-phase2-verified`
- **Base Commit (`HEAD`):** `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d`
- **Gate Verdict:** **PASS (WITH CRITICAL GIT TOPOLOGY DISCOVERY DOCUMENTED)**

---

## 1. Git Topology & Remote Default-Branch Truth

Prior Phase 2 documentation loosely referred to `origin/main`. Direct verification against local refs and `origin` (`https://github.com/minhlongs/apex-os.git`) disproved `origin/main` and exposed a latent PR-targeting hazard:

| Check | Command | Verified Result | Operational Impact |
|---|---|---|---|
| Current `HEAD` | `git rev-parse HEAD` | `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d` | Matches live Staging & Production `/api/version` SHA (`f4285c5...`). |
| `origin/main` existence | `git ls-remote origin refs/heads/main` | **Does NOT exist** (empty) | Any script or PR targeting `main` fails immediately. |
| `origin/master` | `git ls-remote origin refs/heads/master` | `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d` | True canonical integration & production line (PRs `#41` through `#54` all merged into `master`). |
| Merge-base | `git merge-base HEAD origin/master` | `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d` | Zero divergence from `origin/master`; clean linear fast-forward base. |
| Remote `HEAD` symref | `git ls-remote --symref origin HEAD` | `ref: refs/heads/feature/sprint4-email-automation-complete` (`03a0db96...`) | **Hazard identified:** GitHub repository default branch setting still points to a stale Sprint 4 branch (`03a0db96`). Calling `gh pr create` without `--base master` would target the wrong branch! |
| Submodule state | `git submodule status` | `6848726311d795086df682f36636202f138c5008 apex-os-mobile (heads/master)` | Clean gitlink (`160000`), unmodified in Phase 2.1 worktree. |

### Auto-Deploy Safety Verification Before Any Push
1. **GitHub Actions workflows (`.github/workflows/`):**
   - `ci.yml` runs **read-only verification** (`typecheck`, `lint`, `assert-staging-isolation.sh`, `test`, `build:worker`) on `push` to `feat/**` and `pull_request` to `master`.
   - `deploy.yml` triggers **exclusively** on manual `workflow_dispatch` (enforced since PR `#47`). Pushing `feat/ascendancy-phase2-verified` or opening a Draft PR **cannot** trigger a deployment.
2. **Cloudflare Pages / Workers Git Integration:**
   - `npx wrangler pages project list` confirmed legacy project `apex-os` (`apex-os-317.pages.dev`) has `Git Provider: No`.
   - `npx wrangler deployments list` on `apex-os-staging` and `apex-os` confirmed deployments occur via API/CLI, not branch push hooks.

---

## 2. Initial Working Tree Inventory (Pre-G13 Hardening)

At the start of Gate G13-A:
- **Modified tracked files:** `52` files (`3,705` insertions, `878` deletions against `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d`).
- **Untracked Phase 2 files:** `41` files across `src/app/`, `src/components/`, `src/config/canonical-origin.ts`, `src/database/migrations/031_ascendancy_phase2_ui_and_poller.sql`, `src/lib/`, `src/__tests__/`, and `plans/reports/ascendancy-p2/00..03`.
- **Whitespace / Patch hygiene (`git diff --check`):** Flagged one trailing blank line at EOF in `src/lib/partners/types.ts:417` (scheduled for cleanup prior to commit).

---

## 3. Baseline Build, Lint, Typecheck & Test Execution

Every gate command was executed directly in `/Users/macbook/apex-os-worktrees/phase2-ascendancy` on Node `v26.7.0` / npm `11.19.0`:

| Command | Exit Code | Duration | Exact Outcome |
|---|---|---|---|
| `npm run typecheck` | `0` | `4s` | `rm -rf .next/types .next/dev/types && tsc --noEmit` — 0 TypeScript errors. |
| `npm run lint` | `0` | `7s` | `eslint . --ext .ts,.tsx --max-warnings 0` — 0 errors, 0 warnings. |
| `CI=true npm test -- --runInBand` | `0` | `69.3s` | `177 passed, 177 total` suites; `3,621 passed, 1 skipped, 3,622 total` tests. |
| `npm run build` | `0` | `23s` | Next.js webpack production build succeeded across all static, SSG, dynamic, and API routes. |
| `npm run build:worker` | `0` | `53s` | OpenNext Cloudflare bundle generated `.open-next/worker.js` and `.open-next/assets` cleanly. |

---

## 4. Upgraded Staging/Production Isolation Gate (`assert-staging-isolation.sh`)

### Gap Found in Legacy Script
The legacy `scripts/assert-staging-isolation.sh` used naive line `grep` checks covering only `database_id`, KV `id`, R2 `bucket_name`, and staging `name`. It did **not** parse JSONC structure (meaning commented-out IDs could cause false positives/negatives) and completely missed:
- Production worker `name` verification (`apex-os`) and `database_name` collision checks
- R2 `preview_bucket_name` cross-contamination
- Durable Object `script_name` cross-environment binding
- Custom `route` / `routes` / `custom_domains` overlap
- `vars.APP_ENV`, `vars.NEXT_PUBLIC_APP_URL`, `vars.WEBAUTHN_RP_ID`, `vars.WEBAUTHN_ORIGIN`
- Public Suffix List hazard (`WEBAUTHN_RP_ID = "workers.dev"`) and unowned third-party domain guards (`apexos.app`, `apex-os.pages.dev`, `apex-os.com`, `apexos.io`, `long-tran624.workers.dev`)
- `STELLAR_NETWORK` (`testnet` vs `mainnet`) and fail-closed `AUTO_SETTLE_PAYOUTS = "false"`

### Hardening & Negative-Test Proof
- Upgraded `scripts/assert-staging-isolation.sh` to parse JSONC via an embedded Node verifier enforcing all 11 isolation invariants above.
- Added automated negative test suite `__tests__/assert-staging-isolation.test.ts` (`10/10` tests passing in `1.37s`), proving the gate fails closed on every cross-contamination vector while passing (`STAGING_ISOLATED`) on the repository's real `wrangler.staging.jsonc` and `wrangler.jsonc`.

---

## 5. Unresolved Questions
- Should the GitHub repository default branch setting (`origin/HEAD`) eventually be switched from `feature/sprint4-email-automation-complete` to `master` by the repository owner? (Per Gate 1 authorization, repo-wide GitHub settings were left untouched in this session and Draft PR creation explicitly passes `--base master`.)
