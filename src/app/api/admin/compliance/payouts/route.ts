/**
 * src/app/api/admin/compliance/payouts/route.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Admin Compliance Payout Holds Inspection Endpoint
 *
 * Guarded by verifyAdminPayoutAccess (RBAC: role IN ('admin', 'superadmin', 'super_admin')).
 * Returns paginated held payouts (kyc_required, compliance_blocked), joins profiles
 * for affiliate KYC data, supports dimensional filtering, and returns aggregate KPIs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminPayoutAccess } from '@/lib/payouts/admin-auth';
import { complianceAuditService } from '@/lib/compliance/audit-service';
import * as logger from '@/lib/logger';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = await verifyAdminPayoutAccess(request);
  if (!authResult.authorized) {
    return authResult.response;
  }

  const { db } = authResult;
  const url = new URL(request.url);

  // Check if caller requests audit logs view
  const view = url.searchParams.get('view');
  if (view === 'audit') {
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
    const action = url.searchParams.get('action') as any;
    const severity = url.searchParams.get('severity') as any;
    const targetId = url.searchParams.get('targetId') || undefined;
    const actorId = url.searchParams.get('actorId') || undefined;
    const startDate = url.searchParams.get('dateFrom') || undefined;
    const endDate = url.searchParams.get('dateTo') || undefined;

    try {
      const auditResult = await complianceAuditService.getAuditLogs(db, {
        page,
        limit,
        action,
        severity,
        targetId,
        actorId,
        startDate,
        endDate,
      });

      return NextResponse.json({
        success: true,
        ...auditResult,
      });
    } catch (err: any) {
      logger.error(`[Admin Compliance Payouts] Audit query error: ${err?.message || String(err)}`);
      return NextResponse.json(
        { success: false, error: 'Failed to retrieve compliance audit logs' },
        { status: 500 }
      );
    }
  }

  // Payout holds query
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
  const offset = (page - 1) * limit;

  const statusFilter = url.searchParams.get('status')?.toLowerCase() || 'all';
  const chainFilter = url.searchParams.get('chain')?.toLowerCase() || 'all';
  const affiliateIdFilter = url.searchParams.get('affiliateId')?.trim();
  const dateFrom = url.searchParams.get('dateFrom')?.trim();
  const dateTo = url.searchParams.get('dateTo')?.trim();

  // 1. Build WHERE conditions for filtered rows
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (statusFilter === 'kyc_required') {
    conditions.push("(p.compliance_status = 'kyc_required' OR p.status = 'kyc_required')");
  } else if (statusFilter === 'compliance_blocked') {
    conditions.push("(p.compliance_status = 'compliance_blocked' OR p.status = 'compliance_blocked')");
  } else {
    // Default: return all compliance holds
    conditions.push(
      "(p.compliance_status IN ('kyc_required', 'compliance_blocked') OR p.status IN ('kyc_required', 'compliance_blocked'))"
    );
  }

  if (chainFilter !== 'all' && ['ethereum', 'solana', 'stellar'].includes(chainFilter)) {
    conditions.push('p.chain = ?');
    params.push(chainFilter);
  }

  if (affiliateIdFilter) {
    conditions.push('p.affiliate_id = ?');
    params.push(affiliateIdFilter);
  }

  if (dateFrom) {
    conditions.push('p.created_at >= ?');
    params.push(dateFrom);
  }

  if (dateTo) {
    conditions.push('p.created_at <= ?');
    params.push(dateTo);
  }

  const whereClause = conditions.join(' AND ');

  try {
    // 2. Count total matching rows
    const countSql = `SELECT COUNT(*) as total FROM payouts p WHERE ${whereClause}`;
    const countRow = await db.prepare(countSql).bind(...params).first<{ total: number }>();
    const total = Number(countRow?.total ?? 0);

    // 3. Query paginated held payouts joining profiles
    const selectSql = `
      SELECT
        p.id,
        p.affiliate_id,
        p.amount,
        p.currency,
        p.fee,
        p.net_amount,
        p.status,
        p.chain,
        p.payout_method,
        p.payout_method_details,
        p.compliance_status,
        p.compliance_reason,
        p.created_at,
        p.updated_at,
        pr.email as affiliate_email,
        pr.kyc_tier as affiliate_kyc_tier,
        pr.kyc_status as affiliate_kyc_status,
        pr.wallet_address as affiliate_wallet_address
      FROM payouts p
      LEFT JOIN profiles pr ON p.affiliate_id = pr.id
      WHERE ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const selectParams = [...params, limit, offset];
    const dataResult = await db.prepare(selectSql).bind(...selectParams).all<any>();
    const payouts = dataResult.results ?? [];

    // 4. Compute aggregate summary KPIs over all held payouts in D1
    const kpiSql = `
      SELECT
        COALESCE(SUM(CASE WHEN p.compliance_status IN ('kyc_required', 'compliance_blocked') OR p.status IN ('kyc_required', 'compliance_blocked') THEN p.amount ELSE 0 END), 0) as total_held,
        COUNT(CASE WHEN p.compliance_status = 'kyc_required' OR p.status = 'kyc_required' THEN 1 END) as kyc_required_count,
        COUNT(CASE WHEN p.compliance_status = 'compliance_blocked' OR p.status = 'compliance_blocked' THEN 1 END) as compliance_blocked_count,
        COUNT(CASE WHEN p.compliance_status IN ('kyc_required', 'compliance_blocked') OR p.status IN ('kyc_required', 'compliance_blocked') THEN 1 END) as total_count
      FROM payouts p
    `;

    const kpiRow = await db.prepare(kpiSql).first<{
      total_held: number;
      kyc_required_count: number;
      compliance_blocked_count: number;
      total_count: number;
    }>();

    const totalHeldUsd = Number(kpiRow?.total_held ?? 0);
    const totalHeldCents = Math.round(totalHeldUsd * 100);
    const kycRequiredCount = Number(kpiRow?.kyc_required_count ?? 0);
    const complianceBlockedCount = Number(kpiRow?.compliance_blocked_count ?? 0);
    const totalCount = Number(kpiRow?.total_count ?? 0);

    return NextResponse.json({
      success: true,
      payouts,
      data: payouts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
      kpis: {
        totalHeldCents,
        totalHeldUsd,
        kycRequiredCount,
        complianceBlockedCount,
        totalCount,
      },
    });
  } catch (err: any) {
    logger.error(`[Admin Compliance Payouts] Query failed: ${err?.message || String(err)}`);
    return NextResponse.json(
      { success: false, error: 'Database query failed' },
      { status: 500 }
    );
  }
}
