/**
 * Milestone 5 Tier 5 Adversarial Coverage Hardening: Admin Fraud Dashboard, APIs & Audit Ledger
 * Location: src/__tests__/fraud/m5-tier5-adversarial-admin.test.ts
 *
 * Empirical white-box adversarial verification covering:
 * 1. Date range filtering:
 *    - Inverted ranges (dateFrom > dateTo), future dates, distant past dates.
 *    - Parameter aliases (startDate, endDate), exact timestamp boundary matches.
 *    - Invalid/malformed date formats and single-bounded queries.
 *
 * 2. Complex multi-keyword search queries:
 *    - SQL injection payloads (' OR 1=1 --, '; DROP TABLE..., UNION SELECT...).
 *    - Special characters, SQL wildcards (%, _, ', ", \, ;, <script>).
 *    - Unicode/emojis, case insensitivity, partial hash & ID searches.
 *    - Whitespace sanitization, blocked-ips search parameterization.
 *
 * 3. Extreme pagination & offsets boundary hardening:
 *    - Ultra-deep pagination (page 1000000 with 0 results).
 *    - Negative page numbers, zero page, non-numeric/NaN pages.
 *    - Negative limit, zero limit, excessive limit capping (capped at 100).
 *    - Decimal/float parameters, empty database zero-record state.
 *    - Multi-page boundary traversal.
 *
 * 4. Bulk action boundary limits & atomicity:
 *    - Massive batch chunking (110+ clicks crossing 45-statement D1 chunk threshold).
 *    - Mixed valid/invalid click IDs in batch resolution.
 *    - All invalid click IDs in bulk resolution (404 Not Found, zero db pollution).
 *    - Empty clickIds array (400 Bad Request).
 *    - Bulk rejection, single invalid click ID rejection.
 *    - Action validation boundaries (invalid action, short reason, whitespace reason).
 *
 * 5. Manual IP unblocking & block expiration lifecycle:
 *    - Dynamic expiration resolution (expires_at < now vs active).
 *    - activeOnly filtering in GET /api/admin/fraud/blocked-ips.
 *    - Telemetry stats activeBlockedIps calculation.
 *    - Manual unblock via DELETE (query param & JSON body with custom reason).
 *    - Manual unblock via POST (action: unblock).
 *    - Re-blocking previously unblocked IP address.
 *    - Validation for missing/invalid IP and malformed expiration.
 *
 * 6. Audit trail immutability stress under nested transactions:
 *    - Real SQLite engine (better-sqlite3) triggers aborting direct UPDATE operations.
 *    - Real SQLite engine triggers aborting direct DELETE operations.
 *    - Multi-level nested transactions (SAVEPOINTs) immutability enforcement.
 *    - MockFraudDatabase immutability trigger simulation.
 *    - Schema constraints and zero-pollution guarantees.
 *
 * 7. RBAC security guards:
 *    - Unauthenticated requests (401).
 *    - Authenticated non-admin requests (403).
 *    - Anti-backdoor header spoofing prevention.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import {
  setupFraudTestEnvironment,
  mockFraudDB,
  createFraudTestRequest,
  dispatchRoute,
  DealClickRow,
  BlockedIpRow,
} from './fraud-test-harness';
import { recordFraudDecision, EntityNotFoundError } from '@/lib/fraud/audit-logger';
import { FraudReasonCode } from '@/types/fraud';

describe('Milestone 5 Tier 5 Adversarial Hardening: Admin Fraud Dashboard, APIs & Audit Ledger', () => {
  const rootDir = process.cwd();
  const migration001Path = path.join(rootDir, 'src/database/migrations/001_initial_schema_d1.sql');
  const migration003Path = path.join(rootDir, 'src/database/migrations/003_affiliate_schema.sql');
  const migration021Path = path.join(rootDir, 'src/database/migrations/021_fraud_detection_schema.sql');

  let realSqliteDb: Database.Database;

  const initRealD1Database = (): Database.Database => {
    const memoryDb = new Database(':memory:');
    memoryDb.pragma('foreign_keys = ON');
    const sql001 = fs.readFileSync(migration001Path, 'utf8');
    const sql003 = fs.readFileSync(migration003Path, 'utf8');
    const sql021 = fs.readFileSync(migration021Path, 'utf8');
    memoryDb.exec(sql001);
    memoryDb.exec(sql003);
    memoryDb.exec(sql021);
    return memoryDb;
  };

  beforeAll(() => {
    setupFraudTestEnvironment();
  });

  beforeEach(() => {
    mockFraudDB.reset();
  });

  afterEach(() => {
    if (realSqliteDb) {
      realSqliteDb.close();
    }
  });

  // ==========================================================================
  // SECTION 1: Date Range Filtering & Temporal Boundary Analysis
  // ==========================================================================
  describe('1. Date Range Filtering & Temporal Boundary Analysis (GET /api/admin/fraud/clicks)', () => {
    beforeEach(() => {
      // Seed clicks across multiple months in 2026
      const clicksToSeed: Array<Partial<DealClickRow>> = [
        {
          id: 'click-jan-2026',
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-alpha',
          ip_address: '198.51.100.1',
          is_suspicious: 1,
          flag_reasons: JSON.stringify([FraudReasonCode.BURST_CLICK]),
          created_at: '2026-01-15T10:00:00.000Z',
          review_status: 'pending',
        },
        {
          id: 'click-feb-2026',
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-alpha',
          ip_address: '198.51.100.2',
          is_suspicious: 1,
          flag_reasons: JSON.stringify([FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO]),
          created_at: '2026-02-15T10:00:00.000Z',
          review_status: 'pending',
        },
        {
          id: 'click-mar-exact-1',
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-beta',
          ip_address: '198.51.100.3',
          is_suspicious: 1,
          flag_reasons: JSON.stringify([FraudReasonCode.BURST_CLICK]),
          created_at: '2026-03-15T12:00:00.000Z',
          review_status: 'pending',
        },
        {
          id: 'click-mar-exact-2',
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-beta',
          ip_address: '198.51.100.4',
          is_suspicious: 1,
          flag_reasons: JSON.stringify([FraudReasonCode.BURST_CLICK]),
          created_at: '2026-03-15T12:00:01.000Z',
          review_status: 'pending',
        },
        {
          id: 'click-apr-2026',
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-gamma',
          ip_address: '198.51.100.5',
          is_suspicious: 1,
          flag_reasons: JSON.stringify([FraudReasonCode.SUSPICIOUS_USER_AGENT]),
          created_at: '2026-04-20T10:00:00.000Z',
          review_status: 'pending',
        },
      ];

      for (const c of clicksToSeed) {
        mockFraudDB.dealClicks.set(c.id!, {
          session_id: 'sess-default',
          user_agent: 'Mozilla/5.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          anomaly_score: 0.8,
          reviewed_at: null,
          reviewed_by: null,
          ...c,
        } as DealClickRow);
      }
    });

    it('returns empty results without error for inverted date ranges (dateFrom > dateTo)', async () => {
      const req = createFraudTestRequest(
        '/api/admin/fraud/clicks?dateFrom=2026-04-01T00:00:00Z&dateTo=2026-02-01T00:00:00Z',
        { method: 'GET', admin: true }
      );

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toEqual([]);
      expect(res.data.pagination.total).toBe(0);
      expect(res.data.pagination.totalPages).toBe(1);
    });

    it('returns empty results when filtering by a distant future date (dateFrom=2099-01-01)', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?dateFrom=2099-01-01T00:00:00Z', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toEqual([]);
      expect(res.data.pagination.total).toBe(0);
    });

    it('returns empty results when filtering by a distant past date (dateTo=1970-01-01)', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?dateTo=1970-01-01T00:00:00Z', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toEqual([]);
      expect(res.data.pagination.total).toBe(0);
    });

    it('matches exact millisecond timestamp boundary inclusively (dateFrom = created_at = dateTo)', async () => {
      const targetTs = '2026-03-15T12:00:00.000Z';
      const req = createFraudTestRequest(
        `/api/admin/fraud/clicks?dateFrom=${encodeURIComponent(targetTs)}&dateTo=${encodeURIComponent(targetTs)}`,
        { method: 'GET', admin: true }
      );

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.pagination.total).toBe(1);
      expect(res.data.data).toHaveLength(1);
      expect(res.data.data[0].id).toBe('click-mar-exact-1');
      expect(res.data.data[0].createdAt).toBe(targetTs);
    });

    it('filters strictly within date range window and excludes records outside boundaries', async () => {
      const req = createFraudTestRequest(
        '/api/admin/fraud/clicks?dateFrom=2026-02-01T00:00:00Z&dateTo=2026-03-31T23:59:59Z',
        { method: 'GET', admin: true }
      );

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.pagination.total).toBe(3);
      const returnedIds = res.data.data.map((c: any) => c.id);
      expect(returnedIds).toContain('click-feb-2026');
      expect(returnedIds).toContain('click-mar-exact-1');
      expect(returnedIds).toContain('click-mar-exact-2');
      expect(returnedIds).not.toContain('click-jan-2026');
      expect(returnedIds).not.toContain('click-apr-2026');
    });

    it('supports startDate and endDate aliases seamlessly', async () => {
      const req = createFraudTestRequest(
        '/api/admin/fraud/clicks?startDate=2026-02-01T00:00:00Z&endDate=2026-03-31T23:59:59Z',
        { method: 'GET', admin: true }
      );

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.pagination.total).toBe(3);
      const returnedIds = res.data.data.map((c: any) => c.id);
      expect(returnedIds).toContain('click-feb-2026');
      expect(returnedIds).toContain('click-mar-exact-1');
      expect(returnedIds).toContain('click-mar-exact-2');
    });

    it('supports single-bounded lower date filter (dateFrom only)', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?dateFrom=2026-03-01T00:00:00Z', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.total).toBe(3); // mar-1, mar-2, apr
      const returnedIds = res.data.data.map((c: any) => c.id);
      expect(returnedIds).not.toContain('click-jan-2026');
      expect(returnedIds).not.toContain('click-feb-2026');
      expect(returnedIds).toContain('click-apr-2026');
    });

    it('supports single-bounded upper date filter (dateTo only)', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?dateTo=2026-02-28T23:59:59Z', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.total).toBe(2); // jan, feb
      const returnedIds = res.data.data.map((c: any) => c.id);
      expect(returnedIds).toContain('click-jan-2026');
      expect(returnedIds).toContain('click-feb-2026');
      expect(returnedIds).not.toContain('click-mar-exact-1');
      expect(returnedIds).not.toContain('click-apr-2026');
    });

    it('gracefully handles non-ISO and malformed date strings without 500 error', async () => {
      const req = createFraudTestRequest(
        '/api/admin/fraud/clicks?dateFrom=malformed_non_date_string&dateTo=gibberish',
        { method: 'GET', admin: true }
      );

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toEqual([]);
      expect(res.data.pagination.total).toBe(0);
    });
  });

  // ==========================================================================
  // SECTION 2: Complex Multi-Keyword Search Queries & Adversarial Injection Resistance
  // ==========================================================================
  describe('2. Complex Multi-Keyword Search Queries & SQL Injection Resistance', () => {
    beforeEach(() => {
      mockFraudDB.dealClicks.set('click-sec-001', {
        id: 'click-sec-001-a1b2c3d4',
        deal_id: 'deal-active-1',
        affiliate_code: 'AFF-MASTER-77',
        affiliate_id: 'usr-aff-1',
        session_id: 'sess-sec-1',
        ip_address: '198.51.100.88',
        user_agent: 'Mozilla/5.0 Chrome/120',
        referrer_url: 'https://crypto-review.com/apex',
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: JSON.stringify([FraudReasonCode.BURST_CLICK]),
        anomaly_score: 0.95,
        review_status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
        created_at: '2026-03-01T12:00:00Z',
      });

      mockFraudDB.dealClicks.set('click-sec-002', {
        id: 'click-sec-002-e5f6g7h8',
        deal_id: 'deal-active-1',
        affiliate_code: 'AFF-SPECIAL-ALERT',
        affiliate_id: 'usr-aff-2',
        session_id: 'sess-sec-2',
        ip_address: '203.0.113.99',
        user_agent: 'curl/7.68.0',
        referrer_url: null,
        country_code: 'VN',
        device_type: 'mobile',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: JSON.stringify([FraudReasonCode.SUSPICIOUS_USER_AGENT]),
        anomaly_score: 0.88,
        review_status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
        created_at: '2026-03-02T12:00:00Z',
      });
    });

    it('safely neutralizes classical SQL injection tautologies in clicks search without leaking data', async () => {
      const injectionPayloads = [
        "' OR 1=1 --",
        "'; DROP TABLE deal_clicks; --",
        "' UNION SELECT id, null, null, null FROM profiles --",
        '" OR ""="',
        "admin'--",
        "1' OR '1'='1",
      ];

      for (const payload of injectionPayloads) {
        const req = createFraudTestRequest(
          `/api/admin/fraud/clicks?search=${encodeURIComponent(payload)}`,
          { method: 'GET', admin: true }
        );

        const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
        // Tautology should NOT match all rows unless literal payload exists in ID/IP/Affiliate
        expect(res.data.data).toEqual([]);
        expect(res.data.pagination.total).toBe(0);
      }

      // Confirm database tables are not dropped or corrupted
      expect(mockFraudDB.dealClicks.size).toBeGreaterThanOrEqual(2);
    });

    it('safely handles special characters, wildcards, and script tags in search queries', async () => {
      const specialCharacters = [
        '%',
        '_',
        "'",
        '"',
        '\\',
        ';',
        '<script>alert("xss")</script>',
        '${7*7}',
        '{{constructor.constructor}}',
        'SELECT *',
      ];

      for (const char of specialCharacters) {
        const req = createFraudTestRequest(
          `/api/admin/fraud/clicks?search=${encodeURIComponent(char)}`,
          { method: 'GET', admin: true }
        );

        const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
        expect(Array.isArray(res.data.data)).toBe(true);
      }
    });

    it('handles unicode, foreign scripts, and emoji search queries without throwing', async () => {
      const unicodeQueries = ['🚨', '⚠️', '中文测试', '한국어', 'Русский', '🚀_fraud_test'];

      for (const uq of unicodeQueries) {
        const req = createFraudTestRequest(
          `/api/admin/fraud/clicks?search=${encodeURIComponent(uq)}`,
          { method: 'GET', admin: true }
        );

        const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
        expect(res.data.data).toEqual([]);
      }
    });

    it('matches partial hash and substring across ID, IP, and affiliate code', async () => {
      // 1. Match partial ID substring
      const reqId = createFraudTestRequest('/api/admin/fraud/clicks?search=a1b2c3d4', {
        method: 'GET',
        admin: true,
      });
      const resId = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', reqId);
      expect(resId.status).toBe(200);
      expect(resId.data.data).toHaveLength(1);
      expect(resId.data.data[0].id).toBe('click-sec-001-a1b2c3d4');

      // 2. Match partial IP address
      const reqIp = createFraudTestRequest('/api/admin/fraud/clicks?search=198.51.100', {
        method: 'GET',
        admin: true,
      });
      const resIp = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', reqIp);
      expect(resIp.status).toBe(200);
      expect(resIp.data.data).toHaveLength(1);
      expect(resIp.data.data[0].ipAddress).toBe('198.51.100.88');

      // 3. Match partial affiliate code
      const reqAff = createFraudTestRequest('/api/admin/fraud/clicks?search=MASTER-77', {
        method: 'GET',
        admin: true,
      });
      const resAff = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', reqAff);
      expect(resAff.status).toBe(200);
      expect(resAff.data.data).toHaveLength(1);
      expect(resAff.data.data[0].affiliateCode).toBe('AFF-MASTER-77');
    });

    it('performs case-insensitive search across affiliate code and IP address', async () => {
      // Lowercase search for uppercase affiliate code
      const req = createFraudTestRequest('/api/admin/fraud/clicks?search=aff-master', {
        method: 'GET',
        admin: true,
      });
      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.data).toHaveLength(1);
      expect(res.data.data[0].affiliateCode).toBe('AFF-MASTER-77');
    });

    it('ignores whitespace-only search query and returns full dataset', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?search=%20%20%20%20', {
        method: 'GET',
        admin: true,
      });
      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.total).toBe(2);
      expect(res.data.data).toHaveLength(2);
    });

    it('neutralizes SQL injection attempts in GET /api/admin/fraud/blocked-ips search', async () => {
      mockFraudDB.blockedIps.set('198.51.100.99', {
        id: 'block-sec-1',
        ip_address: '198.51.100.99',
        reason: 'SQL injection attack detected from scanner',
        blocked_by: 'usr-admin-1',
        blocked_at: '2026-03-01T00:00:00Z',
        expires_at: null,
        is_active: 1,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      });

      const req = createFraudTestRequest(
        '/api/admin/fraud/blocked-ips?search=' + encodeURIComponent("' OR 1=1 --"),
        { method: 'GET', admin: true }
      );
      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toEqual([]);
      expect(res.data.pagination.total).toBe(0);

      // Honest substring search works
      const honestReq = createFraudTestRequest('/api/admin/fraud/blocked-ips?search=scanner', {
        method: 'GET',
        admin: true,
      });
      const honestRes = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'GET', honestReq);
      expect(honestRes.status).toBe(200);
      expect(honestRes.data.data).toHaveLength(1);
      expect(honestRes.data.data[0].ipAddress).toBe('198.51.100.99');
    });
  });

  // ==========================================================================
  // SECTION 3: Extreme Pagination & Offsets Boundary Hardening
  // ==========================================================================
  describe('3. Extreme Pagination & Offsets Boundary Hardening', () => {
    beforeEach(() => {
      // Seed 25 clicks to verify pagination boundaries
      for (let i = 1; i <= 25; i++) {
        const id = `click-pag-${String(i).padStart(3, '0')}`;
        mockFraudDB.dealClicks.set(id, {
          id,
          deal_id: 'deal-active-1',
          affiliate_code: `AFF-${i}`,
          affiliate_id: `usr-aff-${i}`,
          session_id: `sess-${i}`,
          ip_address: `198.51.100.${i}`,
          user_agent: 'Mozilla/5.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          is_suspicious: 1,
          flag_reasons: JSON.stringify([FraudReasonCode.BURST_CLICK]),
          anomaly_score: 0.75,
          review_status: 'pending',
          reviewed_at: null,
          reviewed_by: null,
          created_at: `2026-03-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
        });
      }
    });

    it('returns empty array gracefully on extreme page index (page=1000000) without crashing', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?page=1000000&limit=20', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toEqual([]);
      expect(res.data.pagination.page).toBe(1000000);
      expect(res.data.pagination.limit).toBe(20);
      expect(res.data.pagination.total).toBe(25);
      expect(res.data.pagination.totalPages).toBe(2);
    });

    it('sanitizes negative page numbers to page 1', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?page=-5&limit=10', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.page).toBe(1);
      expect(res.data.data).toHaveLength(10);
    });

    it('sanitizes page=0 to page 1', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?page=0&limit=10', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.page).toBe(1);
      expect(res.data.data).toHaveLength(10);
    });

    it('sanitizes non-numeric and NaN page parameters to page 1', async () => {
      const nonNumericPages = ['invalid_page', 'NaN', 'null', 'undefined', 'true', '[object Object]'];

      for (const p of nonNumericPages) {
        const req = createFraudTestRequest(`/api/admin/fraud/clicks?page=${p}&limit=5`, {
          method: 'GET',
          admin: true,
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.page).toBe(1);
        expect(res.data.data).toHaveLength(5);
      }
    });

    it('sanitizes negative and zero limits to default limit (20)', async () => {
      const zeroReq = createFraudTestRequest('/api/admin/fraud/clicks?limit=0', {
        method: 'GET',
        admin: true,
      });
      const zeroRes = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', zeroReq);
      expect(zeroRes.status).toBe(200);
      expect(zeroRes.data.pagination.limit).toBe(20);

      const negReq = createFraudTestRequest('/api/admin/fraud/clicks?limit=-99', {
        method: 'GET',
        admin: true,
      });
      const negRes = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', negReq);
      expect(negRes.status).toBe(200);
      expect(negRes.data.pagination.limit).toBe(20);
    });

    it('strictly caps excessive limits (limit=1000000) to max limit of 100', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?limit=1000000', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.limit).toBe(100);
    });

    it('handles decimal and float pagination parameters safely', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?page=2.8&limit=5.9', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.page).toBe(2);
      expect(res.data.pagination.limit).toBe(5);
      expect(res.data.data).toHaveLength(5);
    });

    it('accurately traverses multi-page datasets without off-by-one gaps or overlaps', async () => {
      // 25 clicks, limit 10: Page 1 (10), Page 2 (10), Page 3 (5), Page 4 (0)
      const p1Req = createFraudTestRequest('/api/admin/fraud/clicks?page=1&limit=10', { method: 'GET', admin: true });
      const p1Res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', p1Req);
      expect(p1Res.data.data).toHaveLength(10);

      const p2Req = createFraudTestRequest('/api/admin/fraud/clicks?page=2&limit=10', { method: 'GET', admin: true });
      const p2Res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', p2Req);
      expect(p2Res.data.data).toHaveLength(10);

      const p3Req = createFraudTestRequest('/api/admin/fraud/clicks?page=3&limit=10', { method: 'GET', admin: true });
      const p3Res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', p3Req);
      expect(p3Res.data.data).toHaveLength(5);

      const p4Req = createFraudTestRequest('/api/admin/fraud/clicks?page=4&limit=10', { method: 'GET', admin: true });
      const p4Res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', p4Req);
      expect(p4Res.data.data).toHaveLength(0);
      expect(p4Res.data.pagination.totalPages).toBe(3);

      // Verify no ID overlap between Page 1 and Page 2
      const ids1 = new Set(p1Res.data.data.map((c: any) => c.id));
      const ids2 = new Set(p2Res.data.data.map((c: any) => c.id));
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }
    });

    it('returns totalPages = 1 and data = [] when database has zero records', async () => {
      mockFraudDB.dealClicks.clear();

      const req = createFraudTestRequest('/api/admin/fraud/clicks', { method: 'GET', admin: true });
      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toEqual([]);
      expect(res.data.pagination.total).toBe(0);
      expect(res.data.pagination.totalPages).toBe(1);
    });

    it('handles extreme pagination on GET /api/admin/fraud/blocked-ips (page=1000000, limit=999999)', async () => {
      for (let i = 1; i <= 10; i++) {
        mockFraudDB.blockedIps.set(`198.51.100.${i}`, {
          id: `blk-${i}`,
          ip_address: `198.51.100.${i}`,
          reason: `Test block ${i}`,
          blocked_by: 'usr-admin-1',
          blocked_at: '2026-03-01T00:00:00Z',
          expires_at: null,
          is_active: 1,
          created_at: '2026-03-01T00:00:00Z',
          updated_at: '2026-03-01T00:00:00Z',
        });
      }

      const req = createFraudTestRequest('/api/admin/fraud/blocked-ips?page=1000000&limit=999999', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.limit).toBe(100); // capped at 100
      expect(res.data.pagination.total).toBe(10);
      expect(res.data.data).toEqual([]);
    });
  });

  // ==========================================================================
  // SECTION 4: Bulk Action Boundary Limits & Atomicity
  // ==========================================================================
  describe('4. Bulk Action Boundary Limits & Atomicity (POST /api/admin/fraud/actions)', () => {
    it('executes massive bulk resolution (110 clicks) chunking across 45-statement D1 threshold', async () => {
      // Seed 110 suspicious clicks
      const clickIds: string[] = [];
      for (let i = 1; i <= 110; i++) {
        const id = `bulk-chunk-click-${String(i).padStart(3, '0')}`;
        clickIds.push(id);
        mockFraudDB.dealClicks.set(id, {
          id,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-bulk',
          affiliate_id: 'usr-aff-1',
          session_id: `sess-${i}`,
          ip_address: `198.51.100.${(i % 250) + 1}`,
          user_agent: 'Mozilla/5.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          is_suspicious: 1,
          flag_reasons: JSON.stringify([FraudReasonCode.BURST_CLICK]),
          anomaly_score: 0.9,
          review_status: 'pending',
          reviewed_at: null,
          reviewed_by: null,
          created_at: '2026-03-01T00:00:00Z',
        });
      }

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'bulk_resolve',
          resolution: 'approve',
          clickIds,
          reason: 'Massive batch verified genuine promotions',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.affectedCount).toBe(110);
      expect(res.data.auditIds).toHaveLength(110);

      // Confirm all 110 clicks are updated
      for (const id of clickIds) {
        const row = mockFraudDB.dealClicks.get(id);
        expect(row?.is_suspicious).toBe(0);
        expect(row?.review_status).toBe('approved');
      }

      // Confirm exactly 110 audit records in fraud_reviews
      expect(mockFraudDB.fraudReviews.size).toBe(110);
      for (const auditId of res.data.auditIds) {
        expect(mockFraudDB.fraudReviews.has(auditId)).toBe(true);
      }
    });

    it('executes massive bulk rejection (100 clicks) updating suspicion to 1 and review_status to rejected', async () => {
      const clickIds: string[] = [];
      for (let i = 1; i <= 100; i++) {
        const id = `bulk-rej-click-${String(i).padStart(3, '0')}`;
        clickIds.push(id);
        mockFraudDB.dealClicks.set(id, {
          id,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-bulk-rej',
          affiliate_id: 'usr-aff-1',
          session_id: `sess-${i}`,
          ip_address: `198.51.100.${(i % 250) + 1}`,
          user_agent: 'curl/7.68.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          is_suspicious: 1,
          flag_reasons: JSON.stringify([FraudReasonCode.BURST_CLICK]),
          anomaly_score: 0.95,
          review_status: 'pending',
          reviewed_at: null,
          reviewed_by: null,
          created_at: '2026-03-01T00:00:00Z',
        });
      }

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'bulk_resolve',
          resolution: 'reject',
          clickIds,
          reason: 'Massive bot attack confirmed and rejected',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.affectedCount).toBe(100);

      for (const id of clickIds) {
        const row = mockFraudDB.dealClicks.get(id);
        expect(row?.is_suspicious).toBe(1);
        expect(row?.review_status).toBe('rejected');
      }
      expect(mockFraudDB.fraudReviews.size).toBe(100);
    });

    it('gracefully handles mixed valid and invalid click IDs by resolving only valid entities', async () => {
      // Seed 4 genuine clicks
      const validIds = ['c-mixed-1', 'c-mixed-2', 'c-mixed-3', 'c-mixed-4'];
      for (const id of validIds) {
        mockFraudDB.dealClicks.set(id, {
          id,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-mixed',
          affiliate_id: 'usr-aff-1',
          session_id: 'sess-mixed',
          ip_address: '198.51.100.50',
          user_agent: 'Mozilla/5.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          is_suspicious: 1,
          flag_reasons: JSON.stringify([FraudReasonCode.BURST_CLICK]),
          anomaly_score: 0.85,
          review_status: 'pending',
          reviewed_at: null,
          reviewed_by: null,
          created_at: '2026-03-01T00:00:00Z',
        });
      }

      const nonExistentIds = ['c-fake-101', 'c-fake-102', 'c-fake-103', 'c-fake-104', 'c-fake-105', 'c-fake-106'];
      const mixedBatch = [...validIds, ...nonExistentIds];

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'bulk_resolve',
          resolution: 'approve',
          clickIds: mixedBatch,
          reason: 'Partial batch resolution with invalid entities present',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.affectedCount).toBe(4);
      expect(res.data.auditIds).toHaveLength(4);

      // Verify the 4 valid clicks were updated
      for (const id of validIds) {
        const row = mockFraudDB.dealClicks.get(id);
        expect(row?.review_status).toBe('approved');
      }

      // Verify 0 audit records were created for non-existent clicks
      expect(mockFraudDB.fraudReviews.size).toBe(4);
    });

    it('returns 404 Not Found and writes zero audit logs when bulk resolving purely non-existent click IDs', async () => {
      const nonExistentIds = ['c-ghost-1', 'c-ghost-2', 'c-ghost-3'];

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'bulk_resolve',
          resolution: 'approve',
          clickIds: nonExistentIds,
          reason: 'Non-existent clicks batch',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/no matching clicks found|not found/i);
      expect(mockFraudDB.fraudReviews.size).toBe(0);
    });

    it('returns 400 Bad Request when bulk resolve is called with an empty clickIds array', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'bulk_resolve',
          resolution: 'approve',
          clickIds: [],
          reason: 'Empty array test',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/clickIds array is required/i);
      expect(mockFraudDB.fraudReviews.size).toBe(0);
    });

    it('returns 404 Not Found when executing single click approve or reject on non-existent ID', async () => {
      const approveReq = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: 'click-does-not-exist',
          reason: 'Approving non-existent entity',
        },
      });

      const approveRes = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', approveReq);
      expect(approveRes.status).toBe(404);
      expect(approveRes.data.success).toBe(false);
      expect(mockFraudDB.fraudReviews.size).toBe(0);

      const rejectReq = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'reject',
          clickId: 'click-does-not-exist',
          reason: 'Rejecting non-existent entity',
        },
      });

      const rejectRes = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', rejectReq);
      expect(rejectRes.status).toBe(404);
      expect(rejectRes.data.success).toBe(false);
      expect(mockFraudDB.fraudReviews.size).toBe(0);
    });

    it('rejects invalid action types with 400 Bad Request', async () => {
      const invalidActions = ['purge', 'delete', 'bypass', 'drop_database', '', '   '];

      for (const badAction of invalidActions) {
        const req = createFraudTestRequest('/api/admin/fraud/actions', {
          method: 'POST',
          admin: true,
          body: {
            action: badAction,
            clickId: 'c1',
            reason: 'Valid test reason',
          },
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
        expect(res.data.error).toMatch(/invalid review action/i);
      }
    });

    it('rejects invalid, whitespace, and short reasons (<3 chars) with 400 Bad Request', async () => {
      const invalidReasons = ['a', 'ok', '  ', '   hi  ', '', null, 12345, {}];

      for (const badReason of invalidReasons) {
        const req = createFraudTestRequest('/api/admin/fraud/actions', {
          method: 'POST',
          admin: true,
          body: {
            action: 'approve',
            clickId: 'click-s1',
            reason: badReason,
          },
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
        expect(res.data.error).toMatch(/reason must be at least 3 characters/i);
      }
    });
  });

  // ==========================================================================
  // SECTION 5: Manual IP Unblocking and Block Expiration Lifecycle
  // ==========================================================================
  describe('5. Manual IP Unblocking and Block Expiration Lifecycle (expires_at < now)', () => {
    const now = Date.now();
    const oneHourMs = 3600 * 1000;

    beforeEach(() => {
      // Seed 4 IPs representing the full lifecycle:
      // 1. Active with future expiration
      mockFraudDB.blockedIps.set('198.51.100.11', {
        id: 'blk-exp-future',
        ip_address: '198.51.100.11',
        reason: 'Temporary rate limit block',
        blocked_by: 'usr-admin-1',
        blocked_at: new Date(now - oneHourMs).toISOString(),
        expires_at: new Date(now + oneHourMs).toISOString(),
        is_active: 1,
        created_at: new Date(now - oneHourMs).toISOString(),
        updated_at: new Date(now - oneHourMs).toISOString(),
      });

      // 2. Expired block (expires_at in past)
      mockFraudDB.blockedIps.set('198.51.100.22', {
        id: 'blk-exp-past',
        ip_address: '198.51.100.22',
        reason: 'Expired burst block',
        blocked_by: 'usr-admin-1',
        blocked_at: new Date(now - 2 * oneHourMs).toISOString(),
        expires_at: new Date(now - oneHourMs).toISOString(),
        is_active: 1,
        created_at: new Date(now - 2 * oneHourMs).toISOString(),
        updated_at: new Date(now - 2 * oneHourMs).toISOString(),
      });

      // 3. Permanent block (expires_at is null)
      mockFraudDB.blockedIps.set('198.51.100.33', {
        id: 'blk-perm',
        ip_address: '198.51.100.33',
        reason: 'Permanent manual blacklist',
        blocked_by: 'usr-admin-1',
        blocked_at: new Date(now - 3 * oneHourMs).toISOString(),
        expires_at: null,
        is_active: 1,
        created_at: new Date(now - 3 * oneHourMs).toISOString(),
        updated_at: new Date(now - 3 * oneHourMs).toISOString(),
      });

      // 4. Manually deactivated block (is_active = 0)
      mockFraudDB.blockedIps.set('198.51.100.44', {
        id: 'blk-deactivated',
        ip_address: '198.51.100.44',
        reason: 'Deactivated block record',
        blocked_by: 'usr-admin-1',
        blocked_at: new Date(now - 4 * oneHourMs).toISOString(),
        expires_at: null,
        is_active: 0,
        created_at: new Date(now - 4 * oneHourMs).toISOString(),
        updated_at: new Date(now - 4 * oneHourMs).toISOString(),
      });
    });

    it('filters out expired and inactive blocks when activeOnly=true', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/blocked-ips?activeOnly=true', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.pagination.total).toBe(2);

      const returnedIps = res.data.data.map((b: any) => b.ipAddress);
      expect(returnedIps).toContain('198.51.100.11'); // future expiration
      expect(returnedIps).toContain('198.51.100.33'); // permanent
      expect(returnedIps).not.toContain('198.51.100.22'); // expired
      expect(returnedIps).not.toContain('198.51.100.44'); // inactive
    });

    it('returns all blocks and dynamically marks expired entries as isActive=false when activeOnly=false', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/blocked-ips?activeOnly=false', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.total).toBe(4);

      const itemExpired = res.data.data.find((b: any) => b.ipAddress === '198.51.100.22');
      expect(itemExpired).toBeDefined();
      expect(itemExpired.isActive).toBe(false); // dynamically resolved because expires_at <= now

      const itemFuture = res.data.data.find((b: any) => b.ipAddress === '198.51.100.11');
      expect(itemFuture.isActive).toBe(true);

      const itemPermanent = res.data.data.find((b: any) => b.ipAddress === '198.51.100.33');
      expect(itemPermanent.isActive).toBe(true);
    });

    it('computes real-time telemetry activeBlockedIps excluding expired entries in GET /api/admin/fraud/stats', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/stats', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/stats/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.totalBlockedIps).toBe(4);
      expect(res.data.data.activeBlockedIps).toBe(2); // only 198.51.100.11 and 198.51.100.33
    });

    it('manually unblocks an IP via DELETE /api/admin/fraud/blocked-ips using query param', async () => {
      const req = createFraudTestRequest(
        '/api/admin/fraud/blocked-ips?ip=198.51.100.11&reason=Admin%20unblock%20query%20test',
        { method: 'DELETE', admin: true }
      );

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'DELETE', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.unblocked).toBe(true);

      // Verify deletion from blocked_ips
      expect(mockFraudDB.blockedIps.has('198.51.100.11')).toBe(false);

      // Verify immutable audit log record created
      expect(mockFraudDB.fraudReviews.size).toBe(1);
      const auditLog = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(auditLog.action).toBe('unblock_ip');
      expect(auditLog.ip_address).toBe('198.51.100.11');
      expect(auditLog.reason).toBe('Admin unblock query test');
    });

    it('manually unblocks an IP via DELETE /api/admin/fraud/blocked-ips using JSON body', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/blocked-ips', {
        method: 'DELETE',
        admin: true,
        body: {
          ipAddress: '198.51.100.33',
          reason: 'Manual unblock via JSON body payload',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'DELETE', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(mockFraudDB.blockedIps.has('198.51.100.33')).toBe(false);

      const auditLog = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(auditLog.action).toBe('unblock_ip');
      expect(auditLog.reason).toBe('Manual unblock via JSON body payload');
    });

    it('manually unblocks an IP via POST /api/admin/fraud/blocked-ips with action: unblock', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/blocked-ips', {
        method: 'POST',
        admin: true,
        body: {
          ip: '198.51.100.22',
          action: 'unblock',
          reason: 'Unblocking expired entry explicitly',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(mockFraudDB.blockedIps.has('198.51.100.22')).toBe(false);

      const auditLog = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(auditLog.action).toBe('unblock_ip');
      expect(auditLog.ip_address).toBe('198.51.100.22');
    });

    it('re-blocks a previously unblocked IP address and logs a new audit event', async () => {
      // 1. Unblock
      const unblockReq = createFraudTestRequest('/api/admin/fraud/blocked-ips?ip=198.51.100.11', {
        method: 'DELETE',
        admin: true,
      });
      await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'DELETE', unblockReq);
      expect(mockFraudDB.blockedIps.has('198.51.100.11')).toBe(false);

      // 2. Re-block with new reason and expiration
      const reblockReq = createFraudTestRequest('/api/admin/fraud/blocked-ips', {
        method: 'POST',
        admin: true,
        body: {
          ip: '198.51.100.11',
          action: 'block',
          reason: 'Re-blocked due to recurring abuse burst',
          expiresAt: new Date(now + 24 * oneHourMs).toISOString(),
        },
      });

      const reblockRes = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'POST', reblockReq);
      expect(reblockRes.status).toBe(200);
      expect(reblockRes.data.success).toBe(true);
      expect(mockFraudDB.blockedIps.has('198.51.100.11')).toBe(true);

      const reblockedEntry = mockFraudDB.blockedIps.get('198.51.100.11');
      expect(reblockedEntry?.is_active).toBe(1);
      expect(reblockedEntry?.reason).toBe('Re-blocked due to recurring abuse burst');

      // Both unblock and re-block are logged immutably
      expect(mockFraudDB.fraudReviews.size).toBe(2);
      const auditActions = Array.from(mockFraudDB.fraudReviews.values()).map((r) => r.action);
      expect(auditActions).toContain('unblock_ip');
      expect(auditActions).toContain('block_ip');
    });

    it('rejects POST and DELETE requests missing IP address with 400 Bad Request', async () => {
      const postReq = createFraudTestRequest('/api/admin/fraud/blocked-ips', {
        method: 'POST',
        admin: true,
        body: { reason: 'Missing IP' },
      });
      const postRes = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'POST', postReq);
      expect(postRes.status).toBe(400);
      expect(postRes.data.error).toMatch(/IP address is required/i);

      const delReq = createFraudTestRequest('/api/admin/fraud/blocked-ips', {
        method: 'DELETE',
        admin: true,
      });
      const delRes = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'DELETE', delReq);
      expect(delRes.status).toBe(400);
      expect(delRes.data.error).toMatch(/IP address is required/i);
    });
  });

  // ==========================================================================
  // SECTION 6: Audit Trail Immutability Stress Under Nested Transactions
  // ==========================================================================
  describe('6. Audit Trail Immutability Stress Under Nested Transactions (Feature F12)', () => {
    beforeEach(() => {
      realSqliteDb = initRealD1Database();

      // Seed baseline record in real SQLite database
      realSqliteDb
        .prepare(`
          INSERT INTO fraud_reviews (
            id, click_id, ip_address, reviewer_id, reviewed_by, action, reason, reviewed_at, created_at, details
          ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
        `)
        .run(
          'rev-adv-001',
          'click-target-001',
          '198.51.100.25',
          'usr-admin-1',
          'admin@apex-os.com',
          'reject',
          'Automated burst anomaly detected',
          JSON.stringify({ score: 0.94, code: 'BURST_CLICK' })
        );
    });

    it('strictly aborts direct UPDATE on fraud_reviews columns via SQLite BEFORE UPDATE trigger', () => {
      const updateAttempts = [
        { sql: 'UPDATE fraud_reviews SET reason = ? WHERE id = ?', params: ['Tampered reason', 'rev-adv-001'] },
        { sql: 'UPDATE fraud_reviews SET action = ? WHERE id = ?', params: ['approve', 'rev-adv-001'] },
        { sql: 'UPDATE fraud_reviews SET reviewer_id = ? WHERE id = ?', params: ['usr-hacker', 'rev-adv-001'] },
        { sql: 'UPDATE fraud_reviews SET details = ? WHERE id = ?', params: ['{}', 'rev-adv-001'] },
        { sql: 'UPDATE fraud_reviews SET reviewed_at = ? WHERE id = ?', params: ['2000-01-01', 'rev-adv-001'] },
        { sql: 'UPDATE fraud_reviews SET id = ? WHERE id = ?', params: ['rev-hacked', 'rev-adv-001'] },
      ];

      for (const attempt of updateAttempts) {
        expect(() => {
          realSqliteDb.prepare(attempt.sql).run(...attempt.params);
        }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);
      }

      // Verify data remains untouched
      const original = realSqliteDb.prepare('SELECT * FROM fraud_reviews WHERE id = ?').get('rev-adv-001') as any;
      expect(original.reason).toBe('Automated burst anomaly detected');
      expect(original.action).toBe('reject');
      expect(original.reviewer_id).toBe('usr-admin-1');
    });

    it('strictly aborts targeted and blanket DELETE operations via SQLite BEFORE DELETE trigger', () => {
      // 1. Targeted DELETE
      expect(() => {
        realSqliteDb.prepare('DELETE FROM fraud_reviews WHERE id = ?').run('rev-adv-001');
      }).toThrow(/fraud_reviews audit log is immutable: DELETE operations are prohibited/i);

      // 2. Blanket DELETE
      expect(() => {
        realSqliteDb.prepare('DELETE FROM fraud_reviews').run();
      }).toThrow(/fraud_reviews audit log is immutable: DELETE operations are prohibited/i);

      // 3. Subquery DELETE
      expect(() => {
        realSqliteDb
          .prepare('DELETE FROM fraud_reviews WHERE id IN (SELECT id FROM fraud_reviews)')
          .run();
      }).toThrow(/fraud_reviews audit log is immutable: DELETE operations are prohibited/i);

      // Confirm row was not removed
      const rowCount = realSqliteDb.prepare('SELECT COUNT(*) as count FROM fraud_reviews').get() as { count: number };
      expect(rowCount.count).toBe(1);
    });

    it('enforces immutability triggers under multi-level nested transactions (SAVEPOINTs)', () => {
      // 1. Outer transaction
      realSqliteDb.exec('SAVEPOINT sp_outer');

      realSqliteDb
        .prepare(`
          INSERT INTO fraud_reviews (id, action, reason) VALUES (?, ?, ?)
        `)
        .run('rev-adv-002', 'approve', 'Valid audit in outer savepoint');

      // 2. Inner nested transaction
      realSqliteDb.exec('SAVEPOINT sp_inner');

      realSqliteDb
        .prepare(`
          INSERT INTO fraud_reviews (id, action, reason) VALUES (?, ?, ?)
        `)
        .run('rev-adv-003', 'reject', 'Valid audit in inner savepoint');

      // 3. Attempt illegal UPDATE in inner savepoint -> Trigger aborts
      expect(() => {
        realSqliteDb
          .prepare('UPDATE fraud_reviews SET reason = ? WHERE id = ?')
          .run('Tampered in inner', 'rev-adv-002');
      }).toThrow(/immutable: UPDATE operations are prohibited/i);

      // Rollback to inner savepoint preserves prior work
      realSqliteDb.exec('ROLLBACK TO sp_inner');

      // 4. Attempt illegal DELETE in outer savepoint -> Trigger aborts
      expect(() => {
        realSqliteDb
          .prepare('DELETE FROM fraud_reviews WHERE id = ?')
          .run('rev-adv-001');
      }).toThrow(/immutable: DELETE operations are prohibited/i);

      // Commit outer savepoint
      realSqliteDb.exec('RELEASE sp_outer');

      // Verify rev-adv-001 and rev-adv-002 are intact; rev-adv-001 reason is unchanged
      const r1 = realSqliteDb.prepare('SELECT reason FROM fraud_reviews WHERE id = ?').get('rev-adv-001') as any;
      const r2 = realSqliteDb.prepare('SELECT reason FROM fraud_reviews WHERE id = ?').get('rev-adv-002') as any;

      expect(r1.reason).toBe('Automated burst anomaly detected');
      expect(r2.reason).toBe('Valid audit in outer savepoint');
    });

    it('enforces immutability simulation in MockFraudDatabase', async () => {
      await expect(
        mockFraudDB.prepare('UPDATE fraud_reviews SET reason = ? WHERE id = ?').bind('tampered', 'rev-1').run()
      ).rejects.toThrow(/immutable/i);

      await expect(
        mockFraudDB.prepare('DELETE FROM fraud_reviews WHERE id = ?').bind('rev-1').run()
      ).rejects.toThrow(/immutable/i);
    });

    it('enforces NOT NULL constraints on fraud_reviews (action and reason are required)', () => {
      expect(() => {
        realSqliteDb.prepare('INSERT INTO fraud_reviews (id, action) VALUES (?, ?)').run('bad-1', 'approve');
      }).toThrow(/NOT NULL constraint failed: fraud_reviews.reason/i);

      expect(() => {
        realSqliteDb.prepare('INSERT INTO fraud_reviews (id, reason) VALUES (?, ?)').run('bad-2', 'Valid reason');
      }).toThrow(/NOT NULL constraint failed: fraud_reviews.action/i);
    });
  });

  // ==========================================================================
  // SECTION 7: RBAC & Authentication Hardening Verification
  // ==========================================================================
  describe('7. RBAC & Anti-Backdoor Security Hardening', () => {
    const fraudEndpoints: Array<{
      name: string;
      route: string;
      method: 'GET' | 'POST' | 'DELETE';
      body?: any;
    }> = [
      {
        name: 'GET /api/admin/fraud/clicks',
        route: 'src/app/api/admin/fraud/clicks/route.ts',
        method: 'GET',
      },
      {
        name: 'GET /api/admin/fraud/stats',
        route: 'src/app/api/admin/fraud/stats/route.ts',
        method: 'GET',
      },
      {
        name: 'POST /api/admin/fraud/actions',
        route: 'src/app/api/admin/fraud/actions/route.ts',
        method: 'POST',
        body: { action: 'approve', clickId: 'c1', reason: 'RBAC test reason' },
      },
      {
        name: 'GET /api/admin/fraud/blocked-ips',
        route: 'src/app/api/admin/fraud/blocked-ips/route.ts',
        method: 'GET',
      },
      {
        name: 'POST /api/admin/fraud/blocked-ips',
        route: 'src/app/api/admin/fraud/blocked-ips/route.ts',
        method: 'POST',
        body: { ipAddress: '198.51.100.42', reason: 'RBAC test reason' },
      },
      {
        name: 'DELETE /api/admin/fraud/blocked-ips',
        route: 'src/app/api/admin/fraud/blocked-ips/route.ts',
        method: 'DELETE',
        body: { ipAddress: '198.51.100.42', reason: 'RBAC test reason' },
      },
    ];

    fraudEndpoints.forEach(({ name, route, method, body }) => {
      it(`strictly denies unauthenticated request on ${name} with 401 Unauthorized`, async () => {
        const req = createFraudTestRequest(name.split(' ')[1], {
          method,
          admin: false,
          body,
        });

        const res = await dispatchRoute(route, method, req);
        expect(res.status).toBe(401);
        expect(res.data.success).toBe(false);
        expect(res.data.error).toMatch(/unauthorized|session required/i);
      });

      it(`strictly denies authenticated non-admin request on ${name} with 403 Forbidden`, async () => {
        const req = createFraudTestRequest(name.split(' ')[1], {
          method,
          affiliate: true,
          body,
        });

        const res = await dispatchRoute(route, method, req);
        expect(res.status).toBe(403);
        expect(res.data.success).toBe(false);
        expect(res.data.error).toMatch(/forbidden|admin privileges required/i);
      });

      it(`strictly denies requests with spoofed admin headers on ${name} with 401/403`, async () => {
        const req = createFraudTestRequest(name.split(' ')[1], {
          method,
          admin: false,
          headers: {
            'x-test-admin': 'true',
            'x-admin': '1',
            'x-role': 'admin',
          },
          body,
        });

        const res = await dispatchRoute(route, method, req);
        expect([401, 403]).toContain(res.status);
        expect(res.data.success).toBe(false);
      });
    });
  });
});
