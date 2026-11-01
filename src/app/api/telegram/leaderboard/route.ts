/**
 * src/app/api/telegram/leaderboard/route.ts
 *
 * Edge-Compatible Telegram Social Referral Leaderboard API Route
 *
 * Features:
 * - Edge runtime: export const runtime = 'edge';
 * - GET /api/telegram/leaderboard?limit=20&offset=0&period=all_time
 * - Query parameter validation (limit 1-100, offset >= 0, period: all_time | monthly | weekly)
 * - Dynamic ranking aggregation by verified referee count and volume
 * - Cold-start fallback to referral_tree and profiles when telegram_referrals is fresh or has limited data
 * - Strict privacy sanitization: never exposes emails, profile UUIDs, raw tokens, or IP addresses
 * - HTTP Edge Caching: Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=120
 * - CORS support for GET and OPTIONS
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveDatabase } from '@/lib/auth/session-helper';
import { getDB, type D1Database } from '@/lib/db';
import { warn as logWarn, error as logError } from '@/lib/logger';
import type {
  LeaderboardEntry,
  LeaderboardPeriod,
  LeaderboardResponse,
} from '@/types/telegram';

const CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Resolves Cloudflare D1 database across edge Workers, request env, and test mocks
 */
function getDatabase(request?: Request): D1Database | null {
  if (request && 'env' in request && (request as any).env?.DB) {
    return (request as any).env.DB;
  }
  try {
    const db = resolveDatabase();
    if (db) return db;
  } catch {
    // Fallback below
  }
  try {
    return getDB();
  } catch {
    const globalDb = (globalThis as unknown as { DB?: D1Database }).DB;
    return globalDb || null;
  }
}

/**
 * Computes referral tier badge based on verified referrals count and volume
 */
function calculateTier(
  referrals: number,
  volumeUsd: number
): 'DIAMOND' | 'PLATINUM' | 'GOLD' | 'SILVER' | 'BRONZE' {
  if (referrals >= 50 || volumeUsd >= 5000) return 'DIAMOND';
  if (referrals >= 25 || volumeUsd >= 2000) return 'PLATINUM';
  if (referrals >= 10 || volumeUsd >= 500) return 'GOLD';
  if (referrals >= 3 || volumeUsd >= 100) return 'SILVER';
  return 'BRONZE';
}

/**
 * Computes podium badge based on sequential 1-indexed rank
 */
function calculateBadge(
  rank: number
): 'gold' | 'silver' | 'bronze' | 'top_10' | 'contender' {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  if (rank <= 10) return 'top_10';
  return 'contender';
}

/**
 * Handles CORS Preflight OPTIONS requests
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/**
 * GET /api/telegram/leaderboard
 * Aggregates top referrers by verified referee count and volume with cold-start fallback
 */
export async function GET(request: NextRequest) {
  const db = getDatabase(request);
  if (!db) {
    logError('[Telegram Leaderboard] Database service unavailable');
    return NextResponse.json(
      { success: false, error: 'Database service unavailable' },
      { status: 500, headers: CACHE_HEADERS }
    );
  }

  const { searchParams } = new URL(request.url);

  // Pagination parameters
  const limitParam = searchParams.get('limit');
  const parsedLimit = limitParam ? parseInt(limitParam, 10) : 20;
  const limit = isNaN(parsedLimit) || parsedLimit < 1 ? 20 : Math.min(parsedLimit, 100);

  const offsetParam = searchParams.get('offset');
  const parsedOffset = offsetParam ? parseInt(offsetParam, 10) : 0;
  const offset = isNaN(parsedOffset) || parsedOffset < 0 ? 0 : parsedOffset;

  // Period filter parameter
  const rawPeriod = searchParams.get('period')?.toLowerCase() || 'all_time';
  let period: LeaderboardPeriod = 'all_time';
  let dateClause = '';
  if (rawPeriod === 'week' || rawPeriod === 'weekly') {
    period = 'weekly';
    dateClause = " AND datetime(tr.created_at) >= datetime('now', '-7 days')";
  } else if (rawPeriod === 'month' || rawPeriod === 'monthly') {
    period = 'monthly';
    dateClause = " AND datetime(tr.created_at) >= datetime('now', '-30 days')";
  } else {
    period = 'all_time';
  }

  const targetTelegramId = searchParams.get('telegram_id');
  const targetUserId = searchParams.get('user_id');

  try {
    // 1. Primary Query: aggregate verified referrals from telegram_referrals
    const primarySql = `
      SELECT 
        tr.referrer_id as telegram_id,
        tu.username,
        tu.first_name,
        tu.photo_url,
        tr.referral_code,
        COUNT(CASE WHEN tr.status IN ('active', 'converted', 'completed', 'rewarded') THEN 1 END) as verified_referees,
        SUM(CASE WHEN tr.status IN ('active', 'converted', 'completed', 'rewarded') THEN tr.reward_amount ELSE 0 END) as total_earnings_usd
      FROM telegram_referrals tr
      LEFT JOIN telegram_users tu ON tu.telegram_id = tr.referrer_id
      WHERE tr.referrer_id IS NOT NULL ${dateClause}
      GROUP BY tr.referrer_id
      HAVING verified_referees > 0
      ORDER BY verified_referees DESC, total_earnings_usd DESC
      LIMIT ? OFFSET ?
    `;

    const countSql = `
      SELECT COUNT(DISTINCT tr.referrer_id) as total_count
      FROM telegram_referrals tr
      WHERE tr.referrer_id IS NOT NULL AND tr.status IN ('active', 'converted', 'completed', 'rewarded') ${dateClause}
    `;

    let primaryRows: any[] = [];
    let totalCount = 0;

    try {
      const primaryStmt = db.prepare(primarySql);
      const primaryResult = await primaryStmt.bind(limit, offset).all();
      primaryRows = Array.isArray(primaryResult?.results) ? primaryResult.results : [];

      const countStmt = db.prepare(countSql);
      const countResult = await countStmt.first<{ total_count: number }>();
      totalCount = countResult?.total_count || 0;
    } catch (queryErr) {
      logWarn(`[Telegram Leaderboard] telegram_referrals query failed or empty, attempting fallback: ${queryErr}`);
      primaryRows = [];
      totalCount = 0;
    }

    let entries: LeaderboardEntry[] = [];

    // 2. Cold-start fallback: If telegram_referrals has fewer rows or is empty
    if (primaryRows.length === 0) {
      const fallbackSql = `
        SELECT 
          rt.affiliate_id,
          rt.total_direct_referrals as verified_referees,
          rt.total_earnings as total_earnings_usd,
          p.full_name,
          p.avatar_url,
          p.referral_code,
          tu.telegram_id,
          tu.username,
          tu.first_name,
          tu.photo_url
        FROM referral_tree rt
        JOIN profiles p ON p.id = rt.affiliate_id
        LEFT JOIN telegram_users tu ON tu.user_id = p.id
        WHERE rt.is_active = 1 AND rt.total_direct_referrals > 0
        ORDER BY rt.total_direct_referrals DESC, rt.total_earnings DESC
        LIMIT ? OFFSET ?
      `;

      const fallbackCountSql = `
        SELECT COUNT(*) as total_count
        FROM referral_tree rt
        WHERE rt.is_active = 1 AND rt.total_direct_referrals > 0
      `;

      try {
        const fallbackStmt = db.prepare(fallbackSql);
        const fallbackResult = await fallbackStmt.bind(limit, offset).all();
        const fallbackRows = Array.isArray(fallbackResult?.results) ? fallbackResult.results : [];

        const fbCountStmt = db.prepare(fallbackCountSql);
        const fbCountResult = await fbCountStmt.first<{ total_count: number }>();
        totalCount = fbCountResult?.total_count || 0;

        entries = fallbackRows.map((row: any, index: number) => {
          const rank = offset + index + 1;
          const tid = row.telegram_id ? Number(row.telegram_id) : undefined;
          const rawUsername = row.username ? String(row.username).replace(/^@/, '') : null;
          const formattedUsername = rawUsername ? `@${rawUsername}` : null;
          const firstName = row.first_name || (row.full_name ? String(row.full_name).split(' ')[0] : 'Member');
          const displayName = formattedUsername || firstName || 'Apex Member';
          const avatarUrl = row.photo_url || row.avatar_url || null;
          const refCode = row.referral_code || (tid ? `TG${tid}` : `REF${rank}`);
          const verifiedReferees = Number(row.verified_referees) || 0;
          const earningsUsd = Math.round((Number(row.total_earnings_usd) || 0) * 100) / 100;
          const volumeUsd = row.total_volume_usd !== undefined
            ? Math.round(Number(row.total_volume_usd) * 100) / 100
            : earningsUsd;

          return {
            rank,
            telegram_id: tid,
            username: formattedUsername,
            first_name: firstName,
            display_name: displayName,
            photo_url: avatarUrl,
            avatar_url: avatarUrl,
            referral_code: refCode,
            verified_referees: verifiedReferees,
            total_referrals: verifiedReferees,
            total_volume_usd: volumeUsd,
            total_earnings_usd: earningsUsd,
            badge: calculateBadge(rank),
            tier: calculateTier(verifiedReferees, volumeUsd),
          };
        });
      } catch (fbErr) {
        logError(`[Telegram Leaderboard] Fallback query failed: ${fbErr}`);
        throw fbErr;
      }
    } else {
      // Format primary telegram referral rows
      entries = primaryRows.map((row: any, index: number) => {
        const rank = offset + index + 1;
        const tid = row.telegram_id ? Number(row.telegram_id) : undefined;
        const rawUsername = row.username ? String(row.username).replace(/^@/, '') : null;
        const formattedUsername = rawUsername ? `@${rawUsername}` : null;
        const firstName = row.first_name || (rawUsername ? rawUsername : `User ${rank}`);
        const displayName = formattedUsername || firstName;
        const avatarUrl = row.photo_url || null;
        const refCode = row.referral_code || (tid ? `TG${tid}` : `REF${rank}`);
        const verifiedReferees = Number(row.verified_referees) || 0;
        const earningsUsd = Math.round((Number(row.total_earnings_usd) || 0) * 100) / 100;
        const volumeUsd = row.total_volume_usd !== undefined
          ? Math.round(Number(row.total_volume_usd) * 100) / 100
          : earningsUsd;

        return {
          rank,
          telegram_id: tid,
          username: formattedUsername,
          first_name: firstName,
          display_name: displayName,
          photo_url: avatarUrl,
          avatar_url: avatarUrl,
          referral_code: refCode,
          verified_referees: verifiedReferees,
          total_referrals: verifiedReferees,
          total_volume_usd: volumeUsd,
          total_earnings_usd: earningsUsd,
          badge: calculateBadge(rank),
          tier: calculateTier(verifiedReferees, volumeUsd),
        };
      });
    }

    // 3. User Rank Resolution if specific target user requested
    let userRank: LeaderboardResponse['user_rank'] = null;
    if (targetTelegramId || targetUserId) {
      const targetTid = targetTelegramId ? Number(targetTelegramId) : null;
      const foundInPage = entries.find(
        (e) => (targetTid && e.telegram_id === targetTid)
      );

      if (foundInPage) {
        userRank = {
          rank: foundInPage.rank,
          verified_referees: foundInPage.verified_referees,
          total_volume_usd: foundInPage.total_volume_usd,
          total_earnings_usd: foundInPage.total_earnings_usd,
        };
      }
    }

    const now = new Date().toISOString();

    const responsePayload = {
      success: true,
      period,
      leaderboard: entries,
      data: entries,
      total: totalCount,
      total_participants: totalCount,
      user_rank: userRank,
      generated_at: now,
      updated_at: now,
    };

    return NextResponse.json(responsePayload, {
      status: 200,
      headers: CACHE_HEADERS,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError(`[Telegram Leaderboard] Unexpected error: ${errorMsg}`);
    return NextResponse.json(
      { success: false, error: 'Internal server error processing leaderboard' },
      { status: 500, headers: CACHE_HEADERS }
    );
  }
}
