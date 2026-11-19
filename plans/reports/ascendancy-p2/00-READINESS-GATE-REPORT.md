# Gate G0 — Workspace, Runtime, Git & Baseline Test Proof

- **Date:** 2026-11-18
- **Clean Phase 2 Worktree:** `/Users/macbook/apex-os-worktrees/phase2-ascendancy`
- **Branch:** `feat/ascendancy-phase2-verified` (branched cleanly from `origin/master` @ `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d`)
- **Status:** PASSED (`G0`, `G1`, `G2` Wave A Pre-Flight Complete)

---

## 1. Environment & Sibling Worktree Isolation Proof

- **Node.js Runtime:** `v26.7.0` (`/opt/homebrew/opt/node@26/bin/node`, ABI `147` matching `better-sqlite3` native binding and `.nvmrc`).
- **Package Manager:** `npm 11.11.0` with symlinked `/Users/macbook/apex-os/node_modules` (`pnpm` virtual store layout preserved).
- **Sibling Worktree Safety:**
  - `/Users/macbook/apex-os` (`master`): untouched (`plans/` untracked artifacts left intact).
  - `/Users/macbook/apex-os-worktrees/ascendancy-audit` (`feat/ascendancy-phase2-portal-poller` @ `a0d663b8` with 42 dirty entries): inspected strictly read-only; zero mutations made.
  - `/Users/macbook/apex-os-worktrees/phase2-ascendancy` (`feat/ascendancy-phase2-verified`): dedicated isolated worktree for all Phase 2 implementation and verification.

---

## 2. Clean `origin/master` Baseline Verification (`f4285c5d`)

Executed on `/Users/macbook/apex-os-worktrees/phase2-ascendancy` prior to any code edits:

1. **TypeScript (`npm run typecheck`):**
   - Exit code `0` (`tsc --noEmit` — zero errors).
2. **Phase 1 Sandbox Suite (`npm test -- --runInBand src/__tests__/sandbox`):**
   - `10/10` test suites passed, `99/99` tests passed (`1.749s`).
   - Verified suites:
     - `g0-binance-standard-block.test.ts`
     - `g1-partner-adapters.test.ts`
     - `g2-cash-collected-reconciliation.test.ts`
     - `g3-atomic-ledger.test.ts`
     - `g4-turnkey-safe-signer.test.ts`
     - `g5-fraud-sybil-graph.test.ts`
     - `g6-vn-geofence-shortener.test.ts`
     - `g7-passkey-timelock-audit.test.ts`
     - `ledger-units-and-waterfall.test.ts`
     - `r2-evidence-vault.test.ts`

---

## 3. Prior Unverified Attempt Audit (`ascendancy-audit` Read-Only Forensics)

Read-only inspection of `/Users/macbook/apex-os-worktrees/ascendancy-audit` revealed why the prior unmerged draft could not ship as-is and informed our clean-room Phase 2 engineering:

1. **Migration Fragmentation:** Split across `031_ascendancy_phase2_ui_and_poller.sql` and untracked `032_partner_reconciliation_deposits.sql`, without `short_link_clicks` click-counter telemetry or `b2b_agency_contracts` B2B contract visibility. Consolidated into a single additive `031_ascendancy_phase2_ui_and_poller.sql` in `phase2-ascendancy`.
2. **Unresolved G1 Commercial Split Contradictions:** `README.md`, `CLAUDE.md`, `en.json`, and `vi.json` still advertised legacy `30% / 10% / 5%` multi-tier splits contradicting the `80% / 10% / 0% / 10%` `DoubleEntryLedgerService` engine. Documented and locked in `01-SPLIT-POLICY-RECONCILIATION.md`.
3. **Unresolved G2 Third-Party Domain Drift:** Runtime fallbacks, `.github/workflows/deploy.yml`, `wrangler*.jsonc` WebAuthn vars, and mobile configs still pointed to unowned/third-party domains (`apexos.app` on Render, `apex-os.pages.dev` third-party SPA, parked `apex-os.com`, SiteGround `apexos.io`). Documented and locked in `02-DOMAIN-DEPLOYMENT-RECONCILIATION.md`.
4. **Proven Financial Concurrency & Broadcast Recovery Fixes Preserved:** Read-only audit confirmed three genuine Phase 1 integration fixes discovered during adversarial testing (concurrent clawback cap race guard in `double-entry-ledger.ts`, atomic `SIGNING` slot reservation + Stellar-only V1 config in `turnkey-signer.ts`, and `passiveOnly` cron reconciliation + 300s stale-signing guard in `broadcast-recovery-machine.ts`). Each will be verified with dedicated regression tests and documented line-by-line in `08-LEDGER-PAYOUT-SAFETY.md`.

---

## 4. Wave A Gate Status Summary

| Gate | Description | Artifact | Verdict |
| --- | --- | --- | --- |
| **G0** | Workspace, Runtime (`v26.7.0`), Git Isolation & Baseline Test Proof | `00-READINESS-GATE-REPORT.md` | **PASS** |
| **G1** | Commercial Split & Waterfall Reconciliation (`80 / 10 / 0 / 10` Canonical) | `01-SPLIT-POLICY-RECONCILIATION.md` | **PASS** |
| **G2** | Domain, Brand & Deployment Provenance Reconciliation | `02-DOMAIN-DEPLOYMENT-RECONCILIATION.md` | **PASS** |

---

## 5. Unresolved Questions

- None blocking Wave B–E implementation. Custom Cloudflare Zone cutover remains an external operator DNS action tracked in `02-DOMAIN-DEPLOYMENT-RECONCILIATION.md`.
