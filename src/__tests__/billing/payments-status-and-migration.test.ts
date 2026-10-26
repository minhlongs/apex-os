/**
 * Empirical Challenger Test Suite for Milestone M1
 * Targets:
 *   1. src/app/api/payments/status/route.ts
 *   2. src/database/migrations/020_billing_mobile_enhancements.sql
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/payments/status/route';
import * as dbModule from '@/lib/db';

// Mock logger to keep test output clean while capturing errors
jest.mock('@/lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('Empirical Challenger: Milestone M1 Stress Tests', () => {
  // ==========================================================================
  // PART 1: payments/status/route.ts
  // ==========================================================================
  describe('payments/status/route.ts adversarial testing', () => {
    let mockDb: any;
    let mockPaymentsTable: Map<string, any>;

    beforeEach(() => {
      mockPaymentsTable = new Map();
      mockDb = {
        prepare: jest.fn((query: string) => {
          let boundId: string | null = null;
          return {
            bind: jest.fn((...args: unknown[]) => {
              boundId = args[0] as string;
              return {
                first: jest.fn(async () => {
                  if (query.includes('FROM payments WHERE payment_id = ?')) {
                    return boundId ? mockPaymentsTable.get(boundId) ?? null : null;
                  }
                  return null;
                }),
              };
            }),
          };
        }),
      };
      jest.spyOn(dbModule, 'getDB').mockReturnValue(mockDb);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('Scenario 1.1: Missing query parameter returns HTTP 400 Bad Request', async () => {
      const req = new NextRequest('http://localhost:3000/api/payments/status');
      const res = await GET(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toBe('Missing id');
    });

    it('Scenario 1.2: Empty id query parameter (?id=) returns HTTP 400 Bad Request', async () => {
      const req = new NextRequest('http://localhost:3000/api/payments/status?id=');
      const res = await GET(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toBe('Missing id');
    });

    it('Scenario 1.3: Non-existent paymentId returns HTTP 404 Not Found', async () => {
      const req = new NextRequest('http://localhost:3000/api/payments/status?id=pay_nonexistent_9999');
      const res = await GET(req);
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.error).toBe('Payment not found');
    });

    it('Scenario 1.4: Database uninitialized / getDB() throws returns HTTP 503 Service Unavailable', async () => {
      jest.spyOn(dbModule, 'getDB').mockImplementation(() => {
        throw new Error('Database not configured');
      });

      const req = new NextRequest('http://localhost:3000/api/payments/status?id=pay_123');
      const res = await GET(req);
      const json = await res.json();

      expect(res.status).toBe(503);
      expect(json.error).toBe('Database not configured');
    });

    it('Scenario 1.5: Database query execution error (prepare/first throws) returns HTTP 500 Internal Server Error', async () => {
      mockDb.prepare = jest.fn(() => ({
        bind: jest.fn(() => ({
          first: jest.fn(async () => {
            throw new Error('D1 statement timeout or disk error');
          }),
        })),
      }));

      const req = new NextRequest('http://localhost:3000/api/payments/status?id=pay_123');
      const res = await GET(req);
      const json = await res.json();

      expect(res.status).toBe(500);
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });

    // Test all status mappings: pending, confirmed, failed, expired, refunded, confirming
    const testStatuses = [
      {
        status: 'pending',
        plan: 'BASIC',
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T18:00:00.000Z',
      },
      {
        status: 'confirming',
        plan: 'PREMIUM',
        amount: 29,
        currency: 'USDT',
        txn_id: '0x123abc',
        confirmed_at: null,
        created_at: '2026-09-24T18:01:00.000Z',
      },
      {
        status: 'confirmed',
        plan: 'ENTERPRISE',
        amount: 99,
        currency: 'USDT',
        txn_id: '0x456def',
        confirmed_at: '2026-09-24T18:05:00.000Z',
        created_at: '2026-09-24T18:00:00.000Z',
      },
      {
        status: 'failed',
        plan: 'BASIC',
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T18:00:00.000Z',
      },
      {
        status: 'expired',
        plan: 'MASTER',
        amount: 299,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T17:00:00.000Z',
      },
      {
        status: 'refunded',
        plan: 'PREMIUM',
        amount: 29,
        currency: 'USDT',
        txn_id: '0x789ghi',
        confirmed_at: '2026-09-24T18:05:00.000Z',
        created_at: '2026-09-24T18:00:00.000Z',
      },
    ];

    for (const testCase of testStatuses) {
      it(`Scenario 1.6: Status mapping for '${testCase.status}' returns HTTP 200 with matching schema`, async () => {
        const paymentId = `pay_${testCase.status}_100`;
        mockPaymentsTable.set(paymentId, testCase);

        const req = new NextRequest(`http://localhost:3000/api/payments/status?id=${paymentId}`);
        const res = await GET(req);
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.status).toBe(testCase.status);
        expect(json.amount).toBe(testCase.amount);
        expect(json.currency).toBe(testCase.currency);
        expect(json.txnId).toBe(testCase.txn_id);
        expect(json.confirmedAt).toBe(testCase.confirmed_at);
        expect(json.createdAt).toBe(testCase.created_at);
      });
    }

    it('Scenario 1.7 [CHALLENGE]: Behavior when query parameter is named paymentId (?paymentId=pay_123)', async () => {
      // Adversarial test: caller sends ?paymentId=pay_123 instead of ?id=pay_123
      const req = new NextRequest('http://localhost:3000/api/payments/status?paymentId=pay_123');
      const res = await GET(req);
      const json = await res.json();

      // route.ts specifically checks `searchParams.get('id')`
      // Therefore, if client sends only ?paymentId=pay_123, it is treated as missing 'id' -> 400
      expect(res.status).toBe(400);
      expect(json.error).toBe('Missing id');
    });

    it('Scenario 1.8: SQL injection attempt in ?id parameter is safely parameterized and returns 404', async () => {
      const maliciousId = "' OR '1'='1";
      const req = new NextRequest(`http://localhost:3000/api/payments/status?id=${encodeURIComponent(maliciousId)}`);
      const res = await GET(req);
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.error).toBe('Payment not found');
    });

    it('Scenario 1.9: Extremely long paymentId parameter string (10,000 characters) handles gracefully', async () => {
      const longId = 'pay_' + 'a'.repeat(10000);
      const req = new NextRequest(`http://localhost:3000/api/payments/status?id=${longId}`);
      const res = await GET(req);
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.error).toBe('Payment not found');
    });

    it('Scenario 1.10: Nullable database columns (txn_id=null, confirmed_at=null) serialize safely', async () => {
      mockPaymentsTable.set('pay_nulls_test', {
        status: 'pending',
        plan: 'BASIC',
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T18:00:00.000Z',
      });

      const req = new NextRequest('http://localhost:3000/api/payments/status?id=pay_nulls_test');
      const res = await GET(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.txnId).toBeNull();
      expect(json.confirmedAt).toBeNull();
    });
  });

  // ==========================================================================
  // PART 2: SQLite Compatibility of Migration 020 Under Edge Cases
  // ==========================================================================
  describe('Migration 020 SQLite Compatibility and Edge Cases', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(':memory:');
      const rootDir = process.cwd();
      const m001 = fs.readFileSync(path.join(rootDir, 'src/database/migrations/001_initial_schema_d1.sql'), 'utf8');
      const m012 = fs.readFileSync(path.join(rootDir, 'src/database/migrations/012_billing_payments.sql'), 'utf8');
      const m020 = fs.readFileSync(path.join(rootDir, 'src/database/migrations/020_billing_mobile_enhancements.sql'), 'utf8');

      db.exec(m001);
      db.exec(m012);
      db.exec(m020);
    });

    afterEach(() => {
      db.close();
    });

    it('Scenario 2.1: Inserts multiple device tokens for a single user (multiple devices / platforms)', () => {
      const userId = 'usr_multi_device_1';

      const ins1 = db.prepare(`
        INSERT INTO device_tokens (user_id, platform, token, apns_token, is_active)
        VALUES (?, 'ios', 'tok_apns_iphone15', 'apns_raw_token_1', 1)
      `).run(userId);
      expect(ins1.changes).toBe(1);

      const ins2 = db.prepare(`
        INSERT INTO device_tokens (user_id, platform, token, fcm_token, is_active)
        VALUES (?, 'android', 'tok_fcm_pixel8', 'fcm_raw_token_1', 1)
      `).run(userId);
      expect(ins2.changes).toBe(1);

      const ins3 = db.prepare(`
        INSERT INTO device_tokens (user_id, platform, token, expo_token, is_active)
        VALUES (?, 'web', 'tok_expo_web', 'expo_token_1', 1)
      `).run(userId);
      expect(ins3.changes).toBe(1);

      const userTokens = db.prepare(`
        SELECT id, platform, token, is_active FROM device_tokens WHERE user_id = ? ORDER BY platform ASC
      `).all(userId);

      expect(userTokens.length).toBe(3);
      expect(userTokens.map((t: any) => t.platform)).toEqual(['android', 'ios', 'web']);
      userTokens.forEach((t: any) => {
        expect(t.id).toMatch(/^[0-9a-f]{32}$/);
      });
    });

    it('Scenario 2.2: Duplicate token handling (same token inserted twice for user or across users)', () => {
      const duplicateToken = 'duplicate_expo_push_token_xyz_123';

      const ins1 = db.prepare(`
        INSERT INTO device_tokens (user_id, platform, token, expo_token)
        VALUES ('usr_1', 'ios', ?, ?)
      `).run(duplicateToken, duplicateToken);
      expect(ins1.changes).toBe(1);

      const ins2 = db.prepare(`
        INSERT INTO device_tokens (user_id, platform, token, expo_token)
        VALUES ('usr_1', 'ios', ?, ?)
      `).run(duplicateToken, duplicateToken);
      expect(ins2.changes).toBe(1);

      const ins3 = db.prepare(`
        INSERT INTO device_tokens (user_id, platform, token, expo_token)
        VALUES ('usr_2', 'ios', ?, ?)
      `).run(duplicateToken, duplicateToken);
      expect(ins3.changes).toBe(1);

      const rows = db.prepare('SELECT id, user_id, token FROM device_tokens WHERE token = ?').all(duplicateToken);
      expect(rows.length).toBe(3);
    });

    it('Scenario 2.3: NULL user_id for deep link analytics (anonymous cold launch)', () => {
      const insAnon = db.prepare(`
        INSERT INTO deep_link_analytics (user_id, kind, route, source, timestamp, metadata)
        VALUES (NULL, 'install_click', 'apex-os://deals/starter', 'direct', '2026-09-24T18:00:00Z', '{"ref":"twitter"}')
      `).run();
      expect(insAnon.changes).toBe(1);

      const insAuth = db.prepare(`
        INSERT INTO deep_link_analytics (user_id, kind, route, source, timestamp, metadata)
        VALUES ('usr_authenticated_42', 'tier_upgrade_click', 'apex-os://billing/upgrade', 'notification', '2026-09-24T18:05:00Z', NULL)
      `).run();
      expect(insAuth.changes).toBe(1);

      const anonEvents = db.prepare('SELECT * FROM deep_link_analytics WHERE user_id IS NULL').all();
      expect(anonEvents.length).toBe(1);
      expect((anonEvents[0] as any).kind).toBe('install_click');
      expect((anonEvents[0] as any).id).toMatch(/^[0-9a-f]{32}$/);

      const authEvents = db.prepare('SELECT * FROM deep_link_analytics WHERE user_id = ?').all('usr_authenticated_42');
      expect(authEvents.length).toBe(1);
      expect((authEvents[0] as any).kind).toBe('tier_upgrade_click');
    });

    it('Scenario 2.4: Platform check constraint rejects invalid platforms', () => {
      const invalidPlatforms = ['windows', 'macos', '', 'IOS', 'Android'];

      for (const p of invalidPlatforms) {
        expect(() => {
          db.prepare(`
            INSERT INTO device_tokens (user_id, platform, token)
            VALUES ('usr_1', ?, 'some_token')
          `).run(p);
        }).toThrow(/CHECK constraint failed/i);
      }
    });

    it('Scenario 2.5: deep_link_analytics NOT NULL constraints on kind, route, source, timestamp', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO deep_link_analytics (user_id, kind, source, timestamp)
          VALUES (NULL, 'test', 'direct', '2026-09-24T18:00:00Z')
        `).run();
      }).toThrow(/NOT NULL constraint failed/i);

      expect(() => {
        db.prepare(`
          INSERT INTO deep_link_analytics (user_id, kind, route, timestamp)
          VALUES (NULL, 'test', 'apex-os://home', '2026-09-24T18:00:00Z')
        `).run();
      }).toThrow(/NOT NULL constraint failed/i);
    });

    it('Scenario 2.6: Profiles table alterations (tier default BASIC, wallet_address, preferred_chain)', () => {
      db.prepare(`
        INSERT INTO users (id, email)
        VALUES ('p_user_1', 'user1@example.com')
      `).run();

      db.prepare(`
        INSERT INTO profiles (id, email)
        VALUES ('p_user_1', 'user1@example.com')
      `).run();

      const prof = db.prepare('SELECT tier, wallet_address, preferred_chain FROM profiles WHERE id = ?').get('p_user_1') as any;
      expect(prof.tier).toBe('BASIC');
      expect(prof.wallet_address).toBeNull();
      expect(prof.preferred_chain).toBeNull();

      db.prepare(`
        UPDATE profiles
        SET wallet_address = '0x1234567890123456789012345678901234567890',
            preferred_chain = 'ethereum',
            tier = 'PREMIUM'
        WHERE id = 'p_user_1'
      `).run();

      const updated = db.prepare('SELECT tier, wallet_address, preferred_chain FROM profiles WHERE id = ?').get('p_user_1') as any;
      expect(updated.tier).toBe('PREMIUM');
      expect(updated.wallet_address).toBe('0x1234567890123456789012345678901234567890');
      expect(updated.preferred_chain).toBe('ethereum');
    });

    it('Scenario 2.7: Device tokens trigger trg_device_tokens_updated behavior in SQLite', () => {
      db.prepare(`
        INSERT INTO device_tokens (id, user_id, platform, token, updated_at)
        VALUES ('dt_fixed_1', 'u_1', 'ios', 'tok_initial', '2026-01-01 00:00:00')
      `).run();

      const before = db.prepare('SELECT updated_at FROM device_tokens WHERE id = ?').get('dt_fixed_1') as any;
      expect(before.updated_at).toBe('2026-01-01 00:00:00');

      db.prepare("UPDATE device_tokens SET token = 'tok_updated' WHERE id = 'dt_fixed_1'").run();

      const after = db.prepare('SELECT token, updated_at FROM device_tokens WHERE id = ?').get('dt_fixed_1') as any;
      expect(after.token).toBe('tok_updated');
      expect(after.updated_at).not.toBe('2026-01-01 00:00:00');
    });

    it('Scenario 2.8: High volume stress test: bulk insert 50 device tokens for one user with active filter', () => {
      const insertStmt = db.prepare(`
        INSERT INTO device_tokens (user_id, platform, token, is_active)
        VALUES (?, ?, ?, ?)
      `);

      const insertMany = db.transaction((userId: string, count: number) => {
        for (let i = 0; i < count; i++) {
          const platform = i % 2 === 0 ? 'ios' : 'android';
          const isActive = i % 3 === 0 ? 0 : 1;
          insertStmt.run(userId, platform, `bulk_token_${i}`, isActive);
        }
      });

      insertMany('usr_bulk_devices', 50);

      // Verify active tokens query
      const activeRows = db.prepare(`
        SELECT count(*) as count FROM device_tokens WHERE user_id = ? AND is_active = 1
      `).get('usr_bulk_devices') as any;

      const inactiveRows = db.prepare(`
        SELECT count(*) as count FROM device_tokens WHERE user_id = ? AND is_active = 0
      `).get('usr_bulk_devices') as any;

      expect(activeRows.count + inactiveRows.count).toBe(50);
      expect(activeRows.count).toBeGreaterThan(0);
      expect(inactiveRows.count).toBeGreaterThan(0);
    });

    it('Scenario 2.9: Bulk insert 200 deep link events with mixed NULL and non-NULL user_ids', () => {
      const insertStmt = db.prepare(`
        INSERT INTO deep_link_analytics (user_id, kind, route, source, timestamp, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const insertMany = db.transaction((count: number) => {
        for (let i = 0; i < count; i++) {
          const userId = i % 2 === 0 ? null : `user_${i}`;
          const source = i % 3 === 0 ? 'notification' : 'direct';
          insertStmt.run(userId, 'bulk_event', `apex-os://billing/event/${i}`, source, new Date().toISOString(), null);
        }
      });

      insertMany(200);

      const total = db.prepare('SELECT count(*) as count FROM deep_link_analytics').get() as any;
      const anonTotal = db.prepare('SELECT count(*) as count FROM deep_link_analytics WHERE user_id IS NULL').get() as any;
      const userTotal = db.prepare('SELECT count(*) as count FROM deep_link_analytics WHERE user_id IS NOT NULL').get() as any;

      expect(total.count).toBe(200);
      expect(anonTotal.count).toBe(100);
      expect(userTotal.count).toBe(100);
    });

    it('Scenario 2.10: Complex Unicode, Emojis, and JSON payload in metadata', () => {
      const complexJson = JSON.stringify({
        source_campaign: '🚀 Crypto Launch Promo 2026',
        nested: {
          japanese: '日本語テスト',
          vietnamese: 'Thanh toán tiền điện tử',
          tags: ['web3', 'defi', '🔥'],
        },
      });

      db.prepare(`
        INSERT INTO deep_link_analytics (user_id, kind, route, source, timestamp, metadata)
        VALUES ('usr_emoji', 'promo_click', 'apex-os://promo/web3-🚀', 'direct', '2026-09-24T18:30:00Z', ?)
      `).run(complexJson);

      const record = db.prepare('SELECT metadata, route FROM deep_link_analytics WHERE user_id = ?').get('usr_emoji') as any;
      expect(record.route).toBe('apex-os://promo/web3-🚀');
      const parsed = JSON.parse(record.metadata);
      expect(parsed.source_campaign).toBe('🚀 Crypto Launch Promo 2026');
      expect(parsed.nested.japanese).toBe('日本語テスト');
      expect(parsed.nested.vietnamese).toBe('Thanh toán tiền điện tử');
      expect(parsed.nested.tags).toContain('🔥');
    });

    it('Scenario 2.11: Verification of all indexes created by migration 020', () => {
      const indexes = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
      `).all().map((r: any) => r.name);

      const expectedIndexes = [
        'idx_profiles_tier',
        'idx_profiles_wallet_address',
        'idx_device_tokens_user',
        'idx_device_tokens_token',
        'idx_device_tokens_expo',
        'idx_device_tokens_apns',
        'idx_device_tokens_fcm',
        'idx_device_tokens_platform',
        'idx_device_tokens_user_active',
        'idx_deep_link_analytics_user',
        'idx_deep_link_analytics_kind',
        'idx_deep_link_analytics_route',
        'idx_deep_link_analytics_source',
        'idx_deep_link_analytics_timestamp',
        'idx_deep_link_analytics_created',
      ];

      for (const expected of expectedIndexes) {
        expect(indexes).toContain(expected);
      }
    });
  });
});

