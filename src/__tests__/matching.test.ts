/**
 * Matching Algorithm Tests
 * ApexOS Affiliate Cashback System
 */

import { createMatcher, calculateTierCommission, isValidUserIdentifier } from '@/lib/tracking/matcher';
import type { Database } from '@/lib/tracking/matcher';
import type { AffiliateDeal } from '@/types/deal';
import type { Profile, DealClick, ReferralTree } from '@/types/affiliate';

// Simple mock that directly intercepts method calls
class MockDB implements Database {
  private user: Profile | null;
  private deal: AffiliateDeal | null;
  private click: DealClick | null;
  private referralTree: ReferralTree | null;
  private profiles: Profile[];

  constructor(overrides: {
    user?: Profile | null;
    deal?: AffiliateDeal | null;
    click?: DealClick | null;
    referralTree?: ReferralTree | null;
    profiles?: Profile[];
  } = {}) {
    this.user = overrides.user !== undefined ? overrides.user : mockProfile();
    this.deal = overrides.deal !== undefined ? overrides.deal : mockDeal();
    this.click = overrides.click !== undefined ? overrides.click : mockDealClick();
    this.referralTree = overrides.referralTree !== undefined ? overrides.referralTree : mockReferralTree();
    this.profiles = overrides.profiles ?? [mockProfile(), mockProfile()];
  }

  prepare(sql: string) {
    return {
      bind: (...params: any[]) => ({
        first: async <T = any>(): Promise<T | undefined> => {
          return this.executeFirst(sql, params) as T | undefined;
        },
        all: async <T = any>(): Promise<T[]> => {
          const result = this.executeFirst(sql, params);
          return (result?.results || result || []) as T[];
        },
        run: async (): Promise<{ success: boolean }> => ({ success: true }),
      }),
    };
  }

  private executeFirst(sql: string, params: any[]): any {
    const trimmed = sql.trim().replace(/\s+/g, ' ');

    // Email lookup: SELECT * FROM profiles WHERE email = ? LIMIT 1
    if (trimmed.includes('FROM profiles WHERE email')) {
      if (params[0] === 'user@example.com') {
        return this.user;
      }
      if (params[0] === 'nonexistent@example.com') {
        return null;
      }
      return this.user;
    }

    // Wallet lookup: SELECT p.* FROM profiles p JOIN wallet_connections wc ON p.id = wc.profile_id WHERE wc.wallet_address = ? AND wc.is_primary = 1 LIMIT 1
    if (trimmed.includes('JOIN wallet_connections') && trimmed.includes('wallet_address')) {
      if (params[0] === '0x1234567890abcdef1234567890abcdef12345678') {
        return this.user;
      }
      return null;
    }

    // Get deal: SELECT * FROM deals WHERE id = ?
    if (trimmed.includes('FROM deals WHERE id')) {
      if (params[0] === 'deal-123') {
        return this.deal;
      }
      if (params[0] === 'nonexistent') {
        return null;
      }
      return this.deal;
    }

    // Resolve click (optimized - two queries):
    // 1) SELECT * FROM deal_clicks WHERE deal_id = ? AND created_at >= ? AND affiliate_id = ? AND affiliate_code IS NOT NULL AND affiliate_code != '' ORDER BY created_at DESC LIMIT 1
    // 2) SELECT * FROM deal_clicks WHERE deal_id = ? AND created_at >= ? AND affiliate_code IS NOT NULL AND affiliate_code != '' ORDER BY created_at DESC LIMIT 1
    if (trimmed.includes('FROM deal_clicks WHERE deal_id') && trimmed.includes('affiliate_code')) {
      if (params[0] === 'deal-123' && (params[2] === 'profile-123' || params.length === 2)) {
        return this.click;
      }
      return this.click;
    }

    // Resolve referral tree (optimized - split OR):
    // First: SELECT rt.* FROM referral_tree rt JOIN profiles p ON rt.affiliate_id = p.id WHERE p.referral_code = ? LIMIT 1
    // Second: SELECT * FROM referral_tree WHERE affiliate_id = ? LIMIT 1
    if (trimmed.includes('FROM referral_tree') && trimmed.includes('JOIN profiles')) {
      if (params[0] === 'REF123' || params[1] === 'REF123') {
        return this.referralTree;
      }
      return this.referralTree;
    }

    // Get profiles by IDs (enrich): SELECT * FROM profiles WHERE id IN (?)
    if (trimmed.includes('FROM profiles WHERE id IN')) {
      const ids = params[0];
      if (Array.isArray(ids)) {
        return ids.map((id: string) => {
          const found = this.profiles.find(p => p.id === id);
          return found || null;
        }).filter(Boolean);
      }
      return this.profiles;
    }

    return null;
  }

  execute(sql: string, params?: any[]): Promise<{ success: boolean }> {
    return Promise.resolve({ success: true });
  }
}

function mockDeal(): AffiliateDeal {
  return {
    id: 'deal-123',
    slug: 'binance-spot-cashback',
    name: 'Binance Spot Cashback',
    description: 'Earn cashback on Binance spot trades',
    deal_type: 'product',
    product_id: null,
    url: 'https://binance.com',
    default_commission_rate: 0.10,
    default_commission_type: 'percentage',
    fixed_commission_amount: 0,
    cookie_duration_days: 30,
    is_active: 1,
    starts_at: null,
    ends_at: null,
    metadata: '{}',
    created_by: null,
    exchange: 'binance',
    category: 'spot',
    cashback_percent: 10,
    risk_level: 'low',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function mockProfile(): Profile {
  return {
    id: 'profile-123',
    email: 'user@example.com',
    full_name: 'Test User',
    avatar_url: null,
    role: 'shopper' as const,
    plan: 'free' as const,
    referral_code: 'REF123',
    referred_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function mockDealClick(): DealClick {
  return {
    id: 'click-123',
    deal_id: 'deal-123',
    affiliate_code: 'REF123',
    affiliate_id: 'profile-123',
    session_id: 'session-123',
    ip_address: '192.168.1.1',
    user_agent: 'Mozilla/5.0...',
    referrer_url: 'https://example.com',
    country_code: 'US',
    device_type: 'desktop' as const,
    click_type: 'link' as const,
    is_unique: 1,
    created_at: new Date().toISOString(),
  };
}

function mockReferralTree(): ReferralTree {
  return {
    id: 'tree-123',
    affiliate_id: 'profile-123',
    parent_id: 'profile-456',
    root_id: 'profile-789',
    level: 1,
    path: 'profile-789/profile-456/profile-123',
    total_direct_referrals: 5,
    total_indirect_referrals: 20,
    total_earnings: 1000,
    total_payouts: 800,
    is_active: 1,
    joined_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe('Matcher', () => {
  let matcher: ReturnType<typeof createMatcher>;

  beforeEach(() => {
    const mockDB = new MockDB({ user: mockProfile() });
    matcher = createMatcher(mockDB as unknown as Database);
  });

  describe('lookupUser', () => {
    test('should find user by email', async () => {
      const user = await matcher.lookupUser('user@example.com');
      expect(user).not.toBeNull();
      expect(user?.email).toBe('user@example.com');
    });

    test('should find user by wallet address (0x prefix)', async () => {
      const mockDB = new MockDB({ user: mockProfile() });
      const customMatcher = createMatcher(mockDB as unknown as Database);
      const user = await customMatcher.lookupUser('0x1234567890abcdef1234567890abcdef12345678');
      expect(user).not.toBeNull();
    });

    test('should return null for non-existent user', async () => {
      const mockDB = new MockDB({ user: null });
      const customMatcher = createMatcher(mockDB as unknown as Database);
      const user = await customMatcher.lookupUser('nonexistent@example.com');
      expect(user).toBeNull();
    });
  });

  describe('match', () => {
    test('should return no commission when deal not found', async () => {
      const mockDB = new MockDB({ deal: null });
      const customMatcher = createMatcher(mockDB as unknown as Database);
      const result = await customMatcher.match({
        dealId: 'nonexistent',
        userIdentifier: 'user@example.com',
        tradeVolumeUsd: 1000,
      });

      expect(result.totalCommission).toBe(0);
      expect(result.commissions).toHaveLength(0);
      expect(result.metadata.method).toBe('none');
    });

    test('should calculate commission with referral tree', async () => {
      const result = await matcher.match({
        dealId: 'deal-123',
        userIdentifier: 'user@example.com',
        tradeVolumeUsd: 1000,
      });

      expect(result.user).not.toBeNull();
      expect(result.click).not.toBeNull();
      expect(result.referralTree).not.toBeNull();
      expect(result.totalCommission).toBeGreaterThan(0);
    });

    test('should include metadata about match method', async () => {
      const result = await matcher.match({
        dealId: 'deal-123',
        userIdentifier: 'user@example.com',
        tradeVolumeUsd: 1000,
      });

      expect(result.metadata.method).toBe('cookie');
      expect(result.metadata.clickFound).toBe(true);
      expect(result.metadata.referralFound).toBe(true);
      expect(result.metadata.referralCode).toBe('REF123');
    });

    test('should return null click when no click found', async () => {
      const mockDB = new MockDB({ click: null });
      const customMatcher = createMatcher(mockDB as unknown as Database);
      const result = await customMatcher.match({
        dealId: 'deal-123',
        userIdentifier: 'user@example.com',
        tradeVolumeUsd: 1000,
      });
      expect(result.click).toBeNull();
      expect(result.metadata.method).toBe('wallet');
    });
  });

  describe('calculateCommissions', () => {
    test('should return empty array without referral tree', () => {
      const deal = mockDeal();
      const commissions = matcher.calculateCommissions({
        deal,
        referralTree: null,
        tradeVolumeUsd: 1000,
      });

      expect(commissions).toHaveLength(0);
    });

    test('should calculate 3-tier commissions correctly', () => {
      const deal = mockDeal();
      const tree: ReferralTree = {
        ...mockReferralTree(),
        path: 'profile-789/profile-456/profile-123',
      };

      const commissions = matcher.calculateCommissions({
        deal,
        referralTree: tree,
        tradeVolumeUsd: 1000,
      });

      expect(commissions).toHaveLength(3);
      expect(commissions[0].level).toBe(1);
      expect(commissions[0].amount).toBeCloseTo(30, 5);
      expect(commissions[1].level).toBe(2);
      expect(commissions[1].amount).toBeCloseTo(10, 5);
      expect(commissions[2].level).toBe(3);
      expect(commissions[2].amount).toBeCloseTo(5, 5);
    });

    test('should cap at 3 levels for commission', () => {
      const deal = mockDeal();
      const tree: ReferralTree = {
        ...mockReferralTree(),
        path: 'a/b/c/d/e/f', // 6 levels
      };

      const commissions = matcher.calculateCommissions({
        deal,
        referralTree: tree,
        tradeVolumeUsd: 1000,
      });

      expect(commissions).toHaveLength(3);
    });

    test('should use fixed commission when configured', () => {
      const deal: AffiliateDeal = {
        ...mockDeal(),
        default_commission_type: 'fixed',
        fixed_commission_amount: 50,
      };
      const tree: ReferralTree = { ...mockReferralTree(), path: 'profile-456/profile-123' };

      const commissions = matcher.calculateCommissions({
        deal,
        referralTree: tree,
        tradeVolumeUsd: 1000,
      });

      expect(commissions[0].amount).toBeCloseTo(15, 5);
      expect(commissions[1].amount).toBeCloseTo(5, 5);
    });

    test('should handle zero trade volume', () => {
      const deal = mockDeal();
      const tree: ReferralTree = { ...mockReferralTree(), path: 'profile-456/profile-123' };

      const commissions = matcher.calculateCommissions({
        deal,
        referralTree: tree,
        tradeVolumeUsd: 0,
      });

      expect(commissions).toHaveLength(2);
      expect(commissions[0].amount).toBe(0);
      expect(commissions[1].amount).toBe(0);
    });
  });

  describe('enrichCommissions', () => {
    test('should enrich with profile data', async () => {
      const mockDB = new MockDB({
        profiles: [
          { ...mockProfile(), id: 'profile-123' },
          { ...mockProfile(), id: 'profile-456', email: 'affiliate2@example.com' },
        ],
      });
      const customMatcher = createMatcher(mockDB as unknown as Database);

      const commissions = [
        {
          level: 1 as const,
          tierRate: 0.30,
          dealCashbackRate: 0.10,
          tradeVolumeUsd: 1000,
          amount: 30,
          affiliate: { id: 'profile-123', email: '' },
        },
        {
          level: 2 as const,
          tierRate: 0.10,
          dealCashbackRate: 0.10,
          tradeVolumeUsd: 1000,
          amount: 10,
          affiliate: { id: 'profile-456', email: '' },
        },
      ];

      const enriched = await customMatcher.enrichCommissions(commissions);
      expect(enriched[0].affiliate.email).toBe('user@example.com');
      expect(enriched[1].affiliate.email).toBe('affiliate2@example.com');
    });
  });

  describe('getEffectiveRate', () => {
    test('should calculate correct effective rate for each tier', () => {
      expect(matcher.getEffectiveRate(0.10, 1)).toBeCloseTo(0.03, 5);
      expect(matcher.getEffectiveRate(0.10, 2)).toBeCloseTo(0.01, 5);
      expect(matcher.getEffectiveRate(0.10, 3)).toBeCloseTo(0.005, 5);
    });

    test('should return 0 for invalid tier', () => {
      expect(matcher.getEffectiveRate(0.10, 0)).toBe(0);
      expect(matcher.getEffectiveRate(0.10, 4)).toBe(0);
    });
  });

  describe('calculateTierCommission', () => {
    test('should calculate commission correctly', () => {
      expect(calculateTierCommission(1000, 0.10, 0.30)).toBeCloseTo(30, 5);
      expect(calculateTierCommission(500, 0.20, 0.50)).toBeCloseTo(50, 5);
    });

    test('should return 0 for zero volume', () => {
      expect(calculateTierCommission(0, 0.10, 0.30)).toBe(0);
    });

    test('should return 0 for zero rates', () => {
      expect(calculateTierCommission(1000, 0, 0.30)).toBe(0);
      expect(calculateTierCommission(1000, 0.10, 0)).toBe(0);
    });
  });

  describe('isValidUserIdentifier', () => {
    test('should validate email format', () => {
      expect(isValidUserIdentifier('test@example.com')).toBe(true);
      expect(isValidUserIdentifier('user@domain.co.uk')).toBe(true);
      expect(isValidUserIdentifier('invalid')).toBe(false);
      expect(isValidUserIdentifier('missing@domain')).toBe(false);
      expect(isValidUserIdentifier('@nodomain.com')).toBe(false);
    });

    test('should validate EVM wallet address', () => {
      expect(isValidUserIdentifier('0x1234567890abcdef1234567890abcdef12345678')).toBe(true);
      expect(isValidUserIdentifier('0x123')).toBe(false);
      expect(isValidUserIdentifier('1234567890abcdef1234567890abcdef12345678')).toBe(false);
      expect(isValidUserIdentifier('0xGGG')).toBe(false);
    });

    test('should validate Solana wallet address', () => {
      const solanaAddr = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
      expect(isValidUserIdentifier(solanaAddr)).toBe(true);
      expect(isValidUserIdentifier('short')).toBe(false);
      expect(isValidUserIdentifier('invalidCharacters!@#$%')).toBe(false);
    });
  });
});
