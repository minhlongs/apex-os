/**
 * Passkey-Protected Phase 1 Multichain Settlement Dispatch, Timeout Recovery & Cold-Safe Resolution Route
 *
 * POST /api/admin/settlement/dispatch
 *
 * Production entrypoint wiring together:
 * 1. Admin session + WebAuthn Passkey step-up (`requireAdminWithPasskeyStepUp`)
 * 2. Deterministic M2 Anti-Fraud & 48h Wallet-Change Timelock Check (`M2SybilGraphEngine`)
 * 3. Atomic D1 Double-Entry Ledger Withdrawal Lock (`lockSettledForWithdrawal`, 1:1 per `payoutId`)
 * 4. Turnkey HSM Enclave Signer Isolation ($250/tx, $1,500/24h -> Safe 2-of-3 Cold Queue)
 *    + Phase 1 Multichain USDC (`stellar` 7-dec, `arbitrum` 6-dec, `base` 6-dec, min $10)
 *    + `BROADCAST_PENDING` Uncertain RPC Timeout Recovery (`BroadcastRecoveryMachine`)
 *    + Full ledger lock reconciliation on `dispatch`, `recover`, and `resolve_cold_safe`
 */

import { NextRequest, NextResponse } from 'next/server';
import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import {
  requireAdminWithPasskeyStepUp,
  sanitizeApiErrorResponse,
} from '@/lib/auth/passkey-step-up';
import { SanctionsScreeningService } from '@/lib/compliance/sanctions-service';
import type { D1Database as LegacyD1Database } from '@/lib/db';
import { M2SybilGraphEngine } from '@/lib/fraud/m2-sybil-graph-engine';
import {
  DoubleEntryLedgerService,
  IdempotencyConflictError,
  InsufficientSettledBalanceError,
  LedgerFrozenError,
  LedgerStateTransitionError,
  parseUsdToLedgerUnits,
} from '@/lib/ledger';
import {
  ArbitrumBaseUsdcAdapter,
  assertPhase1ChainEnabled,
  BroadcastRecoveryMachine,
  HorizonStellarBroadcastTransport,
  TurnkeySigner,
  type Phase1SettlementChain,
} from '@/lib/payouts';
import {
  isWalletUnlockedForPayout,
  normalizePhase1WalletAddress,
} from '@/lib/wallet/timelock-wallet-service';

interface WorkerBindings {
  DB?: AuthD1Database;
  SETTLEMENT_MACHINE?: BroadcastRecoveryMachine;
}

interface SettlementDispatchBody {
  action?: 'dispatch' | 'recover' | 'resolve_cold_safe';
  payoutId?: string;
  idempotencyKey?: string;
  affiliateId?: string;
  ownerType?: 'trader' | 'affiliate' | 'agency';
  chain?: string;
  recipientAddress?: string;
  amountUsd?: string;
  usdcReferencePriceUsd?: string;
  bumpGasRbf?: boolean;
  reexecuteExpired?: boolean;
  nowUnix?: number;
  coldResolution?: 'CONFIRMED' | 'CANCELLED';
  txHash?: string;
  reason?: string;
}

/**
 * Lazily constructs a production `BroadcastRecoveryMachine` from Turnkey HSM + RPC/Horizon
 * environment configuration when `bindings.SETTLEMENT_MACHINE` is not explicitly injected.
 * Never reads or holds raw `STELLAR_SECRET_KEY` or EVM private keys in Worker memory.
 */
function resolveSettlementMachine(
  bindings: WorkerBindings,
  db: LegacyD1Database
): BroadcastRecoveryMachine | null {
  if (bindings.SETTLEMENT_MACHINE) {
    return bindings.SETTLEMENT_MACHINE;
  }

  const turnkeyOrgId = process.env.TURNKEY_ORGANIZATION_ID?.trim();
  const turnkeyPubKey = process.env.TURNKEY_API_PUBLIC_KEY?.trim();
  const turnkeyPrivKey = process.env.TURNKEY_API_PRIVATE_KEY?.trim();
  const evmHotAddr = process.env.TURNKEY_EVM_HOT_WALLET_ADDRESS?.trim();
  const stellarHotAddr = process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS?.trim();

  if (
    !turnkeyOrgId ||
    !turnkeyPubKey ||
    !turnkeyPrivKey ||
    !evmHotAddr ||
    !stellarHotAddr
  ) {
    return null;
  }

  const networkMode: 'mainnet' | 'testnet' =
    process.env.SETTLEMENT_NETWORK_MODE === 'testnet' ||
    process.env.STELLAR_NETWORK === 'testnet'
      ? 'testnet'
      : 'mainnet';

  const signer = new TurnkeySigner({
    turnkeyCredentials: {
      apiBaseUrl: process.env.TURNKEY_API_BASE_URL?.trim() || 'https://api.turnkey.com',
      apiPublicKey: turnkeyPubKey,
      apiPrivateKey: turnkeyPrivKey,
      organizationId: turnkeyOrgId,
    },
    evmHotWalletAddress: evmHotAddr,
    stellarHotWalletAddress: stellarHotAddr,
    safeColdMultisigAddresses: {
      arbitrum: process.env.SAFE_COLD_ARBITRUM_ADDRESS?.trim(),
      base: process.env.SAFE_COLD_BASE_ADDRESS?.trim(),
      stellar: process.env.SAFE_COLD_STELLAR_ADDRESS?.trim(),
    },
  });

  const arbitrumAdapter = new ArbitrumBaseUsdcAdapter({
    chain: 'arbitrum',
    networkMode,
    hotWalletAddress: evmHotAddr,
    primaryRpcUrl: process.env.ARBITRUM_RPC_URL?.trim(),
    fallbackRpcUrl: process.env.ARBITRUM_FALLBACK_RPC_URL?.trim(),
  });

  const baseAdapter = new ArbitrumBaseUsdcAdapter({
    chain: 'base',
    networkMode,
    hotWalletAddress: evmHotAddr,
    primaryRpcUrl: process.env.BASE_RPC_URL?.trim(),
    fallbackRpcUrl: process.env.BASE_FALLBACK_RPC_URL?.trim(),
  });

  const stellarTransport = new HorizonStellarBroadcastTransport({
    horizonUrl: process.env.STELLAR_HORIZON_URL?.trim(),
    usdcIssuer: process.env.STELLAR_USDC_ISSUER?.trim(),
  });

  return new BroadcastRecoveryMachine({
    db,
    turnkeySigner: signer,
    evmAdapters: {
      arbitrum: arbitrumAdapter,
      base: baseAdapter,
    },
    stellarTransport,
    sanctionsService: new SanctionsScreeningService(),
  });
}

async function resolveLockBatchIdForPayout(
  ledger: DoubleEntryLedgerService,
  machine: BroadcastRecoveryMachine,
  payoutId: string
): Promise<string | null> {
  const record = await machine.getSettlementRecord(payoutId);
  if (record?.lock_batch_id) {
    return record.lock_batch_id;
  }
  const activeLock = await ledger.getActiveWithdrawalLockByPayoutId(payoutId);
  return activeLock?.id ?? null;
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
    const machine = resolveSettlementMachine(bindings, db as unknown as LegacyD1Database);
    const ledger = new DoubleEntryLedgerService(db);

    // ========================================================================
    // Action 1: Recover Uncertain `BROADCAST_PENDING` Payout & Settle Ledger Lock
    // ========================================================================
    if (action === 'recover') {
      const payoutId = body.payoutId?.trim();
      if (!payoutId) {
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

      const lockBatchId = await resolveLockBatchIdForPayout(ledger, machine, payoutId);
      const recovered = await machine.recoverUncertainBroadcast(payoutId, {
        nowUnix: body.nowUnix,
        bumpGasRbf: body.bumpGasRbf,
        reexecuteExpired: body.reexecuteExpired,
        usdcReferencePriceUsd: body.usdcReferencePriceUsd,
      });

      if (lockBatchId) {
        const lockBatch = await ledger.getBatchById(lockBatchId);
        if (lockBatch && lockBatch.status === 'INFLIGHT') {
          if (recovered.state === 'CONFIRMED' && recovered.txHash) {
            await ledger.finalizeWithdrawal({
              idempotencyKey: `wd_rec_fin:${payoutId}`,
              lockBatchId,
              txHash: recovered.txHash,
            });
          } else if (
            recovered.state === 'FAILED_ABORTED' ||
            (recovered.state === 'EXPIRED_RECOVERED' && !body.reexecuteExpired)
          ) {
            await ledger.revertWithdrawal({
              idempotencyKey: `wd_rec_rev:${payoutId}`,
              lockBatchId,
              reason:
                recovered.reason ??
                `Settlement recovery terminal non-confirmed state: ${recovered.state}`,
            });
          }
        }
      }

      return NextResponse.json(
        {
          success: true,
          lockBatchId,
          recovery: recovered,
        },
        { status: 200 }
      );
    }

    // ========================================================================
    // Action 2: Resolve `QUEUED_COLD_SAFE` Safe 2-of-3 Cold Multisig Payout
    // ========================================================================
    if (action === 'resolve_cold_safe') {
      const payoutId = body.payoutId?.trim();
      if (!payoutId || (body.coldResolution !== 'CONFIRMED' && body.coldResolution !== 'CANCELLED')) {
        return NextResponse.json(
          {
            success: false,
            code: 'MISSING_COLD_RESOLUTION_FIELDS',
            error: "payoutId and coldResolution ('CONFIRMED' | 'CANCELLED') are required",
          },
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

      const lockBatchId = await resolveLockBatchIdForPayout(ledger, machine, payoutId);
      const updatedRecord = await machine.resolveColdSafeBroadcast({
        payoutId,
        resolution: body.coldResolution,
        txHash: body.txHash,
        reason: body.reason,
      });

      if (lockBatchId) {
        const lockBatch = await ledger.getBatchById(lockBatchId);
        if (lockBatch && lockBatch.status === 'INFLIGHT') {
          if (updatedRecord.state === 'CONFIRMED' && updatedRecord.tx_hash) {
            await ledger.finalizeWithdrawal({
              idempotencyKey: `wd_cold_fin:${payoutId}`,
              lockBatchId,
              txHash: updatedRecord.tx_hash,
            });
          } else if (updatedRecord.state === 'FAILED_ABORTED') {
            await ledger.revertWithdrawal({
              idempotencyKey: `wd_cold_rev:${payoutId}`,
              lockBatchId,
              reason:
                updatedRecord.error_reason ?? 'Safe 2-of-3 cold multisig proposal cancelled',
            });
          }
        }
      }

      return NextResponse.json(
        {
          success: true,
          lockBatchId,
          settlement: updatedRecord,
        },
        { status: 200 }
      );
    }

    // ========================================================================
    // Action 3: Primary Phase 1 Settlement Dispatch
    // ========================================================================
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

    const payoutId = body.payoutId.trim();
    const idempotencyKey = body.idempotencyKey.trim();
    const affiliateId = body.affiliateId.trim();
    const recipientAddress = body.recipientAddress.trim();

    assertPhase1ChainEnabled(body.chain);
    const chain = body.chain.trim().toLowerCase() as Phase1SettlementChain;

    // Fail BEFORE locking any ledger funds if the settlement transport is not configured!
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

    // Prevent `payoutId` reuse with a distinct `idempotencyKey` from locking a second withdrawal!
    const existingSettlement = await machine.getSettlementRecord(payoutId);
    if (existingSettlement && existingSettlement.idempotency_key !== idempotencyKey) {
      return NextResponse.json(
        {
          success: false,
          code: 'IDEMPOTENCY_CONFLICT',
          error: `payoutId '${payoutId}' is already bound to a different idempotencyKey`,
        },
        { status: 409 }
      );
    }

    // Verify target profile exists AND enforce 48h timelock + exact bound (walletAddress, chain) match!
    // Prevents dispatching to an arbitrary attacker address or cross-chain EVM mismatch (`arbitrum` vs `base`).
    const targetProfile = await db
      .prepare('SELECT id, role FROM profiles WHERE id = ? LIMIT 1')
      .bind(affiliateId)
      .first<{ id: string; role: string | null }>();
    if (!targetProfile) {
      return NextResponse.json(
        {
          success: false,
          code: 'PAYOUT_PROFILE_NOT_FOUND',
          error: `Target payout profile '${affiliateId}' does not exist`,
        },
        { status: 404 }
      );
    }

    const requestedOwnerType = body.ownerType ?? 'affiliate';
    const profileRole = (targetProfile.role ?? '').trim().toLowerCase();
    const expectedOwnerTypeForRole: Record<string, 'trader' | 'affiliate' | 'agency'> = {
      shopper: 'trader',
      trader: 'trader',
      affiliate: 'affiliate',
      agency: 'agency',
    };
    const requiredOwnerType = expectedOwnerTypeForRole[profileRole];
    if (requiredOwnerType && requiredOwnerType !== requestedOwnerType) {
      return NextResponse.json(
        {
          success: false,
          code: 'OWNER_TYPE_MISMATCH',
          error: `Profile '${affiliateId}' has role '${profileRole}' and cannot dispatch from '${requestedOwnerType}' ledger bucket`,
        },
        { status: 422 }
      );
    }

    const evalNowIso =
      typeof body.nowUnix === 'number' && Number.isFinite(body.nowUnix)
        ? new Date(body.nowUnix * 1000).toISOString()
        : new Date().toISOString();
    const unlockStatus = await isWalletUnlockedForPayout(
      db as unknown as LegacyD1Database,
      affiliateId,
      evalNowIso
    );
    if (!unlockStatus.unlocked) {
      return NextResponse.json(
        {
          success: false,
          code:
            unlockStatus.reason === 'WALLET_TIMELOCK_ACTIVE_48H'
              ? 'FRAUD_OR_TIMELOCK_BLOCKED'
              : 'NO_PAYOUT_WALLET_BOUND',
          triggeredRules: [unlockStatus.reason],
          unlockAt: unlockStatus.unlockAt ?? null,
        },
        { status: 403 }
      );
    }

    const canonicalRequestedAddr = normalizePhase1WalletAddress(recipientAddress, chain);
    const boundChain = (unlockStatus.chain ?? '').trim().toLowerCase();
    const canonicalBoundAddr = normalizePhase1WalletAddress(
      unlockStatus.walletAddress ?? '',
      chain
    );
    if (
      !canonicalRequestedAddr ||
      boundChain !== chain ||
      !canonicalBoundAddr ||
      canonicalRequestedAddr !== canonicalBoundAddr
    ) {
      return NextResponse.json(
        {
          success: false,
          code: 'RECIPIENT_WALLET_MISMATCH',
          error:
            'recipientAddress and chain must match the unlocked payout wallet and preferred_chain bound on the target profile',
        },
        { status: 403 }
      );
    }

    const existingLockForIdem = await ledger.getBatchByIdempotencyKey(
      `wd_lock:${idempotencyKey}`
    );
    const fraudEngine = new M2SybilGraphEngine();
    const fraudCheck = await fraudEngine.evaluate(
      db as unknown as LegacyD1Database,
      {
        eventType: 'payout_withdrawal',
        traderId: affiliateId,
        payoutWalletAddress: recipientAddress,
        // Skip duplicate replay rule when re-entering an already-created withdrawal lock for the SAME idempotencyKey
        idempotencyKey: existingLockForIdem ? undefined : `wd_fraud:${idempotencyKey}`,
        nowIso: evalNowIso,
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
    const lockResult = await ledger.lockSettledForWithdrawal({
      idempotencyKey: `wd_lock:${idempotencyKey}`,
      ownerType: body.ownerType ?? 'affiliate',
      ownerId: affiliateId,
      amountUnits: amountUnits1e8,
      payoutId,
    });

    // Reverted Withdrawal Lock Double-Spend Guard:
    // If `lockResult.isReplay === true` AND `lockResult.batch.status === 'VOIDED'`,
    // a prior attempt with this `idempotencyKey` failed pre-broadcast and already refunded
    // the user's balance. NEVER call `machine.executeSettlement` against a VOIDED lock!
    if (lockResult.isReplay && lockResult.batch.status === 'VOIDED') {
      return NextResponse.json(
        {
          success: false,
          code: 'IDEMPOTENCY_KEY_PREVIOUSLY_VOIDED',
          lockBatchId: lockResult.batch.id,
          error:
            'Withdrawal lock for this idempotencyKey was previously reverted after a pre-broadcast abort; submit a new payoutId and idempotencyKey to retry',
        },
        { status: 409 }
      );
    }

    // If `lockResult.isReplay === true` AND `lockResult.batch.status === 'SETTLED'`,
    // return the already-finalized settlement deterministically without re-executing.
    if (lockResult.isReplay && lockResult.batch.status === 'SETTLED') {
      return NextResponse.json(
        {
          success: true,
          isReplay: true,
          lockBatchId: lockResult.batch.id,
          settlement: existingSettlement ?? {
            payoutId,
            chain,
            state: 'CONFIRMED',
            txHash: lockResult.batch.settledTxHash,
          },
        },
        { status: 200 }
      );
    }

    let dispatchResult;
    try {
      dispatchResult = await machine.executeSettlement({
        payoutId,
        idempotencyKey,
        affiliateId,
        chain,
        recipientAddress,
        amountUnits1e8,
        lockBatchId: lockResult.batch.id,
        usdcReferencePriceUsd: body.usdcReferencePriceUsd ?? '1.0000',
        nowUnix: body.nowUnix,
      });
    } catch (execErr) {
      // Only revert the withdrawal lock if `machine` NEVER persisted an in-flight/committed
      // broadcast record (`SIGNING`, `BROADCAST_PENDING`, `CONFIRMED`, `QUEUED_COLD_SAFE`)!
      const persistedAfterErr = await machine.getSettlementRecord(payoutId).catch(() => null);
      const unsafeToRevert =
        persistedAfterErr !== null &&
        (persistedAfterErr.state === 'SIGNING' ||
          persistedAfterErr.state === 'BROADCAST_PENDING' ||
          persistedAfterErr.state === 'CONFIRMED' ||
          persistedAfterErr.state === 'QUEUED_COLD_SAFE');

      if (!unsafeToRevert) {
        const currentLock = await ledger.getBatchById(lockResult.batch.id);
        if (currentLock && currentLock.status === 'INFLIGHT') {
          await ledger.revertWithdrawal({
            idempotencyKey: `wd_rev_err:${idempotencyKey}`,
            lockBatchId: lockResult.batch.id,
            reason:
              execErr instanceof Error ? execErr.message : 'Pre-signing safety check failed',
          });
        }
      }
      throw execErr;
    }

    if (dispatchResult.state === 'CONFIRMED' && dispatchResult.txHash) {
      const currentLock = await ledger.getBatchById(lockResult.batch.id);
      if (currentLock && currentLock.status === 'INFLIGHT') {
        await ledger.finalizeWithdrawal({
          idempotencyKey: `wd_fin:${idempotencyKey}`,
          lockBatchId: lockResult.batch.id,
          txHash: dispatchResult.txHash,
        });
      }
    } else if (dispatchResult.state === 'FAILED_ABORTED') {
      const currentLock = await ledger.getBatchById(lockResult.batch.id);
      if (currentLock && currentLock.status === 'INFLIGHT') {
        await ledger.revertWithdrawal({
          idempotencyKey: `wd_rev:${idempotencyKey}`,
          lockBatchId: lockResult.batch.id,
          reason: dispatchResult.reason ?? 'Pre-broadcast safety abort',
        });
      }
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
    if (err instanceof IdempotencyConflictError) {
      return sanitizeApiErrorResponse(err, 409);
    }
    if (err instanceof InsufficientSettledBalanceError || err instanceof LedgerStateTransitionError) {
      return sanitizeApiErrorResponse(err, 422);
    }
    if (err instanceof LedgerFrozenError) {
      return sanitizeApiErrorResponse(err, 503);
    }
    return sanitizeApiErrorResponse(err, 400);
  }
}
