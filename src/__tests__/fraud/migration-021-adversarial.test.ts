/**
 * Adversarial Stress Tests for Cloudflare D1 Migration 021 (Fraud Detection Schema & Triggers)
 * Location: src/__tests__/fraud/migration-021-adversarial.test.ts
 *
 * EMPIRICAL CHALLENGE SUITE:
 * 1. DDL Migration Idempotency, Failure Modes & Re-Run Resilience
 * 2. Legacy Data Backfilling & Column Default Preservation on deal_clicks
 * 3. Audit Immutability Trigger Enforcement & Anti-Tamper Stress on fraud_reviews
 * 4. blocked_ips Schema Constraints, Uniqueness & Lifecycle
 * 5. Exhaustive EXPLAIN QUERY PLAN Verification across all 11 Performance Indexes
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

describe('Migration 021 Adversarial Stress Test Suite', () => {
  const rootDir = process.cwd();
  const migration001Path = path.join(rootDir, 'src/database/migrations/001_initial_schema_d1.sql');
  const migration003Path = path.join(rootDir, 'src/database/migrations/003_affiliate_schema.sql');
  const migration021Path = path.join(rootDir, 'src/database/migrations/021_fraud_detection_schema.sql');

  let db: Database.Database;

  const initBaseDb = (): Database.Database => {
    const memoryDb = new Database(':memory:');
    memoryDb.pragma('foreign_keys = ON');
    const sql001 = fs.readFileSync(migration001Path, 'utf8');
    const sql003 = fs.readFileSync(migration003Path, 'utf8');
    memoryDb.exec(sql001);
    memoryDb.exec(sql003);
    return memoryDb;
  };

  const initFullDb = (): Database.Database => {
    const memoryDb = initBaseDb();
    const sql021 = fs.readFileSync(migration021Path, 'utf8');
    memoryDb.exec(sql021);
    return memoryDb;
  };

  beforeEach(() => {
    db = initFullDb();
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  // ==========================================================================
  // 1. DDL MIGRATION IDEMPOTENCY & FAILURE CASES
  // ==========================================================================
  describe('1. DDL Migration Idempotency & Failure Cases', () => {
    it('fails when migration 021 is applied without prerequisite deal_clicks table', () => {
      const bareDb = new Database(':memory:');
      bareDb.pragma('foreign_keys = ON');
      const sql021 = fs.readFileSync(migration021Path, 'utf8');

      // Attempting to alter non-existent deal_clicks must fail
      expect(() => {
        bareDb.exec(sql021);
      }).toThrow(/no such table: deal_clicks/i);

      bareDb.close();
    });

    it('empirically verifies ALTER TABLE ADD COLUMN duplicate failure when re-run', () => {
      // SQLite does not support ALTER TABLE ADD COLUMN IF NOT EXISTS.
      // Re-running raw migration 021 against an already-migrated database MUST throw.
      const sql021 = fs.readFileSync(migration021Path, 'utf8');
      expect(() => {
        db.exec(sql021);
      }).toThrow(/duplicate column name: is_suspicious/i);
    });

    it('verifies CREATE TABLE IF NOT EXISTS idempotency when executed repeatedly', () => {
      const isolatedTableSql = `
        CREATE TABLE IF NOT EXISTS blocked_ips (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          ip_address TEXT UNIQUE NOT NULL,
          reason TEXT NOT NULL,
          blocked_by TEXT DEFAULT 'system',
          created_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT,
          is_active INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS fraud_reviews (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          click_id TEXT,
          ip_address TEXT,
          reviewer_id TEXT,
          reviewed_by TEXT,
          action TEXT NOT NULL,
          reason TEXT NOT NULL,
          reviewed_at TEXT DEFAULT (datetime('now')),
          created_at TEXT DEFAULT (datetime('now')),
          details TEXT
        );
      `;

      // Executing 5 consecutive times must be completely idempotent
      for (let i = 0; i < 5; i++) {
        expect(() => db.exec(isolatedTableSql)).not.toThrow();
      }
    });

    it('verifies CREATE INDEX IF NOT EXISTS idempotency when executed repeatedly', () => {
      const indexSql = `
        CREATE INDEX IF NOT EXISTS idx_deal_clicks_ip_created ON deal_clicks(ip_address, created_at);
        CREATE INDEX IF NOT EXISTS idx_deal_clicks_session_created ON deal_clicks(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_deal_clicks_is_suspicious ON deal_clicks(is_suspicious);
        CREATE INDEX IF NOT EXISTS idx_deal_clicks_suspicious_created ON deal_clicks(is_suspicious, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_blocked_ips_ip ON blocked_ips(ip_address);
        CREATE INDEX IF NOT EXISTS idx_blocked_ips_active ON blocked_ips(is_active, ip_address);
        CREATE INDEX IF NOT EXISTS idx_fraud_reviews_click ON fraud_reviews(click_id);
        CREATE INDEX IF NOT EXISTS idx_fraud_reviews_ip ON fraud_reviews(ip_address);
        CREATE INDEX IF NOT EXISTS idx_fraud_reviews_reviewer ON fraud_reviews(reviewer_id);
        CREATE INDEX IF NOT EXISTS idx_fraud_reviews_action ON fraud_reviews(action);
        CREATE INDEX IF NOT EXISTS idx_fraud_reviews_reviewed_at ON fraud_reviews(reviewed_at DESC);
      `;

      for (let i = 0; i < 5; i++) {
        expect(() => db.exec(indexSql)).not.toThrow();
      }
    });

    it('verifies CREATE TRIGGER IF NOT EXISTS idempotency when executed repeatedly', () => {
      const triggerSql = `
        CREATE TRIGGER IF NOT EXISTS trg_fraud_reviews_prevent_update BEFORE UPDATE ON fraud_reviews
        FOR EACH ROW
        BEGIN
          SELECT RAISE(ABORT, 'fraud_reviews audit log is immutable: UPDATE operations are prohibited');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_fraud_reviews_prevent_delete BEFORE DELETE ON fraud_reviews
        FOR EACH ROW
        BEGIN
          SELECT RAISE(ABORT, 'fraud_reviews audit log is immutable: DELETE operations are prohibited');
        END;
      `;

      for (let i = 0; i < 5; i++) {
        expect(() => db.exec(triggerSql)).not.toThrow();
      }
    });
  });

  // ==========================================================================
  // 2. LEGACY DATA BACKFILLING & COLUMN DEFAULTS ON deal_clicks
  // ==========================================================================
  describe('2. Legacy Data Backfilling & Default Values on deal_clicks', () => {
    it('preserves legacy rows existing before migration and applies correct defaults', () => {
      // Fresh database without migration 021
      const legacyDb = initBaseDb();

      // Seed parent deal
      legacyDb.prepare(`
        INSERT INTO deals (id, name, url, default_commission_rate)
        VALUES ('deal-legacy', 'Legacy Deal', 'https://example.com/legacy', 0.05)
      `).run();

      // Insert pre-migration legacy clicks
      const insertLegacyClick = legacyDb.prepare(`
        INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, created_at)
        VALUES (?, 'deal-legacy', ?, ?, ?)
      `);

      for (let i = 1; i <= 20; i++) {
        insertLegacyClick.run(
          `legacy-click-${i}`,
          `sess-legacy-${i}`,
          `192.168.1.${i}`,
          `2026-01-01 10:${i.toString().padStart(2, '0')}:00`
        );
      }

      // Now apply migration 021 to backfill schema extensions
      const sql021 = fs.readFileSync(migration021Path, 'utf8');
      expect(() => legacyDb.exec(sql021)).not.toThrow();

      // Verify every single pre-existing row has expected defaults
      const legacyRows = legacyDb.prepare(`
        SELECT id, is_suspicious, flag_reasons, anomaly_score
        FROM deal_clicks
        WHERE deal_id = 'deal-legacy'
      `).all() as Array<{
        id: string;
        is_suspicious: number;
        flag_reasons: string | null;
        anomaly_score: number;
      }>;

      expect(legacyRows).toHaveLength(20);
      for (const row of legacyRows) {
        expect(row.is_suspicious).toBe(0);
        expect(row.flag_reasons).toBeNull();
        expect(row.anomaly_score).toBe(0.0);
      }

      legacyDb.close();
    });

    it('correctly sets defaults for newly inserted rows without fraud columns', () => {
      db.prepare(`
        INSERT INTO deals (id, name, url, default_commission_rate)
        VALUES ('deal-new', 'New Deal', 'https://example.com/new', 0.1)
      `).run();

      db.prepare(`
        INSERT INTO deal_clicks (id, deal_id, session_id, ip_address)
        VALUES ('click-new-1', 'deal-new', 'sess-new', '10.0.0.1')
      `).run();

      const row = db.prepare(`
        SELECT is_suspicious, flag_reasons, anomaly_score
        FROM deal_clicks
        WHERE id = 'click-new-1'
      `).get() as any;

      expect(row.is_suspicious).toBe(0);
      expect(row.flag_reasons).toBeNull();
      expect(row.anomaly_score).toBe(0.0);
    });

    it('accurately stores and retrieves explicit fraud flags and score boundaries', () => {
      db.prepare(`
        INSERT INTO deals (id, name, url, default_commission_rate)
        VALUES ('deal-boundary', 'Boundary Deal', 'https://example.com/boundary', 0.1)
      `).run();

      const insertClick = db.prepare(`
        INSERT INTO deal_clicks (
          id, deal_id, session_id, ip_address, is_suspicious, flag_reasons, anomaly_score
        ) VALUES (?, 'deal-boundary', ?, ?, ?, ?, ?)
      `);

      // Test boundary score 0.0 (clean)
      insertClick.run('click-zero', 'sess-zero', '10.0.0.2', 0, null, 0.0);
      // Test boundary score 1.0 (critical anomaly)
      insertClick.run('click-one', 'sess-one', '10.0.0.3', 1, JSON.stringify(['BLOCKED_IP']), 1.0);
      // Test continuous decimal score 0.875
      insertClick.run(
        'click-burst',
        'sess-burst',
        '10.0.0.4',
        1,
        JSON.stringify(['BURST_CLICK', 'HIGH_CLICK_CONVERSION_RATIO']),
        0.875
      );

      const rZero = db.prepare('SELECT * FROM deal_clicks WHERE id = ?').get('click-zero') as any;
      expect(rZero.is_suspicious).toBe(0);
      expect(rZero.anomaly_score).toBe(0.0);
      expect(rZero.flag_reasons).toBeNull();

      const rOne = db.prepare('SELECT * FROM deal_clicks WHERE id = ?').get('click-one') as any;
      expect(rOne.is_suspicious).toBe(1);
      expect(rOne.anomaly_score).toBe(1.0);
      expect(JSON.parse(rOne.flag_reasons)).toEqual(['BLOCKED_IP']);

      const rBurst = db.prepare('SELECT * FROM deal_clicks WHERE id = ?').get('click-burst') as any;
      expect(rBurst.is_suspicious).toBe(1);
      expect(rBurst.anomaly_score).toBeCloseTo(0.875);
      expect(JSON.parse(rBurst.flag_reasons)).toEqual(['BURST_CLICK', 'HIGH_CLICK_CONVERSION_RATIO']);
    });
  });

  // ==========================================================================
  // 3. TRIGGER ENFORCEMENT & IMMUTABILITY ON fraud_reviews
  // ==========================================================================
  describe('3. Trigger Enforcement & Immutability on fraud_reviews', () => {
    beforeEach(() => {
      // Seed sample audit reviews
      const insertReview = db.prepare(`
        INSERT INTO fraud_reviews (id, click_id, ip_address, reviewer_id, reviewed_by, action, reason, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertReview.run(
        'rev-audit-1',
        'click-target-1',
        '203.0.113.10',
        'usr-secops-1',
        'usr-secops-1',
        'reject',
        'Bot farm detected',
        JSON.stringify({ clusterSize: 42 })
      );

      insertReview.run(
        'rev-audit-2',
        'click-target-2',
        '203.0.113.11',
        'usr-secops-2',
        'usr-secops-2',
        'approve',
        'Legitimate influencer traffic',
        JSON.stringify({ verified: true })
      );
    });

    it('TRIGGER ENFORCEMENT: aborts single-row UPDATE on reason column', () => {
      expect(() => {
        db.prepare("UPDATE fraud_reviews SET reason = 'Tampered' WHERE id = 'rev-audit-1'").run();
      }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);

      // Verify data remains unmodified
      const row = db.prepare("SELECT reason FROM fraud_reviews WHERE id = 'rev-audit-1'").get() as any;
      expect(row.reason).toBe('Bot farm detected');
    });

    it('TRIGGER ENFORCEMENT: aborts single-row UPDATE on action column', () => {
      expect(() => {
        db.prepare("UPDATE fraud_reviews SET action = 'approve' WHERE id = 'rev-audit-1'").run();
      }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);

      const row = db.prepare("SELECT action FROM fraud_reviews WHERE id = 'rev-audit-1'").get() as any;
      expect(row.action).toBe('reject');
    });

    it('TRIGGER ENFORCEMENT: aborts single-row UPDATE on details or timestamp columns', () => {
      expect(() => {
        db.prepare("UPDATE fraud_reviews SET details = '{}' WHERE id = 'rev-audit-1'").run();
      }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);

      expect(() => {
        db.prepare("UPDATE fraud_reviews SET reviewed_at = '1970-01-01 00:00:00' WHERE id = 'rev-audit-1'").run();
      }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);
    });

    it('TRIGGER ENFORCEMENT: aborts multi-row unqualified UPDATE', () => {
      expect(() => {
        db.prepare("UPDATE fraud_reviews SET action = 'tampered'").run();
      }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);

      const count = db.prepare("SELECT COUNT(*) as c FROM fraud_reviews WHERE action = 'tampered'").get() as any;
      expect(count.c).toBe(0);
    });

    it('TRIGGER ENFORCEMENT: aborts single-row DELETE', () => {
      expect(() => {
        db.prepare("DELETE FROM fraud_reviews WHERE id = 'rev-audit-1'").run();
      }).toThrow(/fraud_reviews audit log is immutable: DELETE operations are prohibited/i);

      const exists = db.prepare("SELECT id FROM fraud_reviews WHERE id = 'rev-audit-1'").get();
      expect(exists).toBeDefined();
    });

    it('TRIGGER ENFORCEMENT: aborts multi-row unqualified DELETE', () => {
      expect(() => {
        db.prepare("DELETE FROM fraud_reviews").run();
      }).toThrow(/fraud_reviews audit log is immutable: DELETE operations are prohibited/i);

      const count = db.prepare("SELECT COUNT(*) as c FROM fraud_reviews").get() as any;
      expect(count.c).toBe(2);
    });

    it('TRIGGER ENFORCEMENT: aborts UPDATE via subquery', () => {
      expect(() => {
        db.prepare(`
          UPDATE fraud_reviews
          SET reason = (SELECT 'Injected Subquery')
          WHERE id IN (SELECT id FROM fraud_reviews LIMIT 1)
        `).run();
      }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);
    });

    it('preserves database transaction rollback integrity upon trigger abort', () => {
      const runTransaction = db.transaction(() => {
        // Step 1: Valid insert of a new review
        db.prepare(`
          INSERT INTO fraud_reviews (id, reviewer_id, action, reason)
          VALUES ('rev-in-tx', 'usr-tx', 'block_ip', 'Tx test')
        `).run();

        // Step 2: Illegal update that triggers abort
        db.prepare("UPDATE fraud_reviews SET reason = 'Illegal update' WHERE id = 'rev-audit-1'").run();
      });

      expect(() => {
        runTransaction();
      }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);

      // Verify that rev-in-tx was rolled back and never committed
      const txRow = db.prepare("SELECT id FROM fraud_reviews WHERE id = 'rev-in-tx'").get();
      expect(txRow).toBeUndefined();

      // Original record is intact
      const orig = db.prepare("SELECT reason FROM fraud_reviews WHERE id = 'rev-audit-1'").get() as any;
      expect(orig.reason).toBe('Bot farm detected');
    });

    it('does not trigger error when WHERE clause matches zero rows', () => {
      // In SQLite FOR EACH ROW, if 0 rows qualify, the body is never evaluated
      expect(() => {
        const result = db.prepare("UPDATE fraud_reviews SET reason = 'Ghost' WHERE id = 'non-existent-rev'").run();
        expect(result.changes).toBe(0);
      }).not.toThrow();

      expect(() => {
        const result = db.prepare("DELETE FROM fraud_reviews WHERE id = 'non-existent-rev'").run();
        expect(result.changes).toBe(0);
      }).not.toThrow();
    });
  });

  // ==========================================================================
  // 4. blocked_ips SCHEMA CONSTRAINTS & ATTACK SCENARIOS
  // ==========================================================================
  describe('4. blocked_ips Schema Constraints & Attack Scenarios', () => {
    it('enforces UNIQUE constraint on ip_address for IPv4 and IPv6', () => {
      db.prepare(`
        INSERT INTO blocked_ips (id, ip_address, reason, blocked_by)
        VALUES ('b-ipv4', '198.51.100.99', 'IPv4 test', 'admin')
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO blocked_ips (id, ip_address, reason, blocked_by)
          VALUES ('b-ipv4-dup', '198.51.100.99', 'Duplicate attempt', 'system')
        `).run();
      }).toThrow(/UNIQUE constraint failed: blocked_ips\.ip_address/i);

      // Test IPv6 address
      const ipv6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
      db.prepare(`
        INSERT INTO blocked_ips (id, ip_address, reason, blocked_by)
        VALUES ('b-ipv6', ?, 'IPv6 botnet', 'system')
      `).run(ipv6);

      expect(() => {
        db.prepare(`
          INSERT INTO blocked_ips (id, ip_address, reason, blocked_by)
          VALUES ('b-ipv6-dup', ?, 'Duplicate IPv6', 'admin')
        `).run(ipv6);
      }).toThrow(/UNIQUE constraint failed: blocked_ips\.ip_address/i);
    });

    it('enforces NOT NULL constraint on ip_address and reason', () => {
      expect(() => {
        db.prepare("INSERT INTO blocked_ips (id, ip_address, reason) VALUES ('b-null-ip', NULL, 'Reason')").run();
      }).toThrow(/NOT NULL constraint failed: blocked_ips\.ip_address/i);

      expect(() => {
        db.prepare("INSERT INTO blocked_ips (id, ip_address, reason) VALUES ('b-null-reason', '1.2.3.4', NULL)").run();
      }).toThrow(/NOT NULL constraint failed: blocked_ips\.reason/i);
    });

    it('generates random hex PRIMARY KEY default when id is omitted', () => {
      db.prepare(`
        INSERT INTO blocked_ips (ip_address, reason)
        VALUES ('198.51.100.200', 'Automated block')
      `).run();

      const row = db.prepare("SELECT id, ip_address FROM blocked_ips WHERE ip_address = '198.51.100.200'").get() as any;
      expect(row.id).toBeDefined();
      expect(typeof row.id).toBe('string');
      expect(row.id.length).toBe(32); // 16 bytes hex = 32 chars
      expect(/^[0-9a-f]{32}$/.test(row.id)).toBe(true);
    });

    it('supports soft unblocking by toggling is_active = 0 (unblocked)', () => {
      // blocked_ips is NOT trigger locked, allowing administrative unblocking
      db.prepare(`
        INSERT INTO blocked_ips (id, ip_address, reason, is_active)
        VALUES ('b-toggle', '198.51.100.201', 'Temporary block', 1)
      `).run();

      db.prepare("UPDATE blocked_ips SET is_active = 0 WHERE id = 'b-toggle'").run();

      const row = db.prepare("SELECT is_active FROM blocked_ips WHERE id = 'b-toggle'").get() as any;
      expect(row.is_active).toBe(0);
    });
  });

  // ==========================================================================
  // 5. EXHAUSTIVE EXPLAIN QUERY PLAN & INDEX VERIFICATION
  // ==========================================================================
  describe('5. Exhaustive EXPLAIN QUERY PLAN Index Verification (All 11 Indexes)', () => {
    beforeEach(() => {
      // Seed sufficient volume across all tables so SQLite cost-based optimizer prefers indexes
      db.prepare(`
        INSERT INTO deals (id, name, url, default_commission_rate)
        VALUES ('deal-perf', 'Performance Deal', 'https://example.com/perf', 0.15)
      `).run();

      const insertClick = db.prepare(`
        INSERT INTO deal_clicks (
          id, deal_id, session_id, ip_address, is_suspicious, flag_reasons, anomaly_score, created_at
        ) VALUES (?, 'deal-perf', ?, ?, ?, ?, ?, ?)
      `);

      const insertBlockedIp = db.prepare(`
        INSERT INTO blocked_ips (id, ip_address, reason, blocked_by, is_active, created_at)
        VALUES (?, ?, 'High frequency', 'system', ?, ?)
      `);

      const insertReview = db.prepare(`
        INSERT INTO fraud_reviews (id, click_id, ip_address, reviewer_id, reviewed_by, action, reason, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'Audit decision', ?)
      `);

      for (let i = 1; i <= 120; i++) {
        const ip = `192.168.10.${i}`;
        const sess = `session-${i}`;
        const isSusp = i % 3 === 0 ? 1 : 0;
        const ts = `2026-09-25 10:${(i % 60).toString().padStart(2, '0')}:00`;

        insertClick.run(`c-${i}`, sess, ip, isSusp, isSusp ? '["BURST_CLICK"]' : null, isSusp * 0.8, ts);
        insertBlockedIp.run(`b-${i}`, ip, i % 2, ts);
        insertReview.run(`r-${i}`, `c-${i}`, ip, `usr-${i % 5}`, `usr-${i % 5}`, i % 2 === 0 ? 'approve' : 'reject', ts);
      }
    });

    const indexScenarios: Array<{
      name: string;
      query: string;
      expectedIndex: string;
    }> = [
      {
        name: 'idx_deal_clicks_ip_created',
        query: "SELECT id FROM deal_clicks WHERE ip_address = '192.168.10.5' AND created_at > '2026-09-25 00:00:00'",
        expectedIndex: 'idx_deal_clicks_ip_created',
      },
      {
        name: 'idx_deal_clicks_session_created',
        query: "SELECT id FROM deal_clicks WHERE session_id = 'session-10' AND created_at > '2026-09-25 00:00:00'",
        expectedIndex: 'idx_deal_clicks_session_created',
      },
      {
        name: 'idx_deal_clicks_is_suspicious',
        query: "SELECT id FROM deal_clicks WHERE is_suspicious = 1",
        expectedIndex: 'idx_deal_clicks_is_suspicious',
      },
      {
        name: 'idx_deal_clicks_suspicious_created',
        query: "SELECT id FROM deal_clicks WHERE is_suspicious = 1 ORDER BY created_at DESC",
        expectedIndex: 'idx_deal_clicks_suspicious_created',
      },
      {
        name: 'idx_blocked_ips_ip',
        query: "SELECT id FROM blocked_ips WHERE ip_address = '192.168.10.5'",
        expectedIndex: 'idx_blocked_ips_ip',
      },
      {
        name: 'idx_blocked_ips_active',
        query: "SELECT ip_address FROM blocked_ips WHERE is_active = 1",
        expectedIndex: 'idx_blocked_ips_active',
      },
      {
        name: 'idx_fraud_reviews_click',
        query: "SELECT id FROM fraud_reviews WHERE click_id = 'c-5'",
        expectedIndex: 'idx_fraud_reviews_click',
      },
      {
        name: 'idx_fraud_reviews_ip',
        query: "SELECT id FROM fraud_reviews WHERE ip_address = '192.168.10.5'",
        expectedIndex: 'idx_fraud_reviews_ip',
      },
      {
        name: 'idx_fraud_reviews_reviewer',
        query: "SELECT id FROM fraud_reviews WHERE reviewer_id = 'usr-2'",
        expectedIndex: 'idx_fraud_reviews_reviewer',
      },
      {
        name: 'idx_fraud_reviews_action',
        query: "SELECT id FROM fraud_reviews WHERE action = 'approve'",
        expectedIndex: 'idx_fraud_reviews_action',
      },
      {
        name: 'idx_fraud_reviews_reviewed_at',
        query: "SELECT id FROM fraud_reviews ORDER BY reviewed_at DESC LIMIT 10",
        expectedIndex: 'idx_fraud_reviews_reviewed_at',
      },
    ];

    it.each(indexScenarios)(
      'empirically validates optimizer uses $name ($expectedIndex)',
      ({ query, expectedIndex }) => {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>;
        const planText = plan.map((p) => p.detail).join(' | ');

        // Note: For blocked_ips.ip_address, SQLite may choose either idx_blocked_ips_ip or sqlite_autoindex_blocked_ips_1 (from UNIQUE)
        if (expectedIndex === 'idx_blocked_ips_ip') {
          expect(planText).toMatch(/(idx_blocked_ips_ip|sqlite_autoindex_blocked_ips)/i);
        } else {
          expect(planText).toMatch(new RegExp(expectedIndex, 'i'));
        }
      }
    );
  });
});
