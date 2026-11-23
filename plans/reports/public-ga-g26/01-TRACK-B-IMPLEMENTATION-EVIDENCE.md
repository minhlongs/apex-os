# Track B — Public PWA / GA Hygiene Implementation Evidence (G26.B1–G26.B5)

- **Date:** 2026-11-23 (`Asia/Saigon`)
- **Worktree:** `/Users/macbook/apex-os-worktrees/track-b-pwa`
- **Branch:** `fix/apex-public-pwa-ga-hygiene`
- **Baseline Commit SHA:** `eb2e1e55015458a3b6d14358cb2f8e42f29cbaf7` (`master`)
- **Runtime:** Node.js `v26.7.0` (`better-sqlite3` ABI 147)

---

## 1. Changed Files

| File | Scope | Summary |
|------|-------|---------|
| `src/lib/security/d1-rate-limiter.ts` | G26.B1 | Added optional `failClosed?: boolean` to `PersistentRateLimitConfig` so callers can enforce strict fail-closed HTTP `503` regardless of `NODE_ENV`. |
| `src/app/api/b2b/proof-of-rebate/route.ts` | G26.B1 / G26.B5 | Replaced in-memory `checkSlidingWindowRateLimit` + `extractIpAddress` with durable D1 `enforcePersistentD1RateLimit` (`rate_limits` table from migration `032`), SHA-256 hashed caller/IP keys, trusted `cf-connecting-ip`-only IP bucket, fail-closed HTTP `503`, and RFC rate-limit + `Cache-Control: no-store` headers. |
| `public/assets/icons/icon-192.png` | G26.B2 | Generated valid `192×192` RGBA PNG (1,214 bytes) with ApexOS `#020617`/`#10b981` geometric emblem inside 80% maskable safe zone. |
| `public/assets/icons/icon-512.png` | G26.B2 | Generated valid `512×512` RGBA PNG (4,409 bytes) with ApexOS `#020617`/`#10b981` geometric emblem inside 80% maskable safe zone. |
| `public/manifest.json` | G26.B2 | Aligned `background_color`/`theme_color` to `#020617` and split `icons` into explicit W3C `any` and `maskable` entries for `192×192` and `512×512`. |
| `.github/workflows/ci.yml` | G26.B3 | Added least-privilege `permissions: { contents: read }` at workflow + job level, pinned `actions/checkout` and `actions/setup-node` to immutable 40-char SHAs, preserved exact check name `Typecheck, Lint, Test & Worker Bundle`. |
| `.github/workflows/deploy.yml` | G26.B3 | Added least-privilege `permissions: { contents: read }` at workflow + all 4 jobs, pinned all actions to 40-char SHAs, added `bash scripts/assert-staging-isolation.sh` before `wrangler rollback` in `rollback-staging`. |
| `__tests__/lib/notifications/notification-channels.test.ts` | G26.B4 | Un-skipped Resend email channel test and aligned mock assertions with `new Resend(apiKey)` string constructor and `createMockAlertConfig()` subject (`Test Alert`). |
| `src/components/b2b/proof-of-rebate-verifier.tsx` | G26.B5 | Added `aria-label` on form, `htmlFor`/`id` label-input bindings, `role="alert"` + `aria-live="assertive"` on errors, `role="region"` + `aria-live="polite"` on proof output, and `focus-visible:ring-2` keyboard focus styles. |
| `__tests__/platform/g26-track-b-public-ga.test.ts` | G26.B1–B5 | Added 12 adversarial & regression tests covering durable D1 rate limiting, PWA binary PNG/manifest checks, workflow SHA/isolation static validation, and WCAG/ARIA semantics. |

---

## 2. G26.B1 — Durable D1 Rate Limit Atomicity & Security Evidence

- **Atomic SQL:** Reuses `enforcePersistentD1RateLimit` (`src/lib/security/d1-rate-limiter.ts`), executing a single `INSERT INTO rate_limits (...) VALUES (...) ON CONFLICT(key) DO UPDATE SET current_count = CASE WHEN reset_at <= excluded.created_at THEN 1 ELSE current_count + 1 END ... RETURNING current_count, reset_at` against migration `032` (`rate_limits`).
- **Keying & Spoof Resistance:**
  - Caller bucket (`b2b_proof_caller`, 60 req/60s): `user:<sha256(userId)[0..32]>` or `svc:<sha256(apiKey)[0..32]>`. Rotating `X-Forwarded-For` / `X-Real-IP` cannot bypass this limit; zero raw PII or API keys are persisted in `rate_limits`.
  - Trusted Edge IP bucket (`b2b_proof_ip`, 120 req/60s): applied only when Cloudflare's `cf-connecting-ip` header is present, keyed by `ip:<sha256(cfIp)[0..32]>`.
- **Fail-Closed:** `failClosed: true` returns HTTP `503` (`RATE_LIMIT_STORE_UNAVAILABLE`) with `Cache-Control: no-store` whenever D1 is missing or throws on write.

---

## 3. G26.B2 — PWA Asset & Manifest Verification

| Asset | Size (bytes) | PNG Magic (`89 50 4E 47 0D 0A 1A 0A`) | IHDR Dimensions | Manifest Purpose |
|-------|--------------|---------------------------------------|-----------------|------------------|
| `public/assets/icons/icon-192.png` | 1,214 | Verified | `192 × 192` | `any`, `maskable` |
| `public/assets/icons/icon-512.png` | 4,409 | Verified | `512 × 512` | `any`, `maskable` |

- `public/manifest.json`: valid JSON, `display: "standalone"`, `start_url: "/en"`.
- `src/app/[locale]/layout.tsx`: declares `manifest: '/manifest.json'` and `icons.apple: '/assets/icons/icon-192.png'`.

---

## 4. G26.B3 — GitHub Actions SHA Pinning Table

| Action | Official Release Tag | Immutable 40-char Commit SHA | Workflows |
|--------|----------------------|------------------------------|-----------|
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `ci.yml`, `deploy.yml` |
| `actions/setup-node` | `v7.1.0` | `949feb2413d6458794dcd2491c4babbbce0c15c1` | `ci.yml`, `deploy.yml` |

- `ci.yml` check name preserved verbatim: `Typecheck, Lint, Test & Worker Bundle`.
- `deploy.yml` remains `workflow_dispatch`-only, `deploy-production` and `rollback-production` gated on `refs/heads/master`, and `rollback-staging` now runs `bash scripts/assert-staging-isolation.sh` prior to `wrangler rollback`.

---

## 5. G26.B4 — Resend Skipped Test Root Cause & Fix

- **Root Cause:** `__tests__/lib/notifications/notification-channels.test.ts` had `it.skip('should send email via Resend when channel is email')` because the test asserted `MockResend` was called with `{ apiKey: 'test-key' }` and `subject` containing `'Revenue Drop Alert'`, whereas `EmailNotifier.getResend()` (`src/lib/emails/notifier.ts:86`) constructs `new Resend(apiKey)` with a string argument and `createMockAlertConfig()` sets `name: 'Test Alert'`.
- **Fix:** Removed `it.skip` and aligned the deterministic mock assertions to `expect(MockResend).toHaveBeenCalledWith('test-key')`, `from: expect.stringContaining('ApexOS')`, and `subject: expect.stringContaining('Test Alert')`. No live network calls are made.

---

## 6. G26.B5 — Public API Privacy & Accessibility Audit

- `/api/b2b/proof-of-rebate`: enforces `x-b2b-api-key` (constant-time SHA-256 `timingSafeEqual`) or Better Auth session, tenant-scoped `batchId`/`affiliateId` IDOR checks (`403 FORBIDDEN_TENANT_SCOPE`), masked trader UID (`***1234`), sanitized error bodies, and `Cache-Control: no-store` on all responses.
- `src/components/b2b/proof-of-rebate-verifier.tsx`: remediated missing `htmlFor`/`id` bindings, missing `role="alert"` / `aria-live="assertive"` on errors, missing `role="region"` / `aria-live="polite"` on proof output, and missing `focus-visible` keyboard rings.

---

## 7. Local Verification Results (Node v26.7.0)

| Command | Result | Details |
|---------|--------|---------|
| `npm run typecheck` | PASS | 0 TypeScript errors |
| `npm run lint` | PASS | 0 ESLint errors, 0 warnings (`--max-warnings 0`) |
| `CI=true npm test` | PASS | **201 passed / 201 suites**, **4,006 passed / 4,006 tests**, **0 skipped**, **0 failed** |
| `bash scripts/assert-staging-isolation.sh` | PASS | `STAGING_ISOLATED` |
| `npm run build` | PASS | 112/112 static pages generated, 0 errors |
| `npm run build:worker` | PASS | OpenNext Worker saved to `.open-next/worker.js` |

---

## 8. Remaining Public GA Blockers (Outside Track B)

- None within Track B scope. Track C (treasury/payout migrations & signing) and remote Cloudflare deployment / D1 migration execution remain outside Track B ownership.
