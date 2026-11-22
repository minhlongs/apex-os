# 24 — G17 Final PR #56 Merge Review & Founder Decision Packet

**Date:** 2026-11-22  
**Repository:** `https://github.com/minhlongs/apex-os`  
**Branch:** `feat/ascendancy-phase2-verified`  
**Draft PR:** #56 (base `master`, mergeable, remains `DRAFT`)  
**Tracking Issue:** #55  
**Source Baseline SHA Audited:** `7da0d84c15d69e947699cbf98ed4744ab95cc335` (code frozen; only deterministic tests + G17 reports `20`–`24` added)

---

## 1. Concise Release Evidence Index (`00`–`24`)

- **Core Baseline & Remediation (`00`–`06`):** Git/PDF baseline (`00`), R01–R12 traceability (`01`), T-01 Cold Proof (`02`), T-02 Emergency Fence (`03`), T-03 Durable Rolling Cap (`04`), G-01 Shadow Promotion Gate (`05`), G-02 Atomic Flag Audit (`06`).
- **System Controls & Prior Audits (`07`–`19`):** Ledger/Waterfall (`07`, precision wording superseded by `20`), Dust (`08`, superseded by `20`), B2B Proof (`09`), Partner Poller (`10`), PWA/Ops (`11`), Security G15.3 (`12`), Unit Economics (`13`, expanded in `22`), Chaos (`14`), 30/60/90 Matrix (`15`), Quality Gates (`16`), Prior Audit Log (`17`), External Blockers (`18`), Prior Founder Packet (`19`).
- **G17 Final Release Gate & G18 Commercial Evidence (`20`–`24`):**
  - `20-G17-MONETARY-PRECISION-ATTESTATION.md` — Canonical `10^-8` / `10^-7` / `10^-6` unit map + exact conservation proof (`4/4` tests).
  - `21-G17-MIGRATION-031-036-RELEASE-DRILL.md` — SHA-256 checksums, fresh & historical upgrade drill, trigger guards, backup/restore (`3/3` tests).
  - `22-G17-R10-ECONOMIC-RECONCILIATION.md` — Exact Safe-Spread Waterfall I4 reconciliation for BEAR/BASE/BULL + 11 stress tests.
  - `23-G17-B2B-PILOT-READINESS.md` — Bybit/OKX/Bitget readiness register, 48h read-only experiment protocol, 30-day B2B pilot scorecard.
  - `24-G17-FINAL-PR56-MERGE-REVIEW.md` — This final decision packet + 6-reviewer independent audit synthesis.

---

## 2. Independent 6-Reviewer Audit Synthesis (G17.7 on HEAD `7da0d84c`)

| Reviewer | Domain | Verdict | Critical / High / Med / Low | Disposition |
|----------|--------|---------|-----------------------------|-------------|
| **Reviewer 1** | Ledger Precision, Dust & Conservation | `CONDITIONAL_PASS` | `0C / 3H* / 1M / 1L` | Active `/api/admin/settlement/dispatch` path has **0 unit drift**. *3H are library-boundary / unused legacy `StellarService.processBatchPayouts` guards — queued in **Pre-Live-Cutover Hardening PR** before enabling live funds. |
| **Reviewer 2** | T-01 Cold Settlement Proof & Finality | `PASS` | `0C / 0H / 1M / 1L` | All 5 T-01 invariants verified (136/136 targeted tests). 1M legacy cold row `confirmation_lane` fails closed; queued for follow-up. |
| **Reviewer 3** | T-02 Emergency Freeze & T-03 Rolling Cap | `PASS` | `0C / 0H / 2M / 2L` | All T-02/T-03 invariants verified (82/82 tests). Remaining TOCTOU window bounded to single post-grant HTTP request. 2M (`COALESCE` timestamp on promotion, 1-RBF-per-attempt cap) queued for follow-up. |
| **Reviewer 4** | D1 Migrations `031`–`036` Integrity | `CONDITIONAL_PASS` | `0C / 2H* / 1M / 2L` | 100% D1 SQLite compatible, 0 FK errors. *2H are operational rollout conditions (audit pre-`036` `settlement_broadcasts` rows; mandatory D1 backup + sequential single-shot `031`→`036`), documented in Report `21`. |
| **Reviewer 5** | Partner, B2B Rate Limit & HSM Controls | `CONDITIONAL_PASS` | `0C / 1H* / 1M / 1L` | Shadow gate & atomic flag audit PASS (15/15 tests). *1H (`TurnkeyServerHsmTransport` bounded timeout + error classification) required before live HSM cutover; 1M (`/api/b2b/proof-of-rebate` D1 rate limit) queued for Post-Merge GA PR. |
| **Reviewer 6** | Release Workflow, CI, PWA & Security | `CONDITIONAL_PASS` | `0C / 1H* / 1M / 3L` | Push-trigger safety, staging isolation (`STAGING_ISOLATED`), secrets hygiene, and `AUTO_SETTLE_PAYOUTS = "false"` all **PASS**. *1H (missing `icon-192.png`/`icon-512.png`), 1M (pin GitHub Actions to Node 24 / SHA), and 1L (skipped Resend test at `notification-channels.test.ts:368` hides zero security gap) queued for Post-Merge GA PR. |

---

## 3. G17.4 Small GA Hardening Triage (Frozen Out of PR #56)

Per the locked PR #56 source-freeze policy, **none** of these items block merging PR #56 into `master` while `AUTO_SETTLE_PAYOUTS = "false"` and live settlement remains disabled:

1. **Pre-Live-Cutover Hardening PR (Required BEFORE live Turnkey HSM / real USDC):**
   - `TurnkeyServerHsmTransport`: add bounded timeout (`10–15s`), explicit retry/redirect suppression, and `DEFINITE_REJECTED` vs `UNCERTAIN_OUTCOME` error classification.
   - Library-boundary precision guards: assert `residualDust1e8 === 0n` in `lockSettledForWithdrawal`, `ledgerUnits1e8ToStellarStroops`, `ledgerUnits1e8ToEvmUsdcUnits`; enforce `lock.gross_commission_units === disbursableUnits1e8` in hot lane; hard-disable legacy `StellarService.processBatchPayouts`; replace `Number(bigint)` with `toSafeSqlInteger` in `turnkey-signer.ts:822,1066`.
   - Trigger & exposure polish: match `NEW.payout_id` in `035`/`036` `WITHDRAWAL_REVERTED` triggers; update `confirmation_observed_at = unixepoch('now')` unconditionally on `UNVERIFIED_HOT → HOT` promotion; align `worker-wrapper.js:247` to `!== 'true'`.
2. **Post-Merge GA Hygiene PR (Required BEFORE public PWA launch):**
   - Migrate `/api/b2b/proof-of-rebate/route.ts:218` from in-memory `checkSlidingWindowRateLimit` to durable D1 `enforcePersistentD1RateLimit` (migration `032`).
   - Add valid `public/assets/icons/icon-192.png` and `icon-512.png` + disk-existence assertion in `g11-security-compliance.test.ts`.
   - Upgrade & SHA-pin `.github/workflows/ci.yml` and `deploy.yml` actions (`actions/checkout`, `actions/setup-node`) to Node 24-compatible releases with explicit `permissions: { contents: read }`.
   - Fix Jest hoisting + Resend constructor mock in `__tests__/lib/notifications/notification-channels.test.ts:368`.

---

## 4. Founder Decision Matrix (Decisions A–F)

| Decision | Scope | Recommended Verdict | Hard Conditions / Notes |
|----------|-------|---------------------|-------------------------|
| **Decision A** | Merge PR #56 (`feat/ascendancy-phase2-verified` → `master`) | **`GO` (Conditional on Founder Review & Fresh CI Green)** | Codebase is frozen, verified, and has `AUTO_SETTLE_PAYOUTS = "false"`. Merge **does NOT** deploy or enable funds. |
| **Decision B** | Remote Staging Deployment & D1 Migrations `031`–`036` | **`CONDITIONAL_HOLD` (Ready After Decision A)** | Requires explicit Founder approval, pre-flight D1 export backup, legacy `settlement_broadcasts` audit, sequential `031`→`036` execution, and staging soak with `AUTO_SETTLE_PAYOUTS = "false"`. |
| **Decision C** | Post-Merge Hardening & GA Hygiene PRs | **`GO` (Execute Immediately After Decision A)** | Ship Pre-Live-Cutover Hardening PR (HSM timeout + library dust guards) and GA Hygiene PR (B2B D1 rate limit + PWA icons + CI SHA pinning). |
| **Decision D** | Live Production Deployment & Real USDC Settlement | **`NO-GO` (`BLOCKED_EXTERNAL`)** | Blocked on: Pre-Live-Cutover Hardening PR, production Turnkey HSM + Safe/Stellar cold vaults, signed legal/compliance review, and staging soak sign-off. |
| **Decision E** | Shadow Partner Promotion (KuCoin / Gate.io) | **`NO-GO` (`BLOCKED_EXTERNAL`)** | Hard-locked by `shadow-promotion-gate.ts` until 30 continuous days of live zero-discrepancy R2-proven reconciliation exist. |
| **Decision F** | G18 Commercial Validation (Bybit/OKX/Bitget + 48h Experiment + B2B Pilot) | **`GO_COMMERCIAL_TRACK` (External Founder Execution)** | Begin Milestone A partner agreements & legal review now; 48h experiment requires separate Founder sign-off & exchange permission; do not treat green CI as business traction. |

---

## 5. G17.8 Final Verification Gate Results (Node `v26.7.0`)

| Gate | Command | Result | Evidence |
|------|---------|--------|----------|
| **Staging Isolation** | `bash scripts/assert-staging-isolation.sh` | `PASS` | `STAGING_ISOLATED` (`AUTO_SETTLE_PAYOUTS = "false"`) |
| **TypeScript Check** | `npm run typecheck` | `PASS` | 0 errors |
| **ESLint Check** | `npm run lint` | `PASS` | 0 errors, 0 warnings |
| **Full Jest Suite** | `CI=true npm test -- --silent` | `PASS` | **192/192 suites passed**, **3,918 passed**, 1 skipped (`notification-channels.test.ts:368`, Resend mock hoisting — zero security/financial gap), 0 failed (12.88s) |
| **OpenNext Worker Build** | `npm run build:worker` | `PASS` | Next.js 16.4.6 + `@opennextjs/cloudflare 1.20.13`, 112/112 pages, `.open-next/worker.js` generated |
| **Production Source Diff** | `git diff --stat 7da0d84c` | `PASS` | **0 production source files modified** (only 2 deterministic G17.2/G17.3 test suites + reports `20`–`24` added) |
