# SANDBOX-G0-REPORT — ApexOS Baseline Forensic Audit (Gate G0)

- **Audit Date:** 2026-11-14 (Asia/Saigon)
- **Repository:** `minhlongs/apex-os`
- **Tracking Issue:** `#53` (`feat(audit): ApexOS Viability Audit re-architecture & sandbox gates G0–G13`)
- **Isolated Branch:** `feat/ascendancy-audit-g0-g13` (worktree `/Users/macbook/apex-os-worktrees/ascendancy-audit`)

---

## 1. Frozen Baseline Anchor States

| Artifact | Verified Value | Verification Command |
|---|---|---|
| `origin/master` HEAD SHA | `c715a0e0d2b571213c254b649fd16bdb702912f3` | `git rev-parse origin/master` |
| `apex-os-mobile` Submodule SHA | `6848726311d795086df682f36636202f138c5008` | `git submodule status --recursive` |
| Node.js Runtime | `v26.7.0` (`engines.node: >=26.0.0 <27`, ABI 147) | `node -v` |
| CI Authoritative Lockfile | `package-lock.json` (`npm ci` in `.github/workflows/ci.yml:36`); stale secondary `pnpm-lock.yaml` also present | `ls -la package-lock.json pnpm-lock.yaml` |
| Baseline Test Suite (`master`) | **155 suites passed, 3,470 tests passed, 1 skipped** (`16.09s`) | `CI=true npm test` |
| Git History Live Secret Scan | **0 real private keys leaked** (`0x9f86d08...` is SHA-256 of `"test"`; `SA5ZSE...` is Circle public key with `G` swapped to `S` in a test fixture; `SAXXXX...` is a doc placeholder) | `git log -S` + regex inspection |

---

## 2. Empirical Resolution of the 3 Historical Contradictions

The external viability audit (`ApexOS Crypto Affiliate Viability Audit.pdf`, Section R02 & Gate G0) flagged three contradictions as `UNKNOWN` due to private repository visibility. Direct inspection of `c715a0e0d2b571213c254b649fd16bdb702912f3` resolves all three:

### Contradiction 1 — Runtime, Version & Dependency Drift (`README.md` / `CLAUDE.md` vs `package.json`)
- **Observed Reality:**
  - `README.md:1-6` claims version `v1.1.0` and `120 suites | 2,893 passed`, whereas `package.json:3` is at `1.5.0` with `155 suites | 3,470 passed`.
  - Framework is **Next.js `16.4.3`** deployed via **`@opennextjs/cloudflare@1.20.13`** (`wrangler@4.152.0`) using **Jest `29.7.0`** + `better-sqlite3@12.11.1` on **Node `26.7.0`** (not Hono/Vitest).
  - `package.json` carried `stellar-sdk@^12.3.0` (predating Stellar Protocol 30 `"Bell"` scheduled for **2026-11-23**) and `better-auth@0.8.7-beta.5` (6 `high` transitive advisories in `npm audit --omit=dev`).
- **Remediation Action in This Branch:** Upgrade to `@stellar/stellar-sdk@17.4.0`, `decimal.js@10.6.0`, `viem@2.57.19`, `@turnkey/sdk-server@8.9.1`, `json-rules-engine@7.3.1`, `@simplewebauthn/server@14.1.0`, `better-auth@^1.7.23`, and `zod@^4.6.7` (`0` High/Critical prod advisories, `0` `AGPL/GPL/SSPL/ELv2` packages).

### Contradiction 2 — `SECURITY-AUDIT.md` Findings vs Actual Route Posture
- **Observed Reality:**
  - `SECURITY-AUDIT.md` (dated `2026-06-21`) flagged missing rate limiting, missing Binance/Bybit timestamp enforcement, and partial admin protection.
  - Subsequent commits added middleware rate limiters (`src/middleware.ts:32-69`), KV/D1 replay protection (`src/lib/webhooks/replay-protection.ts`), and timestamp checks.
  - **Remaining Real Gaps Verified in Source:**
    1. Exchange ingestion (`src/app/api/webhooks/exchange/route.ts`, `okx/route.ts`, `kucoin/route.ts`) still assumes per-trade webhooks and asks users to link personal exchange trade API keys (`src/app/api/profile/exchange-keys/route.ts`), while `src/lib/webhooks/earnings.ts:52` computes `notional * cashbackPercent` directly instead of reconciling partner `CASH_COLLECTED` commissions.
    2. Admin & payout mutation endpoints (`src/app/api/payouts/route.ts`, `src/app/api/admin/payouts/*`) check session role (`role === 'admin'`) without WebAuthn Passkey step-up, and `src/app/api/profile/wallet/route.ts` updates `profiles.wallet_address` immediately with **0-hour timelock** (vulnerable to ATO instant payout redirection).
    3. `src/middleware.ts:7` defaults to `DEFAULT_LOCALE = 'vi'` with **zero Geo-Fencing** for restricted jurisdictions (`SG, US, GB, EEA, CN, HK, JP, TR, RU, BY, OFAC`) and no `BLOCK_VN_SIGNUPS` kill-switch, while `src/app/api/kyc/initiate/route.ts` initiates third-party KYC identity sessions contrary to Law `91/2025/QH15` data-minimization rules.

### Contradiction 3 — Stellar-Only V1 Gate vs Multichain Payout Rails & Decimal/Issuer Mismatches
- **Observed Reality:**
  - `src/lib/payouts/router.ts:242-259` enforces `V1_STELLAR_ONLY_PAYOUTS` (blocking `ethereum` L1 and `solana` in production), yet `SUPPORTED_PAYOUT_CHAINS` only lists `['stellar', 'ethereum', 'solana']` — **neither `arbitrum` nor `base` exists**.
  - **Critical Scale & Issuer Defects:**
    1. `src/lib/money/constants.ts:11` hardcodes `USDC_DECIMALS = 6` across all chains, whereas Stellar USDC uses **7 decimals** (`10^7` stroops) and Arbitrum/Base USDC uses **6 decimals** (`10^6`).
    2. Two production files hardcode **two different erroneous Stellar USDC issuers**: `src/lib/payouts/adapters/stellar-adapter.ts:26` uses testnet issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, while `src/lib/payouts/stellar-service.ts:49` uses `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGZX3UPOJ2FJ3FNB6DK6L3` (corrupted suffix vs Circle's canonical `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`).
    3. Raw signing keys (`src/lib/payouts/crypto/ed25519-signer.ts`, `secp256k1-signer.ts`, `STELLAR_SECRET_KEY`) execute inside Worker memory without Turnkey HSM isolation (`<=$250/tx`, `<=$1,500/24h`) or `BROADCAST_PENDING` (`TimeBounds(180s)` / `signer_nonces`) timeout recovery.

---

## 3. Monetary Float & Ledger Findings (`G0` -> `G3` Input Map)

- `src/lib/earnings/types.ts:78`: `DEFAULT_TIER_RATES` is hardcoded to 3-tier `0.30 / 0.10 / 0.05` (violating Decree `40/2018/NĐ-CP` on 3-level digital MLM and risking insolvency under VIP fee tiers).
- `src/lib/money/split.ts:12`: Remainder dust is gifted to Tier 1 rather than retained via `ROUND_DOWN`.
- `src/lib/webhooks/earnings.ts:59`: Projects integer minor units back into `REAL` float (`Number(fromMinorUnits(amount)) / 1e6`) with single-entry `earnings` rows, zero `T+7` hold, and zero `CASH_COLLECTED` reconciliation.
- `src/lib/payouts/stellar-service.ts:397,583,827,1053` & `ethereum-adapter.ts:153,240`: Uses `parseFloat(...)` and `Math.round(params.amount * 10 ** 6)` float conversion on payout amounts.

---

## 4. Gate G0 Verdict

- **Status:** **PASS** (Clean isolated baseline established from `c715a0e0d2b571213c254b649fd16bdb702912f3`, zero leaked production keys in history, all three contradictions empirically resolved in source). Proceeding to implementation and verification of Gates `G1–G12`.
