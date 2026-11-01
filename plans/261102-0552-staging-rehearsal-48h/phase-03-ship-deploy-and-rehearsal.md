# Phase 3: Ship PR, Merge, Deploy to Live Staging & Launch 48h Rehearsal

## Context
- Once config changes are merged into `feature/sprint4-email-automation-complete`, deploy the exact merged commit SHA to `apex-os-staging`, verify `/api/version` + `smoke-protected-routes.sh`, and start the `PaperTradingDurableObject` collector.

## Steps
1. Commit, push `feat/staging-rehearsal-48h`, open PR, review, label `ready to ship stable`, and merge to `feature/sprint4-email-automation-complete`.
2. Checkout merged `feature/sprint4-email-automation-complete` commit and run `npm run deploy:staging`.
3. Run `bash scripts/verify-deployment.sh https://apex-os-staging.agencyos-openclaw.workers.dev "$(git rev-parse HEAD)"`.
4. Trigger `POST /api/admin/paper/overview` (`{"action":"start-collector"}`) using a short-lived admin session on `apex-os-staging-db`, verify `GET /api/admin/paper/overview`, and revoke the temporary session token.
5. Verify `paper_trading_runs` on `apex-os-staging-db` and confirm `node scripts/verify-paper-economic-gate.cjs` remains `NO_GO` (exit code 1).
