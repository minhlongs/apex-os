/**
 * src/app/api/admin/payouts/treasury/route.ts
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Milestone 5: Admin Payout Controls, Retries & Audit Logging
 *
 * Endpoint: GET /api/admin/payouts/treasury
 * Inspects multi-chain treasury balances (Stellar, Ethereum, Solana) and pending D1 settlement queues:
 *   - Edge runtime enforcement
 *   - Admin RBAC guard (401 unauthenticated, 403 non-admin, 503 no DB)
 *   - Chain parameter filtering ('stellar' | 'ethereum' | 'solana')
 *   - Supply: Hot wallet native gas tokens and stablecoin reserves vs safety floors
 *   - Demand: Unpaid earnings, pending batches, and in-flight payouts in D1
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAscendancyGuardActive } from '@/lib/compliance/legacy-route-guards';
import { verifyAdminPayoutAccess } from '@/lib/payouts/admin-auth';
import { treasuryHealthService } from '@/lib/payouts/treasury-health-service';
import type { SupportedPayoutChain } from '@/lib/payouts/types';
import { error as logError } from '@/lib/logger';

const VALID_CHAINS = new Set<string>(['stellar', 'ethereum', 'solana']);

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Enforce Admin RBAC guard
  const authResult = await verifyAdminPayoutAccess(request);
  if (!authResult.authorized) {
    return authResult.response;
  }

  const { db } = authResult;

  // 1b. Gate G8 boundary: never invoke legacy raw-key PayoutRouter / TreasuryHealthService
  // when Ascendancy settlement_broadcasts is active or Turnkey HSM Stellar hot wallet is configured.
  const turnkeyStellarConfigured = Boolean(
    process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS?.trim()
  );
  const ascendancyActive = await isAscendancyGuardActive(db, 'settlement_broadcasts');
  if (ascendancyActive || turnkeyStellarConfigured) {
    return NextResponse.json(
      {
        success: false,
        code: 'LEGACY_TREASURY_ROUTE_DISABLED',
        error:
          'Legacy raw-key treasury probe is disabled while Turnkey HSM / Ascendancy settlement is active; use GET /api/admin/settings/stellar/health for read-only Turnkey HSM hot-wallet health.',
        redirectTo: '/api/admin/settings/stellar/health',
      },
      { status: 410 }
    );
  }

  // 2. Parse and validate optional chain filter
  const { searchParams } = new URL(request.url);
  const chainParam = searchParams.get('chain')?.toLowerCase().trim();

  if (chainParam && !VALID_CHAINS.has(chainParam)) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid 'chain' parameter: must be 'stellar', 'ethereum', or 'solana'",
      },
      { status: 400 }
    );
  }

  const targetChain = chainParam as SupportedPayoutChain | undefined;

  try {
    // 3. Query on-chain treasury health (Supply side)
    const treasuryHealth = await treasuryHealthService.checkHealth(targetChain);

    // 4. Query pending queues from D1 (Demand side)
    // 4a. Unpaid earnings count and sum grouped by chain (is_paid = 0 AND payout_id IS NULL)
    let unpaidRows: Array<{ chain: string; count: number; total_amount: number }> = [];
    try {
      const res = await db
        .prepare(`
          SELECT
            LOWER(COALESCE(p.preferred_chain, 'stellar')) AS chain,
            COUNT(e.id) AS count,
            COALESCE(SUM(e.amount), 0.0) AS total_amount
          FROM earnings e
          JOIN profiles p ON e.affiliate_id = p.id
          WHERE e.is_paid = 0
            AND e.payout_id IS NULL
          GROUP BY chain
        `)
        .all<{ chain: string; count: number; total_amount: number }>();
      unpaidRows = Array.isArray(res) ? res : (res?.results || []);
    } catch (err: any) {
      logError('[admin/payouts/treasury] Unpaid earnings query error:', err);
    }

    // 4b. Pending batches count (status IN ('pending', 'processing'))
    let batchRows: Array<{ status: string; count: number }> = [];
    try {
      const batchRes = await db
        .prepare(`
          SELECT
            status,
            COUNT(*) AS count
          FROM payout_batches
          WHERE status IN ('pending', 'processing')
          GROUP BY status
        `)
        .all<{ status: string; count: number }>();
      batchRows = Array.isArray(batchRes) ? batchRes : (batchRes?.results || []);
    } catch (err: any) {
      logError('[admin/payouts/treasury] Pending batches query error:', err);
    }

    // 4c. In-flight payouts count and sum (status IN ('pending', 'processing'))
    let payoutRows: Array<{ chain: string; status: string; count: number; total_amount: number }> = [];
    try {
      const payoutRes = await db
        .prepare(`
          SELECT
            LOWER(COALESCE(chain, 'stellar')) AS chain,
            status,
            COUNT(*) AS count,
            COALESCE(SUM(amount), 0.0) AS total_amount
          FROM payouts
          WHERE status IN ('pending', 'processing')
          GROUP BY chain, status
        `)
        .all<{ chain: string; status: string; count: number; total_amount: number }>();
      payoutRows = Array.isArray(payoutRes) ? payoutRes : (payoutRes?.results || []);
    } catch (err: any) {
      logError('[admin/payouts/treasury] In-flight payouts query error:', err);
    }

    // 5. Aggregate and structure pending queues
    const unpaidByChain: Record<SupportedPayoutChain, { count: number; totalAmount: number }> = {
      stellar: { count: 0, totalAmount: 0 },
      ethereum: { count: 0, totalAmount: 0 },
      solana: { count: 0, totalAmount: 0 },
    };

    let totalUnpaidCount = 0;
    let totalUnpaidAmount = 0;

    for (const row of unpaidRows) {
      const ch = (row.chain as SupportedPayoutChain) || 'stellar';
      const count = Number(row.count) || 0;
      const amount = Number(Number(row.total_amount || 0).toFixed(2));
      if (unpaidByChain[ch]) {
        unpaidByChain[ch].count += count;
        unpaidByChain[ch].totalAmount = Number((unpaidByChain[ch].totalAmount + amount).toFixed(2));
      }
      totalUnpaidCount += count;
      totalUnpaidAmount = Number((totalUnpaidAmount + amount).toFixed(2));
    }

    const pendingBatches = {
      pendingCount: 0,
      processingCount: 0,
      totalPendingCount: 0,
      totalCount: 0,
    };
    for (const row of batchRows) {
      const count = Number(row.count) || 0;
      if (row.status === 'pending') pendingBatches.pendingCount += count;
      if (row.status === 'processing') pendingBatches.processingCount += count;
    }
    pendingBatches.totalPendingCount = pendingBatches.pendingCount + pendingBatches.processingCount;
    pendingBatches.totalCount = pendingBatches.totalPendingCount;

    const inFlightPayouts = {
      totalCount: 0,
      totalAmount: 0,
      byChain: {
        stellar: { pendingCount: 0, processingCount: 0, count: 0, totalAmount: 0 },
        ethereum: { pendingCount: 0, processingCount: 0, count: 0, totalAmount: 0 },
        solana: { pendingCount: 0, processingCount: 0, count: 0, totalAmount: 0 },
      },
    };
    for (const row of payoutRows) {
      const ch = (row.chain as SupportedPayoutChain) || 'stellar';
      const count = Number(row.count) || 0;
      const amount = Number(Number(row.total_amount || 0).toFixed(2));
      if (inFlightPayouts.byChain[ch]) {
        if (row.status === 'pending') inFlightPayouts.byChain[ch].pendingCount += count;
        if (row.status === 'processing') inFlightPayouts.byChain[ch].processingCount += count;
        inFlightPayouts.byChain[ch].count += count;
        inFlightPayouts.byChain[ch].totalAmount = Number(
          (inFlightPayouts.byChain[ch].totalAmount + amount).toFixed(2)
        );
      }
      inFlightPayouts.totalCount += count;
      inFlightPayouts.totalAmount = Number((inFlightPayouts.totalAmount + amount).toFixed(2));
    }

    const pendingQueues = {
      unpaidEarnings: {
        totalCount: totalUnpaidCount,
        totalAmount: totalUnpaidAmount,
        byChain: unpaidByChain,
      },
      pendingBatches,
      pendingPayouts: inFlightPayouts,
      inFlightPayouts,
    };

    const timestamp = new Date().toISOString();

    return NextResponse.json(
      {
        success: true,
        data: {
          treasuryHealth,
          pendingQueues,
          timestamp,
        },
        treasuryHealth,
        pendingQueues,
        health: treasuryHealth,
        queues: pendingQueues,
        timestamp,
      },
      { status: 200 }
    );
  } catch (err: any) {
    logError('[admin/payouts/treasury] Failed to query treasury health:', err);
    return NextResponse.json(
      {
        success: false,
        error: err?.message || 'Failed to inspect treasury balances',
      },
      { status: 500 }
    );
  }
}
