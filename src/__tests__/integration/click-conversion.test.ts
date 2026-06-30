/**
 * Integration Tests: Click → Conversion Flow
 * ApexOS Affiliate Cashback System
 */

import { Matcher } from '@/lib/tracking/matcher';
import type { Database } from 'wrangler';

// ============================================
// Types
// ============================================

type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: 'shopper' | 'affiliate' | 'admin' | 'master_trader';
  plan: 'free' | 'starter' | 'growth' | 'premium' | 'master';
  referral_code: string | null;
  referred_by: string | null;
  created_at: string;
  updated_at: string;
};

type AffiliateDeal = {
  id: string;
  name: string;
  description: string | null;
  deal_type: 'product' | 'service' | 'subscription' | 'course';
  product_id: string | null;
  url: string;
  default_commission_rate: number;
  default_commission_type: 'percentage' | 'fixed';
  fixed_commission_amount: number;
  cookie_duration_days: number;
  is_active: number;
  starts_at: string | null;
  ends_at: string | null;
  metadata: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type DealClick = {
  id: string;
  deal_id: string;
  user_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  referrer_url: string | null;
  cookie_id: string;
  affiliate_code: string | null;
  affiliate_id: string | null;
  created_at: string;
};

type ReferralTreeRecord = {
  id: string;
  affiliate_id: string;
  parent_id: string | null;
  root_id: string | null;
  level: number;
  path: string;
  total_direct_referrals: number;
  total_indirect_referrals: number;
  total_earnings: number;
  total_payouts: number;
  is_active: number;
  joined_at: string;
  updated_at: string;
};

// ============================================
// Mock Database
// ============================================

function createMockDb(): Database {
  let profileByEmail: Profile | null = null;
  let profileByWallet: Profile | null = null;
  let dealById: AffiliateDeal | null = null;
  let clickByDeal: DealClick | null = null;
  let referralTreeByCode: ReferralTreeRecord | null = null;
  let profilesByIds: Profile[] = [];

  const db = {
    prepare: jest.fn().mockImplementation((sql: string) => ({
      bind: jest.fn().mockReturnValue({
        first: jest.fn(() => {
          if (sql.includes('profiles WHERE email')) return profileByEmail;
          if (sql.includes('wallet_connections')) return profileByWallet;
          if (sql.includes('deals WHERE id')) return dealById;
          if (sql.includes('deal_clicks')) return clickByDeal;
          if (sql.includes('referral_tree')) return referralTreeByCode;
          return null;
        }),
        all: jest.fn(() => profilesByIds),
        run: jest.fn().mockReturnValue({ success: true })
      })
    })),
    _setProfileByEmail: (p: Profile | null) => { profileByEmail = p; },
    _setProfileByWallet: (p: Profile | null) => { profileByWallet = p; },
    _setDeal: (d: AffiliateDeal | null) => { dealById = d; },
    _setClick: (c: DealClick | null) => { clickByDeal = c; },
    _setReferralTree: (r: ReferralTreeRecord | null) => { referralTreeByCode = r; },
    _setProfilesList: (pl: Profile[]) => { profilesByIds = pl; },
    _clear: () => {
      profileByEmail = null;
      profileByWallet = null;
      dealById = null;
      clickByDeal = null;
      referralTreeByCode = null;
      profilesByIds = [];
    }
  } as unknown as Database;

  return db;
}

// ============================================
// Test Fixtures
// ============================================

const customerId = 'customer-1';
const customerEmail = 'customer@example.com';

const customer: Profile = {
  id: customerId,
  email: customerEmail,
  full_name: 'Test Customer',
  avatar_url: null,
  role: 'shopper',
  plan: 'free',
  referral_code: null,
  referred_by: null,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

const directAffiliate: Profile = {
  id: 'affiliate-1',
  email: 'direct@example.com',
  full_name: 'Direct Affiliate',
  avatar_url: null,
  role: 'affiliate',
  plan: 'growth',
  referral_code: 'AFF1',
  referred_by: null,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

const level2Affiliate: Profile = {
  id: 'affiliate-2',
  email: 'level2@example.com',
  full_name: 'Level 2 Affiliate',
  avatar_url: null,
  role: 'affiliate',
  plan: 'growth',
  referral_code: 'AFF2',
  referred_by: 'affiliate-1',
  created_at: '2025-01-02T00:00:00Z',
  updated_at: '2025-01-02T00:00:00Z',
};

const level3Affiliate: Profile = {
  id: 'affiliate-3',
  email: 'level3@example.com',
  full_name: 'Level 3 Affiliate',
  avatar_url: null,
  role: 'affiliate',
  plan: 'growth',
  referral_code: 'AFF3',
  referred_by: 'affiliate-2',
  created_at: '2025-01-03T00:00:00Z',
  updated_at: '2025-01-03T00:00:00Z',
};

const dealId = 'deal-123';
const tradeVolume = 1000;

const mockDeal: AffiliateDeal = {
  id: dealId,
  name: 'Binance Spot Trading',
  description: 'Earn cashback on spot trades',
  deal_type: 'service',
  product_id: null,
  url: 'https://binance.com',
  default_commission_rate: 0.10,
  default_commission_type: 'percentage',
  fixed_commission_amount: 0,
  cookie_duration_days: 30,
  is_active: 1,
  starts_at: '2025-01-01T00:00:00Z',
  ends_at: null,
  metadata: '{}',
  created_by: 'admin-001',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

const now = new Date().toISOString();

const mockClick1: DealClick = {
  id: 'click-1',
  deal_id: dealId,
  user_id: customerId,
  ip_address: '192.168.1.1',
  user_agent: 'Mozilla/5.0',
  referrer_url: 'https://example.com',
  cookie_id: 'cookie-1',
  affiliate_code: 'AFF1',
  affiliate_id: 'affiliate-1',
  created_at: now,
};

const mockClick2: DealClick = {
  id: 'click-2',
  deal_id: dealId,
  user_id: customerId,
  ip_address: '192.168.1.1',
  user_agent: 'Mozilla/5.0',
  referrer_url: 'https://example.com',
  cookie_id: 'cookie-2',
  affiliate_code: 'AFF2',
  affiliate_id: 'affiliate-2',
  created_at: now,
};

const mockClick3: DealClick = {
  id: 'click-3',
  deal_id: dealId,
  user_id: customerId,
  ip_address: '192.168.1.1',
  user_agent: 'Mozilla/5.0',
  referrer_url: 'https://example.com',
  cookie_id: 'cookie-3',
  affiliate_code: 'AFF3',
  affiliate_id: 'affiliate-3',
  created_at: now,
};

const mockReferralTree1: ReferralTreeRecord = {
  id: 'tree-1',
  affiliate_id: 'affiliate-1',
  parent_id: null,
  root_id: 'affiliate-1',
  level: 1,
  path: 'affiliate-1',
  total_direct_referrals: 0,
  total_indirect_referrals: 0,
  total_earnings: 0,
  total_payouts: 0,
  is_active: 1,
  joined_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-06-01T00:00:00Z',
};

const mockReferralTree2: ReferralTreeRecord = {
  id: 'tree-2',
  affiliate_id: 'affiliate-2',
  parent_id: 'tree-1',
  root_id: 'tree-1',
  level: 2,
  path: 'affiliate-1/affiliate-2',
  total_direct_referrals: 0,
  total_indirect_referrals: 0,
  total_earnings: 0,
  total_payouts: 0,
  is_active: 1,
  joined_at: '2025-01-02T00:00:00Z',
  updated_at: '2025-06-01T00:00:00Z',
};

const mockReferralTree3: ReferralTreeRecord = {
  id: 'tree-3',
  affiliate_id: 'affiliate-3',
  parent_id: 'tree-2',
  root_id: 'tree-1',
  level: 3,
  path: 'affiliate-1/affiliate-2/affiliate-3',
  total_direct_referrals: 0,
  total_indirect_referrals: 0,
  total_earnings: 0,
  total_payouts: 0,
  is_active: 1,
  joined_at: '2025-01-03T00:00:00Z',
  updated_at: '2025-06-01T00:00:00Z',
};

function setupMockDb(
  db: Database,
  profile: Profile | null,
  deal: AffiliateDeal | null,
  click: DealClick | null,
  referralTree: ReferralTreeRecord | null,
  profilesList: Profile[] = []
) {
  (db as unknown as { _setProfileByEmail: (p: Profile | null) => void })._setProfileByEmail(profile);
  (db as unknown as { _setDeal: (d: AffiliateDeal | null) => void })._setDeal(deal);
  (db as unknown as { _setClick: (c: DealClick | null) => void })._setClick(click);
  (db as unknown as { _setReferralTree: (r: ReferralTreeRecord | null) => void })._setReferralTree(referralTree);
  (db as unknown as { _setProfilesList: (pl: Profile[]) => void })._setProfilesList(profilesList);
}

// ============================================
// Tests
// ============================================

describe('Click → Conversion Integration', () => {
  let db: Database;

  beforeEach(() => {
    db = createMockDb();
  });

  afterEach(() => {
    (db as unknown as { _clear: () => void })._clear();
  });

  describe('Scenario 1: Direct Attribution (Single Tier)', () => {
    it('should attribute conversion to direct referrer only', async () => {
      setupMockDb(db, customer, mockDeal, mockClick1, mockReferralTree1, [directAffiliate]);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.commissions).toHaveLength(1);
      expect(result.commissions[0].level).toBe(1);
      expect(result.commissions[0].affiliate.id).toBe('affiliate-1');
      expect(result.commissions[0].amount).toBeCloseTo(tradeVolume * 0.10 * 0.30, 2);
      expect(result.totalCommission).toBeCloseTo(30, 2);
      expect(result.metadata.clickFound).toBe(true);
      expect(result.metadata.referralFound).toBe(true);
      expect(result.metadata.method).toBe('cookie');
    });
  });

  describe('Scenario 2: Two-Level Referral Chain', () => {
    it('should split commission between level 1 (30%) and level 2 (10%)', async () => {
      setupMockDb(db, customer, mockDeal, mockClick2, mockReferralTree2, [level2Affiliate, directAffiliate]);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.commissions).toHaveLength(2);
      // Level 1 = direct referrer (affiliate-2)
      expect(result.commissions[0].level).toBe(1);
      expect(result.commissions[0].affiliate.id).toBe('affiliate-2');
      expect(result.commissions[0].amount).toBeCloseTo(tradeVolume * 0.10 * 0.30, 2);
      // Level 2 = parent (affiliate-1)
      expect(result.commissions[1].level).toBe(2);
      expect(result.commissions[1].affiliate.id).toBe('affiliate-1');
      expect(result.commissions[1].amount).toBeCloseTo(tradeVolume * 0.10 * 0.10, 2);
      expect(result.totalCommission).toBeCloseTo(40, 2);
    });
  });

  describe('Scenario 3: Three-Level Referral Chain', () => {
    it('should split commission across all 3 tiers (30% + 10% + 5%)', async () => {
      setupMockDb(db, customer, mockDeal, mockClick3, mockReferralTree3, [level3Affiliate, level2Affiliate, directAffiliate]);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.commissions).toHaveLength(3);
      // Level 1 = direct referrer (affiliate-3)
      expect(result.commissions[0].level).toBe(1);
      expect(result.commissions[0].affiliate.id).toBe('affiliate-3');
      expect(result.commissions[0].amount).toBeCloseTo(tradeVolume * 0.10 * 0.30, 2);
      // Level 2 = parent (affiliate-2)
      expect(result.commissions[1].level).toBe(2);
      expect(result.commissions[1].affiliate.id).toBe('affiliate-2');
      expect(result.commissions[1].amount).toBeCloseTo(tradeVolume * 0.10 * 0.10, 2);
      // Level 3 = grandparent (affiliate-1)
      expect(result.commissions[2].level).toBe(3);
      expect(result.commissions[2].affiliate.id).toBe('affiliate-1');
      expect(result.commissions[2].amount).toBeCloseTo(tradeVolume * 0.10 * 0.05, 2);
      expect(result.totalCommission).toBeCloseTo(45, 2);
    });
  });

  describe('Scenario 4: No Click Found', () => {
    it('should return zero commissions when no click found', async () => {
      setupMockDb(db, customer, mockDeal, null, null, []);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.user).not.toBeNull();
      expect(result.click).toBeNull();
      expect(result.metadata.clickFound).toBe(false);
      expect(result.referralTree).toBeNull();
      expect(result.metadata.referralFound).toBe(false);
      expect(result.commissions).toHaveLength(0);
      expect(result.totalCommission).toBe(0);
      expect(result.metadata.method).toBe('wallet');
    });
  });

  describe('Scenario 5: Click Without Referral Code', () => {
    it('should handle clicks with null affiliate_code', async () => {
      const clickNoRef: DealClick = {
        ...mockClick1,
        affiliate_code: null,
        affiliate_id: null,
      };

      setupMockDb(db, customer, mockDeal, clickNoRef, null, []);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.click).toEqual(clickNoRef);
      expect(result.metadata.clickFound).toBe(true);
      expect(result.metadata.referralFound).toBe(false);
      expect(result.commissions).toHaveLength(0);
      expect(result.metadata.method).toBe('cookie');
      expect(result.metadata.referralCode).toBeNull();
    });
  });

  describe('Scenario 6: Custom Tier Rates', () => {
    it('should use custom tier rates when configured', async () => {
      const customRates = { 1: 0.50, 2: 0.25, 3: 0.15 };

      setupMockDb(db, customer, mockDeal, mockClick3, mockReferralTree3, [level3Affiliate, level2Affiliate, directAffiliate]);

      const matcher = new Matcher(db, { tierRates: customRates });
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.commissions[0].amount).toBeCloseTo(tradeVolume * 0.10 * 0.50, 2);
      expect(result.commissions[1].amount).toBeCloseTo(tradeVolume * 0.10 * 0.25, 2);
      expect(result.commissions[2].amount).toBeCloseTo(tradeVolume * 0.10 * 0.15, 2);
      expect(result.totalCommission).toBeCloseTo(90, 2);
    });
  });

  describe('Scenario 7: Very Small Trade Volume', () => {
    it('should handle precision for tiny amounts', async () => {
      const smallVolume = 0.01;

      setupMockDb(db, customer, mockDeal, mockClick1, mockReferralTree1, [directAffiliate]);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: smallVolume,
      });

      expect(result.commissions).toHaveLength(1);
      expect(result.commissions[0].amount).toBeCloseTo(smallVolume * 0.10 * 0.30, 8);
      expect(result.totalCommission).toBeCloseTo(smallVolume * 0.10 * 0.30, 8);
    });
  });

  describe('Scenario 8: Click Outside Cookie Window', () => {
    it('should not attribute stale clicks', async () => {
      setupMockDb(db, customer, mockDeal, null, null, []);

      const matcher = new Matcher(db, { cookieDurationDays: 30 });
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.click).toBeNull();
      expect(result.metadata.clickFound).toBe(false);
      expect(result.commissions).toHaveLength(0);
    });
  });

  describe('Scenario 9: Inactive or Non-Existent Deal', () => {
    it('should handle missing deal', async () => {
      setupMockDb(db, customer, null, null, null, []);
      const matcher = new Matcher(db);
      const result = await matcher.match({ dealId, userIdentifier: customerEmail, tradeVolumeUsd: tradeVolume });
      expect(result.deal).toBeUndefined();
      expect(result.commissions).toHaveLength(0);
    });

    it('should handle inactive deal', async () => {
      const inactiveDeal: AffiliateDeal = { ...mockDeal, is_active: 0 };
      setupMockDb(db, customer, inactiveDeal, null, null, []);
      const matcher = new Matcher(db);
      const result = await matcher.match({ dealId, userIdentifier: customerEmail, tradeVolumeUsd: tradeVolume });
      expect(result.deal).toBeUndefined();
      expect(result.commissions).toHaveLength(0);
    });
  });

  describe('Scenario 10: User Not Found', () => {
    it('should handle unknown user', async () => {
      setupMockDb(db, null, mockDeal, null, null, []);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: 'unknown@example.com',
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.user).toBeNull();
      expect(result.click).toBeNull();
      expect(result.metadata.clickFound).toBe(false);
      expect(result.commissions).toHaveLength(0);
      expect(result.metadata.method).toBe('none');
    });
  });

  describe('Scenario 11: Enrich Commissions', () => {
    it('should populate affiliate profiles in commission tiers', async () => {
      setupMockDb(db, customer, mockDeal, mockClick3, mockReferralTree3, [level3Affiliate, level2Affiliate, directAffiliate]);

      const matcher = new Matcher(db);
      const commissions = matcher.calculateCommissions({
        deal: mockDeal,
        referralTree: mockReferralTree3,
        tradeVolumeUsd: 1000,
      });

      // Before enrichment, profiles have empty email
      expect(commissions[0].affiliate.email).toBe('');
      expect(commissions[1].affiliate.email).toBe('');
      expect(commissions[2].affiliate.email).toBe('');

      const enriched = await matcher.enrichCommissions(commissions);

      // Order: level1 = affiliate-3, level2 = affiliate-2, level3 = affiliate-1
      expect(enriched[0].affiliate.id).toBe('affiliate-3');
      expect(enriched[0].affiliate.email).toBe('level3@example.com');
      expect(enriched[1].affiliate.id).toBe('affiliate-2');
      expect(enriched[1].affiliate.email).toBe('level2@example.com');
      expect(enriched[2].affiliate.id).toBe('affiliate-1');
      expect(enriched[2].affiliate.email).toBe('direct@example.com');
    });
  });

  describe('Scenario 12: Fixed Commission Type', () => {
    it('should calculate fixed amount correctly', async () => {
      const fixedDeal: AffiliateDeal = {
        ...mockDeal,
        default_commission_type: 'fixed',
        fixed_commission_amount: 5.00,
      };

      setupMockDb(db, customer, fixedDeal, mockClick1, mockReferralTree1, [directAffiliate]);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.commissions).toHaveLength(1);
      expect(result.commissions[0].amount).toBeCloseTo(5.00 * 0.30, 2);
      expect(result.totalCommission).toBeCloseTo(1.50, 2);
    });
  });

  describe('Scenario 13: Deep Referral Chain Beyond Level 3', () => {
    it('should cap commissions at 3 levels (leaf upward)', async () => {
      const affiliate4: Profile = {
        ...level2Affiliate,
        id: 'affiliate-4',
        email: 'level4@example.com',
        full_name: 'Level 4 Affiliate',
        referral_code: 'AFF4',
        referred_by: 'affiliate-3',
        created_at: '2025-01-04T00:00:00Z',
        updated_at: '2025-01-04T00:00:00Z',
      };

      const affiliate5: Profile = {
        ...level3Affiliate,
        id: 'affiliate-5',
        email: 'level5@example.com',
        full_name: 'Level 5 Affiliate',
        referral_code: 'AFF5',
        referred_by: 'affiliate-4',
        created_at: '2025-01-05T00:00:00Z',
        updated_at: '2025-01-05T00:00:00Z',
      };

      const deepTree: ReferralTreeRecord = {
        id: 'tree-5',
        affiliate_id: 'affiliate-5',
        parent_id: 'tree-4',
        root_id: 'tree-1',
        level: 5,
        path: 'affiliate-1/affiliate-2/affiliate-3/affiliate-4/affiliate-5',
        total_direct_referrals: 0,
        total_indirect_referrals: 0,
        total_earnings: 0,
        total_payouts: 0,
        is_active: 1,
        joined_at: '2025-01-05T00:00:00Z',
        updated_at: '2025-06-01T00:00:00Z',
      };

      const clickDeep: DealClick = {
        ...mockClick1,
        affiliate_code: 'AFF5',
        affiliate_id: 'affiliate-5',
      };

      setupMockDb(
        db,
        customer,
        mockDeal,
        clickDeep,
        deepTree,
        [affiliate5, affiliate4, level3Affiliate, level2Affiliate, directAffiliate]
      );

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.commissions).toHaveLength(3);
      // Last 3 in path from end: affiliate-5 (level1), affiliate-4 (level2), affiliate-3 (level3)
      expect(result.commissions[0].affiliate.id).toBe('affiliate-5');
      expect(result.commissions[0].level).toBe(1);
      expect(result.commissions[1].affiliate.id).toBe('affiliate-4');
      expect(result.commissions[1].level).toBe(2);
      expect(result.commissions[2].affiliate.id).toBe('affiliate-3');
      expect(result.commissions[2].level).toBe(3);
    });
  });

  describe('Scenario 14: Zero Commission Rate', () => {
    it('should yield zero amounts when rate is zero', async () => {
      const zeroRateDeal: AffiliateDeal = { ...mockDeal, default_commission_rate: 0 };
      setupMockDb(db, customer, zeroRateDeal, mockClick1, mockReferralTree1, [directAffiliate]);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.commissions).toHaveLength(1);
      expect(result.commissions[0].amount).toBe(0);
      expect(result.totalCommission).toBe(0);
    });
  });

  describe('User Lookup', () => {
    it('should find user by wallet address', async () => {
      const walletUser: Profile = {
        ...customer,
        email: 'wallet@example.com',
      };

      (db as unknown as { _setProfileByWallet: (p: Profile | null) => void })._setProfileByWallet(walletUser);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: '0x1234567890abcdef1234567890abcdef12345678',
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.user?.email).toBe('wallet@example.com');
    });

    it('should find user by email', async () => {
      setupMockDb(db, customer, mockDeal, mockClick1, mockReferralTree1, [directAffiliate]);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: customerEmail,
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.user?.email).toBe(customerEmail);
    });

    it('should return null when user not found', async () => {
      (db as unknown as { _setProfileByEmail: (p: Profile | null) => void })._setProfileByEmail(null);

      const matcher = new Matcher(db);
      const result = await matcher.match({
        dealId,
        userIdentifier: 'missing@example.com',
        tradeVolumeUsd: tradeVolume,
      });

      expect(result.user).toBeNull();
      expect(result.metadata.method).toBe('none');
    });
  });

  describe('Commission Calculation Utilities', () => {
    it('getEffectiveRate returns correct default tier rates', () => {
      const matcher = new Matcher(db);
      expect(matcher.getEffectiveRate(0.10, 1)).toBeCloseTo(0.03, 5);
      expect(matcher.getEffectiveRate(0.10, 2)).toBeCloseTo(0.01, 5);
      expect(matcher.getEffectiveRate(0.10, 3)).toBeCloseTo(0.005, 5);
    });

    it('getEffectiveRate uses custom tier rates', () => {
      const customRates = { 1: 0.50, 2: 0.20, 3: 0.10 };
      const matcher = new Matcher(db, { tierRates: customRates });
      expect(matcher.getEffectiveRate(0.10, 1)).toBeCloseTo(0.05, 5);
      expect(matcher.getEffectiveRate(0.10, 2)).toBeCloseTo(0.02, 5);
      expect(matcher.getEffectiveRate(0.10, 3)).toBeCloseTo(0.01, 5);
    });
  });
});
