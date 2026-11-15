/**
 * Payouts Admin API
 * Handles admin-triggered payout execution
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { guardLegacyAdminPayoutMutation } from '@/lib/compliance/legacy-route-guards';
import type { D1Database } from '@/lib/db';
import { BatchSettlementService } from '@/lib/payouts';
import { invalidateAffiliateCache } from '@/lib/cache/cache-invalidation';
import { RateLimiter, extractIpAddress, type RateLimitResult } from '@/lib/ratelimit/rate-limiter';
import { error as logError } from '@/lib/logger';

async function checkPayoutsRateLimit(request: NextRequest): Promise<RateLimitResult | null> {
  const db = (globalThis as unknown as { DB: any }).DB;
  if (!db) return null;
  const limiter = new RateLimiter(db);
  const ip = extractIpAddress(request.headers);
  const result = await limiter.checkLimit('admin', { ip });
  return result;
}

/**
 * Check if user is admin
 */
async function isAdmin(userId: string): Promise<boolean> {
  const db = (globalThis as unknown as { DB: any }).DB;
  const profile = await db.prepare('SELECT role FROM profiles WHERE id = ?')
    .bind(userId)
    .first() as { role: string } | undefined;
  return profile?.role === 'admin';
}

/**
 * POST /api/payouts/run
 * Manually trigger payout batch processing (admin only)
 * In production, this should be called by a cron job weekly
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
  // Rate limit: admin endpoints - 10 req/min per IP
  const rateResult = await checkPayoutsRateLimit(request);
  if (rateResult && !rateResult.allowed) {
   return NextResponse.json(
    { error: 'Too Many Requests', retryAfter: rateResult.retryAfter },
    { status: 429 }
   );
  }
    const rawGlobalDb = (globalThis as unknown as { DB?: D1Database }).DB ?? null;
    const legacyBlock = await guardLegacyAdminPayoutMutation(request, rawGlobalDb);
    if (legacyBlock) {
      return legacyBlock;
    }

    // Authenticate
    const auth = createAuth({
      DB: (globalThis as unknown as { DB?: Parameters<typeof createAuth>[0]['DB'] }).DB!,
    });

    const sessionResult = await auth.api.getSession({
      headers: request.headers,
      cookies: request.cookies as unknown as Record<string, string>,
    });

    if (!sessionResult?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (sessionResult.user as { id: string }).id;
    const admin = await isAdmin(userId);

    if (!admin) {
      return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Get database
    const DB = (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!;

    // Run the full settlement cycle: select eligible affiliates, reserve their
    // earnings, perform the transfer, and reconcile from the on-chain verdict.
    // This endpoint triggers the cycle; it does not move money or retire
    // earnings itself, so a scheduled-but-unconfirmed transfer leaves the
    // ledger payable rather than falsely closed.
    const settlementService = new BatchSettlementService();
    const result = await settlementService.executeBatch({
      chain: 'stellar',
      minThreshold: 10,
      adminId: userId,
      adminEmail: (sessionResult.user as { email?: string }).email ?? null,
      ipAddress: extractIpAddress(request.headers),
    });

    // Report every payout the cycle attempted, attributed where the executor
    // could attribute one. Cache invalidation needs a concrete affiliate id, so
    // it covers only the attributed rows rather than the whole result set.
    const results = result.payouts.map((p) => ({
      affiliate_id: p.affiliateId ?? null,
      amount: p.amount,
      payout_id: p.payoutId,
    }));
    const totalPayoutAmount = result.totalAmount;

    if (result.failedPayouts > 0) {
      logError(`[Payouts] ${result.failedPayouts} payout(s) failed of ${result.totalPayouts} attempted`);
    }

    // Invalidate cache for the affiliates this cycle touched. Results without an
    // attributed affiliate cannot name a dashboard cache key, so they are skipped
    // rather than invalidated under a null id.
    const affiliateIdsToInvalidate = results
      .map(r => r.affiliate_id)
      .filter((id): id is string => typeof id === 'string');
    for (const affiliateId of affiliateIdsToInvalidate) {
      void invalidateAffiliateCache(affiliateId, ['affiliate-dashboard', 'affiliate-payouts']).catch(err =>
        logError('[Payouts] Cache invalidation error:', err)
      );
    }

    return NextResponse.json({
      success: result.failedPayouts === 0,
      message: result.totalPayouts === 0
        ? 'No pending payouts to process'
        : `Processed ${result.successfulPayouts} payouts`,
      processed: result.successfulPayouts,
      failed: result.failedPayouts,
      totalAmount: totalPayoutAmount,
      payouts: results,
    });

  } catch (error) {
    logError('Payout execution error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}

/**
 * GET /api/payouts/run
 * Returns pending payout summary (admin only)
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
  // Rate limit: admin endpoints - 10 req/min per IP
  const rateResult = await checkPayoutsRateLimit(request);
  if (rateResult && !rateResult.allowed) {
   return NextResponse.json(
    { error: 'Too Many Requests', retryAfter: rateResult.retryAfter },
    { status: 429 }
   );
  }
    // Authenticate
    const auth = createAuth({
      DB: (globalThis as unknown as { DB?: Parameters<typeof createAuth>[0]['DB'] }).DB!,
    });

    const sessionResult = await auth.api.getSession({
      headers: request.headers,
      cookies: request.cookies as unknown as Record<string, string>,
    });

    if (!sessionResult?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (sessionResult.user as { id: string }).id;
    const admin = await isAdmin(userId);

    if (!admin) {
      return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Get database
    const DB = (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!;

    // Get pending payout summary
    const summaryQuery = `
      SELECT
        COUNT(DISTINCT e.affiliate_id) as affiliate_count,
        SUM(e.amount) as total_amount,
        COUNT(e.id) as earning_count
      FROM earnings e
      WHERE e.is_paid = 0
    `;

    const summary = await DB.prepare(summaryQuery)
      .first<{ affiliate_count: number; total_amount: number; earning_count: number }>();

    // Get top affiliates by pending amount
    const topAffiliatesQuery = `
      SELECT
        p.id,
        p.email,
        p.full_name,
        SUM(e.amount) as pending_amount,
        COUNT(e.id) as pending_earnings
      FROM earnings e
      JOIN profiles p ON e.affiliate_id = p.id
      WHERE e.is_paid = 0
      GROUP BY p.id, p.email, p.full_name
      ORDER BY pending_amount DESC
      LIMIT 10
    `;

    const topAffiliates = await DB.prepare(topAffiliatesQuery)
      .all<{
        id: string;
        email: string;
        full_name: string | null;
        pending_amount: number;
        pending_earnings: number;
      }>();

    return NextResponse.json({
      success: true,
      summary: summary || { affiliate_count: 0, total_amount: 0, earning_count: 0 },
      topAffiliates: topAffiliates.results,
    });

  } catch (error) {
    logError('Payout summary error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
