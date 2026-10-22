# Phase 02 — Restore the Type-Check Gate

## Overview
- **Priority**: P1
- **Status**: completed
- **Effort**: 5h
- **Blocks**: Phase 06
- **Depends on**: Phase 01

Two independent defects make the type gate inert. Both must be fixed, and fixing either alone is insufficient.

## Key Insights
**Defect A — the build bypasses types.** `package.json:7`:
```json
"build": "NEXT_DISABLE_TYPE_CHECK=1 next build",
```
This env var disables Next's built-in type-check pass. A commit containing type errors still produces a production bundle. CI currently cannot fail on types during build.

**Defect B — the compiler is in lax mode.** `tsconfig.json:16` sets `"strict": false`. Verified consequence: `npx tsc --noEmit` exits 0 today, yet `npx tsc --noEmit --strict` reports **113 errors** (measured this session). Raw `tsc` was never a gate at all.

**Error distribution under `--strict`** (measured, 113 total):
| Code | Count | Meaning |
|------|-------|---------|
| TS2322 | 48 | type-not-assignable — genuine likely bugs |
| TS18048 | 26 | possibly-null/undefined deref |
| TS7017 | 14 | implicit-any / element-implicit-any |
| TS18047 | 11 | null/undefined-not-possibly-null |
| TS2345 | 7 | argument type mismatch |
| TS7053 | 2 | implicit-any index access |
| TS7006 | 2 | implicit-any parameter |
| TS2366, TS2783 | 3 | function-shape mismatch |

**Top offending files** (measured): `src/lib/metrics/business-metrics-fetcher.ts` (25), `src/lib/ratelimit/kv-rate-limiter.ts` (11), `src/lib/metrics/cache.ts` (9), `src/lib/monitoring/alert-engine.ts` (7), `src/lib/analytics/cloudflare-analytics.ts` (7), `src/lib/metrics/business-metrics.ts` (6).

**Defect C — earnings is excluded from type-checking entirely.** `tsconfig.json:61`:
```json
"src/lib/earnings/**"
```
The commission calculator (1066 LOC across `calculator.ts`, `types.ts`, `index.ts`) is invisible to `tsc`. Money-critical code must not be outside the gate.

**Defect D — `src/app/api/admin/health` excluded** (`tsconfig.json:60`) and `scripts/` excluded (`tsconfig.json:49`). Both exclusions predate this plan; assess, do not blindly widen.

**Defect D resolution (verified):** `src/app/api/admin/health` does not exist on disk — the exclusion was dead referent, so removing it is unambiguous and costs nothing. `scripts/` is real and deliberate: including it surfaces **60 strict errors** that are unrelated to the go-live surface, so it stays excluded by decision (recorded here rather than removed silently). The `src/lib/earnings/**` exclusion (Defect C) has been removed and the directory type-checks clean.

**Not a defect, verified**: `tsconfig.json:35` has `"target": "ES2017"`. Do **not** raise it to chase modern syntax — that risks changing runtime semantics on Workers (`compatibility_date` is pinned). Leave it.

## Requirements
### Functional
- F1. `npm run build` must run Next's type check (remove `NEXT_DISABLE_TYPE_CHECK=1`).
- F2. `npx tsc --noEmit` must fail on any type error repo-wide in CI.
- F3. `src/lib/earnings/**` must be inside the type-check scope.
- F4. Every suppressed route (`.next/types` route validators) must still validate — i.e. exports of protected routes must type-check against Next's generated route types.
- F5. Zero new `:any` introduced while fixing. Existing `: any` count is 221 (measured, non-test); this phase must **not increase** it, and must reduce it in the files it touches.

### Non-Functional
- NF1. No behavioral change. Every change is a type-level fix; runtime semantics preserved.
- NF2. The phase must be **individually landable per directory**, so a bad commit can be reverted without losing the whole gate restoration.
- NF3. Gate must be strict **by default**, not opt-in.

## Architecture
The gate is restored in a specific order to avoid an unreadable batch:

```
Step 1: Fix the 113 strict errors (small, tractable — NOT thousands)
Step 2: Flip tsconfig strict:false → strict:true
Step 3: Remove NEXT_DISABLE_TYPE_CHECK=1 from build
Step 4: Remove src/lib/earnings/** from exclude
Step 5: Add type-check + build as CI-required (blueprint; wired in Phase 05)
```

**Why flip strict rather than adding per-flag checks:** `strict` is the single canonical switch. Enabling the five sub-flags individually invites partial states (`strictNullChecks` on, `noImplicitAny` off) that are harder to reason about than one boolean. KISS.

**On the 113 errors:** these are concentrated in 20 files and are largely TS2322/TS18048 — null-safety and assignability. Several will be **real latent bugs** (e.g. `payouts-service.ts:90` assigning `PayoutRecord | null` where `PayoutRecord` is required). That is the point of the exercise. Any fix that changes runtime behavior must be flagged in the phase report and get a regression test, not silently coerced.

**Strict-mode landing strategy (the "no revert" property):**
- Land error fixes as several small commits grouped by directory, each independently green under `tsc --noEmit --strict <file set>`.
- The `tsconfig.json` flip is a **single atomic commit** that must be immediately preceded by a fully-green commit. If it goes wrong, `git revert` restores `strict: false` while retaining all type fixes already merged — fixes are kept, only the flag reverts. Nothing is lost.
- This is why fixing errors *before* flipping the flag matters: forward-only rewrite avoidance.

**Do not use `@ts-expect-error` / `@ts-ignore`** to make errors disappear. Each suppression hides one of the 113 findings. If a fix is genuinely blocked (e.g. an untyped third-party boundary), it must be an explicit, commented `// @ts-expect-error — reason` with the reason named. Report suppression count in phase output.

## Related Code Files
### Modify
- `/Users/macbook/apex-os/tsconfig.json` — `strict: false` → `true` (line 16); remove `"src/lib/earnings/**"` from `exclude` (line 61).
- `/Users/macbook/apex-os/package.json` — line 7, remove `NEXT_DISABLE_TYPE_CHECK=1`; add `typecheck` script.
- `src/lib/payouts/payouts-service.ts:90` — real null-assignability bug, must be fixed with a guard/exhaustive check, not a cast.
- The 20 strict-error files listed in Key Insights (fix each null/assignability issue at the type level).

### Create
- `/Users/macbook/apex-os/.github/workflows/ci.yml` — **blueprint only**; this phase creates the file so the type gate is expressed, but full wiring (Node pin, matrix, deploy) is Phase 05. Content limited to `typecheck` + `lint` + `test` jobs so it is independently runnable.

### Delete
- *(none)*. `wrangler.toml` removal is deliberately **not** here — it is Phase 03 config-collapse scope.

## Implementation Steps
1. **Baseline & snapshot.** Capture the current 113-error list to a scratch file for progress tracking (do not commit it):
   ```bash
   export PATH=/opt/homebrew/opt/node@26/bin:$PATH
   npx tsc --noEmit --strict 2>&1 | grep "error TS" > /tmp/pre-strict-errors.txt
   wc -l /tmp/pre-strict-errors.txt   # expect 113
   ```
2. **Fix `payouts-service.ts:90` first** (money path, highest impact). Read the surrounding function, determine why a `null` `PayoutRecord` can reach an assignment typed non-null, and add a real guard that throws or returns a failure result. Do **not** add `!` (non-null assertion) — that silences the exact null-safety issue this phase exists to catch. If the correct behavior on null is ambiguous, STOP and surface it; do not guess money semantics.
3. **Fix remaining errors grouped in this commit order**, smallest blast radius first, verifying after each group:
   1. `src/lib/payouts/payouts-service.ts` (money)
   2. `src/lib/metrics/business-metrics.ts`, `business-metrics-fetcher.ts`, `cache.ts` (metrics total 40)
   3. `src/lib/ratelimit/kv-rate-limiter.ts`, `rate-limiter.ts`, `rate-limiter-token-bucket.ts` (13) — **note**: `src/lib/ratelimit/middleware.ts` backs `/api/webhooks/exchange`; protected-flow risk. Do not alter control flow, only types.
   4. `src/lib/monitoring/alert-engine.ts`, `src/app/api/cron/route.ts` (10) — cron is a protected flow.
   5. `src/lib/fraud/fraud-engine.ts`, `src/lib/emails/email-queue.ts`, `src/lib/auth/adapters/d1-adapter.ts`, `src/lib/arbitrage/arbitrage-engine.ts`
   6. UI: `src/app/[locale]/**`, `src/components/**`
   Verify after each: `npx tsc --noEmit --strict 2>&1 | grep -c "error TS"` must strictly decrease.
4. **Flip the gate.** After the count is 0, edit `tsconfig.json`:
   - Line 16: `"strict": false` → `"strict": true`
   - Delete line 61: `"src/lib/earnings/**"`
   Then immediately validate. New errors may surface from earnings (previously invisible) — **fix them in the same commit** before declaring step 4 done; if volume is large, land types-only earnings fixes in a preceding commit and keep line 61 removed only once earnings is clean.
5. **Remove the build bypass.** Edit `package.json:7`:
   ```json
   "build": "next build",
   ```
   Add scripts:
   ```json
   "typecheck": "tsc --noEmit",
   "verify": "npm run typecheck && npm run lint && npm test"
   ```
6. **Run the real build for the first time.** This is the first genuine `next build` in the project's history:
   ```bash
   npm run build
   ```
   Expect failures unrelated to types (missing env, `.open-next` asset steps). **Record every non-type build failure** — these are Phase 05's rehearsal backlog. Do not fix build-system issues in this phase; classify them: (a) env/config → Phase 05, (b) genuine app defect → fix here with a test, (c) pre-existing Next 16 behavior → document.
7. **Create the CI blueprint** `.github/workflows/ci.yml` with three jobs — `typecheck` (`npx tsc --noEmit`), `lint`, `test` — each with `export PATH=/opt/homebrew/opt/node@26/bin:$PATH` and `node --version` echo. Use `setup-node` pinned to `26.7.0`. Do **not** reference a deploy job yet.
8. **Assert no new `:any`**:
   ```bash
   grep -rn ": any\b\|as any\b" src --include="*.ts" --include="*.tsx" | grep -v __tests__ | wc -l
   ```
   Must be ≤ 221 and strictly lower in files this phase touched.

## Todo List
- [ ] `/tmp/pre-strict-errors.txt` baselined at 113
- [ ] `payouts-service.ts:90` fixed with a real guard (no `!`, no cast)
- [ ] All 113 strict errors fixed, count = 0
- [ ] `src/lib/earnings/**` type-checks clean and is removed from `exclude`
- [ ] `tsconfig.json` `strict: true` committed as a single atomic commit
- [ ] `package.json` build bypass removed; `typecheck` + `verify` scripts added
- [ ] Real `npm run build` executed and all failures classified into the Phase 05 backlog
- [ ] `.github/workflows/ci.yml` blueprint created (no deploy job)
- [ ] `:any` count ≤ 221; zero `@ts-ignore` added

## Success Criteria
**Definition of done**: a type error anywhere in `src/` (including earnings) fails three independent checks — `tsc --noEmit`, `next build`, and CI. Runtime behavior unchanged.

**Validation commands**:
```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
npx tsc --noEmit --strict && echo STRICT_CLEAN       # expect exit 0, 113→0
grep -c "earnings" tsconfig.json                     # expect 0 (exclusion removed)
npm run typecheck && echo TYPECHECK_OK
npm run build 2>&1 | grep -i "error\|Failed to compile" | head -10   # expect none of TS*
npx eslint . --ext .ts,.tsx --max-warnings 0 && echo LINT_OK
CI=true npx jest 2>&1 | tail -8                      # expect 0 failed, 128 suites
grep -rn "@ts-ignore\|@ts-nocheck" src --include="*.ts" --include="*.tsx" | grep -v __tests__ | wc -l   # expect 0
```

## Risk Assessment
| Risk | Likelihood × Impact | Mitigation |
|------|--------------------|------------|
| 113 errors is an underestimate once `earnings` (1066 LOC) is included | **High × Medium** | Step 4 sequences this deliberately: earnings type-fixes land in a *preceding* commit so the `exclude` removal is a no-op on error count. |
| Fixing TS2322/TS18048 changes runtime behavior on a protected route | Medium × Critical | Types-only discipline; any guard that changes control flow gets an explicit regression test. `src/lib/ratelimit/middleware.ts` and cron flagged for extra review. |
| `next build` broken for env reasons blocks this phase | Medium × Medium | Step 6 explicitly classifies into Phase 05 backlog rather than fixing inline — phase does not block on build-system work. |
| Developer silently reaches for `as any` to close errors fast | **High × Medium** | Explicit `:any` count assertion in Success Criteria; suppression count reported; `@ts-ignore` must be 0. |
| Raising `target`/`lib` while in here, breaking Workers runtime | Low × High | Explicitly out of scope; `target: ES2017` preserved because `compatibility_date` is pinned. |

## Security Considerations
- Several of the 113 errors are null-dereference classes; fixing them closes potential runtime crash/500s on protected routes (auth adapter, webhook middleware).
- `d1-adapter.ts` errors are in the auth session path — fix with test coverage on null/expired sessions.
- No new `as any` to preserve auditability of protected-route data flow.
- CI file must not contain secrets; Node version and PATH only.

## Next Steps
- **Feeds Phase 04**: with `strict` on, the money-path types in `earnings/` and `payouts/` are now visible for correctness work.
- **Feeds Phase 05**: classified non-type build failures form the rehearsal backlog; `ci.yml` is extended there with deploy + smoke jobs.
- **Gates Phase 06**: the go-live gate requires `tsc --noEmit` exit 0 as a hard precondition.
- Cross-ref `reports/researcher-quality-tests-report.md` for lint/any/console.log hygiene findings (pending).
