/**
 * Milestone 1 Unit Tests: TypeScript Types & Contract Compliance
 * Location: src/__tests__/fraud/fraud-types-compliance.test.ts
 *
 * Verifies:
 * 1. Strict TypeScript typing, enum/union correctness, and type guards
 * 2. Compile-time exhaustiveness checks (assertNever) for ReasonCode and AdminFraudActionRequest
 * 3. Database entity contract compliance (DealClickRow, BlockedIpRecord, FraudReviewRecord)
 * 4. JSON serialization and parsing round-trip integrity
 * 5. Runtime Zod schema validations for API boundaries
 */

import {
  FraudReasonCode,
  FRAUD_REASON_CODES,
  ReasonCode,
  isFraudReasonCode,
  FRAUD_REVIEW_ACTIONS,
  FraudReviewAction,
  isFraudReviewAction,
  CLICK_REVIEW_STATUSES,
  ClickReviewStatus,
  isClickReviewStatus,
  DealClickRow,
  BlockedIpRecord,
  HydratedBlockedIp,
  FraudReviewRecord,
  HydratedFraudReview,
  RateLimitConfig,
  RateLimitResult,
  DualWindowRateLimitConfig,
  DualWindowRateLimitResult,
  ClickVelocityInput,
  VelocityCheckThresholds,
  VelocityCheckResult,
  AdminFraudActionRequest,
  AdminFraudActionResponse,
  FlaggedClickDetail,
  FraudStatsSummary,
  serializeReasons,
  parseReasons,
  serializeMetadata,
  parseMetadata,
  FraudReasonCodeSchema,
  FraudReviewActionSchema,
  ClickReviewStatusSchema,
  AdminFraudActionSchema,
  CreateBlockedIpSchema,
} from '@/types/fraud';
import type { DealClick } from '@/types/tracking';

describe('Fraud Types & Contracts Compliance', () => {
  describe('1. Reason Codes Taxonomy & Enum/Unions', () => {
    it('defines all required standard reason codes in enum and array', () => {
      expect(FraudReasonCode.BURST_CLICK).toBe('BURST_CLICK');
      expect(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO).toBe('HIGH_CLICK_CONVERSION_RATIO');
      expect(FraudReasonCode.ABNORMAL_CONVERSION_RATIO).toBe('ABNORMAL_CONVERSION_RATIO');
      expect(FraudReasonCode.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED');
      expect(FraudReasonCode.IP_RATE_LIMIT_EXCEEDED).toBe('IP_RATE_LIMIT_EXCEEDED');
      expect(FraudReasonCode.BLOCKED_IP).toBe('BLOCKED_IP');
      expect(FraudReasonCode.SUSPICIOUS_USER_AGENT).toBe('SUSPICIOUS_USER_AGENT');
      expect(FraudReasonCode.RAPID_IDENTICAL_SESSION).toBe('RAPID_IDENTICAL_SESSION');
      expect(FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER).toBe('AUTO_BLOCKED_REPEAT_OFFENDER');
      expect(FraudReasonCode.MANUAL_FLAG).toBe('MANUAL_FLAG');

      expect(FRAUD_REASON_CODES).toContain('BURST_CLICK');
      expect(FRAUD_REASON_CODES).toContain('HIGH_CLICK_CONVERSION_RATIO');
      expect(FRAUD_REASON_CODES).toContain('RATE_LIMIT_EXCEEDED');
      expect(FRAUD_REASON_CODES).toContain('BLOCKED_IP');
    });

    it('validates reason codes with isFraudReasonCode type guard', () => {
      expect(isFraudReasonCode('BURST_CLICK')).toBe(true);
      expect(isFraudReasonCode(FraudReasonCode.RATE_LIMIT_EXCEEDED)).toBe(true);
      expect(isFraudReasonCode('INVALID_UNKNOWN_REASON')).toBe(false);
      expect(isFraudReasonCode(null)).toBe(false);
      expect(isFraudReasonCode(123)).toBe(false);
    });

    it('satisfies compile-time exhaustiveness check for ReasonCode', () => {
      function handleExhaustiveReason(reason: ReasonCode): string {
        switch (reason) {
          case FraudReasonCode.BURST_CLICK:
          case 'BURST_CLICK':
            return 'burst';
          case FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO:
          case 'HIGH_CLICK_CONVERSION_RATIO':
            return 'high_ratio';
          case FraudReasonCode.ABNORMAL_CONVERSION_RATIO:
          case 'ABNORMAL_CONVERSION_RATIO':
            return 'abnormal_ratio';
          case FraudReasonCode.RATE_LIMIT_EXCEEDED:
          case 'RATE_LIMIT_EXCEEDED':
          case FraudReasonCode.IP_RATE_LIMIT_EXCEEDED:
          case 'IP_RATE_LIMIT_EXCEEDED':
            return 'rate_limit';
          case FraudReasonCode.BLOCKED_IP:
          case 'BLOCKED_IP':
            return 'blocked';
          case FraudReasonCode.SUSPICIOUS_USER_AGENT:
          case 'SUSPICIOUS_USER_AGENT':
            return 'ua';
          case FraudReasonCode.RAPID_IDENTICAL_SESSION:
          case 'RAPID_IDENTICAL_SESSION':
            return 'session';
          case FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER:
          case 'AUTO_BLOCKED_REPEAT_OFFENDER':
            return 'auto_blocked';
          case FraudReasonCode.MANUAL_FLAG:
          case 'MANUAL_FLAG':
            return 'manual';
          default: {
            const _exhaustiveCheck: never = reason;
            return _exhaustiveCheck;
          }
        }
      }

      expect(handleExhaustiveReason('BURST_CLICK')).toBe('burst');
      expect(handleExhaustiveReason(FraudReasonCode.BLOCKED_IP)).toBe('blocked');
    });
  });

  describe('2. Review Actions & Workflow Lifecycle', () => {
    it('defines standard admin review actions and type guard', () => {
      expect(FRAUD_REVIEW_ACTIONS).toEqual(
        expect.arrayContaining(['approve', 'reject', 'block_ip', 'unblock_ip', 'bulk_resolve'])
      );

      expect(isFraudReviewAction('approve')).toBe(true);
      expect(isFraudReviewAction('reject')).toBe(true);
      expect(isFraudReviewAction('block_ip')).toBe(true);
      expect(isFraudReviewAction('unknown_action')).toBe(false);
    });

    it('defines review statuses and status guard', () => {
      expect(CLICK_REVIEW_STATUSES).toEqual(
        expect.arrayContaining(['pending', 'approved', 'rejected', 'ignored'])
      );

      expect(isClickReviewStatus('pending')).toBe(true);
      expect(isClickReviewStatus('approved')).toBe(true);
      expect(isClickReviewStatus('invalid_status')).toBe(false);
    });

    it('narrows discriminated union AdminFraudActionRequest exhaustively', () => {
      function processAction(req: AdminFraudActionRequest): string {
        switch (req.action) {
          case 'approve':
            return `Approved click ${req.clickId}`;
          case 'reject':
            return `Rejected click ${req.clickId} (blockIp: ${req.blockIpAlso ?? false})`;
          case 'block_ip':
            return `Blocked IP ${req.ipAddress}`;
          case 'unblock_ip':
            return `Unblocked IP ${req.ipAddress}`;
          case 'bulk_resolve':
          case 'bulk_approve':
          case 'bulk_reject':
            return `Bulk resolved ${req.clickIds.length} clicks`;
          case 'dismiss':
            return `Dismissed click ${req.clickId}`;
          default: {
            const _exhaustiveCheck: never = req;
            return _exhaustiveCheck;
          }
        }
      }

      expect(processAction({ action: 'approve', clickId: 'c1', reason: 'Legit' })).toBe(
        'Approved click c1'
      );
      expect(
        processAction({ action: 'block_ip', ipAddress: '10.0.0.1', reason: 'Bot' })
      ).toBe('Blocked IP 10.0.0.1');
    });
  });

  describe('3. Database Record Contracts & Structural Compatibility', () => {
    it('DealClickRow is structurally compatible with base DealClick interface', () => {
      const row: DealClickRow = {
        id: 'click-1',
        deal_id: 'deal-1',
        affiliate_code: 'aff-code-1',
        affiliate_id: 'usr-1',
        session_id: 'sess-1',
        ip_address: '198.51.100.1',
        user_agent: 'Mozilla/5.0',
        referrer_url: 'https://google.com',
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: '2026-09-25T10:00:00Z',
        is_suspicious: 1,
        anomaly_score: 0.85,
        flag_reasons: JSON.stringify(['BURST_CLICK']),
        review_status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
      };

      // Compatibility check: DealClick requires tracking columns
      const baseClick: DealClick = {
        id: row.id,
        deal_id: row.deal_id,
        affiliate_code: row.affiliate_code,
        affiliate_id: row.affiliate_id,
        session_id: row.session_id,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
        referrer_url: row.referrer_url,
        country_code: row.country_code,
        device_type: row.device_type,
        click_type: 'link',
        is_unique: row.is_unique,
        created_at: row.created_at,
      };

      expect(baseClick.id).toBe('click-1');
      expect(row.is_suspicious).toBe(1);
    });

    it('BlockedIpRecord and HydratedBlockedIp contract structure', () => {
      const rawRecord: BlockedIpRecord = {
        id: 'b-1',
        ip_address: '198.51.100.99',
        reason: 'Rate limit violation',
        blocked_by: 'system',
        created_at: '2026-09-25T10:00:00Z',
        expires_at: null,
        is_active: 1,
      };

      const hydrated: HydratedBlockedIp = {
        id: rawRecord.id,
        ipAddress: rawRecord.ip_address,
        reason: rawRecord.reason,
        blockedBy: rawRecord.blocked_by,
        blockedAt: rawRecord.created_at!,
        expiresAt: rawRecord.expires_at,
        isActive: rawRecord.is_active === 1,
        metadata: {},
        createdAt: rawRecord.created_at!,
        updatedAt: rawRecord.created_at!,
      };

      expect(hydrated.isActive).toBe(true);
      expect(hydrated.ipAddress).toBe('198.51.100.99');
    });

    it('FraudReviewRecord and HydratedFraudReview contract structure', () => {
      const rawRecord: FraudReviewRecord = {
        id: 'rev-1',
        click_id: 'click-1',
        ip_address: '198.51.100.99',
        reviewer_id: 'usr-admin-1',
        action: 'approve',
        reason: 'Confirmed real trader',
        created_at: '2026-09-25T10:00:00Z',
      };

      const hydrated: HydratedFraudReview = {
        id: rawRecord.id,
        clickId: rawRecord.click_id,
        ipAddress: rawRecord.ip_address,
        reviewerId: rawRecord.reviewer_id!,
        reviewerEmail: 'admin@apex-os.com',
        action: 'approve',
        reason: rawRecord.reason,
        previousStatus: 'pending',
        newStatus: 'approved',
        anomalyScore: 0.8,
        flagReasons: ['BURST_CLICK'],
        metadata: {},
        createdAt: rawRecord.created_at,
      };

      expect(hydrated.action).toBe('approve');
      expect(hydrated.flagReasons).toContain('BURST_CLICK');
    });
  });

  describe('4. Rate Limiter and Velocity Contracts', () => {
    it('DualWindowRateLimitResult contract structure', () => {
      const res: DualWindowRateLimitResult = {
        allowed: false,
        hourlyRemaining: 0,
        dailyRemaining: 450,
        hourlyLimit: 100,
        dailyLimit: 1000,
        hourlyResetAt: 1727260800,
        dailyResetAt: 1727318400,
        retryAfter: 1800,
        exceededWindow: 'hourly',
        isBlocked: false,
        autoBlocked: false,
        reason: 'Hourly rate limit exceeded (100 clicks/hour)',
      };

      expect(res.allowed).toBe(false);
      expect(res.exceededWindow).toBe('hourly');
      expect(res.retryAfter).toBe(1800);
    });

    it('VelocityCheckResult contract structure', () => {
      const result: VelocityCheckResult = {
        isSuspicious: true,
        anomalyScore: 0.95,
        flagReasons: ['BURST_CLICK', 'HIGH_CLICK_CONVERSION_RATIO'],
        burstDetected: true,
        burstDetails: {
          previousClickId: 'prev-1',
          previousClickTimestamp: '2026-09-25T10:00:01Z',
          deltaMs: 450,
          matchedBy: 'ip',
        },
        ratioAnomalyDetected: true,
        ratioDetails: {
          affiliateCode: 'aff-suspicious',
          dealId: 'deal-1',
          totalClicks: 250,
          totalConversions: 2,
          clickToConvRatio: 125,
          convToClickRatio: 0.008,
          lookbackWindowHours: 24,
        },
        rateLimitViolated: false,
        isIpBlocked: false,
      };

      expect(result.isSuspicious).toBe(true);
      expect(result.anomalyScore).toBe(0.95);
      expect(result.burstDetails?.deltaMs).toBe(450);
      expect(result.ratioDetails?.clickToConvRatio).toBe(125);
    });
  });

  describe('5. JSON Serialization & Utility Helpers', () => {
    it('losslessly serializes and parses reason codes arrays', () => {
      const input: ReasonCode[] = ['BURST_CLICK', 'HIGH_CLICK_CONVERSION_RATIO'];
      const serialized = serializeReasons(input);
      expect(typeof serialized).toBe('string');

      const parsed = parseReasons(serialized);
      expect(parsed).toEqual(input);
    });

    it('gracefully handles invalid JSON in parseReasons', () => {
      expect(parseReasons(null)).toEqual([]);
      expect(parseReasons(undefined)).toEqual([]);
      expect(parseReasons('not valid json')).toEqual([]);
      expect(parseReasons(JSON.stringify(['INVALID_REASON', 'BURST_CLICK']))).toEqual([
        'BURST_CLICK',
      ]);
    });

    it('serializes and parses arbitrary metadata objects safely', () => {
      const meta = { ip: '1.2.3.4', attempts: 5, tags: ['bot', 'crawler'] };
      const serialized = serializeMetadata(meta);
      const parsed = parseMetadata(serialized);

      expect(parsed).toEqual(meta);
      expect(parseMetadata(null)).toEqual({});
      expect(parseMetadata('invalid json')).toEqual({});
    });
  });

  describe('6. Zod Schema Boundary Validation', () => {
    it('validates FraudReasonCodeSchema and rejects invalid reason codes', () => {
      expect(FraudReasonCodeSchema.parse('BURST_CLICK')).toBe('BURST_CLICK');
      expect(FraudReasonCodeSchema.parse('RATE_LIMIT_EXCEEDED')).toBe('RATE_LIMIT_EXCEEDED');
      expect(() => FraudReasonCodeSchema.parse('NON_EXISTENT')).toThrow();
    });

    it('validates FraudReviewActionSchema and rejects invalid actions', () => {
      expect(FraudReviewActionSchema.parse('approve')).toBe('approve');
      expect(FraudReviewActionSchema.parse('reject')).toBe('reject');
      expect(FraudReviewActionSchema.parse('block_ip')).toBe('block_ip');
      expect(() => FraudReviewActionSchema.parse('hack_db')).toThrow();
    });

    it('validates AdminFraudActionSchema payloads', () => {
      const validPayload = {
        action: 'approve',
        clickId: 'click-123',
        reason: 'Legitimate marketing campaign verified',
      };
      const result = AdminFraudActionSchema.parse(validPayload);
      expect(result.action).toBe('approve');

      // Short reason fails constraint (<3 chars)
      expect(() =>
        AdminFraudActionSchema.parse({
          action: 'approve',
          clickId: 'c1',
          reason: 'ok',
        })
      ).toThrow();
    });

    it('validates CreateBlockedIpSchema payloads', () => {
      const valid = {
        ipAddress: '198.51.100.77',
        reason: 'Repeated brute force click abuse',
      };
      const parsed = CreateBlockedIpSchema.parse(valid);
      expect(parsed.ipAddress).toBe('198.51.100.77');

      // Empty IP fails
      expect(() =>
        CreateBlockedIpSchema.parse({
          ipAddress: '',
          reason: 'Valid reason here',
        })
      ).toThrow();
    });
  });
});
