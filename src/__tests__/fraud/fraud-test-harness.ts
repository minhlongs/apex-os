/**
 * Comprehensive Fraud Detection & Anomaly Engine Test Harness
 * Location: src/__tests__/fraud/fraud-test-harness.ts
 *
 * Implements:
 * 1. In-memory SQLite/D1 mock database (MockFraudDatabase) tracking all fraud-related tables:
 *    - deal_clicks, deals, conversions, blocked_ips, fraud_reviews, profiles,
 *      rate_limits, rate_limit_configs, wallet_connections, referral_tree
 * 2. Immutability trigger simulation for fraud_reviews table (prohibits UPDATE/DELETE)
 * 3. Prepared statements with positional parameter binding, first, all, run, and batch
 * 4. Request simulation with IP headers (cf-connecting-ip, x-forwarded-for, x-real-ip), cookies, and admin auth
 * 5. Dynamic route dispatcher and progressive testability helpers
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { NextRequest } from 'next/server';

// ============================================================================
// Row Types
// ============================================================================

export interface DealClickRow {
  id: string;
  deal_id: string;
  affiliate_code: string | null;
  affiliate_id: string | null;
  session_id: string;
  ip_address: string | null;
  user_agent: string | null;
  referrer_url: string | null;
  country_code: string | null;
  device_type: string | null;
  click_type: string;
  is_unique: number;
  is_suspicious?: number | null;
  flag_reasons?: string | null;
  anomaly_score?: number | null;
  review_status?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  created_at: string;
}

export type MockDealClickRow = DealClickRow;

export interface DealRow {
  id: string;
  url: string;
  title?: string;
  name?: string;
  is_active: number;
  default_commission_rate?: number;
  default_commission_type?: 'percentage' | 'fixed';
  fixed_commission_amount?: number;
  created_at: string;
}

export type MockDealRow = DealRow;

export interface ConversionRow {
  id: string;
  deal_id: string;
  affiliate_code: string | null;
  affiliate_id: string | null;
  user_id: string;
  amount: number;
  status: 'pending' | 'confirmed' | 'rejected' | string;
  created_at: string;
  converted_at?: string;
}

export type MockConversionRow = ConversionRow;

export interface BlockedIpRow {
  id: string;
  ip_address: string;
  reason: string;
  blocked_by: string;
  blocked_at: string;
  expires_at: string | null;
  is_active: number;
  metadata?: string | null;
  created_at: string;
  updated_at: string;
}

export type MockBlockedIpRow = BlockedIpRow;

export interface FraudReviewRow {
  id: string;
  click_id: string | null;
  ip_address?: string | null;
  reviewer_id: string;
  reviewed_by?: string | null;
  reviewer_email?: string | null;
  action: 'approve' | 'reject' | 'block_ip' | 'unblock_ip' | 'bulk_resolve' | 'bulk_approve' | 'bulk_reject' | 'dismiss' | string;
  action_type?: string;
  reason: string;
  previous_status?: string | null;
  new_status?: string | null;
  anomaly_score?: number | null;
  flag_reasons?: string | null;
  notes?: string | null;
  details?: string | null;
  metadata?: string | null;
  reviewed_at?: string | null;
  created_at: string;
}

export type MockFraudReviewRow = FraudReviewRow;

export interface MockRateLimitRow {
  id: number;
  key: string;
  endpoint_type: string;
  identifier: string;
  current_count: number;
  max_count: number;
  window_seconds: number;
  reset_at: string;
  created_at: string;
  updated_at: string;
}

export interface MockRateLimitConfigRow {
  id: number;
  endpoint_type: string;
  max_requests: number;
  window_seconds: number;
  applies_to: 'ip' | 'user' | 'api_key' | 'combined' | string;
  role_multiplier: number;
  tier_multiplier: number;
  description: string | null;
  is_active: number;
}

export interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  plan: string;
  tier: string;
  referral_code: string | null;
  created_at: string;
  updated_at: string;
}

export type MockProfileRow = ProfileRow;

export interface WalletConnectionRow {
  id: string;
  profile_id: string;
  wallet_address: string;
  preferred_chain: string;
  is_primary: number;
  connected_at: string;
  last_used_at: string | null;
}

export interface ReferralTreeRow {
  id: string;
  affiliate_id: string;
  parent_id: string | null;
  path: string;
  created_at: string;
  updated_at: string;
}

// Active request holder for next/headers mock
let currentActiveRequest: NextRequest | null = null;

export function setActiveTestRequest(req: NextRequest | null) {
  currentActiveRequest = req;
}

// ============================================================================
// In-Memory D1 Mock Database
// ============================================================================

export class MockFraudDatabase {
  public dealClicks: Map<string, DealClickRow> = new Map();
  public deals: Map<string, DealRow> = new Map();
  public conversions: Map<string, ConversionRow> = new Map();
  public blockedIps: Map<string, BlockedIpRow> = new Map();
  public fraudReviews: Map<string, FraudReviewRow> = new Map();
  public profiles: Map<string, ProfileRow> = new Map();
  public walletConnections: Map<string, WalletConnectionRow> = new Map();
  public referralTree: Map<string, ReferralTreeRow> = new Map();
  public rateLimits: Map<string, MockRateLimitRow> = new Map();
  public rateLimitConfigs: Map<string, MockRateLimitConfigRow> = new Map();
  private rateLimitAutoInc: number = 1;

  constructor() {
    this.reset();
  }

  public reset() {
    this.dealClicks.clear();
    this.deals.clear();
    this.conversions.clear();
    this.blockedIps.clear();
    this.fraudReviews.clear();
    this.profiles.clear();
    this.walletConnections.clear();
    this.referralTree.clear();
    this.rateLimits.clear();
    this.rateLimitConfigs.clear();
    this.rateLimitAutoInc = 1;

    // Default test deals
    this.deals.set('deal-active-1', {
      id: 'deal-active-1',
      url: 'https://partner-exchange.com/signup?aff=apex',
      title: 'Active Deal 1',
      name: 'Active Deal 1',
      is_active: 1,
      default_commission_rate: 0.1,
      default_commission_type: 'percentage',
      fixed_commission_amount: 0,
      created_at: '2026-01-01T00:00:00Z',
    });

    this.deals.set('deal-inactive-1', {
      id: 'deal-inactive-1',
      url: 'https://partner-exchange.com/expired',
      title: 'Inactive Deal',
      name: 'Inactive Deal',
      is_active: 0,
      default_commission_rate: 0.1,
      default_commission_type: 'percentage',
      fixed_commission_amount: 0,
      created_at: '2026-01-01T00:00:00Z',
    });

    this.deals.set('deal-binance-spot', {
      id: 'deal-binance-spot',
      url: 'https://binance.com/ref?code=APEX',
      title: 'Binance Spot Cashback',
      name: 'Binance Spot Cashback',
      is_active: 1,
      default_commission_rate: 0.2,
      default_commission_type: 'percentage',
      fixed_commission_amount: 0,
      created_at: '2026-01-01T00:00:00Z',
    });

    this.deals.set('deal-bybit-futures', {
      id: 'deal-bybit-futures',
      url: 'https://bybit.com/ref?code=APEXBY',
      title: 'Bybit Futures Discount',
      name: 'Bybit Futures Discount',
      is_active: 1,
      default_commission_rate: 0.15,
      default_commission_type: 'percentage',
      fixed_commission_amount: 0,
      created_at: '2026-01-01T00:00:00Z',
    });

    // Default test profiles
    this.profiles.set('usr-admin-1', {
      id: 'usr-admin-1',
      email: 'admin@apex-os.com',
      full_name: 'Apex Admin',
      role: 'admin',
      plan: 'enterprise',
      tier: 'MASTER',
      referral_code: 'ADMINREF',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    this.profiles.set('admin-001', {
      id: 'admin-001',
      email: 'admin@apex-os.com',
      full_name: 'Apex Admin Root',
      role: 'admin',
      plan: 'enterprise',
      tier: 'MASTER',
      referral_code: 'ADMINROOT',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    this.profiles.set('usr-affiliate-1', {
      id: 'usr-affiliate-1',
      email: 'affiliate1@apex-os.com',
      full_name: 'Top Affiliate',
      role: 'affiliate',
      plan: 'pro',
      tier: 'PREMIUM',
      referral_code: 'AFFILIATE1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    this.profiles.set('user-affiliate-001', {
      id: 'user-affiliate-001',
      email: 'affiliate1@apex-os.com',
      full_name: 'Top Affiliate Secondary',
      role: 'affiliate',
      plan: 'pro',
      tier: 'PREMIUM',
      referral_code: 'AFF1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    this.profiles.set('usr-trader-1', {
      id: 'usr-trader-1',
      email: 'trader1@apex-os.com',
      full_name: 'Trader One',
      role: 'trader',
      plan: 'free',
      tier: 'BASIC',
      referral_code: 'TRADER1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    // Default wallet connection for trader-1
    this.walletConnections.set('wc-1', {
      id: 'wc-1',
      profile_id: 'usr-trader-1',
      wallet_address: '0x1111111111111111111111111111111111111111',
      preferred_chain: 'ethereum',
      is_primary: 1,
      connected_at: '2026-01-01T00:00:00Z',
      last_used_at: '2026-01-01T00:00:00Z',
    });

    // Default referral tree for affiliate-1
    this.referralTree.set('rt-1', {
      id: 'rt-1',
      affiliate_id: 'usr-affiliate-1',
      parent_id: null,
      path: 'usr-affiliate-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    // Default rate limit configurations
    this.rateLimitConfigs.set('click_tracking:ip', {
      id: 1,
      endpoint_type: 'click_tracking',
      max_requests: 100,
      window_seconds: 3600,
      applies_to: 'ip',
      role_multiplier: 1.0,
      tier_multiplier: 1.0,
      description: 'Click tracking endpoint - 100 req/hour per IP',
      is_active: 1,
    });

    this.rateLimitConfigs.set('click_tracking:user', {
      id: 2,
      endpoint_type: 'click_tracking',
      max_requests: 1000,
      window_seconds: 3600,
      applies_to: 'user',
      role_multiplier: 1.0,
      tier_multiplier: 1.0,
      description: 'Click tracking - 1000 req/hour per user',
      is_active: 1,
    });
  }

  public prepare(sql: string) {
    const cleanSql = sql.replace(/\s+/g, ' ').trim();

    return {
      bind: (...params: any[]) => ({
        first: async <T = unknown>(): Promise<T | null> => {
          return this.executeFirst(cleanSql, params) as T | null;
        },
        all: async <T = unknown>(): Promise<{ results: T[]; meta: { last_row_id: number; changes: number; duration: number } }> => {
          const results = this.executeAll(cleanSql, params);
          return {
            results: results as T[],
            meta: { last_row_id: 0, changes: results.length, duration: 0 },
          };
        },
        run: async (): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }> => {
          const changes = this.executeRun(cleanSql, params);
          return { success: true, meta: { changes, last_row_id: 0 } };
        },
      }),
      first: async <T = unknown>(): Promise<T | null> => {
        return this.executeFirst(cleanSql, []) as T | null;
      },
      all: async <T = unknown>(): Promise<{ results: T[]; meta: { last_row_id: number; changes: number; duration: number } }> => {
        const results = this.executeAll(cleanSql, []);
        return {
          results: results as T[],
          meta: { last_row_id: 0, changes: results.length, duration: 0 },
        };
      },
      run: async (): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }> => {
        const changes = this.executeRun(cleanSql, []);
        return { success: true, meta: { changes, last_row_id: 0 } };
      },
    };
  }

  public async batch(statements: Array<{ run?: () => Promise<any>; first?: () => Promise<any>; all?: () => Promise<any> }>) {
    const results = [];
    for (const stmt of statements) {
      if (typeof stmt.run === 'function') {
        results.push(await stmt.run());
      } else if (typeof stmt.first === 'function') {
        results.push(await stmt.first());
      } else if (typeof stmt.all === 'function') {
        results.push(await stmt.all());
      } else {
        results.push({ success: true, meta: { changes: 1, last_row_id: 0, duration: 0 } });
      }
    }
    return results;
  }

  // ==========================================================================
  // SQL Execution Internals
  // ==========================================================================

  private executeFirst(sql: string, params: any[]): any | null {
    const upper = sql.toUpperCase();

    // 1. Rate limits bucket lookup: SELECT current_count, max_count, reset_at FROM rate_limits WHERE key = ?
    if (upper.includes('FROM RATE_LIMITS') && upper.includes('KEY =')) {
      const key = String(params[0] ?? '');
      const record = this.rateLimits.get(key);
      if (record) {
        return {
          current_count: record.current_count,
          max_count: record.max_count,
          reset_at: record.reset_at,
          window_seconds: record.window_seconds,
          identifier: record.identifier,
          endpoint_type: record.endpoint_type,
        };
      }
      return null;
    }

    // 2. Rate limit config lookup: SELECT * FROM rate_limit_configs WHERE endpoint_type = ? AND is_active = 1
    if (upper.includes('FROM RATE_LIMIT_CONFIGS') && upper.includes('ENDPOINT_TYPE =')) {
      const endpoint = String(params[0] ?? '');
      for (const config of this.rateLimitConfigs.values()) {
        if (config.endpoint_type === endpoint && config.is_active === 1) {
          return { ...config };
        }
      }
      return null;
    }

    // 3. Blocked IP check: SELECT ... FROM blocked_ips WHERE ip_address = ?
    if (upper.includes('FROM BLOCKED_IPS') && upper.includes('IP_ADDRESS =')) {
      const ip = String(params[0] ?? '');
      const blocked = this.blockedIps.get(ip);
      if (blocked) {
        if (upper.includes('IS_ACTIVE = 1')) {
          if (blocked.is_active === 1) {
            if (!blocked.expires_at || new Date(blocked.expires_at).getTime() > Date.now()) {
              return { ...blocked };
            }
          }
          return null;
        }
        return { ...blocked };
      }
      return null;
    }

    // 4. Deal lookup: SELECT id, url, is_active FROM deals WHERE id = ?
    if (upper.includes('FROM DEALS') && upper.includes('ID =')) {
      const dealId = String(params[0] ?? '');
      const deal = this.deals.get(dealId);
      return deal ? { ...deal } : null;
    }

    // 5. Profile lookup
    if (upper.includes('FROM PROFILES')) {
      if (upper.includes('WHERE ID = ?')) {
        const id = String(params[0] ?? '');
        const profile = this.profiles.get(id);
        return profile ? { ...profile } : null;
      }
      if (upper.includes('WHERE EMAIL = ?')) {
        const email = String(params[0] ?? '').toLowerCase();
        const profile = Array.from(this.profiles.values()).find(
          (p) => p.email.toLowerCase() === email
        );
        return profile ? { ...profile } : null;
      }
      if (upper.includes('REFERRAL_CODE = ?')) {
        const code = String(params[0] ?? '');
        const profile = Array.from(this.profiles.values()).find(
          (p) => p.referral_code === code
        );
        return profile ? { ...profile } : null;
      }
    }

    // Default: defer to executeAll
    const all = this.executeAll(sql, params);
    return all.length > 0 ? all[0] : null;
  }

  private executeAll(sql: string, params: any[]): any[] {
    const upper = sql.toUpperCase();

    // 1. SELECT from blocked_ips
    if (upper.includes('FROM BLOCKED_IPS')) {
      let rows = Array.from(this.blockedIps.values());
      if (upper.includes('WHERE IP_ADDRESS = ?')) {
        const ip = String(params[0] ?? '');
        rows = rows.filter((r) => r.ip_address === ip);
      }
      if (upper.includes('IS_ACTIVE = 1')) {
        rows = rows.filter((r) => r.is_active === 1 && (!r.expires_at || new Date(r.expires_at).getTime() > Date.now()));
      }
      if (upper.includes('ORDER BY CREATED_AT DESC') || upper.includes('ORDER BY BLOCKED_AT DESC')) {
        rows.sort((a, b) => new Date(b.created_at || b.blocked_at).getTime() - new Date(a.created_at || a.blocked_at).getTime());
      }
      return rows.map((r) => ({ ...r }));
    }

    // 2. SELECT from deals
    if (upper.includes('FROM DEALS')) {
      let rows = Array.from(this.deals.values());
      if (upper.includes('WHERE ID = ?')) {
        const dealId = String(params[0] ?? '');
        rows = rows.filter((r) => r.id === dealId);
      }
      if (upper.includes('IS_ACTIVE = 1')) {
        rows = rows.filter((r) => r.is_active === 1);
      }
      return rows.map((r) => ({ ...r }));
    }

    // 3. SELECT from profiles
    if (upper.includes('FROM PROFILES')) {
      let rows = Array.from(this.profiles.values());
      if (upper.includes('WHERE ID = ?')) {
        rows = rows.filter((r) => r.id === params[0]);
      } else if (upper.includes('WHERE EMAIL = ?')) {
        rows = rows.filter((r) => r.email.toLowerCase() === String(params[0]).toLowerCase());
      } else if (upper.includes('WHERE REFERRAL_CODE = ?') || upper.includes('WHERE P.REFERRAL_CODE = ?')) {
        rows = rows.filter((r) => r.referral_code === params[0]);
      }
      return rows.map((r) => ({ ...r }));
    }

    // 4. SELECT from wallet_connections
    if (upper.includes('FROM WALLET_CONNECTIONS') || upper.includes('JOIN WALLET_CONNECTIONS')) {
      if (upper.includes('WHERE WC.WALLET_ADDRESS = ?') || upper.includes('WHERE WALLET_ADDRESS = ?')) {
        const addr = String(params[0]).toLowerCase();
        const connection = Array.from(this.walletConnections.values()).find(
          (wc) => wc.wallet_address.toLowerCase() === addr && wc.is_primary === 1
        );
        if (connection) {
          const profile = this.profiles.get(connection.profile_id);
          return profile ? [{ ...profile }] : [];
        }
        return [];
      }
    }

    // 5. SELECT from referral_tree
    if (upper.includes('FROM REFERRAL_TREE')) {
      let rows = Array.from(this.referralTree.values());
      if (upper.includes('WHERE AFFILIATE_ID = ?')) {
        rows = rows.filter((r) => r.affiliate_id === params[0]);
      }
      return rows.map((r) => ({ ...r }));
    }

    // 6. SELECT COUNT(*) from deal_clicks
    if (upper.includes('SELECT COUNT(*)') && upper.includes('FROM DEAL_CLICKS')) {
      let rows = Array.from(this.dealClicks.values());

      if (upper.includes('IP_ADDRESS = ?') && !upper.includes('IS_SUSPICIOUS = 1')) {
        const ip = params[0];
        rows = rows.filter((r) => r.ip_address === ip);
        if (upper.includes('CREATED_AT >= ?')) {
          const since = new Date(params[1]).getTime();
          rows = rows.filter((r) => new Date(r.created_at).getTime() >= since);
        }
        return [{ count: rows.length, 'COUNT(*)': rows.length, total: rows.length }];
      } else if (upper.includes('DEAL_ID = ?') && !upper.includes('IS_SUSPICIOUS = 1')) {
        const dealId = params[0];
        rows = rows.filter((r) => r.deal_id === dealId);
        if (upper.includes('AFFILIATE_CODE = ?')) {
          const affCode = params[1];
          rows = rows.filter((r) => r.affiliate_code === affCode);
        }
        return [{ count: rows.length, 'COUNT(*)': rows.length, total: rows.length }];
      } else if (upper.includes('AFFILIATE_CODE = ?') && !upper.includes('IS_SUSPICIOUS = 1')) {
        const affCode = params[0];
        rows = rows.filter((r) => r.affiliate_code === affCode);
        return [{ count: rows.length, 'COUNT(*)': rows.length, total: rows.length }];
      }

      if (
        upper.includes('WHERE') &&
        (upper.includes('IS_SUSPICIOUS = 1') || upper.includes('REVIEW_STATUS = ?') || upper.includes('REVIEW_STATUS IS NOT NULL'))
      ) {
        if (upper.includes('IS_SUSPICIOUS = 1 OR REVIEW_STATUS IS NOT NULL') || upper.includes('IS_SUSPICIOUS = 1 OR (REVIEW_STATUS IS NOT NULL')) {
          rows = rows.filter((r) => r.is_suspicious === 1 || (r.review_status !== null && r.review_status !== undefined && r.review_status !== '' && r.review_status !== 'pending'));
        } else if (upper.includes('IS_SUSPICIOUS = 1')) {
          rows = rows.filter((r) => r.is_suspicious === 1);
        }

        const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i);
        if (whereMatch) {
          const conditions = whereMatch[1].split(/\s+AND\s+/i);
          let pIdx = 0;
          for (const cond of conditions) {
            const cUp = cond.trim().toUpperCase();
            if (cUp === 'IS_SUSPICIOUS = 1' || cUp.includes('REVIEW_STATUS IS NOT NULL')) continue;
            if (cUp.includes('(REVIEW_STATUS = ? OR REVIEW_STATUS IS NULL)')) {
              const st = String(params[pIdx++] || 'pending');
              rows = rows.filter((r) => r.is_suspicious === 1 && ((r.review_status || 'pending').toLowerCase() === st.toLowerCase() || !r.review_status));
            } else if (cUp === 'REVIEW_STATUS = ?') {
              const st = String(params[pIdx++] || '');
              rows = rows.filter((r) => (r.review_status || '').toLowerCase() === st.toLowerCase());
            } else if (cUp === 'FLAG_REASONS LIKE ?') {
              const pat = String(params[pIdx++] || '').replace(/%/g, '');
              rows = rows.filter((r) => r.flag_reasons?.includes(pat));
            } else if (cUp === '(AFFILIATE_ID = ? OR AFFILIATE_CODE = ?)') {
              const p1 = params[pIdx++];
              const p2 = params[pIdx++];
              rows = rows.filter((r) => r.affiliate_id === p1 || r.affiliate_code === p2);
            } else if (cUp === 'IP_ADDRESS = ?') {
              const ip = params[pIdx++];
              rows = rows.filter((r) => r.ip_address === ip);
            } else if (cUp === 'DEAL_ID = ?') {
              const dId = params[pIdx++];
              rows = rows.filter((r) => r.deal_id === dId);
            } else if (cUp === 'CREATED_AT >= ?') {
              const since = new Date(params[pIdx++]).getTime();
              rows = rows.filter((r) => new Date(r.created_at).getTime() >= since);
            } else if (cUp === 'CREATED_AT <= ?') {
              const until = new Date(params[pIdx++]).getTime();
              rows = rows.filter((r) => new Date(r.created_at).getTime() <= until);
            } else if (cUp === '(ID LIKE ? OR IP_ADDRESS LIKE ? OR AFFILIATE_CODE LIKE ?)') {
              const term = String(params[pIdx++] || '').replace(/%/g, '').toLowerCase();
              pIdx += 2;
              rows = rows.filter(
                (r) =>
                  (r.id && r.id.toLowerCase().includes(term)) ||
                  (r.ip_address && r.ip_address.toLowerCase().includes(term)) ||
                  (r.affiliate_code && r.affiliate_code.toLowerCase().includes(term))
              );
            }
          }
        }
      }
      return [{ count: rows.length, 'COUNT(*)': rows.length, total: rows.length }];
    }

    // 7. SELECT COUNT(*) from conversions
    if (upper.includes('SELECT COUNT(*)') && upper.includes('FROM CONVERSIONS')) {
      let rows = Array.from(this.conversions.values());
      if (upper.includes('DEAL_ID = ?')) {
        const dealId = params[0];
        rows = rows.filter((r) => r.deal_id === dealId);
        if (upper.includes('AFFILIATE_CODE = ?')) {
          rows = rows.filter((r) => r.affiliate_code === params[1]);
        }
      } else if (upper.includes('AFFILIATE_CODE = ?')) {
        rows = rows.filter((r) => r.affiliate_code === params[0]);
      }
      return [{ count: rows.length, 'COUNT(*)': rows.length, total: rows.length }];
    }

    // 8. SELECT * FROM deal_clicks
    if (upper.includes('FROM DEAL_CLICKS')) {
      let rows = Array.from(this.dealClicks.values());

      if (upper.includes('WHERE DEAL_ID = ?')) {
        const dealId = params[0];
        rows = rows.filter((r) => r.deal_id === dealId);

        if (upper.includes('CREATED_AT >= ?')) {
          const cutoff = new Date(params[1]).getTime();
          rows = rows.filter((r) => new Date(r.created_at).getTime() >= cutoff);
        }
        if (upper.includes('AFFILIATE_ID = ?')) {
          const affId = params[2];
          rows = rows.filter((r) => r.affiliate_id === affId);
        }
        if (upper.includes('AFFILIATE_CODE IS NOT NULL')) {
          rows = rows.filter((r) => r.affiliate_code !== null && r.affiliate_code !== '');
        }
      } else if (upper.includes('WHERE IP_ADDRESS = ?')) {
        const ip = params[0];
        rows = rows.filter((r) => r.ip_address === ip);
        if (upper.includes('CREATED_AT >= ?')) {
          const since = new Date(params[1]).getTime();
          rows = rows.filter((r) => new Date(r.created_at).getTime() >= since);
        }
      } else if (upper.includes('WHERE SESSION_ID = ?')) {
        const sess = params[0];
        rows = rows.filter((r) => r.session_id === sess);
      } else if (upper.includes('WHERE (IP_ADDRESS = ? OR SESSION_ID = ?)')) {
        const ip = params[0];
        const sess = params[1];
        rows = rows.filter((r) => r.ip_address === ip || r.session_id === sess);
      } else if (upper.includes('WHERE ID = ?')) {
        const targetId = params[0];
        rows = rows.filter((r) => r.id === targetId);
        if (rows.length === 0 && targetId === 'click-rev-1') {
          const revClick = {
            id: 'click-rev-1',
            deal_id: 'deal-1',
            affiliate_code: 'AFFILIATE1',
            affiliate_id: 'usr-affiliate-1',
            session_id: 'sess-rev-1',
            ip_address: '198.51.100.10',
            user_agent: 'Mozilla/5.0',
            referrer_url: null,
            country_code: 'US',
            device_type: 'desktop',
            click_type: 'link',
            is_unique: 1,
            is_suspicious: 1,
            flag_reasons: '["BURST_CLICK"]',
            anomaly_score: 0.85,
            review_status: 'pending',
            reviewed_at: null,
            reviewed_by: null,
            created_at: '2026-01-01T00:00:00Z',
          };
          this.dealClicks.set('click-rev-1', revClick as any);
          rows = [revClick];
        }
      }

      // Feature 6 Filter: ignore unapproved suspicious clicks
      if (upper.includes('IS_SUSPICIOUS = 0 OR IS_SUSPICIOUS IS NULL') || upper.includes('(IS_SUSPICIOUS = 0 OR IS_SUSPICIOUS IS NULL)')) {
        rows = rows.filter((r) => r.is_suspicious === 0 || r.is_suspicious === null || r.is_suspicious === undefined);
      } else if (
        upper.includes('WHERE') &&
        (upper.includes('IS_SUSPICIOUS = 1') || upper.includes('REVIEW_STATUS = ?') || upper.includes('REVIEW_STATUS IS NOT NULL'))
      ) {
        if (upper.includes('IS_SUSPICIOUS = 1 OR REVIEW_STATUS IS NOT NULL') || upper.includes('IS_SUSPICIOUS = 1 OR (REVIEW_STATUS IS NOT NULL')) {
          rows = rows.filter((r) => r.is_suspicious === 1 || (r.review_status !== null && r.review_status !== undefined && r.review_status !== '' && r.review_status !== 'pending'));
        } else if (upper.includes('IS_SUSPICIOUS = 1')) {
          rows = rows.filter((r) => r.is_suspicious === 1);
        }

        const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i);
        if (whereMatch) {
          const conditions = whereMatch[1].split(/\s+AND\s+/i);
          let pIdx = 0;
          for (const cond of conditions) {
            const cUp = cond.trim().toUpperCase();
            if (cUp === 'IS_SUSPICIOUS = 1' || cUp.includes('REVIEW_STATUS IS NOT NULL')) continue;
            if (cUp.includes('(REVIEW_STATUS = ? OR REVIEW_STATUS IS NULL)')) {
              const st = String(params[pIdx++] || 'pending');
              rows = rows.filter((r) => r.is_suspicious === 1 && ((r.review_status || 'pending').toLowerCase() === st.toLowerCase() || !r.review_status));
            } else if (cUp === 'REVIEW_STATUS = ?') {
              const st = String(params[pIdx++] || '');
              rows = rows.filter((r) => (r.review_status || '').toLowerCase() === st.toLowerCase());
            } else if (cUp === 'FLAG_REASONS LIKE ?') {
              const pat = String(params[pIdx++] || '').replace(/%/g, '');
              rows = rows.filter((r) => r.flag_reasons?.includes(pat));
            } else if (cUp === '(AFFILIATE_ID = ? OR AFFILIATE_CODE = ?)') {
              const p1 = params[pIdx++];
              const p2 = params[pIdx++];
              rows = rows.filter((r) => r.affiliate_id === p1 || r.affiliate_code === p2);
            } else if (cUp === 'IP_ADDRESS = ?') {
              const ip = params[pIdx++];
              rows = rows.filter((r) => r.ip_address === ip);
            } else if (cUp === 'DEAL_ID = ?') {
              const dId = params[pIdx++];
              rows = rows.filter((r) => r.deal_id === dId);
            } else if (cUp === 'CREATED_AT >= ?') {
              const since = new Date(params[pIdx++]).getTime();
              rows = rows.filter((r) => new Date(r.created_at).getTime() >= since);
            } else if (cUp === 'CREATED_AT <= ?') {
              const until = new Date(params[pIdx++]).getTime();
              rows = rows.filter((r) => new Date(r.created_at).getTime() <= until);
            } else if (cUp === '(ID LIKE ? OR IP_ADDRESS LIKE ? OR AFFILIATE_CODE LIKE ?)') {
              const term = String(params[pIdx++] || '').replace(/%/g, '').toLowerCase();
              pIdx += 2;
              rows = rows.filter(
                (r) =>
                  (r.id && r.id.toLowerCase().includes(term)) ||
                  (r.ip_address && r.ip_address.toLowerCase().includes(term)) ||
                  (r.affiliate_code && r.affiliate_code.toLowerCase().includes(term))
              );
            }
          }
        }
      }

      // Sort
      if (upper.includes('ORDER BY CREATED_AT DESC')) {
        rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      } else if (upper.includes('ORDER BY CREATED_AT ASC')) {
        rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      }

      // Limit & Offset
      if (upper.includes('LIMIT ? OFFSET ?')) {
        const limit = Number(params[params.length - 2]);
        const offset = Number(params[params.length - 1]);
        rows = rows.slice(offset, offset + limit);
      } else if (upper.includes('LIMIT 1')) {
        rows = rows.slice(0, 1);
      } else if (upper.includes('LIMIT ?')) {
        const limit = Number(params[params.length - 1]);
        rows = rows.slice(0, limit);
      }

      return rows.map((r) => ({ ...r }));
    }

    // 9. SELECT from fraud_reviews
    if (upper.includes('FROM FRAUD_REVIEWS')) {
      let rows = Array.from(this.fraudReviews.values());
      if (upper.includes('WHERE CLICK_ID = ?')) {
        rows = rows.filter((r) => r.click_id === params[0]);
      } else if (upper.includes('WHERE ID = ?')) {
        rows = rows.filter((r) => r.id === params[0]);
      }
      if (upper.includes('ORDER BY CREATED_AT DESC') || upper.includes('ORDER BY REVIEWED_AT DESC')) {
        rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      }
      return rows.map((r) => ({ ...r }));
    }

    // 10. SELECT from rate_limits
    if (upper.includes('FROM RATE_LIMITS')) {
      return Array.from(this.rateLimits.values()).map((r) => ({ ...r }));
    }

    return [];
  }

  private executeRun(sql: string, params: any[]): number {
    const upper = sql.toUpperCase();

    // IMMUTABILITY TRIGGER ENFORCEMENT:
    // Any UPDATE or DELETE on fraud_reviews is strictly prohibited by SQLite trigger
    if (
      upper.includes('UPDATE FRAUD_REVIEWS') ||
      upper.includes('DELETE FROM FRAUD_REVIEWS') ||
      upper.includes('UPDATE "FRAUD_REVIEWS"') ||
      upper.includes('DELETE FROM "FRAUD_REVIEWS"')
    ) {
      throw new Error(
        'SQLITE_ERROR: fraud_reviews audit log is immutable and cannot be updated or deleted: cannot modify immutable table fraud_reviews (trigger: trg_fraud_reviews_prevent_update)'
      );
    }

    // 1. INSERT INTO deal_clicks
    if (upper.includes('INSERT INTO DEAL_CLICKS')) {
      const match = sql.match(/INSERT\s+INTO\s+deal_clicks\s*\(([^)]+)\)/i);
      const row: any = {
        id: crypto.randomUUID().replace(/-/g, ''),
        deal_id: 'deal-active-1',
        affiliate_code: null,
        affiliate_id: null,
        session_id: 'sess-default',
        ip_address: null,
        user_agent: null,
        referrer_url: null,
        country_code: null,
        device_type: null,
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        flag_reasons: '[]',
        anomaly_score: 0.0,
        review_status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
        created_at: new Date().toISOString(),
      };

      if (match) {
        const columns = match[1].split(',').map((c) => c.trim().toLowerCase());
        columns.forEach((col, idx) => {
          if (idx < params.length) {
            let val = params[idx];
            if (col === 'flag_reasons' && typeof val === 'object' && val !== null) {
              val = JSON.stringify(val);
            }
            row[col] = val;
          }
        });
      } else {
        if (params.length > 0) row.id = params[0];
        if (params.length > 1) row.deal_id = params[1];
        if (params.length > 2) row.affiliate_code = params[2];
        if (params.length > 3) row.affiliate_id = params[3];
        if (params.length > 4) row.session_id = params[4];
        if (params.length > 5) row.ip_address = params[5];
        if (params.length > 6) row.user_agent = params[6];
        if (params.length > 7) row.referrer_url = params[7];
        if (params.length > 8) row.country_code = params[8];
        if (params.length > 9) row.device_type = params[9];
        if (params.length > 10) row.click_type = params[10];
        if (params.length > 11) row.is_unique = params[11];
        if (params.length > 12) row.is_suspicious = params[12];
        if (params.length > 13) row.anomaly_score = params[13];
        if (params.length > 14) row.flag_reasons = params[14];
        if (params.length > 15) row.review_status = params[15];
      }

      this.dealClicks.set(row.id, row as DealClickRow);
      return 1;
    }

    // 2. UPDATE deal_clicks
    if (upper.includes('UPDATE DEAL_CLICKS')) {
      if (upper.includes('WHERE ID = ?')) {
        const clickId = String(params[params.length - 1]);
        const existing = this.dealClicks.get(clickId);
        if (existing) {
          const setMatch = sql.match(/SET\s+(.+)\s+WHERE/i);
          if (setMatch) {
            const setClauses = setMatch[1].split(',').map((s) => s.trim());
            let paramIdx = 0;
            setClauses.forEach((clause) => {
              const colMatch = clause.match(/^([a-zA-Z0-9_]+)\s*=\s*(.+)$/);
              if (colMatch) {
                const col = colMatch[1].toLowerCase();
                const rawVal = colMatch[2].trim();
                let val: any;
                if (rawVal === '?') {
                  if (paramIdx < params.length - 1) {
                    val = params[paramIdx++];
                  }
                } else if (rawVal.toUpperCase() === 'NULL') {
                  val = null;
                } else if (!isNaN(Number(rawVal))) {
                  val = Number(rawVal);
                } else {
                  val = rawVal.replace(/^['"]|['"]$/g, '');
                }
                if (col === 'flag_reasons' && typeof val === 'object' && val !== null) {
                  val = JSON.stringify(val);
                }
                (existing as any)[col] = val;
              }
            });
          } else {
            if (upper.includes('REVIEW_STATUS = ?') && upper.includes('IS_SUSPICIOUS = ?')) {
              existing.review_status = String(params[0] ?? 'approved');
              existing.is_suspicious = Number(params[1] ?? 0);
              existing.reviewed_at = params[2] ? String(params[2]) : new Date().toISOString();
              existing.reviewed_by = params[3] ? String(params[3]) : 'admin-001';
            }
          }
          this.dealClicks.set(clickId, existing);
          return 1;
        }
      }
      return 0;
    }

    // 3. INSERT INTO blocked_ips
    if (upper.includes('INSERT INTO BLOCKED_IPS') || upper.includes('INSERT OR REPLACE INTO BLOCKED_IPS') || upper.includes('INTO BLOCKED_IPS')) {
      const now = new Date().toISOString();
      const id = String(params[0] || crypto.randomUUID().replace(/-/g, ''));
      const ipAddress = String(params[1] ?? '');
      const reason = String(params[2] || 'Manual block');
      const blockedBy = String(params[3] || 'usr-admin-1');
      const blockedAt = params[4] ? String(params[4]) : now;
      const expiresAt = params[5] ? String(params[5]) : null;
      const isActive = params[6] !== undefined ? Number(params[6]) : 1;
      const metadata = params[7] ? String(params[7]) : null;

      if (this.blockedIps.has(ipAddress) && (upper.includes('ON CONFLICT') || upper.includes('OR REPLACE'))) {
        const existing = this.blockedIps.get(ipAddress)!;
        existing.reason = reason;
        existing.blocked_by = blockedBy;
        existing.is_active = 1;
        existing.expires_at = expiresAt;
        existing.created_at = blockedAt;
        existing.updated_at = now;
        return 1;
      }

      const row: BlockedIpRow = {
        id,
        ip_address: ipAddress,
        reason,
        blocked_by: blockedBy,
        blocked_at: blockedAt,
        expires_at: expiresAt,
        is_active: isActive,
        metadata,
        created_at: blockedAt,
        updated_at: now,
      };
      this.blockedIps.set(row.ip_address, row);
      return 1;
    }

    // 4. UPDATE blocked_ips (e.g. SET is_active = 0 WHERE ip_address = ?)
    if (upper.includes('UPDATE BLOCKED_IPS')) {
      const ip = String(params[params.length - 1] ?? '');
      const entry = this.blockedIps.get(ip);
      if (entry) {
        if (upper.includes('IS_ACTIVE = ?')) {
          entry.is_active = Number(params[0]);
        } else if (upper.includes('IS_ACTIVE = 0')) {
          entry.is_active = 0;
        }
        entry.updated_at = new Date().toISOString();
        return 1;
      }
      return 0;
    }

    // 5. DELETE FROM blocked_ips
    if (upper.includes('DELETE FROM BLOCKED_IPS')) {
      if (upper.includes('WHERE IP_ADDRESS = ?')) {
        const ip = String(params[0] ?? '');
        const existed = this.blockedIps.delete(ip);
        return existed ? 1 : 0;
      }
    }

    // 6. INSERT INTO fraud_reviews
    if (upper.includes('INSERT INTO FRAUD_REVIEWS')) {
      const now = new Date().toISOString();
      const match = sql.match(/INSERT\s+INTO\s+fraud_reviews\s*\(([^)]+)\)/i);
      const row: FraudReviewRow = {
        id: crypto.randomUUID().replace(/-/g, ''),
        click_id: null,
        ip_address: null,
        reviewer_id: 'usr-admin-1',
        reviewed_by: 'usr-admin-1',
        reviewer_email: 'admin@apex-os.com',
        action: 'approve',
        action_type: 'approve',
        reason: 'Review verdict',
        notes: null,
        details: null,
        metadata: null,
        created_at: now,
        reviewed_at: now,
      };

      if (match) {
        const columns = match[1].split(',').map((c) => c.trim().toLowerCase());
        columns.forEach((col, idx) => {
          if (idx < params.length) {
            let val = params[idx];
            if ((col === 'metadata' || col === 'details') && typeof val === 'object' && val !== null) {
              val = JSON.stringify(val);
            }
            (row as any)[col] = val;
            if (col === 'reviewer_id') row.reviewed_by = val;
            if (col === 'action') row.action_type = val;
          }
        });
      } else {
        const id = String(params[0] || crypto.randomUUID().replace(/-/g, ''));
        const clickId = params[1] ? String(params[1]) : null;
        const ipAddress = params[2] && typeof params[2] === 'string' && (params[2].includes('.') || params[2].includes(':')) ? String(params[2]) : null;
        const reviewerId = String(params[2] && !ipAddress ? params[2] : (params[3] ?? 'usr-admin-1'));
        const action = String(params[3] && !ipAddress ? params[3] : (params[4] ?? params[5] ?? 'approve'));
        const reason = String(params[4] && !ipAddress ? params[4] : (params[5] ?? params[6] ?? 'Review rationale'));

        row.id = id;
        row.click_id = clickId;
        row.ip_address = ipAddress;
        row.reviewer_id = reviewerId;
        row.reviewed_by = reviewerId;
        row.action = action;
        row.action_type = action;
        row.reason = reason;
      }

      this.fraudReviews.set(row.id, row);
      return 1;
    }

    // 7. INSERT INTO conversions
    if (upper.includes('INSERT INTO CONVERSIONS')) {
      const now = new Date().toISOString();
      const row: ConversionRow = {
        id: String(params[0] || crypto.randomUUID().replace(/-/g, '')),
        deal_id: String(params[1] ?? 'deal-active-1'),
        affiliate_code: params[2] ? String(params[2]) : null,
        affiliate_id: params[3] ? String(params[3]) : null,
        user_id: String(params[4] ?? 'usr-trader-1'),
        amount: Number(params[5] ?? 100),
        status: String(params[6] || 'confirmed'),
        created_at: now,
        converted_at: now,
      };
      this.conversions.set(row.id, row);
      return 1;
    }

    // 8. INSERT INTO rate_limits
    if (upper.includes('INSERT INTO RATE_LIMITS')) {
      const key = String(params[0] ?? '');
      const endpointType = String(params[1] ?? 'click_tracking');
      const identifier = String(params[2] ?? '');
      const currentCount = Number(params[3] ?? 1);
      const maxCount = Number(params[4] ?? 100);
      const windowSeconds = Number(params[5] ?? 3600);
      const resetAt = String(params[6] ?? new Date(Date.now() + 3600000).toISOString());
      const now = new Date().toISOString();

      const entry: MockRateLimitRow = {
        id: this.rateLimitAutoInc++,
        key,
        endpoint_type: endpointType,
        identifier,
        current_count: currentCount,
        max_count: maxCount,
        window_seconds: windowSeconds,
        reset_at: resetAt,
        created_at: now,
        updated_at: now,
      };

      this.rateLimits.set(key, entry);
      return 1;
    }

    // 9. UPDATE rate_limits SET current_count = current_count + 1
    if (upper.includes('UPDATE RATE_LIMITS') && upper.includes('CURRENT_COUNT + 1')) {
      const updatedAt = String(params[0] ?? new Date().toISOString());
      const key = String(params[1] ?? '');
      const entry = this.rateLimits.get(key);
      if (entry) {
        entry.current_count += 1;
        entry.updated_at = updatedAt;
        return 1;
      }
      return 0;
    }

    // 10. DELETE FROM rate_limits WHERE key = ?
    if (upper.includes('DELETE FROM RATE_LIMITS') && upper.includes('KEY =')) {
      const key = String(params[0] ?? '');
      return this.rateLimits.delete(key) ? 1 : 0;
    }

    return 1;
  }
}

export const mockFraudDB = new MockFraudDatabase();

// Injects DB into global scope for routes that access globalThis.DB
(globalThis as any).DB = mockFraudDB;

// ============================================================================
// Auth & Request Factory
// ============================================================================

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | string;
  headers?: Record<string, string>;
  body?: any;
  ip?: string;
  ipAddress?: string;
  userAgent?: string;
  admin?: boolean;
  affiliate?: boolean;
  authRole?: 'admin' | 'user' | 'affiliate' | 'none';
  cookieId?: string;
  trackingCookie?: string;
  urlParams?: Record<string, string>;
}

export function createFraudTestRequest(urlPath: string, options: RequestOptions = {}): NextRequest {
  const method = options.method || 'GET';
  let fullUrl = urlPath.startsWith('http') ? urlPath : `http://localhost:3000${urlPath}`;

  if (options.urlParams && Object.keys(options.urlParams).length > 0) {
    const urlObj = new URL(fullUrl);
    for (const [k, v] of Object.entries(options.urlParams)) {
      urlObj.searchParams.set(k, v);
    }
    fullUrl = urlObj.toString();
  }

  const headers = new Headers();
  headers.set('content-type', 'application/json');

  // IP header injection
  const effectiveIp = options.ip || options.ipAddress;
  if (effectiveIp) {
    headers.set('cf-connecting-ip', effectiveIp);
    headers.set('x-forwarded-for', effectiveIp);
    headers.set('x-real-ip', effectiveIp);
  }

  // User-Agent
  if (options.userAgent) {
    headers.set('user-agent', options.userAgent);
  } else {
    headers.set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
  }

  // Cookies
  const cookies: string[] = [];
  const trackingCookie = options.trackingCookie || options.cookieId;
  if (trackingCookie) {
    cookies.push(`apex_tracking_id=${trackingCookie}`);
  }

  // Authentication
  const isAdmin = options.admin || options.authRole === 'admin';
  const isAffiliate = options.affiliate || options.authRole === 'affiliate' || options.authRole === 'user';

  if (isAdmin) {
    cookies.push('better-auth.session_token=admin-session');
    headers.set('authorization', 'Bearer token-usr-admin-1');
  } else if (isAffiliate) {
    cookies.push('better-auth.session_token=affiliate-session');
    headers.set('authorization', 'Bearer token-usr-affiliate-1');
  }

  if (cookies.length > 0) {
    headers.set('cookie', cookies.join('; '));
  }

  // Custom headers override
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      headers.set(k.toLowerCase(), v);
    }
  }

  const reqInit: any = {
    method,
    headers,
  };

  if (options.body && method !== 'GET') {
    reqInit.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  return new NextRequest(fullUrl, reqInit);
}

// ============================================================================
// Setup Environment & Mocks
// ============================================================================

export function setupFraudTestEnvironment() {
  (globalThis as any).DB = mockFraudDB;

  // Mock globalThis.KV for KVRateLimiter
  const kvStore = new Map<string, string>();
  (globalThis as any).KV = {
    get: jest.fn(async (key: string) => kvStore.get(key) || null),
    put: jest.fn(async (key: string, value: string) => {
      kvStore.set(key, value);
    }),
    delete: jest.fn(async (key: string) => kvStore.delete(key)),
  };

  // Polyfill Headers.prototype.append if missing
  if (typeof (global as any).Headers !== 'undefined') {
    if (!(global as any).Headers.prototype.append) {
      (global as any).Headers.prototype.append = function (name: string, value: string) {
        const lower = name.toLowerCase();
        const current = this.get(lower);
        if (current) {
          this.set(lower, `${current}, ${value}`);
        } else {
          this.set(lower, String(value));
        }
      };
    }
  }

  // Enhance global.NextResponse with redirect, append, and cookies.set support
  if ((global as any).NextResponse) {
    const OrigNextResponse = (global as any).NextResponse;

    const origJson = OrigNextResponse.json;
    OrigNextResponse.json = function (data: any, init?: any) {
      const res = origJson.call(this, data, init);
      if (res && res.headers && typeof res.headers.append !== 'function') {
        res.headers.append = function (name: string, value: string) {
          res.headers.set(name, value);
        };
      }
      if (!res.cookies) {
        res.cookies = {
          set: (name: string, value: string, options?: any) => {
            if (res.headers && res.headers.set) {
              res.headers.set('set-cookie', `${name}=${value}; Path=/`);
            }
          },
          get: () => undefined,
        };
      }
      return res;
    };

    OrigNextResponse.redirect = function (url: string | URL, initOrStatus: any = 302) {
      const res = new OrigNextResponse();
      const statusCode = typeof initOrStatus === 'number' ? initOrStatus : (initOrStatus?.status ?? 302);
      res._status = statusCode;
      res._headers = new Map();
      res._headers.set('location', typeof url === 'string' ? url : url.toString());
      res.cookies = {
        set: (name: string, value: string, options?: any) => {
          res.headers.set('set-cookie', `${name}=${value}; Path=/`);
        },
        get: () => undefined,
      };
      return res;
    };
  }

  // Intercept global fetch for /api/auth/session
  const originalFetch = globalThis.fetch;

  globalThis.fetch = jest.fn(async (input: any, init?: any) => {
    const urlStr = typeof input === 'string' ? input : input?.url ?? String(input);

    if (urlStr.includes('/api/auth/session')) {
      const headers = init?.headers ?? {};
      const cookieStr = headers['cookie'] ?? headers['Cookie'] ?? '';

      if (cookieStr.includes('admin-session')) {
        return new Response(JSON.stringify({ user: { id: 'usr-admin-1', email: 'admin@apex-os.com' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (cookieStr.includes('affiliate-session')) {
        return new Response(JSON.stringify({ user: { id: 'usr-affiliate-1', email: 'affiliate1@apex-os.com' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ user: null }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (typeof originalFetch === 'function') {
      return originalFetch(input, init);
    }
    return new Response('{}', { status: 200 });
  }) as any;
}

// Mock auth-factory for requireAdmin and getSession
jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async ({ headers, cookies }: { headers?: Headers; cookies?: Record<string, string> }) => {
        const cookieStr = typeof cookies === 'object' ? JSON.stringify(cookies) : '';
        const authHeader = headers?.get ? headers.get('authorization') || '' : '';

        if (cookieStr.includes('admin-session') || authHeader.includes('token-usr-admin-1')) {
          return { user: { id: 'usr-admin-1', email: 'admin@apex-os.com' } };
        }
        if (cookieStr.includes('affiliate-session') || authHeader.includes('token-usr-affiliate-1')) {
          return { user: { id: 'usr-affiliate-1', email: 'affiliate1@apex-os.com' } };
        }
        return null;
      }),
    },
  })),
}));

// Mock next/headers for requireAdmin integration
jest.mock('next/headers', () => ({
  headers: jest.fn(async () => {
    return currentActiveRequest?.headers ?? new Headers();
  }),
  cookies: jest.fn(async () => {
    const cookieMap = new Map<string, string>();
    const cookieHeader = currentActiveRequest?.headers.get('cookie') || '';
    cookieHeader.split(';').forEach((c) => {
      const [k, v] = c.trim().split('=');
      if (k) cookieMap.set(k, v || '');
    });
    return {
      get: (name: string) => (cookieMap.has(name) ? { name, value: cookieMap.get(name)! } : undefined),
      getAll: () => Array.from(cookieMap.entries()).map(([name, value]) => ({ name, value })),
    };
  }),
}));

// Mock @/lib/db getDB
jest.mock('@/lib/db', () => ({
  getDB: jest.fn(() => mockFraudDB),
}));

// ============================================================================
// Dynamic Route Dispatcher & Milestone Probing
// ============================================================================

export interface RouteInvocationResult {
  status: number;
  data?: any;
  error?: string;
  implemented: boolean;
  headers: {
    get: (key: string) => string | null;
  };
  rawResponse?: Response;
}

export async function dispatchRoute(
  routeRelativePath: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  request: NextRequest,
  routeParams?: Record<string, string>
): Promise<RouteInvocationResult> {
  const fullPath = path.resolve(process.cwd(), routeRelativePath);

  if (!fs.existsSync(fullPath)) {
    return {
      status: 501,
      implemented: false,
      error: `Route not implemented: ${routeRelativePath}`,
      headers: { get: () => null },
    };
  }

  const moduleAlias = routeRelativePath.replace(/^src\//, '@/').replace(/\.tsx?$/, '');

  setActiveTestRequest(request);

  try {
    const routeModule = await import(moduleAlias);
    const handler = routeModule[method];

    if (typeof handler !== 'function') {
      return {
        status: 405,
        implemented: false,
        error: `Method ${method} not exported from ${routeRelativePath}`,
        headers: { get: () => null },
      };
    }

    const context = {
      params: Promise.resolve(routeParams || {}),
    };

    const response = await handler(request, context);
    let data: any = null;
    try {
      data = await response.json();
    } catch {
      // Body may be plain text, redirect, or empty
    }

    return {
      status: response.status ?? 200,
      data,
      error: data?.error,
      implemented: true,
      headers: {
        get: (k: string) => response.headers?.get ? response.headers.get(k) : null,
      },
      rawResponse: response,
    };
  } catch (err: any) {
    return {
      status: 500,
      implemented: true,
      error: err?.message ?? 'Internal Handler Exception',
      headers: { get: () => null },
    };
  } finally {
    setActiveTestRequest(null);
  }
}

// Progressive milestone checking
export function isFraudEngineImplemented(): boolean {
  return fs.existsSync(path.resolve(process.cwd(), 'src/lib/fraud/fraud-engine.ts'));
}

export function isMigration021Implemented(): boolean {
  return fs.existsSync(path.resolve(process.cwd(), 'src/database/migrations/021_fraud_detection_schema.sql'));
}

export function isFraudTypesImplemented(): boolean {
  return fs.existsSync(path.resolve(process.cwd(), 'src/types/fraud.ts'));
}

export async function getFraudEngine(): Promise<any | null> {
  if (!isFraudEngineImplemented()) return null;
  return await import('@/lib/fraud/fraud-engine');
}
