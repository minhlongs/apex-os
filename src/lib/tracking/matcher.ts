/**
 * Matching Algorithm for Affiliate Attribution
 *
 * Core matching engine for ApexOS affiliate cashback system.
 * Handles: user lookup, click resolution, referral tree traversal, tiered commissions.
 *
 * Commission tiers: Tier1 (direct) = 30%, Tier2 = 10%, Tier3 = 5%
 */

// Minimal D1 Database interface for type safety
interface Statement<T = any> {
  bind(...params: any[]): Statement<T>;
  run(): Promise<{ success: boolean }>;
  first<U = T>(): Promise<U | undefined>;
  all<U = T>(): Promise<U[]>;
}

interface Database {
  prepare(sql: string): Statement;
  execute(sql: string, params?: any[]): Promise<{ success: boolean }>;
}

import type {
  Profile,
  WalletConnection,
  DealClick,
} from '@/types';
import type { AffiliateDeal } from '@/types/deal';
import type { ReferralTree } from '@/types/affiliate';
import { UserPlan, UserRole } from '@/types/profile';

// ============================================
// Types
// ============================================

/**
 * User identifier for matching - can be wallet address or email
 */
export type UserIdentifier = string;

/**
 * Match result - commission breakdown by tier
 */
export interface MatchResult {
  /** The matched user (customer who made the trade) */
  user: Profile | null;
  /** The click that attributed this trade */
  click: DealClick | null;
  /** The referral tree root (top-level affiliate) */
  referralTree: ReferralTree | null;
  /** Commission breakdown per tier */
  commissions: CommissionTier[];
  /** Total commission amount across all tiers */
  totalCommission: number;
  /** Metadata about the match */
  metadata: MatchMetadata;
}

/**
 * Single tier commission calculation
 */
export interface CommissionTier {
  /** Tier level: 1 (direct), 2, or 3 */
  level: 1 | 2 | 3;
  /** Affiliate profile receiving this commission */
  affiliate: Profile;
  /** Commission rate multiplier (0.30, 0.10, 0.05) */
  tierRate: number;
  /** Deal's base cashback percentage */
  dealCashbackRate: number;
  /** Calculated commission amount */
  amount: number;
  /** Trade volume this is based on */
  tradeVolumeUsd: number;
}

/**
 * Match metadata for debugging/auditing
 */
export interface MatchMetadata {
  /** Match method used */
  method: 'wallet' | 'email' | 'cookie' | 'none';
  /** Was a click found within window? */
  clickFound: boolean;
  /** Was a referral tree found? */
  referralFound: boolean;
  /** Referral code that was matched */
  referralCode: string | null;
  /** Days between click and trade */
  daysSinceClick: number | null;
  /** Cookie window in days */
  cookieWindowDays: number;
}

/**
 * Matcher configuration
 */
export interface MatcherConfig {
  /** Cookie duration in days (default: 30) */
  cookieDurationDays: number;
  /** Commission tier multipliers */
  tierRates: Record<1 | 2 | 3, number>;
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: MatcherConfig = {
  cookieDurationDays: 30,
  tierRates: {
    1: 0.30, // Direct referrer gets 30%
    2: 0.10, // Level 2 gets 10%
    3: 0.05, // Level 3 gets 5%
  },
};

// ============================================
// Matcher Class
// ============================================

/**
 * Core matching engine for affiliate attribution and commission calculation.
 *
 * Usage:
 * ```ts
 * const matcher = new Matcher(db);
 * const result = await matcher.match({
 *   dealId: 'deal-123',
 *   userIdentifier: '0x123...', // wallet or email
 *   tradeVolumeUsd: 1000,
 * });
 * ```
 */
export class Matcher {
  private db: Database;
  private config: MatcherConfig;

  constructor(db: Database, config: Partial<MatcherConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Main matching entry point
   * 1. Lookup user by wallet or email
   * 2. Resolve click attribution (cookie + click window)
   * 3. Traverse referral tree (up to 3 levels)
   * 4. Calculate tiered commissions
   */
  async match(params: {
    dealId: string;
    userIdentifier: UserIdentifier;
    tradeVolumeUsd: number;
  }): Promise<MatchResult> {
    const { dealId, userIdentifier, tradeVolumeUsd } = params;

    // Step 1: Lookup user
    const user = await this.lookupUser(userIdentifier);

    // Step 2: Get deal details
    const deal = await this.getDeal(dealId);
    if (!deal) {
      return {
        user: user,
        click: null,
        referralTree: null,
        commissions: [],
        totalCommission: 0,
        metadata: {
          method: 'none',
          clickFound: false,
          referralFound: false,
          referralCode: null,
          daysSinceClick: null,
          cookieWindowDays: this.config.cookieDurationDays,
        },
      };
    }

    // Step 3: Resolve click (only if user was found)
    const click = user ? await this.resolveClick(dealId, user.id) : null;

    // Step 4: Traverse referral tree if click found
    let referralTree: ReferralTree | null = null;
    let referralCode: string | null = null;
    let daysSinceClick: number | null = null;

    if (click?.affiliate_code) {
      referralCode = click.affiliate_code;
      const referralResult = await this.resolveReferralTree(referralCode);
      referralTree = referralResult.tree;
      daysSinceClick = referralResult.daysSinceClick;
    }

    // Step 5: Calculate commissions
    const commissions = this.calculateCommissions({
      deal,
      referralTree,
      tradeVolumeUsd,
    });

    // Step 6: Build result
    const totalCommission = commissions.reduce((sum, c) => sum + c.amount, 0);

    return {
      user,
      click,
      referralTree,
      commissions,
      totalCommission,
      metadata: {
        method: user ? (click ? 'cookie' : 'wallet') : 'none',
        clickFound: click !== null,
        referralFound: referralTree !== null,
        referralCode,
        daysSinceClick,
        cookieWindowDays: this.config.cookieDurationDays,
      },
    };
  }

  /**
   * Lookup user by wallet address or email
   */
  async lookupUser(identifier: UserIdentifier): Promise<Profile | null> {
    // Check if identifier is a wallet address (starts with 0x or base58 for solana)
    const isWallet = identifier.startsWith('0x') ||
                     identifier.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(identifier);

    if (isWallet) {
      // Lookup via wallet_connections table
      const walletResult = await this.db
        .prepare(`
          SELECT p.* FROM profiles p
          JOIN wallet_connections wc ON p.id = wc.profile_id
          WHERE wc.wallet_address = ?
          AND wc.is_primary = 1
          LIMIT 1
        `)
        .bind(identifier.toLowerCase())
        .first<Profile>();

      if (walletResult) {
        return walletResult;
      }
    }

    // Lookup by email (unique)
    const emailResult = await this.db
      .prepare('SELECT * FROM profiles WHERE email = ? LIMIT 1')
      .bind(identifier.toLowerCase())
      .first<Profile>();

    if (emailResult) {
      return emailResult;
    }

    return null;
  }

  /**
   * Resolve click attribution within cookie window
   * Matches clicks by session, IP, or user context within the configured window.
   *
   * Optimized: Uses two queries to avoid ORDER BY CASE which prevents index usage.
   * Priority order: affiliate_id match > any click with affiliate_code
   */
  private async resolveClick(dealId: string, userId: string): Promise<DealClick | null> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.cookieDurationDays);

    // Priority 1: Find clicks where this user IS the affiliate (direct attribution)
    // This uses idx_deal_clicks_deal_affiliate_created index efficiently
    const directResult = await this.db
      .prepare(`
        SELECT * FROM deal_clicks
        WHERE deal_id = ?
          AND created_at >= ?
          AND affiliate_id = ?
          AND affiliate_code IS NOT NULL
          AND affiliate_code != ''
          AND (is_suspicious = 0 OR is_suspicious IS NULL)
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .bind(dealId, cutoffDate.toISOString(), userId)
      .first<DealClick>();

    if (directResult) {
      return directResult;
    }

    // Priority 2: Find any click within the window (cookie-based attribution)
    // This uses idx_deal_clicks_deal_created_code index efficiently
    const anyResult = await this.db
      .prepare(`
        SELECT * FROM deal_clicks
        WHERE deal_id = ?
          AND created_at >= ?
          AND affiliate_code IS NOT NULL
          AND affiliate_code != ''
          AND (is_suspicious = 0 OR is_suspicious IS NULL)
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .bind(dealId, cutoffDate.toISOString())
      .first<DealClick>();

    return anyResult || null;
  }

  /**
   * Resolve referral tree from referral code
   * Returns the root node and path to calculate tier levels.
   *
   * Optimized: Split OR condition into two separate queries for better index usage.
   */
  private async resolveReferralTree(referralCode: string): Promise<{
    tree: ReferralTree | null;
    daysSinceClick: number | null;
  }> {
    // First, try to find by profile's referral_code
    // This uses idx_profiles_referral_code_id efficiently
    const node = await this.db
      .prepare(`
        SELECT rt.* FROM referral_tree rt
        JOIN profiles p ON rt.affiliate_id = p.id
        WHERE p.referral_code = ?
        LIMIT 1
      `)
      .bind(referralCode)
      .first<any>();

    if (node) {
      return this.buildReferralTreeResult(node);
    }

    // If not found by referral_code, try direct affiliate_id match
    // This uses idx_referral_tree_affiliate efficiently
    const nodeById = await this.db
      .prepare(`
        SELECT * FROM referral_tree
        WHERE affiliate_id = ?
        LIMIT 1
      `)
      .bind(referralCode)
      .first<any>();

    return nodeById ? this.buildReferralTreeResult(nodeById) : { tree: null, daysSinceClick: null };
  }

  /**
   * Helper to build ReferralTree result from raw node data
   */
  private buildReferralTreeResult(node: any): {
    tree: ReferralTree | null;
    daysSinceClick: number | null;
  } {
    // Parse path to determine levels
    // Path format: "root_id/parent_id/current_id" or "current_id"
    const pathSegments = node.path?.split('/') || [node.affiliate_id];
    const level = Math.min(pathSegments.length, 3); // Cap at 3 levels for commissions

    // Build tree node (internal representation, cast to any to bypass strict typing)
    const tree: any = {
      ...node,
      level: level as 1 | 2 | 3,
    };

    // Calculate days since the referral converted (approximate from tree updated_at)
    const daysSinceClick = node.updated_at
      ? (Date.now() - new Date(node.updated_at).getTime()) / (1000 * 60 * 60 * 24)
      : null;

    return { tree: tree as ReferralTree, daysSinceClick };
  }

  /**
   * Get affiliate profiles by their IDs (for commission recipients)
   */
  async getAffiliates(affiliateIds: string[]): Promise<Profile[]> {
    if (affiliateIds.length === 0) return [];

    const placeholders = affiliateIds.map(() => '?').join(',');
    const results = await this.db
      .prepare(`SELECT * FROM profiles WHERE id IN (${placeholders})`)
      .bind(...affiliateIds)
      .all<Profile>();

    return results;
  }

  /**
   * Get deal details
   */
  private async getDeal(dealId: string): Promise<AffiliateDeal | null> {
    const result = await this.db
      .prepare('SELECT * FROM deals WHERE id = ? AND is_active = 1 LIMIT 1')
      .bind(dealId)
      .first<AffiliateDeal>();

    return result || null;
  }

  /**
   * Calculate commissions based on deal and referral tree
   *
   * Formula: trade_volume × deal.default_commission_rate × tier_rate
   *
   * Tier distribution:
   * - Tier 1 (direct referrer): 30% of commission pool
   * - Tier 2: 10% of commission pool
   * - Tier 3: 5% of commission pool
   *
   * Note: Total payout = 45% of deal's commission rate
   * Example: 10% deal commission → 3% + 1% + 0.5% = 4.5% to affiliates, rest to platform
   */
  private calculateCommissions(params: {
    deal: AffiliateDeal;
    referralTree: ReferralTree | null;
    tradeVolumeUsd: number;
  }): CommissionTier[] {
    const { deal, referralTree, tradeVolumeUsd } = params;

    // If no referral tree, no commissions
    if (!referralTree) {
      return [];
    }

    const commissions: CommissionTier[] = [];
    // Determine base amount based on commission type
    const baseCommission = deal.default_commission_type === 'fixed'
      ? deal.fixed_commission_amount
      : tradeVolumeUsd * deal.default_commission_rate;

    // Get the path to determine which tiers are applicable
    // The referralTree already has level capped at 3
    const path = referralTree.path?.split('/') || [];
    const levelsInPath = Math.min(path.length, 3);

    // For each level in the path (going up from current)
    // Level 1 = direct parent, Level 2 = grandparent, Level 3 = great-grandparent
    for (let i = 1; i <= levelsInPath; i++) {
      const level = i as 1 | 2 | 3;
      const tierRate = this.config.tierRates[level];
      const affiliateId = path[path.length - i];

      // We need to fetch the affiliate profile - this will be done by caller
      // For now, create a placeholder that will be enriched
      commissions.push({
        level,
        tierRate,
        dealCashbackRate: deal.default_commission_rate,
        tradeVolumeUsd,
        amount: baseCommission * tierRate,
        affiliate: {
          id: affiliateId,
          email: '', // Will be populated via getAffiliates()
          full_name: null,
          avatar_url: null,
          role: UserRole.TRADER,
          plan: UserPlan.FREE,
          referral_code: null,
          referred_by: null,
          notification_settings: null,
          created_at: '',
          updated_at: '',
        },
      });
    }

    return commissions;
  }

  /**
   * Enrich commission tiers with actual affiliate profiles
   * Call after calculateCommissions to populate affiliate details.
   */
  async enrichCommissions(
    commissions: CommissionTier[]
  ): Promise<CommissionTier[]> {
    const affiliateIds = commissions.map(c => c.affiliate.id);
    const profiles = await this.getAffiliates(affiliateIds);

    const profileMap = new Map(profiles.map(p => [p.id, p]));

    return commissions.map(c => ({
      ...c,
      affiliate: profileMap.get(c.affiliate.id) || c.affiliate,
    }));
  }

  /**
   * Get the effective commission rate for a given tier level
   */
  getEffectiveRate(dealCommissionRate: number, tier: number): number {
    if (![1, 2, 3].includes(tier)) {
      return 0;
    }
    return dealCommissionRate * this.config.tierRates[tier as 1 | 2 | 3];
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a new Matcher instance
 */
export function createMatcher(
  db: Database,
  config?: Partial<MatcherConfig>
): Matcher {
  return new Matcher(db, config);
}

// ============================================
// Utility Functions
// ============================================

/**
 * Calculate commission amount for a single tier
 */
export function calculateTierCommission(
  tradeVolumeUsd: number,
  dealCommissionRate: number,
  tierRate: number
): number {
  return tradeVolumeUsd * dealCommissionRate * tierRate;
}

/**
 * Format commission as currency
 */
export function formatCommission(
  amount: number,
  currency: string = 'USD'
): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Validate user identifier format
 */
export function isValidUserIdentifier(identifier: string): boolean {
  if (!identifier || typeof identifier !== 'string') {
    return false;
  }

  // Email pattern
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (emailPattern.test(identifier)) {
    return true;
  }

  // Wallet address pattern (EVM: 0x..., Solana: base58)
  if (identifier.startsWith('0x') && identifier.length === 42) {
    return true;
  }

  // Solana base58 (simplified check)
  if (identifier.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(identifier)) {
    return true;
  }

  return false;
}
