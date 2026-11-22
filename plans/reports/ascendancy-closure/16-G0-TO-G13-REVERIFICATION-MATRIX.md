# 16 — G0–G13 Sandbox Gate Re-Verification Matrix (R12)

**PDF Baseline Note:** Original page-level G0–G13 narrative (pp. 74–80) is `PDF_SOURCE_NOT_LOCALLY_AVAILABLE`. All executable sandbox gate suites present in `src/__tests__/sandbox/` and `__tests__/payouts/` were re-executed on Node `v26.7.0`.

| Gate | Scope | Primary Test Suite(s) | Classification |
|------|-------|-----------------------|----------------|
| **G0–G2** | Core schema, auth, tracking & attribution | Full Jest suite (190/190 suites) | `VERIFIED_BY_EXECUTION` |
| **G3 / G5** | Double-entry conservation, waterfall & dust | Ledger suites + `g16-dust-lifecycle.test.ts` | `VERIFIED_BY_EXECUTION` |
| **G6** | AuthZ & secret boundary (zero raw keys in Worker) | `src/__tests__/sandbox/g6-authz-secret-boundary.test.ts` | `VERIFIED_BY_EXECUTION` |
| **G7** | Multichain USDC settlement simulation (Stellar/Arbitrum/Base + Cold Safe) | `src/__tests__/sandbox/g7-settlement-simulation.test.ts` | `VERIFIED_BY_EXECUTION` |
| **G8** | Uncertain broadcast recovery & RBF safety | `src/__tests__/sandbox/g8-uncertain-broadcast-recovery.test.ts` | `VERIFIED_BY_EXECUTION` |
| **G9–G11** | Partner poller, shadow promotion gate & runtime flag audit | `phase2-ws-a-partner-poller.test.ts`, `shadow-promotion-and-flag-audit.test.ts` | `VERIFIED_BY_EXECUTION` |
| **G12** | Legacy boundary & staging isolation | `settlement-and-legacy-boundary.test.ts`, `assert-staging-isolation.sh` | `VERIFIED_BY_EXECUTION` |
| **G13** | Chaos / negative dispatch resilience | Sandbox negative-path dispatch tests (note: positive live-RPC chaos requires staging/testnet) | `VERIFIED_BY_EXECUTION` (offline negative paths) / `BLOCKED_EXTERNAL_DEPENDENCY` (live testnet chaos) |
| **G15.3** | Independent Security Review | Reviewer D (`PASS`, 118/118 tests, 0C/0H/0M) | `VERIFIED_BY_EXECUTION` |
| **G15.4 / G16** | Treasury Audit (T-01, T-02, T-03) | `g16-treasury-regressions.test.ts`, `g16-emergency-control-contracts.test.ts`, `durable-hot-exposure.test.ts` + Independent Re-Verifier | `VERIFIED_BY_EXECUTION` |
