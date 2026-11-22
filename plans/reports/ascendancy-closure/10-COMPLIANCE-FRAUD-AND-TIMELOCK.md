# 10 — Compliance, Anti-Fraud, Sanctions & 48h Wallet Timelock

**Status:** `VERIFIED_BY_EXECUTION` (code & deterministic tests) / `BLOCKED_EXTERNAL_DEPENDENCY` (production WebAuthn RP ID, live sanctions feed & legal entity).

---

## 1. Verified Controls

- **Sanctions Screening (`src/lib/compliance/sanctions-service.ts`):** Integrated into `BroadcastRecoveryMachine` and payout dispatch; fail-closed on sanctioned addresses.
- **WebAuthn / Passkey Admin Gate (`src/app/api/admin/passkey/route.ts`, `src/app/api/admin/settlement/dispatch/route.ts`):** Sensitive admin settlement dispatch and runtime-flag operations require verified Passkey assertion.
- **48-Hour Wallet Timelock & Geo-Fence (`src/lib/payouts/usdc-safety-guards.ts`):** New or changed payout wallet addresses enforce 48-hour withdrawal timelock; restricted jurisdictions blocked fail-closed.
- **Immutable Compliance Audit Log (`compliance_audit_logs`):** Runtime flag updates are atomically logged via `mutateRuntimeFlagWithAudit` (`db.batch`).

## 2. External Blockers

- Production WebAuthn RP ID configuration (requires production domain — NOT modified in this run).
- Legal entity & formal regulatory opinion (`BLOCKED_EXTERNAL_DEPENDENCY`).
