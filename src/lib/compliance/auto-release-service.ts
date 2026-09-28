/**
 * src/lib/compliance/auto-release-service.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Auto-Release Engine for Compliance-Held Payouts
 *
 * Finds payouts held with compliance_status = 'kyc_required', updates them to 'clean',
 * resets linked earnings (payout_id = NULL where is_paid = 0) so the automated batch settlement
 * runner includes them in upcoming runs, and emits immutable compliance audit logs.
 */

import type { D1Database, D1PreparedStatement } from '../db';
import { complianceAuditService } from './audit-service';
import * as logger from '../logger';

export interface AutoReleaseResult {
  success: boolean;
  affiliateId: string;
  releasedPayoutsCount: number;
  releasedEarningsCount: number;
  releasedPayoutIds: string[];
  totalAmount: number;
}

export class AutoReleaseService {
  /**
   * Release payouts on KYC compliance hold for a given affiliate.
   *
   * @param db - D1Database instance
   * @param affiliateId - Affiliate user ID
   * @returns AutoReleaseResult containing released counts and IDs
   */
  async releaseHeldPayouts(
    db: D1Database,
    affiliateId: string
  ): Promise<AutoReleaseResult> {
    if (!affiliateId || affiliateId.trim() === '') {
      return {
        success: false,
        affiliateId: '',
        releasedPayoutsCount: 0,
        releasedEarningsCount: 0,
        releasedPayoutIds: [],
        totalAmount: 0,
      };
    }

    try {
      // 1. Query all payouts currently held with kyc_required
      const selectSql = `
        SELECT id, amount, status, compliance_status
        FROM payouts
        WHERE affiliate_id = ?
          AND (compliance_status = 'kyc_required' OR status = 'kyc_required')
      `;
      const result = await db.prepare(selectSql).bind(affiliateId).all<{
        id: string;
        amount: number;
        status: string;
        compliance_status?: string;
      }>();

      const heldPayouts = result.results ?? [];

      if (heldPayouts.length === 0) {
        return {
          success: true,
          affiliateId,
          releasedPayoutsCount: 0,
          releasedEarningsCount: 0,
          releasedPayoutIds: [],
          totalAmount: 0,
        };
      }

      const releasedPayoutIds: string[] = [];
      let totalAmount = 0;
      let releasedEarningsCount = 0;

      for (const payout of heldPayouts) {
        releasedPayoutIds.push(payout.id);
        totalAmount += Number(payout.amount ?? 0);

        // Count linked unpaid earnings
        const countEarningsSql = `
          SELECT COUNT(*) as count
          FROM earnings
          WHERE payout_id = ? AND is_paid = 0
        `;
        const countRow = await db
          .prepare(countEarningsSql)
          .bind(payout.id)
          .first<{ count: number }>();
        const earningCount = Number(countRow?.count ?? 0);
        releasedEarningsCount += earningCount;

        // Build atomic batch statements
        const batchStatements: D1PreparedStatement[] = [];

        // 1. Update payout record: compliance_status = 'clean', compliance_reason = 'KYC_VERIFIED_AUTO_RELEASED'
        // If status was 'kyc_required', restore to 'pending'
        const nextStatus = payout.status === 'kyc_required' ? 'pending' : payout.status;
        batchStatements.push(
          db.prepare(`
            UPDATE payouts
            SET compliance_status = 'clean',
                compliance_reason = 'KYC_VERIFIED_AUTO_RELEASED',
                status = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).bind(nextStatus, payout.id)
        );

        // 2. Reset earnings: payout_id = NULL (where is_paid = 0)
        batchStatements.push(
          db.prepare(`
            UPDATE earnings
            SET payout_id = NULL,
                updated_at = datetime('now')
            WHERE payout_id = ? AND is_paid = 0
          `).bind(payout.id)
        );

        // 3. Emit audit log via ComplianceAuditService
        batchStatements.push(
          complianceAuditService.createAuditStatement(db, {
            action: 'kyc_auto_release',
            severity: 'low',
            actorId: affiliateId,
            targetId: payout.id,
            details: {
              payoutId: payout.id,
              affiliateId,
              amount: payout.amount,
              previousComplianceStatus: payout.compliance_status || payout.status,
              releasedEarnings: earningCount,
              reason: 'KYC_VERIFIED_AUTO_RELEASED',
            },
          })
        );

        await db.batch(batchStatements);
      }

      logger.info(
        `[AutoReleaseService] Auto-released ${heldPayouts.length} payout(s) ($${totalAmount.toFixed(
          2
        )}) for affiliate ${affiliateId}`
      );

      return {
        success: true,
        affiliateId,
        releasedPayoutsCount: heldPayouts.length,
        releasedEarningsCount,
        releasedPayoutIds,
        totalAmount,
      };
    } catch (err: any) {
      logger.error(
        `[AutoReleaseService] Failed to auto-release held payouts for ${affiliateId}: ${
          err?.message || String(err)
        }`
      );
      throw err;
    }
  }
}

export const autoReleaseService = new AutoReleaseService();

/**
 * Convenience function matching specification requirements
 */
export async function releaseHeldPayouts(
  db: D1Database,
  affiliateId: string
): Promise<AutoReleaseResult> {
  return autoReleaseService.releaseHeldPayouts(db, affiliateId);
}
