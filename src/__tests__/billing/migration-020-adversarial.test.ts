/**
 * Adversarial Stress Tests for Cloudflare D1 Migration 020
 * src/__tests__/billing/migration-020-adversarial.test.ts
 *
 * EMPIRICAL CHALLENGE SUITE:
 * 1. Migration execution and duplicate column resilience
 * 2. Table constraints (CHECK, NOT NULL, foreign keys, default values)
 * 3. Trigger operations (trg_device_tokens_updated behavior, recursion, timestamps)
 * 4. Index verification and EXPLAIN QUERY PLAN validation across all 15 indexes
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

describe('Migration 020 Adversarial Stress Test Suite', () => {
  const rootDir = process.cwd();
  const migration001Path = path.join(rootDir, 'src/database/migrations/001_initial_schema_d1.sql');
  const migration012Path = path.join(rootDir, 'src/database/migrations/012_billing_payments.sql');
  const migration020Path = path.join(rootDir, 'src/database/migrations/020_billing_mobile_enhancements.sql');

  let db: Database.Database;

  const initFreshDb = (): Database.Database => {
    const memoryDb = new Database(':memory:');
    memoryDb.pragma('foreign_keys = ON');
    const sql001 = fs.readFileSync(migration001Path, 'utf-8');
    const sql012 = fs.readFileSync(migration012Path, 'utf-8');
    const sql020 = fs.readFileSync(migration020Path, 'utf-8');

    memoryDb.exec(sql001);
    memoryDb.exec(sql012);
    memoryDb.exec(sql020);
    return memoryDb;
  };

  beforeEach(() => {
    db = initFreshDb();
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  // ============================================================
  // 1. DUPLICATE COLUMNS & MIGRATION SEQUENCING
  // ============================================================
  describe('Duplicate Columns & Migration Execution', () => {
    it('applies migration 020 cleanly onto base schema', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r: { name: string }) => r.name);

      expect(tables).toContain('profiles');
      expect(tables).toContain('device_tokens');
      expect(tables).toContain('deep_link_analytics');

      const profileCols = db
        .prepare("PRAGMA table_info('profiles')")
        .all()
        .map((c: { name: string }) => c.name);

      expect(profileCols).toContain('tier');
      expect(profileCols).toContain('wallet_address');
      expect(profileCols).toContain('preferred_chain');
    });

    it('sets default tier to BASIC for newly created and existing records', () => {
      db.prepare("INSERT INTO users (id, email) VALUES ('u-test-1', 'test1@apex-os.com')").run();
      db.prepare("INSERT INTO profiles (id, email) VALUES ('u-test-1', 'test1@apex-os.com')").run();

      const profile = db.prepare("SELECT tier FROM profiles WHERE id = 'u-test-1'").get() as {
        tier: string;
      };
      expect(profile.tier).toBe('BASIC');
    });

    it('confirms SQLite throws duplicate column error if ALTER TABLE runs twice', () => {
      // In SQLite, ALTER TABLE ADD COLUMN does not support IF NOT EXISTS.
      // Sequential migration tracking in Cloudflare D1 (via d1_migrations) is therefore essential.
      const sql020 = fs.readFileSync(migration020Path, 'utf-8');
      expect(() => {
        db.exec(sql020);
      }).toThrow(/duplicate column name: tier/);
    });

    it('verifies CREATE TABLE IF NOT EXISTS idempotency for newly added tables', () => {
      // Isolate table creation statements to ensure CREATE TABLE IF NOT EXISTS executes safely
      const isolatedTableSql = `
        CREATE TABLE IF NOT EXISTS device_tokens (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          user_id TEXT NOT NULL,
          platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
          token TEXT,
          expo_token TEXT,
          apns_token TEXT,
          fcm_token TEXT,
          is_active INTEGER DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS deep_link_analytics (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          user_id TEXT,
          kind TEXT NOT NULL,
          route TEXT NOT NULL,
          source TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          metadata TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `;
      expect(() => db.exec(isolatedTableSql)).not.toThrow();
    });
  });

  // ============================================================
  // 2. CHECK CONSTRAINTS & DATA INTEGRITY
  // ============================================================
  describe('CHECK Constraints & Data Integrity', () => {
    beforeEach(() => {
      db.prepare("INSERT INTO users (id, email) VALUES ('usr-tester', 'tester@apex-os.com')").run();
    });

    it('enforces CHECK constraint on device_tokens.platform (ios, android, web only)', () => {
      // Valid platforms succeed
      for (const platform of ['ios', 'android', 'web']) {
        expect(() => {
          db.prepare(
            "INSERT INTO device_tokens (id, user_id, platform, token) VALUES (?, 'usr-tester', ?, 'tok-valid')"
          ).run(`dt-${platform}`, platform);
        }).not.toThrow();
      }

      // Invalid platforms fail with CHECK constraint violation
      const invalidPlatforms = ['windows', 'macos', 'linux', 'blackberry', 'symbian', 'other', ''];
      for (const platform of invalidPlatforms) {
        expect(() => {
          db.prepare(
            "INSERT INTO device_tokens (id, user_id, platform, token) VALUES (?, 'usr-tester', ?, 'tok-bad')"
          ).run(`dt-bad-${platform}`, platform);
        }).toThrow(/CHECK constraint failed/);
      }
    });

    it('enforces NOT NULL constraint on device_tokens.platform and device_tokens.user_id', () => {
      expect(() => {
        db.prepare("INSERT INTO device_tokens (id, user_id, platform) VALUES ('dt-n1', 'usr-tester', NULL)").run();
      }).toThrow(/NOT NULL constraint failed/);

      expect(() => {
        db.prepare("INSERT INTO device_tokens (id, user_id, platform) VALUES ('dt-n2', NULL, 'ios')").run();
      }).toThrow(/NOT NULL constraint failed/);
    });

    it('supports all push token variants (Expo, APNs, FCM) in device_tokens', () => {
      db.prepare(`
        INSERT INTO device_tokens (id, user_id, platform, expo_token, apns_token, fcm_token, is_active)
        VALUES ('dt-multi', 'usr-tester', 'ios', 'ExponentPushToken[xyz]', 'apns-hex-token-123', 'fcm-registration-token-456', 1)
      `).run();

      const tokenRecord = db.prepare("SELECT * FROM device_tokens WHERE id = 'dt-multi'").get() as {
        expo_token: string;
        apns_token: string;
        fcm_token: string;
        is_active: number;
      };

      expect(tokenRecord.expo_token).toBe('ExponentPushToken[xyz]');
      expect(tokenRecord.apns_token).toBe('apns-hex-token-123');
      expect(tokenRecord.fcm_token).toBe('fcm-registration-token-456');
      expect(tokenRecord.is_active).toBe(1);
    });

    it('allows anonymous cold-launch deep-link events (user_id IS NULL)', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO deep_link_analytics (id, user_id, kind, route, source, timestamp, metadata)
          VALUES ('evt-anon', NULL, 'cold_launch', '/upgrade', 'direct', '2026-09-24T12:00:00.000Z', '{"referrer":"twitter"}')
        `).run();
      }).not.toThrow();

      const record = db.prepare("SELECT * FROM deep_link_analytics WHERE id = 'evt-anon'").get() as {
        user_id: string | null;
        kind: string;
      };
      expect(record.user_id).toBeNull();
      expect(record.kind).toBe('cold_launch');
    });

    it('enforces NOT NULL constraint on required deep_link_analytics fields', () => {
      // kind NOT NULL
      expect(() => {
        db.prepare("INSERT INTO deep_link_analytics (id, kind, route, source, timestamp) VALUES ('e1', NULL, '/r', 's', 't')").run();
      }).toThrow(/NOT NULL constraint failed: deep_link_analytics\.kind/);

      // route NOT NULL
      expect(() => {
        db.prepare("INSERT INTO deep_link_analytics (id, kind, route, source, timestamp) VALUES ('e2', 'k', NULL, 's', 't')").run();
      }).toThrow(/NOT NULL constraint failed: deep_link_analytics\.route/);

      // source NOT NULL
      expect(() => {
        db.prepare("INSERT INTO deep_link_analytics (id, kind, route, source, timestamp) VALUES ('e3', 'k', '/r', NULL, 't')").run();
      }).toThrow(/NOT NULL constraint failed: deep_link_analytics\.source/);

      // timestamp NOT NULL
      expect(() => {
        db.prepare("INSERT INTO deep_link_analytics (id, kind, route, source, timestamp) VALUES ('e4', 'k', '/r', 's', NULL)").run();
      }).toThrow(/NOT NULL constraint failed: deep_link_analytics\.timestamp/);
    });
  });

  // ============================================================
  // 3. TRIGGER OPERATIONS & TIMESTAMPS
  // ============================================================
  describe('Trigger Operations (trg_device_tokens_updated)', () => {
    beforeEach(() => {
      db.prepare("INSERT INTO users (id, email) VALUES ('usr-trg', 'trg@apex-os.com')").run();
      db.prepare(`
        INSERT INTO device_tokens (id, user_id, platform, token, is_active, created_at, updated_at)
        VALUES ('dt-trg-1', 'usr-trg', 'ios', 'tok-init', 1, '2020-01-01 00:00:00', '2020-01-01 00:00:00')
      `).run();
    });

    it('auto-updates updated_at timestamp when record is modified', () => {
      const before = db.prepare("SELECT updated_at FROM device_tokens WHERE id = 'dt-trg-1'").get() as {
        updated_at: string;
      };
      expect(before.updated_at).toBe('2020-01-01 00:00:00');

      // Perform update on is_active
      db.prepare("UPDATE device_tokens SET is_active = 0 WHERE id = 'dt-trg-1'").run();

      const after = db.prepare("SELECT updated_at, is_active FROM device_tokens WHERE id = 'dt-trg-1'").get() as {
        updated_at: string;
        is_active: number;
      };
      expect(after.is_active).toBe(0);
      expect(after.updated_at).not.toBe('2020-01-01 00:00:00');
    });

    it('operates safely under default SQLite recursive_triggers setting (OFF)', () => {
      // Verify recursive_triggers is OFF by default
      const pragmaVal = db.pragma('recursive_triggers', { simple: true });
      expect(pragmaVal).toBe(0);

      // Consecutive updates do not trigger recursion errors
      for (let i = 0; i < 10; i++) {
        expect(() => {
          db.prepare("UPDATE device_tokens SET token = ? WHERE id = 'dt-trg-1'").run(`tok-${i}`);
        }).not.toThrow();
      }
    });

    it('documents trigger recursion behavior when recursive_triggers is forced ON', () => {
      // When recursive_triggers is enabled in SQLite, an AFTER UPDATE trigger executing UPDATE
      // on the same table without column restriction hits SQLite max recursion depth.
      const recursiveDb = initFreshDb();
      recursiveDb.pragma('recursive_triggers = ON');
      recursiveDb.prepare("INSERT INTO users (id, email) VALUES ('u-rec', 'rec@apex-os.com')").run();
      recursiveDb.prepare("INSERT INTO device_tokens (id, user_id, platform, token) VALUES ('dt-rec', 'u-rec', 'ios', 'tok')").run();

      expect(() => {
        recursiveDb.prepare("UPDATE device_tokens SET is_active = 0 WHERE id = 'dt-rec'").run();
      }).toThrow(/too many levels of trigger recursion/);
      recursiveDb.close();
    });
  });

  // ============================================================
  // 4. INDEX VALIDATION & QUERY PLAN OPTIMIZATION
  // ============================================================
  describe('Index Validation & EXPLAIN QUERY PLAN Verification', () => {
    beforeEach(() => {
      // Seed sufficient volume of test rows so SQLite cost-based optimizer chooses indexes over full table scans
      const insertUser = db.prepare("INSERT INTO users (id, email) VALUES (?, ?)");
      const insertProfile = db.prepare(
        "INSERT INTO profiles (id, email, tier, wallet_address, preferred_chain) VALUES (?, ?, ?, ?, ?)"
      );
      const insertDeviceToken = db.prepare(`
        INSERT INTO device_tokens (id, user_id, platform, token, expo_token, apns_token, fcm_token, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertAnalytics = db.prepare(`
        INSERT INTO deep_link_analytics (id, user_id, kind, route, source, timestamp, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < 100; i++) {
        const uid = `seed-usr-${i}`;
        const email = `seed-${i}@apex-os.com`;
        const tier = i % 4 === 0 ? 'ENTERPRISE' : i % 3 === 0 ? 'PREMIUM' : 'BASIC';
        const wallet = `0x${i.toString(16).padStart(40, '0')}`;
        const chain = i % 2 === 0 ? 'ethereum' : 'solana';

        insertUser.run(uid, email);
        insertProfile.run(uid, email, tier, wallet, chain);
        insertDeviceToken.run(
          `dt-seed-${i}`,
          uid,
          i % 2 === 0 ? 'ios' : 'android',
          `tok-${i}`,
          `expo-${i}`,
          `apns-${i}`,
          `fcm-${i}`,
          i % 2 === 0 ? 1 : 0
        );
        insertAnalytics.run(
          `an-seed-${i}`,
          uid,
          i % 2 === 0 ? 'checkout' : 'launch',
          `/tier/${tier.toLowerCase()}`,
          i % 2 === 0 ? 'notification' : 'direct',
          `2026-09-24T${(i % 24).toString().padStart(2, '0')}:00:00.000Z`,
          `2026-09-24T${(i % 24).toString().padStart(2, '0')}:00:00.000Z`
        );
      }
    });

    const indexVerificationQueries = [
      {
        name: 'idx_profiles_tier',
        query: "SELECT * FROM profiles WHERE tier = 'PREMIUM'",
        expectedIndex: 'idx_profiles_tier',
      },
      {
        name: 'idx_profiles_wallet_address',
        query: "SELECT * FROM profiles WHERE wallet_address = '0x0000000000000000000000000000000000000005'",
        expectedIndex: 'idx_profiles_wallet_address',
      },
      {
        name: 'idx_device_tokens_user / idx_device_tokens_user_active',
        query: "SELECT * FROM device_tokens WHERE user_id = 'seed-usr-5'",
        expectedIndex: 'idx_device_tokens_user',
      },
      {
        name: 'idx_device_tokens_token',
        query: "SELECT * FROM device_tokens WHERE token = 'tok-5'",
        expectedIndex: 'idx_device_tokens_token',
      },
      {
        name: 'idx_device_tokens_expo',
        query: "SELECT * FROM device_tokens WHERE expo_token = 'expo-5'",
        expectedIndex: 'idx_device_tokens_expo',
      },
      {
        name: 'idx_device_tokens_apns',
        query: "SELECT * FROM device_tokens WHERE apns_token = 'apns-5'",
        expectedIndex: 'idx_device_tokens_apns',
      },
      {
        name: 'idx_device_tokens_fcm',
        query: "SELECT * FROM device_tokens WHERE fcm_token = 'fcm-5'",
        expectedIndex: 'idx_device_tokens_fcm',
      },
      {
        name: 'idx_device_tokens_platform',
        query: "SELECT * FROM device_tokens WHERE platform = 'ios'",
        expectedIndex: 'idx_device_tokens_platform',
      },
      {
        name: 'idx_device_tokens_user_active',
        query: "SELECT * FROM device_tokens WHERE user_id = 'seed-usr-5' AND is_active = 1",
        expectedIndex: 'idx_device_tokens_user_active',
      },
      {
        name: 'idx_deep_link_analytics_user',
        query: "SELECT * FROM deep_link_analytics WHERE user_id = 'seed-usr-5'",
        expectedIndex: 'idx_deep_link_analytics_user',
      },
      {
        name: 'idx_deep_link_analytics_kind',
        query: "SELECT * FROM deep_link_analytics WHERE kind = 'checkout'",
        expectedIndex: 'idx_deep_link_analytics_kind',
      },
      {
        name: 'idx_deep_link_analytics_route',
        query: "SELECT * FROM deep_link_analytics WHERE route = '/tier/premium'",
        expectedIndex: 'idx_deep_link_analytics_route',
      },
      {
        name: 'idx_deep_link_analytics_source',
        query: "SELECT * FROM deep_link_analytics WHERE source = 'notification'",
        expectedIndex: 'idx_deep_link_analytics_source',
      },
      {
        name: 'idx_deep_link_analytics_timestamp',
        query: "SELECT * FROM deep_link_analytics WHERE timestamp > '2026-09-24T10:00:00.000Z'",
        expectedIndex: 'idx_deep_link_analytics_timestamp',
      },
      {
        name: 'idx_deep_link_analytics_created',
        query: "SELECT * FROM deep_link_analytics WHERE created_at > '2026-09-24T10:00:00.000Z'",
        expectedIndex: 'idx_deep_link_analytics_created',
      },
    ];

    it.each(indexVerificationQueries)(
      'utilizes index for $name ($expectedIndex)',
      ({ query, expectedIndex }) => {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>;
        const planDetails = plan.map((p) => p.detail).join(' | ');

        // The query plan must indicate an index search/scan using expectedIndex
        expect(planDetails).toMatch(new RegExp(`USING INDEX ${expectedIndex.split(' ')[0]}`));
      }
    );
  });
});
