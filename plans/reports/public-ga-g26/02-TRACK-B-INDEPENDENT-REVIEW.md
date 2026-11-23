# Track B Independent Security & Quality Review (G26.B6)

**Date:** 2026-11-23
**Worktree:** `/Users/macbook/apex-os-worktrees/track-b-pwa`
**Branch:** `fix/apex-public-pwa-ga-hygiene`
**Baseline SHA:** `eb2e1e55015458a3b6d14358cb2f8e42f29cbaf7`
**Final Re-Review Verdict:** `PASS` (0 unresolved Critical, High, or Medium findings)

---

## 1. Round 1 Independent Adversarial Review Panel (4 Roles)

| Reviewer | Scope | Round 1 Verdict | Blocking / Actionable Findings |
|----------|-------|-----------------|--------------------------------|
| **Reviewer A** | D1 Rate Limit & API Security | `FAIL` | H1: Pre-auth IP rate limit ran after `authorizeB2bProofCaller`; H2: `extractTrustedClientIp` fell back to spoofable `X-Real-IP` / `X-Forwarded-For` in prod/staging; H3: `g26-track-b-public-ga.test.ts` missing `ledger_accounts` caused allowed requests to return 500 masked by `not.toBe(429)` |
| **Reviewer B** | CI Workflow & SHA Pinning | `PASS_WITH_NOTES` | All 10 action pins verified against GitHub API (`actions/checkout@v7.0.1` + `actions/setup-node@v7.1.0`), least-privilege `contents: read`, exact ruleset check name `Typecheck, Lint, Test & Worker Bundle` preserved, `rollback-staging` isolation guard verified; M1: tighten workflow regex tests; L1: add `persist-credentials: false` |
| **Reviewer C** | PWA Manifest, Icons & A11y | `FAIL` | Binary PNG CRC/IHDR/maskable safe-area verified; H1: `middleware.ts` did not exclude `manifest.json`/`robots.txt` from locale redirect; H2: `ProofOfRebateVerifier` `useEffect` fired fetches on `#proof-api-key` keystrokes when `initialBatchId` was set; M1–M4: persistent live regions, `aria-required`/`aria-invalid`/`aria-describedby`, WCAG AA contrast (`text-slate-400`), mobile wrap & `break-all` |
| **Reviewer D** | Resend Test & Public Privacy | `PASS_WITH_NOTES` | Resend SDK deterministic mock verified (0 live calls, 0 skipped), PII/UID redaction & `Cache-Control: no-store` on all 14 branches verified; M1–M3 aligned with Reviewer A (fixture `ledger_accounts`, runtime 500 sanitization test, pre-auth IP rate limit) |

---

## 2. Remediation Applied

1. **`src/app/api/b2b/proof-of-rebate/route.ts`**: Enforced `b2b_proof_ip` (`120 req/60s`, hashed `cf-connecting-ip`, `failClosed: true`) **before** query/AI-tool parsing and `authorizeB2bProofCaller`, keeping `b2b_proof_caller` (`60 req/60s`) immediately after auth and `Cache-Control: no-store` on every return branch.
2. **`src/lib/security/d1-rate-limiter.ts`**: Restricted `extractClientIp` / `extractTrustedClientIp` under `isProductionOrStagingRuntime()` to read exclusively `cf-connecting-ip` (returning `'unknown'` when absent), keeping `x-real-ip`/`x-forwarded-for` fallbacks strictly for local dev/test.
3. **`src/middleware.ts`**: Excluded `manifest\.json` and `robots\.txt` from `config.matcher` negative lookahead.
4. **`src/components/b2b/proof-of-rebate-verifier.tsx`**: Guarded initial auto-verification with `lastAutoVerifiedBatchIdRef`; added persistent `role="status"` and `#proof-error` `role="alert"` live regions; wired `aria-required`, `aria-invalid`, `aria-describedby` on `#proof-batch-id`; upgraded `text-slate-500` to `text-slate-400` (>= 4.5:1 AA); added `flex-wrap gap-2`, `break-all`, and `aria-hidden="true"` on decorative icons.
5. **`.github/workflows/ci.yml` & `.github/workflows/deploy.yml`**: Added `persist-credentials: false` to all 5 `actions/checkout` steps while preserving exact 40-char SHAs, `contents: read`, and required check name `Typecheck, Lint, Test & Worker Bundle`.
6. **`__tests__/platform/g26-track-b-public-ga.test.ts` & `__tests__/lib/notifications/notification-channels.test.ts`**: Added `ledger_accounts` & `ledger_postings` tables in `beforeEach`; tightened allowed assertions to HTTP `200` + `Cache-Control: no-store`; added tests for pre-auth 121st-request `429`, `x-b2b-api-key` hashed `svc:` storage, cross-isolate persistence, runtime sanitized `500`, workflow write-permission rejection, and `middleware.ts` manifest exclusion; asserted `expect(mockFetch).not.toHaveBeenCalled()` in Resend email test.

---

## 3. Round 2 Isolated Re-Review Verdict

- **Verdict:** `PASS`
- **Remaining Critical / High / Medium Findings:** None.
- **Verification:** `typecheck` PASS, `lint` PASS, `assert-staging-isolation.sh` (`STAGING_ISOLATED`), `g26-track-b-public-ga.test.ts` + `notification-channels.test.ts` 43/43 passed (0 `SqliteError`), 15/15 related suites (244/244 tests) passed, `build:worker` PASS.
- **Release Gate Preserved:** `LIVE_SETTLEMENT=HOLD`, `REMOTE_D1_MIGRATION=NOT_AUTHORIZED`, `STAGING_DEPLOY=HOLD`, `PRODUCTION_DEPLOY=HOLD`, `PUBLIC_GA=HOLD`.
