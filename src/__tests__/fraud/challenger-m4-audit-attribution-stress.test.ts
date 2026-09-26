/**
 * Milestone 4 Adversarial Challenger Stress Suite:
 * Audit Log Immutability Triggers, Atomic Dual-Write, and Attribution Recovery
 * Location: src/__tests__/fraud/challenger-m4-audit-attribution-stress.test.ts
 *
 * Empirical verification and stress testing covering:
 * 1. Audit Log Immutability Triggers (Feature F12):
 *    - Direct UPDATE on fraud_reviews (notes, reason, action, details, timestamp) MUST fail/abort.
 *    - Direct DELETE on fraud_reviews (targeted, blanket, subquery) MUST fail/abort.
 *    - Enforced on both real SQLite engine (better-sqlite3 with DDL triggers) and MockFraudDatabase.
 *    - Confirm ONLY INSERT operations are permitted and data integrity is preserved.
 *
 * 2. Atomic Dual-Write Consistency (Feature F11 & F12):
 *    - Click approval / rejection updates deal_clicks AND inserts audit log in one batch.
 *    - IP blocking via actions or blocked-ips endpoint writes blocked_ips AND audit log.
 *    - IP unblocking removes IP AND writes audit log.
 *    - Bulk resolution executes atomically across multi-chunk batches (crossing 45-statement threshold).
 *    - Validation failures reject cleanly without partial or orphaned writes.
 *
 * 3. Attribution Restoration Dynamics (Feature F12 & Matcher):
 *    - Flagged suspicious clicks (is_suspicious = 1) strictly ignored by Matcher.resolveClick.
 *    - Admin approval clears suspicion (is_suspicious = 0) and Matcher immediately attributes.
 *    - Tiered commissions (Tier 1 30%, Tier 2 10%, Tier 3 5%) calculate accurately post-restoration.
 *    - Multi-click competition: fallback to older clean clicks when newer click is suspicious,
 *      and dynamic re-attribution once newer click is approved.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import {
  setupFraudTestEnvironment,
  mockFraudDB,
  createFraudTestRequest,
  dispatchRoute,
} from './fraud-test-harness';
import { recordFraudDecision } from '@/lib/fraud/audit-logger';
import { Matcher } from '@/lib/tracking/matcher';

describe('Milestone 4 Adversarial Stress Suite: Audit Immutability & Attribution Recovery', () => {
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
    realSqliteDb = initRealD1Database();
  });

  afterEach(() => {
    if (realSqliteDb) {
      realSqliteDb.close();
    }
  });

  // ==========================================================================
  // SECTION 1: Audit Log Immutability Triggers (Feature F12)
  // ==========================================================================
  describe('1. Audit Log Immutability Triggers (UPDATE & DELETE Abort Enforcement)', () => {
    // 1.1 Real SQLite Engine Immutability Trigger Stress
    describe('1.1 Real SQLite Engine with Migration 021 Triggers', () => {
      beforeEach(() => {
        // Seed legitimate audit record in real SQLite
        realSqliteDb.prepare(`
          INSERT INTO fraud_reviews (
            id, click_id, ip_address, reviewer_id, reviewed_by, action, reason, reviewed_at, created_at, details
          ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
        `).run(
          'rev-sqlite-001',
          'click-target-001',
          '198.51.100.25',
          'usr-admin-1',
          'admin@apex-os.com',
          'reject',
          'Automated burst pattern detected',
          JSON.stringify({ score: 0.92, type: 'BURST_CLICK' })
        );
      });

      it('aborts direct UPDATE on reason with SQLite RAISE(ABORT)', () => {
        expect(() => {
          realSqliteDb.prepare("UPDATE fraud_reviews SET reason = 'Tampered Reason' WHERE id = 'rev-sqlite-001'").run();
        }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);

        const row = realSqliteDb.prepare("SELECT reason FROM fraud_reviews WHERE id = 'rev-sqlite-001'").get() as any;
        expect(row.reason).toBe('Automated burst pattern detected');
      });

      it('aborts direct UPDATE on action (tampering review decision)', () => {
        expect(() => {
          realSqliteDb.prepare("UPDATE fraud_reviews SET action = 'approve' WHERE id = 'rev-sqlite-001'").run();
        }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);

        const row = realSqliteDb.prepare("SELECT action FROM fraud_reviews WHERE id = 'rev-sqlite-001'").get() as any;
        expect(row.action).toBe('reject');
      });

      it('aborts direct UPDATE on details metadata JSON', () => {
        expect(() => {
          realSqliteDb.prepare("UPDATE fraud_reviews SET details = '{\"forged\":true}' WHERE id = 'rev-sqlite-001'").run();
        }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);
      });

      it('aborts direct UPDATE on reviewed_at timestamp (backdating attack)', () => {
        expect(() => {
          realSqliteDb.prepare("UPDATE fraud_reviews SET reviewed_at = '2020-01-01 00:00:00' WHERE id = 'rev-sqlite-001'").run();
        }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);
      });

      it('aborts direct UPDATE when notes column is present (explicit prompt requirement)', () => {
        // Alter table to add notes column to verify trigger still traps UPDATE on notes column
        realSqliteDb.exec('ALTER TABLE fraud_reviews ADD COLUMN notes TEXT;');

        expect(() => {
          realSqliteDb.prepare("UPDATE fraud_reviews SET notes = 'tampered' WHERE id = 'rev-sqlite-001'").run();
        }).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);
      });

      it('aborts direct DELETE on targeted audit record', () => {
        expect(() => {
          realSqliteDb.prepare("DELETE FROM fraud_reviews WHERE id = 'rev-sqlite-001'").run();
        }).toThrow(/fraud_reviews audit log is immutable: DELETE operations are prohibited/i);

        const exists = realSqliteDb.prepare("SELECT id FROM fraud_reviews WHERE id = 'rev-sqlite-001'").get();
        expect(exists).toBeDefined();
      });

      it('aborts blanket DELETE FROM fraud_reviews', () => {
        expect(() => {
          realSqliteDb.prepare('DELETE FROM fraud_reviews').run();
        }).toThrow(/fraud_reviews audit log is immutable: DELETE operations are prohibited/i);

        const count = realSqliteDb.prepare('SELECT COUNT(*) as count FROM fraud_reviews').get() as any;
        expect(count.count).toBe(1);
      });

      it('aborts subquery DELETE FROM fraud_reviews WHERE id IN (...)', () => {
        expect(() => {
          realSqliteDb.prepare('DELETE FROM fraud_reviews WHERE id IN (SELECT id FROM fraud_reviews)').run();
        }).toThrow(/fraud_reviews audit log is immutable: DELETE operations are prohibited/i);
      });

      it('aborts UPDATE inside an explicit transaction and rolls back entire transaction', () => {
        const tx = realSqliteDb.transaction(() => {
          realSqliteDb.prepare(`
            INSERT INTO fraud_reviews (id, reviewer_id, action, reason)
            VALUES ('rev-in-tx', 'usr-admin-1', 'approve', 'Valid inside tx')
          `).run();

          // Attempt forbidden update
          realSqliteDb.prepare("UPDATE fraud_reviews SET reason = 'Tampered inside tx' WHERE id = 'rev-sqlite-001'").run();
        });

        expect(() => tx()).toThrow(/fraud_reviews audit log is immutable: UPDATE operations are prohibited/i);

        // Verify neither the inserted record nor the update persisted
        const txRow = realSqliteDb.prepare("SELECT id FROM fraud_reviews WHERE id = 'rev-in-tx'").get();
        expect(txRow).toBeUndefined();

        const origRow = realSqliteDb.prepare("SELECT reason FROM fraud_reviews WHERE id = 'rev-sqlite-001'").get() as any;
        expect(origRow.reason).toBe('Automated burst pattern detected');
      });

      it('confirms ONLY INSERT operations are permitted and monotonically increment count', () => {
        for (let i = 2; i <= 6; i++) {
          realSqliteDb.prepare(`
            INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
            VALUES (?, ?, ?, ?, ?)
          `).run(`rev-sqlite-00${i}`, `click-00${i}`, 'usr-admin-1', 'approve', `Valid audit ${i}`);
        }

        const count = realSqliteDb.prepare('SELECT COUNT(*) as count FROM fraud_reviews').get() as any;
        expect(count.count).toBe(6);
      });
    });

    // 1.2 Mock Database Immutability Trigger Stress
    describe('1.2 Mock Database (mockFraudDB) Trigger Simulation', () => {
      beforeEach(() => {
        mockFraudDB.fraudReviews.set('rev-mock-1', {
          id: 'rev-mock-1',
          click_id: 'click-m1',
          reviewer_id: 'usr-admin-1',
          action: 'reject',
          reason: 'Initial rejection',
          notes: 'Initial notes',
          created_at: new Date().toISOString(),
        });
      });

      it('aborts direct UPDATE fraud_reviews SET notes = "tampered" WHERE id = ?', async () => {
        await expect(
          mockFraudDB.prepare("UPDATE fraud_reviews SET notes = 'tampered' WHERE id = 'rev-mock-1'").run()
        ).rejects.toThrow(/fraud_reviews audit log is immutable and cannot be updated or deleted/i);

        const rev = mockFraudDB.fraudReviews.get('rev-mock-1');
        expect(rev?.notes).toBe('Initial notes');
      });

      it('aborts direct UPDATE fraud_reviews SET reason = "tampered" WHERE id = ?', async () => {
        await expect(
          mockFraudDB.prepare("UPDATE fraud_reviews SET reason = 'tampered' WHERE id = 'rev-mock-1'").run()
        ).rejects.toThrow(/fraud_reviews audit log is immutable and cannot be updated or deleted/i);
      });

      it('aborts direct DELETE FROM fraud_reviews WHERE id = ?', async () => {
        await expect(
          mockFraudDB.prepare("DELETE FROM fraud_reviews WHERE id = 'rev-mock-1'").run()
        ).rejects.toThrow(/fraud_reviews audit log is immutable and cannot be updated or deleted/i);

        expect(mockFraudDB.fraudReviews.has('rev-mock-1')).toBe(true);
      });

      it('aborts blanket DELETE FROM fraud_reviews', async () => {
        await expect(
          mockFraudDB.prepare('DELETE FROM fraud_reviews').run()
        ).rejects.toThrow(/fraud_reviews audit log is immutable and cannot be updated or deleted/i);

        expect(mockFraudDB.fraudReviews.size).toBe(1);
      });

      it('permits INSERT INTO fraud_reviews without restriction', async () => {
        await mockFraudDB.prepare(`
          INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
          VALUES (?, ?, ?, ?, ?)
        `).bind('rev-mock-2', 'click-m2', 'usr-admin-1', 'approve', 'Approved legitimate traffic').run();

        expect(mockFraudDB.fraudReviews.has('rev-mock-2')).toBe(true);
        expect(mockFraudDB.fraudReviews.size).toBe(2);
      });
    });
  });

  // ==========================================================================
  // SECTION 2: Atomic Dual-Write Consistency (Feature F11 & F12)
  // ==========================================================================
  describe('2. Atomic Dual-Write Consistency Stress Testing', () => {
    it('confirms approving a click simultaneously updates click state AND inserts audit record', async () => {
      mockFraudDB.dealClicks.set('click-dual-1', {
        id: 'click-dual-1',
        deal_id: 'deal-1',
        ip_address: '198.51.100.101',
        is_suspicious: 1,
        anomaly_score: 0.88,
        review_status: 'pending',
        created_at: new Date().toISOString(),
      } as any);

      const result = await recordFraudDecision(
        mockFraudDB,
        {
          action: 'approve',
          clickId: 'click-dual-1',
          reason: 'Verified affiliate influencer campaign',
        },
        { userId: 'usr-admin-1', email: 'admin@apex-os.com' }
      );

      expect(result.success).toBe(true);
      expect(result.affectedCount).toBe(1);

      // Verify click state updated
      const click = mockFraudDB.dealClicks.get('click-dual-1');
      expect(click?.is_suspicious).toBe(0);
      expect(click?.anomaly_score).toBe(0.0);
      expect(click?.review_status).toBe('approved');
      expect(click?.reviewed_by).toBe('usr-admin-1');

      // Verify audit record inserted simultaneously
      expect(mockFraudDB.fraudReviews.size).toBe(1);
      const audit = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(audit.click_id).toBe('click-dual-1');
      expect(audit.action).toBe('approve');
      expect(audit.reason).toBe('Verified affiliate influencer campaign');
      expect(audit.ip_address).toBe('198.51.100.101');
    });

    it('confirms rejecting a click simultaneously updates click state AND inserts audit record', async () => {
      mockFraudDB.dealClicks.set('click-dual-2', {
        id: 'click-dual-2',
        deal_id: 'deal-1',
        ip_address: '198.51.100.102',
        is_suspicious: 1,
        review_status: 'pending',
        created_at: new Date().toISOString(),
      } as any);

      const result = await recordFraudDecision(
        mockFraudDB,
        {
          action: 'reject',
          clickId: 'click-dual-2',
          reason: 'Automated script click farming',
        },
        { userId: 'usr-admin-2', email: 'secops@apex-os.com' }
      );

      expect(result.success).toBe(true);

      const click = mockFraudDB.dealClicks.get('click-dual-2');
      expect(click?.is_suspicious).toBe(1);
      expect(click?.review_status).toBe('rejected');
      expect(click?.reviewed_by).toBe('usr-admin-2');

      const audit = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(audit.click_id).toBe('click-dual-2');
      expect(audit.action).toBe('reject');
      expect(audit.reason).toBe('Automated script click farming');
    });

    it('confirms rejecting a click with blockIpAlso executes 3-way atomic write (click + blocked_ips + 2 audits)', async () => {
      const clickId = 'click-dual-3';
      const targetIp = '198.51.100.103';

      mockFraudDB.dealClicks.set(clickId, {
        id: clickId,
        deal_id: 'deal-1',
        ip_address: targetIp,
        is_suspicious: 1,
        review_status: 'pending',
        created_at: new Date().toISOString(),
      } as any);

      const result = await recordFraudDecision(
        mockFraudDB,
        {
          action: 'reject',
          clickId,
          reason: 'Severe proxy crawler attack',
          blockIpAlso: true,
        },
        { userId: 'usr-admin-1', email: 'admin@apex-os.com' }
      );

      expect(result.success).toBe(true);
      expect(mockFraudDB.dealClicks.get(clickId)?.review_status).toBe('rejected');

      // IP is added to blocked_ips
      expect(mockFraudDB.blockedIps.has(targetIp)).toBe(true);
      const blocked = mockFraudDB.blockedIps.get(targetIp);
      expect(blocked?.is_active).toBe(1);
      expect(blocked?.reason).toContain('Severe proxy crawler attack');

      // 2 audits: 1 for click rejection + 1 for IP block
      expect(mockFraudDB.fraudReviews.size).toBe(2);
      const audits = Array.from(mockFraudDB.fraudReviews.values());
      const clickAudit = audits.find((a) => a.action === 'reject');
      const ipAudit = audits.find((a) => a.action === 'block_ip');

      expect(clickAudit).toBeDefined();
      expect(clickAudit?.click_id).toBe(clickId);
      expect(ipAudit).toBeDefined();
      expect(ipAudit?.ip_address).toBe(targetIp);
    });

    it('confirms blocking an IP via /api/admin/fraud/actions simultaneously inserts audit record', async () => {
      const targetIp = '203.0.113.88';
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'block_ip',
          ip: targetIp,
          reason: 'Persistent multi-session rate limit abuser',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);

      // Blocked IP recorded
      expect(mockFraudDB.blockedIps.has(targetIp)).toBe(true);

      // Audit recorded
      expect(mockFraudDB.fraudReviews.size).toBe(1);
      const audit = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(audit.ip_address).toBe(targetIp);
      expect(audit.action).toBe('block_ip');
      expect(audit.reason).toBe('Persistent multi-session rate limit abuser');
    });

    it('confirms blocking an IP via /api/admin/fraud/blocked-ips endpoint simultaneously inserts audit record', async () => {
      const targetIp = '203.0.113.99';
      const req = createFraudTestRequest('/api/admin/fraud/blocked-ips', {
        method: 'POST',
        admin: true,
        body: {
          ipAddress: targetIp,
          reason: 'Known malicious bot subnet',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'POST', req);
      expect(res.status).toBe(200);

      expect(mockFraudDB.blockedIps.has(targetIp)).toBe(true);
      expect(mockFraudDB.fraudReviews.size).toBe(1);
      const audit = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(audit.ip_address).toBe(targetIp);
      expect(audit.action).toBe('block_ip');
      expect(audit.reason).toBe('Known malicious bot subnet');
    });

    it('confirms unblocking an IP via DELETE /api/admin/fraud/blocked-ips simultaneously inserts audit record', async () => {
      const targetIp = '203.0.113.50';
      mockFraudDB.blockedIps.set(targetIp, {
        id: 'block-50',
        ip_address: targetIp,
        reason: 'Temporary investigation ban',
        blocked_by: 'usr-admin-1',
        is_active: 1,
        created_at: new Date().toISOString(),
      } as any);

      const req = createFraudTestRequest(`/api/admin/fraud/blocked-ips?ip=${targetIp}&reason=Admin+whitelisted`, {
        method: 'DELETE',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'DELETE', req);
      expect(res.status).toBe(200);

      expect(mockFraudDB.blockedIps.has(targetIp)).toBe(false);
      expect(mockFraudDB.fraudReviews.size).toBe(1);
      const audit = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(audit.ip_address).toBe(targetIp);
      expect(audit.action).toBe('unblock_ip');
      expect(audit.reason).toContain('Admin whitelisted');
    });

    it('confirms bulk_resolve executes atomically across multi-chunk batches (crossing 45-statement threshold)', async () => {
      // Create 50 clicks (crosses CHUNK_SIZE = 45 in audit-logger.ts)
      const count = 50;
      const clickIds: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = `click-bulk-stress-${i}`;
        clickIds.push(id);
        mockFraudDB.dealClicks.set(id, {
          id,
          deal_id: 'deal-bulk-1',
          ip_address: `198.51.100.${i % 250}`,
          is_suspicious: 1,
          review_status: 'pending',
          anomaly_score: 0.85,
          created_at: new Date().toISOString(),
        } as any);
      }

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'bulk_resolve',
          clickIds,
          resolution: 'approve',
          reason: 'Verified wholesale promotional campaign',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.affectedCount).toBe(50);
      expect(res.data.auditIds.length).toBe(50);

      // Verify every single click is updated
      for (const id of clickIds) {
        const c = mockFraudDB.dealClicks.get(id);
        expect(c?.is_suspicious).toBe(0);
        expect(c?.review_status).toBe('approved');
        expect(c?.anomaly_score).toBe(0.0);
      }

      // Verify exactly 50 immutable audit records were inserted
      expect(mockFraudDB.fraudReviews.size).toBe(50);
      const audits = Array.from(mockFraudDB.fraudReviews.values());
      expect(audits.every((a) => a.action === 'approve')).toBe(true);
      expect(audits.every((a) => a.reason === 'Verified wholesale promotional campaign')).toBe(true);
    });

    it('rejects invalid or empty decision payload without modifying database state', async () => {
      const initialAuditCount = mockFraudDB.fraudReviews.size;
      const initialClickCount = mockFraudDB.dealClicks.size;

      // Missing reason
      const reqNoReason = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: 'c-invalid',
          reason: '   ',
        },
      });
      const res1 = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', reqNoReason);
      expect(res1.status).toBe(400);

      // Invalid action enum
      const reqInvalidAction = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'hack_database',
          clickId: 'c-invalid',
          reason: 'Attempt invalid action',
        },
      });
      const res2 = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', reqInvalidAction);
      expect(res2.status).toBe(400);

      // Empty clickIds for bulk_resolve
      const reqEmptyBulk = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'bulk_resolve',
          clickIds: [],
          reason: 'Empty bulk',
        },
      });
      const res3 = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', reqEmptyBulk);
      expect(res3.status).toBe(400);

      // No state was corrupted or partially written
      expect(mockFraudDB.fraudReviews.size).toBe(initialAuditCount);
      expect(mockFraudDB.dealClicks.size).toBe(initialClickCount);
    });
  });

  // ==========================================================================
  // SECTION 3: Attribution Restoration Dynamics (Matcher.resolveClick)
  // ==========================================================================
  describe('3. Attribution Restoration Dynamics (Matcher.resolveClick & Matcher.match)', () => {
    const dealId = 'deal-attribution-test';
    const affiliateCode = 'affiliate-prime-1';
    const affiliateProfileId = 'usr-affiliate-prime';
    const traderProfileId = 'usr-trader-alice';
    const traderWallet = '0x1234567890123456789012345678901234567890';
    const traderEmail = 'alice@example.com';
    const clickId = 'click-restoration-target';

    beforeEach(() => {
      // 1. Seed Deal (10% commission rate)
      mockFraudDB.deals.set(dealId, {
        id: dealId,
        url: 'https://broker.example.com/ref',
        title: 'Prime Crypto Trading Deal',
        is_active: 1,
        default_commission_rate: 0.10, // 10%
        default_commission_type: 'percentage',
        created_at: new Date(Date.now() - 86400000).toISOString(),
      });

      // 2. Seed Affiliate Profile & Referral Tree
      mockFraudDB.profiles.set(affiliateProfileId, {
        id: affiliateProfileId,
        email: 'affiliate@apex-os.com',
        full_name: 'Affiliate Prime',
        role: 'affiliate',
        plan: 'free',
        tier: 'tier1',
        referral_code: affiliateCode,
        created_at: new Date(Date.now() - 86400000 * 30).toISOString(),
        updated_at: new Date().toISOString(),
      });

      mockFraudDB.referralTree.set(affiliateProfileId, {
        id: 'tree-node-1',
        affiliate_id: affiliateProfileId,
        parent_id: null,
        path: affiliateProfileId,
        created_at: new Date(Date.now() - 86400000 * 30).toISOString(),
        updated_at: new Date().toISOString(),
      });

      // 3. Seed Trader Profile & Wallet Connection
      mockFraudDB.profiles.set(traderProfileId, {
        id: traderProfileId,
        email: traderEmail,
        full_name: 'Alice Trader',
        role: 'trader',
        plan: 'free',
        tier: 'tier1',
        referral_code: null,
        created_at: new Date(Date.now() - 86400000 * 10).toISOString(),
        updated_at: new Date().toISOString(),
      });

      mockFraudDB.walletConnections.set(traderWallet, {
        id: 'wc-alice-1',
        profile_id: traderProfileId,
        wallet_address: traderWallet.toLowerCase(),
        preferred_chain: 'ethereum',
        is_primary: 1,
        connected_at: new Date(Date.now() - 86400000 * 10).toISOString(),
        last_used_at: null,
      });
    });

    it('confirms suspicious click (is_suspicious = 1) is strictly ignored by Matcher.resolveClick and matcher.match', async () => {
      // Seed flagged click
      mockFraudDB.dealClicks.set(clickId, {
        id: clickId,
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: affiliateProfileId,
        session_id: 'sess-flagged-001',
        ip_address: '198.51.100.210',
        user_agent: 'Automated Bot 2.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1, // FLAGGED SUSPICIOUS
        flag_reasons: '["BURST_CLICK","HIGH_CLICK_CONVERSION_RATIO"]',
        anomaly_score: 0.94,
        review_status: 'pending',
        created_at: new Date(Date.now() - 1000 * 60 * 10).toISOString(), // 10 minutes ago
      });

      const matcher = new Matcher(mockFraudDB as any);

      // Verify Matcher.resolveClick directly returns null
      const directResolved = await (matcher as any).resolveClick(dealId, traderProfileId);
      expect(directResolved).toBeNull();

      // Test via email identifier
      const matchResultEmail = await matcher.match({
        dealId,
        userIdentifier: traderEmail,
        tradeVolumeUsd: 10000,
      });

      expect(matchResultEmail.user).not.toBeNull();
      expect(matchResultEmail.user?.id).toBe(traderProfileId);
      expect(matchResultEmail.click).toBeNull();
      expect(matchResultEmail.metadata.clickFound).toBe(false);
      expect(matchResultEmail.referralTree).toBeNull();
      expect(matchResultEmail.commissions.length).toBe(0);
      expect(matchResultEmail.totalCommission).toBe(0);

      // Test via wallet identifier
      const matchResultWallet = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 10000,
      });
      expect(matchResultWallet.user).not.toBeNull();
      expect(matchResultWallet.click).toBeNull();
      expect(matchResultWallet.metadata.clickFound).toBe(false);
      expect(matchResultWallet.totalCommission).toBe(0);
    });

    it('confirms admin approval immediately restores attribution and calculates tiered commissions accurately', async () => {
      // 1. Seed flagged click
      mockFraudDB.dealClicks.set(clickId, {
        id: clickId,
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: affiliateProfileId,
        session_id: 'sess-flagged-002',
        ip_address: '198.51.100.211',
        user_agent: 'Chrome Desktop',
        referrer_url: 'https://twitter.com',
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.85,
        review_status: 'pending',
        created_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);

      // Pre-approval: No attribution
      const preApprovalResult = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 10000,
      });
      expect(preApprovalResult.click).toBeNull();
      expect(preApprovalResult.totalCommission).toBe(0);

      // 2. Admin approves click via recordFraudDecision service
      const decisionResult = await recordFraudDecision(
        mockFraudDB,
        {
          action: 'approve',
          clickId,
          reason: 'Manual KYC verification of high-volume trader',
        },
        { userId: 'usr-admin-1', email: 'admin@apex-os.com' }
      );
      expect(decisionResult.success).toBe(true);

      // Verify deal_clicks is now clean
      const updatedClick = mockFraudDB.dealClicks.get(clickId);
      expect(updatedClick?.is_suspicious).toBe(0);
      expect(updatedClick?.review_status).toBe('approved');

      // 3. Post-approval: Matcher immediately resolves click and attributes commissions
      const postApprovalResult = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 10000,
      });

      expect(postApprovalResult.click).not.toBeNull();
      expect(postApprovalResult.click?.id).toBe(clickId);
      expect(postApprovalResult.metadata.clickFound).toBe(true);
      expect(postApprovalResult.referralTree).not.toBeNull();

      // Commission check: $10,000 trade volume × 10% deal commission × 30% Tier 1 = $300.00
      expect(postApprovalResult.commissions.length).toBe(1);
      const tier1 = postApprovalResult.commissions[0];
      expect(tier1.level).toBe(1);
      expect(tier1.tradeVolumeUsd).toBe(10000);
      expect(tier1.tierRate).toBe(0.30);
      expect(tier1.amount).toBe(300);
      expect(postApprovalResult.totalCommission).toBe(300);
    });

    it('confirms admin approval via POST /api/admin/fraud/actions immediately restores attribution', async () => {
      mockFraudDB.dealClicks.set(clickId, {
        id: clickId,
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: affiliateProfileId,
        session_id: 'sess-flagged-003',
        ip_address: '198.51.100.212',
        user_agent: 'Safari iOS',
        referrer_url: null,
        country_code: 'VN',
        device_type: 'mobile',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        review_status: 'pending',
        created_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);

      // Dispatch route call
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId,
          reason: 'Legitimate flash sale promotion',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);

      // Attribution succeeds immediately
      const matchResult = await matcher.match({
        dealId,
        userIdentifier: traderEmail, // Identify by email
        tradeVolumeUsd: 5000,
      });

      expect(matchResult.click).not.toBeNull();
      expect(matchResult.click?.id).toBe(clickId);
      expect(matchResult.metadata.clickFound).toBe(true);
      // $5,000 trade volume × 10% deal commission × 30% Tier 1 = $150.00
      expect(matchResult.totalCommission).toBe(150);
    });

    it('confirms multi-click fallback: older clean click attributes when newer click is suspicious, switching to newer click on approval', async () => {
      const olderCleanClickId = 'click-older-clean';
      const newerFlaggedClickId = 'click-newer-flagged';

      const olderAffiliateCode = 'affiliate-older-code';
      const olderAffiliateProfileId = 'usr-affiliate-older';

      mockFraudDB.profiles.set(olderAffiliateProfileId, {
        id: olderAffiliateProfileId,
        email: 'older-affiliate@apex-os.com',
        full_name: 'Older Affiliate',
        role: 'affiliate',
        plan: 'free',
        tier: 'tier1',
        referral_code: olderAffiliateCode,
        created_at: new Date(Date.now() - 86400000 * 40).toISOString(),
        updated_at: new Date().toISOString(),
      });

      mockFraudDB.referralTree.set(olderAffiliateProfileId, {
        id: 'tree-older',
        affiliate_id: olderAffiliateProfileId,
        parent_id: null,
        path: olderAffiliateProfileId,
        created_at: new Date(Date.now() - 86400000 * 40).toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Older click: 2 hours ago, clean
      mockFraudDB.dealClicks.set(olderCleanClickId, {
        id: olderCleanClickId,
        deal_id: dealId,
        affiliate_code: olderAffiliateCode,
        affiliate_id: olderAffiliateProfileId,
        session_id: 'sess-clean-older',
        ip_address: '198.51.100.220',
        user_agent: 'Firefox',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0, // Clean!
        created_at: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
      });

      // Newer click: 10 minutes ago, suspicious
      mockFraudDB.dealClicks.set(newerFlaggedClickId, {
        id: newerFlaggedClickId,
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: affiliateProfileId,
        session_id: 'sess-flagged-newer',
        ip_address: '198.51.100.221',
        user_agent: 'Chrome Bot',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1, // Suspicious!
        review_status: 'pending',
        created_at: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);

      // Phase 1: Matcher should skip the newer suspicious click and attribute to older clean click
      const phase1Result = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 1000,
      });

      expect(phase1Result.click).not.toBeNull();
      expect(phase1Result.click?.id).toBe(olderCleanClickId);
      expect(phase1Result.metadata.referralCode).toBe(olderAffiliateCode);

      // Phase 2: Admin approves the newer click
      await recordFraudDecision(
        mockFraudDB,
        {
          action: 'approve',
          clickId: newerFlaggedClickId,
          reason: 'Pardoned newer click',
        },
        { userId: 'usr-admin-1', email: 'admin@apex-os.com' }
      );

      // Phase 3: Matcher now selects the newer click (most recent legitimate click)
      const phase3Result = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 1000,
      });

      expect(phase3Result.click).not.toBeNull();
      expect(phase3Result.click?.id).toBe(newerFlaggedClickId);
      expect(phase3Result.metadata.referralCode).toBe(affiliateCode);
    });

    it('confirms re-flagging or rejecting a click revokes attribution instantly', async () => {
      // Start with approved click
      mockFraudDB.dealClicks.set(clickId, {
        id: clickId,
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: affiliateProfileId,
        session_id: 'sess-cycle',
        ip_address: '198.51.100.230',
        user_agent: 'Mobile Safari',
        referrer_url: null,
        country_code: 'US',
        device_type: 'mobile',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        review_status: 'approved',
        created_at: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);

      const res1 = await matcher.match({ dealId, userIdentifier: traderWallet, tradeVolumeUsd: 1000 });
      expect(res1.click?.id).toBe(clickId);

      // Admin rejects click
      await recordFraudDecision(
        mockFraudDB,
        {
          action: 'reject',
          clickId,
          reason: 'Chargeback fraud associated with click origin',
        },
        { userId: 'usr-admin-1', email: 'admin@apex-os.com' }
      );

      // Attribution immediately revoked
      const res2 = await matcher.match({ dealId, userIdentifier: traderWallet, tradeVolumeUsd: 1000 });
      expect(res2.click).toBeNull();
      expect(res2.totalCommission).toBe(0);
    });

    it('empirically verifies complete review lifecycle and attribution recovery with /clicks and /stats', async () => {
      // Step 1: Flagged suspicious click (is_suspicious = 1) -> Matcher.resolveClick ignores it.
      const testClickId = 'click-lifecycle-e2e-1';
      mockFraudDB.dealClicks.set(testClickId, {
        id: testClickId,
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: affiliateProfileId,
        session_id: 'sess-lifecycle-001',
        ip_address: '198.51.100.222',
        user_agent: 'Chrome Test',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        review_status: 'pending',
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.9,
        created_at: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);

      // Verify Matcher.resolveClick strictly ignores it
      const clickBeforeApproval = await (matcher as any).resolveClick(dealId, traderProfileId);
      expect(clickBeforeApproval).toBeNull();

      const matchBefore = await matcher.match({
        dealId,
        userIdentifier: traderEmail,
        tradeVolumeUsd: 1000,
      });
      expect(matchBefore.click).toBeNull();
      expect(matchBefore.metadata.clickFound).toBe(false);

      // Step 2: Admin approves click via POST /api/admin/fraud/actions -> is_suspicious set to 0, review_status set to 'approved'.
      const reqApprove = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: testClickId,
          reason: 'Verified legitimate affiliate influencer promotion',
        },
      });
      const resApprove = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', reqApprove);
      expect(resApprove.status).toBe(200);
      expect(resApprove.data.success).toBe(true);

      const approvedDbClick = mockFraudDB.dealClicks.get(testClickId);
      expect(approvedDbClick?.is_suspicious).toBe(0);
      expect(approvedDbClick?.review_status).toBe('approved');

      // Step 3: Matcher.resolveClick immediately attributes conversions to this approved click.
      const clickAfterApproval = await (matcher as any).resolveClick(dealId, traderProfileId);
      expect(clickAfterApproval).not.toBeNull();
      expect(clickAfterApproval?.id).toBe(testClickId);

      const matchAfter = await matcher.match({
        dealId,
        userIdentifier: traderEmail,
        tradeVolumeUsd: 1000,
      });
      expect(matchAfter.click).not.toBeNull();
      expect(matchAfter.click?.id).toBe(testClickId);
      expect(matchAfter.metadata.clickFound).toBe(true);
      expect(matchAfter.totalCommission).toBeGreaterThan(0);

      // Step 4: Calling GET /api/admin/fraud/clicks?status=approved MUST return the approved click.
      const reqClicks = createFraudTestRequest('/api/admin/fraud/clicks?status=approved', {
        method: 'GET',
        admin: true,
      });
      const resClicks = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', reqClicks);
      expect(resClicks.status).toBe(200);
      const returnedClicks = resClicks.data.clicks || resClicks.data.data;
      const foundInApproved = returnedClicks.find((c: any) => c.id === testClickId);
      expect(foundInApproved).toBeDefined();
      expect(foundInApproved.id).toBe(testClickId);
      expect(foundInApproved.reviewStatus).toBe('approved');
      expect(foundInApproved.isSuspicious).toBe(false);

      // Step 5: Calling GET /api/admin/fraud/stats MUST count this approved review in approvedReviews.
      const reqStats = createFraudTestRequest('/api/admin/fraud/stats', {
        method: 'GET',
        admin: true,
      });
      const resStats = await dispatchRoute('src/app/api/admin/fraud/stats/route.ts', 'GET', reqStats);
      expect(resStats.status).toBe(200);
      const stats = resStats.data.stats || resStats.data.data;
      expect(stats.approvedReviews).toBeGreaterThanOrEqual(1);
    });

    it('empirically verifies approving non-existent click returns 404 without polluting audit ledger', async () => {
      const nonExistentClickId = 'click-ghost-999';
      const initialAudits = mockFraudDB.fraudReviews.size;

      const reqApproveGhost = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: nonExistentClickId,
          reason: 'Attempting to approve a ghost entity',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', reqApproveGhost);
      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/not found/i);

      // Verify no audit log entry was added for phantom click
      expect(mockFraudDB.fraudReviews.size).toBe(initialAudits);
    });

    it('empirically verifies reason length boundary rejects reasons under 3 chars with 400', async () => {
      const shortReasonReq = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId,
          reason: 'ok', // only 2 chars
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', shortReasonReq);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/at least 3 characters/i);
    });

    it('empirically verifies x-test-admin backdoor is rejected and returns 401/403', async () => {
      // Craft request without session cookie, only the backdoor header
      const backdoorReq = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: false,
        headers: {
          'x-test-admin': 'true',
        },
        body: {
          action: 'approve',
          clickId,
          reason: 'Attack attempting bypass',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', backdoorReq);
      expect([401, 403]).toContain(res.status);
      expect(res.data.success).toBe(false);
    });
  });
});

