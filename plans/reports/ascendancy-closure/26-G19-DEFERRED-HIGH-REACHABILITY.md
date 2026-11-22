# 26 — G19 Deferred High Reachability Matrix & Merge-Trigger Safety (G19.1 + G19.4)

**Date:** 2026-11-22  
**Audited Baseline:** `feat/ascendancy-phase2-verified` (`7c36be49c104410b9680f265fb84d11922d4a6cc`)  
**Severity Integrity Rule:** All 7 deferred High findings from `24-G17-FINAL-PR56-MERGE-REVIEW.md` retain their original **`High`** severity. None were downgraded.  
**G19.1 Reachability Verdict:** **0 / 7 High findings reachable on source-only merge to `master`** (`NO HOLD_MERGE_REACHABLE_HIGH`).  
**G19.4 Repo Merge-Trigger Verdict:** `PASS` for repo-controlled workflows (`ci.yml` verification-only; `deploy.yml` `workflow_dispatch`-only); **`UNCERTAIN_EXTERNAL_CHECK_REQUIRED`** for external Cloudflare Dashboard Git integration & remote Worker secrets (unverifiable from Git metadata alone).

---

## 1. Complete 19-Column Deferred High Reachability Matrix (G19.1)

| Field | **H1** | **H2** | **H3** | **H4** | **H5** | **H6** | **H7** |
|---|---|---|---|---|---|---|---|
| **Original Severity** | `High` (Rev 1) | `High` (Rev 1) | `High` (Rev 1) | `High` (Rev 4) | `High` (Rev 4) | `High` (Rev 5) | `High` (Rev 6) |
| **Exact Source Symbol** | `StellarService.processBatchPayouts` (`stellar-service.ts:925`) | `lockSettledForWithdrawal` (`double-entry-ledger.ts:2013`), `ledgerUnits1e8ToStellarStroops` (`stellar-service.ts:380`), `ledgerUnits1e8ToEvmUsdcUnits` (`arbitrum-base-usdc-adapter.ts:255`) | `Number(bigint)` (`turnkey-signer.ts:822,1066`) | Pre-`036` `settlement_broadcasts` `NULL` lane rows (`036_durable_hot_exposure.sql`) | Non-idempotent `ALTER TABLE ADD COLUMN` in `036` (`031..036`) | `TurnkeyServerHsmTransport` timeout/retry/classification (`turnkey-signer.ts:379-471`) | Missing `icon-192.png` / `icon-512.png` (`public/manifest.json:10-23`) |
| **Actual Entry Points** | **0 callers** in `src/`, `scripts/`, `worker-wrapper.js`, tests (dead code) | `lockSettledForWithdrawal`: only `dispatch/route.ts:538`; `StellarStroops`: **0 prod callers**; `EvmUsdcUnits`: `usdc-safety-guards.ts:352` & `arbitrum-base-usdc-adapter.ts:744` | `:822` `claimHotWalletSigningSlot`; `:1066` `enqueueColdSafeMultisig` (both via `dispatch/route.ts`) | Manual `wrangler d1 execute` on remote D1 | Manual `wrangler d1 execute` on remote D1 | `resolveSettlementMachine` (`settlement-reconciler.ts:121`) ← `dispatch/route.ts:181` | Browser PWA manifest fetch when deployed |
| **Runtime Feature Flags** | Legacy routes blocked by `guardLegacyAdminPayoutMutation` (`409`) | `V1_STELLAR_ONLY_PAYOUTS="true"` blocks EVM; Passkey + HSM required | Passkey + HSM required; `:822` bounded by `$250` cap (`:810`) | None (DB migration only) | None (DB migration only) | `AUTO_SETTLE_PAYOUTS="false"` + 4 `TURNKEY_*` secrets required | None |
| **Reachable in Current Prod?** | No (dead code) | No (not deployed; active route pre-strips dust) | No (not deployed; `:822` mathematically bounded) | No (not applied) | No (not applied) | No (not deployed; no `TURNKEY_*` in config) | No (not deployed) |
| **Reachable After Source-Only Merge?** | **No** | **No** | **No** | **No** | **No** | **No** | **No** |
| **Reachable via Manual Admin Routes?** | No (`409 LEGACY_PAYOUT_ROUTE_DISABLED`) | Active route (`dispatch/route.ts:520-522`) pre-strips `residualDust1e8` before calling | `:822` impossible (`<=2.5e10 << 2^53-1`); `:1066` requires `>$90.07M` settled balance + Passkey + live HSM | No | No | Only if deployed + 4 `TURNKEY_*` secrets provisioned + Admin Passkey | No |
| **Reachable via Cron?** | No | No (cron reconciler runs `passiveOnly: true`) | No | No | No | No (`settlement-reconciler.ts:400-405` never signs) | No |
| **Reachable via Direct Internal Calls?** | No (0 callers) | Future unguarded library caller only (hence Pre-Live PR A) | Future caller passing `>2^53-1` to `:1066` | No | No | Only inside `TurnkeySigner` when credentials provided | No |
| **Required Deployment Config** | Code edit to wire a caller | Deployed Worker + Passkey + `TURNKEY_*` + new unguarded caller | Deployed Worker + Passkey + `TURNKEY_*` + `>$90.07M` settled balance | Manual remote D1 migration `036` | Manual remote D1 migration `031..036` | Deployed Worker + all 4 `TURNKEY_*` secrets + Admin Passkey | Deployed Worker |
| **Can Mutate Real Funds?** | Not reachable | Not via active route | `:822` No; `:1066` only cold proposal if deployed + HSM | No (fails closed: blocks hot cap) | No (fails fast on re-run) | Only if deployed + live `TURNKEY_*` + Passkey | No |
| **Can Bypass Emergency Pause?** | No | No (`assertLedgerNotFrozen` + trigger `034`) | No (trigger `034`/`035` + safety epoch) | No | No | No (`payout_effect_grants` + safety epoch) | No |
| **Can Corrupt Existing Ledger?** | No | No (active route `residualDust1e8 === 0n`) | No (`toSafeSqlInteger` guards ledger postings) | No (fail-closed cap) | Partial DDL if run without backup | Unknown-outcome retry risk if live HSM enabled | No |
| **Blocked Independently of `AUTO_SETTLE_PAYOUTS=false`?** | **Yes** (0 callers + `409` legacy guards) | **Yes** (`dispatch/route.ts:520-522` pre-aligns + `503` HSM + Passkey) | **Yes** (`:810` `$250` cap + `503` HSM + Passkey) | **Yes** (no auto-migration runner) | **Yes** (no auto-migration runner) | **Yes** (`503 SETTLEMENT_TRANSPORT_UNCONFIGURED` without 4 `TURNKEY_*` secrets + Passkey) | **Yes** (no auto-deploy in repo) |
| **Merge-Blocking Status** | **No** | **No** | **No** | **No** | **No** | **No** | **No** |
| **Pre-Live-Cutover-Blocking?** | **YES (PR A)** | **YES (PR A)** | **YES (PR A)** | **YES (Runbook 21)** | **YES (Runbook 21)** | **YES (PR A)** | No |
| **GA-Blocking Status?** | **YES** | **YES** | **YES** | **YES** | **YES** | **YES** | **YES (PR B)** |
| **Test Evidence** | Grep 0 callers + legacy `409` tests | `monetary-precision-conservation.test.ts` (4/4) + `dispatch` tests | `g7-settlement-simulation` + T-03 tests (82/82) | `migration-031-036-release-drill.test.ts` (3/3) | `migration-031-036-release-drill.test.ts` (3/3) | `settlement-reconciler` tests | Verified on disk (`public/assets/icons/` has only `.svg`) |

---

## 2. G19.4 — Source-Only Merge-Trigger & Manual Admin Safety Verification

### Verified Repo-Controlled Facts (`PASS`)
1. **`.github/workflows/ci.yml`:** Triggers on `push` / `pull_request` to `main`, `master`, `feature/sprint4-email-automation-complete`. Executes **only** `npm ci`, `scripts/assert-staging-isolation.sh`, `npm run typecheck`, `npm run lint`, `CI=true npm test`, `npm run build:worker`. Contains **zero** `wrangler deploy`, **zero** `wrangler d1`, and **zero** secret mutations.
2. **`.github/workflows/deploy.yml`:** Triggers **exclusively on `workflow_dispatch`** (`deploy.yml:3-15`). Never fires on `push` or PR merge to `master`. Production deploy further requires `needs: [deploy-staging]`, `environment: production`, `scripts/go-live-gate.sh`, and `scripts/verify-paper-economic-gate.cjs`. Never executes D1 schema migrations.
3. **Runtime Flags (`wrangler.jsonc:49-60` & `wrangler.staging.jsonc:53-64`):**
   - `AUTO_SETTLE_PAYOUTS = "false"` (enforced at both `worker-wrapper.js:247` and `src/app/api/cron/route.ts:102`).
   - `V1_STELLAR_ONLY_PAYOUTS = "true"` (blocks Arbitrum/Base EVM settlement rails).
   - `PARTNER_KUCOIN_LIVE` & `PARTNER_GATEIO_LIVE`: unset → default `false` / `SHADOW_ONLY` (30-day R2-proven gate in `shadow-promotion-gate.ts`).
   - Zero `TURNKEY_*` secrets in config; zero custom Cloudflare `routes` or `custom_domains`.
4. **Manual Admin Endpoints Independently Fail Closed:**
   - `/api/payouts`, `/api/admin/payouts/batch` (`execute`), `/api/admin/payouts/retry` → `409 LEGACY_PAYOUT_ROUTE_DISABLED`.
   - `/api/admin/payouts/treasury` → `410 LEGACY_TREASURY_ROUTE_DISABLED`.
   - `/api/admin/settlement/dispatch` (`dispatch`, `recover`, `resolve_cold_safe`) → requires Admin session + WebAuthn Passkey step-up (`dispatch/route.ts:167-177`) AND fails closed with `503 SETTLEMENT_TRANSPORT_UNCONFIGURED` if any of the 4 `TURNKEY_*` secrets is absent (`settlement-reconciler.ts:98-106`).
   - `/api/cron` (`t7_release`, `settlement_reconcile`, `partner_reconciliation`) → constant-time `Bearer ${CRON_SECRET}` + reconciler strictly `passiveOnly: true` (never signs or broadcasts).

### External Infrastructure Uncertainties (`UNCERTAIN — NOT PASS` Until Founder Checks Dashboard)
Because Git repository files cannot inspect external Cloudflare/GitHub control-plane state, the Founder **must verify** these 3 items before clicking Merge on PR #56:
1. **Cloudflare Dashboard Git Integration:** Confirm neither Cloudflare Workers Builds nor Cloudflare Pages is externally connected to auto-deploy `minhlongs/apex-os` branch `master` (note stale legacy `.cloudflare/pages-config.toml` in repo).
2. **Remote Cloudflare Worker Secrets:** Confirm live `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, and `TURNKEY_STELLAR_HOT_WALLET_ADDRESS` are **not** pre-populated on the production Worker prior to PR A landing.
3. **GitHub Branch / Environment Protection:** Confirm `production` environment required reviewers and `master` branch protection remain active.
