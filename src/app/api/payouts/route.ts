/**
 * Payouts Admin API
 * Handles admin-triggered payout execution
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { createPayoutsService } from '@/lib/payouts';
import { invalidateAffiliateCache } from '@/lib/cache/cache-invalidation';
import { RateLimiter, extractIpAddress, type RateLimitResult } from '@/lib/ratelimit/rate-limiter';
import { error as logError, warn as logWarn } from '@/lib/logger';
import { enqueueTransactional } from '@/lib/emails/executor';
import { payoutCompletedTemplate } from '@/lib/emails/templates';

const PAYOUTS_RATE_LIMITER = new RateLimiter(
  (globalThis as unknown as { DB: any }).DB
);

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

    // Get pending earnings that haven't been paid
    const pendingEarningsQuery = `
      SELECT
        e.affiliate_id,
        SUM(e.amount) as total_amount,
        GROUP_CONCAT(e.id) as earning_ids
      FROM earnings e
      WHERE e.is_paid = 0
      GROUP BY e.affiliate_id
      HAVING total_amount >= 10.00 -- Minimum payout threshold $10
    `;

    const pendingResults = await DB.prepare(pendingEarningsQuery)
      .all<{
        affiliate_id: string;
        total_amount: number;
        earning_ids: string;
      }>();

    if (pendingResults.results.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No pending payouts to process',
        processed: 0,
        totalAmount: 0,
      });
    }

    // Get affiliate payout methods
    const affiliateIds = pendingResults.results.map(r => r.affiliate_id);
    const placeholders = affiliateIds.map(() => '?').join(',');
    const affiliates = await DB.prepare(`
      SELECT id, email, full_name, payout_method, payout_method_details
      FROM profiles
      WHERE id IN (${placeholders})
    `)
      .bind(...affiliateIds)
      .all<{
        id: string;
        email: string;
        full_name: string | null;
        payout_method: string | null;
        payout_method_details: string | null;
      }>();

    const affiliateMap = new Map(affiliates.results.map(a => [a.id, a]));

    // Create payouts
    const payoutsService = createPayoutsService(DB);
    const results = [];
    let totalPayoutAmount = 0;

    for (const pending of pendingResults.results) {
      const affiliate = affiliateMap.get(pending.affiliate_id);
      if (!affiliate) {
        logWarn(`Affiliate not found: ${pending.affiliate_id}`);
        continue;
      }

      const payoutMethod = affiliate.payout_method || 'crypto';
      const payoutDetails = affiliate.payout_method_details
        ? JSON.parse(affiliate.payout_method_details)
        : {};

      try {
        const netAmount = pending.total_amount - (pending.total_amount * 0.01); // 1% fee
        const payout = await payoutsService.createPayout({
          affiliate_id: pending.affiliate_id,
          payout_method: payoutMethod as 'crypto' | 'sepay' | 'bank_transfer',
          payout_method_details: payoutDetails,
          amount: pending.total_amount,
          net_amount: netAmount,
          currency: 'USDC',
          fee: pending.total_amount * 0.01, // 1% fee
          scheduled_at: new Date().toISOString(),
          status: 'processing',
          notes: `Auto-generated payout for ${pending.earning_ids.split(',').length} earnings`,
        });

 // Reserve the earnings against this payout without marking them paid. This
 // endpoint schedules the transfer; it does not perform it, so the earnings are
 // retired only once a broadcast is confirmed on chain by the settlement gate.
 const earningIds = pending.earning_ids.split(',');
 for (const earningId of earningIds) {
   await DB.prepare('UPDATE earnings SET payout_id = ? WHERE id = ?')
     .bind(payout.id, earningId)
     .run();
 }

 // Queue payout-sent email (non-blocking)
 try {
   const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://apex-os.com';
   const explorerUrl = payout.transaction_id
    ? `https://stellar.expert/explorer/testnet/tx/${payout.transaction_id}`
    : `${baseUrl}/dashboard/payouts`;
   const html = payoutCompletedTemplate({
     userName: affiliate.full_name || affiliate.email,
     userEmail: affiliate.email,
     locale: 'en',
     baseUrl,
     amount: pending.total_amount,
     transactionHash: payout.transaction_id || payout.id,
     walletAddress: payoutDetails.address || '',
     network: 'testnet',
     payoutDate: new Date().toLocaleDateString(),
     explorerUrl,
   });
   enqueueTransactional({
     userId: pending.affiliate_id,
     email: affiliate.email,
     type: 'payout-completed',
     subject: `Payout Sent: $${pending.total_amount.toFixed(2)} USDC to your wallet`,
     html,
     priority: 1,
   });
 } catch (enqueueError) {
   logError(`[Payouts] enqueue failed for ${pending.affiliate_id}:`, enqueueError);
 }

 results.push({
   affiliate_id: pending.affiliate_id,
   affiliate_email: affiliate.email,
   amount: pending.total_amount,
   payout_id: payout.id,
 });
 totalPayoutAmount += pending.total_amount;
      } catch (error) {
        logError(`Failed to create payout for ${pending.affiliate_id}:`, error);
      }
    }

    // Invalidate cache for all affected affiliates (async)
    const affiliateIdsToInvalidate = results.map(r => r.affiliate_id);
    for (const affiliateId of affiliateIdsToInvalidate) {
      void invalidateAffiliateCache(affiliateId, ['affiliate-dashboard', 'affiliate-payouts']).catch(err =>
        logError('[Payouts] Cache invalidation error:', err)
      );
    }

    return NextResponse.json({
      success: true,
      message: `Processed ${results.length} payouts`,
      processed: results.length,
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
