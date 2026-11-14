/**
 * Passkey-Protected Phase 1 Multichain Settlement Dispatch & Timeout Recovery Route
 *
 * POST /api/admin/settlement/dispatch
 *
 * Production entrypoint wiring together:
 * 1. Admin session + WebAuthn Passkey step-up (`requireAdminWithPasskeyStepUp`)
 * 2. Deterministic M2 Anti-Fraud & 48h Wallet-Change Timelock Check (`M2SybilGraphEngine`)
 * 3. Atomic D1 Double-Entry Ledger Withdrawal Lock (`lockSettledForWithdrawal`)
 * 4. Turnkey HSM Enclave Signer Isolation ($250/tx, $1,500/24h -> Safe 2-of-3 Cold Queue)
 *    + Phase 1 Multichain USDC (`stellar` 7-dec, `arbitrum` 6-dec, `base` 6-dec, min $10)
 *    + `BROADCAST_PENDING` Uncertain RPC Timeout Recovery (`BroadcastRecoveryMachine`)
 */

import { NextRequest, NextResponse } from 'next/server';
import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import {
  requireAdminWithPasskeyStepUp,
  sanitizeApiErrorResponse,
} from '@/lib/auth/passkey-step-up';
import type { D1Database as LegacyD1Database } from '@/lib/db';
import { M2SybilGraphEngine } from '@/lib/fraud/m2-sybil-graph-engine';
import {
  DoubleEntryLedgerService,
  parseUsdToLedgerUnits,
} from '@/lib/ledger';
import {
  assertPhase1ChainEnabled,
  BroadcastRecoveryMachine,
  type Phase1SettlementChain,
} from '@/lib/payouts';

interface WorkerBindings {
  DB?: AuthD1Database;
  SETTLEMENT_MACHINE?: BroadcastRecoveryMachine;
}

interface SettlementDispatchBody {
  action?: 'dispatch' | 'recover';
  payoutId?: string;
  idempotencyKey?: string;
  affiliateId?: string;
  ownerType?: 'trader' | 'affiliate' | 'agency';
  chain?: string;
  recipientAddress?: string;
  amountUsd?: string;
  usdcReferencePriceUsd?: string;
}

export async function POST(request: NextRequest): Promise<Response> {
  const bindings = globalThis as unknown as WorkerBindings;
  const db = bindings.DB;
  if (!db) {
    return NextResponse.json(
      { success: false, error: 'Database unavailable' },
      { status: 503 }
    );
  }

  try {
    const authz = await requireAdminWithPasskeyStepUp(
      request,
      db as unknown as LegacyD1Database,
      { purpose: 'admin_step_up' }
    );
    if (!authz.authorized) {
      return NextResponse.json(
        { success: false, code: authz.code, error: authz.error },
        { status: authz.status }
      );
    }

    const body = (await request.json()) as SettlementDispatchBody;
    const action = body.action ?? 'dispatch';
    const machine = bindings.SETTLEMENT_MACHINE;

    if (action === 'recover') {
      if (!body.payoutId) {
        return NextResponse.json(
          { success: false, code: 'MISSING_PAYOUT_ID', error: 'payoutId is required for recovery' },
          { status: 400 }
        );
      }
      if (!machine) {
        return NextResponse.json(
          {
            success: false,
            code: 'SETTLEMENT_TRANSPORT_UNCONFIGURED',
            error: 'Turnkey HSM settlement machine is not configured in this environment',
          },
          { status: 503 }
        );
      }
      const recovered = await machine.recoverUncertainBroadcast(body.payoutId);
      return NextResponse.json({ success: true, recovery: recovered }, { status: 200 });
    }

    if (
      !body.payoutId ||
      !body.idempotencyKey ||
      !body.affiliateId ||
      !body.chain ||
      !body.recipientAddress ||
      !body.amountUsd
    ) {
      return NextResponse.json(
        {
          success: false,
          code: 'MISSING_SETTLEMENT_FIELDS',
          error:
            'payoutId, idempotencyKey, affiliateId, chain, recipientAddress, and amountUsd are required',
        },
        { status: 400 }
      );
    }

    assertPhase1ChainEnabled(body.chain);
    const chain = body.chain as Phase1SettlementChain;

    const fraudEngine = new M2SybilGraphEngine();
    const fraudCheck = await fraudEngine.evaluate(
      db as unknown as LegacyD1Database,
      {
        eventType: 'payout_withdrawal',
        traderId: body.affiliateId,
        payoutWalletAddress: body.recipientAddress,
        idempotencyKey: `wd_fraud:${body.idempotencyKey}`,
      }
    );
    if (!fraudCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          code: 'FRAUD_OR_TIMELOCK_BLOCKED',
          triggeredRules: fraudCheck.triggeredRules,
          unlockAt: fraudCheck.unlockAt ?? null,
        },
        { status: 403 }
      );
    }

    const amountUnits1e8 = parseUsdToLedgerUnits(body.amountUsd);
    const ledger = new DoubleEntryLedgerService(db);
    const lockResult = await ledger.lockSettledForWithdrawal({
      idempotencyKey: `wd_lock:${body.idempotencyKey}`,
      ownerType: body.ownerType ?? 'affiliate',
      ownerId: body.affiliateId,
      amountUnits: amountUnits1e8,
      payoutId: body.payoutId,
    });

    if (!machine) {
      await ledger.revertWithdrawal({
        idempotencyKey: `wd_revert_unconf:${body.idempotencyKey}`,
        lockBatchId: lockResult.batch.id,
        reason: 'Turnkey settlement transport unconfigured',
      });
      return NextResponse.json(
        {
          success: false,
          code: 'SETTLEMENT_TRANSPORT_UNCONFIGURED',
          error: 'Turnkey HSM settlement machine is not configured in this environment',
        },
        { status: 503 }
      );
    }

    let dispatchResult;
    try {
      dispatchResult = await machine.executeSettlement({
        payoutId: body.payoutId,
        idempotencyKey: body.idempotencyKey,
        affiliateId: body.affiliateId,
        chain,
        recipientAddress: body.recipientAddress,
        amountUnits1e8,
        usdcReferencePriceUsd: body.usdcReferencePriceUsd ?? '1.0000',
      });
    } catch (execErr) {
      await ledger.revertWithdrawal({
        idempotencyKey: `wd_rev_err:${body.idempotencyKey}`,
        lockBatchId: lockResult.batch.id,
        reason: execErr instanceof Error ? execErr.message : 'Pre-signing safety check failed',
      });
      throw execErr;
    }

    if (dispatchResult.state === 'CONFIRMED' && dispatchResult.txHash) {
      await ledger.finalizeWithdrawal({
        idempotencyKey: `wd_fin:${body.idempotencyKey}`,
        lockBatchId: lockResult.batch.id,
        txHash: dispatchResult.txHash,
      });
    } else if (dispatchResult.state === 'FAILED_ABORTED') {
      await ledger.revertWithdrawal({
        idempotencyKey: `wd_rev:${body.idempotencyKey}`,
        lockBatchId: lockResult.batch.id,
        reason: dispatchResult.reason ?? 'Pre-broadcast safety abort',
      });
    }

    return NextResponse.json(
      {
        success: dispatchResult.state !== 'FAILED_ABORTED',
        lockBatchId: lockResult.batch.id,
        settlement: dispatchResult,
      },
      { status: dispatchResult.state === 'FAILED_ABORTED' ? 422 : 200 }
    );
  } catch (err) {
    return sanitizeApiErrorResponse(err, 400);
  }
}
