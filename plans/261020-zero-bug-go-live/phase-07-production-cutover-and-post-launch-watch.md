# Phase 07 — Production Cutover & Post-Launch Watch

## Overview
- **Priority**: P2
- **Status**: completed
- **Effort**: 4h (+2h for the mandatory fabricated-payout reconciliation pre-flight)
- **Blocks**: none (go-live is authorized by Phase 06)
- **Depends on**: Phase 06 green gate + founder sign-off

Cutover is short and must be boring. The work is de-risking, and that happened in Phases 01-06. This phase executes and watches.

## Key Insights
**A. Money paths have a blast radius that a web deploy does not.** The weekly payout cron (`0 0 * * 0`), the alert engine (`*/5`), and D1 metrics (`*/30`) start firing the moment production Workers are live. Cutover must be scheduled so that the **first 24 hours do not include the weekly payout window** — cut over early in the week, never Friday/Saturday, so a Sunday 00:00 UTC payout is preceded by ≥48h of watch.

**B. P2, not P1.** All risk-reducing work is in Phases 01-06. This phase has no leverage left to add; it only needs to be correct. Keeping it short and P2 prevents scope inflation into "post-launch iteration" which is a different plan.

**C. Warranted caution on the very first production write.** Because Phase 04's money module normalizes `REAL` → minor units at the read edge and the first production week will compute the **first** payouts under the new path, the very first payout run should be observed manually (not discovered via cron output) before being left automatic.

**D. There may already be fabricated payouts in the database — this is a mandatory pre-flight, not a postmortum.** Before cutover, run a **reconciliation query** over existing `payouts.transaction_id` values. The Solana (`MOCK_SIGNED_TX_PAYLOAD`) and Ethereum (keccak-of-metadata) paths fabricated transaction ids while returning `success: true`, so **any row whose `transaction_id` is not verifiable on-chain is a fake payout with `earnings.is_paid = 1`**. Consequences:
- Such rows are unrecoverable ledger entries — the user was never actually paid.
- If any exist, this must be surfaced to the founder **before** cutover, with the affected user list, so a remediation/repayment decision can be made explicitly.
- This is a founder decision, not an engineering default. **Do not silently delete or rewrite historical payout rows.**

## Requirements
### Functional
- F1. **Reconcile pre-existing payouts against chain state (mandatory pre-flight).** Any `payouts.transaction_id` not verifiable on-chain is a fabricated payout; surface to founder and get an explicit remediation decision *before* deploy.
- F2. Deploy to production through the Phase 05 pipeline (no manual console deploy).
- F3. Confirm cron triggers are registered and firing against production.
- F4. Confirm the first payout run completes with a reconciled ledger (single movement per earning, totals match).
- F5. Watch for a defined window with defined abort criteria.
- F6. Rollback is immediately available (Phase 05's rehearsed path), executed via the pinned `wrangler` workspace binary.

### Non-Functional
- NF1. Cutover avoids the weekly payout window (≥48h lead before Sunday 00:00 UTC).
- NF2. All rollback prerequisites re-verified on the day (previous good SHA known, deploy pipeline working).
- NF3. Observable: alerts active and reaching a real channel before cutover, not after.

## Architecture
```
Pre-flight (T-1h)   ─► re-verify rollback path, confirm alerts active, confirm secrets set in prod
Cutover   (T-0)     ─► deploy:production (Phase 05 pipeline) → gate deploy-mode
Watch     (T+0..2h)  ─► worker logs (no 5xx on protected routes), D1 metrics, /api/version SHA
Verify    (T+2h)     ─► protected-route smoke against prod, alert-engine cron observed
Money     (T+24h)    ─► first revenue/earnings ingestion observed; no payout window yet
First payout (before Sun 00:00 UTC) ─► manual observation of one payout run, ledger reconciliation
Steady state          ─► gate runs on every subsequent deploy
```

**Abort criteria (defined in advance, not improvised):** roll back immediately if any of — (a) any protected webhook returns 5xx, (b) `/api/cron` returns unauthenticated 200, (c) payout ledger does not reconcile, (d) D1 metrics show abnormal rows-scanned (>10k avg target from CLAUDE.md alert rules), (e) alert engine cron throws.

## Related Code Files
### Create
- `docs/cutover-runbook.md` — the T-1h → T+first-payout sequence, plus abort/rollback criteria.

### Modify
- `docs/operational-runbook.md` — add the "gate on every production deploy" doctrine (Phase 06 hands this over).
- `docs/project-changelog.md` — record the go-live entry with SHA and gate verdict.

### Delete
- *(none)*

## Implementation Steps
1. **T-1h pre-flight.** Confirm: rollback SHA recorded and deployable; **`node_modules/.bin/wrangler --version` returns the pinned version and `which wrangler` resolves in-repo** (not `/opt/homebrew/bin`); secrets present in the production deploy environment (Stellar key, webhook secrets for Binance/Bybit/KuCoin/OKX, Resend, Telegram); alert channels (Slack/email/Telegram) verified reaching a human; `/api/health` green on staging.
2. **Set the prod deploy secrets** in CI/Cloudflare (if not already). Verify no secret is in a tracked file: `git grep -l "G[A-Z0-9]\{50\}" -- .` should return nothing.
3. **Reconcile pre-existing payouts (mandatory, blocks deploy).** Identify payouts whose `transaction_id` cannot be verified on-chain — in particular any row carrying a fabricated id from the Solana/EVM paths. Let the core team list affected users/amounts, then the founder signs an explicit remediation decision. Deploy does not proceed until this is closed.
4. **Cutover.** `npm run deploy:production`, then run the gate in deploy mode against the production URL.
4. **Verify crons are live.** Confirm the three triggers registered and that a manual trigger of the `*/5` alert-engine cron returns a well-formed response (no `Module not found`, no 500). This is where a broken `worker-wrapper.js` dynamic-import would surface.
5. **Watch T+0..2h.** Worker logs for 5xx on protected routes; D1 metrics; `/api/version` SHA matches the deployed SHA.
6. **T+24h.** Confirm webhook ingestion from a real exchange is landing conversions/earnings correctly, with commission splits reconciled (tier1+tier2+tier3 == conversion commission).
7. **First payout observation.** Before the Sunday 00:00 UTC payout window, manually trigger the payout path once against production data (or observe the earliest scheduled run), and assert: one payout record per eligible affiliate, each earning marked `is_paid` exactly once, sum of payout `net_amount` == sum of earnings amounts included.
8. **Record.** Update `docs/project-changelog.md` with the go-live entry (SHA, date, gate verdict). Update `docs/operational-runbook.md` with the gate-on-every-deploy doctrine.
9. **Schedule Phase 07+ follow-ups** (from earlier phases): D1 money column migration; migration ledger; AML/sanctions screening integration; staging KV namespace; load/performance test.

## Todo List
- [ ] **Pre-existing payouts reconciled against chain state; fabricated payouts surfaced; founder remediation decision recorded**
- [ ] Cutover scheduled ≥48h before Sunday 00:00 UTC
- [ ] Rollback SHA recorded + confirmed deployable **via the pinned `wrangler`**
- [ ] All prod secrets set via CI/Cloudflare; none in tracked files
- [ ] Alert channels verified reaching a human
- [ ] Production deployed via pipeline; gate deploy-mode PASS
- [ ] All three crons registered; alert-engine cron manually triggered clean
- [ ] T+2h protected-route smoke green on prod; no 5xx
- [ ] T+24h exchange ingestion observed; commission splits reconcile
- [ ] First payout run manually observed; ledger reconciled exactly once
- [ ] `docs/project-changelog.md` + `docs/operational-runbook.md` updated
- [ ] Phase 07+ follow-ups scheduled

## Success Criteria
**Definition of done**: pre-existing fabricated payouts are reconciled and signed off; production is serving all protected routes with zero 5xx, all three crons fire cleanly, exchange ingestion and the first payout run reconcile exactly, and the go-live is recorded against a specific SHA.

**Validation commands**:
```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
GATE_SHA=$GITHUB_SHA GATE_URL=https://apex-os.<subdomain>.workers.dev npm run gate   # exit 0
bash scripts/smoke-protected-routes.sh https://apex-os.<subdomain>.workers.dev        # no 500, no unauth 200
curl -s https://apex-os.<subdomain>.workers.dev/api/version | node -e "const d=JSON.parse(require('fs').readFileSync(0));if(d.sha!==process.env.GITHUB_SHA)process.exit(1)" && echo SHA_MATCH
# ledger reconciliation (read-only, prod D1)
wrangler d1 execute apex-os-db --command "SELECT COUNT(*) AS payouts FROM payouts WHERE status='completed'" --json
wrangler d1 execute apex-os-db --command "SELECT COUNT(*) AS unpaid_but_paid FROM earnings WHERE is_paid=1 AND payout_id IS NULL" --json   # expect 0
```

## Risk Assessment
| Risk | Likelihood × Impact | Mitigation |
|------|--------------------|------------|
| **First production payout double-pays or overpays** | **Low × Critical** | Phase 04 idempotency test + Phase 05 staging payout dry-run; Step 7 manually observes the first run before trusting the cron. |
| Cutover lands inside the weekly payout window | Medium × Critical | NF1 requires ≥48h lead; abort criteria defined in advance. |
| Rollback needed but previous SHA no longer deployable (build drift) | Low × Critical | Phase 05 rehearses rollback from an older commit; T-1h re-confirms using the pinned `wrangler`. |
| Cron triggers registered but silently failing | Medium × High | Step 4 manually triggers the alert-engine cron; worker logs watched T+0..2h. |
| Prod secrets missing → payouts fail silently overnight | Medium × High | T-1h secret checklist; alerts reach a human *before* cutover. |
| Launch pressure converts this phase into feature work | Medium × Medium | P2 and short by design; anything beyond cutover+watch is a new plan. |

## Security Considerations
- Production secrets are injected at deploy time from CI/Cloudflare; `git grep` proves none are tracked.
- `/api/cron` must be non-public; the smoke test's unauthenticated-200 rejection is re-run here against prod.
- Payout observation and reconciliation are read-only (`wrangler d1 execute` SELECTs); do not mutate prod data during watch.
- The reconciliation report contains wallet addresses and payout amounts — treat as sensitive; deliver to the founder over the existing secure channel, not a public tracker.
- Stellar signing key stays in Cloudflare env; never exported into logs — verify logging does not print payout method details (which contain wallet addresses) to unprotected channels.
- Do not delete or rewrite fabricated payout rows during reconciliation; remediation is a founder-signed decision recorded in `go-live-signoff.md`.

## Next Steps
- **Steady state**: `npm run gate` runs on every subsequent production deploy (doctrine recorded in Phase 06).
- **Phase 07+ backlog** (separate plans, not scope creep here): D1 money column migration with own rehearsal; applied-migration ledger; AML/sanctions screening; staging KV namespace; load test; mobile app go-live.
- Revisit accepted residual risks (Phase 06) at the first post-launch review.
