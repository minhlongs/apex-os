/**
 * ApexOS Admin Fraud API: Real-Time Telemetry & Statistics
 * Route: GET /api/admin/fraud/stats
 *
 * Implements Feature F11: Admin Fraud API Endpoints.
 * - Authenticated and guarded by admin RBAC (401 unauthenticated, 403 non-admin).
 * - Aggregates total traffic, flagged volumes, pending reviews, and blocked IPs.
 * - Computes real-time 24h fraud rates and top offender rankings.
 * - Handles boundary conditions (0% and 100% fraud rates) without NaN or division-by-zero.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import { FraudStatsSummary, FraudReasonCode } from '@/types/fraud';
import { verifyAdminAccess } from '@/lib/fraud/audit-logger';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await verifyAdminAccess(request);
  if (auth.authorized === false) {
    return auth.response;
  }

  const db = getDB();
  const now = Date.now();
  const cutoff24h = new Date(now - 24 * 3600 * 1000).toISOString();

  // 1. Parallel counts compatible with SQLite and MockFraudDatabase
  const [totalClicksRes, flaggedClicksRes, blockedIpsList, flaggedClicksRows] =
    await Promise.all([
      db
        .prepare('SELECT COUNT(*) as count FROM deal_clicks')
        .first<{ count?: number; 'COUNT(*)': number; total?: number }>(),
      db
        .prepare('SELECT COUNT(*) as count FROM deal_clicks WHERE is_suspicious = 1 OR (review_status IS NOT NULL AND review_status != \'pending\')')
        .first<{ count?: number; 'COUNT(*)': number; total?: number }>(),
      db
        .prepare(
          'SELECT id, ip_address, is_active, expires_at FROM blocked_ips'
        )
        .all<{
          id: string;
          ip_address: string;
          is_active: number;
          expires_at: string | null;
        }>(),
      db
        .prepare(
          'SELECT id, affiliate_code, ip_address, flag_reasons, review_status, created_at FROM deal_clicks WHERE is_suspicious = 1 OR (review_status IS NOT NULL AND review_status != \'pending\')'
        )
        .all<any>(),
    ]);

  const totalClicksEvaluated =
    totalClicksRes?.count ??
    totalClicksRes?.['COUNT(*)'] ??
    totalClicksRes?.total ??
    0;
  const totalFlaggedClicks =
    flaggedClicksRes?.count ??
    flaggedClicksRes?.['COUNT(*)'] ??
    flaggedClicksRes?.total ??
    0;

  // Safe percentage calculation: avoid NaN on 0 total clicks (F10-B2, F10-B3)
  const flaggedPercentage =
    totalClicksEvaluated > 0
      ? Math.round((totalFlaggedClicks / totalClicksEvaluated) * 10000) / 100
      : 0;

  // 2. Active blocked IPs resolution
  const allBlocked = blockedIpsList.results || [];
  const totalBlockedIps = allBlocked.length;
  const activeBlockedIps = allBlocked.filter((b) => {
    if (b.is_active !== 1) return false;
    if (b.expires_at) {
      const exp = new Date(b.expires_at).getTime();
      return isNaN(exp) || exp > now;
    }
    return true;
  }).length;

  // 3. Status breakdown & Reason breakdown
  const rows = flaggedClicksRows.results || [];
  let pendingReviews = 0;
  let approvedReviews = 0;
  let rejectedReviews = 0;
  let burstClicksCount = 0;
  let ratioAnomaliesCount = 0;
  let rateLimitViolationsCount = 0;
  let clicks24hFlagged = 0;

  const affiliateCounts: Record<string, number> = {};
  const ipCounts: Record<string, number> = {};

  for (const r of rows) {
    const status = (r.review_status || 'pending').toLowerCase();
    if (status === 'approved') {
      approvedReviews++;
    } else if (status === 'rejected') {
      rejectedReviews++;
    } else {
      pendingReviews++;
    }

    const reasonsStr = r.flag_reasons || '';
    if (reasonsStr.includes(FraudReasonCode.BURST_CLICK)) {
      burstClicksCount++;
    }
    if (reasonsStr.includes(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO)) {
      ratioAnomaliesCount++;
    }
    if (
      reasonsStr.includes(FraudReasonCode.RATE_LIMIT_EXCEEDED) ||
      reasonsStr.includes(FraudReasonCode.IP_RATE_LIMIT_EXCEEDED)
    ) {
      rateLimitViolationsCount++;
    }

    if (r.affiliate_code) {
      affiliateCounts[r.affiliate_code] =
        (affiliateCounts[r.affiliate_code] || 0) + 1;
    }
    if (r.ip_address) {
      ipCounts[r.ip_address] = (ipCounts[r.ip_address] || 0) + 1;
    }

    if (
      r.created_at &&
      new Date(r.created_at).getTime() >= new Date(cutoff24h).getTime()
    ) {
      clicks24hFlagged++;
    }
  }

  // Calculate 24h fraud rate relative to total evaluated clicks in 24h
  const fraudRate24h =
    totalClicksEvaluated > 0
      ? Math.round((clicks24hFlagged / totalClicksEvaluated) * 10000) / 100
      : 0;

  // Top 5 affiliates & IPs
  const topFlaggedAffiliates = Object.entries(affiliateCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([affiliateCode, flaggedCount]) => ({ affiliateCode, flaggedCount }));

  const topFlaggedIps = Object.entries(ipCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ipAddress, flaggedCount]) => ({ ipAddress, flaggedCount }));

  const data: FraudStatsSummary & { activeBlockedIps?: number; fraudRate24h: number } = {
    totalClicksEvaluated,
    totalFlaggedClicks,
    flaggedPercentage,
    totalBlockedIps,
    activeBlockedIps,
    pendingReviews,
    approvedReviews,
    rejectedReviews,
    burstClicksCount,
    ratioAnomaliesCount,
    rateLimitViolationsCount,
    topFlaggedAffiliates,
    topFlaggedIps,
    fraudRate24h,
  };

  return NextResponse.json({
    success: true,
    data,
    stats: data, // Dual alias for backward compatibility
  });
}
