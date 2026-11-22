# 28 — G19 Founder Merge Decision & Post-Merge Roadmap (FINAL)

**Date:** 2026-11-22  
**Repository:** `minhlongs/apex-os`  
**Worktree:** `/Users/macbook/apex-os-worktrees/phase2-ascendancy`  
**Branch / PR:** `feat/ascendancy-phase2-verified` → `master` (Draft PR #56: https://github.com/minhlongs/apex-os/pull/56)  
**Verified Baseline SHA:** `7c36be49c104410b9680f265fb84d11922d4a6cc` (+ G19 docs/reports/test commit; **0 production source files modified**)  

## FINAL VERDICT

```text
READY_FOR_FOUNDER_MERGE_APPROVAL
```

> **Scope of Verdict:** Approved **solely** for a **source-only merge** of PR #56 into `master` under disabled financial configuration (`AUTO_SETTLE_PAYOUTS = "false"`, `V1_STELLAR_ONLY_PAYOUTS = "true"`, `PARTNER_KUCOIN_LIVE` / `PARTNER_GATEIO_LIVE` unset/false, zero `TURNKEY_*` secrets).  
> **NOT Approved For:** Marking PR #56 Ready/Merging automatically, staging/production deployment, remote D1 migrations (`031`–`036`), HSM/Turnkey activation, real USDC settlement, KuCoin/Gate.io promotion, or live commercial pilot.

---

## 1. Authoritative Git & PR #56 State (G19.0)
- **PR #56:** `OPEN`, `isDraft: true`, `MERGEABLE`, `baseRefName: master` (`f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d`), `merge-base === origin/master` (zero divergence), `0` comments/review blockers.
- **Remote Default Branch Observation:** `origin/HEAD` currently points to `feature/sprint4-email-automation-complete` (not modified).
- **Evidence:** `plans/reports/ascendancy-closure/25-G19-CURRENT-SOURCE-SEAL.md`.

## 2. Reclassified Deferred High Findings — Reachability Proof (G19.1)
- All 7 deferred High findings (`H1`–`H7`) from Report `24` **retain their original `High` severity** (zero downgrading).
- **Reachable on source-only merge to `master`: `0 / 7`** (NO `HOLD_MERGE_REACHABLE_HIGH`).
  - `H1` (`StellarService.processBatchPayouts`): 0 callers (dead code) + legacy payout routes return `409 LEGACY_PAYOUT_ROUTE_DISABLED`.
  - `H2` (`lockSettledForWithdrawal` / `ledgerUnits1e8ToStellarStroops` / `ledgerUnits1e8ToEvmUsdcUnits`): active route `dispatch/route.ts:520-522` pre-strips `residualDust1e8`; EVM blocked by `V1_STELLAR_ONLY_PAYOUTS = "true"`.
  - `H3` (`Number(bigint)` at `turnkey-signer.ts:822,1066`): `:822` mathematically bounded by `$250` cap (`<=2.5e10 << 2^53-1`); `:1066` requires `>$90.07M` single settled withdrawal + live HSM + Passkey.
  - `H4`/`H5` (migrations `031`–`036` operational rollout): no automatic migration runner on merge.
  - `H6` (`TurnkeyServerHsmTransport` timeout/classification): fails closed `503 SETTLEMENT_TRANSPORT_UNCONFIGURED` without all 4 `TURNKEY_*` secrets + Admin Passkey; cron reconciler strictly `passiveOnly: true`.
  - `H7` (missing PWA PNG icons): non-security, not deployed on merge.
- **Evidence:** `plans/reports/ascendancy-closure/26-G19-DEFERRED-HIGH-REACHABILITY.md`.

## 3. Corrected R10 Unit Economics (G19.2)
- Fixed the implied-opex defect in Report `22` (which previously subtracted historical PDF FCF from retained allocation, preserving old FCF by construction).
- Recalculated strictly in `10^-8` `bigint` via `computeSafeSpreadWaterfall` holding PDF R10 (pp. 69–70) cost baselines constant (`BEAR $516.35`, `BASE $898.25`, `BULL $2,281.64`):

| Scenario (USD/month) | BEAR | BASE | BULL |
|---|---:|---:|---:|
| **Original PDF FCF** | -$390.01 | +$684.79 | +$10,066.36 |
| **Retail I4 FCF (33.25% retained)** | **-$385.08** | **+$649.87** | **+$11,404.06** |
| **Max B2B L2 FCF (28.50% retained)** | **-$403.83** | **+$428.71** | **+$9,448.96** |

- Verified by deterministic `10^-8` `bigint` test suite `src/lib/ledger/__tests__/r10-unit-economics-reconciliation.test.ts` (4/4 PASS).
- **Evidence:** `plans/reports/ascendancy-closure/27-G19-R10-CORRECTED-UNIT-ECONOMICS.md` & revised `22-G17-R10-ECONOMIC-RECONCILIATION.md`.

## 4. Legal Source Attribution Correction (G19.3)
- Updated `README.md`, `CLAUDE.md`, `22-G17-R10-ECONOMIC-RECONCILIATION.md`, and `23-G17-B2B-PILOT-READINESS.md` to separate: (1) implemented L3 `0%` software product restriction, (2) current Vietnamese law (Decree 40/2018/ND-CP as amended/replaced — not cited as unverified current legal authority), (3) legal classification of ApexOS's retail L1 and B2B L2 structures, and (4) required independent external counsel sign-off.
- Disabling L3 in code does **not** by itself establish that the B2B L2 structure is legal. Remaining runtime UI/i18n/error-string copy updates are scoped to Post-Merge PR B.

## 5. Source-Only Merge Safety & External Preconditions (G19.4)
- **Repo-Verified `PASS`:** `.github/workflows/ci.yml` is verification-only; `.github/workflows/deploy.yml` is `workflow_dispatch`-only; `wrangler.jsonc` enforces `AUTO_SETTLE_PAYOUTS="false"`, `V1_STELLAR_ONLY_PAYOUTS="true"`, `PARTNER_KUCOIN_LIVE`/`PARTNER_GATEIO_LIVE` unset (false), zero `TURNKEY_*` secrets; manual admin routes independently fail closed (`409`/`410`/`503` + Passkey).
- **3 External Preconditions Marked `UNCERTAIN — FOUNDER MUST CHECK BEFORE MERGE`:**
  1. Confirm Cloudflare Dashboard Git integration (Workers Builds / Pages) is **not** connected to auto-deploy `master` (note stale `.cloudflare/pages-config.toml`).
  2. Confirm remote production Worker does **not** have live `TURNKEY_*` secrets pre-populated.
  3. Confirm GitHub `master` branch protection & `production` environment required reviewers remain active.

## 6. Reverified G17 Treasury, Migration & Local CI Gates (G19.5)
All local checks re-executed on Node `v26.7.0` after G19 edits:
- `bash scripts/assert-staging-isolation.sh`: **`STAGING_ISOLATED`** (`PASS`)
- `npm run typecheck`: **`PASS`** (0 errors)
- `npm run lint`: **`PASS`** (0 errors, 0 warnings)
- `CI=true npm test -- --silent`: **`193/193` suites PASS, `3,922` passed, `1` skipped** (pre-existing Resend mock test at `notification-channels.test.ts:368`, queued in PR B), `0` failed (13.952s). Includes `g16-treasury-regressions`, `payout-effect-fence`, `durable-hot-exposure`, `monetary-precision-conservation`, `migration-031-036-release-drill`, `shadow-promotion-and-flag-audit`, and `r10-unit-economics-reconciliation`.
- `npm run build:worker`: **`PASS`** (`OpenNext build complete`, 112/112 static pages, `.open-next/worker.js` emitted).
- Fresh GitHub Actions CI (`pull_request` + `push`) is verified on the pushed final HEAD SHA before delivering the final decision summary.

## 7. Prepared Post-Merge Workstreams (G19.6)
Fully specified with disjoint file ownership and Definitions of Done in `plans/reports/ascendancy-closure/29-G19-POST-MERGE-PR-A-AND-B-PLANS.md` (not branched/published until Founder merges PR #56):
- **PR A — Pre-Live-Cutover Hardening (Mandatory before any real HSM/USDC activity):** Turnkey `AbortController` bounded timeout + `DEFINITE_REJECTED` vs `UNCERTAIN_OUTCOME` classification (no blind retry), disable `StellarService.processBatchPayouts`, lossless `BigInt` (`toSafeSqlInteger`), strict dust/amount boundary assertions, migration `037` withdrawal trigger `payout_id` binding + `UNVERIFIED_HOT → HOT` timestamp, adversarial freeze/reservation tests, independent HSM call-graph review.
- **PR B — Public PWA / GA Hygiene (Mandatory before public customer launch):** Durable D1 rate limiting on `/api/b2b/proof-of-rebate`, real `192×192` / `512×512` PNG PWA icons + manifest integrity tests, GitHub Actions Node 24 + 40-char SHA pinning + least-privilege permissions, repair skipped Resend mock test (`0` skipped), runtime UI/legal copy alignment.

## 8. G18 Commercial Execution Readiness (G19.7)
- Documented in `plans/reports/ascendancy-closure/23-G17-B2B-PILOT-READINESS.md` Section 5.
- **Empirical Baseline:** Actual partner commission collected = **`$0.00`**; signed exchange partner agreements = **`NOT VERIFIED`**; 30-day B2B pilot = **`NOT STARTED`**.
- **Remaining External Blockers:** Corporate entity & external legal counsel memo, signed Bybit/OKX/Bitget agreements + read-only API keys, Turnkey HSM + Safe/Stellar cold vaults + PR A, and Founder-authorized Milestone B (48h) → Milestone C (30-day real B2B pilot).

## 9. Single Explicit Founder Decision Required Next
1. Verify the 3 external Cloudflare/GitHub Dashboard preconditions above (Section 5).
2. Decide whether to mark Draft PR #56 Ready for Review and **source-only merge** into `master` (keeping all money-moving flags `false` and triggering **no** deployment or remote D1 migration).
3. Upon merge, authorize opening Post-Merge **PR A** and **PR B** on `master` and executing external Milestone A (legal + Bybit/OKX/Bitget partner enrollment).
