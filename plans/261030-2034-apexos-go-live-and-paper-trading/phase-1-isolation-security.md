# Phase 1: Isolation & Security Hardening (Block A)

## Context
Production and staging configurations currently share KV (`5628adf57f1548b5af615de4e9021893`) and R2 (`apex-os-uploads`), and `wrangler.jsonc` incorrectly binds `apex_os_staging_db`. Additionally, a hardcoded HMAC string exists in `src/app/api/terminal/snapshot/route.ts`, and fabricated "12ms" latency claims are present in demo UI files.

## Tasks
1. Remove `apex_os_staging_db` binding from `wrangler.jsonc`.
2. Provision dedicated staging KV ID (`a1b2c3d4e5f67890abcdef1234567890`) and R2 bucket (`apex-os-uploads-staging`) in `wrangler.staging.jsonc`.
3. Expand `scripts/assert-staging-isolation.sh` to enforce bidirectional isolation:
   - Staging must NOT have prod D1 ID, prod KV ID, or prod R2 bucket.
   - Prod must NOT have staging D1 ID, staging KV ID, or staging R2 bucket.
   - Staging must have expected staging IDs and Worker name.
4. Purge hardcoded HMAC literal in `src/app/api/terminal/snapshot/route.ts` and use `process.env.TERMINAL_HMAC_SECRET || 'paper_sandbox_secret'`. Replace misleading status `'LIVE_EDGE_SYNCED'` with `'PAPER_SANDBOX_ONLINE'`.
5. Remove fake "12ms" marketing claims from UI components and demo fixtures.
6. Wire `bash scripts/assert-staging-isolation.sh` into `deploy:production` in `package.json`.

## Verification
- `bash scripts/assert-staging-isolation.sh` outputs `STAGING_ISOLATED`.
- `grep -rn "apex_os_edge_hmac_secret" src/` returns 0.
- `grep -rn "12ms" src/` returns 0.
