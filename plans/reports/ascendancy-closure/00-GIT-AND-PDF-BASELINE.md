# 00 — Live Git & PDF Research Baseline

**Execution Date:** 2026-11-22  
**Worktree:** `/Users/macbook/apex-os-worktrees/phase2-ascendancy`  
**Branch:** `feat/ascendancy-phase2-verified`  
**PR:** #56 (Draft, base `master`)  
**Tracking Issue:** #55  

---

## 1. Live Git Reconstruction (GATE A0)

| Check | Observed Truth | Classification |
|-------|---------------|----------------|
| Pre-remediation `HEAD` | `262b070a0f07eeb3367415bb192ed2bf717f5867` | `VERIFIED_BY_EXECUTION` |
| Remote `origin/feat/ascendancy-phase2-verified` | `262b070a0f07eeb3367415bb192ed2bf717f5867` (matched local pre-commit) | `VERIFIED_BY_EXECUTION` |
| Merge-base with `origin/master` | `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d` | `VERIFIED_BY_EXECUTION` |
| PR #56 state | `OPEN`, `isDraft: true`, base `master`, mergeable | `VERIFIED_BY_EXECUTION` |
| Migrations `031` & `032` | Present (`031_ascendancy_phase2_ui_and_poller.sql`, `032_persistent_d1_rate_limits.sql`) | `VERIFIED_IN_CODE` |
| New Treasury migrations added | `033_cold_settlement_claims.sql`, `034_withdrawal_freeze_at_write.sql`, `035_payout_effect_grants.sql`, `036_durable_hot_exposure.sql` | `VERIFIED_IN_CODE` |
| Scratch files cleaned | 36 `plans/reports/ascendancy-p2/g16-*.txt` and `g16-*.patch` removed | `VERIFIED_BY_EXECUTION` |
| Push-trigger inspection | `.github/workflows/ci.yml` runs read-only checks on `feat/**`; `.github/workflows/deploy.yml` triggers strictly on `workflow_dispatch` | `VERIFIED_IN_CODE` |

---

## 2. Research PDF Baseline (GATE A1)

- **Target Document:** `ApexOS Crypto Affiliate Viability Audit.pdf` (95 pages, R01–R12, dated 2026-11-14)
- **Local Availability Check:** Not present in `/Users/macbook/apex-os`, `/Users/macbook/apex-os-worktrees/phase2-ascendancy`, or mounted workspace directories.
- **Classification:** `PDF_SOURCE_NOT_LOCALLY_AVAILABLE`
- **Rule Applied:** No uninspected PDF claim is fabricated as read. Traceability in `01-R01-R12-TRACEABILITY.md` maps all concrete requirements reproduced in Supreme Command #07 plus verifiable repository artifacts (`src/`, `migrations/`, `plans/reports/ascendancy-p2/`), explicitly flagging any uninspected PDF-only details as `PDF_SOURCE_NOT_LOCALLY_AVAILABLE`.

---

## 3. Runtime & Toolchain Verification

- **Node.js:** `v26.7.0` (`/opt/homebrew/opt/node@26/bin/node`, ABI 147 for `better-sqlite3`)
- **Quality Gates Executed on Remediated Tree:**
  - `npm run typecheck` — PASS (0 errors)
  - `npm run lint` — PASS (0 errors, 0 warnings)
  - `CI=true npm test -- --silent` — PASS (**190/190 suites**, **3,911 passed**, 1 skipped, 0 failed)
  - `bash scripts/assert-staging-isolation.sh` — PASS (`STAGING_ISOLATED`)
  - `npm run build` & `npm run build:worker` — PASS (`.open-next/worker.js`)
