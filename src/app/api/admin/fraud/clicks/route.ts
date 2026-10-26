/**
 * ApexOS Admin Fraud API: Suspicious Clicks Listing
 * Route: GET /api/admin/fraud/clicks
 *
 * Implements Feature F11: Admin Fraud API Endpoints.
 * - Authenticated and guarded by admin RBAC (401 unauthenticated, 403 non-admin).
 * - Multi-dimensional filtering by status, reason code, affiliate, IP, and date range.
 * - Boundary-safe pagination (page >= 1, 1 <= limit <= 100).
 * - Dual contract compatibility: returns both `data` and `clicks` arrays.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import { parseReasons, ClickReviewStatus, FlaggedClickDetail } from '@/types/fraud';
import { isIpBlocked } from '@/lib/fraud/ip-blocker';
import { verifyAdminAccess } from '@/lib/fraud/audit-logger';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await verifyAdminAccess(request);
  if (auth.authorized === false) {
    return auth.response;
  }

  const { searchParams } = new URL(request.url);

  // 1. Boundary-safe pagination parsing (F11-B1, F11-B2, F11-B3)
  const rawPage = parseInt(searchParams.get('page') || '1', 10);
  const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;

  const rawLimit = parseInt(searchParams.get('limit') || '20', 10);
  let limit = isNaN(rawLimit) || rawLimit < 1 ? 20 : rawLimit;
  if (limit > 100) limit = 100; // Cap extreme limit (F11-B3)

  const offset = (page - 1) * limit;

  // 2. Query filter parameters
  const statusParam = searchParams.get('status')?.toLowerCase() || searchParams.get('reviewStatus')?.toLowerCase();
  const reasonParam = searchParams.get('reason');
  const affiliateParam = searchParams.get('affiliateId') || searchParams.get('affiliateCode');
  const ipParam = searchParams.get('ip') || searchParams.get('ipAddress');
  const dealIdParam = searchParams.get('dealId');
  const dateFromParam = searchParams.get('dateFrom') || searchParams.get('startDate');
  const dateToParam = searchParams.get('dateTo') || searchParams.get('endDate');
  const searchParam = searchParams.get('search')?.trim();

  const db = getDB();

  // 3. Construct dynamic query clauses
  const whereClauses: string[] = [];
  const queryParams: any[] = [];

  // Review lifecycle status filtering
  if (statusParam === 'approved') {
    whereClauses.push('review_status = ?');
    queryParams.push('approved');
  } else if (statusParam === 'rejected') {
    whereClauses.push('review_status = ?');
    queryParams.push('rejected');
  } else if (statusParam === 'pending') {
    whereClauses.push('is_suspicious = 1 AND (review_status = ? OR review_status IS NULL)');
    queryParams.push('pending');
  } else if (statusParam === 'ignored' || statusParam === 'dismissed') {
    whereClauses.push('review_status = ?');
    queryParams.push('ignored');
  } else {
    // Default: status === 'all' or omitted/undefined
    // Retrieves all clicks that are currently flagged or have ever been reviewed
    whereClauses.push('(is_suspicious = 1 OR (review_status IS NOT NULL AND review_status != \'pending\'))');
  }

  if (reasonParam && reasonParam !== 'ALL') {
    whereClauses.push('flag_reasons LIKE ?');
    queryParams.push(`%${reasonParam}%`);
  }

  if (affiliateParam) {
    whereClauses.push('(affiliate_id = ? OR affiliate_code = ?)');
    queryParams.push(affiliateParam, affiliateParam);
  }

  if (ipParam) {
    whereClauses.push('ip_address = ?');
    queryParams.push(ipParam);
  }

  if (dealIdParam) {
    whereClauses.push('deal_id = ?');
    queryParams.push(dealIdParam);
  }

  if (dateFromParam) {
    whereClauses.push('created_at >= ?');
    queryParams.push(dateFromParam);
  }

  if (dateToParam) {
    whereClauses.push('created_at <= ?');
    queryParams.push(dateToParam);
  }

  if (searchParam) {
    whereClauses.push('(id LIKE ? OR ip_address LIKE ? OR affiliate_code LIKE ?)');
    queryParams.push(`%${searchParam}%`, `%${searchParam}%`, `%${searchParam}%`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // 4. Execute count query
  const countSql = `SELECT COUNT(*) as count FROM deal_clicks ${whereSql}`;
  const countStmt = db.prepare(countSql);
  const countResult = await (queryParams.length > 0 ? countStmt.bind(...queryParams) : countStmt)
    .first<{ count?: number; 'COUNT(*)': number; total?: number }>();
  const total = countResult?.count ?? countResult?.['COUNT(*)'] ?? countResult?.total ?? 0;

  // 5. Execute paginated data query
  const dataSql = `
    SELECT
      id, deal_id, affiliate_code, affiliate_id, session_id,
      ip_address, user_agent, referrer_url, country_code, device_type,
      click_type, is_unique, is_suspicious, flag_reasons, anomaly_score,
      review_status, reviewed_at, reviewed_by, created_at
    FROM deal_clicks
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  const dataParams = [...queryParams, limit, offset];
  const dataStmt = db.prepare(dataSql).bind(...dataParams);
  const { results: rawClicks } = await dataStmt.all<any>();

  // 6. Hydrate records
  const clicks: FlaggedClickDetail[] = await Promise.all(
    (rawClicks || []).map(async (row) => {
      const blocked = row.ip_address ? await isIpBlocked(db as any, row.ip_address) : false;
      const reasons = parseReasons(row.flag_reasons);

      return {
        id: row.id,
        dealId: row.deal_id,
        dealName: undefined,
        affiliateCode: row.affiliate_code,
        affiliateId: row.affiliate_id,
        affiliateEmail: null,
        sessionId: row.session_id,
        ipAddress: row.ip_address,
        isIpBlocked: blocked,
        userAgent: row.user_agent,
        referrerUrl: row.referrer_url,
        countryCode: row.country_code,
        deviceType: row.device_type,
        isSuspicious: Boolean(row.is_suspicious),
        anomalyScore: Number(row.anomaly_score ?? 0),
        flagReasons: reasons,
        reviewStatus: (row.review_status as ClickReviewStatus) || 'pending',
        reviewedAt: row.reviewed_at || null,
        reviewedBy: row.reviewed_by || null,
        createdAt: row.created_at,
      };
    })
  );

  return NextResponse.json({
    success: true,
    data: clicks,
    clicks, // Backward compatibility alias for E2E tests
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
}
