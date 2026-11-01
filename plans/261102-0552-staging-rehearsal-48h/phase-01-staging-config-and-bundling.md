# Phase 1: Align Staging KV, Worker Bundling & CI Config

## Context
- `wrangler.staging.jsonc` and `scripts/assert-staging-isolation.sh` currently reference placeholder KV ID `e8f7a6b5c4d3210987654321fedcba09` instead of real `KV_STAGING` (`f2cf595dec5543dc96f6370bebbc8754`).
- `package.json` and `.github/workflows/deploy.yml` call `opennextjs-cloudflare deploy`, which bundles `.open-next/worker.js` directly instead of `worker-wrapper.js`, dropping `PaperTradingDurableObject`.

## Files
- `wrangler.staging.jsonc`
- `scripts/assert-staging-isolation.sh`
- `package.json`
- `.github/workflows/deploy.yml`

## Steps
1. Update `wrangler.staging.jsonc` KV namespace ID to `f2cf595dec5543dc96f6370bebbc8754`.
2. Update `scripts/assert-staging-isolation.sh` `STAGING_KV_ID` to `f2cf595dec5543dc96f6370bebbc8754`.
3. Update `package.json`:
   - `build:worker`: auto-populate `NEXT_PUBLIC_COMMIT_SHA` and `NEXT_PUBLIC_BUILD_TIME` when unset.
   - `deploy:staging` & `deploy:production`: use `wrangler deploy --config ...` after `npm run build:worker`.
4. Update `.github/workflows/deploy.yml`:
   - Use `./node_modules/.bin/wrangler deploy --config ...` for staging and production.
   - Default staging verification URL to `https://apex-os-staging.agencyos-openclaw.workers.dev`.

## Validation
- `bash scripts/assert-staging-isolation.sh` outputs `STAGING_ISOLATED`.
- `ALLOW_DIRTY_TREE=1 npm run gate` passes 29/29 checks.
