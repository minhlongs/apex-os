/**
 * Milestone 1 Challenger Stress Test Suite
 * Location: src/__tests__/fraud/challenger-m1-stress.test.ts
 *
 * Adversarial challenge and empirical stress-testing for:
 * 1. MockFraudDatabase edge cases: boundary parameter binding, empty strings, nulls, SQL injection strings
 * 2. MockFraudDatabase batch operations and rollback simulation
 * 3. src/types/fraud.ts serialization roundtrips, guards, and schemas
 */

import {
  MockFraudDatabase,
  MockDealClickRow,
  MockBlockedIpRow,
  MockFraudReviewRow,
} from './fraud-test-harness';
import {
  FraudReasonCode,
  FRAUD_REASON_CODES,
  ReasonCode,
  isFraudReasonCode,
  serializeReasons,
  parseReasons,
  serializeMetadata,
  parseMetadata,
  FraudReasonCodeSchema,
  FraudReviewActionSchema,
  ClickReviewStatusSchema,
  AdminFraudActionSchema,
  CreateBlockedIpSchema,
  AdminFraudActionRequest,
} from '@/types/fraud';

describe('Challenger M1 Stress: MockFraudDatabase Adversarial Tests', () => {
  let db: MockFraudDatabase;

  beforeEach(() => {
    db = new MockFraudDatabase();
  });

  describe('1. Boundary Parameter Binding, Empty Strings, Nulls, & SQL Injection', () => {
    it('1.1 handles null and undefined parameters in deal_clicks insertion', async () => {
      await db
        .prepare(`
          INSERT INTO deal_clicks (
            id, deal_id, session_id, ip_address, affiliate_code, affiliate_id,
            referrer_url, country_code, device_type, is_suspicious, flag_reasons, anomaly_score
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          'click-boundary-null',
          'deal-active-1',
          'sess-boundary',
          null,
          null,
          null,
          null,
          null,
          null,
          0,
          null,
          null
        )
        .run();

      const click = db.dealClicks.get('click-boundary-null');
      expect(click).toBeDefined();
      expect(click?.ip_address).toBeNull();
      expect(click?.affiliate_code).toBeNull();
      expect(click?.flag_reasons).toBeNull();
      expect(click?.anomaly_score).toBeNull();
    });

    it('1.2 handles empty strings in IP, session_id, reason, and deal_id', async () => {
      // Empty IP click insertion
      await db
        .prepare(`
          INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, is_suspicious, flag_reasons)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind('click-empty-ip', '', '', '', 1, '[]')
        .run();

      const click = db.dealClicks.get('click-empty-ip');
      expect(click).toBeDefined();
      expect(click?.ip_address).toBe('');
      expect(click?.deal_id).toBe('');
      expect(click?.session_id).toBe('');

      // Query by empty string IP
      const { results: emptyIpResults } = await db
        .prepare('SELECT * FROM deal_clicks WHERE ip_address = ?')
        .bind('')
        .all<MockDealClickRow>();

      expect(emptyIpResults.length).toBe(1);
      expect(emptyIpResults[0].id).toBe('click-empty-ip');

      // Empty IP blocked_ips insertion and lookup
      await db
        .prepare('INSERT INTO blocked_ips (id, ip_address, reason, blocked_by) VALUES (?, ?, ?, ?)')
        .bind('b-empty', '', '', '')
        .run();

      const blockedEmpty = await db
        .prepare('SELECT * FROM blocked_ips WHERE ip_address = ? AND is_active = 1')
        .bind('')
        .first<MockBlockedIpRow>();

      expect(blockedEmpty).toBeDefined();
      expect(blockedEmpty?.ip_address).toBe('');
    });

    it('1.3 handles extreme numeric parameters and non-standard values (0, -1, NaN, MAX_SAFE_INTEGER)', async () => {
      await db
        .prepare(`
          INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, is_suspicious, anomaly_score)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind('click-num-edge', 'deal-active-1', 'sess-num', '10.10.10.10', 0, Number.MAX_SAFE_INTEGER)
        .run();

      const click = db.dealClicks.get('click-num-edge');
      expect(click?.anomaly_score).toBe(Number.MAX_SAFE_INTEGER);

      // Negative is_suspicious or NaN
      await db
        .prepare(`
          INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, is_suspicious, anomaly_score)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind('click-nan', 'deal-active-1', 'sess-nan', '10.10.10.11', -1, NaN)
        .run();

      const clickNaN = db.dealClicks.get('click-nan');
      expect(clickNaN?.is_suspicious).toBe(-1);
      expect(Number.isNaN(clickNaN?.anomaly_score)).toBe(true);
    });

    it('1.4 auto-serializes objects/arrays passed as flag_reasons in INSERT and UPDATE', async () => {
      // Object/array in INSERT
      await db
        .prepare(`
          INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, is_suspicious, flag_reasons)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind('click-obj-reasons', 'deal-active-1', 'sess-obj', '10.10.10.20', 1, [
          'BURST_CLICK',
          'RATE_LIMIT_EXCEEDED',
        ])
        .run();

      const click = db.dealClicks.get('click-obj-reasons');
      expect(typeof click?.flag_reasons).toBe('string');
      expect(JSON.parse(click?.flag_reasons || '[]')).toEqual(['BURST_CLICK', 'RATE_LIMIT_EXCEEDED']);

      // Object/array in UPDATE
      await db
        .prepare('UPDATE deal_clicks SET flag_reasons = ? WHERE id = ?')
        .bind(['HIGH_CLICK_CONVERSION_RATIO'], 'click-obj-reasons')
        .run();

      const updated = db.dealClicks.get('click-obj-reasons');
      expect(typeof updated?.flag_reasons).toBe('string');
      expect(JSON.parse(updated?.flag_reasons || '[]')).toEqual(['HIGH_CLICK_CONVERSION_RATIO']);
    });

    it('1.5 handles parameter binding count mismatch (more parameters than placeholders)', async () => {
      // Providing 4 params when query only specifies 2 placeholders
      const stmt = db
        .prepare('SELECT * FROM blocked_ips WHERE ip_address = ?')
        .bind('192.168.1.1', 'extra-arg-1', 'extra-arg-2');

      const result = await stmt.first();
      // Should not throw or crash on surplus parameters
      expect(result).toBeNull();
    });

    it('1.6 handles parameter binding count mismatch (fewer parameters than placeholders)', async () => {
      // Missing required params
      const res = await db
        .prepare('SELECT * FROM deal_clicks WHERE (ip_address = ? OR session_id = ?)')
        .bind('192.168.1.1') // missing second param
        .all();

      expect(Array.isArray(res.results)).toBe(true);
    });

    it('1.7 safely handles SQL injection strings as parameter values without code execution', async () => {
      const sqlInjectionStrings = [
        "' OR '1'='1",
        "'; DROP TABLE deal_clicks; --",
        "' UNION SELECT * FROM profiles --",
        "admin' --",
        "'; DELETE FROM blocked_ips WHERE '1'='1",
        '1; SELECT * FROM profiles;',
        '\x00-- null byte attack',
      ];

      for (const injection of sqlInjectionStrings) {
        // Test in blocked_ips insert & lookup
        const id = `b-sqli-${Math.random().toString(36).substring(2, 8)}`;
        await db
          .prepare('INSERT INTO blocked_ips (id, ip_address, reason, blocked_by) VALUES (?, ?, ?, ?)')
          .bind(id, injection, injection, injection)
          .run();

        // Exact match retrieval - must NOT match other IPs or drop tables
        const fetched = await db
          .prepare('SELECT * FROM blocked_ips WHERE ip_address = ? AND is_active = 1')
          .bind(injection)
          .first<MockBlockedIpRow>();

        expect(fetched).not.toBeNull();
        expect(fetched?.ip_address).toBe(injection);
        expect(fetched?.reason).toBe(injection);
      }

      // Verify dealClicks and blockedIps tables still exist and are intact
      expect(db.deals.size).toBeGreaterThan(0);
      expect(db.profiles.size).toBeGreaterThan(0);
    });

    it('1.8 handles raw execution without bind()', async () => {
      const allDeals = await db.prepare('SELECT * FROM deals WHERE is_active = 1').all();
      expect(allDeals.results.length).toBeGreaterThan(0);

      const firstProfile = await db.prepare('SELECT * FROM profiles').first();
      expect(firstProfile).not.toBeNull();
    });
  });

  describe('2. Batch Operations and Transactional Rollback Simulation', () => {
    it('2.1 executes an empty batch successfully', async () => {
      const results = await db.batch([]);
      expect(results).toEqual([]);
    });

    it('2.2 executes batch of heterogeneous read and write statements', async () => {
      const stmt1 = db
        .prepare('INSERT INTO blocked_ips (id, ip_address, reason, blocked_by) VALUES (?, ?, ?, ?)')
        .bind('batch-h1', '172.16.0.1', 'Batch test 1', 'admin');

      const stmt2 = db
        .prepare('SELECT * FROM deals WHERE id = ?')
        .bind('deal-active-1');

      const stmt3 = db
        .prepare('INSERT INTO blocked_ips (id, ip_address, reason, blocked_by) VALUES (?, ?, ?, ?)')
        .bind('batch-h2', '172.16.0.2', 'Batch test 2', 'admin');

      const results = await db.batch([stmt1, stmt2, stmt3]);
      expect(results.length).toBe(3);
      expect(results[0].success).toBe(true);
      expect(results[1]).toBeDefined();
      expect(results[2].success).toBe(true);

      expect(db.blockedIps.has('172.16.0.1')).toBe(true);
      expect(db.blockedIps.has('172.16.0.2')).toBe(true);
    });

    it('2.3 evaluates batch behavior when a statement fails (empirical rollback verification)', async () => {
      const initialCount = db.blockedIps.size;

      const stmtGood = db
        .prepare('INSERT INTO blocked_ips (id, ip_address, reason, blocked_by) VALUES (?, ?, ?, ?)')
        .bind('batch-rollback-candidate', '172.16.99.99', 'Rollback test', 'admin');

      // Attempting illegal UPDATE on immutable fraud_reviews throws an error
      const stmtFailing = db
        .prepare("UPDATE fraud_reviews SET reason = 'illegal' WHERE id = 'rev-nonexistent'");

      // Execute batch and expect rejection
      await expect(db.batch([stmtGood, stmtFailing])).rejects.toThrow(
        /cannot modify immutable table/i
      );

      // Empirical Check:
      // In Cloudflare D1 production runtime, batch() is executed in a transaction,
      // so if any statement fails, prior statements are rolled back.
      // In the in-memory mock: does stmtGood persist or roll back?
      const wasCommittedInMock = db.blockedIps.has('172.16.99.99');
      // Documenting empirical observation of mock vs production transaction semantics:
      // The current in-memory MockFraudDatabase executes statements iteratively without snapshot/rollback.
      expect(wasCommittedInMock).toBe(true);
    });

    it('2.4 handles batch statements with multiple binds to the same prepared query template', async () => {
      const template = db.prepare(
        'INSERT INTO blocked_ips (id, ip_address, reason, blocked_by) VALUES (?, ?, ?, ?)'
      );

      const stmts = [
        template.bind('b-multi-1', '10.200.0.1', 'Reason 1', 'admin'),
        template.bind('b-multi-2', '10.200.0.2', 'Reason 2', 'admin'),
        template.bind('b-multi-3', '10.200.0.3', 'Reason 3', 'admin'),
      ];

      const results = await db.batch(stmts);
      expect(results.length).toBe(3);
      expect(db.blockedIps.has('10.200.0.1')).toBe(true);
      expect(db.blockedIps.has('10.200.0.2')).toBe(true);
      expect(db.blockedIps.has('10.200.0.3')).toBe(true);
    });
  });

  describe('3. Type Serialization Roundtrips and Contract Stress (src/types/fraud.ts)', () => {
    it('3.1 roundtrips all valid FraudReasonCodes losslessly through serializeReasons and parseReasons', () => {
      const allReasons: ReasonCode[] = [
        FraudReasonCode.BURST_CLICK,
        FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO,
        FraudReasonCode.ABNORMAL_CONVERSION_RATIO,
        FraudReasonCode.RATE_LIMIT_EXCEEDED,
        FraudReasonCode.IP_RATE_LIMIT_EXCEEDED,
        FraudReasonCode.BLOCKED_IP,
        FraudReasonCode.SUSPICIOUS_USER_AGENT,
        FraudReasonCode.RAPID_IDENTICAL_SESSION,
        FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER,
        FraudReasonCode.MANUAL_FLAG,
      ];

      const serialized = serializeReasons(allReasons);
      const parsed = parseReasons(serialized);
      expect(parsed).toEqual(allReasons);
      expect(parsed.length).toBe(10);
    });

    it('3.2 filters out corrupt, invalid, or injected reason codes during parseReasons', () => {
      const corruptInputs = [
        JSON.stringify(['BURST_CLICK', 'SQLI_ATTACK', 'INVALID_REASON', 999, null, false]),
        JSON.stringify({ reason: 'BURST_CLICK' }), // non-array
        JSON.stringify('BURST_CLICK'), // string primitive
        'undefined',
        'NaN',
        '{"malformed":',
        '',
        '   ',
        null,
        undefined,
      ];

      expect(parseReasons(corruptInputs[0])).toEqual(['BURST_CLICK']);
      expect(parseReasons(corruptInputs[1])).toEqual([]);
      expect(parseReasons(corruptInputs[2])).toEqual([]);
      expect(parseReasons(corruptInputs[3])).toEqual([]);
      expect(parseReasons(corruptInputs[4])).toEqual([]);
      expect(parseReasons(corruptInputs[5])).toEqual([]);
      expect(parseReasons(corruptInputs[6])).toEqual([]);
      expect(parseReasons(corruptInputs[7])).toEqual([]);
      expect(parseReasons(corruptInputs[8])).toEqual([]);
      expect(parseReasons(corruptInputs[9])).toEqual([]);
    });

    it('3.3 roundtrips deeply nested metadata safely through serializeMetadata and parseMetadata', () => {
      const complexMeta = {
        ruleHit: 'BURST_DETECTION',
        thresholds: {
          burstWindowMs: 2000,
          deltaMs: 450,
          clickIds: ['c1', 'c2', 'c3'],
        },
        clientInfo: {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'cf-ipcountry': 'US',
          },
          reputationScore: 0.12,
        },
        flags: [true, false, true],
        nullField: null,
      };

      const serialized = serializeMetadata(complexMeta);
      const parsed = parseMetadata(serialized);
      expect(parsed).toEqual(complexMeta);
    });

    it('3.4 handles edge-case inputs in parseMetadata gracefully', () => {
      expect(parseMetadata(null)).toEqual({});
      expect(parseMetadata(undefined)).toEqual({});
      expect(parseMetadata('')).toEqual({});
      expect(parseMetadata('   ')).toEqual({});
      expect(parseMetadata('invalid json string')).toEqual({});
      expect(parseMetadata('[1, 2, 3]')).toEqual({}); // array rejected
      expect(parseMetadata('"string literal"')).toEqual({}); // primitive rejected
      expect(parseMetadata('12345')).toEqual({}); // number rejected
      expect(parseMetadata('true')).toEqual({}); // boolean rejected
      expect(parseMetadata('null')).toEqual({}); // JSON null literal rejected
    });

    it('3.5 validates Zod schemas on boundary inputs', () => {
      // 1. FraudReasonCodeSchema
      expect(FraudReasonCodeSchema.parse('BURST_CLICK')).toBe('BURST_CLICK');
      expect(() => FraudReasonCodeSchema.parse('BURST_CLICK_INVALID')).toThrow();

      // 2. FraudReviewActionSchema
      expect(FraudReviewActionSchema.parse('approve')).toBe('approve');
      expect(FraudReviewActionSchema.parse('block_ip')).toBe('block_ip');
      expect(() => FraudReviewActionSchema.parse('delete_db')).toThrow();

      // 3. ClickReviewStatusSchema
      expect(ClickReviewStatusSchema.parse('pending')).toBe('pending');
      expect(ClickReviewStatusSchema.parse('rejected')).toBe('rejected');
      expect(() => ClickReviewStatusSchema.parse('unknown')).toThrow();

      // 4. CreateBlockedIpSchema
      expect(() =>
        CreateBlockedIpSchema.parse({
          ipAddress: '',
          reason: 'Valid reason here',
        })
      ).toThrow();

      expect(() =>
        CreateBlockedIpSchema.parse({
          ipAddress: '1.2.3.4',
          reason: 'ab', // < 3 chars
        })
      ).toThrow();

      const validBlock = CreateBlockedIpSchema.parse({
        ipAddress: '1.2.3.4',
        reason: 'Valid reason here',
        expiresAt: '2026-12-31T23:59:59.000Z',
        metadata: { source: 'automated_guard' },
      });
      expect(validBlock.ipAddress).toBe('1.2.3.4');
    });

    it('3.6 AdminFraudActionSchema handles valid action payloads and rejects insufficient reasons', () => {
      // Valid approve payload
      const validApprove = AdminFraudActionSchema.parse({
        action: 'approve',
        clickId: 'click-100',
        reason: 'Legitimate influencer marketing traffic',
      });
      expect(validApprove.action).toBe('approve');

      // Valid bulk_resolve payload
      const validBulk = AdminFraudActionSchema.parse({
        action: 'bulk_resolve',
        clickIds: ['click-1', 'click-2'],
        resolution: 'reject',
        reason: 'Confirmed bot network burst pattern',
        blockIpAlso: true,
      });
      expect(validBulk.action).toBe('bulk_resolve');

      // Reject short reason (<3 chars)
      expect(() =>
        AdminFraudActionSchema.parse({
          action: 'approve',
          clickId: 'c1',
          reason: 'ok',
        })
      ).toThrow(/at least 3 characters/i);
    });
  });
});
