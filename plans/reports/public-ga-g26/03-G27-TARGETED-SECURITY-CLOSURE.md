# G27 Targeted Security Closure Evidence Report (Track B)

- **Branch:** `fix/apex-public-pwa-ga-hygiene`
- **Worktree:** `/Users/macbook/apex-os-worktrees/track-b-pwa`
- **Date:** 2026-11-23
- **Scope:**
  - **G27.B1:** Close Missing Client-IP Pre-Auth Rate-Limit Gap on `GET /api/b2b/proof-of-rebate`
  - **G27.B2:** Remove Uncontrolled Runtime Schema Creation (`CREATE TABLE IF NOT EXISTS rate_limits`) in production/staging

---

## 1. G27.B1 — Production Ingress Admission Policy Matrix

Implemented in `src/app/api/b2b/proof-of-rebate/route.ts` (using `isProductionOrStagingRuntime()` from `src/lib/auth/runtime-env.ts` and `enforcePersistentD1RateLimit` from `src/lib/security/d1-rate-limiter.ts`):

| Ingress Path | Runtime | `cf-connecting-ip` | `x-b2b-api-key` | Pre-Auth Admission Policy | Durable D1 Bucket | D1 Session Lookup on Reject |
|---|---|---|---|---|---|---|
| Cloudflare custom domain | Production | Present (edge-set) | Optional | Admitted if `<= 120 req/60s`; else `429 RATE_LIMITED` (`Cache-Control: no-store`) | `b2b_proof_ip` (`ip:<sha256_32>`) | 0 (blocked before query parse & auth) |
| `*.workers.dev` edge | Production | Present (edge-set) | Optional | Admitted if `<= 120 req/60s`; else `429 RATE_LIMITED` (`Cache-Control: no-store`) | `b2b_proof_ip` (`ip:<sha256_32>`) | 0 |
| Staging routes | Staging | Present (edge-set) | Optional | Admitted if `<= 120 req/60s`; else `429 RATE_LIMITED` (`Cache-Control: no-store`) | `b2b_proof_ip` (`ip:<sha256_32>`) | 0 |
| Internal Worker-to-Worker / Service | Production / Staging | Missing / empty | Valid (`B2B_PROOF_API_KEY`, SHA-256 + `timingSafeEqual`) | Admitted if `<= 120 req/60s`; else `429 RATE_LIMITED` (`Cache-Control: no-store`) | `b2b_proof_svc_ingress` (`svc_ingress:<sha256_32>`) | 0 |
| Direct origin bypass / spoofed `X-Forwarded-For` / `X-Real-IP` / cookie-only without `cf-connecting-ip` | Production / Staging | Missing / empty / whitespace | Missing or invalid | **Rejected immediately** with `403 MISSING_TRUSTED_CLIENT_IP` (`Cache-Control: no-store`) BEFORE query/AI-tool parsing | None (no shared anonymous DoS bucket) | 0 |
| Local dev / CI test | Dev / Test (`!isProductionOrStagingRuntime()`) | Optional (falls back to `x-real-ip` / `x-forwarded-for` / `'unknown'`) | Optional | Never skipped — enforced at `120 req/60s` (`failClosed: true`) BEFORE query parse & auth | `b2b_proof_ip` (`ip:<sha256_32>`) | 0 |
| D1 rate-limit store error / missing table | Any (`failClosed: true`) | Any admitted path | Any admitted path | **Fail-closed** `503 RATE_LIMIT_STORE_UNAVAILABLE` (`Cache-Control: no-store`) | N/A | 0 |

---

## 2. G27.B2 — Runtime Schema Creation Removal Proof

Implemented in `src/lib/security/d1-rate-limiter.ts`:

- `ensureRateLimitsTable(db)` now immediately returns when `isProductionOrStagingRuntime()` is `true` without executing `CREATE TABLE IF NOT EXISTS rate_limits`.
- Production and staging schema MUST be provisioned exclusively via approved Migration `032` (`src/database/migrations/032_persistent_d1_rate_limits.sql`).
- When `rate_limits` is absent in production/staging, the atomic `INSERT ... ON CONFLICT(key) DO UPDATE ... RETURNING` throws `no such table: rate_limits`, and `enforcePersistentD1RateLimit` catches it under `strictRuntime = true` (`failClosed: true`) and returns `{ allowed: false, status: 503, source: 'fail-closed', errorCode: 'RATE_LIMIT_STORE_UNAVAILABLE' }` without mutating schema or falling back to in-memory stores.
- `src/lib/auth/runtime-env.ts` recognizes both `APP_ENV` and `APEX_ENVIRONMENT` (`production` / `staging`), plus `NODE_ENV=production`.
- Verified in `__tests__/platform/g27-track-b-security-closure.test.ts` (G27.B2 scenarios 1–5):
  - Spy on `db.prepare` confirms **0** `CREATE TABLE` statements in both `production` and `staging`.
  - Missing `rate_limits` table returns HTTP `503 RATE_LIMIT_STORE_UNAVAILABLE` + `Cache-Control: no-store`.
  - Approved Migration `032` schema returns HTTP `200` and preserves cross-isolate atomic counters.
  - Local dev/test fixtures (`!isProductionOrStagingRuntime()`) remain deterministic.

---

## 3. Local Verification Results

All commands executed with Node `v26.7.0` (`/opt/homebrew/opt/node@26/bin`):

| Command | Result |
|---|---|
| `npm run typecheck` | PASS (`tsc --noEmit` — 0 errors) |
| `npm run lint` | PASS (`eslint . --ext .ts,.tsx --max-warnings 0` — 0 errors, 0 warnings) |
| `bash scripts/assert-staging-isolation.sh` | PASS (`STAGING_ISOLATED`) |
| `npm test -- __tests__/platform/ src/__tests__/security/ src/__tests__/sandbox/g2-trust-boundary.test.ts` | PASS (5 suites passed, 54 tests passed, 0 failed) |
| `npm run build:worker` | PASS (OpenNext Cloudflare Worker built to `.open-next/worker.js`) |
