# ApexOS Go-Live Checklist

This checklist mirrors `scripts/go-live-gate.sh` and serves as the operational audit artifact for the production cutover.

| Gate | Check Item | Status | Owner | Verification Evidence |
|------|------------|--------|-------|-----------------------|
| **G0** | Node runtime compatibility | Verified | Platform | Node `26.7.0` (ABI 147) required and confirmed |
| **G0** | Clean working tree | Verified | Lead Engineer | `git status --porcelain` is empty |
| **G0** | Secret scanning | Verified | Security | Zero staged private keys or tokens |
| **G1** | TypeScript compilation | Verified | Engineering | `tsc --noEmit` passes with 0 errors |
| **G1** | ESLint compliance | Verified | Engineering | `eslint` passes with 0 warnings |
| **G1** | Jest unit & integration suite | Verified | QA / Eng | 100% tests green under Node 26 |
| **G1** | Worker build pipeline | Verified | Platform | `opennextjs-cloudflare build` succeeds |
| **G2** | No build type-check bypass | Verified | Architecture | Zero `NEXT_DISABLE_TYPE_CHECK` / `ignoreBuildErrors` |
| **G2** | Pinned toolchain | Verified | Platform | `wrangler` and `@opennextjs/cloudflare` pinned |
| **G2** | Single config authority | Verified | Platform | `wrangler.toml` absent; JSONC configs used |
| **G3** | Version endpoint & deploy proof | Verified | Platform | `/api/version` reports SHA and env |
| **G4a**| Webhook body read order | Verified | Security | `await request.text()` strictly precedes `json()` |
| **G4b**| Solana fail-closed integrity | Verified | Money Rails | Zero mock signed tx payloads |
| **G4c**| EVM fail-closed integrity | Verified | Money Rails | No synthetic transaction IDs |
| **G4d**| Payout settlement confirmation | Verified | Money Rails | `is_paid=1` only upon verified on-chain confirmation |
| **G4e**| Exact minor-unit currency math | Verified | Money Rails | No float money multipliers; exact minor units |
| **G4f**| Strategic decisions recorded | Verified | Founder | `D1` and `D2` signed off in `go-live-signoff.md` |
| **G4g**| Real-handler webhook coverage | Verified | QA / Eng | Exchange route tests import real handlers |
| **G4h**| Cron schedule dispatch parity | Verified | Platform | Schedules in `wrangler.jsonc` match `worker-wrapper.js` |
| **G4i**| Cron authentication fail-closed | Verified | Security | Missing `CRON_SECRET` yields 401 Unauthorized |
| **G5** | Rollback runbook & staging isolation | Verified | SRE / DevOps | Staging D1 strictly isolated; runbook in docs |
