# 05 — Governance, 30-Day Shadow Promotion Gate & Runtime Flag Audit (G-01 & G-02)

**Findings:**
- `G-01`: Incomplete 30-day shadow promotion evidence.
- `G-02`: Runtime flags may update without durable audit logging.

**Status:** `CLOSED` (`VERIFIED_BY_EXECUTION`, Independent Reviewer C: `PASS`, 0 Critical / 0 High, 33/33 tests PASS, both Mediums fixed).

---

## 1. G-01 Remediation (`src/lib/partners/shadow-promotion-gate.ts`)

`validateShadowPromotionGate` enforces all 7 fail-closed invariants on `partner_shadow_reconciliations` joined with `r2_evidence_objects` before allowing `PARTNER_KUCOIN_LIVE = 'true'` or `PARTNER_GATEIO_LIVE = 'true'`:
1. Non-empty shadow history (`SHADOW_HISTORY_MISSING`).
2. Zero `SHADOW_DISCREPANCY` / unknown statuses, zero non-zero `discrepancy_units`, zero `unmapped_uid_count` (`SHADOW_DISCREPANCY_PRESENT`).
3. Complete R2 evidence provenance: matching `exchange`, valid 64-hex SHA-256 digest, valid counts (`SHADOW_PROVENANCE_INCOMPLETE`), and no future UTC timestamps (`SHADOW_FUTURE_TIMESTAMP`).
4. Full 30-day elapsed observation window (`evalNowMs - earliestMs >= 30 days`) with SQLite UTC timestamp normalization (`SHADOW_WINDOW_UNDER_30_DAYS`).
5. Freshness: latest clean batch within 48 hours (`SHADOW_EVIDENCE_STALE`).
6. Continuous coverage: ≥ 30 distinct UTC days in the trailing 30-day window and no consecutive gap > 48 hours (`SHADOW_COVERAGE_INCOMPLETE`).
7. **Window-Scoped Non-Zero Volume (post-audit fix):** `windowReconciledRows > 0 && windowMappedUids > 0` computed strictly over batches inside `[evalNowMs - 30d, evalNowMs]` (`SHADOW_INSUFFICIENT_VOLUME`), preventing stale pre-window volume from masking 30 days of empty runs.

Demotion (`flagValue === 'false'`) bypasses the promotion gate so operators can always fall back to shadow mode immediately. Live promotion flags remain disabled (`false`).

---

## 2. G-02 Remediation (`src/lib/admin/runtime-flag-audit.ts`, `src/lib/query-monitor.ts`)

- All runtime flag mutations (`src/app/api/admin/runtime-flags/route.ts` and `src/app/api/admin/reconciliation/poller/route.ts`) use `mutateRuntimeFlagWithAudit`, which executes the `runtime_flags` upsert and `compliance_audit_logs` insert in a single atomic `db.batch([...])` transaction.
- `QueryMonitor.batch()` unwraps tracked prepared statements via a `WeakMap` so monitored D1 bindings execute real native D1 atomic batches without losing statement bindings or falling back to non-atomic sequential writes.
- `src/app/api/admin/reconciliation/poller/route.ts` gates test-only clock overrides with `process.env.NODE_ENV === 'test' && !isProductionOrStagingRuntime()` (post-audit fix for Reviewer C Medium #2).

---

## 3. Verification Evidence

- `src/__tests__/admin/shadow-promotion-and-flag-audit.test.ts` + `src/__tests__/admin/ascendancy-admin-console.test.ts`: **33/33 tests PASS**.
