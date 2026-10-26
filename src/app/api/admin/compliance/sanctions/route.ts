/**
 * src/app/api/admin/compliance/sanctions/route.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Admin Sanctions & AML Watchlist Management Endpoints
 *
 * Guarded by verifyAdminPayoutAccess (RBAC: role IN ('admin', 'superadmin', 'super_admin')).
 * GET: Lists sanctioned addresses with chain filtering, search, and pagination.
 * POST: Adds newly flagged address with normalization and critical audit log.
 * DELETE: Removes address from sanctions watchlist with audit log.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminPayoutAccess } from '@/lib/payouts/admin-auth';
import { complianceAuditService } from '@/lib/compliance/audit-service';
import { sanctionsScreeningService } from '@/lib/compliance/sanctions-service';
import type { SupportedPayoutChain } from '@/lib/payouts/types';
import * as logger from '@/lib/logger';

const VALID_CHAINS = ['ethereum', 'solana', 'stellar'] as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = await verifyAdminPayoutAccess(request);
  if (!authResult.authorized) {
    return authResult.response;
  }

  const { db } = authResult;
  const url = new URL(request.url);

  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
  const offset = (page - 1) * limit;

  const chainFilter = url.searchParams.get('chain')?.toLowerCase() || 'all';
  const search = url.searchParams.get('search')?.trim();

  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];

  if (chainFilter !== 'all' && VALID_CHAINS.includes(chainFilter as any)) {
    conditions.push('chain = ?');
    params.push(chainFilter);
  }

  if (search) {
    conditions.push('(lower(address) LIKE ? OR lower(source) LIKE ?)');
    params.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`);
  }

  const whereClause = conditions.join(' AND ');

  try {
    const countSql = `SELECT COUNT(*) as total FROM sanctioned_addresses WHERE ${whereClause}`;
    const countRow = await db.prepare(countSql).bind(...params).first<{ total: number }>();
    const total = Number(countRow?.total ?? 0);

    const selectSql = `
      SELECT address, chain, source, risk_score, added_at
      FROM sanctioned_addresses
      WHERE ${whereClause}
      ORDER BY added_at DESC
      LIMIT ? OFFSET ?
    `;
    const selectParams = [...params, limit, offset];
    const dataResult = await db.prepare(selectSql).bind(...selectParams).all<any>();
    const addresses = dataResult.results ?? [];

    return NextResponse.json({
      success: true,
      addresses,
      data: addresses,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err: any) {
    logger.error(`[Admin Sanctions] Query failed: ${err?.message || String(err)}`);
    return NextResponse.json(
      { success: false, error: 'Database query failed' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = await verifyAdminPayoutAccess(request);
  if (!authResult.authorized) {
    return authResult.response;
  }

  const { db, admin } = authResult;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Malformed JSON payload' },
      { status: 400 }
    );
  }

  const { address, chain, source, riskScore, reason } = body || {};

  if (!address || typeof address !== 'string' || address.trim() === '') {
    return NextResponse.json(
      { success: false, error: 'address is required' },
      { status: 400 }
    );
  }

  const normalizedChain = (chain || '').toLowerCase().trim() as SupportedPayoutChain;
  if (!VALID_CHAINS.includes(normalizedChain as any)) {
    return NextResponse.json(
      {
        success: false,
        error: `Invalid chain '${chain}'. Supported chains: ${VALID_CHAINS.join(', ')}`,
      },
      { status: 400 }
    );
  }

  let normalizedAddress: string;
  try {
    normalizedAddress = sanctionsScreeningService.normalizeAddress(
      address,
      normalizedChain
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Invalid address format' },
      { status: 400 }
    );
  }

  const effectiveRisk = typeof riskScore === 'number' ? Math.max(0, Math.min(1, riskScore)) : 1.0;
  const effectiveSource = source?.trim() || reason?.trim() || 'Manual Administrative Block';

  try {
    const insertStmt = db
      .prepare(`
        INSERT INTO sanctioned_addresses (address, chain, source, risk_score, added_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(chain, address) DO UPDATE SET
          source = excluded.source,
          risk_score = excluded.risk_score
      `)
      .bind(normalizedAddress, normalizedChain, effectiveSource, effectiveRisk);

    const auditStmt = complianceAuditService.createAuditStatement(db, {
      action: 'admin_flag_address',
      severity: 'critical',
      actorId: admin.id,
      targetId: normalizedAddress,
      details: {
        action: 'add_sanctioned_address',
        address: normalizedAddress,
        chain: normalizedChain,
        source: effectiveSource,
        riskScore: effectiveRisk,
        reason: reason || effectiveSource,
        adminEmail: admin.email,
      },
    });

    await db.batch([insertStmt, auditStmt]);

    logger.info(
      `[Admin Sanctions] Added ${normalizedChain} address ${normalizedAddress} by ${admin.email}`
    );

    return NextResponse.json({
      success: true,
      address: normalizedAddress,
      chain: normalizedChain,
      message: 'Address added to sanctions watchlist',
    });
  } catch (err: any) {
    logger.error(`[Admin Sanctions] Insertion failed: ${err?.message || String(err)}`);
    return NextResponse.json(
      { success: false, error: 'Database transaction failed' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const authResult = await verifyAdminPayoutAccess(request);
  if (!authResult.authorized) {
    return authResult.response;
  }

  const { db, admin } = authResult;

  let address: string | null = null;
  let chain: string | null = null;
  let reason: string | null = null;

  try {
    const body = await request.json();
    address = body?.address;
    chain = body?.chain;
    reason = body?.reason;
  } catch {
    // Check searchParams as fallback
    const url = new URL(request.url);
    address = url.searchParams.get('address');
    chain = url.searchParams.get('chain');
    reason = url.searchParams.get('reason');
  }

  if (!address || typeof address !== 'string' || address.trim() === '') {
    return NextResponse.json(
      { success: false, error: 'address is required' },
      { status: 400 }
    );
  }

  const normalizedChain = (chain || '').toLowerCase().trim() as SupportedPayoutChain;
  if (!VALID_CHAINS.includes(normalizedChain as any)) {
    return NextResponse.json(
      {
        success: false,
        error: `Invalid chain '${chain}'. Supported chains: ${VALID_CHAINS.join(', ')}`,
      },
      { status: 400 }
    );
  }

  let normalizedAddress: string;
  try {
    normalizedAddress = sanctionsScreeningService.normalizeAddress(
      address,
      normalizedChain
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Invalid address format' },
      { status: 400 }
    );
  }

  try {
    const deleteStmt = db
      .prepare(`
        DELETE FROM sanctioned_addresses
        WHERE chain = ? AND lower(address) = lower(?)
      `)
      .bind(normalizedChain, normalizedAddress);

    const auditStmt = complianceAuditService.createAuditStatement(db, {
      action: 'admin_override',
      severity: 'high',
      actorId: admin.id,
      targetId: normalizedAddress,
      details: {
        action: 'remove_sanctioned_address',
        address: normalizedAddress,
        chain: normalizedChain,
        reason: reason || 'Administrative removal from sanctions watchlist',
        adminEmail: admin.email,
      },
    });

    await db.batch([deleteStmt, auditStmt]);

    logger.info(
      `[Admin Sanctions] Removed ${normalizedChain} address ${normalizedAddress} by ${admin.email}`
    );

    return NextResponse.json({
      success: true,
      address: normalizedAddress,
      chain: normalizedChain,
      message: 'Address removed from sanctions watchlist',
    });
  } catch (err: any) {
    logger.error(`[Admin Sanctions] Removal failed: ${err?.message || String(err)}`);
    return NextResponse.json(
      { success: false, error: 'Database transaction failed' },
      { status: 500 }
    );
  }
}
