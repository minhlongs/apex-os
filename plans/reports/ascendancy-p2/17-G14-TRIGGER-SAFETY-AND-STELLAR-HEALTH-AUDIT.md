# 17 — Gate G14 Deployment Trigger Safety & Zero-Secret Stellar Health Audit

- **Date:** 2026-11-18 (`Asia/Saigon`)
- **Worktree:** `/Users/macbook/apex-os-worktrees/phase2-ascendancy`
- **Branch:** `feat/ascendancy-phase2-verified`
- **Base Commit (`origin/master`):** `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d`
- **Verdict:** **PASS — SAFE FOR BRANCH PUSH & DRAFT PR (`--base master`)**

---

## 1. Gate G14.4 — GitHub & Cloudflare Auto-Deploy Trigger Audit

Read-only verification across `.github/workflows/`, GitHub REST API (`minhlongs/apex-os`), and Cloudflare Workers/Pages metadata confirms that pushing `feat/ascendancy-phase2-verified` or opening a Draft PR into `master` **cannot** mutate staging or production:

| Surface | Observed Configuration | Trigger Verdict |
|---|---|---|
| `.github/workflows/ci.yml` | `on: push` (`feat/**`, `master`, etc.) & `pull_request` (`master`, etc.). Runs `npm ci`, `assert-staging-isolation.sh`, `typecheck`, `lint`, `CI=true npm test`, `build:worker`. Zero `wrangler deploy`, zero `d1 execute --remote`, zero Cloudflare secrets. | **SAFE (Read-Only Build/Test)** |
| `.github/workflows/deploy.yml` | `on: workflow_dispatch` **only** (both in worktree and on `origin/master`). Zero `push`, `pull_request`, `pull_request_target`, or `workflow_run` triggers. Unowned `https://apex-os.com` replaced with `${{ vars.PRODUCTION_URL \|\| 'https://apex-os.agencyos-openclaw.workers.dev' }}`. | **SAFE (Manual Dispatch Only)** |
| GitHub Webhooks (`repos/minhlongs/apex-os/hooks`) | `[]` (`0` webhooks) | **SAFE** |
| GitHub Pages (`repos/minhlongs/apex-os/pages`) | `404 Not Found` (disabled) | **SAFE** |
| External Commit Check-Runs / Statuses | Only `github-actions` (`Typecheck, Lint, Test & Worker Bundle`); `0` Cloudflare Workers Builds GitHub App check-runs or commit statuses. | **SAFE** |
| Cloudflare Workers (`apex-os`, `apex-os-staging`) | `wrangler deployments list` shows `Upload` / `Secret Change` / CLI deployments only; zero Git-integrated deployments. | **SAFE** |
| Cloudflare Pages (`apex-os` / `apex-os-317.pages.dev`) | `Git Provider: No` (`"source": null`, `"latest_deployment_trigger": "ad_hoc"`). | **SAFE** |

### Operational Guardrails for PR Creation
1. **Explicit `--base master` Required:** GitHub repository `default_branch` is still set to stale `feature/sprint4-email-automation-complete`. Always invoke `gh pr create --draft --base master --head feat/ascendancy-phase2-verified` so the PR targets `master` (`f4285c5d...`).
2. **Branch Protection Recommended:** `repos/minhlongs/apex-os/branches/master/protection` currently returns `404` and `rulesets` is `[]`. Enabling required status checks (`verify`) and PR review on `master` is recommended post-PR creation.

---

## 2. Gate G6 / G8 — Strict Read-Only Stellar Horizon Health Boundary

All admin Stellar health, settings, and connection-test surfaces now enforce a strict zero-raw-secret boundary in Cloudflare Worker memory:

- **`src/app/api/admin/settings/stellar/health/route.ts`** and **`src/lib/admin/stellar-actions.ts`** (`getStellarSettings()`, `testStellarConnection()`):
  - Removed all `process.env.STELLAR_SECRET_KEY` fallbacks.
  - Require a valid Ed25519 Stellar public account ID (`G...`, verified via `isValidStellarAccountId()`) from `TURNKEY_STELLAR_HOT_WALLET_ADDRESS` (or KV `senderAccountId`).
  - Reject accidentally pasted `S...` secret seeds without logging or returning raw secret values.
- **`src/lib/payouts/stellar-service.ts`**:
  - Added `sanitizeStellarDiagnosticError()` to redact any `S...` secret seeds or `STELLAR_SECRET_KEY=...` tokens from diagnostic strings.
  - Redacted invalid `senderPublicKey` values and `Keypair.fromSecret` parse error details in `StellarService` constructor logs.
  - Updated `createStellarService()` to prefer `TURNKEY_STELLAR_HOT_WALLET_ADDRESS` before reading `STELLAR_SECRET_KEY`.
- **`__tests__/payouts/stellar-readonly-health.test.ts`**:
  - Added 4 dedicated tests proving Horizon reachability, sender existence, XLM/USDC balances via public account ID, refusal to touch `STELLAR_SECRET_KEY`, and redaction of `S...` secret seeds across responses and `console.error`.
