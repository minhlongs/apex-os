# Ascendancy Phase 2 — Implementation & Verification Report

- **Date:** 2026-11-18
- **Worktree:** `/Users/macbook/apex-os-worktrees/phase2-ascendancy`
- **Branch:** `feat/ascendancy-phase2-verified` (clean-branched from verified `origin/main` @ `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d`)
- **Verification Verdict:** **GO FOR STAGING DEPLOYMENT** (`177/177` Jest suites | `3,621` passed tests | `tsc --noEmit` 0 errors | `next build --webpack` exit `0` | `STAGING_ISOLATED`)

---

## 1. Readiness Gates (G0–G2) Summary

| Gate | Verdict | Evidence |
|---|---|---|
| **G0 — Baseline Forensic & Branch Provenance** | **PASS** | Clean worktree created from `origin/main` (`f4285c5`). Sibling `ascendancy-audit` worktree audited read-only; four latent defects in `ascendancy-audit` were caught and remediated before landing (`00-BASELINE-FORENSIC.md`). |
| **G1 — Split Policy & Decree 40/2018/ND-CP Reconciliation** | **PASS** | Single source of truth reconciled: Retail 1-Tier default (`5.00%` reserve / `47.50%` trader / `14.25%` L1 / `0.00%` L2 / `0.00%` L3 / `33.25%` platform) + White-Label B2B Agency L2 override (`<= 1,000 bps` of spread `S`, `L1 + L2 <= 4,500 bps` of `S`, `L3 === 0` hard-locked in D1 `CHECK` + TypeScript) (`01-SPLIT-POLICY-RECONCILIATION.md`). |
| **G2 — Domain, Brand & Deployment Provenance** | **PASS** | Live DNS/HTTP/Wrangler audit proved `apexos.app`, `apex-os.pages.dev`, `apex-os.com`, and `apexos.io` are third-party or unowned, and `*.long-tran624.workers.dev` is `NXDOMAIN`. Canonical origins locked to `https://apex-os.agencyos-openclaw.workers.dev` (prod) and `https://apex-os-staging.agencyos-openclaw.workers.dev` (staging) via `src/config/canonical-origin.ts`, `wrangler.jsonc`, `wrangler.staging.jsonc`, and `.github/workflows/deploy.yml` (`02-DOMAIN-DEPLOYMENT-RECONCILIATION.md`). |

---

## 2. Workstreams Delivered

### WS-A — Automated 5-Exchange Partner API Poller & 30-Day Shadow Gate
- **Partner HTTP Clients & Adapters:** `src/lib/partners/http-signing.ts`, `bybit-affiliate-adapter.ts`, `okx-affiliate-adapter.ts`, `bitget-broker-adapter.ts`, `kucoin-uta-v2-adapter.ts`, `gateio-v4-adapter.ts`, `partner-poller.ts`, `shadow-gate-service.ts`.
- **Migrations & Endpoints:** `src/database/migrations/031_ascendancy_phase2_ui_and_poller.sql` (`partner_sync_cursors`, `partner_shadow_reconciliations`, `b2b_agency_contracts`), `/api/admin/partners/poll`, `/api/admin/partners/shadow-gate`, and daily `02:00 UTC` cron schedule (`0 2 * * *`).
- **Critical Fixes Over Raw `ascendancy-audit`:**
  1. Preserved `worker-cron-schedules.js` and `worker-wrapper.js` per-schedule routing (`15 * * * *` outbox/analytics, `*/5 * * * *` reconciliation, `0 2 * * *` partner poller) instead of overwriting `worker-wrapper.js`.
  2. Wired `getB2bAgencyContractByProfileId()` into `partner-poller.ts` so provisioned B2B Agency L2 overrides execute automatically during daily partner commission ingestion.

### WS-B — Settlement Reconciler & Turnkey HSM / Safe 2-of-3 Dispatch
- **On-Chain Reconciler:** `src/lib/payouts/settlement-reconciler.ts` verifies `BROADCAST_UNCERTAIN` and `SUBMITTED` payouts against Stellar Horizon (`transaction_hash` + memo + destination + amount) and Arbitrum/Base JSON-RPC receipts (`eth_getTransactionReceipt` + ERC-20 `Transfer` logs) before finalizing or releasing holds.
- **Passkey-Gated Dispatch:** `/api/admin/settlement/dispatch` enforces WebAuthn Passkey step-up (`X-Passkey-Stepup-Token`), Turnkey HSM signing caps (`<= $250/tx`, `<= $1,500/24h`), and Safe 2-of-3 multisig queuing above cap.
- **Critical Fix Over Raw `ascendancy-audit`:** Fixed `src/lib/payouts/turnkey-signer.ts` dynamic import path (`@turnkey/sdk-server`) and hardened `src/lib/ledger/proof-of-rebate.ts` R2 retrieval fallback (`arrayBuffer()` when `text()` is absent).

### WS-C — Trader Rebate Portal, Admin Treasury Console & B2B Proof-of-Rebate
- **Trader & Partner Portal (`src/app/[locale]/dashboard/`):** UID-only connection manager (strictly rejecting API keys/withdrawal secrets), `10^-8` USD ledger state breakdown (`PENDING_T7`, `SETTLED_AVAILABLE`, `CLAWED_BACK`), 48h timelocked self-custody wallet binding (Stellar, Arbitrum, Base), and clean-room `/r/[code]` short-link generator anchored to `resolveCanonicalAppOrigin()`.
- **Admin Treasury & Governance Console (`src/app/admin/treasury`, `/admin/passkey`, `/admin/reconciliation`, `/admin/fraud`):** WebAuthn Passkey enrollment + 5-minute step-up ceremony, Partner Poller & 30-day Shadow Gate controls, Settlement Dispatch panel, and **White-Label B2B Agency Split Contracts** provisioning panel (`b2b_agency_contracts` + `/api/admin/b2b-contracts`).
- **Public/Partner Cryptographic Proof-of-Rebate Verifier (`src/app/[locale]/b2b/proof-of-rebate`):** Client-side WebCrypto SHA-256 hash recomputation against Cloudflare R2 immutable raw payload hashes and `10^-8` USD waterfall audit trails.

### WS-D — Clean-Room Landing, Exact Rebate Calculator & Legal Perimeter
- **Landing & Calculator (`src/app/[locale]/landing/page.tsx`, `src/components/landing/rebate-calculator.tsx`):** Non-custodial UID-only positioning in EN & VI, integer `BigInt` Safe-Spread calculator across Bybit, OKX, Bitget, KuCoin, and Gate.io (with explicit Binance Referral Pro UID-privacy exclusion note), and zero Copy Trading / AI Signal / 3-Tier MLM claims.
- **Legal Perimeter (`src/app/[locale]/legal/{terms,non-custodial-disclosure,geo-restriction}/page.tsx`):** Localized Terms, Non-Custodial & MiCA Art. 3(1)(16) Disclosure, and Geo-Restriction HTTP `451` (`CF-IPCountry` + `BLOCK_VN_SIGNUPS`) pages registered in `sitemap.ts` and `robots.ts` on the verified canonical Worker origin.

---

## 3. Verification Matrix

- **Unit, Sandbox & Integration Tests (`npm test`):** `177 / 177` suites passed (`3,621` passed, `1` skipped, `0` failed).
- **TypeScript Strict Check (`npm run typecheck`):** `0` errors.
- **Production Next.js Webpack Build (`npm run build`):** Compiled and statically generated `112/112` pages with exit code `0`.
- **Staging/Production Resource Isolation (`bash scripts/assert-staging-isolation.sh`):** `STAGING_ISOLATED` (distinct D1, KV, R2, and `APP_ENV` bindings).

---

## 4. Unresolved Questions

1. Which operator-owned Cloudflare Zone on account `f691e83094f776311a1bfe3f8b126f1c` (or newly acquired custom domain) should be bound as the permanent custom production hostname via Worker Custom Domains, Resend DKIM/SPF, and `WEBAUTHN_RP_ID` so WebAuthn passkeys do not require re-enrollment after leaving `*.agencyos-openclaw.workers.dev`?
2. Should migration `031_ascendancy_phase2_ui_and_poller.sql` be applied to remote staging D1 (`be4ed659-c877-4820-ae6e-9747bc7ee316`) immediately prior to `npm run deploy:staging`?
