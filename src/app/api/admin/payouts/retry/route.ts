/**
 * src/app/api/admin/payouts/retry/route.ts
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Milestone 5: Admin Payout Controls, Retries & Audit Logging
 *
 * Endpoint: POST /api/admin/payouts/retry
 * Handles retrying failed payouts across Stellar, Ethereum, and Solana with:
 *   - Edge runtime enforcement
 *   - Admin RBAC guard (401 unauthenticated, 403 non-admin, 503 no DB)
 *   - Real-time gas/network fee re-estimation
 *   - Pre-flight on-chain verification avoiding duplicate broadcasts
 *   - Atomic Compare-And-Swap (CAS) locking against race conditions
 *   - Administrative force-override audit logging ('override' action)
 *   - Strict HTTP status code mapping (400, 404, 409, 422, 502, 200)
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminPayoutAccess } from '@/lib/payouts/admin-auth';
import { batchSettlementService } from '@/lib/payouts/batch-settlement-service';
import { payoutAuditService } from '@/lib/payouts/audit-service';
import type { RetryOptions, PayoutExecutionResult } from '@/lib/payouts/types';
import { error as logError, info as logInfo } from '@/lib/logger';

export interface RetryPayoutRequestBody {
  payoutId: string;
  refreshFee?: boolean;
  force?: boolean;
  notes?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const startTime = Date.now();

  // 1. Enforce Admin RBAC guard
  const authResult = await verifyAdminPayoutAccess(request);
  if (!authResult.authorized) {
    return authResult.response;
  }

  const { admin, db, ipAddress } = authResult;

  // 2. Parse JSON body
  let body: RetryPayoutRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid JSON request body',
        code: 'INVALID_REQUEST',
      },
      { status: 400 }
    );
  }

  const { payoutId, refreshFee = true, force = false, notes } = body || {};

  // 3. Validate payoutId
  if (!payoutId || typeof payoutId !== 'string' || payoutId.trim() === '') {
    return NextResponse.json(
      {
        success: false,
        error: "Missing or invalid 'payoutId': must be a non-empty string",
        code: 'INVALID_REQUEST',
      },
      { status: 400 }
    );
  }

  const trimmedPayoutId = payoutId.trim();
  const sanitizedNotes = typeof notes === 'string' ? notes.trim() : undefined;

  // 4. Record administrative override audit log if force is requested
  if (force) {
    try {
      await payoutAuditService.log(db, {
        payout_id: trimmedPayoutId,
        action: 'override',
        admin_id: admin.id,
        admin_email: admin.email,
        ip_address: ipAddress,
        details: {
          event: 'admin_retry_force_override',
          payoutId: trimmedPayoutId,
          notes: sanitizedNotes,
        },
      });
    } catch (auditErr) {
      logError('[admin/payouts/retry] Failed to record override audit log:', auditErr);
    }
  }

  // 5. Invoke BatchSettlementService.retryPayout
  const retryOptions: RetryOptions = {
    refreshFee: Boolean(refreshFee),
    force: Boolean(force),
    reason: sanitizedNotes,
    adminId: admin.id,
    adminEmail: admin.email,
    ipAddress,
  };

  try {
    const result: PayoutExecutionResult = await batchSettlementService.retryPayout(
      trimmedPayoutId,
      retryOptions
    );

    // 6. Handle success
    if (result.success) {
      logInfo(
        `[admin/payouts/retry] Successfully retried payout ${trimmedPayoutId} (Tx: ${result.transactionId}) in ${
          Date.now() - startTime
        }ms`
      );

      return NextResponse.json(
        {
          data: {
            payoutId: result.payoutId,
            chain: result.chain,
            transactionId: result.transactionId ?? null,
            status: result.status,
            amount: result.amount,
            token: result.token,
            gasFeeNative: result.gasFeeNative,
            gasFeeUsd: result.gasFeeUsd,
            recipientAddress: result.toAddress,
            timestamp: result.timestamp ?? new Date().toISOString(),
          },
          ...result,
          // Declared after the spread so the response's success flag is not silently overwritten;
          // this branch is only reached when result.success is true.
          success: true,
        },
        { status: 200 }
      );
    }

    // 7. Map error cases to status codes
    const errorMsg = result.error || 'Retry payout failed';

    // Case A: Payout record not found in database (404)
    if (errorMsg.includes('Payout record not found')) {
      return NextResponse.json(
        {
          success: false,
          error: errorMsg,
          code: 'PAYOUT_NOT_FOUND',
        },
        { status: 404 }
      );
    }

    // Case B: CAS concurrency lock conflict (409)
    if (errorMsg.includes('Payout is already processing or has already been retried')) {
      return NextResponse.json(
        {
          success: false,
          error: 'Payout is currently being processed by another worker or has already completed',
          code: 'CONCURRENT_MODIFICATION_CONFLICT',
        },
        { status: 409 }
      );
    }

    // Case C: Invalid status - payout not in 'failed' status without force (409)
    if (errorMsg.includes("Only 'failed' payouts can be retried")) {
      return NextResponse.json(
        {
          success: false,
          error: errorMsg,
          code: 'INVALID_PAYOUT_STATUS',
        },
        { status: 409 }
      );
    }

    // Case D: Circuit breaker halted retry execution (422)
    if (errorMsg.includes('Retry halted by circuit breaker')) {
      return NextResponse.json(
        {
          success: false,
          error: errorMsg,
          code: 'CIRCUIT_BREAKER_HALTED',
        },
        { status: 422 }
      );
    }

    // Case E: Recipient address cannot be resolved (422)
    if (errorMsg.includes('recipient address cannot be resolved')) {
      return NextResponse.json(
        {
          success: false,
          error: errorMsg,
          code: 'INVALID_RECIPIENT_ADDRESS',
        },
        { status: 422 }
      );
    }

    // Case F: Blockchain RPC or execution error (502)
    return NextResponse.json(
      {
        success: false,
        error: errorMsg,
        code: 'ONCHAIN_EXECUTION_FAILED',
        data: {
          payoutId: result.payoutId,
          chain: result.chain,
          status: result.status,
        },
      },
      { status: 502 }
    );
  } catch (err: any) {
    logError('[admin/payouts/retry] Unhandled exception:', err);
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error occurred while retrying payout',
        code: 'INTERNAL_SERVER_ERROR',
        details: err?.message,
      },
      { status: 500 }
    );
  }
}
