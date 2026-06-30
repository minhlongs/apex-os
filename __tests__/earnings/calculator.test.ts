/**
 * Earnings Calculator Tests
 * ApexOS Affiliate Cashback System
 */

import {
  EarningsCalculator,
  createEarningsCalculator,
  DEFAULT_TIER_RATES,
  BatchJobProgress,
  BatchJobStatusCode,
  Conversion,
  ReferralNode,
  AffiliateProfile,
  EarningsRecord,
} from '@/lib/earnings/calculator';

describe('EarningsCalculator', () => {
  let calculator: EarningsCalculator;

  beforeEach(() => {
    calculator = createEarningsCalculator();
  });

  describe('Configuration', () => {
    it('should use default tier rates', () => {
      const config = calculator.getConfig();
      expect(config.tierRates.tier1_rate).toBe(0.30);
      expect(config.tierRates.tier2_rate).toBe(0.10);
      expect(config.tierRates.tier3_rate).toBe(0.05);
    });

    it('should accept custom tier rates', () => {
      calculator.setTierRates({
        tier1_rate: 0.40,
        tier2_rate: 0.15,
        tier3_rate: 0.05,
      });
      const config = calculator.getConfig();
      expect(config.tierRates.tier1_rate).toBe(0.40);
      expect(config.tierRates.tier2_rate).toBe(0.15);
      expect(config.tierRates.tier3_rate).toBe(0.05);
    });

    it('should have default max referral depth of 3', () => {
      const config = calculator.getConfig();
      expect(config.maxReferralDepth).toBe(3);
    });
  });

  describe('calculateConversionEarnings', () => {
    const referralTree: Map<string, ReferralNode> = new Map([
      ['affiliate1', { id: 'tree1', affiliate_id: 'affiliate1', parent_id: null, root_id: 'tree1', level: 1, path: 'affiliate1', is_active: 1 }],
      ['affiliate2', { id: 'tree2', affiliate_id: 'affiliate2', parent_id: 'tree1', root_id: 'tree1', level: 2, path: 'affiliate1:affiliate2', is_active: 1 }],
      ['affiliate3', { id: 'tree3', affiliate_id: 'affiliate3', parent_id: 'tree2', root_id: 'tree1', level: 3, path: 'affiliate1:affiliate2:affiliate3', is_active: 1 }],
    ]);

    // Build a map of node ID to node for ancestor lookup
    const nodeIdToNode = new Map<string, ReferralNode>();
    referralTree.forEach((node, affiliateId) => {
      nodeIdToNode.set(node.id, node);
    });

    const getAncestors = (affiliateId: string, maxLevels: number): ReferralNode[] => {
      const node = referralTree.get(affiliateId);
      if (!node || !node.parent_id) return [];

      const ancestors: ReferralNode[] = [];
      let currentParentId = node.parent_id;

      for (let i = 0; i < maxLevels && currentParentId; i++) {
        const parentNode = nodeIdToNode.get(currentParentId);
        if (!parentNode) break;
        ancestors.push(parentNode);
        currentParentId = parentNode.parent_id;
      }

      return ancestors;
    };

    it('should calculate tier 1 earning for direct affiliate', () => {
      const conversion: Conversion = {
        id: 'conv1',
        deal_id: 'deal1',
        deal_click_id: null,
        affiliate_code: null,
        affiliate_id: 'affiliate1',
        customer_id: null,
        order_id: null,
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
      };

      const earnings = calculator.calculateConversionEarnings(conversion, referralTree, getAncestors);

      expect(earnings).toHaveLength(1);
      expect(earnings[0].amount).toBe(90); // 300 * 0.30
      expect(earnings[0].level).toBe(1);
      expect(earnings[0].affiliate_id).toBe('affiliate1');
    });

    it('should calculate tier 1 and tier 2 earnings', () => {
      const conversion: Conversion = {
        id: 'conv1',
        deal_id: 'deal1',
        deal_click_id: null,
        affiliate_code: null,
        affiliate_id: 'affiliate2',
        customer_id: null,
        order_id: null,
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
      };

      const earnings = calculator.calculateConversionEarnings(conversion, referralTree, getAncestors);

      expect(earnings).toHaveLength(2);
      expect(earnings[0].amount).toBe(90); // tier1: 300 * 0.30
      expect(earnings[0].level).toBe(1);
      expect(earnings[1].amount).toBe(30); // tier2: 300 * 0.10
      expect(earnings[1].level).toBe(2);
    });

    it('should calculate all three tiers', () => {
      const conversion: Conversion = {
        id: 'conv1',
        deal_id: 'deal1',
        deal_click_id: null,
        affiliate_code: null,
        affiliate_id: 'affiliate3',
        customer_id: null,
        order_id: null,
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
      };

      const earnings = calculator.calculateConversionEarnings(conversion, referralTree, getAncestors);

      expect(earnings).toHaveLength(3);
      expect(earnings[0].amount).toBe(90); // tier1: 300 * 0.30
      expect(earnings[1].amount).toBe(30); // tier2: 300 * 0.10
      expect(earnings[2].amount).toBe(15); // tier3: 300 * 0.05
    });

    it('should return empty array when affiliate not in referral tree', () => {
      const conversion: Conversion = {
        id: 'conv1',
        deal_id: 'deal1',
        deal_click_id: null,
        affiliate_code: null,
        affiliate_id: 'unknown',
        customer_id: null,
        order_id: null,
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
      };

      const earnings = calculator.calculateConversionEarnings(conversion, referralTree, getAncestors);
      expect(earnings).toHaveLength(0);
    });
  });

  describe('buildReferralTreeMap', () => {
    it('should build map from referral nodes', () => {
      const nodes: ReferralNode[] = [
        { id: 'tree1', affiliate_id: 'user1', parent_id: null, root_id: 'tree1', level: 1, path: 'user1', is_active: 1 },
        { id: 'tree2', affiliate_id: 'user2', parent_id: 'tree1', root_id: 'tree1', level: 2, path: 'user1:user2', is_active: 1 },
      ];

      const map = calculator.buildReferralTreeMap(nodes);

      expect(map.size).toBe(2);
      expect(map.get('user1')?.id).toBe('tree1');
      expect(map.get('user2')?.id).toBe('tree2');
    });
  });

  describe('buildProfilesMap', () => {
    it('should build map from profiles', () => {
      const profiles: AffiliateProfile[] = [
        { id: 'p1', email: 'test1@example.com', full_name: 'Test 1', role: 'affiliate', referral_code: 'REF1' },
        { id: 'p2', email: 'test2@example.com', full_name: 'Test 2', role: 'shopper', referral_code: null },
      ];

      const map = calculator.buildProfilesMap(profiles);

      expect(map.size).toBe(2);
      expect(map.get('p1')?.email).toBe('test1@example.com');
      expect(map.get('p2')?.email).toBe('test2@example.com');
    });
  });

  describe('buildExistingEarningsLookup', () => {
    it('should build set of conversion:affiliate keys', () => {
      const existing: EarningsRecord[] = [
        { id: 'e1', conversion_id: 'c1', affiliate_id: 'a1', referral_tree_id: null, amount: 10, commission_type: 'percentage', commission_rate: 0.1, level: 1, parent_earnings_id: null, earnings_period_start: null, earnings_period_end: null, is_paid: 0, paid_at: null, payout_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { id: 'e2', conversion_id: 'c1', affiliate_id: 'a2', referral_tree_id: null, amount: 5, commission_type: 'percentage', commission_rate: 0.1, level: 2, parent_earnings_id: null, earnings_period_start: null, earnings_period_end: null, is_paid: 0, paid_at: null, payout_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ];

      const set = calculator.buildExistingEarningsLookup(existing);

      expect(set.size).toBe(2);
      expect(set.has('c1:a1')).toBe(true);
      expect(set.has('c1:a2')).toBe(true);
    });
  });

  describe('isConversionEligible', () => {
    const approvedConversion: Conversion = {
      id: 'conv1',
      deal_id: 'deal1',
      deal_click_id: null,
      affiliate_code: null,
      affiliate_id: 'a1',
      customer_id: null,
      order_id: null,
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
    };

    it('should approve eligible conversions', () => {
      const options: Parameters<typeof calculator.isConversionEligible>[1] = {
        batch_size: 100,
        start_date: null,
        end_date: null,
        min_commission_amount: 0,
        skip_existing: true,
      };

      expect(calculator.isConversionEligible(approvedConversion, options)).toBe(true);
    });

    it('should reject non-approved conversions', () => {
      const pendingConversion = { ...approvedConversion, status: 'pending' as const };
      const options: Parameters<typeof calculator.isConversionEligible>[1] = {
        batch_size: 100,
        start_date: null,
        end_date: null,
        min_commission_amount: 0,
        skip_existing: true,
      };

      expect(calculator.isConversionEligible(pendingConversion, options)).toBe(false);
    });

    it('should reject conversions below minimum commission', () => {
      const lowCommission = { ...approvedConversion, commission_amount: 5 };
      const options: Parameters<typeof calculator.isConversionEligible>[1] = {
        batch_size: 100,
        start_date: null,
        end_date: null,
        min_commission_amount: 100,
        skip_existing: true,
      };

      expect(calculator.isConversionEligible(lowCommission, options)).toBe(false);
    });

    it('should respect start date filter', () => {
      const pastConversion = {
        ...approvedConversion,
        converted_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
      };
      const options: Parameters<typeof calculator.isConversionEligible>[1] = {
        batch_size: 100,
        start_date: new Date().toISOString(), // now
        end_date: null,
        min_commission_amount: 0,
        skip_existing: true,
      };

      expect(calculator.isConversionEligible(pastConversion, options)).toBe(false);
    });

    it('should respect end date filter', () => {
      const futureConversion = {
        ...approvedConversion,
        converted_at: new Date(Date.now() + 86400000).toISOString(), // 1 day in future
      };
      const options: Parameters<typeof calculator.isConversionEligible>[1] = {
        batch_size: 100,
        start_date: null,
        end_date: new Date().toISOString(), // now
        min_commission_amount: 0,
        skip_existing: true,
      };

      expect(calculator.isConversionEligible(futureConversion, options)).toBe(false);
    });
  });

  describe('filterConversionsByDate', () => {
    it('should filter by date range', () => {
      const now = Date.now();
      const conversions: Conversion[] = [
        {
          id: 'c1',
          deal_id: 'd1',
          affiliate_id: 'a1',
          revenue: 100,
          currency: 'USD',
          commission_amount: 30,
          commission_type: 'percentage',
          conversion_type: 'sale',
          status: 'approved',
          conversion_data: '{}',
          converted_at: new Date(now - 86400000).toISOString(),
          approved_at: null,
          rejected_at: null,
          refunded_at: null,
          notes: null,
          deal_click_id: null,
          affiliate_code: null,
          customer_id: null,
          order_id: null,
        },
        {
          id: 'c2',
          deal_id: 'd1',
          affiliate_id: 'a1',
          revenue: 100,
          currency: 'USD',
          commission_amount: 30,
          commission_type: 'percentage',
          conversion_type: 'sale',
          status: 'approved',
          conversion_data: '{}',
          converted_at: new Date(now).toISOString(),
          approved_at: null,
          rejected_at: null,
          refunded_at: null,
          notes: null,
          deal_click_id: null,
          affiliate_code: null,
          customer_id: null,
          order_id: null,
        },
      ];

      const filtered = calculator.filterConversionsByDate(conversions, new Date(now - 43200000).toISOString(), null);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('c2');
    });
  });

  describe('calculateAffiliateSummary', () => {
    it('should calculate summary correctly', () => {
      const earnings: EarningsRecord[] = [
        { id: 'e1', conversion_id: 'c1', affiliate_id: 'a1', referral_tree_id: null, amount: 30, commission_type: 'percentage', commission_rate: 0.3, level: 1, parent_earnings_id: null, earnings_period_start: null, earnings_period_end: null, is_paid: 0, paid_at: null, payout_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { id: 'e2', conversion_id: 'c2', affiliate_id: 'a1', referral_tree_id: null, amount: 10, commission_type: 'percentage', commission_rate: 0.1, level: 2, parent_earnings_id: null, earnings_period_start: null, earnings_period_end: null, is_paid: 0, paid_at: null, payout_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { id: 'e3', conversion_id: 'c3', affiliate_id: 'a1', referral_tree_id: null, amount: 5, commission_type: 'percentage', commission_rate: 0.05, level: 3, parent_earnings_id: null, earnings_period_start: null, earnings_period_end: null, is_paid: 1, paid_at: new Date().toISOString(), payout_id: 'p1', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ];

      const conversions: Conversion[] = [
        { id: 'c1', deal_id: 'd1', affiliate_id: 'a1', revenue: 100, currency: 'USD', commission_amount: 100, commission_type: 'percentage', conversion_type: 'sale', status: 'approved', conversion_data: '{}', converted_at: new Date().toISOString(), approved_at: null, rejected_at: null, refunded_at: null, notes: null, deal_click_id: null, affiliate_code: null, customer_id: null, order_id: null },
        { id: 'c2', deal_id: 'd1', affiliate_id: 'a1', revenue: 100, currency: 'USD', commission_amount: 100, commission_type: 'percentage', conversion_type: 'sale', status: 'approved', conversion_data: '{}', converted_at: new Date().toISOString(), approved_at: null, rejected_at: null, refunded_at: null, notes: null, deal_click_id: null, affiliate_code: null, customer_id: null, order_id: null },
        { id: 'c3', deal_id: 'd1', affiliate_id: 'a1', revenue: 100, currency: 'USD', commission_amount: 100, commission_type: 'percentage', conversion_type: 'sale', status: 'approved', conversion_data: '{}', converted_at: new Date().toISOString(), approved_at: null, rejected_at: null, refunded_at: null, notes: null, deal_click_id: null, affiliate_code: null, customer_id: null, order_id: null },
      ];

      const summary = calculator.calculateAffiliateSummary(earnings, conversions);

      expect(summary.total_earnings).toBe(45);
      expect(summary.pending_earnings).toBe(40);
      expect(summary.paid_earnings).toBe(5);
      expect(summary.conversions_count).toBe(3);
      expect(summary.breakdown).toHaveLength(3);
      expect(summary.breakdown[0].level).toBe(1);
      expect(summary.breakdown[0].total_amount).toBe(30);
    });
  });

  describe('Batch Job Registry', () => {
    it('should create and track batch jobs', () => {
      const tracker = calculator.createProgressTracker();
      const job = tracker.startJob({ batch_size: 50, min_commission_amount: 10, skip_existing: true });

      expect(job.job_id).toBeDefined();
      expect(job.status).toBe(BatchJobStatusCode.PENDING);
      expect(job.started_at).toBeDefined();
    });

    it('should list all jobs', () => {
      const tracker = calculator.createProgressTracker();
      tracker.startJob({ batch_size: 50, min_commission_amount: 10, skip_existing: true });
      tracker.startJob({ batch_size: 100, min_commission_amount: 5, skip_existing: false });

      const jobs = tracker.listJobs();
      expect(jobs.length).toBe(2);
    });

    it('should get job by id', () => {
      const tracker = calculator.createProgressTracker();
      const job = tracker.startJob({ batch_size: 50, min_commission_amount: 10, skip_existing: true });

      const retrieved = tracker.getJob(job.job_id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.job_id).toBe(job.job_id);
    });
  });
});
