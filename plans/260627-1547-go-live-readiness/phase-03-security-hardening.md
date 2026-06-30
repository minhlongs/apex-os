# Phase 03: Security Hardening

## Context
No rate limiting on public endpoints, partial admin protection. Critical security blockers.

## Files to Create
- `src/lib/rate-limit.ts` — rate limiter middleware (in-memory token bucket, per-IP)
- `src/middleware.ts` — global middleware for rate limiting + admin guard

## Files to Modify
- `src/app/api/tracking/click/route.ts` — apply rate limit
- `src/app/api/auth/[...all]/route.ts` — apply rate limit
- `src/app/api/webhooks/exchange/route.ts` — apply rate limit + signature check
- `src/app/api/admin/**/*.ts` — add explicit admin role guard
- `src/lib/auth-guard.ts` — create reusable admin guard utility

## Steps
1. Create rate-limit.ts: token bucket, 100 req/min per IP, skip internal IPs
2. Create auth-guard.ts: verify admin role from Better Auth session
3. Update middleware.ts: apply rate limit to all /api/* routes, admin guard to /api/admin/*
4. Apply rate limit to high-risk endpoints: /api/tracking/click, /api/auth/*, /api/webhooks/*
5. Add admin guard to all /api/admin/* routes
6. Run tests: `pnvm test -- __tests__/lib/rate-limit*`

## Acceptance
- All public API endpoints rate-limited
- All admin routes require admin role
- Rate limiter tests pass
- No new test failures introduced
