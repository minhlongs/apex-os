/**
 * __tests__/telegram/leaderboard.test.ts
 *
 * Comprehensive Test Suite for Telegram Social Referral Leaderboard API:
 * - GET /api/telegram/leaderboard
 * - Sequential 1-indexed rankings, medals (gold, silver, bronze, top_10, contender) & referral tiers (DIAMOND, PLATINUM, GOLD, SILVER, BRONZE)
 * - Pagination parameters (limit, offset, max clamp to 100, negative number handling)
 * - Period filtering (all_time, monthly, weekly)
 * - Cold-start fallback behavior (falling back to referral_tree + profiles when telegram_referrals is fresh)
 * - Privacy sanitization (zero email leakage, zero internal UUIDs, zero auth tokens or IPs)
 * - HTTP Edge Caching (Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=120) & CORS headers
 * - OPTIONS preflight handling (HTTP 204 with CORS headers)
 * - User rank resolution (?telegram_id=...)
 * - Error resilience (HTTP 500 when D1 database is unavailable or throws)
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

import { NextRequest } from 'next/server';
import { GET, OPTIONS, calculateTier, calculateBadge } from '@/app/api/telegram/leaderboard/route';
import * as dbModule from '@/lib/db';
import type { D1Database } from '@/lib/db';

interface TelegramUserRow {
  telegram_id: number;
  user_id: string | null;
  username: string | null;
  first_name: string;
  photo_url: string | null;
}

interface TelegramReferralRow {
  id: string;
  referrer_id: number | null;
  referee_id: number;
  referral_code: string;
  status: string;
  reward_amount: number;
  created_at: string;
}

interface ReferralTreeNode {
  affiliate_id: string;
  total_direct_referrals: number;
  total_earnings: number;
  is_active: number;
}

interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  referral_code: string;
}

describe('Telegram Referral Leaderboard API (GET /api/telegram/leaderboard)', () => {
  let telegramUsers: TelegramUserRow[] = [];
  let telegramReferrals: TelegramReferralRow[] = [];
  let referralTree: ReferralTreeNode[] = [];
  let profiles: ProfileRow[] = [];
  let shouldThrowDbError = false;

  const createMockDb = (): D1Database => {
    return {
      prepare: (query: string) => {
        if (shouldThrowDbError) {
          throw new Error('D1 database connection interrupted');
        }

        let boundArgs: any[] = [];
        const norm = query.replace(/\s+/g, ' ').trim();

        const stmt: any = {
          bind: (...args: any[]) => {
            boundArgs = args;
            return stmt;
          },
          all: async () => {
            if (shouldThrowDbError) {
              throw new Error('D1 statement execution failed');
            }

            // 1. Primary Query: telegram_referrals aggregation
            if (norm.includes('FROM telegram_referrals tr')) {
              // Group active referrals by referrer_id
              const referrerMap = new Map<number, {
                telegram_id: number;
                username: string | null;
                first_name: string;
                photo_url: string | null;
                referral_code: string;
                verified_referees: number;
                total_earnings_usd: number;
              }>();

              // Date filtering simulation if weekly or monthly
              const isWeekly = norm.includes("-7 days");
              const isMonthly = norm.includes("-30 days");
              const nowMs = Date.now();

              for (const ref of telegramReferrals) {
                if (!ref.referrer_id) continue;
                if (!['active', 'converted', 'completed', 'rewarded'].includes(ref.status)) continue;

                if (isWeekly || isMonthly) {
                  const createdAtMs = new Date(ref.created_at).getTime();
                  const ageDays = (nowMs - createdAtMs) / (1000 * 60 * 60 * 24);
                  if (isWeekly && ageDays > 7) continue;
                  if (isMonthly && ageDays > 30) continue;
                }

                const user = telegramUsers.find((u) => u.telegram_id === ref.referrer_id);
                const existing = referrerMap.get(ref.referrer_id) || {
                  telegram_id: ref.referrer_id,
                  username: user?.username || null,
                  first_name: user?.first_name || 'Member',
                  photo_url: user?.photo_url || null,
                  referral_code: ref.referral_code,
                  verified_referees: 0,
                  total_earnings_usd: 0,
                };

                existing.verified_referees += 1;
                existing.total_earnings_usd += ref.reward_amount;
                referrerMap.set(ref.referrer_id, existing);
              }

              const aggregated = Array.from(referrerMap.values())
                .filter((r) => r.verified_referees > 0)
                .sort((a, b) => {
                  if (b.verified_referees !== a.verified_referees) {
                    return b.verified_referees - a.verified_referees;
                  }
                  return b.total_earnings_usd - a.total_earnings_usd;
                });

              const limit = typeof boundArgs[0] === 'number' ? boundArgs[0] : 20;
              const offset = typeof boundArgs[1] === 'number' ? boundArgs[1] : 0;
              const paginated = aggregated.slice(offset, offset + limit);

              return { results: paginated };
            }

            // 2. Fallback Query: referral_tree + profiles
            if (norm.includes('FROM referral_tree rt')) {
              const activeNodes = referralTree
                .filter((n) => n.is_active === 1 && n.total_direct_referrals > 0)
                .sort((a, b) => {
                  if (b.total_direct_referrals !== a.total_direct_referrals) {
                    return b.total_direct_referrals - a.total_direct_referrals;
                  }
                  return b.total_earnings - a.total_earnings;
                });

              const joined = activeNodes.map((node) => {
                const profile = profiles.find((p) => p.id === node.affiliate_id);
                const tgUser = telegramUsers.find((u) => u.user_id === node.affiliate_id);

                return {
                  affiliate_id: node.affiliate_id,
                  verified_referees: node.total_direct_referrals,
                  total_earnings_usd: node.total_earnings,
                  full_name: profile?.full_name || null,
                  avatar_url: profile?.avatar_url || null,
                  referral_code: profile?.referral_code || 'APEXREF',
                  telegram_id: tgUser?.telegram_id || null,
                  username: tgUser?.username || null,
                  first_name: tgUser?.first_name || (profile?.full_name ? profile.full_name.split(' ')[0] : 'Member'),
                  photo_url: tgUser?.photo_url || null,
                };
              });

              const limit = typeof boundArgs[0] === 'number' ? boundArgs[0] : 20;
              const offset = typeof boundArgs[1] === 'number' ? boundArgs[1] : 0;
              const paginated = joined.slice(offset, offset + limit);

              return { results: paginated };
            }

            return { results: [] };
          },
          first: async <T = unknown>(): Promise<T | null> => {
            if (shouldThrowDbError) {
              throw new Error('D1 first() failed');
            }

            // Count for primary query
            if (norm.includes('COUNT(DISTINCT tr.referrer_id)')) {
              const uniqueReferrers = new Set(
                telegramReferrals
                  .filter((r) => r.referrer_id && ['active', 'converted', 'completed', 'rewarded'].includes(r.status))
                  .map((r) => r.referrer_id)
              );
              return { total_count: uniqueReferrers.size } as T;
            }

            // Count for fallback query
            if (norm.includes('COUNT(*) as total_count FROM referral_tree rt')) {
              const count = referralTree.filter(
                (n) => n.is_active === 1 && n.total_direct_referrals > 0
              ).length;
              return { total_count: count } as T;
            }

            return null;
          },
        };

        return stmt;
      },
    } as unknown as D1Database;
  };

  beforeEach(() => {
    shouldThrowDbError = false;
    telegramUsers = [];
    telegramReferrals = [];
    referralTree = [];
    profiles = [];

    const mockDb = createMockDb();
    (globalThis as any).DB = mockDb;
    jest.spyOn(dbModule, 'getDB').mockReturnValue(mockDb);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ============================================================================
  // 1. Tier and Badge Helper Tests
  // ============================================================================
  describe('Helper Functions: calculateTier and calculateBadge', () => {
    it('should assign correct tier based on referrals count and volume thresholds', () => {
      expect(calculateTier(60, 10000)).toBe('DIAMOND');
      expect(calculateTier(50, 200)).toBe('DIAMOND');
      expect(calculateTier(2, 6000)).toBe('DIAMOND');

      expect(calculateTier(30, 2500)).toBe('PLATINUM');
      expect(calculateTier(25, 50)).toBe('PLATINUM');
      expect(calculateTier(5, 2000)).toBe('PLATINUM');

      expect(calculateTier(15, 600)).toBe('GOLD');
      expect(calculateTier(10, 20)).toBe('GOLD');
      expect(calculateTier(2, 550)).toBe('GOLD');

      expect(calculateTier(5, 200)).toBe('SILVER');
      expect(calculateTier(3, 10)).toBe('SILVER');
      expect(calculateTier(1, 150)).toBe('SILVER');

      expect(calculateTier(2, 50)).toBe('BRONZE');
      expect(calculateTier(0, 0)).toBe('BRONZE');
    });

    it('should assign correct medal badge based on 1-indexed rank', () => {
      expect(calculateBadge(1)).toBe('gold');
      expect(calculateBadge(2)).toBe('silver');
      expect(calculateBadge(3)).toBe('bronze');
      expect(calculateBadge(4)).toBe('top_10');
      expect(calculateBadge(10)).toBe('top_10');
      expect(calculateBadge(11)).toBe('contender');
      expect(calculateBadge(99)).toBe('contender');
    });
  });

  // ============================================================================
  // 2. Primary Query: Rankings, Medals, Tiers, and Sorting
  // ============================================================================
  describe('Primary Leaderboard Query & Ranking', () => {
    beforeEach(() => {
      // Setup 4 referrers with different active referrals
      telegramUsers = [
        { telegram_id: 1001, user_id: 'usr_1', username: 'alice_crypto', first_name: 'Alice', photo_url: 'https://cdn.example.com/alice.jpg' },
        { telegram_id: 1002, user_id: 'usr_2', username: 'bob_apex', first_name: 'Bob', photo_url: null },
        { telegram_id: 1003, user_id: 'usr_3', username: null, first_name: 'Charlie', photo_url: 'https://cdn.example.com/charlie.jpg' },
        { telegram_id: 1004, user_id: 'usr_4', username: 'david_whale', first_name: 'David', photo_url: null },
      ];

      // Alice: 3 referrals ($15 reward) -> rank 2
      // Bob: 5 referrals ($25 reward) -> rank 1
      // Charlie: 2 referrals ($10 reward) -> rank 3
      // David: 1 referral ($5 reward) -> rank 4
      telegramReferrals = [
        // Bob (5)
        { id: 'r1', referrer_id: 1002, referee_id: 2001, referral_code: 'BOB100', status: 'active', reward_amount: 5, created_at: '2026-09-28T00:00:00Z' },
        { id: 'r2', referrer_id: 1002, referee_id: 2002, referral_code: 'BOB100', status: 'active', reward_amount: 5, created_at: '2026-09-28T00:00:00Z' },
        { id: 'r3', referrer_id: 1002, referee_id: 2003, referral_code: 'BOB100', status: 'active', reward_amount: 5, created_at: '2026-09-28T00:00:00Z' },
        { id: 'r4', referrer_id: 1002, referee_id: 2004, referral_code: 'BOB100', status: 'converted', reward_amount: 5, created_at: '2026-09-28T00:00:00Z' },
        { id: 'r5', referrer_id: 1002, referee_id: 2005, referral_code: 'BOB100', status: 'rewarded', reward_amount: 5, created_at: '2026-09-28T00:00:00Z' },
        // Alice (3)
        { id: 'r6', referrer_id: 1001, referee_id: 2006, referral_code: 'ALICE50', status: 'active', reward_amount: 5, created_at: '2026-09-28T00:00:00Z' },
        { id: 'r7', referrer_id: 1001, referee_id: 2007, referral_code: 'ALICE50', status: 'active', reward_amount: 5, created_at: '2026-09-28T00:00:00Z' },
        { id: 'r8', referrer_id: 1001, referee_id: 2008, referral_code: 'ALICE50', status: 'completed', reward_amount: 5, created_at: '2026-09-28T00:00:00Z' },
        // Charlie (2)
        { id: 'r9', referrer_id: 1003, referee_id: 2009, referral_code: 'CHARLIE10', status: 'active', reward_amount: 5, created_at: '2026-09-28T00:00:00Z' },
        { id: 'r10', referrer_id: 1003, referee_id: 2010, referral_code: 'CHARLIE10', status: 'active', reward_amount: 5, created_at: '2026-09-28T00:00:00Z' },
        // David (1 active, 1 rejected - only 1 counted)
        { id: 'r11', referrer_id: 1004, referee_id: 2011, referral_code: 'DAVID20', status: 'active', reward_amount: 5, created_at: '2026-09-28T00:00:00Z' },
        { id: 'r12', referrer_id: 1004, referee_id: 2012, referral_code: 'DAVID20', status: 'rejected', reward_amount: 0, created_at: '2026-09-28T00:00:00Z' },
      ];
    });

    it('should return sorted rankings by verified referee count descending', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard');
      const res = await GET(req);

      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.total).toBe(4);
      expect(json.leaderboard).toHaveLength(4);

      // Rank 1: Bob (5 referrals)
      expect(json.leaderboard[0].rank).toBe(1);
      expect(json.leaderboard[0].telegram_id).toBe(1002);
      expect(json.leaderboard[0].username).toBe('@bob_apex');
      expect(json.leaderboard[0].verified_referees).toBe(5);
      expect(json.leaderboard[0].badge).toBe('gold');
      expect(json.leaderboard[0].tier).toBe('SILVER'); // 5 referrals qualifies for SILVER tier

      // Rank 2: Alice (3 referrals)
      expect(json.leaderboard[1].rank).toBe(2);
      expect(json.leaderboard[1].telegram_id).toBe(1001);
      expect(json.leaderboard[1].username).toBe('@alice_crypto');
      expect(json.leaderboard[1].verified_referees).toBe(3);
      expect(json.leaderboard[1].badge).toBe('silver');
      expect(json.leaderboard[1].tier).toBe('SILVER');

      // Rank 3: Charlie (2 referrals)
      expect(json.leaderboard[2].rank).toBe(3);
      expect(json.leaderboard[2].telegram_id).toBe(1003);
      expect(json.leaderboard[2].username).toBeNull();
      expect(json.leaderboard[2].first_name).toBe('Charlie');
      expect(json.leaderboard[2].display_name).toBe('Charlie');
      expect(json.leaderboard[2].verified_referees).toBe(2);
      expect(json.leaderboard[2].badge).toBe('bronze');
      expect(json.leaderboard[2].tier).toBe('BRONZE');

      // Rank 4: David (1 active referral)
      expect(json.leaderboard[3].rank).toBe(4);
      expect(json.leaderboard[3].telegram_id).toBe(1004);
      expect(json.leaderboard[3].verified_referees).toBe(1);
      expect(json.leaderboard[3].badge).toBe('top_10');
      expect(json.leaderboard[3].tier).toBe('BRONZE');
    });

    it('should return user_rank when requested via query parameter ?telegram_id=...', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard?telegram_id=1001');
      const res = await GET(req);

      const json = await res.json();
      expect(json.user_rank).toBeDefined();
      expect(json.user_rank.rank).toBe(2);
      expect(json.user_rank.verified_referees).toBe(3);
      expect(json.user_rank.total_earnings_usd).toBe(15);
    });

    it('should return user_rank: null when target user has no referrals', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard?telegram_id=999999');
      const res = await GET(req);

      const json = await res.json();
      expect(json.user_rank).toBeNull();
    });
  });

  // ============================================================================
  // 3. Pagination Tests
  // ============================================================================
  describe('Pagination (limit & offset)', () => {
    beforeEach(() => {
      telegramUsers = Array.from({ length: 25 }, (_, i) => ({
        telegram_id: 1000 + i,
        user_id: `usr_${i}`,
        username: `user_${i}`,
        first_name: `Trader${i}`,
        photo_url: null,
      }));

      telegramReferrals = Array.from({ length: 25 }, (_, i) => ({
        id: `ref_${i}`,
        referrer_id: 1000 + i,
        referee_id: 5000 + i,
        referral_code: `CODE_${i}`,
        status: 'active',
        reward_amount: 5,
        created_at: '2026-09-28T00:00:00Z',
      }));
    });

    it('should default to limit 20 and offset 0', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard');
      const res = await GET(req);
      const json = await res.json();

      expect(json.leaderboard).toHaveLength(20);
      expect(json.leaderboard[0].rank).toBe(1);
      expect(json.leaderboard[19].rank).toBe(20);
      expect(json.total).toBe(25);
    });

    it('should paginate with custom limit and offset and shift ranks appropriately', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard?limit=5&offset=10');
      const res = await GET(req);
      const json = await res.json();

      expect(json.leaderboard).toHaveLength(5);
      expect(json.leaderboard[0].rank).toBe(11);
      expect(json.leaderboard[4].rank).toBe(15);
    });

    it('should clamp limit to maximum 100 and handle negative/invalid params', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard?limit=500&offset=-5');
      const res = await GET(req);
      const json = await res.json();

      // Limit should be capped at 100 (which returns all 25 rows)
      expect(json.leaderboard).toHaveLength(25);
      expect(json.leaderboard[0].rank).toBe(1);
    });
  });

  // ============================================================================
  // 4. Period Filtering Tests
  // ============================================================================
  describe('Period Filtering (all_time, monthly, weekly)', () => {
    it('should accept period=week / weekly and set period in response', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard?period=weekly');
      const res = await GET(req);
      const json = await res.json();

      expect(json.period).toBe('weekly');
    });

    it('should accept period=month / monthly and set period in response', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard?period=month');
      const res = await GET(req);
      const json = await res.json();

      expect(json.period).toBe('monthly');
    });

    it('should default unrecognized periods to all_time', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard?period=century');
      const res = await GET(req);
      const json = await res.json();

      expect(json.period).toBe('all_time');
    });
  });

  // ============================================================================
  // 5. Cold-Start Fallback Tests
  // ============================================================================
  describe('Cold-Start Fallback (referral_tree + profiles)', () => {
    beforeEach(() => {
      // telegram_referrals is completely empty (cold-start)
      telegramReferrals = [];

      // Existing referral_tree and profiles from web affiliate platform
      profiles = [
        { id: 'aff_1', email: 'secret_whale@domain.com', full_name: 'Satoshi Nakamoto', avatar_url: 'https://cdn.example.com/satoshi.png', referral_code: 'BITCOIN1' },
        { id: 'aff_2', email: 'secret_trader@domain.com', full_name: 'Elena Rostova', avatar_url: null, referral_code: 'ELENA99' },
      ];

      // One user has linked telegram, one has not
      telegramUsers = [
        { telegram_id: 888777, user_id: 'aff_1', username: 'satoshin', first_name: 'Satoshi', photo_url: 'https://cdn.example.com/tg_satoshi.png' },
      ];

      referralTree = [
        { affiliate_id: 'aff_1', total_direct_referrals: 55, total_earnings: 2500.0, is_active: 1 },
        { affiliate_id: 'aff_2', total_direct_referrals: 12, total_earnings: 450.0, is_active: 1 },
      ];
    });

    it('should automatically fall back to referral_tree when telegram_referrals has 0 rows', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard');
      const res = await GET(req);

      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.total).toBe(2);
      expect(json.leaderboard).toHaveLength(2);

      // Rank 1: Satoshi (55 referrals, $2500 earnings -> DIAMOND tier)
      const rank1 = json.leaderboard[0];
      expect(rank1.rank).toBe(1);
      expect(rank1.telegram_id).toBe(888777);
      expect(rank1.username).toBe('@satoshin');
      expect(rank1.verified_referees).toBe(55);
      expect(rank1.total_earnings_usd).toBe(2500.0);
      expect(rank1.badge).toBe('gold');
      expect(rank1.tier).toBe('DIAMOND');

      // Rank 2: Elena (12 referrals, not linked to telegram -> first_name Elena, GOLD tier)
      const rank2 = json.leaderboard[1];
      expect(rank2.rank).toBe(2);
      expect(rank2.first_name).toBe('Elena');
      expect(rank2.display_name).toBe('Elena');
      expect(rank2.verified_referees).toBe(12);
      expect(rank2.total_earnings_usd).toBe(450.0);
      expect(rank2.badge).toBe('silver');
      expect(rank2.tier).toBe('GOLD');
    });

    it('should return empty leaderboard when both telegram_referrals and referral_tree are empty', async () => {
      referralTree = [];
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard');
      const res = await GET(req);
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.leaderboard).toEqual([]);
      expect(json.total).toBe(0);
    });
  });

  // ============================================================================
  // 6. Privacy Sanitization Tests
  // ============================================================================
  describe('Privacy Sanitization', () => {
    beforeEach(() => {
      telegramReferrals = [];
      profiles = [
        { id: 'aff_uuid_123456789', email: 'sensitive_ceo@cryptohedgefund.com', full_name: 'John Doe', avatar_url: null, referral_code: 'JD2026' },
      ];
      referralTree = [
        { affiliate_id: 'aff_uuid_123456789', total_direct_referrals: 10, total_earnings: 200, is_active: 1 },
      ];
    });

    it('must never leak user emails, internal UUIDs, or passwords in leaderboard output', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard');
      const res = await GET(req);
      const rawText = await res.text();

      // String-level assertions ensuring no sensitive data is leaked
      expect(rawText).not.toContain('sensitive_ceo@cryptohedgefund.com');
      expect(rawText).not.toContain('@cryptohedgefund.com');
      expect(rawText).not.toContain('aff_uuid_123456789');
      expect(rawText).not.toContain('email');

      const json = JSON.parse(rawText);
      const entry = json.leaderboard[0];
      expect(entry.email).toBeUndefined();
      expect(entry.user_id).toBeUndefined();
      expect(entry.id).toBeUndefined();
      expect(entry.password).toBeUndefined();
      expect(entry.token).toBeUndefined();
    });
  });

  // ============================================================================
  // 7. HTTP Caching & CORS Tests
  // ============================================================================
  describe('HTTP Caching & CORS Headers', () => {
    it('should set Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=120 on GET', async () => {
      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard');
      const res = await GET(req);

      expect(res.headers.get('Cache-Control')).toBe(
        'public, max-age=30, s-maxage=60, stale-while-revalidate=120'
      );
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Content-Type')).toContain('application/json');
    });

    it('should return HTTP 204 with CORS headers on OPTIONS preflight request', async () => {
      const res = await OPTIONS();
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
      expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    });
  });

  // ============================================================================
  // 8. Infrastructure & Database Error Resilience Tests
  // ============================================================================
  describe('Infrastructure Resilience & Error Handling', () => {
    it('should return HTTP 500 when Cloudflare D1 database service is unavailable', async () => {
      (globalThis as any).DB = null;
      jest.spyOn(dbModule, 'getDB').mockImplementation(() => {
        throw new Error('D1 not initialized');
      });

      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard');
      const res = await GET(req);

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('Database service unavailable');
    });

    it('should return HTTP 500 cleanly without crashing when D1 query throws an error', async () => {
      shouldThrowDbError = true;

      const req = new NextRequest('http://localhost:3000/api/telegram/leaderboard');
      const res = await GET(req);

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('Internal server error');
    });
  });
});
