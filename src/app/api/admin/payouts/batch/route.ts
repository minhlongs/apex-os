/**
 * src/app/api/admin/payouts/batch/route.ts
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Milestone 5: Admin Payout Controls, Retries & Audit Logging
 *
 * Endpoint: POST /api/admin/payouts/batch
 * Handles previewing and executing automated batch payouts across Stellar, Ethereum, and Solana.
 * Features:
 *   - Edge runtime enforcement
 *   - Admin RBAC guard (401 unauthenticated, 403 non-admin, 503 no DB)
 *   - Input validation (action, chain, minThreshold, limit)
 *   - Multi-chain batch preview and execution via BatchSettlementService
 *   - Admin identity and IP address tracking in immutable audit logs
 */

import { NextRequest, NextResponse } from 'next/server';
import { guardLegacyAdminPayoutMutation } from '@/lib/compliance/legacy-route-guards';
import { verifyAdminPayoutAccess } from '@/lib/payouts/admin-auth';
import { batchSettlementService } from '@/lib/payouts/batch-settlement-service';
import type { SupportedPayoutChain, BatchSettlementOptions } from '@/lib/payouts/types';
import { error as logError } from '@/lib/logger';

const VALID_CHAINS = new Set<string>(['stellar', 'ethereum', 'solana', 'all']);

export interface AdminBatchRequestBody {
  action: 'preview' | 'execute';
  chain?: SupportedPayoutChain | 'all';
  minThreshold?: number;
  dryRun?: boolean;
  limit?: number;
  scheduledAt?: string | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Enforce Admin RBAC guard
  const authResult = await verifyAdminPayoutAccess(request);
  if (!authResult.authorized) {
    return authResult.response;
  }

  const { admin, ipAddress } = authResult;

  // 2. Parse request body
  let body: AdminBatchRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid JSON request body',
      },
      { status: 400 }
    );
  }

  // 3. Validate required action field
  const action = body?.action;
  if (!action || (action !== 'preview' && action !== 'execute')) {
    return NextResponse.json(
      {
        success: false,
        error: "Missing or invalid 'action': must be 'preview' or 'execute'",
      },
      { status: 400 }
    );
  }

  // 4. Validate chain filter
  if (body.chain !== undefined) {
    const chainStr = String(body.chain).toLowerCase();
    if (!VALID_CHAINS.has(chainStr)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid 'chain': must be 'stellar', 'ethereum', 'solana', or 'all'",
        },
        { status: 400 }
      );
    }
  }

  // 5. Validate minThreshold
  if (body.minThreshold !== undefined) {
    const threshold = Number(body.minThreshold);
    if (!Number.isFinite(threshold) || threshold < 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid 'minThreshold': must be a non-negative number",
        },
        { status: 400 }
      );
    }
  }

  // 6. Validate limit
  if (body.limit !== undefined) {
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid 'limit': must be an integer between 1 and 500",
        },
        { status: 400 }
      );
    }
  }

  // 7. Prepare batch settlement options
  const targetChain = body.chain
    ? (String(body.chain).toLowerCase() as SupportedPayoutChain | 'all')
    : 'all';

  const options: BatchSettlementOptions = {
    chain: targetChain,
    minThreshold: body.minThreshold !== undefined ? Number(body.minThreshold) : 50.0,
    dryRun: Boolean(body.dryRun),
    limit: body.limit !== undefined ? Number(body.limit) : 50,
    adminId: admin.id,
    adminEmail: admin.email,
    ipAddress,
    scheduledAt: body.scheduledAt || null,
  };

  try {
    // 8. Dispatch by action
    if (action === 'preview') {
      const preview = await batchSettlementService.previewBatch(options);
      return NextResponse.json(
        {
          success: true,
          data: preview,
          preview,
          ...preview,
        },
        { status: 200 }
      );
    }

    // action === 'execute'
    if (!options.dryRun) {
      const legacyBlock = await guardLegacyAdminPayoutMutation(request, authResult.db);
      if (legacyBlock) {
        return legacyBlock;
      }
    }

    const execution = await batchSettlementService.executeBatch(options);
    return NextResponse.json(
      {
        success: true,
        data: execution,
        ...execution,
      },
      { status: 200 }
    );
  } catch (err: any) {
    logError('[admin/payouts/batch] Batch operation failed:', err);
    return NextResponse.json(
      {
        success: false,
        error: err?.message || 'Failed to process batch payout request',
      },
      { status: 500 }
    );
  }
}
