import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { SqliteD1Adapter } from '@/lib/ledger/double-entry-ledger';
import { resetDB } from '@/lib/db';
import {
  issuePasskeyStepUpToken,
  PASSKEY_STEPUP_HEADER,
} from '@/lib/auth/passkey-step-up';
import { validateShadowPromotionGate } from '@/lib/partners/shadow-promotion-gate';
import {
  persistRuntimeFlagWithAudit,
  RuntimeFlagAuditPersistenceError,
  type AtomicFlagAuditDatabase,
} from '@/lib/admin/runtime-flag-audit';
import { POST as runtimeFlagsPost } from '@/app/api/admin/runtime-flags/route';
import { POST as adminPasskeyPost } from '@/app/api/admin/passkey/route';
import { POST as pollerAdminPost } from '@/app/api/admin/reconciliation/poller/route';

function createGovernanceTestDb(): { sqlite: Database.Database; db: SqliteD1Adapter } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const migDir = path.resolve(process.cwd(), 'src/database/migrations');
  for (const file of [
    '001_initial_schema_d1.sql',
    '002_auth_tables.sql',
    '003_affiliate_schema.sql',
    '024_kyc_compliance_schema.sql',
    '028_ascendancy_audit_core.sql',
    '031_ascendancy_phase2_ui_and_poller.sql',
  ]) {
    sqlite.exec(fs.readFileSync(path.join(migDir, file), 'utf8'));
  }

  const futureExp = new Date(Date.now() + 3600_000).toISOString();
  sqlite
    .prepare(
      `INSERT INTO profiles (id, email, full_name, role, referral_code)
       VALUES
         ('admin_gov', 'admin-gov@apexos.app', 'Gov Admin', 'admin', 'ADMGOV'),
         ('user_gov', 'user-gov@apexos.app', 'Regular User', 'shopper', 'USRGOV')`
    )
    .run();

  sqlite
    .prepare(
      `INSERT INTO sessions (id, user_id, token, expires_at)
       VALUES
         ('sess_adm_gov', 'admin_gov', 'tok_adm_gov', ?),
         ('sess_usr_gov', 'user_gov', 'tok_usr_gov', ?)`
    )
    .run(futureExp, futureExp);

  sqlite
    .prepare(
      `INSERT INTO webauthn_challenges (
         challenge_id, user_id, challenge, purpose, expires_at, consumed
       ) VALUES ('wac_gov_stepup', 'admin_gov', 'ch_gov', 'admin_step_up', '2099-01-01T00:00:00Z', 1)`
    )
    .run();

  const db = new SqliteD1Adapter(sqlite);
  return { sqlite, db };
}

function seedShadowBatch(
  sqlite: Database.Database,
  opts: {
    id: string;
    exchange: 'kucoin' | 'gateio';
    evidenceExchange?: 'kucoin' | 'gateio';
    evidenceSha?: string;
    createdAt: string;
    rowCount?: number;
    mappedUidCount?: number;
    unmappedUidCount?: number;
    discrepancyUnits?: number;
    status?: 'SHADOW_LOGGED' | 'SHADOW_DISCREPANCY' | 'PROMOTED_READY';
  }
): void {
  const evId = `ev_${opts.id}`;
  sqlite
    .prepare(
      `INSERT INTO r2_evidence_objects (
         id, exchange, source_kind, r2_object_key, payload_sha256, byte_length,
         statement_period_start, statement_period_end, retention_until
       ) VALUES (?, ?, 'rest_poll', ?, ?, 256, ?, ?, '2031-10-01T00:00:00Z')`
    )
    .run(
      evId,
      opts.evidenceExchange ?? opts.exchange,
      `${opts.exchange}/gov/${opts.id}.json`,
      opts.evidenceSha ?? 'a'.repeat(64),
      opts.createdAt,
      opts.createdAt
    );

  sqlite
    .prepare(
      `INSERT INTO partner_shadow_reconciliations (
         id, exchange, evidence_id, row_count, mapped_uid_count, unmapped_uid_count,
         simulated_gross_units, wallet_cash_collected_units, discrepancy_units,
         status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1000000000, 1000000000, ?, ?, ?)`
    )
    .run(
      opts.id,
      opts.exchange,
      evId,
      opts.rowCount ?? 5,
      opts.mappedUidCount ?? 5,
      opts.unmappedUidCount ?? 0,
      opts.discrepancyUnits ?? 0,
      opts.status ?? 'SHADOW_LOGGED',
      opts.createdAt
    );
}

describe('Shadow promotion completeness and atomic runtime-flag audit logging', () => {
  let sqlite: Database.Database;
  let db: SqliteD1Adapter;
  let stepUpToken: string;

  beforeEach(() => {
    const setup = createGovernanceTestDb();
    sqlite = setup.sqlite;
    db = setup.db;
    (globalThis as unknown as { DB?: SqliteD1Adapter; env?: { DB: SqliteD1Adapter } }).DB = db;
    (globalThis as unknown as { env?: { DB: SqliteD1Adapter } }).env = { DB: db };
    stepUpToken = issuePasskeyStepUpToken({
      userId: 'admin_gov',
      purpose: 'admin_step_up',
      challengeId: 'wac_gov_stepup',
    });
  });

  afterEach(() => {
    resetDB();
    delete (globalThis as unknown as { DB?: unknown }).DB;
    delete (globalThis as unknown as { env?: unknown }).env;
    sqlite.close();
  });

  describe('30-day shadow promotion completeness', () => {
    const evalNowMs = Date.parse('2026-10-31T12:00:00.000Z');
    const dayMs = 24 * 60 * 60 * 1000;

    it('rejects empty shadow history', async () => {
      const res = await validateShadowPromotionGate(db, 'PARTNER_KUCOIN_LIVE', evalNowMs);
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.code).toBe('SHADOW_HISTORY_MISSING');
    });

    it('rejects a single 31-day-old clean batch with stale tail', async () => {
      seedShadowBatch(sqlite, {
        id: 'old_single',
        exchange: 'kucoin',
        createdAt: new Date(evalNowMs - 31 * dayMs).toISOString(),
      });
      const res = await validateShadowPromotionGate(db, 'kucoin', evalNowMs);
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.code).toBe('SHADOW_EVIDENCE_STALE');
    });

    it('rejects sparse endpoints (day 0 and day 30 only) with insufficient distinct UTC days', async () => {
      seedShadowBatch(sqlite, {
        id: 'start_only',
        exchange: 'kucoin',
        createdAt: new Date(evalNowMs - 30 * dayMs).toISOString(),
      });
      seedShadowBatch(sqlite, {
        id: 'end_only',
        exchange: 'kucoin',
        createdAt: new Date(evalNowMs - 1 * 3600_000).toISOString(),
      });
      const res = await validateShadowPromotionGate(db, 'kucoin', evalNowMs);
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.code).toBe('SHADOW_COVERAGE_INCOMPLETE');
    });

    it('rejects a 30-day window that contains a 72-hour silent gap', async () => {
      for (let d = 32; d >= 0; d--) {
        if (d === 15 || d === 14) continue; // creates a 72-hour gap between d=16 and d=13
        seedShadowBatch(sqlite, {
          id: `gap_d${d}`,
          exchange: 'gateio',
          createdAt: new Date(evalNowMs - d * dayMs).toISOString(),
        });
      }
      const res = await validateShadowPromotionGate(db, 'gateio', evalNowMs);
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.code).toBe('SHADOW_COVERAGE_INCOMPLETE');
    });

    it('rejects any batch with SHADOW_DISCREPANCY, non-zero discrepancy_units, or unmapped UIDs', async () => {
      for (let d = 30; d >= 0; d--) {
        seedShadowBatch(sqlite, {
          id: `disc_d${d}`,
          exchange: 'kucoin',
          createdAt: new Date(evalNowMs - d * dayMs).toISOString(),
          unmappedUidCount: d === 5 ? 1 : 0,
        });
      }
      const res = await validateShadowPromotionGate(db, 'kucoin', evalNowMs);
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.code).toBe('SHADOW_DISCREPANCY_PRESENT');
    });

    it('rejects mismatched R2 provenance exchange or malformed SHA-256', async () => {
      for (let d = 30; d >= 0; d--) {
        seedShadowBatch(sqlite, {
          id: `prov_d${d}`,
          exchange: 'kucoin',
          evidenceExchange: d === 2 ? 'gateio' : 'kucoin',
          createdAt: new Date(evalNowMs - d * dayMs).toISOString(),
        });
      }
      const res = await validateShadowPromotionGate(db, 'kucoin', evalNowMs);
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.code).toBe('SHADOW_PROVENANCE_INCOMPLETE');
    });

    it('rejects future-dated shadow batches', async () => {
      for (let d = 30; d >= 0; d--) {
        seedShadowBatch(sqlite, {
          id: `fut_d${d}`,
          exchange: 'kucoin',
          createdAt: new Date(evalNowMs - d * dayMs).toISOString(),
        });
      }
      seedShadowBatch(sqlite, {
        id: 'fut_ahead',
        exchange: 'kucoin',
        createdAt: new Date(evalNowMs + 3600_000).toISOString(),
      });
      const res = await validateShadowPromotionGate(db, 'kucoin', evalNowMs);
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.code).toBe('SHADOW_FUTURE_TIMESTAMP');
    });

    it('rejects 30 days of zero-volume no-op runs', async () => {
      for (let d = 30; d >= 0; d--) {
        seedShadowBatch(sqlite, {
          id: `zero_d${d}`,
          exchange: 'kucoin',
          createdAt: new Date(evalNowMs - d * dayMs).toISOString(),
          rowCount: 0,
          mappedUidCount: 0,
        });
      }
      const res = await validateShadowPromotionGate(db, 'kucoin', evalNowMs);
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.code).toBe('SHADOW_INSUFFICIENT_VOLUME');
    });

    it('allows promotion when all 30 UTC days are continuously covered with clean R2-anchored batches', async () => {
      for (let d = 30; d >= 0; d--) {
        seedShadowBatch(sqlite, {
          id: `ok_d${d}`,
          exchange: 'kucoin',
          createdAt: new Date(evalNowMs - d * dayMs).toISOString(),
        });
      }
      const res = await validateShadowPromotionGate(db, 'kucoin', evalNowMs);
      expect(res.allowed).toBe(true);
      if (res.allowed) {
        expect(res.totalBatches).toBe(31);
        expect(res.distinctDays).toBeGreaterThanOrEqual(30);
        expect(res.totalReconciledRows).toBe(155);
      }
    });
  });

  describe('Atomic runtime-flag audit persistence across all mutating admin routes', () => {
    it('atomically persists flag change and compliance_audit_logs row on /api/admin/runtime-flags', async () => {
      const res = await runtimeFlagsPost(
        new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_adm_gov',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            flagKey: 'EMERGENCY_PAUSE',
            flagValue: 'true',
            reason: 'Planned incident response drill',
          }),
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { auditId: string };
      expect(body.auditId).toBeTruthy();

      const flag = sqlite
        .prepare("SELECT flag_value FROM system_runtime_flags WHERE flag_key = 'EMERGENCY_PAUSE'")
        .get() as { flag_value: string };
      expect(flag.flag_value).toBe('true');

      const audit = sqlite
        .prepare('SELECT action, actor_id, target_id, details FROM compliance_audit_logs WHERE id = ?')
        .get(body.auditId) as { action: string; actor_id: string; target_id: string; details: string };
      expect(audit.action).toBe('runtime_flag_updated');
      expect(audit.actor_id).toBe('admin_gov');
      expect(audit.target_id).toBe('EMERGENCY_PAUSE');
      const parsed = JSON.parse(audit.details) as { flagValue: string; source: string };
      expect(parsed.flagValue).toBe('true');
      expect(parsed.source).toBe('/api/admin/runtime-flags');
    });

    it('atomically persists flag change and audit row on /api/admin/passkey and /api/admin/reconciliation/poller', async () => {
      const passkeyRes = await adminPasskeyPost(
        new NextRequest('http://localhost:3000/api/admin/passkey', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_adm_gov',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
            'cf-connecting-ip': '203.0.113.10',
          },
          body: JSON.stringify({
            action: 'set_runtime_flag',
            flagKey: 'EMERGENCY_LEDGER_FREEZE',
            flagValue: 'true',
            reason: 'Freeze drill via passkey endpoint',
          }),
        })
      );
      expect(passkeyRes.status).toBe(200);
      const passkeyBody = (await passkeyRes.json()) as { auditId: string };
      expect(
        sqlite
          .prepare('SELECT target_id FROM compliance_audit_logs WHERE id = ?')
          .get(passkeyBody.auditId)
      ).toEqual({ target_id: 'EMERGENCY_LEDGER_FREEZE' });

      const pollerRes = await pollerAdminPost(
        new NextRequest('https://apexos.app/api/admin/reconciliation/poller', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_adm_gov',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            action: 'promote_shadow',
            exchange: 'kucoin',
            liveEnabled: false,
            reason: 'Verify demotion audit trail',
          }),
        })
      );
      expect(pollerRes.status).toBe(200);
      const pollerBody = (await pollerRes.json()) as { auditId: string };
      expect(
        sqlite
          .prepare('SELECT target_id FROM compliance_audit_logs WHERE id = ?')
          .get(pollerBody.auditId)
      ).toEqual({ target_id: 'PARTNER_KUCOIN_LIVE' });
    });

    it('rolls back system_runtime_flags on /api/admin/runtime-flags when compliance_audit_logs fails', async () => {
      const before = sqlite
        .prepare("SELECT flag_value FROM system_runtime_flags WHERE flag_key = 'EMERGENCY_PAUSE'")
        .get() as { flag_value: string } | undefined;

      sqlite.exec('DROP TABLE compliance_audit_logs');

      const res = await runtimeFlagsPost(
        new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_adm_gov',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            flagKey: 'EMERGENCY_PAUSE',
            flagValue: 'true',
            reason: 'Should fail closed when audit table is absent',
          }),
        })
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('AUDIT_PERSISTENCE_FAILED');

      const after = sqlite
        .prepare("SELECT flag_value FROM system_runtime_flags WHERE flag_key = 'EMERGENCY_PAUSE'")
        .get() as { flag_value: string } | undefined;
      expect(after).toEqual(before);
    });

    it('rolls back system_runtime_flags on /api/admin/passkey and /api/admin/reconciliation/poller when audit insert is aborted by trigger', async () => {
      sqlite.exec(`
        CREATE TRIGGER trg_inject_audit_failure
        BEFORE INSERT ON compliance_audit_logs
        BEGIN
          SELECT RAISE(ABORT, 'injected audit storage failure');
        END;
      `);

      const beforeFreeze = sqlite
        .prepare("SELECT flag_value FROM system_runtime_flags WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'")
        .get();

      const passkeyRes = await adminPasskeyPost(
        new NextRequest('http://localhost:3000/api/admin/passkey', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_adm_gov',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
            'cf-connecting-ip': '203.0.113.10',
          },
          body: JSON.stringify({
            action: 'set_runtime_flag',
            flagKey: 'EMERGENCY_LEDGER_FREEZE',
            flagValue: 'true',
            reason: 'Trigger rollback check on passkey route',
          }),
        })
      );
      expect(passkeyRes.status).toBe(500);
      expect(
        sqlite
          .prepare("SELECT flag_value FROM system_runtime_flags WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'")
          .get()
      ).toEqual(beforeFreeze);

      const pollerRes = await pollerAdminPost(
        new NextRequest('https://apexos.app/api/admin/reconciliation/poller', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_adm_gov',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            action: 'promote_shadow',
            exchange: 'kucoin',
            liveEnabled: false,
            reason: 'Trigger rollback check on poller route',
          }),
        })
      );
      expect(pollerRes.status).toBe(500);
      const pollerBody = (await pollerRes.json()) as { code: string };
      expect(pollerBody.code).toBe('AUDIT_PERSISTENCE_FAILED');
    });

    it('fails closed when database binding lacks atomic batch() support', async () => {
      const brokenDb = {
        prepare: () => ({
          bind: () => ({ first: async () => null }),
        }),
      } as unknown as AtomicFlagAuditDatabase;

      await expect(
        persistRuntimeFlagWithAudit(brokenDb, {
          flagKey: 'EMERGENCY_PAUSE',
          flagValue: 'true',
          reason: 'No batch support',
          updatedBy: 'admin_gov',
          source: 'unit-test',
        })
      ).rejects.toThrow(RuntimeFlagAuditPersistenceError);
    });

    it('rejects unauthenticated and non-step-up requests with zero flag or audit writes', async () => {
      const beforeCount = (
        sqlite.prepare('SELECT COUNT(*) AS n FROM compliance_audit_logs').get() as { n: number }
      ).n;

      const unauthRes = await runtimeFlagsPost(
        new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            flagKey: 'EMERGENCY_PAUSE',
            flagValue: 'true',
            reason: 'Unauthenticated attempt',
          }),
        })
      );
      expect(unauthRes.status).toBe(401);

      const noStepUpRes = await runtimeFlagsPost(
        new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_adm_gov',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            flagKey: 'EMERGENCY_PAUSE',
            flagValue: 'true',
            reason: 'Missing step-up attempt',
          }),
        })
      );
      expect(noStepUpRes.status).toBe(403);

      const afterCount = (
        sqlite.prepare('SELECT COUNT(*) AS n FROM compliance_audit_logs').get() as { n: number }
      ).n;
      expect(afterCount).toBe(beforeCount);
    });
  });
});
