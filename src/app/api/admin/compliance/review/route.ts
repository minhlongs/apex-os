/**
 * src/app/api/admin/compliance/review/route.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Admin Compliance Review & Manual Override Route
 *
 * Guarded by verifyAdminPayoutAccess (RBAC: role IN ('admin', 'superadmin', 'super_admin')).
 * Validates review actions ('approve'/'override', 'reject', 'reverify', 'flag_address')
 * and review reason (minimum 5 characters).
 * Performs atomic dual-write updating payout/profile and logging to compliance_audit_logs
 * using db.batch([updateStmt, auditStmt]).
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminPayoutAccess } from '@/lib/payouts/admin-auth';
import { complianceAuditService } from '@/lib/compliance/audit-service';
import { sanctionsScreeningService } from '@/lib/compliance/sanctions-service';
import type { D1PreparedStatement } from '@/lib/db';
import type { SupportedPayoutChain } from '@/lib/payouts/types';
import * as logger from '@/lib/logger';

export const runtime = 'edge';

const VALID_ACTIONS = [
  'approve',
  'override',
  'reject',
  'reverify',
  'flag_address',
] as const;

type ReviewAction = (typeof VALID_ACTIONS)[number];

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. RBAC Guard: Verify admin credentials
  const authResult = await verifyAdminPayoutAccess(request);
  if (!authResult.authorized) {
    return authResult.response;
  }

  const { db, admin } = authResult;

  // 2. Parse request body
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Malformed JSON payload' },
      { status: 400 }
    );
  }

  const { payoutId, action, reason, address, chain } = body || {};

  // 3. Validate payoutId
  if (!payoutId || typeof payoutId !== 'string' || payoutId.trim() === '') {
    return NextResponse.json(
      { success: false, error: 'payoutId is required' },
      { status: 400 }
    );
  }

  // 4. Validate action
  const normalizedAction = (action || '').toLowerCase().trim() as ReviewAction;
  if (!VALID_ACTIONS.includes(normalizedAction)) {
    return NextResponse.json(
      {
        success: false,
        error: `Invalid review action '${action}'. Expected one of: ${VALID_ACTIONS.join(', ')}`,
      },
      { status: 400 }
    );
  }

  // 5. Validate reason (min 5 chars)
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (trimmedReason.length < 5) {
    return NextResponse.json(
      {
        success: false,
        error: 'Review reason is required and must be at least 5 characters',
      },
      { status: 400 }
    );
  }

  try {
    // 6. Inspect target payout record
    const payout = await db
      .prepare(`
        SELECT id, affiliate_id, amount, status, chain, payout_method_details, compliance_status
        FROM payouts
        WHERE id = ?
      `)
      .bind(payoutId)
      .first<{
        id: string;
        affiliate_id: string;
        amount: number;
        status: string;
        chain: string;
        payout_method_details: string;
        compliance_status?: string;
      }>();

    if (!payout) {
      return NextResponse.json(
        { success: false, error: `Payout not found: ${payoutId}` },
        { status: 404 }
      );
    }

    const batchStatements: D1PreparedStatement[] = [];

    // 7. Branch by action and build atomic dual-write statements
    if (normalizedAction === 'approve' || normalizedAction === 'override') {
      const updateReason = `ADMIN_OVERRIDE: ${trimmedReason}`;

      // Payout statement: compliance_status = 'approved', status = 'pending'
      batchStatements.push(
        db.prepare(`
          UPDATE payouts
          SET compliance_status = 'approved',
              compliance_reason = ?,
              status = 'pending',
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(updateReason, payoutId)
      );

      // Audit log statement
      batchStatements.push(
        complianceAuditService.createAuditStatement(db, {
          action: 'admin_override',
          severity: 'medium',
          actorId: admin.id,
          targetId: payoutId,
          details: {
            action: normalizedAction,
            reason: trimmedReason,
            adminEmail: admin.email,
            previousComplianceStatus: payout.compliance_status || payout.status,
            amount: payout.amount,
          },
        })
      );
    } else if (normalizedAction === 'reject') {
      const updateReason = `ADMIN_REJECTED: ${trimmedReason}`;

      // Payout statement: compliance_status = 'rejected', status = 'cancelled'
      batchStatements.push(
        db.prepare(`
          UPDATE payouts
          SET compliance_status = 'rejected',
              compliance_reason = ?,
              status = 'cancelled',
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(updateReason, payoutId)
      );

      // Audit log statement
      batchStatements.push(
        complianceAuditService.createAuditStatement(db, {
          action: 'admin_reject',
          severity: 'high',
          actorId: admin.id,
          targetId: payoutId,
          details: {
            action: 'reject',
            reason: trimmedReason,
            adminEmail: admin.email,
            previousComplianceStatus: payout.compliance_status || payout.status,
            amount: payout.amount,
          },
        })
      );
    } else if (normalizedAction === 'reverify') {
      const updateReason = `ADMIN_REQUESTED_REVERIFY: ${trimmedReason}`;

      // Profile statement: kyc_status = 'requires_action'
      batchStatements.push(
        db.prepare(`
          UPDATE profiles
          SET kyc_status = 'requires_action',
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(payout.affiliate_id)
      );

      // Payout statement: compliance_status = 'pending_review'
      batchStatements.push(
        db.prepare(`
          UPDATE payouts
          SET compliance_status = 'pending_review',
              compliance_reason = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(updateReason, payoutId)
      );

      // Audit log statement
      batchStatements.push(
        complianceAuditService.createAuditStatement(db, {
          action: 'admin_override',
          severity: 'medium',
          actorId: admin.id,
          targetId: payoutId,
          details: {
            action: 'reverify',
            reason: trimmedReason,
            affiliateId: payout.affiliate_id,
            adminEmail: admin.email,
          },
        })
      );
    } else if (normalizedAction === 'flag_address') {
      // Resolve address and chain
      let targetChain = (chain || payout.chain || 'ethereum') as SupportedPayoutChain;
      let targetAddress = (address || '').trim();

      if (!targetAddress && payout.payout_method_details) {
        try {
          const details =
            typeof payout.payout_method_details === 'string'
              ? JSON.parse(payout.payout_method_details)
              : payout.payout_method_details;
          targetAddress =
            details.wallet_address ||
            details.destination ||
            details.recipient ||
            '';
        } catch {
          // Ignore parse failure
        }
      }

      if (!targetAddress) {
        // Query affiliate profile's configured wallet
        const profileRow = await db
          .prepare('SELECT wallet_address, preferred_chain FROM profiles WHERE id = ?')
          .bind(payout.affiliate_id)
          .first<{ wallet_address: string; preferred_chain: string }>();

        targetAddress = profileRow?.wallet_address || '';
        if (profileRow?.preferred_chain) {
          targetChain = profileRow.preferred_chain as SupportedPayoutChain;
        }
      }

      if (!targetAddress) {
        return NextResponse.json(
          {
            success: false,
            error: 'Cannot flag address: No destination address specified or found for payout',
          },
          { status: 400 }
        );
      }

      let normalizedAddress: string;
      try {
        normalizedAddress = sanctionsScreeningService.normalizeAddress(
          targetAddress,
          targetChain
        );
      } catch (err: any) {
        return NextResponse.json(
          { success: false, error: err?.message || 'Invalid recipient address format' },
          { status: 400 }
        );
      }

      const flagSource = `Admin Flagged: ${trimmedReason}`;

      // Insert/update into sanctioned_addresses
      batchStatements.push(
        db.prepare(`
          INSERT INTO sanctioned_addresses (address, chain, source, risk_score, added_at)
          VALUES (?, ?, ?, 1.0, datetime('now'))
          ON CONFLICT(chain, address) DO UPDATE SET
            source = excluded.source,
            risk_score = 1.0
        `).bind(normalizedAddress, targetChain, flagSource)
      );

      // Payout statement: compliance_status = 'compliance_blocked', compliance_reason = 'SANCTIONED_ADDRESS_FLAGGED'
      batchStatements.push(
        db.prepare(`
          UPDATE payouts
          SET compliance_status = 'compliance_blocked',
              compliance_reason = 'SANCTIONED_ADDRESS_FLAGGED',
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(payoutId)
      );

      // Audit log statement: critical severity
      batchStatements.push(
        complianceAuditService.createAuditStatement(db, {
          action: 'admin_flag_address',
          severity: 'critical',
          actorId: admin.id,
          targetId: normalizedAddress,
          details: {
            action: 'flag_address',
            address: normalizedAddress,
            chain: targetChain,
            reason: trimmedReason,
            payoutId,
            adminEmail: admin.email,
          },
        })
      );
    }

    // 8. Execute atomic dual-write via db.batch
    await db.batch(batchStatements);

    logger.info(
      `[Admin Compliance Review] Successfully executed action '${normalizedAction}' on payout ${payoutId} by ${admin.email}`
    );

    return NextResponse.json({
      success: true,
      payoutId,
      action: normalizedAction,
      message: 'Compliance review action recorded successfully',
    });
  } catch (err: any) {
    logger.error(`[Admin Compliance Review] Action failed: ${err?.message || String(err)}`);
    return NextResponse.json(
      { success: false, error: 'Database transaction failed' },
      { status: 500 }
    );
  }
}
