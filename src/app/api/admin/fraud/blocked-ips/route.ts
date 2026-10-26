/**
 * ApexOS Admin Fraud API: Blocked IPs Management
 * Route: GET, POST, DELETE /api/admin/fraud/blocked-ips
 *
 * Implements Feature F11: Admin Fraud API Endpoints.
 * - Authenticated and guarded by admin RBAC (401 unauthenticated, 403 non-admin).
 * - Lists, searches, and paginates blocked IP addresses.
 * - Manually adds and removes IP blacklist entries with immutable audit logging.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import { normalizeIpAddress } from '@/lib/fraud/ip-blocker';
import { verifyAdminAccess, recordFraudDecision } from '@/lib/fraud/audit-logger';
import { BlockedIpDetailItem } from '@/types/fraud';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await verifyAdminAccess(request);
  if (auth.authorized === false) {
    return auth.response;
  }

  const { searchParams } = new URL(request.url);
  const rawPage = parseInt(searchParams.get('page') || '1', 10);
  const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;

  const rawLimit = parseInt(searchParams.get('limit') || '50', 10);
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(100, rawLimit);

  const activeOnly = searchParams.get('activeOnly') === 'true';
  const search = searchParams.get('search')?.trim().toLowerCase();

  const db = getDB();
  const now = Date.now();

  const rowsRes = await db
    .prepare(
      'SELECT id, ip_address, reason, blocked_by, created_at, expires_at, is_active FROM blocked_ips ORDER BY created_at DESC'
    )
    .all<any>();

  let allRows = rowsRes.results || [];

  if (activeOnly) {
    allRows = allRows.filter((r) => {
      if (r.is_active !== 1) return false;
      if (r.expires_at) {
        const exp = new Date(r.expires_at).getTime();
        return isNaN(exp) || exp > now;
      }
      return true;
    });
  }

  if (search) {
    allRows = allRows.filter(
      (r) =>
        (r.ip_address && r.ip_address.toLowerCase().includes(search)) ||
        (r.reason && r.reason.toLowerCase().includes(search))
    );
  }

  const total = allRows.length;
  const paginated = allRows.slice((page - 1) * limit, page * limit);

  const blockedIps: BlockedIpDetailItem[] = paginated.map((r) => {
    let isActive = r.is_active === 1;
    if (isActive && r.expires_at) {
      const exp = new Date(r.expires_at).getTime();
      if (!isNaN(exp) && exp <= now) {
        isActive = false;
      }
    }

    return {
      id: r.id,
      ipAddress: r.ip_address,
      reason: r.reason,
      blockedBy: r.blocked_by,
      blockedAt: r.created_at,
      expiresAt: r.expires_at || null,
      isActive,
      flaggedClicksCount: 0,
      metadata: {},
      createdAt: r.created_at,
    };
  });

  return NextResponse.json({
    success: true,
    data: blockedIps,
    blockedIps, // Compatibility alias
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await verifyAdminAccess(request);
  if (auth.authorized === false) {
    return auth.response;
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Malformed JSON payload' },
      { status: 400 }
    );
  }

  const rawIp = body.ip || body.ipAddress;
  const ip = normalizeIpAddress(rawIp) || (typeof rawIp === 'string' ? rawIp.trim() : '');
  if (!ip) {
    return NextResponse.json(
      { success: false, error: 'IP address is required' },
      { status: 400 }
    );
  }

  const action = body.action || 'block';
  const reason = body.reason?.trim();
  if (!reason || reason.length < 3) {
    return NextResponse.json(
      { success: false, error: 'Reason must be at least 3 characters' },
      { status: 400 }
    );
  }

  const db = getDB();
  const decisionAction = action === 'unblock' ? 'unblock_ip' : 'block_ip';

  try {
    const result = await recordFraudDecision(
      db,
      {
        action: decisionAction,
        ipAddress: ip,
        reason,
        expiresAt: body.expiresAt || null,
        metadata: body.metadata || {},
      },
      {
        userId: auth.admin.userId,
        email: auth.admin.email,
      }
    );

    const nowIso = new Date().toISOString();
    return NextResponse.json({
      success: true,
      data: {
        id: result.reviewId,
        ipAddress: ip,
        reason,
        blockedBy: auth.admin.userId,
        blockedAt: nowIso,
        expiresAt: body.expiresAt || null,
        isActive: action !== 'unblock',
        metadata: body.metadata || {},
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      auditId: result.reviewId,
      message:
        action === 'unblock'
          ? `IP ${ip} unblocked successfully`
          : `IP ${ip} blocked successfully`,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to update blocked IP' },
      { status: 400 }
    );
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = await verifyAdminAccess(request);
  if (auth.authorized === false) {
    return auth.response;
  }

  const { searchParams } = new URL(request.url);
  let rawIp = searchParams.get('ip') || searchParams.get('ipAddress');
  let reason = searchParams.get('reason')?.trim();

  if (!rawIp) {
    try {
      const body = await request.json();
      rawIp = body.ip || body.ipAddress;
      reason = body.reason?.trim() || reason;
    } catch {
      // Body may not be provided on DELETE
    }
  }

  const ip = normalizeIpAddress(rawIp) || (typeof rawIp === 'string' ? rawIp.trim() : '');
  if (!ip) {
    return NextResponse.json(
      { success: false, error: 'IP address is required' },
      { status: 400 }
    );
  }

  const effectiveReason =
    reason && reason.length >= 3 ? reason : 'Manual unblock by administrator';
  const db = getDB();

  try {
    const result = await recordFraudDecision(
      db,
      {
        action: 'unblock_ip',
        ipAddress: ip,
        reason: effectiveReason,
      },
      {
        userId: auth.admin.userId,
        email: auth.admin.email,
      }
    );

    return NextResponse.json({
      success: true,
      unblocked: true,
      auditId: result.reviewId,
      message: `IP ${ip} unblocked successfully`,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to unblock IP' },
      { status: 400 }
    );
  }
}
