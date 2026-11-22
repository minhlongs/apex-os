# 14 — Staging Isolation, Build & CI Push-Trigger Safety

**Status:** `VERIFIED_BY_EXECUTION`

---

## 1. Push-Trigger Inspection

- **`.github/workflows/ci.yml`:** Triggers read-only verification (`typecheck`, `lint`, `test`, `build`) on pushes to `feat/**` and PRs targeting `master`. Performs zero deployments, zero remote D1 migrations, and zero secret mutations.
- **`.github/workflows/deploy.yml`:** Triggers strictly on manual `workflow_dispatch`. Pushing to `feat/ascendancy-phase2-verified` cannot trigger staging or production deployment.

## 2. Local Build & Isolation Verification (Node `v26.7.0`)

| Gate | Command | Result |
|------|---------|--------|
| TypeScript | `npm run typecheck` | `PASS` (0 errors) |
| ESLint | `npm run lint` (`--max-warnings 0`) | `PASS` (0 errors, 0 warnings) |
| Staging Isolation | `bash scripts/assert-staging-isolation.sh` | `PASS` (`STAGING_ISOLATED`) |
| Next.js Build | `npm run build` | `PASS` |
| OpenNext Cloudflare Worker Build | `npm run build:worker` | `PASS` (`.open-next/worker.js`) |
