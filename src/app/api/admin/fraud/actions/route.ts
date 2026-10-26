/**
 * ApexOS Admin Fraud API: Fraud Review Actions & Decisions
 * Route: POST /api/admin/fraud/actions
 *
 * Implements Feature F11: Admin Fraud API Endpoints & Feature F12.
 * - Authenticated and guarded by admin RBAC (401 unauthenticated, 403 non-admin).
 * - Handles approve, reject, block_ip, unblock_ip, bulk_resolve.
 * - Validates action types and non-empty reasons (returning 400 on error).
 * - Executes atomic dual-write via recordFraudDecision service.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import { isFraudReviewAction } from '@/types/fraud';
import { verifyAdminAccess, recordFraudDecision } from '@/lib/fraud/audit-logger';

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

  const { action, reason } = body || {};

  // 1. Boundary check: action validation (F11-B4)
  if (!action || typeof action !== 'string' || !isFraudReviewAction(action)) {
    return NextResponse.json(
      { success: false, error: `Invalid review action: ${action}` },
      { status: 400 }
    );
  }

  // 2. Boundary check: reason validation (F11-B5)
  if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
    return NextResponse.json(
      { success: false, error: 'Reason must be at least 3 characters' },
      { status: 400 }
    );
  }

  const db = getDB();

  try {
    const result = await recordFraudDecision(db, body, {
      userId: auth.admin.userId,
      email: auth.admin.email,
    });

    return NextResponse.json({
      success: true,
      affectedCount: result.affectedCount,
      auditIds: result.auditIds,
      reviewId: result.reviewId,
      message: result.message || `Action ${action} executed successfully`,
    });
  } catch (err: any) {
    const isNotFound = err?.statusCode === 404 || /not found/i.test(err?.message || '');
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to execute fraud action' },
      { status: isNotFound ? 404 : 400 }
    );
  }
}
