# Phase 05: Verify + Deploy

## Context
Final verification gate — all fixes must pass before deployment.

## Steps
1. Run full test suite: `pnpm test` — target >99% pass rate
2. Run lint: `pnpm lint` — zero errors
3. Run build: `pnpm build` — clean compile
4. Verify no console.log in production code: `grep -r "console.log" src/app/api/ src/lib/`
5. Verify rate limiting active: check middleware.ts coverage
6. Verify error boundaries: check all route segments
7. Run Lighthouse audit: `pnpm test:lighthouse` or manual
8. Commit all changes with conventional commit format
9. Deploy to Cloudflare Pages (staging first, then production)

## Acceptance Criteria
- [ ] Test pass rate >99% (1420+/1426)
- [ ] Lint: 0 errors, 0 warnings
- [ ] Build: clean, 0 errors
- [ ] Zero console.log in src/app/api/ and src/lib/
- [ ] Rate limiting on all public endpoints
- [ ] error.tsx in every route segment
- [ ] Deployed to apex-os.pages.dev

## Rollback
If deployment fails: `wrangler pages project list` → rollback via Cloudflare dashboard.
