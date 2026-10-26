/**
 * Milestone 3 Adversarial Challenger Stress Suite:
 * Burst Detection & Click-to-Conversion Ratio Velocity Boundaries
 * Location: src/__tests__/fraud/challenger-m3-burst-ratio-stress.test.ts
 *
 * Empirical verification and stress testing covering:
 * 1. Burst Detection Exact Boundaries & Clock Skew (Feature F7):
 *    - 2,000ms delta (exact boundary -> clean)
 *    - 1,999ms delta (exact boundary -> flagged BURST_CLICK, score 0.85)
 *    - 2,001ms delta (clean)
 *    - Sub-second bursts: 999ms, 500ms, 100ms, 0ms (score >= 0.90)
 *    - Exact 1,000ms delta (score 0.85)
 *    - First click for IP/session (clean)
 *    - Session tracking across rotated IPs (matchedBy = 'session')
 *    - IP tracking across rotated sessions (matchedBy = 'ip')
 *    - Negative delta / out-of-order clicks (clean)
 *    - IPv4-mapped IPv6 normalization in burst detection (::ffff:x.x.x.x vs x.x.x.x)
 *    - SQLite space-separated timestamp vs ISO epoch parsing
 *
 * 2. Click-to-Conversion Velocity Thresholds & Status Filtering (Feature F8):
 *    - 9 clicks and 0 conversions (clean under 10-click floor)
 *    - 10 clicks and 0 conversions (flagged HIGH_CLICK_CONVERSION_RATIO)
 *    - 10 clicks and 1 conversion (ratio = 10.0 -> clean)
 *    - 11 clicks and 1 conversion (ratio = 11.0 -> flagged HIGH_CLICK_CONVERSION_RATIO)
 *    - Status filtering: 'confirmed' vs 'approved' vs 'rejected' vs 'unconfirmed' vs 'pending'
 *    - Real SQLite / D1 database testing with better-sqlite3 engine
 *    - Fallback affiliate identification via affiliateId when affiliateCode is null
 *
 * 3. Multi-Anomaly Stacking & Ingestion Persistence (Test C5 & Routes):
 *    - Combined BURST_CLICK + HIGH_CLICK_CONVERSION_RATIO probabilistic stacking (>= 0.85)
 *    - Route integration: POST/GET deals/[id]/click & GET tracking/click fraud transparency
 *    - Attribution isolation in Matcher
 */

import {
  mockFraudDB,
  setupFraudTestEnvironment,
  createFraudTestRequest,
  dispatchRoute,
} from './fraud-test-harness';
import {
  evaluateClickVelocity,
  parseTimestampMs,
} from '@/lib/fraud/fraud-engine';
import { Matcher } from '@/lib/tracking/matcher';
import { FraudReasonCode } from '@/types/fraud';
import Database from 'better-sqlite3';

beforeAll(() => {
  setupFraudTestEnvironment();
});

function createRealSqliteD1() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE deal_clicks (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      affiliate_code TEXT,
      affiliate_id TEXT,
      session_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT DEFAULT 'agent',
      referrer_url TEXT,
      country_code TEXT DEFAULT 'US',
      device_type TEXT DEFAULT 'desktop',
      click_type TEXT DEFAULT 'link',
      is_unique INTEGER DEFAULT 1,
      is_suspicious INTEGER DEFAULT 0,
      anomaly_score REAL DEFAULT 0.0,
      flag_reasons TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE conversions (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      affiliate_code TEXT,
      affiliate_id TEXT,
      user_id TEXT,
      amount REAL DEFAULT 0.0,
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_clicks_ip_sess ON deal_clicks(ip_address, session_id, created_at);
    CREATE INDEX idx_clicks_deal_aff ON deal_clicks(deal_id, affiliate_code);
    CREATE INDEX idx_conv_deal_aff ON conversions(deal_id, affiliate_code, status);
  `);

  const d1Adapter: any = {
    prepare: (sql: string) => {
      const stmt = sqlite.prepare(sql);
      return {
        bind: (...params: any[]) => ({
          first: async <T>() => stmt.get(...params) as T,
          all: async <T>() => ({ results: stmt.all(...params) as T[] }),
          run: async () => {
            const res = stmt.run(...params);
            return { success: true, meta: { changes: res.changes } };
          },
        }),
      };
    },
    _rawDb: sqlite,
  };

  return { d1Adapter, sqlite };
}

describe('Milestone 3 Challenger Stress Suite: Burst & Ratio Boundaries', () => {
  const db = mockFraudDB;

  beforeEach(() => {
    mockFraudDB.reset();

    mockFraudDB.deals.set('deal-active-1', {
      id: 'deal-active-1',
      url: 'https://partner.exchange.com/register?ref=apex',
      title: 'Active Deal 1',
      is_active: 1,
      created_at: new Date().toISOString(),
    });

    mockFraudDB.profiles.set('usr-trader-1', {
      id: 'usr-trader-1',
      email: 'trader1@apex-os.com',
      full_name: 'Trader One',
      role: 'user',
      created_at: new Date().toISOString(),
    });
  });

  // ==========================================================================
  // Section 1: Rapid Multi-Click Burst Anomaly Detection (Feature F7)
  // ==========================================================================
  describe('1. Burst Detection Boundary Conditions', () => {
    const testIp = '198.51.100.77';
    const testSession = 'sess-burst-test-77';
    const baseNow = 1758816000000;

    it('1.1 First click for an IP/session has no prior record and is clean', async () => {
      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-clean',
        sessionId: 'sess-first-ever',
        ipAddress: '198.51.100.99',
        timestamp: baseNow,
      });

      expect(res.isSuspicious).toBe(false);
      expect(res.burstDetected).toBe(false);
      expect(res.anomalyScore).toBe(0.0);
      expect(res.flagReasons).toEqual([]);
      expect(res.burstDetails).toBeUndefined();
    });

    it('1.2 EXACT BOUNDARY: Click at exactly 2,000ms delta is clean', async () => {
      db.dealClicks.set('c-prior-2000', {
        id: 'c-prior-2000',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: testSession,
        ip_address: testIp,
        created_at: new Date(baseNow - 2000).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: baseNow,
      });

      expect(res.burstDetected).toBe(false);
      expect(res.isSuspicious).toBe(false);
      expect(res.flagReasons).not.toContain(FraudReasonCode.BURST_CLICK);
    });

    it('1.3 EXACT BOUNDARY: Click at 1,999ms delta is flagged BURST_CLICK with score 0.85', async () => {
      db.dealClicks.set('c-prior-1999', {
        id: 'c-prior-1999',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: testSession,
        ip_address: testIp,
        created_at: new Date(baseNow - 1999).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: baseNow,
      });

      expect(res.isSuspicious).toBe(true);
      expect(res.burstDetected).toBe(true);
      expect(res.flagReasons).toContain(FraudReasonCode.BURST_CLICK);
      expect(res.burstDetails?.deltaMs).toBe(1999);
      expect(res.anomalyScore).toBe(0.85);
    });

    it('1.4 EXACT BOUNDARY: Click at 2,001ms delta is clean', async () => {
      db.dealClicks.set('c-prior-2001', {
        id: 'c-prior-2001',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: testSession,
        ip_address: testIp,
        created_at: new Date(baseNow - 2001).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: baseNow,
      });

      expect(res.burstDetected).toBe(false);
      expect(res.isSuspicious).toBe(false);
    });

    it('1.5 Sub-second burst boundary: exactly 1,000ms has base score 0.85', async () => {
      db.dealClicks.set('c-prior-1000', {
        id: 'c-prior-1000',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: testSession,
        ip_address: testIp,
        created_at: new Date(baseNow - 1000).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: baseNow,
      });

      expect(res.burstDetected).toBe(true);
      expect(res.anomalyScore).toBe(0.85);
      expect(res.burstDetails?.deltaMs).toBe(1000);
    });

    it('1.6 Sub-second burst: 999ms delta produces elevated score 0.90 (score >= 0.90)', async () => {
      db.dealClicks.set('c-prior-999', {
        id: 'c-prior-999',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: testSession,
        ip_address: testIp,
        created_at: new Date(baseNow - 999).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: baseNow,
      });

      expect(res.burstDetected).toBe(true);
      expect(res.anomalyScore).toBe(0.90);
      expect(res.anomalyScore).toBeGreaterThanOrEqual(0.90);
      expect(res.burstDetails?.deltaMs).toBe(999);
    });

    it('1.7 Sub-second burst: ultra-rapid 50ms interval produces elevated score 0.90', async () => {
      db.dealClicks.set('c-prior-50', {
        id: 'c-prior-50',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: testSession,
        ip_address: testIp,
        created_at: new Date(baseNow - 50).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: baseNow,
      });

      expect(res.burstDetected).toBe(true);
      expect(res.anomalyScore).toBe(0.90);
      expect(res.burstDetails?.deltaMs).toBe(50);
    });

    it('1.8 Simultaneous click (0ms delta) produces elevated score 0.90', async () => {
      db.dealClicks.set('c-prior-0ms', {
        id: 'c-prior-0ms',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: testSession,
        ip_address: testIp,
        created_at: new Date(baseNow).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: baseNow,
      });

      expect(res.burstDetected).toBe(true);
      expect(res.anomalyScore).toBe(0.90);
      expect(res.burstDetails?.deltaMs).toBe(0);
    });

    it('1.9 Clock skew / out-of-order click (deltaMs < 0) is ignored and not flagged', async () => {
      db.dealClicks.set('c-future-clock', {
        id: 'c-future-clock',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: testSession,
        ip_address: testIp,
        created_at: new Date(baseNow + 5000).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: baseNow,
      });

      expect(res.burstDetected).toBe(false);
      expect(res.isSuspicious).toBe(false);
    });

    it('1.10 Rotated IP with shared session_id triggers burst (matchedBy = "session")', async () => {
      const ip1 = '198.51.100.10';
      const ip2 = '203.0.113.20';
      const sharedSess = 'sess-rotated-ip-99';

      db.dealClicks.set('c-prior-sess', {
        id: 'c-prior-sess',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: sharedSess,
        ip_address: ip1,
        created_at: new Date(baseNow - 400).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: sharedSess,
        ipAddress: ip2,
        timestamp: baseNow,
      });

      expect(res.burstDetected).toBe(true);
      expect(res.burstDetails?.matchedBy).toBe('session');
      expect(res.burstDetails?.previousClickId).toBe('c-prior-sess');
    });

    it('1.11 Rotated session with shared IP triggers burst (matchedBy = "ip")', async () => {
      const sharedIp = '198.51.100.33';
      const sess1 = 'sess-alpha';
      const sess2 = 'sess-beta';

      db.dealClicks.set('c-prior-ip', {
        id: 'c-prior-ip',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: sess1,
        ip_address: sharedIp,
        created_at: new Date(baseNow - 600).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: sess2,
        ipAddress: sharedIp,
        timestamp: baseNow,
      });

      expect(res.burstDetected).toBe(true);
      expect(res.burstDetails?.matchedBy).toBe('ip');
      expect(res.burstDetails?.previousClickId).toBe('c-prior-ip');
    });

    it('1.12 IPv4-mapped IPv6 address matches plain IPv4 in prior click', async () => {
      const plainIp = '198.51.100.50';
      const mappedIp = '::ffff:198.51.100.50';

      db.dealClicks.set('c-prior-mapped', {
        id: 'c-prior-mapped',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: 's-mapped-1',
        ip_address: plainIp,
        created_at: new Date(baseNow - 500).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: 's-mapped-2',
        ipAddress: mappedIp, // Normalized to 198.51.100.50
        timestamp: baseNow,
      });

      expect(res.burstDetected).toBe(true);
      expect(res.burstDetails?.matchedBy).toBe('ip');
    });

    it('1.13 Prior click stored with SQLite space format (YYYY-MM-DD HH:MM:SS) parses accurately in UTC', async () => {
      // 2026-09-25 16:00:00 UTC = 1758816000000
      const sqliteTimestamp = '2026-09-25 16:00:00';
      const priorMs = Date.UTC(2026, 8, 25, 16, 0, 0, 0);
      const incomingNowMs = priorMs + 800; // 800ms later

      db.dealClicks.set('c-sqlite-format', {
        id: 'c-sqlite-format',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        session_id: 's-sqlite',
        ip_address: '198.51.100.60',
        created_at: sqliteTimestamp,
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        sessionId: 's-sqlite',
        ipAddress: '198.51.100.60',
        timestamp: incomingNowMs,
      });

      expect(res.burstDetected).toBe(true);
      expect(res.burstDetails?.deltaMs).toBe(800);
      expect(res.anomalyScore).toBe(0.90);
    });
  });

  // ==========================================================================
  // Section 2: Click-to-Conversion Ratio Velocity Boundaries (Feature F8)
  // ==========================================================================
  describe('2. Click-to-Conversion Ratio Velocity Thresholds', () => {
    const dealId = 'deal-active-1';
    const affCode = 'aff-ratio-stress';

    it('2.1 Statistical floor: 9 clicks and 0 conversions is clean (under 10-click floor)', async () => {
      for (let i = 0; i < 9; i++) {
        db.dealClicks.set(`c-fl9-${i}`, {
          id: `c-fl9-${i}`,
          deal_id: dealId,
          affiliate_code: affCode,
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: `198.51.100.${i}`,
          created_at: new Date(Date.now() - 60000).toISOString(),
        });
      }

      const res = await evaluateClickVelocity(db as any, {
        dealId,
        affiliateCode: affCode,
        sessionId: 's-new-fl9',
        ipAddress: '198.51.100.250',
      });

      expect(res.ratioAnomalyDetected).toBe(false);
      expect(res.isSuspicious).toBe(false);
    });

    it('2.2 Statistical floor: 10 clicks and 0 conversions IS flagged (Infinity > 10.0)', async () => {
      for (let i = 0; i < 10; i++) {
        db.dealClicks.set(`c-fl10-${i}`, {
          id: `c-fl10-${i}`,
          deal_id: dealId,
          affiliate_code: affCode,
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: `198.51.100.${i}`,
          created_at: new Date(Date.now() - 60000).toISOString(),
        });
      }

      const res = await evaluateClickVelocity(db as any, {
        dealId,
        affiliateCode: affCode,
        sessionId: 's-new-fl10',
        ipAddress: '198.51.100.250',
      });

      expect(res.ratioAnomalyDetected).toBe(true);
      expect(res.isSuspicious).toBe(true);
      expect(res.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
      expect(res.anomalyScore).toBe(0.70);
      expect(res.ratioDetails?.totalClicks).toBe(10);
      expect(res.ratioDetails?.totalConversions).toBe(0);
      expect(res.ratioDetails?.clickToConvRatio).toBe(Infinity);
    });

    it('2.3 EXACT BOUNDARY: 10 clicks and 1 conversion (ratio = 10.0) is clean (NOT flagged)', async () => {
      for (let i = 0; i < 10; i++) {
        db.dealClicks.set(`c-ex10-${i}`, {
          id: `c-ex10-${i}`,
          deal_id: dealId,
          affiliate_code: affCode,
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: `198.51.100.${i}`,
          created_at: new Date(Date.now() - 60000).toISOString(),
        });
      }

      db.conversions.set('conv-ex10-1', {
        id: 'conv-ex10-1',
        deal_id: dealId,
        affiliate_code: affCode,
        affiliate_id: 'u1',
        user_id: 'trader-1',
        amount: 50,
        status: 'confirmed',
        created_at: new Date(Date.now() - 50000).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId,
        affiliateCode: affCode,
        sessionId: 's-new-ex10',
        ipAddress: '198.51.100.250',
      });

      expect(res.ratioAnomalyDetected).toBe(false);
      expect(res.isSuspicious).toBe(false);
    });

    it('2.4 EXACT BOUNDARY: 11 clicks and 1 conversion (ratio = 11.0 > 10.0) IS flagged', async () => {
      for (let i = 0; i < 11; i++) {
        db.dealClicks.set(`c-ex11-${i}`, {
          id: `c-ex11-${i}`,
          deal_id: dealId,
          affiliate_code: affCode,
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: `198.51.100.${i}`,
          created_at: new Date(Date.now() - 60000).toISOString(),
        });
      }

      db.conversions.set('conv-ex11-1', {
        id: 'conv-ex11-1',
        deal_id: dealId,
        affiliate_code: affCode,
        affiliate_id: 'u1',
        user_id: 'trader-1',
        amount: 50,
        status: 'confirmed',
        created_at: new Date(Date.now() - 50000).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId,
        affiliateCode: affCode,
        sessionId: 's-new-ex11',
        ipAddress: '198.51.100.250',
      });

      expect(res.ratioAnomalyDetected).toBe(true);
      expect(res.isSuspicious).toBe(true);
      expect(res.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
      expect(res.ratioDetails?.totalClicks).toBe(11);
      expect(res.ratioDetails?.totalConversions).toBe(1);
      expect(res.ratioDetails?.clickToConvRatio).toBe(11);
    });

    it('2.5 Status filtering in real SQLite/D1 engine: ignores unconfirmed, rejected, and pending conversions', async () => {
      const { d1Adapter, sqlite } = createRealSqliteD1();
      const aff = 'aff-sqlite-status-test';

      // Insert 10 clicks in real SQLite
      const insertClick = sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, affiliate_code, session_id, ip_address, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `);
      for (let i = 0; i < 10; i++) {
        insertClick.run(`c-sql-${i}`, dealId, aff, `s-${i}`, `198.51.100.${i}`);
      }

      // Insert 3 conversions with non-confirmed statuses: 'rejected', 'unconfirmed', 'pending'
      const insertConv = sqlite.prepare(`
        INSERT INTO conversions (id, deal_id, affiliate_code, status, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `);
      insertConv.run('conv-rej', dealId, aff, 'rejected');
      insertConv.run('conv-unconf', dealId, aff, 'unconfirmed');
      insertConv.run('conv-pend', dealId, aff, 'pending');

      const res = await evaluateClickVelocity(d1Adapter, {
        dealId,
        affiliateCode: aff,
        sessionId: 's-sql-check',
        ipAddress: '198.51.100.200',
      });

      // 10 clicks, 0 valid conversions -> ratio = Infinity > 10.0 -> flagged!
      expect(res.ratioAnomalyDetected).toBe(true);
      expect(res.isSuspicious).toBe(true);
      expect(res.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
      expect(res.ratioDetails?.totalClicks).toBe(10);
      expect(res.ratioDetails?.totalConversions).toBe(0);
      expect(res.ratioDetails?.clickToConvRatio).toBe(Infinity);
    });

    it('2.6 Status filtering in real SQLite/D1 engine: accepts both "confirmed" and "approved" statuses', async () => {
      const { d1Adapter, sqlite } = createRealSqliteD1();
      const aff = 'aff-sqlite-approved-test';

      // Insert 20 clicks in real SQLite
      const insertClick = sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, affiliate_code, session_id, ip_address, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `);
      for (let i = 0; i < 20; i++) {
        insertClick.run(`c-sql20-${i}`, dealId, aff, `s-${i}`, `198.51.100.${i}`);
      }

      // Insert 1 'confirmed' and 1 'approved' conversion -> total valid = 2
      // Ratio = 20 / 2 = 10.0 -> clean!
      const insertConv = sqlite.prepare(`
        INSERT INTO conversions (id, deal_id, affiliate_code, status, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `);
      insertConv.run('conv-conf-1', dealId, aff, 'confirmed');
      insertConv.run('conv-appr-1', dealId, aff, 'approved');

      const res = await evaluateClickVelocity(d1Adapter, {
        dealId,
        affiliateCode: aff,
        sessionId: 's-sql-check2',
        ipAddress: '198.51.100.200',
      });

      expect(res.ratioAnomalyDetected).toBe(false);
      expect(res.isSuspicious).toBe(false);
    });

    it('2.7 Fallback affiliate identification via affiliateId when affiliateCode is null', async () => {
      const { d1Adapter, sqlite } = createRealSqliteD1();
      const affId = 'usr-affiliate-uuid-42';

      // Insert 11 clicks with affiliate_id (null affiliate_code)
      const insertClick = sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, affiliate_id, session_id, ip_address, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `);
      for (let i = 0; i < 11; i++) {
        insertClick.run(`c-affid-${i}`, dealId, affId, `s-${i}`, `198.51.100.${i}`);
      }

      // Insert 1 confirmed conversion with affiliate_id
      const insertConv = sqlite.prepare(`
        INSERT INTO conversions (id, deal_id, affiliate_id, status, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `);
      insertConv.run('conv-affid-1', dealId, affId, 'confirmed');

      const res = await evaluateClickVelocity(d1Adapter, {
        dealId,
        affiliateCode: null,
        affiliateId: affId,
        sessionId: 's-affid-check',
        ipAddress: '198.51.100.200',
      });

      // 11 clicks, 1 conversion -> ratio = 11.0 > 10.0 -> flagged!
      expect(res.ratioAnomalyDetected).toBe(true);
      expect(res.isSuspicious).toBe(true);
      expect(res.ratioDetails?.totalClicks).toBe(11);
      expect(res.ratioDetails?.totalConversions).toBe(1);
    });
  });

  // ==========================================================================
  // Section 3: Multi-Anomaly Stacking & Probabilistic Union
  // ==========================================================================
  describe('3. Multi-Anomaly Score Stacking', () => {
    it('3.1 Combines BURST_CLICK (0.90) and HIGH_CLICK_CONVERSION_RATIO (0.70) to 0.97 (>= 0.85)', async () => {
      const affCode = 'stack-test-aff';
      const testIp = '198.51.100.180';
      const testSession = 'sess-stack-180';
      const now = 1758816000000;

      // Seed 15 clicks for ratio
      for (let i = 0; i < 15; i++) {
        db.dealClicks.set(`c-stk-${i}`, {
          id: `c-stk-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: affCode,
          session_id: `s-${i}`,
          ip_address: `198.51.100.${i}`,
          created_at: new Date(now - 120000).toISOString(),
        });
      }

      // Prior click 300ms ago -> sub-second burst (0.90)
      db.dealClicks.set('c-stk-burst', {
        id: 'c-stk-burst',
        deal_id: 'deal-active-1',
        affiliate_code: affCode,
        session_id: testSession,
        ip_address: testIp,
        created_at: new Date(now - 300).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: affCode,
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: now,
      });

      expect(res.isSuspicious).toBe(true);
      expect(res.burstDetected).toBe(true);
      expect(res.ratioAnomalyDetected).toBe(true);
      expect(res.flagReasons).toContain(FraudReasonCode.BURST_CLICK);
      expect(res.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
      // Union: 1 - (1 - 0.90) * (1 - 0.70) = 1 - 0.10 * 0.30 = 0.97
      expect(res.anomalyScore).toBe(0.97);
      expect(res.anomalyScore).toBeGreaterThanOrEqual(0.85);
    });

    it('3.2 Combines 1,500ms BURST_CLICK (0.85) and HIGH_CLICK_CONVERSION_RATIO (0.70) to 0.955 (>= 0.85)', async () => {
      const affCode = 'stack-test-aff2';
      const testIp = '198.51.100.181';
      const testSession = 'sess-stack-181';
      const now = 1758816000000;

      for (let i = 0; i < 12; i++) {
        db.dealClicks.set(`c-stk2-${i}`, {
          id: `c-stk2-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: affCode,
          session_id: `s-${i}`,
          ip_address: `198.51.100.${i}`,
          created_at: new Date(now - 120000).toISOString(),
        });
      }

      // Prior click 1500ms ago -> burst score 0.85
      db.dealClicks.set('c-stk2-burst', {
        id: 'c-stk2-burst',
        deal_id: 'deal-active-1',
        affiliate_code: affCode,
        session_id: testSession,
        ip_address: testIp,
        created_at: new Date(now - 1500).toISOString(),
      });

      const res = await evaluateClickVelocity(db as any, {
        dealId: 'deal-active-1',
        affiliateCode: affCode,
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: now,
      });

      expect(res.isSuspicious).toBe(true);
      // Union: 1 - (1 - 0.85) * (1 - 0.70) = 1 - 0.15 * 0.30 = 0.955
      expect(res.anomalyScore).toBe(0.955);
      expect(res.anomalyScore).toBeGreaterThanOrEqual(0.85);
    });
  });

  // ==========================================================================
  // Section 4: Route Level Fraud Transparency & Ingestion Persistence
  // ==========================================================================
  describe('4. Route Integration & Attribution Isolation', () => {
    it('4.1 POST /api/deals/[id]/click persists burst click with is_suspicious = 1 without breaking user 200 response', async () => {
      const ip = '198.51.100.210';
      const session = 'sess-route-post';

      db.dealClicks.set('prior-post-click', {
        id: 'prior-post-click',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-route',
        session_id: session,
        ip_address: ip,
        created_at: new Date(Date.now() - 400).toISOString(),
      });

      const req = createFraudTestRequest('http://localhost:3000/api/deals/deal-active-1/click', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': ip,
          cookie: `apex_tracking_id=${session}`,
        },
        body: { userId: 'u-post-1' },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: 'deal-active-1' }
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      const inserted = Array.from(db.dealClicks.values()).find(
        (c) => c.id !== 'prior-post-click' && c.ip_address === ip
      );
      expect(inserted).toBeDefined();
      expect(inserted?.is_suspicious).toBe(1);
      expect(inserted?.anomaly_score).toBe(0.90);
      expect(inserted?.flag_reasons).toContain('BURST_CLICK');
    });

    it('4.2 GET /api/deals/[id]/click returns 302 redirect for burst click while flagging in database', async () => {
      const ip = '198.51.100.211';
      const session = 'sess-route-get';

      db.dealClicks.set('prior-get-click', {
        id: 'prior-get-click',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-route',
        session_id: session,
        ip_address: ip,
        created_at: new Date(Date.now() - 500).toISOString(),
      });

      const req = createFraudTestRequest('http://localhost:3000/api/deals/deal-active-1/click', {
        method: 'GET',
        headers: {
          'cf-connecting-ip': ip,
          cookie: `apex_tracking_id=${session}`,
        },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'GET',
        req,
        { id: 'deal-active-1' }
      );

      expect(res.status).toBe(302);

      const inserted = Array.from(db.dealClicks.values()).find(
        (c) => c.id !== 'prior-get-click' && c.ip_address === ip
      );
      expect(inserted).toBeDefined();
      expect(inserted?.is_suspicious).toBe(1);
      expect(inserted?.anomaly_score).toBe(0.90);
    });

    it('4.3 Matcher isolates suspicious clicks: zero commission attributed', async () => {
      const matcher = new Matcher(db as any);

      db.dealClicks.set('click-suspicious-flagged', {
        id: 'click-suspicious-flagged',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-fraudster',
        affiliate_id: 'usr-trader-1',
        session_id: 'sess-fraudster',
        ip_address: '198.51.100.220',
        user_agent: 'bot',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: JSON.stringify(['BURST_CLICK']),
        anomaly_score: 0.90,
        created_at: new Date().toISOString(),
      });

      const matchRes = await matcher.match({
        dealId: 'deal-active-1',
        userIdentifier: 'trader1@apex-os.com',
        tradeVolumeUsd: 5000,
      });

      expect(matchRes.click).toBeNull();
      expect(matchRes.totalCommission).toBe(0);
    });
  });
});
