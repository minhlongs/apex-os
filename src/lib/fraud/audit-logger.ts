/**
 * ApexOS Fraud Review Audit Logging & Decision Service
 * Location: src/lib/fraud/audit-logger.ts
 *
 * Implements Feature F12: Immutable Audit Logging & Atomic Dual-Write.
 * - Protects audit trail immutability (INSERT-only to fraud_reviews).
 * - Enforces atomic dual-write via Cloudflare D1 db.batch().
 * - Restores conversion attribution immediately for approved clicks.
 * - Unified admin RBAC verification (401 for unauthenticated, 403 for non-admin).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import {
  AdminFraudActionRequest,
  AdminFraudActionResponse,
  FraudReviewAction,
} from '@/types/fraud';
import { normalizeIpAddress } from './ip-blocker';

// ============================================================================
// Types & Contracts
// ============================================================================

export interface ReviewerContext {
  userId: string;
  email?: string;
  role?: string;
}

export interface ReviewDecisionParams {
  action: FraudReviewAction | string;
  reason: string;
  clickId?: string;
  clickIds?: string[];
  ip?: string;
  ipAddress?: string;
  reviewerId?: string;
  reviewerEmail?: string;
  notes?: string;
  expiresAt?: string | null;
  resolution?: 'approve' | 'reject';
  blockIpAlso?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ReviewDecisionResult extends AdminFraudActionResponse {
  reviewId: string;
}

export type AdminAuthResult =
  | { authorized: true; admin: { userId: string; role: string; email: string }; response?: never }
  | { authorized: false; status: 401 | 403; response: NextResponse; admin?: never };

// ============================================================================
// RBAC Security Guard: verifyAdminAccess
// ============================================================================

/**
 * Validates request authentication and enforces admin privileges.
 * - Returns 401 Unauthorized if caller has no active session.
 * - Returns 403 Forbidden if caller is authenticated but not an admin.
 * - Returns authorized admin context on success.
 */
export async function verifyAdminAccess(request: NextRequest): Promise<AdminAuthResult> {
  const db = getDB();

  // Extract credentials from Next.js headers and request
  const headers = new Headers();
  const cookiesObj: Record<string, string> = {};

  try {
    const { headers: getHeaders, cookies } = await import('next/headers');
    const readonlyHeaders = await getHeaders();
    const cookieStore = await cookies();

    readonlyHeaders.forEach((value, key) => headers.append(key, value));
    const allCookies = cookieStore.getAll();
    for (const cookie of allCookies) {
      cookiesObj[cookie.name] = cookie.value;
    }
  } catch {
    // May throw when evaluated outside of standard Next.js request execution context
  }

  // Check direct request headers
  const authHeader = request.headers.get('authorization');
  if (authHeader && !headers.get('authorization')) {
    headers.set('authorization', authHeader);
  }

  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    cookieHeader.split(';').forEach((c) => {
      const trimmed = c.trim();
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim();
        if (k && !cookiesObj[k]) cookiesObj[k] = v;
      }
    });
  }

  let sessionResult: any = null;
  try {
    const { createAuth } = await import('@/lib/auth/auth-factory');
    sessionResult = await createAuth({ DB: db }).api.getSession({
      headers,
      cookies: cookiesObj,
    });
  } catch {
    // Auth factory error fallback
  }

  // 401: Unauthenticated
  if (!sessionResult?.user) {
    return {
      authorized: false,
      status: 401,
      response: NextResponse.json(
        { success: false, error: 'Unauthorized: Session required' },
        { status: 401 }
      ),
    };
  }

  const userId = (sessionResult.user as { id: string }).id;
  const userEmail = (sessionResult.user as { email?: string }).email || '';

  // 2. Query user profile to verify admin role
  const profile = await db
    .prepare('SELECT role, email FROM profiles WHERE id = ?')
    .bind(userId)
    .first<{ role: string; email?: string }>();

  // 403: Authenticated but not an administrator
  if (!profile || profile.role !== 'admin') {
    return {
      authorized: false,
      status: 403,
      response: NextResponse.json(
        { success: false, error: 'Forbidden: Admin privileges required' },
        { status: 403 }
      ),
    };
  }

  return {
    authorized: true,
    admin: {
      userId,
      role: profile.role,
      email: profile.email || userEmail || 'admin@apex-os.com',
    },
  };
}

// ============================================================================
// Service Layer: recordFraudDecision
// ============================================================================

export class EntityNotFoundError extends Error {
  public statusCode: number = 404;
  constructor(message: string) {
    super(message);
    this.name = 'EntityNotFoundError';
  }
}

/**
 * Persists an administrative fraud decision into Cloudflare D1.
 * Atomic dual-write: updates entity state (deal_clicks / blocked_ips) and writes
 * an immutable audit log entry (fraud_reviews).
 *
 * IMMUTABILITY GUARANTEE:
 * fraud_reviews is INSERT-only. SQLite triggers trg_fraud_reviews_prevent_update
 * and trg_fraud_reviews_prevent_delete abort any UPDATE or DELETE operations.
 */
export async function recordFraudDecision(
  db: any,
  params: ReviewDecisionParams | AdminFraudActionRequest,
  reviewer?: ReviewerContext
): Promise<ReviewDecisionResult> {
  if (!params.reason || typeof params.reason !== 'string' || params.reason.trim().length < 3) {
    throw new Error('Reason must be at least 3 characters');
  }

  const trimmedReason = params.reason.trim();
  const rawAction = String(params.action).toLowerCase();
  const nowIso = new Date().toISOString();

  const reviewerId = reviewer?.userId || (params as any).reviewerId || 'usr-admin-1';
  const reviewerEmail = reviewer?.email || (params as any).reviewerEmail || 'admin@apex-os.com';

  const rawClickIds = (params as any).clickIds || ((params as any).clickId ? [(params as any).clickId] : []);
  const clickIds: string[] = Array.isArray(rawClickIds) ? rawClickIds.filter(Boolean) : [];
  const rawIp = (params as any).ip || (params as any).ipAddress;
  const ip = rawIp ? (normalizeIpAddress(rawIp) || String(rawIp).trim()) : null;

  const auditIds: string[] = [];
  let affectedCount = 0;

  switch (rawAction) {
    case 'approve': {
      if (clickIds.length === 0) {
        throw new Error('clickId is required for approve action');
      }

      const statements: any[] = [];
      let processedClicks = 0;

      for (const cId of clickIds) {
        // Fetch click row to verify entity existence and get context
        const click = (await db
          .prepare('SELECT id, ip_address, is_suspicious, review_status FROM deal_clicks WHERE id = ?')
          .bind(cId)
          .first()) as { id: string; ip_address: string | null; is_suspicious: number; review_status: string | null } | null;

        if (!click) {
          if (clickIds.length === 1) {
            throw new EntityNotFoundError(`Click not found: ${cId}`);
          }
          continue; // Skip non-existent in multi-click batch
        }

        const auditId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
        auditIds.push(auditId);
        processedClicks++;

        const effectiveIp = ip || click.ip_address || null;

        // 1. Mutate deal_clicks: clear suspicion, reset anomaly score, set review_status to approved
        statements.push(
          db.prepare(`
            UPDATE deal_clicks
            SET is_suspicious = 0, anomaly_score = 0.0, review_status = 'approved', reviewed_at = ?, reviewed_by = ?
            WHERE id = ?
          `).bind(nowIso, reviewerId, cId)
        );

        // 2. Insert immutable audit log
        const detailsJson = JSON.stringify({
          reviewType: 'CLICK',
          targetId: cId,
          notes: trimmedReason,
          metadata: {
            previousStatus: click.review_status ?? 'pending',
            newStatus: 'approved',
            ip: effectiveIp,
            ...((params as any).metadata ?? {}),
          },
        });

        statements.push(
          db.prepare(`
            INSERT INTO fraud_reviews (
              id, click_id, ip_address, reviewer_id, reviewed_by, action, reason, reviewed_at, created_at, details
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            auditId,
            cId,
            effectiveIp,
            reviewerId,
            reviewerEmail,
            'approve',
            trimmedReason,
            nowIso,
            nowIso,
            detailsJson
          )
        );
      }

      if (statements.length === 0) {
        throw new EntityNotFoundError('No valid clicks found to approve');
      }

      await db.batch(statements);
      affectedCount = processedClicks;
      break;
    }

    case 'reject': {
      if (clickIds.length === 0) {
        throw new Error('clickId is required for reject action');
      }

      const statements: any[] = [];
      let processedClicks = 0;

      for (const cId of clickIds) {
        const click = (await db
          .prepare('SELECT id, ip_address, is_suspicious, review_status FROM deal_clicks WHERE id = ?')
          .bind(cId)
          .first()) as { id: string; ip_address: string | null; is_suspicious: number; review_status: string | null } | null;

        if (!click) {
          if (clickIds.length === 1) {
            throw new EntityNotFoundError(`Click not found: ${cId}`);
          }
          continue;
        }

        const auditId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
        auditIds.push(auditId);
        processedClicks++;

        const effectiveIp = ip || click.ip_address || null;

        // 1. Mutate deal_clicks: confirm suspicion
        statements.push(
          db.prepare(`
            UPDATE deal_clicks
            SET is_suspicious = 1, review_status = 'rejected', reviewed_at = ?, reviewed_by = ?
            WHERE id = ?
          `).bind(nowIso, reviewerId, cId)
        );

        // 2. Insert audit log
        const detailsJson = JSON.stringify({
          reviewType: 'CLICK',
          targetId: cId,
          blockIpAlso: Boolean((params as any).blockIpAlso),
          metadata: {
            previousStatus: click.review_status ?? 'pending',
            newStatus: 'rejected',
            ...((params as any).metadata ?? {}),
          },
        });

        statements.push(
          db.prepare(`
            INSERT INTO fraud_reviews (
              id, click_id, ip_address, reviewer_id, reviewed_by, action, reason, reviewed_at, created_at, details
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            auditId,
            cId,
            effectiveIp,
            reviewerId,
            reviewerEmail,
            'reject',
            trimmedReason,
            nowIso,
            nowIso,
            detailsJson
          )
        );

        // 3. Optional: also block originating IP
        if ((params as any).blockIpAlso && effectiveIp) {
          const blockId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
          const ipAuditId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
          auditIds.push(ipAuditId);

          statements.push(
            db.prepare(`
              INSERT INTO blocked_ips (id, ip_address, reason, blocked_by, created_at, expires_at, is_active)
              VALUES (?, ?, ?, ?, ?, ?, 1)
              ON CONFLICT(ip_address) DO UPDATE SET
                reason = excluded.reason,
                blocked_by = excluded.blocked_by,
                is_active = 1,
                created_at = excluded.created_at
            `).bind(blockId, effectiveIp, `Auto-blocked via click rejection: ${trimmedReason}`, reviewerId, nowIso, (params as any).expiresAt || null)
          );

          statements.push(
            db.prepare(`
              INSERT INTO fraud_reviews (
                id, click_id, ip_address, reviewer_id, reviewed_by, action, reason, reviewed_at, created_at, details
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              ipAuditId,
              cId,
              effectiveIp,
              reviewerId,
              reviewerEmail,
              'block_ip',
              `Associated IP blocked: ${trimmedReason}`,
              nowIso,
              nowIso,
              JSON.stringify({ reviewType: 'IP', targetId: effectiveIp })
            )
          );
        }
      }

      if (statements.length === 0) {
        throw new EntityNotFoundError('No valid clicks found to reject');
      }

      await db.batch(statements);
      affectedCount = processedClicks;
      break;
    }

    case 'block_ip': {
      if (!ip) {
        throw new Error('IP address is required for block_ip action');
      }

      const blockId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
      const auditId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
      auditIds.push(auditId);

      const targetClickId = clickIds[0] || null;

      const detailsJson = JSON.stringify({
        reviewType: 'IP',
        targetId: ip,
        expiresAt: (params as any).expiresAt ?? null,
        metadata: (params as any).metadata ?? {},
      });

      await db.batch([
        db.prepare(`
          INSERT INTO blocked_ips (id, ip_address, reason, blocked_by, created_at, expires_at, is_active)
          VALUES (?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(ip_address) DO UPDATE SET
            reason = excluded.reason,
            blocked_by = excluded.blocked_by,
            is_active = 1,
            expires_at = excluded.expires_at,
            created_at = excluded.created_at
        `).bind(blockId, ip, trimmedReason, reviewerId, nowIso, (params as any).expiresAt || null),
        db.prepare(`
          INSERT INTO fraud_reviews (
            id, click_id, ip_address, reviewer_id, reviewed_by, action, reason, reviewed_at, created_at, details
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          auditId,
          targetClickId,
          ip,
          reviewerId,
          reviewerEmail,
          'block_ip',
          trimmedReason,
          nowIso,
          nowIso,
          detailsJson
        ),
      ]);

      affectedCount = 1;
      break;
    }

    case 'unblock_ip': {
      if (!ip) {
        throw new Error('IP address is required for unblock_ip action');
      }

      const auditId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
      auditIds.push(auditId);

      const detailsJson = JSON.stringify({
        reviewType: 'IP',
        targetId: ip,
        metadata: (params as any).metadata ?? {},
      });

      await db.batch([
        db.prepare('DELETE FROM blocked_ips WHERE ip_address = ?').bind(ip),
        db.prepare(`
          INSERT INTO fraud_reviews (
            id, click_id, ip_address, reviewer_id, reviewed_by, action, reason, reviewed_at, created_at, details
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          auditId,
          null,
          ip,
          reviewerId,
          reviewerEmail,
          'unblock_ip',
          trimmedReason,
          nowIso,
          nowIso,
          detailsJson
        ),
      ]);

      affectedCount = 1;
      break;
    }

    case 'bulk_resolve':
    case 'bulk_approve':
    case 'bulk_reject': {
      if (clickIds.length === 0) {
        throw new Error('clickIds array is required for bulk resolution');
      }

      const resolution = (params as any).resolution ?? (rawAction === 'bulk_approve' ? 'approve' : 'reject');

      // Filter to only existing clicks
      const validClicks: Array<{ id: string; ip_address: string | null }> = [];
      for (const cId of clickIds) {
        const click = (await db
          .prepare('SELECT id, ip_address FROM deal_clicks WHERE id = ?')
          .bind(cId)
          .first()) as { id: string; ip_address: string | null } | null;
        if (click) {
          validClicks.push(click);
        }
      }

      if (validClicks.length === 0) {
        throw new EntityNotFoundError('No matching clicks found for bulk resolution');
      }

      // Safe chunking to stay below D1 batch limit (chunk size 45 -> 90 statements)
      const CHUNK_SIZE = 45;
      for (let i = 0; i < validClicks.length; i += CHUNK_SIZE) {
        const chunk = validClicks.slice(i, i + CHUNK_SIZE);
        const statements: any[] = [];

        for (const targetClick of chunk) {
          const cId = targetClick.id;
          const auditId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
          auditIds.push(auditId);

          if (resolution === 'approve') {
            statements.push(
              db.prepare(`
                UPDATE deal_clicks
                SET is_suspicious = 0, anomaly_score = 0.0, review_status = 'approved', reviewed_at = ?, reviewed_by = ?
                WHERE id = ?
              `).bind(nowIso, reviewerId, cId)
            );
          } else {
            statements.push(
              db.prepare(`
                UPDATE deal_clicks
                SET is_suspicious = 1, review_status = 'rejected', reviewed_at = ?, reviewed_by = ?
                WHERE id = ?
              `).bind(nowIso, reviewerId, cId)
            );
          }

          statements.push(
            db.prepare(`
              INSERT INTO fraud_reviews (
                id, click_id, ip_address, reviewer_id, reviewed_by, action, reason, reviewed_at, created_at, details
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              auditId,
              cId,
              targetClick.ip_address || null,
              reviewerId,
              reviewerEmail,
              resolution,
              trimmedReason,
              nowIso,
              nowIso,
              JSON.stringify({
                reviewType: 'CLICK',
                targetId: cId,
                bulk: true,
                batchSize: validClicks.length,
                metadata: (params as any).metadata ?? {},
              })
            )
          );
        }

        await db.batch(statements);
      }

      affectedCount = validClicks.length;
      break;
    }

    case 'dismiss': {
      if (clickIds.length === 0) {
        throw new Error('clickId is required for dismiss action');
      }

      const statements: any[] = [];
      let processedClicks = 0;

      for (const cId of clickIds) {
        const click = (await db
          .prepare('SELECT id, ip_address, is_suspicious, review_status FROM deal_clicks WHERE id = ?')
          .bind(cId)
          .first()) as { id: string; ip_address: string | null; is_suspicious: number; review_status: string | null } | null;

        if (!click) {
          if (clickIds.length === 1) {
            throw new EntityNotFoundError(`Click not found: ${cId}`);
          }
          continue;
        }

        const auditId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
        auditIds.push(auditId);
        processedClicks++;

        statements.push(
          db.prepare(`
            UPDATE deal_clicks
            SET review_status = 'ignored', reviewed_at = ?, reviewed_by = ?
            WHERE id = ?
          `).bind(nowIso, reviewerId, cId)
        );

        statements.push(
          db.prepare(`
            INSERT INTO fraud_reviews (
              id, click_id, ip_address, reviewer_id, reviewed_by, action, reason, reviewed_at, created_at, details
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            auditId,
            cId,
            click.ip_address || null,
            reviewerId,
            reviewerEmail,
            'dismiss',
            trimmedReason,
            nowIso,
            nowIso,
            JSON.stringify({ reviewType: 'CLICK', targetId: cId })
          )
        );
      }

      if (statements.length === 0) {
        throw new EntityNotFoundError('No valid clicks found to dismiss');
      }

      await db.batch(statements);
      affectedCount = processedClicks;
      break;
    }

    default:
      throw new Error(`Unsupported fraud review action: ${params.action}`);
  }

  return {
    success: true,
    reviewId: auditIds[0] || '',
    auditIds,
    affectedCount,
    message: `Fraud decision '${rawAction}' successfully recorded to audit log.`,
  };
}
