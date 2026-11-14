/**
 * src/lib/payouts/broadcast-recovery-machine.ts
 *
 * Deterministic `BROADCAST_PENDING` Settlement State Machine & Timeout Recovery (Gates G7 & G8)
 *
 * Manages `settlement_broadcasts` and `signer_nonces` on Cloudflare D1:
 * - Pre-signing safety guards (Phase 1 chain gate, USDC peg [$0.985, $1.015], $10 floor,
 *   OFAC sanctions, Circle `isBlacklisted` + `eth_call` simulation, Stellar existing USDC trustline).
 * - Turnkey HSM policy enforcement ($250/tx, $1,500/24h rolling hot cap -> `QUEUED_COLD_SAFE`).
 * - Atomic nonce/sequence reservation BEFORE signing (`signer_nonces`).
 * - Persist `BROADCAST_PENDING` + deterministic `tx_hash` BEFORE RPC broadcast so 504 Gateway Timeouts
 *   or dropped sockets never lose transaction identity.
 * - Gate G8 `recoverUncertainBroadcast`:
 *   1. Never allocates a new EVM nonce or signs a new Stellar sequence while `BROADCAST_PENDING` is unresolved.
 *   2. Reconciles to `CONFIRMED` if the original tx landed on-chain (0 double-sends).
 *   3. On Stellar: refuses re-signing while `nowUnix <= timebounds_max_unix` (180s); only marks
 *      `EXPIRED_RECOVERED` once `nowUnix > timebounds_max_unix` AND verified absent on Horizon.
 *   4. On EVM: if unmined and `confirmedNonce <= assigned_nonce`, re-broadcasts the SAME signed raw tx
 *      or builds an RBF replacement reusing the EXACT SAME `assigned_nonce`.
 */

import Decimal from 'decimal.js';
import type { Hex } from 'viem';
import type { D1Database } from '../db';
import type { SanctionsScreeningService } from '../compliance/sanctions-service';
import {
  EVM_USDC_DECIMALS,
  ledgerUnits1e8ToEvmUsdcUnits,
  type ArbitrumBaseUsdcAdapter,
  type EvmPhase1SettlementChain,
  type Phase1SettlementChain,
} from './adapters/arbitrum-base-usdc-adapter';
import {
  STELLAR_TIMEBOUNDS_SECONDS,
  STELLAR_USDC_DECIMALS,
  fromStellarStroops,
  ledgerUnits1e8ToStellarStroops,
} from './stellar-service';
import { TurnkeySigner } from './turnkey-signer';
import {
  assertPreSigningSafetyGuards,
  type StellarTrustlineVerifier,
} from './usdc-safety-guards';

// ============================================================================
// State Machine Types & Stellar Transport Interface
// ============================================================================

export type SettlementBroadcastState =
  | 'QUEUED_COLD_SAFE'
  | 'SIGNING'
  | 'BROADCAST_PENDING'
  | 'CONFIRMED'
  | 'EXPIRED_RECOVERED'
  | 'FAILED_ABORTED';

export interface SettlementBroadcastRow {
  payout_id: string;
  idempotency_key: string;
  affiliate_id: string;
  chain: Phase1SettlementChain;
  recipient_address: string;
  amount_units_1e8: number;
  chain_token_units: string;
  chain_decimals: 6 | 7;
  state: SettlementBroadcastState;
  signer_address: string | null;
  assigned_nonce: number | null;
  stellar_sequence: string | null;
  timebounds_max_unix: number | null;
  tx_hash: string | null;
  signed_raw_tx?: string | null;
  rbf_candidate_tx_hash?: string | null;
  lock_batch_id?: string | null;
  turnkey_activity_id: string | null;
  safe_multisig_tx_hash: string | null;
  error_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface StellarBuiltUnsignedTx {
  unsignedEnvelopeXdr: string;
  txHashHex: string;
  stellarSequence: string;
  timeboundsMaxUnix: number;
  amountFormatted7: string;
}

export interface StellarHorizonTxLookupResult {
  found: boolean;
  successful: boolean;
  ledger?: number;
}

/**
 * Injectable Stellar Horizon transport for Protocol 30 transaction preparation,
 * submission, and sequence/status inspection without holding secret keys.
 */
export interface StellarBroadcastTransport extends StellarTrustlineVerifier {
  getAccountSequence(accountId: string): Promise<bigint>;
  buildUnsignedUsdcPayment(params: {
    fromAccount: string;
    recipientAddress: string;
    stellarSequence: string;
    amountStroops: bigint;
    amountFormatted7: string;
    timeboundsMaxUnix: number;
    memo?: string;
  }): Promise<StellarBuiltUnsignedTx>;
  submitSignedTransaction(params: {
    signedEnvelopeXdr: string;
    signatureBase64: string;
    expectedTxHash: string;
  }): Promise<{ txHash: string; confirmed: boolean }>;
  lookupTransaction(txHash: string): Promise<StellarHorizonTxLookupResult>;
}

export interface BroadcastRecoveryMachineDeps {
  db: D1Database;
  turnkeySigner: TurnkeySigner;
  evmAdapters: Partial<Record<EvmPhase1SettlementChain, ArbitrumBaseUsdcAdapter>>;
  stellarTransport?: StellarBroadcastTransport;
  sanctionsService?: SanctionsScreeningService;
  defaultUsdcPriceUsd?: string | number | Decimal;
  nowUnixProvider?: () => number;
}

export interface ExecuteSettlementRequest {
  payoutId: string;
  idempotencyKey: string;
  affiliateId: string;
  chain: string;
  recipientAddress: string;
  amountUnits1e8: bigint;
  lockBatchId?: string | null;
  usdcReferencePriceUsd?: string | number | Decimal;
  nowUnix?: number;
  memo?: string;
}

export interface ExecuteSettlementOutcome {
  payoutId: string;
  chain: Phase1SettlementChain;
  state: SettlementBroadcastState;
  txHash?: string | null;
  assignedNonce?: number | null;
  stellarSequence?: string | null;
  timeboundsMaxUnix?: number | null;
  safeMultisigTxHash?: string | null;
  turnkeyActivityId?: string | null;
  uncertainBroadcast?: boolean;
  reason?: string;
}

export type RecoveryAction =
  | 'ALREADY_CONFIRMED'
  | 'RECONCILED_ON_CHAIN'
  | 'LOCKED_AWAITING_TIMEBOUNDS_EXPIRY'
  | 'EXPIRED_RECOVERED'
  | 'EXPIRED_AND_REEXECUTED'
  | 'EVM_REBROADCAST_SAME_NONCE_CONFIRMED'
  | 'EVM_RBF_SAME_NONCE_CONFIRMED'
  | 'STILL_BROADCAST_PENDING'
  | 'FAILED_ON_CHAIN_REVERTED'
  | 'NO_RECOVERY_NEEDED';

export interface RecoverBroadcastOptions {
  nowUnix?: number;
  bumpGasRbf?: boolean;
  reexecuteExpired?: boolean;
  usdcReferencePriceUsd?: string | number | Decimal;
}

export interface RecoverBroadcastOutcome {
  payoutId: string;
  chain: Phase1SettlementChain;
  state: SettlementBroadcastState;
  action: RecoveryAction;
  txHash: string | null;
  assignedNonce: number | null;
  stellarSequence: string | null;
  timeboundsMaxUnix: number | null;
  reason?: string;
}

// ============================================================================
// Lightweight Async Mutex for Deterministic Reservation Serialization
// ============================================================================

class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function isUncertainBroadcastError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('504') ||
    msg.includes('gateway timeout') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('502') ||
    msg.includes('503')
  );
}

// ============================================================================
// BroadcastRecoveryMachine Implementation
// ============================================================================

export class BroadcastRecoveryMachine {
  private readonly db: D1Database;
  private readonly turnkeySigner: TurnkeySigner;
  private readonly evmAdapters: Partial<
    Record<EvmPhase1SettlementChain, ArbitrumBaseUsdcAdapter>
  >;
  private readonly stellarTransport?: StellarBroadcastTransport;
  private readonly sanctionsService?: SanctionsScreeningService;
  private readonly defaultUsdcPriceUsd: string | number | Decimal;
  private readonly nowUnixProvider: () => number;

  // Serializes policy cap check + nonce/sequence reservation + D1 row insert across concurrent calls
  private readonly reservationMutex = new AsyncSerialQueue();
  // Per-payout mutex preventing concurrent recovery races on the same payout_id
  private readonly payoutLocks = new Map<string, AsyncSerialQueue>();
  // Signed raw EVM transaction cache keyed by payout_id for zero-re-signing raw rebroadcast
  private readonly signedEvmRawTxCache = new Map<string, Hex>();

  constructor(deps: BroadcastRecoveryMachineDeps) {
    this.db = deps.db;
    this.turnkeySigner = deps.turnkeySigner;
    this.evmAdapters = deps.evmAdapters;
    this.stellarTransport = deps.stellarTransport;
    this.sanctionsService = deps.sanctionsService;
    this.defaultUsdcPriceUsd = deps.defaultUsdcPriceUsd ?? '1.0000';
    this.nowUnixProvider =
      deps.nowUnixProvider ?? (() => Math.floor(Date.now() / 1000));
  }

  private getPayoutLock(payoutId: string): AsyncSerialQueue {
    let lock = this.payoutLocks.get(payoutId);
    if (!lock) {
      lock = new AsyncSerialQueue();
      this.payoutLocks.set(payoutId, lock);
    }
    return lock;
  }

  async getSettlementRecord(payoutId: string): Promise<SettlementBroadcastRow | null> {
    const row = await this.db
      .prepare('SELECT * FROM settlement_broadcasts WHERE payout_id = ?')
      .bind(payoutId)
      .first<SettlementBroadcastRow>();
    return row ?? null;
  }

  async getNextSignerNonce(
    chain: Phase1SettlementChain,
    signerAddress: string
  ): Promise<number | null> {
    const row = await this.db
      .prepare(
        'SELECT next_nonce FROM signer_nonces WHERE chain = ? AND signer_address = ?'
      )
      .bind(chain, signerAddress)
      .first<{ next_nonce: number }>();
    return row ? Number(row.next_nonce) : null;
  }

  /**
   * Atomically reserve the next EVM nonce in `signer_nonces` BEFORE signing,
   * using Compare-And-Swap (`WHERE next_nonce = ?`) so cross-isolate Workers never
   * allocate the same EVM nonce concurrently.
   */
  private async reserveEvmNonce(
    chain: EvmPhase1SettlementChain,
    adapter: ArbitrumBaseUsdcAdapter,
    signerAddress: string
  ): Promise<number> {
    const onChainPending = await adapter.getTransactionCount(signerAddress, 'pending');

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const existing = await this.getNextSignerNonce(chain, signerAddress);
      if (existing === null) {
        const assignedNonce = onChainPending;
        try {
          const ins = await this.db
            .prepare(
              `INSERT OR IGNORE INTO signer_nonces (chain, signer_address, next_nonce, updated_at)
               VALUES (?, ?, ?, datetime('now'))`
            )
            .bind(chain, signerAddress, assignedNonce + 1)
            .run();
          if (ins.meta?.changes === 1) {
            return assignedNonce;
          }
        } catch {
          // Concurrent insert won; retry CAS loop
        }
        continue;
      }

      const assignedNonce = Math.max(existing, onChainPending);
      const upd = await this.db
        .prepare(
          `UPDATE signer_nonces
           SET next_nonce = ?, updated_at = datetime('now')
           WHERE chain = ? AND signer_address = ? AND next_nonce = ?`
        )
        .bind(assignedNonce + 1, chain, signerAddress, existing)
        .run();

      if (!upd.meta || upd.meta.changes === 1) {
        return assignedNonce;
      }
    }

    throw new Error(`Failed to atomically reserve EVM nonce on ${chain} after 16 CAS attempts`);
  }

  /**
   * Atomically reserve the next 64-bit Stellar sequence number in `signer_nonces`
   * stored as exact decimal `TEXT` (`next_sequence_text`) + `BigInt` so 64-bit Horizon
   * sequences (`(ledger << 32) + idx` > `2^53 - 1`) never lose precision.
   */
  async getNextStellarSequence(signerAddress: string): Promise<bigint | null> {
    const row = await this.db
      .prepare(
        `SELECT next_sequence_text, next_nonce
         FROM signer_nonces
         WHERE chain = 'stellar' AND signer_address = ?`
      )
      .bind(signerAddress)
      .first<{ next_sequence_text?: string | null; next_nonce?: number | null }>();
    if (!row) {
      return null;
    }
    if (typeof row.next_sequence_text === 'string' && /^\d+$/.test(row.next_sequence_text)) {
      return BigInt(row.next_sequence_text);
    }
    if (typeof row.next_nonce === 'number' && row.next_nonce > 0) {
      return BigInt(Math.trunc(row.next_nonce));
    }
    return null;
  }

  private async reserveStellarSequence(
    transport: StellarBroadcastTransport,
    signerAddress: string
  ): Promise<string> {
    const horizonCurrentSeq = await transport.getAccountSequence(signerAddress);
    const minNextSeq = horizonCurrentSeq + BigInt(1);

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.db
        .prepare(
          `SELECT next_sequence_text, next_nonce
           FROM signer_nonces
           WHERE chain = 'stellar' AND signer_address = ?`
        )
        .bind(signerAddress)
        .first<{ next_sequence_text?: string | null; next_nonce?: number | null }>();

      if (!row) {
        const assignedSeq = minNextSeq;
        const nextSeqText = (assignedSeq + BigInt(1)).toString();
        const safeNonceMirror =
          assignedSeq + BigInt(1) <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(assignedSeq + BigInt(1))
            : 0;
        const ins = await this.db
          .prepare(
            `INSERT OR IGNORE INTO signer_nonces (
               chain, signer_address, next_nonce, next_sequence_text, updated_at
             ) VALUES ('stellar', ?, ?, ?, datetime('now'))`
          )
          .bind(signerAddress, safeNonceMirror, nextSeqText)
          .run();
        if (!ins.meta || ins.meta.changes === 1) {
          return assignedSeq.toString();
        }
        continue;
      }

      const storedNext =
        typeof row.next_sequence_text === 'string' && /^\d+$/.test(row.next_sequence_text)
          ? BigInt(row.next_sequence_text)
          : BigInt(Math.max(0, Math.trunc(Number(row.next_nonce ?? 0))));
      const assignedSeq = storedNext > minNextSeq ? storedNext : minNextSeq;
      const nextSeqText = (assignedSeq + BigInt(1)).toString();
      const safeNonceMirror =
        assignedSeq + BigInt(1) <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(assignedSeq + BigInt(1))
          : 0;

      const upd =
        typeof row.next_sequence_text === 'string'
          ? await this.db
              .prepare(
                `UPDATE signer_nonces
                 SET next_nonce = ?,
                     next_sequence_text = ?,
                     updated_at = datetime('now')
                 WHERE chain = 'stellar'
                   AND signer_address = ?
                   AND next_sequence_text = ?`
              )
              .bind(safeNonceMirror, nextSeqText, signerAddress, row.next_sequence_text)
              .run()
          : await this.db
              .prepare(
                `UPDATE signer_nonces
                 SET next_nonce = ?,
                     next_sequence_text = ?,
                     updated_at = datetime('now')
                 WHERE chain = 'stellar'
                   AND signer_address = ?
                   AND next_sequence_text IS NULL
                   AND next_nonce = ?`
              )
              .bind(safeNonceMirror, nextSeqText, signerAddress, row.next_nonce ?? 0)
              .run();

      if (!upd.meta || upd.meta.changes === 1) {
        return assignedSeq.toString();
      }
    }

    throw new Error('Failed to atomically reserve 64-bit Stellar sequence after 16 CAS attempts');
  }

  /**
   * Execute a Phase 1 settlement payout with full pre-signing safety guards,
   * Turnkey HSM policy isolation, and `BROADCAST_PENDING` lock guarantees.
   */
  async executeSettlement(
    request: ExecuteSettlementRequest
  ): Promise<ExecuteSettlementOutcome> {
    return this.getPayoutLock(request.payoutId).runExclusive(async () => {
      return this.executeSettlementLocked(request);
    });
  }

  private async executeSettlementLocked(
    request: ExecuteSettlementRequest
  ): Promise<ExecuteSettlementOutcome> {
    const nowUnix = request.nowUnix ?? this.nowUnixProvider();
    const referencePrice = request.usdcReferencePriceUsd ?? this.defaultUsdcPriceUsd;

    // Step 0: Check existing settlement_broadcasts record first!
    // Gate G8 Invariant: NEVER re-allocate nonce or re-sign an unresolved BROADCAST_PENDING record!
    const existing = await this.getSettlementRecord(request.payoutId);
    if (existing) {
      if (existing.state === 'CONFIRMED') {
        return {
          payoutId: existing.payout_id,
          chain: existing.chain,
          state: 'CONFIRMED',
          txHash: existing.tx_hash,
          assignedNonce: existing.assigned_nonce,
          stellarSequence: existing.stellar_sequence,
          timeboundsMaxUnix: existing.timebounds_max_unix,
          turnkeyActivityId: existing.turnkey_activity_id,
        };
      }

      if (existing.state === 'QUEUED_COLD_SAFE') {
        return {
          payoutId: existing.payout_id,
          chain: existing.chain,
          state: 'QUEUED_COLD_SAFE',
          safeMultisigTxHash: existing.safe_multisig_tx_hash,
          reason: existing.error_reason ?? undefined,
        };
      }

      if (existing.state === 'BROADCAST_PENDING' || existing.state === 'SIGNING') {
        return {
          payoutId: existing.payout_id,
          chain: existing.chain,
          state: existing.state,
          txHash: existing.tx_hash,
          assignedNonce: existing.assigned_nonce,
          stellarSequence: existing.stellar_sequence,
          timeboundsMaxUnix: existing.timebounds_max_unix,
          turnkeyActivityId: existing.turnkey_activity_id,
          uncertainBroadcast: true,
          reason:
            'Payout is locked in BROADCAST_PENDING; invoke recoverUncertainBroadcast instead of allocating a duplicate nonce/sequence',
        };
      }

      if (existing.state === 'FAILED_ABORTED') {
        return {
          payoutId: existing.payout_id,
          chain: existing.chain,
          state: 'FAILED_ABORTED',
          reason: existing.error_reason ?? 'Settlement previously aborted',
        };
      }
      // Note: existing.state === 'EXPIRED_RECOVERED' is eligible for bounded re-execution below.
    }

    // Step 1: Run all pre-signing safety guards (Phase 1 chain gate, peg band, $10 floor,
    // OFAC sanctions, Circle isBlacklisted + eth_call OR Stellar existing USDC trustline).
    const verdict = await assertPreSigningSafetyGuards({
      db: this.db,
      chain: request.chain,
      recipientAddress: request.recipientAddress,
      amountUnits1e8: request.amountUnits1e8,
      usdcReferencePriceUsd: referencePrice,
      sanctionsService: this.sanctionsService,
      evmAdapters: this.evmAdapters,
      stellarTrustlineVerifier: this.stellarTransport,
    });

    const chain = verdict.chain;
    const chainDecimals: 6 | 7 =
      chain === 'stellar' ? STELLAR_USDC_DECIMALS : EVM_USDC_DECIMALS;
    const chainTokenUnitsBig =
      chain === 'stellar'
        ? ledgerUnits1e8ToStellarStroops(request.amountUnits1e8)
        : ledgerUnits1e8ToEvmUsdcUnits(request.amountUnits1e8);
    const chainTokenUnits = chainTokenUnitsBig.toString();

    // Step 2: Serialized Turnkey policy check + atomic nonce/sequence reservation + SIGNING state insert
    const reservation = await this.reservationMutex.runExclusive(async () => {
      const policy = await this.turnkeySigner.evaluateHotWalletPolicy(
        this.db,
        request.amountUnits1e8,
        request.payoutId
      );

      if (!policy.allowedHotSign) {
        const coldQueued = await this.turnkeySigner.enqueueColdSafeMultisig(this.db, {
          payoutId: request.payoutId,
          idempotencyKey: request.idempotencyKey,
          affiliateId: request.affiliateId,
          chain,
          recipientAddress: verdict.recipientAddress,
          amountUnits1e8: request.amountUnits1e8,
          chainTokenUnits,
          chainDecimals,
          lockBatchId: request.lockBatchId ?? null,
          reason:
            policy.reason ??
            'Routed to Safe{Wallet} 2-of-3 cold multisig due to hot-wallet policy cap',
        });

        return {
          routedCold: true as const,
          coldQueued,
        };
      }

      const signerAddress = this.turnkeySigner.getHotWalletAddress(chain);

      if (chain === 'arbitrum' || chain === 'base') {
        const adapter = this.evmAdapters[chain];
        if (!adapter) {
          throw new Error(`Missing ArbitrumBaseUsdcAdapter for ${chain}`);
        }
        const assignedNonce = await this.reserveEvmNonce(chain, adapter, signerAddress);

        await this.db
          .prepare(
            `INSERT INTO settlement_broadcasts (
               payout_id, idempotency_key, affiliate_id, chain, recipient_address,
               amount_units_1e8, chain_token_units, chain_decimals, state,
               signer_address, assigned_nonce, stellar_sequence, timebounds_max_unix,
               tx_hash, signed_raw_tx, rbf_candidate_tx_hash, lock_batch_id,
               turnkey_activity_id, error_reason, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SIGNING', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, datetime('now'), datetime('now'))
             ON CONFLICT(payout_id) DO UPDATE SET
               state = 'SIGNING',
               signer_address = excluded.signer_address,
               assigned_nonce = excluded.assigned_nonce,
               tx_hash = NULL,
               signed_raw_tx = NULL,
               rbf_candidate_tx_hash = NULL,
               lock_batch_id = COALESCE(settlement_broadcasts.lock_batch_id, excluded.lock_batch_id),
               turnkey_activity_id = NULL,
               error_reason = NULL,
               updated_at = datetime('now')`
          )
          .bind(
            request.payoutId,
            request.idempotencyKey,
            request.affiliateId,
            chain,
            verdict.recipientAddress,
            Number(request.amountUnits1e8),
            chainTokenUnits,
            chainDecimals,
            signerAddress,
            assignedNonce,
            request.lockBatchId ?? null
          )
          .run();

        return {
          routedCold: false as const,
          signerAddress,
          assignedNonce,
          stellarSequence: null,
          timeboundsMaxUnix: null,
        };
      }

      if (!this.stellarTransport) {
        throw new Error('Missing StellarBroadcastTransport for Stellar settlement');
      }

      const stellarSequence = await this.reserveStellarSequence(
        this.stellarTransport,
        signerAddress
      );
      const timeboundsMaxUnix = nowUnix + STELLAR_TIMEBOUNDS_SECONDS;

      await this.db
        .prepare(
          `INSERT INTO settlement_broadcasts (
             payout_id, idempotency_key, affiliate_id, chain, recipient_address,
             amount_units_1e8, chain_token_units, chain_decimals, state,
             signer_address, assigned_nonce, stellar_sequence, timebounds_max_unix,
             tx_hash, signed_raw_tx, rbf_candidate_tx_hash, lock_batch_id,
             turnkey_activity_id, error_reason, created_at, updated_at
           ) VALUES (?, ?, ?, 'stellar', ?, ?, ?, 7, 'SIGNING', ?, NULL, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, datetime('now'), datetime('now'))
           ON CONFLICT(payout_id) DO UPDATE SET
             state = 'SIGNING',
             signer_address = excluded.signer_address,
             stellar_sequence = excluded.stellar_sequence,
             timebounds_max_unix = excluded.timebounds_max_unix,
             tx_hash = NULL,
             signed_raw_tx = NULL,
             rbf_candidate_tx_hash = NULL,
             lock_batch_id = COALESCE(settlement_broadcasts.lock_batch_id, excluded.lock_batch_id),
             turnkey_activity_id = NULL,
             error_reason = NULL,
             updated_at = datetime('now')`
        )
        .bind(
          request.payoutId,
          request.idempotencyKey,
          request.affiliateId,
          verdict.recipientAddress,
          Number(request.amountUnits1e8),
          chainTokenUnits,
          signerAddress,
          stellarSequence,
          timeboundsMaxUnix,
          request.lockBatchId ?? null
        )
        .run();

      return {
        routedCold: false as const,
        signerAddress,
        assignedNonce: null,
        stellarSequence,
        timeboundsMaxUnix,
      };
    });

    if (reservation.routedCold) {
      return {
        payoutId: request.payoutId,
        chain,
        state: 'QUEUED_COLD_SAFE',
        safeMultisigTxHash: reservation.coldQueued.safeMultisigTxHash,
        reason: reservation.coldQueued.reason,
      };
    }

    // Step 3: Build unsigned transaction, sign via Turnkey HSM, persist BROADCAST_PENDING BEFORE RPC broadcast
    if (chain === 'arbitrum' || chain === 'base') {
      const adapter = this.evmAdapters[chain]!;
      const assignedNonce = reservation.assignedNonce!;

      const envelope = await adapter.buildUnsignedTransfer({
        recipientAddress: verdict.recipientAddress,
        amountUnits1e8: request.amountUnits1e8,
        assignedNonce,
      });

      const sig = await this.turnkeySigner.signEvmDigestEnforced({
        db: this.db,
        payoutId: request.payoutId,
        chain,
        amountUnits1e8: request.amountUnits1e8,
        digestHex: envelope.signingDigestHex,
      });

      const assembled = adapter.assembleSignedTransaction(envelope, sig);
      this.signedEvmRawTxCache.set(request.payoutId, assembled.signedRawTxHex);

      // Persist BROADCAST_PENDING + tx_hash + signed_raw_tx BEFORE calling eth_sendRawTransaction!
      await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'BROADCAST_PENDING',
               tx_hash = ?,
               signed_raw_tx = ?,
               turnkey_activity_id = ?,
               updated_at = datetime('now')
           WHERE payout_id = ?`
        )
        .bind(assembled.txHash, assembled.signedRawTxHex, sig.activityId, request.payoutId)
        .run();

      try {
        const rpcHash = await adapter.broadcastSignedTransaction(assembled.signedRawTxHex);
        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'CONFIRMED',
                 tx_hash = ?,
                 error_reason = NULL,
                 updated_at = datetime('now')
             WHERE payout_id = ?`
          )
          .bind(rpcHash, request.payoutId)
          .run();

        return {
          payoutId: request.payoutId,
          chain,
          state: 'CONFIRMED',
          txHash: rpcHash,
          assignedNonce,
          turnkeyActivityId: sig.activityId,
        };
      } catch (broadcastErr: unknown) {
        const errMsg =
          broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr);

        if (isUncertainBroadcastError(broadcastErr)) {
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'BROADCAST_PENDING',
                   error_reason = ?,
                   updated_at = datetime('now')
               WHERE payout_id = ?`
            )
            .bind(errMsg, request.payoutId)
            .run();

          return {
            payoutId: request.payoutId,
            chain,
            state: 'BROADCAST_PENDING',
            txHash: assembled.txHash,
            assignedNonce,
            turnkeyActivityId: sig.activityId,
            uncertainBroadcast: true,
            reason: errMsg,
          };
        }

        // Keep BROADCAST_PENDING even on unexpected RPC errors unless deterministically rejected pre-mempool
        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'BROADCAST_PENDING',
                 error_reason = ?,
                 updated_at = datetime('now')
             WHERE payout_id = ?`
          )
          .bind(errMsg, request.payoutId)
          .run();

        return {
          payoutId: request.payoutId,
          chain,
          state: 'BROADCAST_PENDING',
          txHash: assembled.txHash,
          assignedNonce,
          turnkeyActivityId: sig.activityId,
          uncertainBroadcast: true,
          reason: errMsg,
        };
      }
    }

    // Stellar branch
    const transport = this.stellarTransport!;
    const stellarSequence = reservation.stellarSequence!;
    const timeboundsMaxUnix = reservation.timeboundsMaxUnix!;
    const amountFormatted7 = fromStellarStroops(chainTokenUnitsBig);

    const built = await transport.buildUnsignedUsdcPayment({
      fromAccount: reservation.signerAddress,
      recipientAddress: verdict.recipientAddress,
      stellarSequence,
      amountStroops: chainTokenUnitsBig,
      amountFormatted7,
      timeboundsMaxUnix,
      memo: request.memo ?? request.idempotencyKey.slice(0, 28),
    });

    const stellarSig = await this.turnkeySigner.signStellarEnvelopeEnforced({
      db: this.db,
      payoutId: request.payoutId,
      amountUnits1e8: request.amountUnits1e8,
      unsignedEnvelopeXdr: built.unsignedEnvelopeXdr,
      txHashHex: built.txHashHex,
    });

    // Persist BROADCAST_PENDING + tx_hash + timebounds_max_unix BEFORE Horizon submission!
    await this.db
      .prepare(
        `UPDATE settlement_broadcasts
         SET state = 'BROADCAST_PENDING',
             tx_hash = ?,
             turnkey_activity_id = ?,
             updated_at = datetime('now')
         WHERE payout_id = ?`
      )
      .bind(stellarSig.txHash, stellarSig.activityId, request.payoutId)
      .run();

    try {
      const submitRes = await transport.submitSignedTransaction({
        signedEnvelopeXdr: stellarSig.signedEnvelopeXdr,
        signatureBase64: stellarSig.signatureBase64,
        expectedTxHash: stellarSig.txHash,
      });

      const finalState: SettlementBroadcastState = submitRes.confirmed
        ? 'CONFIRMED'
        : 'BROADCAST_PENDING';

      await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = ?,
               tx_hash = ?,
               error_reason = NULL,
               updated_at = datetime('now')
           WHERE payout_id = ?`
        )
        .bind(finalState, submitRes.txHash, request.payoutId)
        .run();

      return {
        payoutId: request.payoutId,
        chain: 'stellar',
        state: finalState,
        txHash: submitRes.txHash,
        stellarSequence,
        timeboundsMaxUnix,
        turnkeyActivityId: stellarSig.activityId,
      };
    } catch (submitErr: unknown) {
      const errMsg = submitErr instanceof Error ? submitErr.message : String(submitErr);

      await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'BROADCAST_PENDING',
               error_reason = ?,
               updated_at = datetime('now')
           WHERE payout_id = ?`
        )
        .bind(errMsg, request.payoutId)
        .run();

      return {
        payoutId: request.payoutId,
        chain: 'stellar',
        state: 'BROADCAST_PENDING',
        txHash: stellarSig.txHash,
        stellarSequence,
        timeboundsMaxUnix,
        turnkeyActivityId: stellarSig.activityId,
        uncertainBroadcast: true,
        reason: errMsg,
      };
    }
  }

  /**
   * Gate G8 Critical Recovery Entry Point:
   * Resolves uncertain `BROADCAST_PENDING` records after 504 Gateway Timeouts or network drops
   * with ZERO double-sends, ZERO duplicate nonce allocations, and strict Stellar TimeBounds(180s) enforcement.
   */
  async recoverUncertainBroadcast(
    payoutId: string,
    options?: RecoverBroadcastOptions
  ): Promise<RecoverBroadcastOutcome> {
    return this.getPayoutLock(payoutId).runExclusive(async () => {
      return this.recoverUncertainBroadcastLocked(payoutId, options);
    });
  }

  private async recoverUncertainBroadcastLocked(
    payoutId: string,
    options?: RecoverBroadcastOptions
  ): Promise<RecoverBroadcastOutcome> {
    const row = await this.getSettlementRecord(payoutId);
    if (!row) {
      throw new Error(`Settlement broadcast record not found: ${payoutId}`);
    }

    if (row.state === 'CONFIRMED') {
      return {
        payoutId: row.payout_id,
        chain: row.chain,
        state: 'CONFIRMED',
        action: 'ALREADY_CONFIRMED',
        txHash: row.tx_hash,
        assignedNonce: row.assigned_nonce,
        stellarSequence: row.stellar_sequence,
        timeboundsMaxUnix: row.timebounds_max_unix,
      };
    }

    if (row.state !== 'BROADCAST_PENDING') {
      return {
        payoutId: row.payout_id,
        chain: row.chain,
        state: row.state,
        action: 'NO_RECOVERY_NEEDED',
        txHash: row.tx_hash,
        assignedNonce: row.assigned_nonce,
        stellarSequence: row.stellar_sequence,
        timeboundsMaxUnix: row.timebounds_max_unix,
        reason: row.error_reason ?? undefined,
      };
    }

    const nowUnix = options?.nowUnix ?? this.nowUnixProvider();

    // ========================================================================
    // Branch 1: Stellar `BROADCAST_PENDING` Recovery
    // ========================================================================
    if (row.chain === 'stellar') {
      if (!this.stellarTransport) {
        throw new Error('Missing StellarBroadcastTransport for Stellar broadcast recovery');
      }
      if (!row.tx_hash) {
        throw new Error(`Stellar BROADCAST_PENDING record ${payoutId} missing tx_hash`);
      }

      let lookup: StellarHorizonTxLookupResult;
      try {
        lookup = await this.stellarTransport.lookupTransaction(row.tx_hash);
      } catch (lookupErr: unknown) {
        // Horizon query itself timed out: remain strictly locked in BROADCAST_PENDING
        return {
          payoutId: row.payout_id,
          chain: 'stellar',
          state: 'BROADCAST_PENDING',
          action: 'STILL_BROADCAST_PENDING',
          txHash: row.tx_hash,
          assignedNonce: null,
          stellarSequence: row.stellar_sequence,
          timeboundsMaxUnix: row.timebounds_max_unix,
          reason:
            lookupErr instanceof Error
              ? lookupErr.message
              : 'Horizon lookup failed during recovery',
        };
      }

      // 1a. Original tx landed on-chain despite 504! Reconcile to CONFIRMED (0 double-sends).
      if (lookup.found && lookup.successful) {
        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'CONFIRMED',
                 error_reason = NULL,
                 updated_at = datetime('now')
             WHERE payout_id = ?`
          )
          .bind(payoutId)
          .run();

        return {
          payoutId: row.payout_id,
          chain: 'stellar',
          state: 'CONFIRMED',
          action: 'RECONCILED_ON_CHAIN',
          txHash: row.tx_hash,
          assignedNonce: null,
          stellarSequence: row.stellar_sequence,
          timeboundsMaxUnix: row.timebounds_max_unix,
        };
      }

      if (lookup.found && !lookup.successful) {
        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'FAILED_ABORTED',
                 error_reason = 'Stellar transaction failed on-chain',
                 updated_at = datetime('now')
             WHERE payout_id = ?`
          )
          .bind(payoutId)
          .run();

        return {
          payoutId: row.payout_id,
          chain: 'stellar',
          state: 'FAILED_ABORTED',
          action: 'FAILED_ON_CHAIN_REVERTED',
          txHash: row.tx_hash,
          assignedNonce: null,
          stellarSequence: row.stellar_sequence,
          timeboundsMaxUnix: row.timebounds_max_unix,
          reason: 'Stellar transaction failed on-chain',
        };
      }

      // 1b. Not on Horizon yet: enforce TimeBounds(180s) invariant!
      const maxUnix = row.timebounds_max_unix ?? nowUnix + STELLAR_TIMEBOUNDS_SECONDS;
      if (nowUnix <= maxUnix) {
        // Refuse re-signing before TimeBounds expiry!
        return {
          payoutId: row.payout_id,
          chain: 'stellar',
          state: 'BROADCAST_PENDING',
          action: 'LOCKED_AWAITING_TIMEBOUNDS_EXPIRY',
          txHash: row.tx_hash,
          assignedNonce: null,
          stellarSequence: row.stellar_sequence,
          timeboundsMaxUnix: maxUnix,
          reason: `Stellar TimeBounds not yet expired (now=${nowUnix} <= maxTime=${maxUnix}); refusing premature re-sign`,
        };
      }

      // 1c. nowUnix > timebounds_max_unix AND verified absent on Horizon -> mark EXPIRED_RECOVERED
      const expiredReason = `Stellar TimeBounds expired (now=${nowUnix} > maxTime=${maxUnix}) and verified absent on Horizon`;
      await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'EXPIRED_RECOVERED',
               error_reason = ?,
               updated_at = datetime('now')
           WHERE payout_id = ?`
        )
        .bind(expiredReason, payoutId)
        .run();

      if (options?.reexecuteExpired) {
        const reexec = await this.executeSettlementLocked({
          payoutId: row.payout_id,
          idempotencyKey: row.idempotency_key,
          affiliateId: row.affiliate_id,
          chain: 'stellar',
          recipientAddress: row.recipient_address,
          amountUnits1e8: BigInt(row.amount_units_1e8),
          usdcReferencePriceUsd: options.usdcReferencePriceUsd,
          nowUnix,
        });

        return {
          payoutId: row.payout_id,
          chain: 'stellar',
          state: reexec.state,
          action: 'EXPIRED_AND_REEXECUTED',
          txHash: reexec.txHash ?? null,
          assignedNonce: null,
          stellarSequence: reexec.stellarSequence ?? null,
          timeboundsMaxUnix: reexec.timeboundsMaxUnix ?? null,
          reason: reexec.reason,
        };
      }

      return {
        payoutId: row.payout_id,
        chain: 'stellar',
        state: 'EXPIRED_RECOVERED',
        action: 'EXPIRED_RECOVERED',
        txHash: row.tx_hash,
        assignedNonce: null,
        stellarSequence: row.stellar_sequence,
        timeboundsMaxUnix: maxUnix,
        reason: expiredReason,
      };
    }

    // ========================================================================
    // Branch 2: EVM (`arbitrum` | `base`) `BROADCAST_PENDING` Recovery
    // ========================================================================
    const adapter = this.evmAdapters[row.chain];
    if (!adapter) {
      throw new Error(`Missing ArbitrumBaseUsdcAdapter for ${row.chain} recovery`);
    }
    if (!row.tx_hash || row.assigned_nonce === null || !row.signer_address) {
      throw new Error(
        `EVM BROADCAST_PENDING record ${payoutId} missing tx_hash, assigned_nonce, or signer_address`
      );
    }

    let receipt;
    let resolvedOnChainTxHash = row.tx_hash;
    try {
      receipt = await adapter.getTransactionReceipt(row.tx_hash);
      if (
        !receipt.found &&
        typeof row.rbf_candidate_tx_hash === 'string' &&
        row.rbf_candidate_tx_hash.length > 0 &&
        row.rbf_candidate_tx_hash !== row.tx_hash
      ) {
        const rbfReceipt = await adapter.getTransactionReceipt(row.rbf_candidate_tx_hash);
        if (rbfReceipt.found) {
          receipt = rbfReceipt;
          resolvedOnChainTxHash = row.rbf_candidate_tx_hash;
        }
      }
    } catch (receiptErr: unknown) {
      return {
        payoutId: row.payout_id,
        chain: row.chain,
        state: 'BROADCAST_PENDING',
        action: 'STILL_BROADCAST_PENDING',
        txHash: row.tx_hash,
        assignedNonce: row.assigned_nonce,
        stellarSequence: null,
        timeboundsMaxUnix: null,
        reason:
          receiptErr instanceof Error ? receiptErr.message : 'EVM receipt lookup failed',
      };
    }

    // 2a. Original or RBF tx landed and succeeded on-chain despite 504! Reconcile to CONFIRMED.
    if (receipt.found && receipt.confirmed) {
      await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'CONFIRMED',
               tx_hash = ?,
               error_reason = NULL,
               updated_at = datetime('now')
           WHERE payout_id = ?`
        )
        .bind(resolvedOnChainTxHash, payoutId)
        .run();

      return {
        payoutId: row.payout_id,
        chain: row.chain,
        state: 'CONFIRMED',
        action: 'RECONCILED_ON_CHAIN',
        txHash: resolvedOnChainTxHash,
        assignedNonce: row.assigned_nonce,
        stellarSequence: null,
        timeboundsMaxUnix: null,
      };
    }

    if (receipt.found && receipt.reverted) {
      await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'FAILED_ABORTED',
               tx_hash = ?,
               error_reason = 'EVM transaction reverted on-chain (status 0x0)',
               updated_at = datetime('now')
           WHERE payout_id = ?`
        )
        .bind(resolvedOnChainTxHash, payoutId)
        .run();

      return {
        payoutId: row.payout_id,
        chain: row.chain,
        state: 'FAILED_ABORTED',
        action: 'FAILED_ON_CHAIN_REVERTED',
        txHash: resolvedOnChainTxHash,
        assignedNonce: row.assigned_nonce,
        stellarSequence: null,
        timeboundsMaxUnix: null,
        reason: 'EVM transaction reverted on-chain (status 0x0)',
      };
    }

    // 2b. Receipt not found: inspect on-chain confirmed nonce for signer_address
    const confirmedNonce = await adapter.getTransactionCount(row.signer_address, 'latest');

    if (confirmedNonce <= row.assigned_nonce) {
      // NEVER increment signer_nonces.next_nonce! Reuse the EXACT SAME assigned_nonce!
      // Read persisted `signed_raw_tx` from D1 when recovering across stateless Worker isolates.
      const cachedSignedRawTx =
        this.signedEvmRawTxCache.get(payoutId) ??
        (typeof row.signed_raw_tx === 'string' && row.signed_raw_tx.startsWith('0x')
          ? (row.signed_raw_tx as Hex)
          : undefined);

      if (cachedSignedRawTx && !options?.bumpGasRbf) {
        try {
          const rebroadcastHash = await adapter.broadcastSignedTransaction(cachedSignedRawTx);
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'CONFIRMED',
                   tx_hash = ?,
                   error_reason = NULL,
                   updated_at = datetime('now')
               WHERE payout_id = ?`
            )
            .bind(rebroadcastHash, payoutId)
            .run();

          return {
            payoutId: row.payout_id,
            chain: row.chain,
            state: 'CONFIRMED',
            action: 'EVM_REBROADCAST_SAME_NONCE_CONFIRMED',
            txHash: rebroadcastHash,
            assignedNonce: row.assigned_nonce,
            stellarSequence: null,
            timeboundsMaxUnix: null,
          };
        } catch (rebroadcastErr: unknown) {
          // Check if another node already mined it right as we rebroadcast ("already known" / "nonce too low")
          const checkAgain = await adapter.getTransactionReceipt(row.tx_hash).catch(() => null);
          if (checkAgain?.found && checkAgain.confirmed) {
            await this.db
              .prepare(
                `UPDATE settlement_broadcasts
                 SET state = 'CONFIRMED',
                     error_reason = NULL,
                     updated_at = datetime('now')
                 WHERE payout_id = ?`
              )
              .bind(payoutId)
              .run();

            return {
              payoutId: row.payout_id,
              chain: row.chain,
              state: 'CONFIRMED',
              action: 'RECONCILED_ON_CHAIN',
              txHash: row.tx_hash,
              assignedNonce: row.assigned_nonce,
              stellarSequence: null,
              timeboundsMaxUnix: null,
            };
          }

          const errMsg =
            rebroadcastErr instanceof Error
              ? rebroadcastErr.message
              : String(rebroadcastErr);
          return {
            payoutId: row.payout_id,
            chain: row.chain,
            state: 'BROADCAST_PENDING',
            action: 'STILL_BROADCAST_PENDING',
            txHash: row.tx_hash,
            assignedNonce: row.assigned_nonce,
            stellarSequence: null,
            timeboundsMaxUnix: null,
            reason: errMsg,
          };
        }
      }

      // RBF path: build replacement transfer reusing EXACT SAME `row.assigned_nonce` (+15% fee bump)
      const rbfEnvelope = await adapter.buildUnsignedTransfer({
        recipientAddress: row.recipient_address,
        amountUnits1e8: BigInt(row.amount_units_1e8),
        assignedNonce: row.assigned_nonce,
        feeBumpBasisPoints: 1500,
      });

      const rbfSig = await this.turnkeySigner.signEvmDigestEnforced({
        db: this.db,
        payoutId: row.payout_id,
        chain: row.chain,
        amountUnits1e8: BigInt(row.amount_units_1e8),
        digestHex: rbfEnvelope.signingDigestHex,
      });

      const rbfAssembled = adapter.assembleSignedTransaction(rbfEnvelope, rbfSig);
      this.signedEvmRawTxCache.set(payoutId, rbfAssembled.signedRawTxHex);

      // Persist RBF candidate hash in `rbf_candidate_tx_hash` WITHOUT overwriting original `tx_hash`
      // so if the original tx mines right as RBF fails/times out, next recovery still finds `row.tx_hash`!
      await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET rbf_candidate_tx_hash = ?,
               signed_raw_tx = ?,
               turnkey_activity_id = ?,
               updated_at = datetime('now')
           WHERE payout_id = ? AND assigned_nonce = ?`
        )
        .bind(
          rbfAssembled.txHash,
          rbfAssembled.signedRawTxHex,
          rbfSig.activityId,
          payoutId,
          row.assigned_nonce
        )
        .run();

      try {
        const rbfHash = await adapter.broadcastSignedTransaction(rbfAssembled.signedRawTxHex);
        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'CONFIRMED',
                 tx_hash = ?,
                 rbf_candidate_tx_hash = ?,
                 error_reason = NULL,
                 updated_at = datetime('now')
             WHERE payout_id = ?`
          )
          .bind(rbfHash, rbfAssembled.txHash, payoutId)
          .run();

        return {
          payoutId: row.payout_id,
          chain: row.chain,
          state: 'CONFIRMED',
          action: 'EVM_RBF_SAME_NONCE_CONFIRMED',
          txHash: rbfHash,
          assignedNonce: row.assigned_nonce,
          stellarSequence: null,
          timeboundsMaxUnix: null,
        };
      } catch (rbfErr: unknown) {
        // Check if original `row.tx_hash` mined first ("nonce too low" / "replacement transaction underpriced")
        const origCheck = await adapter.getTransactionReceipt(row.tx_hash).catch(() => null);
        if (origCheck?.found && origCheck.confirmed) {
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'CONFIRMED',
                   tx_hash = ?,
                   error_reason = NULL,
                   updated_at = datetime('now')
               WHERE payout_id = ?`
            )
            .bind(row.tx_hash, payoutId)
            .run();

          return {
            payoutId: row.payout_id,
            chain: row.chain,
            state: 'CONFIRMED',
            action: 'RECONCILED_ON_CHAIN',
            txHash: row.tx_hash,
            assignedNonce: row.assigned_nonce,
            stellarSequence: null,
            timeboundsMaxUnix: null,
          };
        }

        const errMsg = rbfErr instanceof Error ? rbfErr.message : String(rbfErr);
        return {
          payoutId: row.payout_id,
          chain: row.chain,
          state: 'BROADCAST_PENDING',
          action: 'STILL_BROADCAST_PENDING',
          txHash: row.tx_hash,
          assignedNonce: row.assigned_nonce,
          stellarSequence: null,
          timeboundsMaxUnix: null,
          reason: errMsg,
        };
      }
    }

    // confirmedNonce > row.assigned_nonce while receipt for row.tx_hash was absent -> nonce replaced externally
    return {
      payoutId: row.payout_id,
      chain: row.chain,
      state: 'BROADCAST_PENDING',
      action: 'STILL_BROADCAST_PENDING',
      txHash: row.tx_hash,
      assignedNonce: row.assigned_nonce,
      stellarSequence: null,
      timeboundsMaxUnix: null,
      reason: `Signer confirmed nonce (${confirmedNonce}) advanced past assigned_nonce (${row.assigned_nonce}); manual audit required before re-dispatch`,
    };
  }

  /**
   * Resolves a Safe{Wallet} 2-of-3 `QUEUED_COLD_SAFE` broadcast record once the cold multisig
   * transaction is either confirmed on-chain (`CONFIRMED` + `txHash`) or cancelled (`FAILED_ABORTED`).
   */
  async resolveColdSafeBroadcast(params: {
    payoutId: string;
    resolution: 'CONFIRMED' | 'CANCELLED';
    txHash?: string;
    reason?: string;
  }): Promise<SettlementBroadcastRow> {
    return this.getPayoutLock(params.payoutId).runExclusive(async () => {
      const row = await this.getSettlementRecord(params.payoutId);
      if (!row) {
        throw new Error(`Settlement broadcast record not found: ${params.payoutId}`);
      }

      if (params.resolution === 'CONFIRMED') {
        const cleanHash = (params.txHash ?? '').trim();
        if (!cleanHash) {
          throw new Error('txHash is required to confirm a QUEUED_COLD_SAFE payout');
        }
        if (row.state === 'CONFIRMED' && row.tx_hash === cleanHash) {
          return row;
        }
        if (row.state !== 'QUEUED_COLD_SAFE') {
          throw new Error(
            `Cannot confirm cold Safe payout ${params.payoutId} from state ${row.state}`
          );
        }
        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'CONFIRMED',
                 tx_hash = ?,
                 error_reason = NULL,
                 updated_at = datetime('now')
             WHERE payout_id = ? AND state = 'QUEUED_COLD_SAFE'`
          )
          .bind(cleanHash, params.payoutId)
          .run();
      } else {
        const cancelReason = (params.reason ?? 'Safe 2-of-3 cold multisig proposal cancelled').trim();
        if (row.state === 'FAILED_ABORTED') {
          return row;
        }
        if (row.state !== 'QUEUED_COLD_SAFE') {
          throw new Error(
            `Cannot cancel cold Safe payout ${params.payoutId} from state ${row.state}`
          );
        }
        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'FAILED_ABORTED',
                 error_reason = ?,
                 updated_at = datetime('now')
             WHERE payout_id = ? AND state = 'QUEUED_COLD_SAFE'`
          )
          .bind(cancelReason, params.payoutId)
          .run();
      }

      const updated = await this.getSettlementRecord(params.payoutId);
      if (!updated) {
        throw new Error(`Settlement broadcast record ${params.payoutId} missing after cold resolution`);
      }
      return updated;
    });
  }
}
