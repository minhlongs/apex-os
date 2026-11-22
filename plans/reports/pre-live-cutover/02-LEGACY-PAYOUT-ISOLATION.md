# 02 — G23.2 Hard-Disable Legacy Money-Moving Paths

**Date:** 2026-11-22  
**Branch:** `fix/apex-pre-live-cutover-hardening`  
**Workstream:** G23.2 (Deferred High H1)  
**Target:** `StellarService.processBatchPayouts` (`src/lib/payouts/stellar-service.ts`)

---

## 1. Full Call-Graph Audit
Searched across `src/`, `__tests__/`, `scripts/`, `docs/`, and `worker-wrapper.js`:

| Surface | Findings |
|---|---|
| Direct `processBatchPayouts` callers | Only `src/lib/payouts/stellar-service.ts:925` (definition) and `__tests__/payouts/stellar-service.test.ts` (legacy unit tests). Zero HTTP routes, zero Worker crons, zero scripts. |
| `StellarService` re-exports | `src/lib/payouts/index.ts` re-exports `StellarService`, `createStellarService`, and now `LegacyPayoutPathDisabledError`. |
| Read-only `StellarService` callers | `src/app/api/admin/settings/stellar/health/route.ts`, `src/lib/admin/stellar-actions.ts`, `src/lib/payouts/stellar-horizon-transport.ts`, `src/lib/payouts/adapters/stellar-adapter.ts` — all preserved intact for passive balance, trustline, transaction, and health checks. |

---

## 2. Hardening Applied
- Added exported `LegacyPayoutPathDisabledError` (`code = 'LEGACY_PAYOUT_PATH_DISABLED'`) in `src/lib/payouts/stellar-service.ts` and re-exported it from `src/lib/payouts/index.ts`.
- Replaced the entire legacy money-moving implementation of `StellarService.processBatchPayouts` (including its `dryRun` branch, `db.getPendingEarnings`, `db.createPayout`, `this.sendPayout`, and `db.markEarningsPaid`) with an unconditional fail-closed throw of `LegacyPayoutPathDisabledError`.
- Removed unused `track` analytics import from `src/lib/payouts/stellar-service.ts`.
- Preserved all read-only reconciliation and inspection methods (`getAccount`, `getUSDCBalance`, `getXLMBalance`, `hasUsdcTrustline`, `getTransaction`, `verifyPayout`, `healthCheck`).

---

## 3. Regression Verification
Command:
```bash
npx jest __tests__/payouts/stellar-service.test.ts __tests__/payouts/legacy-payout-isolation.test.ts --no-coverage
```
Result: **2 passed, 41 tests passed, 0 failed**.

Verified assertions:
- Direct invocation of `StellarService.processBatchPayouts(db)` throws `LegacyPayoutPathDisabledError` (`code === 'LEGACY_PAYOUT_PATH_DISABLED'`).
- Even `dryRun: true` fails closed immediately.
- `sendPayout`, `submitTransaction`, `getPendingEarnings`, `createPayout`, and `markEarningsPaid` are called **0 times**.
- Passive reconciliation methods remain functional.

**Acceptance:** `LEGACY_PAYOUT_EXECUTION = 0` — **PASS**.
