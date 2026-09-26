/**
 * Milestone 1 Unit Tests: Migration 021 Schema & SQLite D1 Verification
 * Location: src/__tests__/fraud/migration-021-schema.test.ts
 *
 * Verifies:
 * 1. Sequential execution of migrations 001, 003, and 021 in better-sqlite3 in-memory database
 * 2. deal_clicks schema extension (is_suspicious, flag_reasons, anomaly_score)
 * 3. blocked_ips table creation, columns, and UNIQUE(ip_address) constraint
 * 4. fraud_reviews immutable audit table and SQLite triggers preventing UPDATE / DELETE
 * 5. Covering performance indexes and EXPLAIN QUERY PLAN verification
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

describe('Migration 021: Fraud Detection Schema & Triggers', () => {
  let db: Database.Database;
  const migration021Path = path.resolve(
    process.cwd(),
    'src/database/migrations/021_fraud_detection_schema.sql'
  );
  const migration001Path = path.resolve(
    process.cwd(),
    'src/database/migrations/001_initial_schema_d1.sql'
  );
  const migration003Path = path.resolve(
    process.cwd(),
    'src/database/migrations/003_affiliate_schema.sql'
  );

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Apply baseline migrations
    const sql001 = fs.readFileSync(migration001Path, 'utf8');
    const sql003 = fs.readFileSync(migration003Path, 'utf8');
    const sql021 = fs.readFileSync(migration021Path, 'utf8');

    db.exec(sql001);
    db.exec(sql003);
    db.exec(sql021);
  });

  afterEach(() => {
    db.close();
  });

  describe('1. Migration File Integrity & Sequential Application', () => {
    it('migration file exists and contains expected D1 SQL statements', () => {
      expect(fs.existsSync(migration021Path)).toBe(true);
      const sql = fs.readFileSync(migration021Path, 'utf8');
      expect(sql).toContain('ALTER TABLE deal_clicks ADD COLUMN is_suspicious');
      expect(sql).toContain('ALTER TABLE deal_clicks ADD COLUMN flag_reasons');
      expect(sql).toContain('ALTER TABLE deal_clicks ADD COLUMN anomaly_score');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS blocked_ips');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS fraud_reviews');
      expect(sql).toContain('CREATE TRIGGER IF NOT EXISTS trg_fraud_reviews_prevent_update');
      expect(sql).toContain('CREATE TRIGGER IF NOT EXISTS trg_fraud_reviews_prevent_delete');
    });

    it('provisions blocked_ips and fraud_reviews tables in sqlite_master', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r: any) => r.name);

      expect(tables).toContain('deal_clicks');
      expect(tables).toContain('blocked_ips');
      expect(tables).toContain('fraud_reviews');
    });
  });

  describe('2. deal_clicks Table Extension', () => {
    it('adds is_suspicious, flag_reasons, and anomaly_score columns with proper defaults', () => {
      const columns = db
        .prepare("PRAGMA table_info('deal_clicks')")
        .all() as Array<{ name: string; type: string; dflt_value: string | null }>;

      const colMap = new Map(columns.map((c) => [c.name, c]));

      expect(colMap.has('is_suspicious')).toBe(true);
      expect(colMap.get('is_suspicious')?.dflt_value).toBe('0');

      expect(colMap.has('flag_reasons')).toBe(true);

      expect(colMap.has('anomaly_score')).toBe(true);
      expect(colMap.get('anomaly_score')?.dflt_value).toBe('0.0');
    });

    it('defaults is_suspicious to 0 and anomaly_score to 0.0 on row insert', () => {
      // Seed a required deal first for foreign key
      db.prepare(`
        INSERT INTO deals (id, name, url, default_commission_rate)
        VALUES ('deal-test-1', 'Test Deal', 'https://example.com', 0.1)
      `).run();

      db.prepare(`
        INSERT INTO deal_clicks (id, deal_id, session_id, ip_address)
        VALUES ('click-default-1', 'deal-test-1', 'sess-1', '198.51.100.1')
      `).run();

      const row = db
        .prepare('SELECT is_suspicious, flag_reasons, anomaly_score FROM deal_clicks WHERE id = ?')
        .get('click-default-1') as any;

      expect(row).toBeDefined();
      expect(row.is_suspicious).toBe(0);
      expect(row.flag_reasons).toBeNull();
      expect(row.anomaly_score).toBe(0.0);
    });

    it('persists suspicious flag and serialized JSON reason codes', () => {
      db.prepare(`
        INSERT INTO deals (id, name, url, default_commission_rate)
        VALUES ('deal-test-2', 'Test Deal 2', 'https://example.com', 0.1)
      `).run();

      db.prepare(`
        INSERT INTO deal_clicks (
          id, deal_id, session_id, ip_address, is_suspicious, flag_reasons, anomaly_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'click-susp-1',
        'deal-test-2',
        'sess-2',
        '198.51.100.2',
        1,
        JSON.stringify(['BURST_CLICK', 'HIGH_CLICK_CONVERSION_RATIO']),
        0.85
      );

      const row = db
        .prepare('SELECT is_suspicious, flag_reasons, anomaly_score FROM deal_clicks WHERE id = ?')
        .get('click-susp-1') as any;

      expect(row.is_suspicious).toBe(1);
      expect(JSON.parse(row.flag_reasons)).toEqual(['BURST_CLICK', 'HIGH_CLICK_CONVERSION_RATIO']);
      expect(row.anomaly_score).toBeCloseTo(0.85);
    });
  });

  describe('3. blocked_ips Table & Constraints', () => {
    it('verifies column specifications on blocked_ips', () => {
      const columns = db
        .prepare("PRAGMA table_info('blocked_ips')")
        .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;

      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('ip_address');
      expect(colNames).toContain('reason');
      expect(colNames).toContain('blocked_by');
      expect(colNames).toContain('created_at');
      expect(colNames).toContain('expires_at');
      expect(colNames).toContain('is_active');

      const pkCol = columns.find((c) => c.name === 'id');
      expect(pkCol?.pk).toBe(1);
    });

    it('enforces UNIQUE constraint on ip_address', () => {
      db.prepare(`
        INSERT INTO blocked_ips (id, ip_address, reason, blocked_by)
        VALUES ('b1', '198.51.100.50', 'Rate limit exceeded', 'system')
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO blocked_ips (id, ip_address, reason, blocked_by)
          VALUES ('b2', '198.51.100.50', 'Duplicate attempt', 'admin')
        `).run();
      }).toThrow(/UNIQUE constraint failed: blocked_ips\.ip_address/i);
    });

    it('sets default values for is_active and blocked_by', () => {
      db.prepare(`
        INSERT INTO blocked_ips (id, ip_address, reason)
        VALUES ('b-def', '198.51.100.51', 'Suspicious activity')
      `).run();

      const row = db
        .prepare('SELECT is_active, blocked_by, created_at FROM blocked_ips WHERE id = ?')
        .get('b-def') as any;

      expect(row.is_active).toBe(1);
      expect(row.blocked_by).toBe('system');
      expect(row.created_at).toBeDefined();
    });
  });

  describe('4. fraud_reviews Table & Immutability Triggers', () => {
    it('verifies fraud_reviews audit log columns', () => {
      const columns = db
        .prepare("PRAGMA table_info('fraud_reviews')")
        .all() as Array<{ name: string }>;

      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('click_id');
      expect(colNames).toContain('ip_address');
      expect(colNames).toContain('reviewer_id');
      expect(colNames).toContain('reviewed_by');
      expect(colNames).toContain('action');
      expect(colNames).toContain('reason');
      expect(colNames).toContain('reviewed_at');
      expect(colNames).toContain('created_at');
      expect(colNames).toContain('details');
    });

    it('allows inserting immutable review decisions', () => {
      db.prepare(`
        INSERT INTO fraud_reviews (id, click_id, ip_address, reviewer_id, reviewed_by, action, reason)
        VALUES ('rev-1', 'click-1', '198.51.100.2', 'usr-admin-1', 'usr-admin-1', 'approve', 'Verified human')
      `).run();

      const row = db
        .prepare('SELECT action, reason, reviewer_id FROM fraud_reviews WHERE id = ?')
        .get('rev-1') as any;

      expect(row.action).toBe('approve');
      expect(row.reason).toBe('Verified human');
      expect(row.reviewer_id).toBe('usr-admin-1');
    });

    it('TRIGGER ENFORCEMENT: aborts UPDATE operations on fraud_reviews', () => {
      db.prepare(`
        INSERT INTO fraud_reviews (id, reviewer_id, action, reason)
        VALUES ('rev-immutable-update', 'usr-admin-1', 'approve', 'Initial verdict')
      `).run();

      expect(() => {
        db.prepare(`
          UPDATE fraud_reviews SET reason = 'tampered' WHERE id = 'rev-immutable-update'
        `).run();
      }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);
    });

    it('TRIGGER ENFORCEMENT: aborts DELETE operations on fraud_reviews', () => {
      db.prepare(`
        INSERT INTO fraud_reviews (id, reviewer_id, action, reason)
        VALUES ('rev-immutable-delete', 'usr-admin-1', 'reject', 'Bot traffic')
      `).run();

      expect(() => {
        db.prepare(`
          DELETE FROM fraud_reviews WHERE id = 'rev-immutable-delete'
        `).run();
      }).toThrow(/fraud_reviews audit log is immutable: DELETE operations are prohibited/i);
    });
  });

  describe('5. Indexes & Query Performance Plans', () => {
    it('creates all required performance indexes', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((r: any) => r.name);

      expect(indexes).toContain('idx_deal_clicks_ip_created');
      expect(indexes).toContain('idx_deal_clicks_session_created');
      expect(indexes).toContain('idx_deal_clicks_is_suspicious');
      expect(indexes).toContain('idx_deal_clicks_suspicious_created');
      expect(indexes).toContain('idx_blocked_ips_ip');
      expect(indexes).toContain('idx_blocked_ips_active');
      expect(indexes).toContain('idx_fraud_reviews_click');
      expect(indexes).toContain('idx_fraud_reviews_ip');
      expect(indexes).toContain('idx_fraud_reviews_reviewer');
      expect(indexes).toContain('idx_fraud_reviews_action');
      expect(indexes).toContain('idx_fraud_reviews_reviewed_at');
    });

    it('uses idx_deal_clicks_ip_created for velocity lookups', () => {
      const plan = db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT * FROM deal_clicks WHERE ip_address = ? AND created_at > ?'
        )
        .all('198.51.100.1', '2026-01-01') as any[];

      const planDetail = plan.map((p) => p.detail).join('; ');
      expect(planDetail).toMatch(/idx_deal_clicks_ip_created/i);
    });

    it('uses index for real-time IP blacklist lookups', () => {
      const plan = db
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM blocked_ips WHERE ip_address = ?')
        .all('198.51.100.1') as any[];

      const planDetail = plan.map((p) => p.detail).join('; ');
      expect(planDetail).toMatch(/(idx_blocked_ips_ip|sqlite_autoindex_blocked_ips)/i);
    });
  });
});
