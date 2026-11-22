# 05 — G23.5 Cloudflare Token Segmentation Plan

**Date:** 2026-11-22  
**Branch:** `fix/apex-pre-live-cutover-hardening`  
**Status:** `TOKEN_SEGMENTATION_PLAN_READY`  
**Execution Boundary:** **Documentation-only plan.** Zero Cloudflare API calls, zero token creation/rotation, zero DNS or Worker secret mutations, and zero inspection of real secret values were performed.

---

## 1. Purpose & Least-Privilege Principle

GitHub `production` environment protection prevents unauthorized workflow runs, but does not by itself enforce least privilege inside Cloudflare. A single broad `CLOUDFLARE_API_TOKEN` with account-wide `Workers + D1 + R2 + DNS` write permissions would allow a staging workflow or compromised CI job to mutate production D1 or production Workers.

All Cloudflare credentials must be segmented by **environment** (`staging` vs `production`) and by **capability** (Worker deploy vs D1 migration vs read-only observability), with **zero** shared write tokens between staging and production.

---

## 2. Required Token Matrix

| Token Name (GitHub Secret) | Environment Scope | Exact Cloudflare Permissions | Explicit Exclusions | Storage Location |
|---|---|---|---|---|
| `CF_TOKEN_STAGING_DEPLOY` | Staging only | `Workers Scripts: Edit` (restricted to staging Worker `apex-os-staging`), `Workers KV/R2: Read` (staging buckets) | No D1 Write, no Production Worker access, no DNS, no Account Settings | GitHub `staging` environment secret |
| `CF_TOKEN_STAGING_D1_MIGRATE` | Staging only | `D1: Edit` (restricted to staging D1 database `apex-os-staging-db`) | No Production D1, no Workers deploy, no DNS, no R2 write | GitHub `staging-db` environment secret (manual dispatch only) |
| `CF_TOKEN_PROD_DEPLOY` | Production only | `Workers Scripts: Edit` (restricted to production Worker `apex-os`), `Workers Routes: Read` | No D1 Write, no Staging Worker, no DNS Edit, no Token/IAM management | GitHub `production` environment secret (required Founder reviewer) |
| `CF_TOKEN_PROD_D1_MIGRATE` | Production only | `D1: Edit` (restricted to production D1 database `apex-os-db`) | No Workers deploy, no Staging D1, no DNS, no R2 delete | Founder-controlled break-glass / `production-db` environment secret (dual-gate manual dispatch) |
| `CF_TOKEN_READONLY_AUDIT` | Read-only (Staging + Prod) | `Workers Scripts: Read`, `D1: Read`, `R2: Read`, `Account Analytics: Read` | Zero Write/Edit/Delete permissions across all resources | CI / Ops read-only audit environment |

---

## 3. Hard Isolation Rules
1. **No D1 write in Worker deploy tokens:** `deploy.yml` never runs D1 migrations; separating `*_DEPLOY` from `*_D1_MIGRATE` ensures a deployment job cannot execute DDL or mutate financial tables.
2. **No DNS or Zone Edit in CI tokens:** DNS and custom domain routing remain manual Founder dashboard actions only.
3. **No Turnkey HSM secrets in CI/GitHub Actions:** `TURNKEY_API_PRIVATE_KEY` and `TURNKEY_ORGANIZATION_ID` must never be stored in GitHub Actions or wrangler config files — they belong exclusively in encrypted Cloudflare Worker runtime secrets provisioned directly by the Founder after PR A + staging soak sign-off.
4. **TTL & IP/Condition Restrictions:** Where supported by Cloudflare API Tokens, restrict `*_DEPLOY` and `*_D1_MIGRATE` tokens with expiration dates (90-day rotation cadence) and audit-log alerting on every use.

---

## 4. Rollout & Verification Checklist (Founder-Executed Later — NOT Executed Here)
1. Create the 5 scoped tokens in Cloudflare Dashboard → Manage Account → Account API Tokens using the exact table above.
2. Verify each token's scope via Cloudflare's `/user/tokens/verify` endpoint and a negative permission check (confirm `CF_TOKEN_STAGING_DEPLOY` receives `403` against production Worker and staging D1).
3. Populate the corresponding GitHub Environment secrets (`staging`, `staging-db`, `production`, `production-db`) with required reviewer approvals on `production` and `production-db`.
4. **Prerequisite before legacy token revocation:** Open and merge a dedicated follow-up workflow PR updating `.github/workflows/deploy.yml` to map `CF_TOKEN_STAGING_DEPLOY`, `CF_TOKEN_PROD_DEPLOY`, and `CF_TOKEN_READONLY_AUDIT` (for the `deploy-production` staging D1 `SELECT` verification step at `deploy.yml:111-119`) instead of the legacy `CLOUDFLARE_API_TOKEN`.
5. Revoke any legacy broad `CLOUDFLARE_API_TOKEN` only after the `deploy.yml` secret-wiring PR is merged and a staging dry-run deploy succeeds with `CF_TOKEN_STAGING_DEPLOY`.
6. Record token IDs (never token values) and rotation due dates in the Founder ops register.
