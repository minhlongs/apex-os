# 31 — G21 Final Governance Approval & Merge Decision Packet

**Date:** 2026-11-22  
**Repository:** `minhlongs/apex-os`  
**Pull Request:** https://github.com/minhlongs/apex-os/pull/56  

## Founder Decision

```text
HOLD_GITHUB_PROTECTION
```

> **Summary:** The deployment workflow rollback bypass defect in `.github/workflows/deploy.yml` has been **FIXED and verified** (`rollback-staging` → `environment: staging`; `rollback-production` → `environment: production` + `refs/heads/master`; `deploy-production` → `environment: production` + `refs/heads/master`). All local verification gates (`194/194` Jest suites, `typecheck`, `lint`, `build:worker`, `assert-staging-isolation.sh`, YAML syntax) and fresh GitHub CI pass.  
> The **sole remaining source-merge blocker** is that Founder has not yet configured the GitHub `master` branch ruleset/protection and the GitHub `production` deployment environment with required reviewers. Once Founder applies those exact settings (zero code changes required), the verdict becomes eligible for `MERGE_PREFLIGHT_PASS`.

---

## 1. Git
- **Feature Branch:** `feat/ascendancy-phase2-verified`
- **Base Branch / SHA (`origin/master`):** `master` @ `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d`
- **Prior Baseline SHA (G20):** `d79f3806d9645039dda584e5fd99d89f7c7bb060`
- **Current G21 Scope:** `.github/workflows/deploy.yml`, `src/__tests__/ci/deploy-workflow-protection.test.ts`, `__tests__/assert-cloudflare-credentials.test.ts`, Reports `30` & `31` (0 production application/treasury/ledger files modified).
- **PR #56 State:** `OPEN`, `isDraft: true`, `MERGEABLE`, 0 merge conflicts, 0 blocking reviews.
- **Repository Default Branch:** `feature/sprint4-email-automation-complete` (noted, not changed).

## 2. GitHub Branch Protection (`INCOMPLETE — BLOCKER`)
Live read-only API inspection (`repos/minhlongs/apex-os`):
- `GET /rulesets`: `[]` (0 active rulesets)
- `GET /rules/branches/master`: `[]` (0 effective rules)
- `GET /branches/master/protection`: HTTP 404 (`Branch not protected`)
- **Required Founder Settings for `master` Ruleset:**
  1. Active ruleset targeting `refs/heads/master`.
  2. Require pull request before merging (solo-Founder appropriate: `required_approving_review_count: 0` so solo Founder is not blocked on a nonexistent second reviewer).
  3. Require status checks to pass: **`Typecheck, Lint, Test & Worker Bundle`** (GitHub Actions).
  4. Block force pushes and block branch deletions.
  5. No unrestricted admin bypass.

## 3. Production Environment (`INCOMPLETE — BLOCKER`)
Live read-only API inspection (`GET /environments`):
- Present environments: `staging` only (`protection_rules: []`, `deployment_branch_policy: null`).
- Environment `production`: **DOES NOT EXIST**.
- **Required Founder Settings for `production` Environment:**
  1. Create environment named exactly **`production`**.
  2. Configure **Required reviewers** (Founder account; ensure solo-Founder review policy does not lock out self-approval when operating solo).
  3. Restrict **Deployment branches** to selected branch **`master`** only.
  4. *(Recommended follow-up, documented in Report 30)*: Split `CLOUDFLARE_API_TOKEN` from repository-scoped secret into separate environment-scoped secrets (`staging` vs `production`).

## 4. Workflow Safety (`VERIFIED — PASS`)
Full audit in `plans/reports/ascendancy-closure/30-G21-DEPLOYMENT-ROLLBACK-PROTECTION.md` and `src/__tests__/ci/deploy-workflow-protection.test.ts` (`5/5 PASS`):
- `deploy-staging` → `environment: staging` → `wrangler.staging.jsonc`
- `deploy-production` → `needs: [deploy-staging]` + `github.ref == 'refs/heads/master'` + `environment: production` → `wrangler.jsonc`
- `rollback-staging` → `environment: staging` → `wrangler.staging.jsonc`
- `rollback-production` → `github.ref == 'refs/heads/master'` + `environment: production` → `wrangler.jsonc`
- Trigger strictly `workflow_dispatch` only; `.github/workflows/ci.yml` contains zero deploy/rollback/D1 commands and preserves check name `Typecheck, Lint, Test & Worker Bundle`.

## 5. Cloudflare (`VERIFIED — NO MUTATION`)
- Confirmed `NO_EXTERNAL_AUTODEPLOY_CONFIRMED` (Cloudflare Pages `apex-os` has `Git Provider: No`; Worker deployments are manual upload/secret-change only; 0 GitHub webhooks; no Cloudflare GitHub App check-suites).
- Zero deployments, zero rollbacks, zero Worker or D1 mutations performed.

## 6. Treasury & Financial Boundaries (`VERIFIED — DISABLED`)
- `AUTO_SETTLE_PAYOUTS = "false"`, `V1_STELLAR_ONLY_PAYOUTS = "true"`, `PARTNER_KUCOIN_LIVE = false`, `PARTNER_GATEIO_LIVE = false`.
- Production Worker `wrangler secret list --name apex-os` confirmed `HSM_NOT_CONFIGURED` (`0/4` `TURNKEY_*` secrets present).
- All 7 deferred High findings (`H1`–`H7`) retain `High` severity and remain `0/7` reachable on source-only merge.
- Source-only merge is **NOT** production payment readiness.

## 7. CI & Local Verification
- **Local (Node `v26.7.0`):** `assert-staging-isolation.sh` (`STAGING_ISOLATED`), `typecheck` PASS, `lint` PASS, `CI=true npm test -- --silent` (`194/194` suites PASS, `3,927` passed, `1` skipped, `0` failed), `build:worker` PASS, YAML syntax `YAML_SYNTAX_OK`.
- **GitHub Actions (prior SHA `d79f3806`):** `push` run `45004923809` (`SUCCESS`) & `pull_request` run `45004927830` (`SUCCESS`).
- **GitHub Actions (new G21 SHA):** Verified fresh on push to `feat/ascendancy-phase2-verified` (run IDs recorded on PR #56 comment and final report).

## 8. Outstanding Blockers (Separated by Gate)
- **Source-Merge Blocker (ONLY ONE):** Founder configuring GitHub `master` ruleset + `production` environment (`HOLD_GITHUB_PROTECTION`).
- **Pre-Live-Cutover Blockers (Post-Merge PR A):** Turnkey bounded timeout + `DEFINITE_REJECTED` vs `UNCERTAIN_OUTCOME` (no blind retry), disable `StellarService.processBatchPayouts`, lossless `BigInt` + dust boundaries, migration `037` (`payout_id` trigger binding + hot finality timestamp), environment-scoped Cloudflare token split, remote D1 backup + sequential `031`–`036` rollout.
- **Public GA Blockers (Post-Merge PR B):** Persistent D1 rate limits on `/api/b2b/proof-of-rebate`, 192px/512px PNG PWA icons, GitHub Actions upgrade/SHA pinning + least-privilege permissions, fix skipped Resend test, runtime UI/legal wording updates.
- **Commercial Blockers (G18 Track):** Legal counsel memo, signed Bybit/OKX/Bitget affiliate agreements + read-only UID API keys, controlled 48h reconciliation experiment, 30-day real B2B pilot.
