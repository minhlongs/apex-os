/**
 * Affiliate Dashboard API
 * Returns stats and referral tree for the authenticated affiliate
 *
 * Rate Limiting:
 * - Authenticated users: 2000 req/hour
 * - IP-based: 500 req/hour
 *
 * Caching:
 * - Per-user KV cache with 30s TTL
 * - Cache-Control: public, s-maxage=30, stale-while-revalidate=15
 * - Invalidated on: conversion update, payout status change
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { withRateLimit, extractIpAddress } from '@/lib/ratelimit/middleware';
import { getUserIdCacheKey, getCached, setCache, isKVAvailable } from '@/lib/cache/kv-cache';

// Minimal Database interface for D1
interface Database {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      run(): Promise<{ success: boolean }>;
    };
  };
}

interface ReferralChild {
  affiliate_id: string;
  email: string;
  full_name: string | null;
  level: number;
  display_level: number;
  total_earnings: number;
  total_conversions: number;
  conversion_rate: number;
  children: ReferralChild[];
}

/**
 * Generate a unique referral code from user ID
 */
function generateReferralCode(userId: string): string {
  // Take first 8 characters of user ID (after removing non-alphanumeric)
  const base = userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  // Add 4 random characters for uniqueness
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${random}`;
}

/**
 * Build the referral tree structure for an affiliate
 * Returns a hierarchical tree of downline referrals up to 3 levels
 */
async function buildReferralTree(
  DB: Database,
  rootAffiliateId: string,
  rootProfile: { email: string; full_name: string | null }
): Promise<{
  root: {
    affiliate_id: string;
    email: string;
    full_name: string | null;
    level: number;
    total_earnings: number;
    total_conversions: number;
    conversion_rate: number;
    children: ReferralChild[];
  } | null;
  total_nodes: number;
}> {
  // First, get the referral tree node for this affiliate
  const rootNode = await DB.prepare(`
    SELECT rt.affiliate_id, rt.level, rt.path
    FROM referral_tree rt
    WHERE rt.affiliate_id = ?
  `)
    .bind(rootAffiliateId)
    .first<{
      affiliate_id: string;
      level: number;
      path: string;
    }>();

  if (!rootNode) {
    return { root: null, total_nodes: 0 };
  }

  // Get all descendants with level offset (relative to root being level 0 for display)
  // The referral_tree stores root as level 1, direct as 2, etc.
  // We'll display root at level 0, direct at 1, indirect at 2
  const descendants = await DB.prepare(`
    SELECT
      p.id as affiliate_id,
      p.email,
      p.full_name,
      rt.level,
      rt.path,
      COALESCE(rt.total_earnings, 0) as total_earnings,
      COALESCE(ap.total_conversions, 0) as total_conversions,
      COALESCE(ap.conversion_rate, 0) as conversion_rate
    FROM referral_tree rt
    JOIN profiles p ON p.id = rt.affiliate_id
    LEFT JOIN v_affiliate_performance ap ON ap.affiliate_id = p.id
    WHERE rt.path LIKE ?
    ORDER BY rt.level ASC, p.email
  `)
    .bind(`${rootNode.path}%`)
    .all<{
      affiliate_id: string;
      email: string;
      full_name: string | null;
      level: number;
      path: string;
      total_earnings: number;
      total_conversions: number;
      conversion_rate: number;
    }>();

  // Build tree structure
  const nodeMap = new Map<string, ReferralChild>();

  for (const node of descendants.results) {
    const displayLevel = node.level - rootNode.level; // 0 for root, 1 for direct, etc.
    nodeMap.set(node.affiliate_id, {
      affiliate_id: node.affiliate_id,
      email: node.email,
      full_name: node.full_name,
      level: node.level,
      display_level: displayLevel,
      total_earnings: node.total_earnings,
      total_conversions: node.total_conversions,
      conversion_rate: node.conversion_rate,
      children: [],
    });
  }

  // Assemble tree
  const rootChildren: ReferralChild[] = [];

  for (const node of descendants.results) {
    const treeNode = nodeMap.get(node.affiliate_id)!;
    const displayLevel = node.level - rootNode.level;

    if (displayLevel === 0) {
      // This is the root (current user)
      rootChildren.push(treeNode);
    } else {
      // Find parent using path
      const pathParts = node.path.split(',');
      const parentIdx = pathParts.length - 2; // parent is second-to-last
      if (parentIdx >= 0) {
        const parentId = pathParts[parentIdx];
        const parent = nodeMap.get(parentId);
        if (parent) {
          parent.children.push(treeNode);
        } else {
          // Orphan node, attach to root
          rootChildren.push(treeNode);
        }
      } else {
        rootChildren.push(treeNode);
      }
    }
  }

  // Calculate root stats from performance query
  const rootStats = descendants.results
    .filter(r => r.affiliate_id === rootAffiliateId)
    .map(r => ({
      total_earnings: r.total_earnings,
      total_conversions: r.total_conversions,
    }))[0] || { total_earnings: 0, total_conversions: 0 };

  return {
    root: {
      affiliate_id: rootAffiliateId,
      email: rootProfile.email,
      full_name: rootProfile.full_name,
      level: rootNode.level,
      children: rootChildren,
      total_earnings: rootStats.total_earnings,
      total_conversions: rootStats.total_conversions,
      conversion_rate: 0,
    },
    total_nodes: descendants.results.length,
  };
}

/**
 * GET /api/affiliate/dashboard
 * Returns affiliate dashboard data including stats and referral tree
 */
export const GET = withRateLimit(async (request: NextRequest): Promise<Response> => {
  const startTime = Date.now();
  const cacheAvailable = isKVAvailable();

  try {
    const auth = createAuth({
      DB: (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!,
    });

    const sessionResult = await auth.api.getSession({
      headers: request.headers,
      cookies: request.cookies as unknown as Record<string, string>,
    });

    if (!sessionResult?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (sessionResult.user as { id: string }).id;
    const DB = (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!;

    // Check cache first if KV is available
    if (cacheAvailable) {
      const cacheKey = getUserIdCacheKey('affiliate-dashboard', userId, 'v1');
      const cached = await getCached<typeof responseData>(cacheKey);
      if (cached) {
        const queryTime = Date.now() - startTime;
        return NextResponse.json(cached, {
          headers: {
            'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=15',
            'X-Cache': 'HIT',
            'X-Cache-Query-Time': String(queryTime),
            'X-Cache-TTL': '30',
            'Vary': 'Accept, Accept-Encoding, Cookie',
          },
        });
      }
    }

    // ========================================================================
    // Cache miss - fetch from database
    // ========================================================================

    const DB_START = Date.now();

    // Get affiliate profile with referral code
    const profile = await DB.prepare(`
      SELECT id, email, full_name, role, referral_code, created_at
      FROM profiles
      WHERE id = ?
    `)
      .bind(userId)
      .first<{
        id: string;
        email: string;
        full_name: string | null;
        role: string;
        referral_code: string | null;
        created_at: string;
      }>();

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    // Check if user is an affiliate (has role affiliate or higher)
    const isAffiliate = profile.role === 'affiliate' || profile.role === 'admin';
    const referralCode = profile.referral_code || generateReferralCode(userId);

    // If user doesn't have a referral code, generate one
    if (!profile.referral_code) {
      const newCode = generateReferralCode(userId);
      await DB.prepare('UPDATE profiles SET referral_code = ? WHERE id = ?')
        .bind(newCode, userId)
        .run();
    }

    // Get affiliate performance stats from view
    const performance = await DB.prepare(`
      SELECT
        p.id as affiliate_id,
        COALESCE(rt.level, 1) as level,
        COALESCE(rt.total_earnings, 0) as lifetime_earnings,
        COALESCE(rt.total_payouts, 0) as lifetime_payouts,
        COALESCE(rt.total_direct_referrals, 0) as total_direct_referrals,
        COALESCE(rt.total_indirect_referrals, 0) as total_indirect_referrals,
        COALESCE(ap.total_conversions, 0) as total_conversions,
        COALESCE(ap.total_revenue, 0) as total_revenue,
        COALESCE(ap.total_clicks, 0) as total_clicks,
        COALESCE(ap.conversion_rate, 0) as conversion_rate
      FROM profiles p
      LEFT JOIN referral_tree rt ON p.id = rt.affiliate_id
      LEFT JOIN v_affiliate_performance ap ON ap.affiliate_id = p.id
      WHERE p.id = ?
    `)
      .bind(userId)
      .first<{
        level: number | null;
        lifetime_earnings: number | null;
        lifetime_payouts: number | null;
        total_direct_referrals: number | null;
        total_indirect_referrals: number | null;
        total_conversions: number;
        total_revenue: number;
        total_clicks: number;
        conversion_rate: number;
      }>();

    // Get pending earnings
    const pendingResult = await DB.prepare(`
      SELECT COALESCE(SUM(amount), 0) as pending_earnings
      FROM earnings
      WHERE affiliate_id = ? AND is_paid = 0
    `)
      .bind(userId)
      .first<{ pending_earnings: number }>();

    // Get recent payouts
    const recentPayouts = await DB.prepare(`
      SELECT id, amount, net_amount, status, scheduled_at, paid_at, transaction_id
      FROM payouts
      WHERE affiliate_id = ?
      ORDER BY scheduled_at DESC
      LIMIT 5
    `)
      .bind(userId)
      .all<{
        id: string;
        amount: number;
        net_amount: number;
        status: string;
        scheduled_at: string | null;
        paid_at: string | null;
        transaction_id: string | null;
      }>();

    // Build referral tree structure
    const treeData = await buildReferralTree(DB, userId, {
      email: profile.email,
      full_name: profile.full_name,
    });

    // Build share link based on request host
    const url = new URL(request.url);
    const host = url.host;
    const shareLink = `https://${host}/signup?ref=${referralCode}`;

    const DB_TIME = Date.now() - DB_START;

    const responseData = {
      profile: {
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
        role: profile.role,
        referral_code: profile.referral_code || referralCode,
        is_affiliate: isAffiliate,
      },
      stats: {
        lifetime_earnings: performance?.lifetime_earnings || 0,
        pending_earnings: pendingResult?.pending_earnings || 0,
        lifetime_payouts: performance?.lifetime_payouts || 0,
        total_conversions: performance?.total_conversions || 0,
        total_clicks: performance?.total_clicks || 0,
        conversion_rate: performance?.conversion_rate || 0,
        direct_referrals: performance?.total_direct_referrals || 0,
        indirect_referrals: performance?.total_indirect_referrals || 0,
        total_referrals: (performance?.total_direct_referrals || 0) + (performance?.total_indirect_referrals || 0),
        total_revenue: performance?.total_revenue || 0,
      },
      share_link: shareLink,
      referral_tree: treeData,
      recent_payouts: recentPayouts,
    };

    const totalTime = Date.now() - startTime;

    // Cache the response if KV is available
    if (cacheAvailable) {
      try {
        const cacheKey = getUserIdCacheKey('affiliate-dashboard', userId, 'v1');
        await setCache(cacheKey, responseData, 30); // 30 second TTL
      } catch (cacheError) {
        console.error('[DashboardCache] Cache store error:', cacheError);
      }
    }

    return NextResponse.json(responseData, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=15',
        'X-Cache': 'MISS',
        'X-Cache-Query-Time': String(totalTime),
        'X-DB-Query-Time': String(DB_TIME),
        'X-Cache-TTL': '30',
        'Vary': 'Accept, Accept-Encoding, Cookie',
      },
    });
  } catch (error) {
    console.error('Error fetching affiliate dashboard:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}, {
  endpointType: 'api_general',
  getIdentifier: (request) => ({
    ip: extractIpAddress(request.headers)
  })
});
