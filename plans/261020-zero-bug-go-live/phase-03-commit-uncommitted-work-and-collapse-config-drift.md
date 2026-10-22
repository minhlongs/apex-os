---
title: "Phase 03 — Commit Uncommitted Work + Collapse Config Drift + Harden Cron Auth"
status: completed
priority: P1
effort: 2h
updated: 2026-10-21
---

# Phase 03 — Commit Uncommitted Work + Collapse Config Drift

## Overview

The working tree was dirty (10 modified + 4 untracked paths) and the deploy
configuration was ambiguous in a way that could point production at the wrong
database. Both are resolved, plus two P0 defects that lived in the same surface.

## What was done (commits)

| # | Commit | Outcome |
|---|---|---|
| 1 | `be944a9b` | Stitch terminal work committed: `?tab=` deep-linking, keyboard-accessible telemetry, reduced-motion guard |
| 2 | `a68630b1` | **P0-6 fixed** — every configured cron schedule now dispatches; `wrangler.toml` deleted; deploy-config guard added; docs written |
| 3 | `74614875` | Type gate restored across three mechanisms; `payouts-service` null-deref fixed |
| 4 | `fca1f4ac` | Remaining strict-mode errors in component surfaces |
| 5 | `033ea726` | **P0-7 fixed** — cron auth fails closed when the secret is missing, and the worker entry no longer dispatches on a spoofable header alone |
| 6 | `4eb3f71a` | Config guard reports a parse failure with its position instead of a stack trace |
| 7 | `21a8755a` | **Bonus P0 fixed** — the weekly payout handler called `.all()()`, throwing on every run with an eligible affiliate, and zero tests covered the path |

## Key Insights

**A. The cron bug was worse than a string mismatch (P0-6).** Cloudflare follows
Quartz rules where days of week run 1=Sunday..7=Saturday and `0` is invalid.
So `wrangler.toml`'s `0 0 * * 0` was never a valid schedule, `wrangler.jsonc`'s
`0 0 * * 7` is **Saturday**, and `worker-wrapper.js` dispatched on a third
literal matching neither. The weekend payout silently never ran. Fixed by
defining the schedules once in `worker-cron-schedules.js` and consuming that
module on both sides, using the `SUN` acronym because a bare number can be
misread as an off-by-one week. Verified at the bundler level, not just in Node:
esbuild inlines `CRON_WEEKLY_PAYOUTS = "0 0 * * SUN"` and the dispatcher
compares against it.

**C. An extra P0 was hiding behind the missing cron test.** While hardening the
cron auth I found `handleWeeklyPayouts` reading `.all()()` — invoking the
awaited result of `.all()` as a function, which throws a TypeError on every run
with at least one eligible affiliate. It survived since 2026-08-02 because the
error is caught per affiliate, logged, and skipped, so the job reports success
with zero payouts. The reason it was never caught is the same reason P0-1
survives: no test calls the real route. The route-level test added for it is
mutation-tested — removing the `.await` on the query fails it, whereas a naive
assertion on "a query ran" passes either way, because the statement is bound
before it is invoked.

**B. The config deletion required a parity proof, not a preference.**
`wrangler.toml` and `wrangler.jsonc` agreed on `main` and on all four bindings,
but disagreed on `compatibility_date` by 17 months and on
`compatibility_flags`, and only the JSON form carried the `assets` block
OpenNext requires. Deleting the JSON one would have broken the deploy; deleting
the TOML is safe. `scripts/assert-deploy-config.cjs` now refuses a second
config and refuses prod and staging D1 bindings sharing a `database_id`.

**C. Two auth conventions existed and opposite each other were true of them
(P0-7).** `admin/notifications` and `tasks/executor` both fail *closed*; the
cron route and worker entry failed *open*. The cron one moves money. Fixed to
fail closed, and the worker dispatch now requires the shared secret because
`cf-cron-trigger` is client-controllable.

## Deferred, not silently skipped

- `ORIGINAL_REQUEST.md`, `public/stitch/`, `design-system/`, `plans/` and the
  brainstorm doc remain untracked. `ORIGINAL_REQUEST.md` is a prompt
  transcript, not product content — recorded as a founder decision.
- `src/components/stitch/screens/` is a new index that re-exports an existing
  component and is imported by nothing. Harmless, but it should either be wired
  up or removed before it becomes dead-weight surface.

## Related Code Files

- `worker-cron-schedules.js` (new) — single source of the three schedule strings
- `worker-wrapper.js` — imports them; cron dispatch now authenticated
- `wrangler.jsonc` — cron string aligned
- `wrangler.toml` (deleted)
- `__tests__/worker-cron-schedules.test.ts` (new) — fails if config and dispatcher drift
- `scripts/assert-deploy-config.cjs` (new) — deploy-time binding assertion
- `docs/deploy-architecture.md` (new) — bindings, runtime, deploy graph, rollback
- `src/app/api/cron/route.ts` — fail-closed authorization

## Transaction-boundary verification (commit 74614875)

The `createPayout` throw was checked against **both** call paths, and both are
safe for the same reason:

- `/api/cron` `handleWeeklyPayouts` — `createPayout` at line 154, then
  `UPDATE earnings SET is_paid = 1` at 172-177, then `results.push` at 180.
- `worker-wrapper.js` — `createPayout` at 159, then the same `UPDATE` at 174,
  then the summary response.

In each, the `is_paid = 1` writes sit strictly **after** the call that can
throw, inside the same `try`. A throw jumps straight to the catch, the earnings
are never marked, they remain eligible on the next run, and no false "paid"
record is written. Nothing else calls `createPayout` — grep found only these
two — so no caller depended on the old possibly-null return.

## Success Criteria — met

- `node scripts/assert-deploy-config.cjs` → exit 0
- `npm run typecheck` → exit 0 (`strict: true`)
- `npm run lint` → exit 0
- `CI=true npm test` → **129 suites / 3189 passed / 0 failed**
- `esbuild --bundle worker-wrapper.js` → succeeds, cron constants inlined
- Cron contract test fails on drift (verified by reverting each side)

## Risk Assessment

`worker-wrapper.js` now needs a secret present. If it is absent, cron returns
401 instead of running. That is the intended direction — a missing secret is a
deployment error — but it must be set in the Cloudflare dashboard before go-live
or weekly payouts stop working. Noted for Phase 05 (deploy) and Phase 06 (gate).

## Decisions still owed by the user

- **D1** Are Solana/EVM payouts live at go-live, or should they be gated?
- **D2** Is `src/lib/payouts/payouts-service.ts` live or dead?
