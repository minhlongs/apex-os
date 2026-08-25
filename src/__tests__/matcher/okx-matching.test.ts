/**
 * OKX-Specific Matching Tests
 * Covers: commission tiers, trade volume math, referral tree levels
 * OKX signature verification is tested in okx-verification.test.ts
 * OKX user matching via API key is handled in the webhook route directly
 */

import { createMatcher, calculateTierCommission } from '@/lib/tracking/matcher';
import type { Database } from '@/lib/tracking/matcher';
import type { AffiliateDeal } from '@/types/deal';
import type { ReferralTree } from '@/types/affiliate';

class MockDB implements Database {
  private deal: AffiliateDeal | null;
  private click: any;
  private referralTree: ReferralTree | null;
  private emailResult: any;

  constructor(overrides: {
    deal?: AffiliateDeal | null;
    click?: any;
    referralTree?: ReferralTree | null;
    emailResult?: any;
  } = {}) {
    this.deal = overrides.deal !== undefined ? overrides.deal : mockOkxDeal();
    this.click = overrides.click !== undefined ? overrides.click : mockOkxClick();
    this.referralTree = overrides.referralTree !== undefined ? overrides.referralTree : mockOkxReferralTree();
    this.emailResult = overrides.emailResult !== undefined ? overrides.emailResult : mockOkxProfile();
  }

  prepare(sql: string) {
    return {
      bind: (...params: any[]) => ({
        first: async <T = any>(): Promise<T | undefined> => {
          return this.executeFirst(sql, params) as T | undefined;
        },
        all: async <T = any>(): Promise<T[]> => [],
        run: async (): Promise<{ success: boolean }> => ({ success: true }),
      }),
    };
  }

  private executeFirst(sql: string, params: any[]): any {
    const trimmed = sql.trim().replace(/\s+/g, ' ');

    if (trimmed.includes('FROM profiles WHERE email')) {
      return this.emailResult;
    }
    if (trimmed.includes('FROM deals WHERE id')) {
      return this.deal;
    }
    if (trimmed.includes('FROM deal_clicks WHERE deal_id')) {
      return this.click;
    }
    // referral_tree query via referral code — return null to simulate no tree
    if (trimmed.includes('FROM referral_tree rt JOIN profiles')) {
      return this.referralTree;
    }
    // referral_tree direct lookup (fallback path)
    if (trimmed.includes('FROM referral_tree') && !trimmed.includes('JOIN')) {
      return this.referralTree;
    }
    return null;
  }

  execute(sql: string, params?: any[]): Promise<{ success: boolean }> {
    return Promise.resolve({ success: true });
  }
}

function mockOkxProfile() {
  return {
    id: 'okx-profile-1',
    email: 'okx-user@example.com',
    full_name: 'OKX Test User',
    avatar_url: null,
    role: 'shopper',
    plan: 'free',
    referral_code: 'OKXREF1',
    referred_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function mockOkxDeal(): AffiliateDeal {
  return {
    id: 'okx-deal-1',
    slug: 'okx-spot-cashback',
    name: 'OKX Spot Cashback',
    description: 'Earn cashback on OKX spot trades',
    deal_type: 'product',
    product_id: null,
    url: 'https://okx.com',
    default_commission_rate: 0.10,
    default_commission_type: 'percentage',
    fixed_commission_amount: 0,
    cookie_duration_days: 30,
    is_active: 1,
    starts_at: null,
    ends_at: null,
    metadata: '{}',
    created_by: null,
    exchange: 'okx',
    category: 'spot',
    cashback_percent: 10,
    risk_level: 'low',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function mockOkxClick() {
  return {
    id: 'okx-click-1',
    deal_id: 'okx-deal-1',
    affiliate_code: 'OKXREF1',
    affiliate_id: 'okx-affiliate-1',
    session_id: 'okx-session-1',
    ip_address_hash: 'hash1',
    user_agent_hash: 'hash2',
    country_code: 'VN',
    device_type: 'desktop',
    click_type: 'link',
    is_unique: 1,
    created_at: new Date().toISOString(),
  };
}

function mockOkxReferralTree(): ReferralTree {
  return {
    id: 'okx-tree-1',
    affiliate_id: 'okx-affiliate-1',
    parent_id: 'okx-affiliate-2',
    root_id: 'okx-affiliate-3',
    level: 3,
    path: 'okx-affiliate-3/okx-affiliate-2/okx-affiliate-1',
    total_direct_referrals: 5,
    total_indirect_referrals: 20,
    total_earnings: 500,
    total_payouts: 400,
    is_active: 1,
    joined_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe('OKX Matching', () => {
  describe('OKX trade volume calculation', () => {
    test('calculates volume as sz * px (BTC 0.01 @ $60000)', () => {
      const sz = 0.01;
      const px = 60000;
      const volume = sz * px;
      expect(volume).toBeCloseTo(600, 5);
    });

    test('calculates volume for ETH trade', () => {
      const sz = 2.5;
      const px = 3000;
      const volume = sz * px;
      expect(volume).toBeCloseTo(7500, 5);
    });

    test('handles small trade volumes', () => {
      const sz = 0.001;
      const px = 60000;
      const volume = sz * px;
      expect(volume).toBeCloseTo(60, 5);
    });
  });

  describe('OKX commission tiers', () => {
    test('3-tier commission: 30/10/5 on 1000 USDT with 10% rate', async () => {
      const mockDB = new MockDB();
      const matcher = createMatcher(mockDB as unknown as Database);
      const result = await matcher.match({
        dealId: 'okx-deal-1',
        userIdentifier: 'okx-user@example.com',
        tradeVolumeUsd: 1000,
      });

      expect(result.commissions).toHaveLength(3);
      expect(result.commissions[0].level).toBe(1);
      expect(result.commissions[0].amount).toBeCloseTo(30, 5);
      expect(result.commissions[1].level).toBe(2);
      expect(result.commissions[1].amount).toBeCloseTo(10, 5);
      expect(result.commissions[2].level).toBe(3);
      expect(result.commissions[2].amount).toBeCloseTo(5, 5);
      expect(result.totalCommission).toBeCloseTo(45, 5);
    });

    test('2-tier commission when tree level is 2', async () => {
      const tree: ReferralTree = {
        ...mockOkxReferralTree(),
        level: 2,
        path: 'okx-affiliate-2/okx-affiliate-1',
      };
      const mockDB = new MockDB({ referralTree: tree });
      const matcher = createMatcher(mockDB as unknown as Database);
      const result = await matcher.match({
        dealId: 'okx-deal-1',
        userIdentifier: 'okx-user@example.com',
        tradeVolumeUsd: 1000,
      });

      expect(result.commissions).toHaveLength(2);
      expect(result.commissions[0].amount).toBeCloseTo(30, 5);
      expect(result.commissions[1].amount).toBeCloseTo(10, 5);
    });

    test('no commission without referral tree', async () => {
      const mockDB = new MockDB({ referralTree: null });
      const matcher = createMatcher(mockDB as unknown as Database);
      const result = await matcher.match({
        dealId: 'okx-deal-1',
        userIdentifier: 'okx-user@example.com',
        tradeVolumeUsd: 1000,
      });

      expect(result.commissions).toHaveLength(0);
      expect(result.totalCommission).toBe(0);
    });
  });

  describe('calculateTierCommission', () => {
    test('tier 1: 30% of 10% deal rate on 1000 USDT = 30', () => {
      expect(calculateTierCommission(1000, 0.10, 0.30)).toBeCloseTo(30, 5);
    });

    test('tier 2: 10% of 10% deal rate on 1000 USDT = 10', () => {
      expect(calculateTierCommission(1000, 0.10, 0.10)).toBeCloseTo(10, 5);
    });

    test('tier 3: 5% of 10% deal rate on 1000 USDT = 5', () => {
      expect(calculateTierCommission(1000, 0.10, 0.05)).toBeCloseTo(5, 5);
    });

    test('returns 0 for zero volume', () => {
      expect(calculateTierCommission(0, 0.10, 0.30)).toBe(0);
    });

    test('returns 0 for zero tier rate', () => {
      expect(calculateTierCommission(1000, 0.10, 0)).toBe(0);
    });
  });
});
