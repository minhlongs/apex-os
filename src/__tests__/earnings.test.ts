/**
 * Earnings Calculator - Extended Test Suite
 * ApexOS Affiliate Cashback System
 *
 * Additional edge cases, integration scenarios, and error handling tests
 */

import {
  EarningsCalculator,
  createEarningsCalculator,
  DEFAULT_TIER_RATES,
  Conversion,
  ReferralNode,
  AffiliateProfile,
  EarningsRecord,
  BatchOptions,
  AffiliateEarningsSummary,
} from '@/lib/earnings/calculator';

describe('EarningsCalculator - Extended Tests', () => {
  let calculator: EarningsCalculator;

  beforeEach(() => {
    calculator = createEarningsCalculator();
  });

  describe('processConversion', () => {
    const makeReferralTreeMap = (): Map<string, ReferralNode> => {
      return new Map([
        ['a1', { id: 'tree1', affiliate_id: 'a1', parent_id: null, root_id: 'tree1', level: 1, path: 'a1', is_active: 1 }],
        ['a2', { id: 'tree2', affiliate_id: 'a2', parent_id: 'a1', root_id: 'tree1', level: 2, path: 'a1:a2', is_active: 1 }],
        ['a3', { id: 'tree3', affiliate_id: 'a3', parent_id: 'a2', root_id: 'tree1', level: 3, path: 'a1:a2:a3', is_active: 1 }],
      ]);
    };

    const makeProfilesMap = (): Map<string, AffiliateProfile> => {
      return new Map([
        ['a1', { id: 'a1', email: 'a1@test.com', full_name: 'Affiliate 1', role: 'affiliate', referral_code: 'REF1' }],
        ['a2', { id: 'a2', email: 'a2@test.com', full_name: 'Affiliate 2', role: 'affiliate', referral_code: 'REF2' }],
        ['a3', { id: 'a3', email: 'a3@test.com', full_name: 'Affiliate 3', role: 'affiliate', referral_code: 'REF3' }],
      ]);
    };

    it('should skip existing earnings when already processed', () => {
      const referralTreeMap = makeReferralTreeMap();
      const profilesMap = makeProfilesMap();

      const conversion: Conversion = {
        id: 'conv1',
        deal_id: 'deal1',
        affiliate_id: 'a2',
        revenue: 1000,
        currency: 'USD',
        commission_amount: 300,
        commission_type: 'percentage',
        conversion_type: 'sale',
        status: 'approved',
        conversion_data: '{}',
        converted_at: new Date().toISOString(),
        approved_at: null,
        rejected_at: null,
        refunded_at: null,
        notes: null,
        deal_click_id: null,
        affiliate_code: null,
        customer_id: null,
        order_id: null,
      };

      const existingEarnings = new Set<string>(['conv1:a2']);

      const records = calculator.processConversion(
        conversion,
        referralTreeMap,
        profilesMap,
        existingEarnings
      );

      expect(records.length).toBe(1);
      expect(records[0].affiliate_id).toBe('a1');
      expect(records[0].level).toBe(2);
    });

    it('should skip earnings when profile not found', () => {
      const referralTreeMap = makeReferralTreeMap();
      const profilesWithoutA4 = new Map<string, AffiliateProfile>([
        ['a1', { id: 'a1', email: 'a1@test.com', full_name: 'Affiliate 1', role: 'affiliate', referral_code: 'REF1' }],
        ['a2', { id: 'a2', email: 'a2@test.com', full_name: 'Affiliate 2', role: 'affiliate', referral_code: 'REF2' }],
        ['a3', { id: 'a3', email: 'a3@test.com', full_name: 'Affiliate 3', role: 'affiliate', referral_code: 'REF3' }],
      ]);

      const conversion: Conversion = {
        id: 'conv1',
        deal_id: 'deal1',
        affiliate_id: 'a3',
        revenue: 1000,
        currency: 'USD',
        commission_amount: 300,
        commission_type: 'percentage',
        conversion_type: 'sale',
        status: 'approved',
        conversion_data: '{}',
        converted_at: new Date().toISOString(),
        approved_at: null,
        rejected_at: null,
        refunded_at: null,
        notes: null,
        deal_click_id: null,
        affiliate_code: null,
        customer_id: null,
        order_id: null,
      };

      const extendedTree = new Map<string, ReferralNode>([
        ...makeReferralTreeMap(),
        ['a4', { id: 'tree4', affiliate_id: 'a4', parent_id: 'a3', root_id: 'tree1', level: 4, path: 'a1:a2:a3:a4', is_active: 1 }],
      ]);

      const records = calculator.processConversion(
        conversion,
        extendedTree,
        profilesWithoutA4,
        new Set()
      );

      expect(records.length).toBe(3);
      expect(records.map(r => r.affiliate_id)).not.toContain('a4');
    });

    it('should handle fixed commission type', () => {
      const referralTreeMap = makeReferralTreeMap();
      const profilesMap = makeProfilesMap();

      const conversion: Conversion = {
        id: 'conv1',
        deal_id: 'deal1',
        affiliate_id: 'a3',
        revenue: 1000,
        currency: 'USD',
        commission_amount: 100,
        commission_type: 'fixed',
        conversion_type: 'sale',
        status: 'approved',
        conversion_data: '{}',
        converted_at: new Date().toISOString(),
        approved_at: null,
        rejected_at: null,
        refunded_at: null,
        notes: null,
        deal_click_id: null,
        affiliate_code: null,
        customer_id: null,
        order_id: null,
      };

      const records = calculator.processConversion(
        conversion,
        referralTreeMap,
        profilesMap,
        new Set()
      );

      expect(records.length).toBe(3);
      expect(records[0].amount).toBe(30); // 100 * 0.30
      expect(records[1].amount).toBe(10); // 100 * 0.10
      expect(records[2].amount).toBe(5);  // 100 * 0.05
    });

    it('should generate unique IDs for each earning record', () => {
      const referralTreeMap = makeReferralTreeMap();
      const profilesMap = makeProfilesMap();

      const conversion: Conversion = {
        id: 'conv1',
        deal_id: 'deal1',
        affiliate_id: 'a1',
        revenue: 1000,
        currency: 'USD',
        commission_amount: 300,
        commission_type: 'percentage',
        conversion_type: 'sale',
        status: 'approved',
        conversion_data: '{}',
        converted_at: new Date().toISOString(),
        approved_at: null,
        rejected_at: null,
        refunded_at: null,
        notes: null,
        deal_click_id: null,
        affiliate_code: null,
        customer_id: null,
        order_id: null,
      };

      const records = calculator.processConversion(
        conversion,
        referralTreeMap,
        profilesMap,
        new Set()
      );

      const ids = records.map(r => r.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should set correct metadata on earnings records', () => {
      const referralTreeMap = makeReferralTreeMap();
      const profilesMap = makeProfilesMap();

      const now = new Date().toISOString();
      const conversion: Conversion = {
        id: 'conv1',
        deal_id: 'deal1',
        affiliate_id: 'a1',
        revenue: 1000,
        currency: 'USD',
        commission_amount: 300,
        commission_type: 'percentage',
        conversion_type: 'sale',
        status: 'approved',
        conversion_data: '{}',
        converted_at: now,
        approved_at: null,
        rejected_at: null,
        refunded_at: null,
        notes: null,
        deal_click_id: null,
        affiliate_code: null,
        customer_id: null,
        order_id: null,
      };

      const records = calculator.processConversion(
        conversion,
        referralTreeMap,
        profilesMap,
        new Set()
      );

      records.forEach(record => {
        expect(record.conversion_id).toBe('conv1');
        expect(record.commission_type).toBe('percentage');
        expect(record.is_paid).toBe(0);
        expect(record.paid_at).toBeNull();
        expect(record.payout_id).toBeNull();
        expect(record.earnings_period_start).toBeNull();
        expect(record.earnings_period_end).toBeNull();
        expect(record.parent_earnings_id).toBeNull();
        expect(record.created_at).toBeDefined();
        expect(record.updated_at).toBeDefined();
      });
    });
  });

  describe('lookupAncestors', () => {
    const makeReferralTreeMap = (): Map<string, ReferralNode> => {
      return new Map([
        ['a1', { id: 'tree1', affiliate_id: 'a1', parent_id: null, root_id: 'tree1', level: 1, path: 'a1', is_active: 1 }],
        ['a2', { id: 'tree2', affiliate_id: 'a2', parent_id: 'a1', root_id: 'tree1', level: 2, path: 'a1:a2', is_active: 1 }],
        ['a3', { id: 'tree3', affiliate_id: 'a3', parent_id: 'a2', root_id: 'tree1', level: 3, path: 'a1:a2:a3', is_active: 1 }],
        ['a4', { id: 'tree4', affiliate_id: 'a4', parent_id: 'a3', root_id: 'tree1', level: 4, path: 'a1:a2:a3:a4', is_active: 1 }],
      ]);
    };

    it('should return empty array for root node', () => {
      const referralTreeMap = makeReferralTreeMap();
      const ancestors = calculator.lookupAncestors('a1', referralTreeMap, 2);
      expect(ancestors).toHaveLength(0);
    });

    it('should return parent only when maxLevels is 1', () => {
      const referralTreeMap = makeReferralTreeMap();
      const ancestors = calculator.lookupAncestors('a2', referralTreeMap, 1);
      expect(ancestors).toHaveLength(1);
      expect(ancestors[0].affiliate_id).toBe('a1');
    });

    it('should respect maxLevels limit', () => {
      const referralTreeMap = makeReferralTreeMap();
      const ancestors = calculator.lookupAncestors('a4', referralTreeMap, 2);
      expect(ancestors).toHaveLength(2);
      expect(ancestors[0].affiliate_id).toBe('a3');
      expect(ancestors[1].affiliate_id).toBe('a2');
    });

    it('should handle non-existent affiliate', () => {
      const referralTreeMap = makeReferralTreeMap();
      const ancestors = calculator.lookupAncestors('nonexistent', referralTreeMap, 2);
      expect(ancestors).toHaveLength(0);
    });
  });

  describe('filterConversionsByDate', () => {
    it('should return all when no filters', () => {
      const conversions: Conversion[] = [
        createTestConversion('c1', new Date()),
        createTestConversion('c2', new Date(Date.now() - 86400000)),
      ];

      const filtered = calculator.filterConversionsByDate(conversions, null, null);
      expect(filtered).toHaveLength(2);
    });

    it('should handle null dates correctly', () => {
      const now = Date.now();
      const conversions: Conversion[] = [
        createTestConversion('c1', new Date(now - 86400000)),
        createTestConversion('c2', new Date(now)),
        createTestConversion('c3', new Date(now + 86400000)),
      ];

      const filtered = calculator.filterConversionsByDate(conversions, new Date(now - 43200000).toISOString(), null);
      expect(filtered).toHaveLength(2);
      expect(filtered.map(c => c.id).sort()).toEqual(['c2', 'c3']);
    });
  });

  describe('filterConversionsByMinCommission', () => {
    it('should filter by minimum commission', () => {
      const conversions: Conversion[] = [
        { ...createTestConversion('c1', new Date()), commission_amount: 5 },
        { ...createTestConversion('c2', new Date()), commission_amount: 50 },
        { ...createTestConversion('c3', new Date()), commission_amount: 100 },
      ];

      const filtered = calculator.filterConversionsByMinCommission(conversions, 50);
      expect(filtered).toHaveLength(2);
      expect(filtered.map(c => c.id).sort()).toEqual(['c2', 'c3']);
    });

    it('should handle zero minimum', () => {
      const conversions: Conversion[] = [
        { ...createTestConversion('c1', new Date()), commission_amount: 0 },
        { ...createTestConversion('c2', new Date()), commission_amount: 1 },
      ];

      const filtered = calculator.filterConversionsByMinCommission(conversions, 0);
      expect(filtered).toHaveLength(2);
    });
  });

  describe('calculateAffiliateSummary', () => {
    it('should handle empty arrays', () => {
      const summary = calculator.calculateAffiliateSummary([], []);
      expect(summary.total_earnings).toBe(0);
      expect(summary.pending_earnings).toBe(0);
      expect(summary.paid_earnings).toBe(0);
      expect(summary.conversions_count).toBe(0);
      expect(summary.breakdown).toHaveLength(0);
      expect(summary.last_earnings_at).toBeNull();
    });

    it('should calculate correct averages', () => {
      const now = new Date().toISOString();
      const earnings: EarningsRecord[] = [
        createEarningsRecord('e1', 'c1', 'a1', 30, now),
        createEarningsRecord('e2', 'c2', 'a1', 30, now),
        createEarningsRecord('e3', 'c3', 'a1', 10, now, 2),
      ];

      const conversions: Conversion[] = [
        createTestConversion('c1', new Date()),
        createTestConversion('c2', new Date()),
        createTestConversion('c3', new Date()),
      ];

      const summary = calculator.calculateAffiliateSummary(earnings, conversions);

      expect(summary.total_earnings).toBe(70);
      expect(summary.breakdown.find(b => b.level === 1)?.avg_amount).toBe(30);
      expect(summary.breakdown.find(b => b.level === 2)?.avg_amount).toBe(10);
    });

    it('should sort breakdown by level', () => {
      const now = new Date().toISOString();
      const earnings: EarningsRecord[] = [
        createEarningsRecord('e1', 'c1', 'a1', 30, now, 3),
        createEarningsRecord('e2', 'c2', 'a1', 10, now, 1),
        createEarningsRecord('e3', 'c3', 'a1', 5, now, 2),
      ];

      const conversions: Conversion[] = [
        createTestConversion('c1', new Date()),
        createTestConversion('c2', new Date()),
        createTestConversion('c3', new Date()),
      ];

      const summary = calculator.calculateAffiliateSummary(earnings, conversions);

      for (let i = 0; i < summary.breakdown.length - 1; i++) {
        expect(summary.breakdown[i].level).toBeLessThanOrEqual(summary.breakdown[i + 1].level);
      }
    });

    it('should track last earnings timestamp correctly', () => {
      const time1 = new Date('2024-01-01T10:00:00Z').toISOString();
      const time2 = new Date('2024-01-01T12:00:00Z').toISOString();
      const time3 = new Date('2024-01-01T11:00:00Z').toISOString();

      const earnings: EarningsRecord[] = [
        createEarningsRecord('e1', 'c1', 'a1', 30, time1),
        createEarningsRecord('e2', 'c2', 'a1', 10, time2),
        createEarningsRecord('e3', 'c3', 'a1', 5, time3),
      ];

      const conversions: Conversion[] = [
        createTestConversion('c1', new Date('2024-01-01T10:00:00Z')),
        createTestConversion('c2', new Date('2024-01-01T12:00:00Z')),
        createTestConversion('c3', new Date('2024-01-01T11:00:00Z')),
      ];

      const summary = calculator.calculateAffiliateSummary(earnings, conversions);
      expect(summary.last_earnings_at).toBe(time2);
    });
  });

  describe('Custom Tier Rates', () => {
    it('should handle different rate structures', () => {
      calculator.setTierRates({
        tier1_rate: 0.50,
        tier2_rate: 0.25,
        tier3_rate: 0.10,
      });

      const referralTreeMap = new Map<string, ReferralNode>([
        ['a1', { id: 'tree1', affiliate_id: 'a1', parent_id: null, root_id: 'tree1', level: 1, path: 'a1', is_active: 1 }],
        ['a2', { id: 'tree2', affiliate_id: 'a2', parent_id: 'a1', root_id: 'tree1', level: 2, path: 'a1:a2', is_active: 1 }],
        ['a3', { id: 'tree3', affiliate_id: 'a3', parent_id: 'a2', root_id: 'tree1', level: 3, path: 'a1:a2:a3', is_active: 1 }],
      ]);

      const profiles = new Map<string, AffiliateProfile>([
        ['a1', { id: 'a1', email: 'a1@test.com', full_name: 'A1', role: 'affiliate', referral_code: 'REF1' }],
        ['a2', { id: 'a2', email: 'a2@test.com', full_name: 'A2', role: 'affiliate', referral_code: 'REF2' }],
        ['a3', { id: 'a3', email: 'a3@test.com', full_name: 'A3', role: 'affiliate', referral_code: 'REF3' }],
      ]);

      const conversion: Conversion = {
        id: 'conv1',
        deal_id: 'deal1',
        affiliate_id: 'a3',
        revenue: 1000,
        currency: 'USD',
        commission_amount: 100,
        commission_type: 'percentage',
        conversion_type: 'sale',
        status: 'approved',
        conversion_data: '{}',
        converted_at: new Date().toISOString(),
        approved_at: null,
        rejected_at: null,
        refunded_at: null,
        notes: null,
        deal_click_id: null,
        affiliate_code: null,
        customer_id: null,
        order_id: null,
      };

      const records = calculator.processConversion(
        conversion,
        referralTreeMap,
        profiles,
        new Set()
      );

      expect(records.length).toBe(3);
      expect(records[0].amount).toBe(50); // 100 * 0.50 (tier1)
      expect(records[1].amount).toBe(25); // 100 * 0.25 (tier2)
      expect(records[2].amount).toBe(10); // 100 * 0.10 (tier3)
    });
  });

  describe('isConversionEligible', () => {
    const baseConversion = (status: Conversion['status']): Conversion => ({
      id: 'conv1',
      deal_id: 'deal1',
      affiliate_id: 'a1',
      revenue: 1000,
      currency: 'USD',
      commission_amount: 300,
      commission_type: 'percentage',
      conversion_type: 'sale',
      status,
      conversion_data: '{}',
      converted_at: new Date().toISOString(),
      approved_at: null,
      rejected_at: null,
      refunded_at: null,
      notes: null,
      deal_click_id: null,
      affiliate_code: null,
      customer_id: null,
      order_id: null,
    });

    const defaultOptions: BatchOptions = {
      batch_size: 100,
      start_date: null,
      end_date: null,
      min_commission_amount: 0,
      skip_existing: true,
    };

    it('should reject refunded conversions', () => {
      expect(calculator.isConversionEligible(baseConversion('refunded'), defaultOptions)).toBe(false);
    });

    it('should reject rejected conversions', () => {
      expect(calculator.isConversionEligible(baseConversion('rejected'), defaultOptions)).toBe(false);
    });

    it('should reject pending conversions', () => {
      expect(calculator.isConversionEligible(baseConversion('pending'), defaultOptions)).toBe(false);
    });

    it('should accept approved conversions', () => {
      expect(calculator.isConversionEligible(baseConversion('approved'), defaultOptions)).toBe(true);
    });
  });

  describe('Referral Tree Edge Cases', () => {
    it('should handle broken referral chain (missing parent)', () => {
      const brokenTree = new Map<string, ReferralNode>([
        ['a2', { id: 'tree2', affiliate_id: 'a2', parent_id: 'a1', root_id: 'tree2', level: 1, path: 'a2', is_active: 1 }],
      ]);

      const profiles = new Map<string, AffiliateProfile>([
        ['a2', { id: 'a2', email: 'a2@test.com', full_name: 'A2', role: 'affiliate', referral_code: 'REF2' }],
      ]);

      const conversion: Conversion = {
        id: 'conv1',
        deal_id: 'deal1',
        affiliate_id: 'a2',
        revenue: 1000,
        currency: 'USD',
        commission_amount: 300,
        commission_type: 'percentage',
        conversion_type: 'sale',
        status: 'approved',
        conversion_data: '{}',
        converted_at: new Date().toISOString(),
        approved_at: null,
        rejected_at: null,
        refunded_at: null,
        notes: null,
        deal_click_id: null,
        affiliate_code: null,
        customer_id: null,
        order_id: null,
      };

      const records = calculator.processConversion(
        conversion,
        brokenTree,
        profiles,
        new Set()
      );

      expect(records.length).toBe(1);
      expect(records[0].affiliate_id).toBe('a2');
      expect(records[0].level).toBe(1);
    });
  });

  describe('buildReferralTreeMap', () => {
    it('should handle empty array', () => {
      const map = calculator.buildReferralTreeMap([]);
      expect(map.size).toBe(0);
    });

    it('should overwrite duplicate affiliate_ids', () => {
      const nodes: ReferralNode[] = [
        { id: 'tree1', affiliate_id: 'a1', parent_id: null, root_id: 'tree1', level: 1, path: 'a1', is_active: 1 },
        { id: 'tree2', affiliate_id: 'a1', parent_id: 'tree1', root_id: 'tree1', level: 2, path: 'a1:a1', is_active: 1 },
      ];

      const map = calculator.buildReferralTreeMap(nodes);
      expect(map.size).toBe(1);
      expect(map.get('a1')?.id).toBe('tree2'); // Last one wins
    });
  });

  describe('buildProfilesMap', () => {
    it('should handle empty array', () => {
      const map = calculator.buildProfilesMap([]);
      expect(map.size).toBe(0);
    });
  });

  describe('buildExistingEarningsLookup', () => {
    it('should handle empty array', () => {
      const set = calculator.buildExistingEarningsLookup([]);
      expect(set.size).toBe(0);
    });

    it('should deduplicate same conversion-affiliate pair', () => {
      const existing: EarningsRecord[] = [
        createEarningsRecord('e1', 'c1', 'a1'),
        createEarningsRecord('e2', 'c1', 'a1'),
      ];

      const set = calculator.buildExistingEarningsLookup(existing);
      expect(set.size).toBe(1);
    });
  });
});

// Helper functions
function createTestConversion(id: string, date: Date): Conversion {
  return {
    id,
    deal_id: 'deal1',
    affiliate_id: 'a1',
    revenue: 1000,
    currency: 'USD',
    commission_amount: 300,
    commission_type: 'percentage',
    conversion_type: 'sale',
    status: 'approved',
    conversion_data: '{}',
    converted_at: date.toISOString(),
    approved_at: null,
    rejected_at: null,
    refunded_at: null,
    notes: null,
    deal_click_id: null,
    affiliate_code: null,
    customer_id: null,
    order_id: null,
  };
}

function createEarningsRecord(
  id: string,
  conversionId: string,
  affiliateId: string,
  amount?: number,
  createdAt?: string,
  level?: number
): EarningsRecord {
  return {
    id,
    conversion_id: conversionId,
    affiliate_id: affiliateId,
    referral_tree_id: null,
    amount: amount ?? 100,
    commission_type: 'percentage',
    commission_rate: 0.1,
    level: level ?? 1,
    parent_earnings_id: null,
    earnings_period_start: null,
    earnings_period_end: null,
    is_paid: 0,
    paid_at: null,
    payout_id: null,
    created_at: createdAt ?? new Date().toISOString(),
    updated_at: createdAt ?? new Date().toISOString(),
  };
}
