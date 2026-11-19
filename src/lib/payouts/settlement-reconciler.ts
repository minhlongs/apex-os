/**
 * src/lib/payouts/settlement-reconciler.ts
 *
 * Shared production settlement machine factory & passive settlement reconciler.
 *
 * Used by BOTH:
 * - `POST /api/admin/settlement/dispatch` (interactive Passkey-authenticated dispatch/recovery)
 * - `/api/cron?job=settlement_reconcile` and `handleT7HoldRelease` (automated passive recovery of
 *   uncertain `BROADCAST_PENDING` payouts so `WITHDRAWAL_LOCKED` ledger funds never stay stranded
 *   waiting for manual admin intervention after a transient Horizon/RPC timeout).
 *
 * Security invariants:
 * - Never reads or holds raw `STELLAR_SECRET_KEY` or EVM private keys in Worker memory.
 * - V1 Stellar-only deployments (`V1_STELLAR_ONLY_PAYOUTS === 'true'` without
 *   `TURNKEY_EVM_HOT_WALLET_ADDRESS`) construct cleanly for Stellar while failing closed on EVM.
 * - Automated cron reconciliation runs strictly in passive mode (`bumpGasRbf: false`,
 *   `reexecuteExpired: false`, `passiveOnly: true`) so unattended ticks never emit new HSM
 *   signatures, never broadcast, and never abort an active `SIGNING` claim.
 * - Terminal broadcasts (`CONFIRMED`, `FAILED_ABORTED`, `EXPIRED_RECOVERED`) are re-visited until
 *   their paired `WITHDRAWAL_LOCK` leaves `INFLIGHT`, so a ledger freeze or transient D1 error
 *   between the on-chain outcome and ledger resolution cannot strand user funds forever.
 */

import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import { SanctionsScreeningService } from '@/lib/compliance/sanctions-service';
import type { D1Database as LegacyD1Database } from '@/lib/db';
import { DoubleEntryLedgerService } from '@/lib/ledger';
import { ArbitrumBaseUsdcAdapter } from './adapters/arbitrum-base-usdc-adapter';
import { BroadcastRecoveryMachine } from './broadcast-recovery-machine';
import { HorizonStellarBroadcastTransport } from './stellar-horizon-transport';
import { TurnkeySigner } from './turnkey-signer';

/**
 * Module-scope cache: one `BroadcastRecoveryMachine` per (D1 binding, configuration fingerprint).
 *
 * Sharing the machine across requests in the same isolate preserves `AsyncSerialQueue`
 * nonce/sequence serialization while `WeakMap` keying prevents leaks across recycled bindings.
 */
const settlementMachineCache = new WeakMap<
  object,
  Map<string, BroadcastRecoveryMachine>
>();

export interface WorkerBindings {
  DB?: AuthD1Database;
  SETTLEMENT_MACHINE?: BroadcastRecoveryMachine;
  ANALYTICS_ENGINE?: unknown;
  [key: string]: unknown;
}

export function buildSettlementMachineConfigFingerprint(): string {
  return [
    process.env.TURNKEY_API_BASE_URL?.trim() ?? '',
    process.env.TURNKEY_ORGANIZATION_ID?.trim() ?? '',
    process.env.TURNKEY_API_PUBLIC_KEY?.trim() ?? '',
    process.env.TURNKEY_EVM_HOT_WALLET_ADDRESS?.trim() ?? '',
    process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS?.trim() ?? '',
    process.env.SAFE_COLD_ARBITRUM_ADDRESS?.trim() ?? '',
    process.env.SAFE_COLD_BASE_ADDRESS?.trim() ?? '',
    process.env.SAFE_COLD_STELLAR_ADDRESS?.trim() ?? '',
    process.env.ARBITRUM_RPC_URL?.trim() ?? '',
    process.env.ARBITRUM_FALLBACK_RPC_URL?.trim() ?? '',
    process.env.BASE_RPC_URL?.trim() ?? '',
    process.env.BASE_FALLBACK_RPC_URL?.trim() ?? '',
    process.env.STELLAR_HORIZON_URL?.trim() ?? '',
    process.env.STELLAR_USDC_ISSUER?.trim() ?? '',
    process.env.SETTLEMENT_NETWORK_MODE ?? '',
    process.env.STELLAR_NETWORK ?? '',
  ].join('|');
}

function resolveNetworkMode(): 'mainnet' | 'testnet' {
  const settlementMode = (process.env.SETTLEMENT_NETWORK_MODE ?? '').trim().toLowerCase();
  const stellarMode = (process.env.STELLAR_NETWORK ?? '').trim().toLowerCase();
  return settlementMode === 'testnet' || stellarMode === 'testnet'
    ? 'testnet'
    : 'mainnet';
}

/**
 * Lazily constructs a production `BroadcastRecoveryMachine` from Turnkey HSM +
 * RPC/Horizon environment configuration when `bindings.SETTLEMENT_MACHINE` is
 * not explicitly injected. Returns `null` when required settlement credentials
 * are absent so callers can fail closed with a descriptive 503.
 */
export function resolveSettlementMachine(
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

  if (!turnkeyOrgId || !turnkeyPubKey || !turnkeyPrivKey || !stellarHotAddr) {
    return null;
  }

  const fingerprint = buildSettlementMachineConfigFingerprint();
  let perDbCache = settlementMachineCache.get(db as unknown as object);
  if (!perDbCache) {
    perDbCache = new Map<string, BroadcastRecoveryMachine>();
    settlementMachineCache.set(db as unknown as object, perDbCache);
  }
  const cached = perDbCache.get(fingerprint);
  if (cached) {
    return cached;
  }

  const networkMode = resolveNetworkMode();

  const signer = new TurnkeySigner({
    turnkeyCredentials: {
      apiBaseUrl: process.env.TURNKEY_API_BASE_URL?.trim() || 'https://api.turnkey.com',
      apiPublicKey: turnkeyPubKey,
      apiPrivateKey: turnkeyPrivKey,
      organizationId: turnkeyOrgId,
    },
    evmHotWalletAddress: evmHotAddr || undefined,
    stellarHotWalletAddress: stellarHotAddr,
    safeColdMultisigAddresses: {
      arbitrum: process.env.SAFE_COLD_ARBITRUM_ADDRESS?.trim(),
      base: process.env.SAFE_COLD_BASE_ADDRESS?.trim(),
      stellar: process.env.SAFE_COLD_STELLAR_ADDRESS?.trim(),
    },
  });

  const evmAdapters: {
    arbitrum?: ArbitrumBaseUsdcAdapter;
    base?: ArbitrumBaseUsdcAdapter;
  } = {};

  if (evmHotAddr) {
    evmAdapters.arbitrum = new ArbitrumBaseUsdcAdapter({
      chain: 'arbitrum',
      networkMode,
      hotWalletAddress: evmHotAddr,
      primaryRpcUrl: process.env.ARBITRUM_RPC_URL?.trim(),
      fallbackRpcUrl: process.env.ARBITRUM_FALLBACK_RPC_URL?.trim(),
    });
    evmAdapters.base = new ArbitrumBaseUsdcAdapter({
      chain: 'base',
      networkMode,
      hotWalletAddress: evmHotAddr,
      primaryRpcUrl: process.env.BASE_RPC_URL?.trim(),
      fallbackRpcUrl: process.env.BASE_FALLBACK_RPC_URL?.trim(),
    });
  }

  const stellarTransport = new HorizonStellarBroadcastTransport({
    horizonUrl: process.env.STELLAR_HORIZON_URL?.trim(),
    usdcIssuer: process.env.STELLAR_USDC_ISSUER?.trim(),
  });

  const machine = new BroadcastRecoveryMachine({
    db,
    turnkeySigner: signer,
    evmAdapters,
    stellarTransport,
    sanctionsService: new SanctionsScreeningService(),
  });

  perDbCache.set(fingerprint, machine);
  return machine;
}

export async function resolveLockBatchIdForPayout(
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

export interface PendingBroadcastReconcileSummary {
  scanned: number;
  confirmed: number;
  reverted: number;
  stillPending: number;
  skippedNoMachine: boolean;
  errors: Array<{ payoutId: string; error: string }>;
}

interface ScannedBroadcastRow {
  payout_id: string;
  state: string;
  tx_hash: string | null;
  lock_batch_id: string | null;
  error_reason: string | null;
}

function emptySummary(skippedNoMachine = false): PendingBroadcastReconcileSummary {
  return {
    scanned: 0,
    confirmed: 0,
    reverted: 0,
    stillPending: 0,
    skippedNoMachine,
    errors: [],
  };
}

/**
 * Selects rows that still need reconciliation work:
 * - every `BROADCAST_PENDING` row (on-chain outcome not yet established), and
 * - every terminal row (`CONFIRMED` / `FAILED_ABORTED` / `EXPIRED_RECOVERED`) whose paired
 *   `WITHDRAWAL_LOCK` is still `INFLIGHT`, which means the ledger never observed the outcome
 *   (transient D1 failure, `EMERGENCY_LEDGER_FREEZE`, or a crashed isolate mid-resolution).
 */
async function selectReconciliationCandidates(
  db: AuthD1Database,
  limit: number
): Promise<ScannedBroadcastRow[]> {
  try {
    const joined = await db
      .prepare(
        `SELECT sb.payout_id, sb.state, sb.tx_hash, sb.lock_batch_id, sb.error_reason
         FROM settlement_broadcasts sb
         WHERE sb.state = 'BROADCAST_PENDING'
            OR (
              sb.state IN ('CONFIRMED', 'FAILED_ABORTED', 'EXPIRED_RECOVERED')
              AND EXISTS (
                SELECT 1
                FROM ledger_journal_batches lb
                WHERE lb.journal_type = 'WITHDRAWAL_LOCK'
                  AND lb.status = 'INFLIGHT'
                  AND (
                    (sb.lock_batch_id IS NOT NULL AND lb.id = sb.lock_batch_id)
                    OR lb.payout_id = sb.payout_id
                  )
              )
            )
         ORDER BY sb.updated_at ASC
         LIMIT ?`
      )
      .bind(limit)
      .all<ScannedBroadcastRow>();
    return joined.results ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table:\s*ledger_journal_batches/i.test(message)) {
      const pendingOnly = await db
        .prepare(
          `SELECT payout_id, state, tx_hash, lock_batch_id, error_reason
           FROM settlement_broadcasts
           WHERE state = 'BROADCAST_PENDING'
           ORDER BY updated_at ASC
           LIMIT ?`
        )
        .bind(limit)
        .all<ScannedBroadcastRow>();
      return pendingOnly.results ?? [];
    }
    throw err;
  }
}

/**
 * Finds the `INFLIGHT` `WITHDRAWAL_LOCK` batch that still has to be resolved for a payout.
 * Prefers the batch id recorded on the broadcast row, then falls back to the unique active
 * lock for the payout. Returns `null` when the lock table is absent or nothing is `INFLIGHT`.
 */
async function findInflightWithdrawalLockId(
  db: AuthD1Database,
  payoutId: string,
  lockBatchId: string | null
): Promise<string | null> {
  try {
    if (lockBatchId) {
      const bound = await db
        .prepare(
          `SELECT id
           FROM ledger_journal_batches
           WHERE id = ? AND journal_type = 'WITHDRAWAL_LOCK' AND status = 'INFLIGHT'
           LIMIT 1`
        )
        .bind(lockBatchId)
        .first<{ id: string }>();
      if (bound?.id) {
        return bound.id;
      }
    }

    const active = await db
      .prepare(
        `SELECT id
         FROM ledger_journal_batches
         WHERE journal_type = 'WITHDRAWAL_LOCK'
           AND payout_id = ?
           AND status = 'INFLIGHT'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .bind(payoutId)
      .first<{ id: string }>();
    return active?.id ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table:\s*ledger_journal_batches/i.test(message)) {
      return null;
    }
    throw err;
  }
}

/**
 * Passively reconciles `BROADCAST_PENDING` rows in `settlement_broadcasts` against
 * Horizon / EVM RPC and finalizes or reverts their paired `WITHDRAWAL_LOCKED`
 * double-entry ledger batches using the canonical `wd_rec_fin:<payoutId>` and
 * `wd_rec_rev:<payoutId>` idempotency keys.
 *
 * It also retries ledger resolution for terminal broadcasts whose `WITHDRAWAL_LOCK`
 * is still `INFLIGHT`, and never signs, broadcasts, or aborts an active `SIGNING` claim.
 */
export async function reconcilePendingSettlementBroadcasts(
  db: AuthD1Database,
  options?: {
    bindings?: WorkerBindings;
    machine?: BroadcastRecoveryMachine | null;
    limit?: number;
    nowUnix?: number;
  }
): Promise<PendingBroadcastReconcileSummary> {
  const limit = Math.max(1, Math.min(options?.limit ?? 25, 100));

  let rows: ScannedBroadcastRow[];
  try {
    rows = await selectReconciliationCandidates(db, limit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(message)) {
      return emptySummary();
    }
    throw err;
  }

  if (rows.length === 0) {
    return emptySummary();
  }

  const bindings = options?.bindings ?? (globalThis as unknown as WorkerBindings);
  const machine =
    options?.machine !== undefined
      ? options.machine
      : resolveSettlementMachine(bindings, db as unknown as LegacyD1Database);

  const ledger = new DoubleEntryLedgerService(db);
  let confirmed = 0;
  let reverted = 0;
  let stillPending = 0;
  let skippedPendingWithoutMachine = 0;
  const errors: Array<{ payoutId: string; error: string }> = [];

  for (const row of rows) {
    const payoutId = row.payout_id;

    if (row.state === 'BROADCAST_PENDING') {
      if (!machine) {
        skippedPendingWithoutMachine += 1;
        stillPending += 1;
        continue;
      }

      try {
        const recovered = await machine.recoverUncertainBroadcast(payoutId, {
          nowUnix: options?.nowUnix,
          bumpGasRbf: false,
          reexecuteExpired: false,
          passiveOnly: true,
        });

        const latestRecord =
          recovered.state === 'CONFIRMED' ||
          recovered.state === 'FAILED_ABORTED' ||
          recovered.state === 'EXPIRED_RECOVERED'
            ? await machine.getSettlementRecord(payoutId)
            : null;
        const effectiveLockBatchId =
          latestRecord?.lock_batch_id ?? row.lock_batch_id;
        const inflightLockId =
          recovered.state === 'CONFIRMED' ||
          recovered.state === 'FAILED_ABORTED' ||
          recovered.state === 'EXPIRED_RECOVERED'
            ? await findInflightWithdrawalLockId(db, payoutId, effectiveLockBatchId)
            : null;

        if (recovered.state === 'CONFIRMED') {
          const txHash = (recovered.txHash ?? latestRecord?.tx_hash ?? '').trim();
          if (!txHash) {
            errors.push({
              payoutId,
              error:
                'CONFIRMED settlement broadcast is missing tx_hash; refusing to finalize or revert the withdrawal lock',
            });
            continue;
          }
          if (inflightLockId) {
            await ledger.finalizeWithdrawal({
              idempotencyKey: `wd_rec_fin:${payoutId}`,
              lockBatchId: inflightLockId,
              txHash,
            });
          }
          confirmed += 1;
        } else if (
          recovered.state === 'FAILED_ABORTED' ||
          recovered.state === 'EXPIRED_RECOVERED'
        ) {
          if (inflightLockId) {
            await ledger.revertWithdrawal({
              idempotencyKey: `wd_rec_rev:${payoutId}`,
              lockBatchId: inflightLockId,
              reason:
                latestRecord?.error_reason ??
                recovered.reason ??
                `Settlement recovery terminal non-confirmed state: ${recovered.state}`,
            });
          }
          reverted += 1;
        } else {
          stillPending += 1;
        }
      } catch (err) {
        errors.push({
          payoutId,
          error: err instanceof Error ? err.message : 'Unknown recovery error',
        });
      }
      continue;
    }

    // Terminal broadcast rows are only selected while their `WITHDRAWAL_LOCK` is `INFLIGHT`.
    // They need no signing machine: the on-chain outcome is already durable, only the ledger
    // resolution may still be outstanding.
    try {
      const freshRow = await db
        .prepare(
          `SELECT state, tx_hash, lock_batch_id, error_reason
           FROM settlement_broadcasts
           WHERE payout_id = ?`
        )
        .bind(payoutId)
        .first<{
          state: string;
          tx_hash: string | null;
          lock_batch_id: string | null;
          error_reason: string | null;
        }>();
      if (!freshRow) {
        continue;
      }

      if (freshRow.state === 'CONFIRMED') {
        const txHash = (freshRow.tx_hash ?? '').trim();
        if (!txHash) {
          errors.push({
            payoutId,
            error:
              'CONFIRMED settlement broadcast is missing tx_hash; refusing to finalize or revert the withdrawal lock',
          });
          continue;
        }
        const inflightLockId = await findInflightWithdrawalLockId(
          db,
          payoutId,
          freshRow.lock_batch_id ?? row.lock_batch_id
        );
        if (!inflightLockId) {
          continue;
        }
        await ledger.finalizeWithdrawal({
          idempotencyKey: `wd_rec_fin:${payoutId}`,
          lockBatchId: inflightLockId,
          txHash,
        });
        confirmed += 1;
        continue;
      }

      if (
        freshRow.state === 'FAILED_ABORTED' ||
        freshRow.state === 'EXPIRED_RECOVERED'
      ) {
        const inflightLockId = await findInflightWithdrawalLockId(
          db,
          payoutId,
          freshRow.lock_batch_id ?? row.lock_batch_id
        );
        if (!inflightLockId) {
          continue;
        }
        await ledger.revertWithdrawal({
          idempotencyKey: `wd_rec_rev:${payoutId}`,
          lockBatchId: inflightLockId,
          reason:
            freshRow.error_reason ??
            `Settlement recovery terminal non-confirmed state: ${freshRow.state}`,
        });
        reverted += 1;
        continue;
      }

      // A concurrent caller transitioned an `EXPIRED_RECOVERED` row back to an active state.
      stillPending += 1;
    } catch (err) {
      errors.push({
        payoutId,
        error: err instanceof Error ? err.message : 'Unknown settlement resolution error',
      });
    }
  }

  return {
    scanned: rows.length,
    confirmed,
    reverted,
    stillPending,
    skippedNoMachine:
      skippedPendingWithoutMachine > 0 &&
      confirmed === 0 &&
      reverted === 0 &&
      errors.length === 0,
    errors,
  };
}

/** Clears cached machines for a D1 binding; test-only escape hatch. */
export function resetSettlementMachineCacheForTests(
  db: LegacyD1Database
): void {
  settlementMachineCache.delete(db as unknown as object);
}
