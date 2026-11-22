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
 *   3. On Stellar: refuses re-signing while `nowUnix <= timebounds_max_unix` (180s); keeps
 *      unresolved submissions pending even after local expiry.
 *   4. On EVM: if unmined and `confirmedNonce <= assigned_nonce`, re-broadcasts the SAME signed raw tx
 *      or builds an RBF replacement reusing the EXACT SAME `assigned_nonce`.
 */

import Decimal from 'decimal.js';
import type { Hex } from 'viem';
import type { D1Database } from '../db';
import type { SanctionsScreeningService } from '../compliance/sanctions-service';
import { DoubleEntryLedgerService, type LedgerJournalBatchRecord } from '../ledger/double-entry-ledger';
import { ledgerUnitsToChainUnits } from '../ledger/units';
import {
  EVM_USDC_DECIMALS,
  type ArbitrumBaseUsdcAdapter,
  type EvmPhase1SettlementChain,
  type Phase1SettlementChain,
} from './adapters/arbitrum-base-usdc-adapter';
import {
  STELLAR_TIMEBOUNDS_SECONDS,
  STELLAR_USDC_DECIMALS,
  fromStellarStroops,
  sanitizeStellarDiagnosticError,
} from './stellar-service';
import { hasAdmittedPayoutEffect, isPayoutEffectBlockedError, PayoutEffectBlockedError, withPayoutWorkflow, type PayoutWorkflow } from './payout-effect-fence';
import { normalizeColdTxHash, selectColdPaymentTransfer, type ColdPaymentEvidence } from './cold-payment-evidence';
import { TurnkeySigner, isTurnkeyUncertainOutcomeError } from './turnkey-signer';
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
  candidate_tx_hashes?: string | null;
  lock_batch_id?: string | null;
  turnkey_activity_id: string | null;
  safe_multisig_tx_hash: string | null;
  confirmation_lane?: string | null;
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
    db: D1Database;
    payoutId: string;
    effect: 'STELLAR_SUBMIT';
    workflow?: PayoutWorkflow;
    signedEnvelopeXdr: string;
    signatureBase64: string;
    expectedTxHash: string;
  }): Promise<{ txHash: string; confirmed: boolean }>;
  lookupTransaction(txHash: string): Promise<StellarHorizonTxLookupResult>;
  readonly coldPaymentNetwork?: string;
  readonly coldPaymentAsset?: string;
  getColdPaymentEvidence?(txHash: string): Promise<ColdPaymentEvidence>;
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
  residualDustUnits1e8?: string;
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
  | 'FAILED_PRE_BROADCAST_ABORTED'
  | 'NO_RECOVERY_NEEDED';

export interface RecoverBroadcastOptions {
  nowUnix?: number;
  bumpGasRbf?: boolean;
  reexecuteExpired?: boolean;
  /**
   * Strictly passive observation mode for unattended cron reconciliation:
   * inspects on-chain receipts and Stellar TimeBounds only, NEVER calling
   * `broadcastSignedTransaction`, `submitSignedTransaction`, or Turnkey HSM signing,
   * and NEVER aborting active `SIGNING` claims.
   */
  passiveOnly?: boolean;
  /** @deprecated Elapsed time never authorizes reclaiming an unresolved signing claim. */
  signingStaleTimeoutSeconds?: number;
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

export const SIGNING_STALE_ABORT_AFTER_SECONDS = 300;

function isTurnkeyHotPolicyBlockError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('turnkey policy hard-block');
}

function collectCandidateHashes(
  row: Pick<SettlementBroadcastRow, 'tx_hash' | 'rbf_candidate_tx_hash' | 'candidate_tx_hashes'>,
  extraHashes: Array<string | null | undefined> = []
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  const pushHash = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(trimmed);
    }
  };

  pushHash(row.tx_hash);
  pushHash(row.rbf_candidate_tx_hash);
  if (typeof row.candidate_tx_hashes === 'string' && row.candidate_tx_hashes.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(row.candidate_tx_hashes) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          pushHash(item);
        }
      }
    } catch {
      // Ignore malformed historical JSON; primary tx_hash + rbf_candidate_tx_hash remain intact
    }
  }
  for (const h of extraHashes) {
    pushHash(h);
  }
  return ordered;
}

const MAX_SANITIZED_ERROR_LEN = 400;

/**
 * Redacts Stellar secret seeds, EVM private keys, Turnkey/API keys, Bearer tokens,
 * and URL credentials/API-key query parameters before persisting error diagnostics
 * into `settlement_broadcasts.error_reason` or returning them to API callers.
 */
export function sanitizeSettlementErrorMessage(
  err: unknown,
  fallback = 'Settlement operation failed'
): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '');
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  let sanitized = sanitizeStellarDiagnosticError(trimmed)
    // Redact Bearer / Basic auth headers
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    // Redact labeled secrets / private keys / API keys / tokens
    .replace(
      /\b((?:TURNKEY|STELLAR|EVM|RPC|ALCHEMY|INFURA|API|PRIVATE|SECRET|AUTH|SIGNER)[A-Z0-9_]*\s*[=:]\s*)([^\s,;'"`]+)/gi,
      '$1[REDACTED]'
    )
    // Redact URL embedded credentials (https://user:pass@host)
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1[REDACTED]:[REDACTED]@')
    // Redact sensitive URL query params (?apiKey=..., ?key=..., ?token=...)
    .replace(/([?&](?:api[_-]?key|key|token|secret|auth)=)([^&\s]+)/gi, '$1[REDACTED]')
    // Redact 64-hex raw private keys when paired with private/secret/key context
    .replace(/(private[_ -]?key\s*[:=]?\s*)(0x)?[a-f0-9]{64}\b/gi, '$1[REDACTED]');

  if (sanitized.length > MAX_SANITIZED_ERROR_LEN) {
    sanitized = `${sanitized.slice(0, MAX_SANITIZED_ERROR_LEN)}...`;
  }
  return sanitized;
}

interface ColdPaymentClaim {
  payout_id: string;
  lock_batch_id: string;
  chain: Phase1SettlementChain;
  network: string;
  tx_hash: string;
  operation_id: string;
  source_address: string;
  recipient_address: string;
  amount_token_units: string;
}

const normalizeColdAddress = (chain: Phase1SettlementChain, value: string): string =>
  chain === 'stellar' ? value : value.toLowerCase();

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
          if (!ins.meta || typeof ins.meta.changes !== 'number' || ins.meta.changes === 1) {
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
   * Reclaims an unbroadcast EVM nonce or 64-bit Stellar sequence via strict top-of-counter CAS
   * (`WHERE next_nonce = assignedNonce + 1` or `WHERE next_sequence_text = (assignedSeq + 1)`).
   * Only rolls back the counter if no subsequent transaction allocated a higher nonce/sequence,
   * preventing nonce gaps when pre-signing construction or HSM signing fails before broadcast.
   */
  private async reclaimPreBroadcastNonceOrSequence(params: {
    chain: Phase1SettlementChain;
    signerAddress: string | null;
    assignedNonce?: number | null;
    stellarSequence?: string | null;
  }): Promise<void> {
    if (!params.signerAddress) {
      return;
    }
    try {
      if (
        (params.chain === 'arbitrum' || params.chain === 'base') &&
        typeof params.assignedNonce === 'number' &&
        params.assignedNonce >= 0
      ) {
        await this.db
          .prepare(
            `UPDATE signer_nonces
             SET next_nonce = ?, updated_at = datetime('now')
             WHERE chain = ? AND signer_address = ? AND next_nonce = ?`
          )
          .bind(
            params.assignedNonce,
            params.chain,
            params.signerAddress,
            params.assignedNonce + 1
          )
          .run();
        return;
      }

      if (params.chain === 'stellar' && typeof params.stellarSequence === 'string') {
        const assignedSeq = BigInt(params.stellarSequence);
        const expectedTopText = (assignedSeq + BigInt(1)).toString();
        const rollbackText = assignedSeq.toString();
        const safeMirror =
          assignedSeq <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(assignedSeq) : 0;
        await this.db
          .prepare(
            `UPDATE signer_nonces
             SET next_nonce = ?, next_sequence_text = ?, updated_at = datetime('now')
             WHERE chain = 'stellar' AND signer_address = ? AND next_sequence_text = ?`
          )
          .bind(safeMirror, rollbackText, params.signerAddress, expectedTopText)
          .run();
      }
    } catch {
      // Best-effort CAS rollback; if a concurrent tx already took N+1, on-chain recovery handles N
    }
  }

  private async lookupAnyCandidateEvmReceipt(
    adapter: ArbitrumBaseUsdcAdapter,
    candidateHashes: readonly string[]
  ): Promise<{
    found: boolean;
    confirmed: boolean;
    reverted: boolean;
    blockNumber?: number;
    finalized?: boolean;
    matchedTxHash: string | null;
  }> {
    for (const candidateHash of candidateHashes) {
      const receipt = await adapter.getTransactionReceipt(candidateHash);
      if (receipt.found) {
        return {
          found: true,
          confirmed: receipt.confirmed,
          reverted: receipt.reverted,
          blockNumber: receipt.blockNumber,
          finalized: receipt.finalized,
          matchedTxHash: candidateHash,
        };
      }
    }
    return {
      found: false,
      confirmed: false,
      reverted: false,
      matchedTxHash: candidateHashes[0] ?? null,
    };
  }

  /**
   * Execute a Phase 1 settlement payout with full pre-signing safety guards,
   * Turnkey HSM policy isolation, and `BROADCAST_PENDING` lock guarantees.
   */
  async executeSettlement(
    request: ExecuteSettlementRequest
  ): Promise<ExecuteSettlementOutcome> {
    return this.getPayoutLock(request.payoutId).runExclusive(async () => {
      return withPayoutWorkflow(this.db, request.payoutId, (workflow) => this.executeSettlementLocked(request, workflow));
    });
  }

  private mapExistingRecordToOutcome(
    existing: SettlementBroadcastRow
  ): ExecuteSettlementOutcome | null {
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
          existing.state === 'SIGNING'
            ? 'Payout has an active or unresolved SIGNING claim; refusing to allocate a duplicate nonce/sequence'
            : 'Payout is locked in BROADCAST_PENDING; invoke recoverUncertainBroadcast instead of allocating a duplicate nonce/sequence',
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

    // The signer independently requires durable release proof before any replacement claim.
    return null;
  }

  private async executeSettlementLocked(
    request: ExecuteSettlementRequest,
    workflow: PayoutWorkflow
  ): Promise<ExecuteSettlementOutcome> {
    const nowUnix = request.nowUnix ?? this.nowUnixProvider();
    const referencePrice = request.usdcReferencePriceUsd ?? this.defaultUsdcPriceUsd;

    // Step 0: Check existing settlement_broadcasts record first!
    // Gate G8 Invariant: NEVER re-allocate nonce or re-sign an unresolved BROADCAST_PENDING record!
    const existing = await this.getSettlementRecord(request.payoutId);
    if (existing) {
      const existingOutcome = this.mapExistingRecordToOutcome(existing);
      if (existingOutcome) {
        return existingOutcome;
      }
    }

    // Step 0b: Align requested 10^-8 ledger units to the target chain's native USDC precision
    // (Stellar 7dp -> divisor 10; Arbitrum/Base 6dp -> divisor 100) so residual sub-chain dust
    // is never burned or silently locked into settlement_broadcasts.
    const requestedChainNormalized = String(request.chain).trim().toLowerCase();
    const preChainConversion =
      requestedChainNormalized === 'stellar' ||
      requestedChainNormalized === 'arbitrum' ||
      requestedChainNormalized === 'base'
        ? ledgerUnitsToChainUnits(request.amountUnits1e8, requestedChainNormalized)
        : null;
    const disbursableUnits1e8 = preChainConversion
      ? request.amountUnits1e8 - preChainConversion.residualDust1e8
      : request.amountUnits1e8;
    const residualDustUnits1e8 = preChainConversion
      ? preChainConversion.residualDust1e8
      : BigInt(0);

    // Step 1: Run all pre-signing safety guards (Phase 1 chain gate, peg band, $10 floor,
    // OFAC sanctions, Circle isBlacklisted + eth_call OR Stellar existing USDC trustline).
    const verdict = await assertPreSigningSafetyGuards({
      db: this.db,
      chain: request.chain,
      recipientAddress: request.recipientAddress,
      amountUnits1e8: disbursableUnits1e8,
      usdcReferencePriceUsd: referencePrice,
      sanctionsService: this.sanctionsService,
      evmAdapters: this.evmAdapters,
      stellarTrustlineVerifier: this.stellarTransport,
    });

    const chain = verdict.chain;
    const chainConversion =
      preChainConversion ?? ledgerUnitsToChainUnits(disbursableUnits1e8, chain);
    const chainDecimals: 6 | 7 =
      chain === 'stellar' ? STELLAR_USDC_DECIMALS : EVM_USDC_DECIMALS;
    const chainTokenUnitsBig = chainConversion.chainUnits;
    const chainTokenUnits = chainTokenUnitsBig.toString();

    // Step 2: Serialized intra-isolate queue + cross-isolate atomic D1 `SIGNING` budget claim
    // (`<= $250/tx` and `<= $1,500/24h` rolling hot-wallet cap) BEFORE reserving any EVM nonce /
    // Stellar sequence or calling Turnkey HSM, followed by durable `BROADCAST_PENDING` persistence.
    const prepared = await this.reservationMutex.runExclusive(async () => {
      const slotClaim = await this.turnkeySigner.claimHotWalletSigningSlot(this.db, {
        payoutId: request.payoutId,
        idempotencyKey: request.idempotencyKey,
        affiliateId: request.affiliateId,
        chain,
        recipientAddress: verdict.recipientAddress,
        amountUnits1e8: disbursableUnits1e8,
        chainTokenUnits,
        chainDecimals,
        lockBatchId: request.lockBatchId ?? null,
      });

      if (!slotClaim.claimed) {
        if (slotClaim.violationCode === 'WITHDRAWAL_LOCK_NOT_INFLIGHT') {
          throw new Error(
            slotClaim.reason ??
              `Payout ${request.payoutId} withdrawal lock is already resolved; refusing to settle again`
          );
        }

        if (slotClaim.violationCode === 'CONCURRENT_PAYOUT_ACTIVE') {
          const concurrentRecord = await this.getSettlementRecord(request.payoutId);
          const concurrentOutcome = concurrentRecord
            ? this.mapExistingRecordToOutcome(concurrentRecord)
            : null;
          if (concurrentOutcome) {
            return {
              kind: 'existing' as const,
              outcome: concurrentOutcome,
            };
          }
        }

        const coldQueued = await this.turnkeySigner.enqueueColdSafeMultisig(this.db, {
          payoutId: request.payoutId,
          idempotencyKey: request.idempotencyKey,
          affiliateId: request.affiliateId,
          chain,
          recipientAddress: verdict.recipientAddress,
          amountUnits1e8: disbursableUnits1e8,
          chainTokenUnits,
          chainDecimals,
          lockBatchId: request.lockBatchId ?? null,
          reason: slotClaim.reason,
        });

        // Cross-isolate race guard: if a concurrent isolate claimed `SIGNING` / `BROADCAST_PENDING` /
        // `CONFIRMED` between `claimHotWalletSigningSlot` and `enqueueColdSafeMultisig`, the conditional
        // `WHERE state IN ('EXPIRED_RECOVERED', 'FAILED_ABORTED', 'QUEUED_COLD_SAFE')` clause prevented
        // clobbering the active row; return that active outcome rather than reporting a phantom cold queue.
        const postColdRecord = await this.getSettlementRecord(request.payoutId);
        if (postColdRecord && postColdRecord.state !== 'QUEUED_COLD_SAFE') {
          const postColdOutcome = this.mapExistingRecordToOutcome(postColdRecord);
          if (postColdOutcome) {
            return {
              kind: 'existing' as const,
              outcome: postColdOutcome,
            };
          }
        }

        return {
          kind: 'cold' as const,
          coldQueued,
        };
      }

      const { signerAddress } = slotClaim;

      if (chain === 'arbitrum' || chain === 'base') {
        let assignedNonce: number | null = null;
        let lostSigningOwnership = false;
        try {
          const adapter = this.evmAdapters[chain];
          if (!adapter) {
            throw new Error(`Missing ArbitrumBaseUsdcAdapter for ${chain}`);
          }

          assignedNonce = await this.reserveEvmNonce(chain, adapter, signerAddress);

          const nonceUpd = await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET assigned_nonce = ?,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'SIGNING'`
            )
            .bind(assignedNonce, request.payoutId)
            .run();
          if (typeof nonceUpd.meta?.changes === 'number' && nonceUpd.meta.changes !== 1) {
            lostSigningOwnership = true;
            throw new Error(
              `Lost SIGNING ownership for payout ${request.payoutId} before persisting assigned EVM nonce`
            );
          }

          const envelope = await adapter.buildUnsignedTransfer({
            recipientAddress: verdict.recipientAddress,
            amountUnits1e8: disbursableUnits1e8,
            assignedNonce,
          });

          const sig = await this.turnkeySigner.signEvmDigestEnforced({
            workflow,
            db: this.db,
            payoutId: request.payoutId,
            chain,
            amountUnits1e8: disbursableUnits1e8,
            digestHex: envelope.signingDigestHex,
            assignedNonce,
          });

          const assembled = adapter.assembleSignedTransaction(envelope, sig);
          const candidateJson = JSON.stringify([assembled.txHash]);

          // Persist BROADCAST_PENDING + tx_hash + signed_raw_tx BEFORE calling eth_sendRawTransaction!
          const pendingUpd = await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'BROADCAST_PENDING',
                   tx_hash = ?,
                   signed_raw_tx = ?,
                   candidate_tx_hashes = ?,
                   turnkey_activity_id = ?,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'SIGNING'`
            )
            .bind(
              assembled.txHash,
              assembled.signedRawTxHex,
              candidateJson,
              sig.activityId,
              request.payoutId
            )
            .run();
          if (typeof pendingUpd.meta?.changes === 'number' && pendingUpd.meta.changes !== 1) {
            lostSigningOwnership = true;
            throw new Error(
              `Lost SIGNING ownership for payout ${request.payoutId} before persisting BROADCAST_PENDING state`
            );
          }

          this.signedEvmRawTxCache.set(request.payoutId, assembled.signedRawTxHex);

          return {
            kind: 'evm' as const,
            chain,
            adapter,
            assignedNonce,
            txHash: assembled.txHash,
            signedRawTxHex: assembled.signedRawTxHex,
            activityId: sig.activityId,
          };
        } catch (preBroadcastErr: unknown) {
          // Persist diagnostic Turnkey activityId if wrapped inside PayoutEffectBlockedError.cause
          const underlyingHsmErr =
            isTurnkeyUncertainOutcomeError(preBroadcastErr)
              ? preBroadcastErr
              : isPayoutEffectBlockedError(preBroadcastErr) &&
                  isTurnkeyUncertainOutcomeError(preBroadcastErr.cause)
                ? preBroadcastErr.cause
                : null;
          if (underlyingHsmErr?.activityId) {
            await this.db
              .prepare(
                `UPDATE settlement_broadcasts
                 SET turnkey_activity_id = COALESCE(turnkey_activity_id, ?),
                     error_reason = COALESCE(error_reason, ?),
                     updated_at = datetime('now')
                 WHERE payout_id = ? AND state = 'SIGNING'`
              )
              .bind(
                underlyingHsmErr.activityId,
                sanitizeSettlementErrorMessage(underlyingHsmErr, 'Turnkey HSM outcome uncertain'),
                request.payoutId
              )
              .run()
              .catch(() => undefined);
          }
          // Never reclaim after a signature was admitted or when HSM outcome is uncertain.
          if (isTurnkeyUncertainOutcomeError(preBroadcastErr)) throw preBroadcastErr;
          if (isPayoutEffectBlockedError(preBroadcastErr)) throw preBroadcastErr;
          if (hasAdmittedPayoutEffect(workflow)) throw new PayoutEffectBlockedError('admitted signature not durably recorded');
          this.signedEvmRawTxCache.delete(request.payoutId);

          if (!lostSigningOwnership && assignedNonce !== null) {
            await this.reclaimPreBroadcastNonceOrSequence({
              chain,
              signerAddress,
              assignedNonce,
            });
          }

          if (!lostSigningOwnership && isTurnkeyHotPolicyBlockError(preBroadcastErr)) {
            const coldQueued = await this.turnkeySigner.enqueueColdSafeMultisig(this.db, {
              payoutId: request.payoutId,
              idempotencyKey: request.idempotencyKey,
              affiliateId: request.affiliateId,
              chain,
              recipientAddress: verdict.recipientAddress,
              amountUnits1e8: disbursableUnits1e8,
              chainTokenUnits,
              chainDecimals,
              lockBatchId: request.lockBatchId ?? null,
              preSubmissionWorkflow: workflow,
              reason:
                preBroadcastErr instanceof Error
                  ? sanitizeSettlementErrorMessage(preBroadcastErr)
                  : 'Routed to Safe{Wallet} 2-of-3 cold multisig due to hot-wallet policy cap',
            });
            return {
              kind: 'cold' as const,
              coldQueued,
            };
          }

          const preErrMsg = sanitizeSettlementErrorMessage(
            preBroadcastErr,
            'Pre-broadcast EVM signing failed'
          );
          if (lostSigningOwnership) throw preBroadcastErr;
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'FAILED_ABORTED',
                   exposure_release_kind = 'PRE_SUBMISSION_ABORT',
                   exposure_released_at = unixepoch('now'),
                   exposure_release_attempt_id = ?,
                   assigned_nonce = NULL,
                   tx_hash = NULL,
                   signed_raw_tx = NULL,
                   error_reason = ?,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'SIGNING'
               AND EXISTS (SELECT 1 FROM payout_effect_attempts a
                 WHERE a.attempt_id = ? AND a.payout_id = settlement_broadcasts.payout_id
                   AND a.lock_batch_id IS settlement_broadcasts.lock_batch_id
                   AND a.owner_id = settlement_broadcasts.affiliate_id AND a.active = 1
                   AND NOT EXISTS (SELECT 1 FROM payout_effect_grants g WHERE g.attempt_id = a.attempt_id))`
            )
            .bind(workflow.attemptId, preErrMsg, request.payoutId, workflow.attemptId)
            .run();
          throw preBroadcastErr;
        }
      }

      let stellarSequence: string | null = null;
      let lostStellarSigningOwnership = false;
      try {
        if (!this.stellarTransport) {
          throw new Error('Missing StellarBroadcastTransport for Stellar settlement');
        }

        const transport = this.stellarTransport;
        stellarSequence = await this.reserveStellarSequence(
          transport,
          signerAddress
        );
        const timeboundsMaxUnix = nowUnix + STELLAR_TIMEBOUNDS_SECONDS;

        const seqUpd = await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET stellar_sequence = ?,
                 timebounds_max_unix = ?,
                 updated_at = datetime('now')
             WHERE payout_id = ? AND state = 'SIGNING'`
          )
          .bind(stellarSequence, timeboundsMaxUnix, request.payoutId)
          .run();
        if (typeof seqUpd.meta?.changes === 'number' && seqUpd.meta.changes !== 1) {
          lostStellarSigningOwnership = true;
          throw new Error(
            `Lost SIGNING ownership for payout ${request.payoutId} before persisting Stellar sequence`
          );
        }

        const amountFormatted7 = fromStellarStroops(chainTokenUnitsBig);
        const built = await transport.buildUnsignedUsdcPayment({
          fromAccount: signerAddress,
          recipientAddress: verdict.recipientAddress,
          stellarSequence,
          amountStroops: chainTokenUnitsBig,
          amountFormatted7,
          timeboundsMaxUnix,
          memo: request.memo ?? request.idempotencyKey.slice(0, 28),
        });

        const stellarSig = await this.turnkeySigner.signStellarEnvelopeEnforced({
          workflow,
          db: this.db,
          payoutId: request.payoutId,
          amountUnits1e8: disbursableUnits1e8,
          unsignedEnvelopeXdr: built.unsignedEnvelopeXdr,
          stellarSequence,
          txHashHex: built.txHashHex,
        });

        // Persist BROADCAST_PENDING + tx_hash + signed_raw_tx BEFORE Horizon submission!
        const pendingUpd = await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'BROADCAST_PENDING',
                 tx_hash = ?,
                 signed_raw_tx = ?,
                 candidate_tx_hashes = ?,
                 turnkey_activity_id = ?,
                 updated_at = datetime('now')
             WHERE payout_id = ? AND state = 'SIGNING'`
          )
          .bind(
            stellarSig.txHash,
            stellarSig.signedEnvelopeXdr,
            JSON.stringify([stellarSig.txHash]),
            stellarSig.activityId,
            request.payoutId
          )
          .run();
        if (typeof pendingUpd.meta?.changes === 'number' && pendingUpd.meta.changes !== 1) {
          lostStellarSigningOwnership = true;
          throw new Error(
            `Lost SIGNING ownership for payout ${request.payoutId} before persisting Stellar BROADCAST_PENDING state`
          );
        }

        return {
          kind: 'stellar' as const,
          transport,
          stellarSequence,
          timeboundsMaxUnix,
          stellarSig,
        };
      } catch (preBroadcastErr: unknown) {
        // Persist diagnostic Turnkey activityId if wrapped inside PayoutEffectBlockedError.cause
        const underlyingStellarHsmErr =
          isTurnkeyUncertainOutcomeError(preBroadcastErr)
            ? preBroadcastErr
            : isPayoutEffectBlockedError(preBroadcastErr) &&
                isTurnkeyUncertainOutcomeError(preBroadcastErr.cause)
              ? preBroadcastErr.cause
              : null;
        if (underlyingStellarHsmErr?.activityId) {
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET turnkey_activity_id = COALESCE(turnkey_activity_id, ?),
                   error_reason = COALESCE(error_reason, ?),
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'SIGNING'`
            )
            .bind(
              underlyingStellarHsmErr.activityId,
              sanitizeSettlementErrorMessage(underlyingStellarHsmErr, 'Turnkey HSM outcome uncertain'),
              request.payoutId
            )
            .run()
            .catch(() => undefined);
        }
        // A denied, uncertain, or ambiguous admission is not proof that a reserved sequence is reusable.
        if (isTurnkeyUncertainOutcomeError(preBroadcastErr)) throw preBroadcastErr;
        if (isPayoutEffectBlockedError(preBroadcastErr)) throw preBroadcastErr;
        if (hasAdmittedPayoutEffect(workflow)) throw new PayoutEffectBlockedError('admitted signature not durably recorded');
        if (!lostStellarSigningOwnership && stellarSequence !== null) {
          await this.reclaimPreBroadcastNonceOrSequence({
            chain: 'stellar',
            signerAddress,
            stellarSequence,
          });
        }

        if (!lostStellarSigningOwnership && isTurnkeyHotPolicyBlockError(preBroadcastErr)) {
          const coldQueued = await this.turnkeySigner.enqueueColdSafeMultisig(this.db, {
            payoutId: request.payoutId,
            idempotencyKey: request.idempotencyKey,
            affiliateId: request.affiliateId,
            chain: 'stellar',
            recipientAddress: verdict.recipientAddress,
            amountUnits1e8: disbursableUnits1e8,
            chainTokenUnits,
            chainDecimals: 7,
            lockBatchId: request.lockBatchId ?? null,
            preSubmissionWorkflow: workflow,
            reason:
              preBroadcastErr instanceof Error
                ? sanitizeSettlementErrorMessage(preBroadcastErr)
                : 'Routed to Safe{Wallet} 2-of-3 cold multisig due to hot-wallet policy cap',
          });
          return {
            kind: 'cold' as const,
            coldQueued,
          };
        }

        const preErrMsg = sanitizeSettlementErrorMessage(
          preBroadcastErr,
          'Pre-broadcast Stellar signing failed'
        );
        if (lostStellarSigningOwnership) throw preBroadcastErr;
        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'FAILED_ABORTED',
                 exposure_release_kind = 'PRE_SUBMISSION_ABORT',
                 exposure_released_at = unixepoch('now'),
                 exposure_release_attempt_id = ?,
                 stellar_sequence = NULL,
                 timebounds_max_unix = NULL,
                 tx_hash = NULL,
                 signed_raw_tx = NULL,
                 error_reason = ?,
                 updated_at = datetime('now')
             WHERE payout_id = ? AND state = 'SIGNING'
               AND EXISTS (SELECT 1 FROM payout_effect_attempts a
                 WHERE a.attempt_id = ? AND a.payout_id = settlement_broadcasts.payout_id
                   AND a.lock_batch_id IS settlement_broadcasts.lock_batch_id
                   AND a.owner_id = settlement_broadcasts.affiliate_id AND a.active = 1
                   AND NOT EXISTS (SELECT 1 FROM payout_effect_grants g WHERE g.attempt_id = a.attempt_id))`
          )
          .bind(workflow.attemptId, preErrMsg, request.payoutId, workflow.attemptId)
          .run();
        throw preBroadcastErr;
      }
    });

    if (prepared.kind === 'existing') {
      return prepared.outcome;
    }

    if (prepared.kind === 'cold') {
      return {
        payoutId: request.payoutId,
        chain,
        state: 'QUEUED_COLD_SAFE',
        safeMultisigTxHash: prepared.coldQueued.safeMultisigTxHash,
        residualDustUnits1e8: residualDustUnits1e8.toString(),
        reason: prepared.coldQueued.reason,
      };
    }

    // Status-only receipts preserve existing workflow state, but cannot authorize cap release.
    // UNVERIFIED_HOT keeps exposure until canonical finality / ledger inclusion is proven.
    // Step 3: Broadcast signed transaction and require on-chain receipt before CONFIRMED
    if (prepared.kind === 'evm') {
      const { adapter, assignedNonce, txHash: precomputedHash, signedRawTxHex, activityId } = prepared;
      try {
        const rpcHash = await adapter.broadcastSignedTransaction(signedRawTxHex, { workflow, db: this.db, payoutId: request.payoutId, effect: 'EVM_BROADCAST' });
        const candidatesJson = JSON.stringify(
          collectCandidateHashes({ tx_hash: precomputedHash }, [rpcHash])
        );
        const receipt = await adapter.getTransactionReceipt(rpcHash).catch(() => null);

        if (receipt?.found && receipt.confirmed) {
          const confirmationLane =
            receipt.finalized === true &&
            typeof receipt.blockNumber === 'number' &&
            Number.isSafeInteger(receipt.blockNumber) &&
            receipt.blockNumber > 0
              ? 'HOT'
              : 'UNVERIFIED_HOT';
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'CONFIRMED',
                   confirmation_lane = ?, confirmation_observed_at = unixepoch('now'),
                   tx_hash = ?,
                   candidate_tx_hashes = ?,
                   error_reason = NULL,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
            )
            .bind(confirmationLane, rpcHash, candidatesJson, request.payoutId)
            .run();

          return {
            payoutId: request.payoutId,
            chain: prepared.chain,
            state: 'CONFIRMED',
            txHash: rpcHash,
            assignedNonce,
            turnkeyActivityId: activityId,
            residualDustUnits1e8: residualDustUnits1e8.toString(),
          };
        }

        if (receipt?.found && receipt.reverted) {
          const revertReason = 'EVM transaction reverted on-chain (status 0x0)';
          const pending = await this.getSettlementRecord(request.payoutId);
          if (!pending) throw new Error('Pending settlement missing after submission');
          const finalityBlock = receipt.finalized === true ? receipt.blockNumber : undefined;
          await this.recordFailedReceipt(pending, rpcHash, finalityBlock);

          return {
            payoutId: request.payoutId,
            chain: prepared.chain,
            state: 'FAILED_ABORTED',
            txHash: rpcHash,
            assignedNonce,
            turnkeyActivityId: activityId,
            residualDustUnits1e8: residualDustUnits1e8.toString(),
            reason: revertReason,
          };
        }

        // Admitted to mempool (`eth_sendRawTransaction` succeeded), awaiting block receipt (`status === 0x1`)
        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'BROADCAST_PENDING',
                 tx_hash = ?,
                 candidate_tx_hashes = ?,
                 error_reason = NULL,
                 updated_at = datetime('now')
             WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
          )
          .bind(rpcHash, candidatesJson, request.payoutId)
          .run();

        return {
          payoutId: request.payoutId,
          chain: prepared.chain,
          state: 'BROADCAST_PENDING',
          txHash: rpcHash,
          assignedNonce,
          turnkeyActivityId: activityId,
          residualDustUnits1e8: residualDustUnits1e8.toString(),
          reason: 'Transaction broadcast to mempool; awaiting confirmed on-chain receipt',
        };
      } catch (broadcastErr: unknown) {
        const errMsg = sanitizeSettlementErrorMessage(
          broadcastErr,
          'EVM broadcast failed with uncertain status'
        );

        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'BROADCAST_PENDING',
                 error_reason = ?,
                 updated_at = datetime('now')
             WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
          )
          .bind(errMsg, request.payoutId)
          .run();

        return {
          payoutId: request.payoutId,
          chain: prepared.chain,
          state: 'BROADCAST_PENDING',
          txHash: precomputedHash,
          assignedNonce,
          turnkeyActivityId: activityId,
          uncertainBroadcast: true,
          residualDustUnits1e8: residualDustUnits1e8.toString(),
          reason: errMsg,
        };
      }
    }

    // Stellar branch
    const { transport, stellarSequence, timeboundsMaxUnix, stellarSig } = prepared;
    try {
      const submitRes = await transport.submitSignedTransaction({
        workflow, db: this.db, payoutId: request.payoutId, effect: 'STELLAR_SUBMIT',
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
               confirmation_lane = CASE WHEN ? = 'CONFIRMED' THEN 'UNVERIFIED_HOT' ELSE confirmation_lane END,
               confirmation_observed_at = CASE WHEN ? = 'CONFIRMED' THEN unixepoch('now') ELSE confirmation_observed_at END,
               tx_hash = ?,
               error_reason = NULL,
               updated_at = datetime('now')
           WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
        )
        .bind(finalState, finalState, finalState, submitRes.txHash, request.payoutId)
        .run();

      return {
        payoutId: request.payoutId,
        chain: 'stellar',
        state: finalState,
        txHash: submitRes.txHash,
        stellarSequence,
        timeboundsMaxUnix,
        turnkeyActivityId: stellarSig.activityId,
        residualDustUnits1e8: residualDustUnits1e8.toString(),
      };
    } catch (submitErr: unknown) {
      const errMsg = sanitizeSettlementErrorMessage(
        submitErr,
        'Stellar Horizon submission failed with uncertain status'
      );

      await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'BROADCAST_PENDING',
               error_reason = ?,
               updated_at = datetime('now')
           WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
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
        residualDustUnits1e8: residualDustUnits1e8.toString(),
        reason: errMsg,
      };
    }
  }

  /**
   * Read-only passive finality upgrade for hot payouts that confirmed immediately at submission
   * (`confirmation_lane = 'UNVERIFIED_HOT'`) before chain finality was observed.
   * Performs zero signing and zero broadcasting; safe to execute under emergency pause or freeze.
   */
  async promoteUnverifiedHotConfirmation(payoutId: string): Promise<boolean> {
    return this.getPayoutLock(payoutId).runExclusive(async () => {
      const row = await this.getSettlementRecord(payoutId);
      if (
        !row ||
        row.state !== 'CONFIRMED' ||
        row.confirmation_lane !== 'UNVERIFIED_HOT' ||
        row.safe_multisig_tx_hash !== null ||
        !row.tx_hash
      ) {
        return false;
      }

      let finalizedOnChain = false;
      if (row.chain === 'arbitrum' || row.chain === 'base') {
        const adapter = this.evmAdapters[row.chain];
        if (!adapter) return false;
        const receipt = await adapter.getTransactionReceipt(row.tx_hash).catch(() => null);
        finalizedOnChain = Boolean(
          receipt?.found &&
            receipt.confirmed &&
            receipt.finalized === true &&
            typeof receipt.blockNumber === 'number' &&
            Number.isSafeInteger(receipt.blockNumber) &&
            receipt.blockNumber > 0
        );
      } else if (row.chain === 'stellar') {
        if (!this.stellarTransport) return false;
        const status = await this.stellarTransport.lookupTransaction(row.tx_hash).catch(() => null);
        finalizedOnChain = Boolean(
          status?.found &&
            status.successful === true &&
            typeof status.ledger === 'number' &&
            Number.isSafeInteger(status.ledger) &&
            status.ledger > 0
        );
      }

      if (!finalizedOnChain) {
        return false;
      }

      const res = await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET confirmation_lane = 'HOT',
               confirmation_observed_at = unixepoch('now'),
               updated_at = datetime('now')
           WHERE payout_id = ?
             AND state = 'CONFIRMED'
             AND confirmation_lane = 'UNVERIFIED_HOT'
             AND safe_multisig_tx_hash IS NULL`
        )
        .bind(payoutId)
        .run();

      return Boolean(res.success && Number(res.meta?.changes ?? 0) === 1);
    });
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
      if (options?.passiveOnly) return this.recoverUncertainBroadcastLocked(payoutId, options);
      // Claim before any asynchronous recovery preparation, not after a chain lookup.
      try {
        return await withPayoutWorkflow(this.db, payoutId, (workflow) =>
          this.recoverUncertainBroadcastLocked(payoutId, options, workflow));
      } catch (error) {
        if (!isPayoutEffectBlockedError(error)) throw error;
        const observed = await this.recoverUncertainBroadcastLocked(payoutId, { ...options, passiveOnly: true });
        if (observed.state === 'CONFIRMED' || observed.state === 'FAILED_ABORTED') return observed;
        return { ...observed, reason: error.message };
      }
    });
  }

  /** Persist exact failed-chain evidence before the reconciler can refund the lock. */
  private async recordFailedReceipt(
    row: SettlementBroadcastRow,
    txHash: string,
    finalityLedger?: number
  ): Promise<void> {
    const verifiedFinalityLedger =
      typeof finalityLedger === 'number' &&
      Number.isSafeInteger(finalityLedger) &&
      finalityLedger > 0
        ? finalityLedger
        : null;
    const result = await this.db.prepare(`
      UPDATE payout_effect_attempts AS a
      SET active = 0, worker_id = NULL, failed_tx_hash = ?, failed_finality_ledger = ?
      WHERE a.payout_id = ? AND a.active = 1 AND a.lock_batch_id = ?
        AND a.chain = ? AND a.signer_address = ? AND a.assigned_nonce IS ? AND a.stellar_sequence IS ?
        AND EXISTS (
          SELECT 1 FROM settlement_broadcasts b WHERE b.payout_id = a.payout_id
            AND b.lock_batch_id = a.lock_batch_id AND b.affiliate_id = a.owner_id
            AND b.state = 'BROADCAST_PENDING' AND b.chain = a.chain AND b.signer_address = a.signer_address
            AND b.assigned_nonce IS a.assigned_nonce AND b.stellar_sequence IS a.stellar_sequence
        )
        AND EXISTS (
          SELECT 1 FROM payout_effect_grants g WHERE g.attempt_id = a.attempt_id AND g.payout_id = a.payout_id
            AND g.safety_epoch = a.safety_epoch AND lower(g.tx_hash) = lower(?)
            AND ((a.chain = 'stellar' AND g.effect_kind = 'STELLAR_SUBMIT') OR
                 (a.chain IN ('arbitrum', 'base') AND g.effect_kind IN ('EVM_BROADCAST', 'EVM_REBROADCAST', 'EVM_RBF_BROADCAST')))
        )
    `).bind(txHash, verifiedFinalityLedger, row.payout_id, row.lock_batch_id ?? null, row.chain, row.signer_address,
      row.assigned_nonce, row.stellar_sequence, txHash).run();
    if (result.success !== true) throw new Error('Failed receipt persistence unavailable');
    if (result.meta?.changes === 1) return;

    // Legacy broadcasts have no admitted effects. Never publish an unbound receipt for a fenced attempt.
    const legacy = await this.db.prepare(`
      UPDATE settlement_broadcasts SET state = 'FAILED_ABORTED', tx_hash = ?,
        error_reason = 'Transaction failed on-chain', updated_at = datetime('now')
      WHERE payout_id = ? AND state = 'BROADCAST_PENDING' AND lock_batch_id IS ?
        AND chain = ? AND signer_address IS ? AND assigned_nonce IS ? AND stellar_sequence IS ?
        AND NOT EXISTS (SELECT 1 FROM payout_effect_attempts a
                        WHERE a.payout_id = settlement_broadcasts.payout_id AND a.signer_address IS NOT NULL)
    `).bind(txHash, row.payout_id, row.lock_batch_id ?? null, row.chain, row.signer_address,
      row.assigned_nonce, row.stellar_sequence).run();
    if (legacy.success === true && legacy.meta?.changes === 1) return;
    const current = await this.getSettlementRecord(row.payout_id);
    if (current?.state !== 'FAILED_ABORTED' || current.tx_hash !== txHash) {
      throw new PayoutEffectBlockedError('failed receipt does not match the retained submission');
    }
  }

  private async recoverUncertainBroadcastLocked(
    payoutId: string,
    options?: RecoverBroadcastOptions,
    workflow?: PayoutWorkflow
  ): Promise<RecoverBroadcastOutcome> {
    const row = await this.getSettlementRecord(payoutId);
    if (!row) {
      throw new Error(`Settlement broadcast record not found: ${payoutId}`);
    }

    // Cold resolution owns any ledger mutation for cold proposals, including legacy rows.
    if (row.safe_multisig_tx_hash) {
      if (row.state === 'CONFIRMED') {
        const claim = await this.getColdPaymentClaim(row.payout_id);
        if (!claim) throw new Error('Legacy cold confirmation has no verified payment claim');
        await this.finalizeColdClaim(row, claim, new DoubleEntryLedgerService(this.db));
      } else if (row.state !== 'QUEUED_COLD_SAFE') {
        throw new Error('Cold Safe proposal requires explicit settlement reconciliation');
      }
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

    if (row.state === 'SIGNING') {
      return {
        payoutId, chain: row.chain, state: 'SIGNING', action: 'NO_RECOVERY_NEEDED',
        txHash: row.tx_hash, assignedNonce: row.assigned_nonce,
        stellarSequence: row.stellar_sequence, timeboundsMaxUnix: row.timebounds_max_unix,
        reason: 'Elapsed time does not prove signing did not occur; operator verification required',
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
        const confirmationLane =
          typeof lookup.ledger === 'number' &&
          Number.isSafeInteger(lookup.ledger) &&
          lookup.ledger > 0
            ? 'HOT'
            : 'UNVERIFIED_HOT';
        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'CONFIRMED',
                 confirmation_lane = ?, confirmation_observed_at = unixepoch('now'),
                 error_reason = NULL,
                 updated_at = datetime('now')
             WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
          )
          .bind(confirmationLane, payoutId)
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
        await this.recordFailedReceipt(row, row.tx_hash, lookup.ledger);

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

      // The transport cannot prove chain-authoritative expiry and reliable absence.
      return {
        payoutId, chain: 'stellar', state: 'BROADCAST_PENDING', action: 'STILL_BROADCAST_PENDING',
        txHash: row.tx_hash, assignedNonce: null, stellarSequence: row.stellar_sequence,
        timeboundsMaxUnix: maxUnix, reason: 'Local expiry and Horizon absence cannot prove non-execution',
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

    const allCandidateHashes = collectCandidateHashes(row);
    let receiptCheck: {
      found: boolean;
      confirmed: boolean;
      reverted: boolean;
      blockNumber?: number;
      finalized?: boolean;
      matchedTxHash: string | null;
    };
    try {
      receiptCheck = await this.lookupAnyCandidateEvmReceipt(adapter, allCandidateHashes);
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
        reason: sanitizeSettlementErrorMessage(receiptErr, 'EVM receipt lookup failed'),
      };
    }

    const resolvedOnChainTxHash = receiptCheck.matchedTxHash ?? row.tx_hash;

    // 2a. Original or any historical RBF candidate tx landed and succeeded on-chain despite 504! Reconcile to CONFIRMED.
    if (receiptCheck.found && receiptCheck.confirmed) {
      const confirmationLane =
        receiptCheck.finalized === true &&
        typeof receiptCheck.blockNumber === 'number' &&
        Number.isSafeInteger(receiptCheck.blockNumber) &&
        receiptCheck.blockNumber > 0
          ? 'HOT'
          : 'UNVERIFIED_HOT';
      await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'CONFIRMED',
               confirmation_lane = ?, confirmation_observed_at = unixepoch('now'),
               tx_hash = ?,
               error_reason = NULL,
               updated_at = datetime('now')
           WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
        )
        .bind(confirmationLane, resolvedOnChainTxHash, payoutId)
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

    if (receiptCheck.found && receiptCheck.reverted) {
      const finalityBlock = receiptCheck.finalized === true ? receiptCheck.blockNumber : undefined;
      await this.recordFailedReceipt(row, resolvedOnChainTxHash, finalityBlock);

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

    // 2b. Receipt not found: passive reconciliation must never sign or broadcast.
    if (!workflow || options?.passiveOnly) {
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
          'Passive reconciliation found no confirmed on-chain receipt; refusing to re-sign or re-broadcast',
      };
    }

    // Inspect on-chain confirmed nonce for signer_address
    let confirmedNonce: number;
    try {
      confirmedNonce = await adapter.getTransactionCount(row.signer_address, 'latest');
    } catch (nonceErr: unknown) {
      return {
        payoutId: row.payout_id,
        chain: row.chain,
        state: 'BROADCAST_PENDING',
        action: 'STILL_BROADCAST_PENDING',
        txHash: row.tx_hash,
        assignedNonce: row.assigned_nonce,
        stellarSequence: null,
        timeboundsMaxUnix: null,
        reason: sanitizeSettlementErrorMessage(nonceErr, 'EVM confirmed nonce lookup failed'),
      };
    }

    if (confirmedNonce <= row.assigned_nonce) {
      // NEVER increment signer_nonces.next_nonce! Reuse the EXACT SAME assigned_nonce!
      // Read persisted `signed_raw_tx` from D1 when recovering across stateless Worker isolates.
      const cachedSignedRawTx =
        this.signedEvmRawTxCache.get(payoutId) ??
        (typeof row.signed_raw_tx === 'string' && row.signed_raw_tx.startsWith('0x')
          ? (row.signed_raw_tx as Hex)
          : undefined);

      if (!cachedSignedRawTx && !options?.bumpGasRbf) {
        // No persisted signature and no explicit RBF request: refuse to build a fresh signature.
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
            'No persisted signed raw transaction and no RBF gas bump requested; refusing to sign a replacement',
        };
      }

      if (cachedSignedRawTx && !options?.bumpGasRbf) {
        try {
          const rebroadcastHash = await adapter.broadcastSignedTransaction(cachedSignedRawTx, { workflow, db: this.db, payoutId: row.payout_id, effect: 'EVM_REBROADCAST' });
          const updatedCandidates = collectCandidateHashes(row, [rebroadcastHash]);
          const updatedCandidatesJson = JSON.stringify(updatedCandidates);
          const rebroadcastReceipt = await this.lookupAnyCandidateEvmReceipt(
            adapter,
            updatedCandidates
          ).catch(() => null);

          if (rebroadcastReceipt?.found && rebroadcastReceipt.confirmed) {
            const finalHash = rebroadcastReceipt.matchedTxHash ?? rebroadcastHash;
            const confirmationLane =
              rebroadcastReceipt.finalized === true &&
              typeof rebroadcastReceipt.blockNumber === 'number' &&
              Number.isSafeInteger(rebroadcastReceipt.blockNumber) &&
              rebroadcastReceipt.blockNumber > 0
                ? 'HOT'
                : 'UNVERIFIED_HOT';
            await this.db
              .prepare(
                `UPDATE settlement_broadcasts
                 SET state = 'CONFIRMED',
                     confirmation_lane = ?, confirmation_observed_at = unixepoch('now'),
                     tx_hash = ?,
                     candidate_tx_hashes = ?,
                     error_reason = NULL,
                     updated_at = datetime('now')
                 WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
              )
              .bind(confirmationLane, finalHash, updatedCandidatesJson, payoutId)
              .run();

            return {
              payoutId: row.payout_id,
              chain: row.chain,
              state: 'CONFIRMED',
              action: 'EVM_REBROADCAST_SAME_NONCE_CONFIRMED',
              txHash: finalHash,
              assignedNonce: row.assigned_nonce,
              stellarSequence: null,
              timeboundsMaxUnix: null,
            };
          }

          if (rebroadcastReceipt?.found && rebroadcastReceipt.reverted) {
            const finalHash = rebroadcastReceipt.matchedTxHash ?? rebroadcastHash;
            const revertReason = 'EVM transaction reverted on-chain (status 0x0)';
            const finalityBlock =
              rebroadcastReceipt.finalized === true ? rebroadcastReceipt.blockNumber : undefined;
            await this.recordFailedReceipt(row, finalHash, finalityBlock);

            return {
              payoutId: row.payout_id,
              chain: row.chain,
              state: 'FAILED_ABORTED',
              action: 'FAILED_ON_CHAIN_REVERTED',
              txHash: finalHash,
              assignedNonce: row.assigned_nonce,
              stellarSequence: null,
              timeboundsMaxUnix: null,
              reason: revertReason,
            };
          }

          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'BROADCAST_PENDING',
                   candidate_tx_hashes = ?,
                   error_reason = NULL,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
            )
            .bind(updatedCandidatesJson, payoutId)
            .run();

          return {
            payoutId: row.payout_id,
            chain: row.chain,
            state: 'BROADCAST_PENDING',
            action: 'STILL_BROADCAST_PENDING',
            txHash: rebroadcastHash,
            assignedNonce: row.assigned_nonce,
            stellarSequence: null,
            timeboundsMaxUnix: null,
            reason: 'Rebroadcast accepted to mempool; awaiting confirmed on-chain receipt',
          };
        } catch (rebroadcastErr: unknown) {
          // Check if another node already mined any candidate hash right as we rebroadcast ("already known" / "nonce too low")
          const checkAgain = await this.lookupAnyCandidateEvmReceipt(
            adapter,
            allCandidateHashes
          ).catch(() => null);
          if (checkAgain?.found && checkAgain.confirmed) {
            const minedHash = checkAgain.matchedTxHash ?? row.tx_hash;
            const confirmationLane =
              checkAgain.finalized === true &&
              typeof checkAgain.blockNumber === 'number' &&
              Number.isSafeInteger(checkAgain.blockNumber) &&
              checkAgain.blockNumber > 0
                ? 'HOT'
                : 'UNVERIFIED_HOT';
            await this.db
              .prepare(
                `UPDATE settlement_broadcasts
                 SET state = 'CONFIRMED',
                     confirmation_lane = ?, confirmation_observed_at = unixepoch('now'),
                     tx_hash = ?,
                     error_reason = NULL,
                     updated_at = datetime('now')
                 WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
              )
              .bind(confirmationLane, minedHash, payoutId)
              .run();

            return {
              payoutId: row.payout_id,
              chain: row.chain,
              state: 'CONFIRMED',
              action: 'RECONCILED_ON_CHAIN',
              txHash: minedHash,
              assignedNonce: row.assigned_nonce,
              stellarSequence: null,
              timeboundsMaxUnix: null,
            };
          }

          if (checkAgain?.found && checkAgain.reverted) {
            const minedHash = checkAgain.matchedTxHash ?? row.tx_hash;
            const revertReason = 'EVM transaction reverted on-chain (status 0x0)';
            const finalityBlock = checkAgain.finalized === true ? checkAgain.blockNumber : undefined;
            await this.recordFailedReceipt(row, minedHash, finalityBlock);

            return {
              payoutId: row.payout_id,
              chain: row.chain,
              state: 'FAILED_ABORTED',
              action: 'FAILED_ON_CHAIN_REVERTED',
              txHash: minedHash,
              assignedNonce: row.assigned_nonce,
              stellarSequence: null,
              timeboundsMaxUnix: null,
              reason: revertReason,
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

      // RBF path: build replacement transfer reusing EXACT SAME `row.assigned_nonce`
      // Compound fee bump across successive RBF attempts (`candidateCount * 1500` bps) so repeated RBFs never collide.
      const priorAttemptCount = Math.max(1, allCandidateHashes.length);
      const rbfFeeBumpBps = Math.min(10000, priorAttemptCount * 1500);
      const rbfEnvelope = await adapter.buildUnsignedTransfer({
        recipientAddress: row.recipient_address,
        amountUnits1e8: BigInt(row.amount_units_1e8),
        assignedNonce: row.assigned_nonce,
        feeBumpBasisPoints: rbfFeeBumpBps,
      });

      const rbfSig = await this.turnkeySigner.signEvmDigestEnforced({
        workflow,
        db: this.db,
        payoutId: row.payout_id,
        chain: row.chain,
        amountUnits1e8: BigInt(row.amount_units_1e8),
        digestHex: rbfEnvelope.signingDigestHex,
        assignedNonce: row.assigned_nonce,
        effect: 'EVM_RBF_SIGN',
      });

      const rbfAssembled = adapter.assembleSignedTransaction(rbfEnvelope, rbfSig);
      const rbfCandidates = collectCandidateHashes(row, [rbfAssembled.txHash]);
      const rbfCandidatesJson = JSON.stringify(rbfCandidates);

      // Persist EVERY historical candidate hash in `candidate_tx_hashes` AND latest `rbf_candidate_tx_hash`
      // WITHOUT overwriting original `tx_hash`, so any earlier tx mining on-chain is always discovered!
      const rbfPreUpd = await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET rbf_candidate_tx_hash = ?,
               candidate_tx_hashes = ?,
               signed_raw_tx = ?,
               turnkey_activity_id = ?,
               updated_at = datetime('now')
           WHERE payout_id = ? AND state = 'BROADCAST_PENDING' AND assigned_nonce = ?`
        )
        .bind(
          rbfAssembled.txHash,
          rbfCandidatesJson,
          rbfAssembled.signedRawTxHex,
          rbfSig.activityId,
          payoutId,
          row.assigned_nonce
        )
        .run();
      if (typeof rbfPreUpd.meta?.changes === 'number' && rbfPreUpd.meta.changes !== 1) {
        const latestAfterRbfPrep = await this.getSettlementRecord(payoutId);
        return {
          payoutId: row.payout_id,
          chain: row.chain,
          state: latestAfterRbfPrep?.state ?? row.state,
          action:
            latestAfterRbfPrep?.state === 'CONFIRMED'
              ? 'ALREADY_CONFIRMED'
              : 'NO_RECOVERY_NEEDED',
          txHash: latestAfterRbfPrep?.tx_hash ?? row.tx_hash,
          assignedNonce: latestAfterRbfPrep?.assigned_nonce ?? row.assigned_nonce,
          stellarSequence: null,
          timeboundsMaxUnix: null,
          reason:
            latestAfterRbfPrep?.error_reason ??
            'BROADCAST_PENDING state changed concurrently before RBF broadcast',
        };
      }
      this.signedEvmRawTxCache.set(payoutId, rbfAssembled.signedRawTxHex);

      try {
        const rbfHash = await adapter.broadcastSignedTransaction(rbfAssembled.signedRawTxHex, { workflow, db: this.db, payoutId: row.payout_id, effect: 'EVM_RBF_BROADCAST' });
        const postBroadcastCandidates = collectCandidateHashes(row, [
          rbfAssembled.txHash,
          rbfHash,
        ]);
        const postBroadcastCandidatesJson = JSON.stringify(postBroadcastCandidates);
        const rbfReceiptCheck = await this.lookupAnyCandidateEvmReceipt(
          adapter,
          postBroadcastCandidates
        ).catch(() => null);

        if (rbfReceiptCheck?.found && rbfReceiptCheck.confirmed) {
          const finalHash = rbfReceiptCheck.matchedTxHash ?? rbfHash;
          const confirmationLane =
            rbfReceiptCheck.finalized === true &&
            typeof rbfReceiptCheck.blockNumber === 'number' &&
            Number.isSafeInteger(rbfReceiptCheck.blockNumber) &&
            rbfReceiptCheck.blockNumber > 0
              ? 'HOT'
              : 'UNVERIFIED_HOT';
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'CONFIRMED',
                   confirmation_lane = ?, confirmation_observed_at = unixepoch('now'),
                   tx_hash = ?,
                   rbf_candidate_tx_hash = ?,
                   candidate_tx_hashes = ?,
                   error_reason = NULL,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
            )
            .bind(confirmationLane, finalHash, rbfAssembled.txHash, postBroadcastCandidatesJson, payoutId)
            .run();

          return {
            payoutId: row.payout_id,
            chain: row.chain,
            state: 'CONFIRMED',
            action: 'EVM_RBF_SAME_NONCE_CONFIRMED',
            txHash: finalHash,
            assignedNonce: row.assigned_nonce,
            stellarSequence: null,
            timeboundsMaxUnix: null,
          };
        }

        if (rbfReceiptCheck?.found && rbfReceiptCheck.reverted) {
          const finalHash = rbfReceiptCheck.matchedTxHash ?? rbfHash;
          const revertReason = 'EVM transaction reverted on-chain (status 0x0)';
          const finalityBlock =
            rbfReceiptCheck.finalized === true ? rbfReceiptCheck.blockNumber : undefined;
          await this.recordFailedReceipt(row, finalHash, finalityBlock);

          return {
            payoutId: row.payout_id,
            chain: row.chain,
            state: 'FAILED_ABORTED',
            action: 'FAILED_ON_CHAIN_REVERTED',
            txHash: finalHash,
            assignedNonce: row.assigned_nonce,
            stellarSequence: null,
            timeboundsMaxUnix: null,
            reason: revertReason,
          };
        }

        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'BROADCAST_PENDING',
                 rbf_candidate_tx_hash = ?,
                 candidate_tx_hashes = ?,
                 error_reason = NULL,
                 updated_at = datetime('now')
             WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
          )
          .bind(rbfAssembled.txHash, postBroadcastCandidatesJson, payoutId)
          .run();

        return {
          payoutId: row.payout_id,
          chain: row.chain,
          state: 'BROADCAST_PENDING',
          action: 'STILL_BROADCAST_PENDING',
          txHash: rbfHash,
          assignedNonce: row.assigned_nonce,
          stellarSequence: null,
          timeboundsMaxUnix: null,
          reason: 'RBF replacement broadcast accepted to mempool; awaiting confirmed on-chain receipt',
        };
      } catch (rbfErr: unknown) {
        // Check if original `row.tx_hash` OR any prior RBF candidate mined first ("nonce too low")
        const priorCheck = await this.lookupAnyCandidateEvmReceipt(
          adapter,
          rbfCandidates
        ).catch(() => null);
        if (priorCheck?.found && priorCheck.confirmed) {
          const minedHash = priorCheck.matchedTxHash ?? row.tx_hash;
          const confirmationLane =
            priorCheck.finalized === true &&
            typeof priorCheck.blockNumber === 'number' &&
            Number.isSafeInteger(priorCheck.blockNumber) &&
            priorCheck.blockNumber > 0
              ? 'HOT'
              : 'UNVERIFIED_HOT';
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'CONFIRMED',
                   confirmation_lane = ?, confirmation_observed_at = unixepoch('now'),
                   tx_hash = ?,
                   error_reason = NULL,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
            )
            .bind(confirmationLane, minedHash, payoutId)
            .run();

          return {
            payoutId: row.payout_id,
            chain: row.chain,
            state: 'CONFIRMED',
            action: 'RECONCILED_ON_CHAIN',
            txHash: minedHash,
            assignedNonce: row.assigned_nonce,
            stellarSequence: null,
            timeboundsMaxUnix: null,
          };
        }

        if (priorCheck?.found && priorCheck.reverted) {
          const minedHash = priorCheck.matchedTxHash ?? row.tx_hash;
          const revertReason = 'EVM transaction reverted on-chain (status 0x0)';
          const finalityBlock = priorCheck.finalized === true ? priorCheck.blockNumber : undefined;
          await this.recordFailedReceipt(row, minedHash, finalityBlock);

          return {
            payoutId: row.payout_id,
            chain: row.chain,
            state: 'FAILED_ABORTED',
            action: 'FAILED_ON_CHAIN_REVERTED',
            txHash: minedHash,
            assignedNonce: row.assigned_nonce,
            stellarSequence: null,
            timeboundsMaxUnix: null,
            reason: revertReason,
          };
        }

        const errMsg = sanitizeSettlementErrorMessage(
          rbfErr,
          'EVM RBF same-nonce replacement failed'
        );
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
   * Confirms a cold Safe payout only after a finalized payment is claimed and posted.
   * Cancellation remains fail-closed without proposal-specific proof of nonexecution.
   */
  async resolveColdSafeBroadcast(params: {
    payoutId: string;
    resolution: 'CONFIRMED' | 'CANCELLED';
    txHash?: string;
    reason?: string;
    operationId?: string;
  }): Promise<SettlementBroadcastRow> {
    return this.getPayoutLock(params.payoutId).runExclusive(async () => {
      const row = await this.requireColdPayout(params.payoutId);
      if (params.resolution === 'CANCELLED') {
        // A missing/failed candidate transaction cannot exclude a different Safe execution.
        // Until there is a proposal-specific proof of nonexecution, do not release the liability.
        throw new Error('Cannot prove cold Safe proposal did not execute; withdrawal remains locked');
      }
      const txHash = normalizeColdTxHash(row.chain, params.txHash ?? '');
      const operationId = params.operationId;
      if (operationId !== undefined && (typeof operationId !== 'string' || !/^(0|[1-9]\d*)$/.test(operationId))) {
        throw new Error('Invalid cold payment operationId');
      }
      const ledger = new DoubleEntryLedgerService(this.db);
      const lock = await this.validateColdWithdrawalLock(row, ledger);
      let claim = await this.getColdPaymentClaim(row.payout_id);
      if (!claim) {
        // A legacy confirmation with an inflight lock may recover, but only by proving
        // its original hash. A settled legacy lock must never be posted a second time.
        if (lock.status !== 'INFLIGHT' ||
            (row.state === 'CONFIRMED' && row.tx_hash?.toLowerCase() !== txHash)) {
          throw new Error('Cold payout has no verified payment claim for this withdrawal and transaction');
        }
        claim = await this.claimColdPayment(row, lock, txHash, operationId);
      }
      if (claim.tx_hash !== txHash || (operationId !== undefined && claim.operation_id !== operationId)) {
        throw new Error('Cold payout already has a claim for a different transaction or operationId');
      }
      return this.finalizeColdClaim(row, claim, ledger);
    });
  }

  /** Passive reconciliation of durable evidence; no provider, signer, or new claim is needed. */
  async resumeColdPaymentClaim(payoutId: string): Promise<SettlementBroadcastRow> {
    return this.getPayoutLock(payoutId).runExclusive(async () => {
      const row = await this.requireColdPayout(payoutId);
      const claim = await this.getColdPaymentClaim(payoutId);
      if (!claim) throw new Error('Cold payout has no verified payment claim');
      return this.finalizeColdClaim(row, claim, new DoubleEntryLedgerService(this.db));
    });
  }

  private async requireColdPayout(payoutId: string): Promise<SettlementBroadcastRow> {
    const row = await this.getSettlementRecord(payoutId);
    if (!row?.safe_multisig_tx_hash || !row.signer_address ||
        (row.state !== 'QUEUED_COLD_SAFE' && row.state !== 'CONFIRMED')) {
      throw new Error('Settlement is not an eligible cold Safe payout');
    }
    return row;
  }

  private async validateColdWithdrawalLock(
    row: SettlementBroadcastRow,
    ledger: DoubleEntryLedgerService
  ): Promise<LedgerJournalBatchRecord> {
    const lock = await ledger.getActiveWithdrawalLockByPayoutId(row.payout_id);
    if (!lock || !row.lock_batch_id || lock.id !== row.lock_batch_id ||
        lock.metadata.payoutId !== row.payout_id || lock.metadata.ownerId !== row.affiliate_id ||
        (lock.metadata.chain !== undefined && lock.metadata.chain !== row.chain) ||
        !['trader', 'affiliate', 'agency'].some((ownerType) => ownerType === lock.metadata.ownerType) ||
        !Number.isSafeInteger(row.amount_units_1e8) ||
        lock.grossCommissionUnits !== BigInt(row.amount_units_1e8) ||
        lock.metadata.lockedAmountUnits !== String(row.amount_units_1e8)) {
      throw new Error('Cold payout does not match its withdrawal lock, owner, or amount');
    }
    const conversion = ledgerUnitsToChainUnits(lock.grossCommissionUnits, row.chain);
    if (conversion.residualDust1e8 !== BigInt(0) ||
        conversion.chainUnits.toString() !== row.chain_token_units ||
        row.chain_decimals !== (row.chain === 'stellar' ? STELLAR_USDC_DECIMALS : EVM_USDC_DECIMALS)) {
      throw new Error('Cold payout amount is not exactly aligned to the withdrawal lock and chain');
    }
    return lock;
  }

  private getColdPaymentClaim(payoutId: string) {
    return this.db.prepare('SELECT * FROM cold_settlement_claims WHERE payout_id = ?')
      .bind(payoutId).first<ColdPaymentClaim>();
  }

  private async claimColdPayment(
    row: SettlementBroadcastRow,
    lock: LedgerJournalBatchRecord,
    txHash: string,
    operationId?: string
  ): Promise<ColdPaymentClaim> {
    const treasury = this.turnkeySigner.getSafeColdMultisigAddress(row.chain);
    const source = normalizeColdAddress(row.chain, treasury);
    const recipient = normalizeColdAddress(row.chain, row.recipient_address);
    if (!row.signer_address || normalizeColdAddress(row.chain, row.signer_address) !== source || source === recipient) {
      throw new Error('Cold payout source does not match the configured cold treasury');
    }
    let evidence: ColdPaymentEvidence;
    let network: string;
    let asset: string;
    if (row.chain === 'stellar') {
      const horizon = this.stellarTransport;
      if (!horizon?.getColdPaymentEvidence || !horizon.coldPaymentNetwork || !horizon.coldPaymentAsset) {
        throw new Error('Missing authoritative Stellar transfer metadata transport');
      }
      network = horizon.coldPaymentNetwork;
      asset = horizon.coldPaymentAsset;
      evidence = await horizon.getColdPaymentEvidence(txHash);
    } else {
      const adapter = this.evmAdapters[row.chain];
      if (!adapter?.getColdPaymentEvidence || adapter.chain !== row.chain) {
        throw new Error('Missing authoritative EVM transfer metadata transport for this chain');
      }
      network = `eip155:${adapter.chainId}`;
      asset = adapter.usdcContractAddress;
      evidence = await adapter.getColdPaymentEvidence(txHash);
    }
    const transfer = selectColdPaymentTransfer({
      evidence, network, txHash, stellar: row.chain === 'stellar', source, recipient, asset,
      amountUnits: BigInt(row.chain_token_units), operationId,
    });

    // Guard both the payout/lock snapshot and past unclaimed confirmations. For historical
    // confirmations we cannot know which operation was used; fail closed for the entire hash.
    await this.db.prepare(`
      INSERT INTO cold_settlement_claims (
        network, tx_hash, operation_id, payout_id, lock_batch_id, chain, block_reference,
        source_address, recipient_address, asset, amount_token_units
      )
      SELECT ?, ?, ?, sb.payout_id, lb.id, sb.chain, ?, ?, ?, ?, sb.chain_token_units
      FROM settlement_broadcasts sb JOIN ledger_journal_batches lb ON lb.id = sb.lock_batch_id
      WHERE sb.payout_id = ? AND sb.state = ? AND sb.safe_multisig_tx_hash = ?
        AND (sb.state = 'QUEUED_COLD_SAFE' OR lower(sb.tx_hash) = ?)
        AND sb.signer_address = ? AND sb.recipient_address = ? AND sb.affiliate_id = ?
        AND sb.chain = ? AND sb.amount_units_1e8 = ? AND sb.chain_token_units = ? AND sb.chain_decimals = ?
        AND lb.id = ? AND lb.payout_id = sb.payout_id AND lb.journal_type = 'WITHDRAWAL_LOCK'
        AND lb.status = 'INFLIGHT' AND lb.gross_commission_units = sb.amount_units_1e8
        AND json_extract(lb.metadata, '$.payoutId') = sb.payout_id
        AND json_extract(lb.metadata, '$.ownerId') = sb.affiliate_id
        AND json_extract(lb.metadata, '$.ownerType') = ?
        AND (json_type(lb.metadata, '$.chain') IS NULL OR json_extract(lb.metadata, '$.chain') = sb.chain)
        AND json_extract(lb.metadata, '$.lockedAmountUnits') = CAST(sb.amount_units_1e8 AS TEXT)
        AND NOT EXISTS (
          SELECT 1 FROM settlement_broadcasts old
          WHERE old.payout_id <> sb.payout_id AND old.chain = sb.chain AND lower(old.tx_hash) = ?
            AND old.state = 'CONFIRMED' AND old.safe_multisig_tx_hash IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM cold_settlement_claims c WHERE c.payout_id = old.payout_id)
        )
      ON CONFLICT DO NOTHING`)
      .bind(network, txHash, transfer.operationId, evidence.blockReference, source, recipient,
        normalizeColdAddress(row.chain, asset), row.payout_id, row.state, row.safe_multisig_tx_hash, txHash,
        row.signer_address, row.recipient_address, row.affiliate_id, row.chain, row.amount_units_1e8,
        row.chain_token_units, row.chain_decimals, lock.id, lock.metadata.ownerType, txHash)
      .run();
    const claim = await this.getColdPaymentClaim(row.payout_id);
    if (!claim) throw new Error('Cold payment was already used by another payout or the withdrawal lock changed');
    if (claim.network !== network || claim.tx_hash !== txHash || claim.operation_id !== transfer.operationId) {
      throw new Error('Cold payout already has a claim for a different payment');
    }
    return claim;
  }

  private async finalizeColdClaim(
    row: SettlementBroadcastRow,
    claim: ColdPaymentClaim,
    ledger: DoubleEntryLedgerService
  ): Promise<SettlementBroadcastRow> {
    const lock = await this.validateColdWithdrawalLock(row, ledger);
    if (claim.payout_id !== row.payout_id || claim.lock_batch_id !== lock.id || claim.chain !== row.chain ||
        claim.source_address !== normalizeColdAddress(row.chain, row.signer_address ?? '') ||
        claim.recipient_address !== normalizeColdAddress(row.chain, row.recipient_address) ||
        claim.amount_token_units !== row.chain_token_units ||
        (row.state === 'CONFIRMED' && row.tx_hash?.toLowerCase() !== claim.tx_hash)) {
      throw new Error('Cold payment claim does not match the withdrawal');
    }
    const idempotencyKey = `wd_cold_fin:${row.payout_id}`;
    const ledgerCommitted = async (): Promise<boolean> => {
      const batch = await ledger.getBatchByIdempotencyKey(idempotencyKey);
      if (!batch) return false;
      const updatedLock = await this.validateColdWithdrawalLock(row, ledger);
      if (batch.journalType !== 'WITHDRAWAL_FINALIZED' || batch.status !== 'SETTLED' ||
          batch.settledTxHash !== claim.tx_hash || batch.grossCommissionUnits !== lock.grossCommissionUnits ||
          batch.metadata.lockBatchId !== lock.id || batch.metadata.payoutId !== row.payout_id ||
          updatedLock.status !== 'SETTLED' || updatedLock.settledTxHash !== claim.tx_hash ||
          updatedLock.metadata.finalizeBatchId !== batch.id) {
        throw new Error('Cold withdrawal ledger finalization differs from the reserved payment');
      }
      return true;
    };
    if (!(await ledgerCommitted())) {
      try {
        await ledger.finalizeWithdrawal({ idempotencyKey, lockBatchId: lock.id, txHash: claim.tx_hash });
      } catch (error) {
        // The batch can commit before a transient result failure, or a concurrent retry can win.
        if (!(await ledgerCommitted())) throw error;
      }
      if (!(await ledgerCommitted())) throw new Error('Cold withdrawal ledger finalization not committed');
    }
    if (row.state === 'CONFIRMED') return row;
    await this.db.prepare(`
      UPDATE settlement_broadcasts SET state = 'CONFIRMED',
        confirmation_lane = 'COLD', confirmation_observed_at = unixepoch('now'), tx_hash = ?, error_reason = NULL,
        updated_at = datetime('now')
      WHERE payout_id = ? AND lock_batch_id = ? AND state = 'QUEUED_COLD_SAFE'
        AND safe_multisig_tx_hash = ? AND signer_address = ? AND recipient_address = ?
        AND affiliate_id = ? AND chain = ? AND amount_units_1e8 = ? AND chain_token_units = ? AND chain_decimals = ?`)
      .bind(claim.tx_hash, row.payout_id, lock.id, row.safe_multisig_tx_hash, row.signer_address,
        row.recipient_address, row.affiliate_id, row.chain, row.amount_units_1e8, row.chain_token_units,
        row.chain_decimals).run();
    const updated = await this.getSettlementRecord(row.payout_id);
    if (updated?.state !== 'CONFIRMED' || updated.tx_hash !== claim.tx_hash || updated.lock_batch_id !== lock.id) {
      throw new Error('Cold payment is reserved and ledger finalized; retry broadcast confirmation');
    }
    return updated;
  }
}
