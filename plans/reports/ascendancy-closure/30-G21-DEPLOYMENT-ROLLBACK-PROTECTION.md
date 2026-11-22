# 30 — G21 Deployment & Rollback Protection Audit

**Date:** 2026-11-22  
**Workflow Audited:** `.github/workflows/deploy.yml` (and `.github/workflows/ci.yml`)  
**Regression Test:** `src/__tests__/ci/deploy-workflow-protection.test.ts` (`5/5 PASS`)  
**YAML Validation:** `python3 -I` `yaml.safe_load` (`YAML_SYNTAX_OK`)

---

## 1. Confirmed Defect Before Fix
In `.github/workflows/deploy.yml` (prior lines `139–171`), the single `rollback` job handled both `rollback-staging` and `rollback-production` **without an `environment:` binding** and **without a `github.ref == 'refs/heads/master'` branch guard**. Consequently, even after configuring required reviewers on the `production` GitHub environment, an operator with `workflow_dispatch` permission could invoke `action: rollback-production` from any branch and execute `wrangler rollback --config wrangler.jsonc -y` while bypassing the `production` approval gate.

---

## 2. Action-to-Environment Coverage Matrix (After Fix)

| Workflow Action (`workflow_dispatch`) | Job Name | Branch / Precondition Guard | GitHub Environment | Remote Target Config |
|---|---|---|---|---|
| `deploy-staging` | `deploy-staging` | `action == 'deploy-staging' \|\| action == 'deploy-production'` | `staging` | `wrangler.staging.jsonc` (`apex-os-staging`) |
| `deploy-production` | `deploy-production` | `needs.deploy-staging.result == 'success' && action == 'deploy-production' && github.ref == 'refs/heads/master'` | **`production`** | `wrangler.jsonc` (`apex-os`) |
| `rollback-staging` | `rollback-staging` | `action == 'rollback-staging'` | `staging` | `wrangler.staging.jsonc` (`apex-os-staging`) |
| `rollback-production` | `rollback-production` | `action == 'rollback-production' && github.ref == 'refs/heads/master'` | **`production`** | `wrangler.jsonc` (`apex-os`) |

- **Zero unprotected production mutation paths remain** in `.github/workflows/deploy.yml` or `.github/workflows/ci.yml`.
- **Rollback functionality is fully preserved** for both staging and production under their respective environment gates.

---

## 3. Credential Boundary Audit & Least-Privilege Split Design

### Current Risk (Documented — Credentials Not Modified)
Both `staging` jobs (`deploy-staging`, `rollback-staging`) and `production` jobs (`deploy-production`, `rollback-production`) currently reference the same secret names (`secrets.CLOUDFLARE_API_TOKEN`, `secrets.CLOUDFLARE_ACCOUNT_ID`). If `CLOUDFLARE_API_TOKEN` is stored as a **repository-scoped secret** with Workers Edit permissions across the entire account, then any workflow run entering `staging` (including from an unreviewed feature branch) can technically read a token capable of mutating the production Worker.

### Target Least-Privilege Split (Requires Separate Founder Execution)
1. **Remove repository-scoped `CLOUDFLARE_API_TOKEN`** after creating two environment-scoped tokens in Cloudflare Dashboard (scoped strictly to the target Worker / D1 resource where supported, or separate Cloudflare accounts/zones):
   - GitHub Environment `staging` → environment secret `CLOUDFLARE_API_TOKEN` (staging-only token).
   - GitHub Environment `production` (restricted to `master` + required reviewer) → environment secret `CLOUDFLARE_API_TOKEN` (production-only token).
2. Because GitHub does not release environment secrets until **both** the branch policy (`master`) **and** required reviewer approvals pass, feature-branch runs can never obtain production Cloudflare credentials.

---

## 4. Emergency Break-Glass Rollback Procedure
When a production incident requires immediate rollback and GitHub Actions is degraded or unavailable:
1. **Operator:** Founder (or explicitly designated on-call with Cloudflare Super Admin / Workers Edit MFA access).
2. **Pre-Action Log:** Record incident timestamp, target previous Worker version ID (`wrangler deployments list --name apex-os`), and reason in the incident log before running any command.
3. **Command:** Run `wrangler rollback --config wrangler.jsonc` locally with MFA-authenticated Wrangler session (never weaken GitHub `production` environment approvals to bypass review).
4. **Post-Action Audit:** Capture resulting deployment ID, verify `/api/version` and `/api/health`, and append a post-mortem entry under `plans/reports/`.
