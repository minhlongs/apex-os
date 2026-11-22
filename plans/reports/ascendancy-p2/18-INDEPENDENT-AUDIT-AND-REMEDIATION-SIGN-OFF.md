# Ascendancy Phase 2 — Independent Forensic Audit & Remediation Sign-Off (`G1–G11`)

- **Date:** 2026-11-19
- **Worktree:** `/Users/macbook/apex-os-worktrees/phase2-ascendancy`
- **Branch:** `feat/ascendancy-phase2-verified`
- **Runtime:** Node.js `26.7.0`
- **Verdict:** **READY FOR CLEAN COMMIT & DRAFT PR** (Production auto-deploy remains strictly manual via `workflow_dispatch`; `AUTO_SETTLE_PAYOUTS = "false"`; `V1_STELLAR_ONLY_PAYOUTS = "true"`).

---

## 1. Independent Verification Summary

| Gate | Scope | Independent Audit Result | Post-Remediation Status |
|---|---|---|---|
| **G1** | Phase 1 vs Phase 2 vs Docs Reconciliation | Found stale 3-tier `30/10/5%`, Binance/KuCoin, Polar webhook, Ethereum/Solana, raw `STELLAR_SECRET_KEY`, and conflicting test counts in `README.md` and `CLAUDE.md`. | **PASS** — `README.md` and `CLAUDE.md` reconciled to Ascendancy v1.5.0 (`183 suites / 3,676 tests`, 47 migrations). |
| **G2** | Migration 031 & 032 + Isolated D1 Rehearsal | Verified `031_ascendancy_phase2_ui_and_poller.sql` & `032_persistent_d1_rate_limits.sql` on an isolated SQLite DB: clean upgrade `001..030 -> 031 + 032`, idempotent re-runs, FK/UNIQUE/CHECK constraints, `.backup`/restore `PRAGMA integrity_check = ok`. | **PASS** |
| **G3** | 5-Exchange Partner Poller & Cron | Found orphaned `wallet-deposit-normalizer.ts`, unused `partner_reconciliation_deposits` table, missing `nextCursor` pagination (including Gate.io array responses), missing-currency `'USDT'` fallback in Bybit/OKX/Bitget, L1 email passed into B2B fraud check, and non-constant-time `CRON_SECRET` check. | **PASS** — All 6 G3 findings fixed and covered by `src/__tests__/partners/partner-poller-hardening.test.ts`. |
| **G4** | Double-Entry Rebate Ledger & Safe-Spread Waterfall I4 | Verified `waterfall.ts`, `units.ts`, and `reconciliation-service.ts` untouched from Phase 1; verified all 10 ledger invariants (`10^-8` USD `bigint`, double-entry balance, `T+7` hold, reserve-first clawback, shadow isolation, tenant isolation). Upstream `CASH_COLLECTED` boundary hardened via G3 fixes. | **PASS** |
| **G5** | Trader Portal, UID Binding, Short Links & Wallet Timelock | Found missing CSRF/Origin + D1 rate-limit on `profile/wallet` & `profile/wallet/timelock`, raw `error.message` leaks in `profile/wallet`, JS summation over `LIMIT 200` postings, and raw internal UUID exposure in `affiliate/ledger-summary`. | **PASS** — CSRF + D1 rate-limit + sanitized errors added; SQL `SUM(CASE ...)` aggregation and `partner-<8hex>` masking implemented. |
| **G6** | Admin Console, Kill Switches & Ingestion | Found missing `verifyTrustedMutationOrigin` across G6 mutation routes, no immutable audit log on runtime-flag mutations, and operator `requestIp` leaked into `reconciliation/ingest` Sybil telemetry. | **PASS** — `verifyTrustedMutationOrigin` enforced inside `requireAdminWithPasskeyStepUp`; `compliance_audit_logs` written on flag mutations; operator IP removed from ingest telemetry. |
| **G7** | WebAuthn Passkey & Domain Hygiene | Found missing passkey revocation flow, step-up tokens not bound to active credential existence, `resolveStepUpSigningSecret` only guarded by `NODE_ENV === 'production'`, and `beginPasskeyRegistration` missing `supportedAlgorithmIDs: [-7]`. | **PASS** — Added `revoke_passkey` action, active credential DB verification, staging/prod fail-closed secret guard, ES256-only registration, and 5-char minimum reason on `set_runtime_flag`. |
| **G8** | Turnkey HSM & Zero Raw Secret (P0) | Found **P0** unguarded `GET /api/admin/payouts/treasury` calling legacy `PayoutRouter` raw-key adapters, hardcoded placeholder Cold Safe addresses in `turnkey-signer.ts`, unverified Cold Safe transfer details on manual confirmation, raw RPC error persistence in `settlement_broadcasts`, and unvalidated `horizonUrl` SSRF risk in `updateStellarConfig`. | **PASS** — `/api/admin/payouts/treasury` fails closed (`410`) when Turnkey/Ascendancy ledger is active; Cold Safe addresses fail closed in prod/staging; transfer recipient/asset/amount validated on confirmation; errors sanitized; Horizon URL restricted to HTTPS allowlist. |
| **G9** | Multichain Money Precision | Found `residualDust1e8` dropped on disbursement (`settlement/dispatch` + `broadcast-recovery-machine`), causing ledger `SETTLED_OUT` vs on-chain USDC drift. | **PASS** — Wired `ledgerUnitsToChainUnits` so `disbursableUnits1e8 = amountUnits1e8 - residualDust1e8` is locked/settled and `residualDust1e8` remains in the user's `settled` balance; `$10.00` floor enforced post-alignment. |
| **G10** | Non-Custodial, Geo & Legal Boundaries | Found **CRITICAL** hardcoded fallback HMAC secret in legacy `src/app/api/webhooks/ipn/route.ts:40-43`, unowned `'apex-os.com'` fallback in `payments/route.ts:32`, live `insights.ctaDesc` advertising "read-only API Key ID" + Binance, live `affiliates-client.tsx` rendering 3-tier `30%/10%/5%`, and EN `geo-restriction/page.tsx:67` misstating `BLOCK_VN_SIGNUPS` scope. | **PASS** — IPN fails closed (`503`) without secret; `'apex-os.com'` removed; `affiliates-client.tsx` & `en.json`/`vi.json` updated to canonical Safe-Spread Waterfall I4 and UID-only Bybit/OKX/Bitget attribution; EN `geo-restriction` aligned with `geo-fence.ts` and VI copy. |
| **G11** | CI, Build, Tests & Secret Scan | Verified `.github/workflows/deploy.yml` is strictly `workflow_dispatch`-only, `wrangler.jsonc` & `wrangler.staging.jsonc` isolate staging/prod and enforce `AUTO_SETTLE_PAYOUTS = "false"` / `V1_STELLAR_ONLY_PAYOUTS = "true"`. | **PASS** — See Verification Commands below. |

---

## 2. Final Verification Commands (Post-Remediation)

- `bash scripts/assert-staging-isolation.sh` → **`STAGING_ISOLATED`** (exit 0)
- `npm run typecheck` (`tsc --noEmit`) → **0 errors** (exit 0)
- `npm run lint` (`eslint . --ext .ts,.tsx --max-warnings 0`) → **0 errors, 0 warnings** (exit 0)
- `CI=true npm test` → **183/183 suites passed, 3,676 passed, 1 skipped (3,677 total, 17.28s)** (exit 0)
- `npm run build` → **Next.js production build succeeded** (exit 0)
- `node scripts/verify-paper-economic-gate.cjs` → **`NO_GO` (fail-closed expected locally; no 30-day paper window records)**
- Secret pattern scan across all 135 modified/untracked files → **0 real secrets** (2 matches are synthetic canary strings inside unit tests verifying Stellar seed redaction: `__tests__/payouts/stellar-readonly-health.test.ts:29` and `__tests__/payouts/phase2-track-a-hardening.test.ts:87`).

---

## 3. Unresolved Items / Operator Actions Outside Code

- Live Cloudflare staging/production deployment, D1 remote migration execution (`031` & `032`), and real-market 30-day shadow/paper windows remain operator-gated via manual `workflow_dispatch` and are intentionally **not** triggered automatically.
