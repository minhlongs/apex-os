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
  candidate_tx_hashes?: string | null;
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
  recipient?: string;
  asset?: string;
  assetCode?: string;
  assetIssuer?: string;
  amountUnits?: string | bigint;
  amountStroops?: string | bigint;
  transfers?: Array<{
    recipient: string;
    asset?: string;
    assetCode?: string;
    assetIssuer?: string;
    amountUnits?: string | bigint;
    amountStroops?: string | bigint;
  }>;
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
  /**
   * Minimum age in seconds required before an interactive recovery call may abort a
   * zero-payload `SIGNING` record (`!tx_hash && !signed_raw_tx && !turnkey_activity_id`).
   * Defaults to `SIGNING_STALE_ABORT_AFTER_SECONDS` (300s) so an active cross-isolate
   * signing attempt can never be clobbered mid-preparation.
   */
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

function parseD1TimestampUnixSeconds(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const parsedMs = Date.parse(normalized);
  if (Number.isNaN(parsedMs)) {
    return null;
  }
  return Math.floor(parsedMs / 1000);
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

interface ColdSafeTransferCandidate {
  recipient?: string;
  to?: string;
  tokenContract?: string;
  asset?: string;
  assetCode?: string;
  assetIssuer?: string;
  amountUnits?: string | bigint | number;
  amountStroops?: string | bigint | number;
  amount?: string | bigint | number;
}

interface ColdSafeTransferVerificationPayload extends ColdSafeTransferCandidate {
  transfers?: ColdSafeTransferCandidate[];
}

function normalizeUnitsBigInt(raw: string | bigint | number | undefined): bigint | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) return null;
    return BigInt(raw);
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    return BigInt(trimmed);
  }
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    return BigInt(trimmed);
  }
  return null;
}

function matchesExpectedAsset(
  candidate: ColdSafeTransferCandidate,
  chain: Phase1SettlementChain,
  expectedEvmUsdcContract?: string
): boolean | null {
  if (chain === 'stellar') {
    const code = candidate.assetCode?.trim();
    const asset = candidate.asset?.trim();
    const issuer = candidate.assetIssuer?.trim();
    const expectedIssuer = process.env.STELLAR_USDC_ISSUER?.trim();

    if (!code && !asset && !issuer) {
      return null;
    }
    if (code && code.toUpperCase() !== 'USDC') {
      return false;
    }
    if (asset) {
      const normalized = asset.toUpperCase();
      if (normalized !== 'USDC' && !normalized.startsWith('USDC:')) {
        return false;
      }
      if (normalized.startsWith('USDC:') && expectedIssuer) {
        const assetIssuerPart = asset.slice(5).trim();
        if (assetIssuerPart && assetIssuerPart !== expectedIssuer) {
          return false;
        }
      }
    }
    if (issuer && expectedIssuer && issuer !== expectedIssuer) {
      return false;
    }
    return true;
  }

  const token = (candidate.tokenContract ?? candidate.asset)?.trim();
  if (!token) {
    return null;
  }
  if (!expectedEvmUsdcContract) {
    return true;
  }
  return token.toLowerCase() === expectedEvmUsdcContract.toLowerCase();
}

function verifyColdSafeTransferDetails(params: {
  payoutId: string;
  chain: Phase1SettlementChain;
  txHash: string;
  expectedRecipient: string;
  expectedChainTokenUnits: string;
  expectedEvmUsdcContract?: string;
  payload: ColdSafeTransferVerificationPayload;
  strictColdSafeVerification?: boolean;
}): void {
  const {
    payoutId,
    chain,
    txHash,
    expectedRecipient,
    expectedChainTokenUnits,
    expectedEvmUsdcContract,
    payload,
    strictColdSafeVerification,
  } = params;

  const expectedUnitsBig = BigInt(expectedChainTokenUnits);
  const normalizeRecipient = (addr: string): string =>
    chain === 'stellar' ? addr.trim() : addr.trim().toLowerCase();
  const expectedRecipientNorm = normalizeRecipient(expectedRecipient);

  // Case 1: Receipt/lookup exposes an array of decoded transfer events/operations.
  if (Array.isArray(payload.transfers)) {
    if (payload.transfers.length === 0) {
      throw new Error(
        `Cannot confirm cold Safe ${chain} payout ${payoutId}: transaction '${txHash}' contains no matching USDC transfer events`
      );
    }

    const matched = payload.transfers.some((entry) => {
      const entryRecipient = (entry.recipient ?? entry.to)?.trim();
      if (!entryRecipient || normalizeRecipient(entryRecipient) !== expectedRecipientNorm) {
        return false;
      }
      const assetMatch = matchesExpectedAsset(entry, chain, expectedEvmUsdcContract);
      if (assetMatch === false) {
        return false;
      }
      const rawAmount = entry.amountUnits ?? entry.amountStroops ?? entry.amount;
      const entryAmount = normalizeUnitsBigInt(rawAmount);
      if (entryAmount === null || entryAmount !== expectedUnitsBig) {
        return false;
      }
      return true;
    });

    if (!matched) {
      throw new Error(
        `Cannot confirm cold Safe ${chain} payout ${payoutId}: on-chain transfers in '${txHash}' do not match expected recipient (${expectedRecipient}), asset, and amount (${expectedChainTokenUnits})`
      );
    }
    return;
  }

  // Case 2: Receipt/lookup exposes top-level transfer fields (`recipient`/`to`, `tokenContract`/`asset`, `amountUnits`/`amountStroops`/`amount`).
  const observedRecipient = (payload.recipient ?? payload.to)?.trim();
  const assetCheck = matchesExpectedAsset(payload, chain, expectedEvmUsdcContract);
  const rawAmount = payload.amountUnits ?? payload.amountStroops ?? payload.amount;
  const hasAnyTransferMetadata =
    Boolean(observedRecipient) || assetCheck !== null || rawAmount !== undefined;

  if (!hasAnyTransferMetadata) {
    if (strictColdSafeVerification) {
      throw new Error(
        `Cannot confirm cold Safe ${chain} payout ${payoutId}: transaction '${txHash}' receipt did not provide verifiable recipient/asset/amount transfer metadata`
      );
    }
    return;
  }

  if (observedRecipient && normalizeRecipient(observedRecipient) !== expectedRecipientNorm) {
    throw new Error(
      `Cannot confirm cold Safe ${chain} payout ${payoutId}: on-chain recipient '${observedRecipient}' does not match expected recipient '${expectedRecipient}'`
    );
  }

  if (assetCheck === false) {
    const observedAsset =
      payload.tokenContract ?? payload.asset ?? payload.assetCode ?? 'unknown';
    throw new Error(
      `Cannot confirm cold Safe ${chain} payout ${payoutId}: on-chain asset '${observedAsset}' does not match expected USDC asset`
    );
  }

  if (rawAmount !== undefined) {
    const observedAmount = normalizeUnitsBigInt(rawAmount);
    if (observedAmount === null || observedAmount !== expectedUnitsBig) {
      throw new Error(
        `Cannot confirm cold Safe ${chain} payout ${payoutId}: on-chain amount '${String(rawAmount)}' does not match expected chain token units '${expectedChainTokenUnits}'`
      );
    }
  }
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
    matchedTxHash: string | null;
  }> {
    for (const candidateHash of candidateHashes) {
      const receipt = await adapter.getTransactionReceipt(candidateHash);
      if (receipt.found) {
        return {
          found: true,
          confirmed: receipt.confirmed,
          reverted: receipt.reverted,
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
      return this.executeSettlementLocked(request);
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

    // existing.state === 'EXPIRED_RECOVERED' is eligible for bounded re-execution.
    return null;
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
            db: this.db,
            payoutId: request.payoutId,
            chain,
            amountUnits1e8: disbursableUnits1e8,
            digestHex: envelope.signingDigestHex,
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
              allowFromSigningState: true,
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
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'FAILED_ABORTED',
                   assigned_nonce = NULL,
                   tx_hash = NULL,
                   signed_raw_tx = NULL,
                   error_reason = ?,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'SIGNING'`
            )
            .bind(preErrMsg, request.payoutId)
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
          db: this.db,
          payoutId: request.payoutId,
          amountUnits1e8: disbursableUnits1e8,
          unsignedEnvelopeXdr: built.unsignedEnvelopeXdr,
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
            allowFromSigningState: true,
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
        await this.db
          .prepare(
            `UPDATE settlement_broadcasts
             SET state = 'FAILED_ABORTED',
                 stellar_sequence = NULL,
                 timebounds_max_unix = NULL,
                 tx_hash = NULL,
                 signed_raw_tx = NULL,
                 error_reason = ?,
                 updated_at = datetime('now')
             WHERE payout_id = ? AND state = 'SIGNING'`
          )
          .bind(preErrMsg, request.payoutId)
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

    // Step 3: Broadcast signed transaction and require verified on-chain receipt before CONFIRMED
    if (prepared.kind === 'evm') {
      const { adapter, assignedNonce, txHash: precomputedHash, signedRawTxHex, activityId } = prepared;
      try {
        const rpcHash = await adapter.broadcastSignedTransaction(signedRawTxHex);
        const candidatesJson = JSON.stringify(
          collectCandidateHashes({ tx_hash: precomputedHash }, [rpcHash])
        );
        const receipt = await adapter.getTransactionReceipt(rpcHash).catch(() => null);

        if (receipt?.found && receipt.confirmed) {
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'CONFIRMED',
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
            state: 'CONFIRMED',
            txHash: rpcHash,
            assignedNonce,
            turnkeyActivityId: activityId,
            residualDustUnits1e8: residualDustUnits1e8.toString(),
          };
        }

        if (receipt?.found && receipt.reverted) {
          const revertReason = 'EVM transaction reverted on-chain (status 0x0)';
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'FAILED_ABORTED',
                   tx_hash = ?,
                   candidate_tx_hashes = ?,
                   error_reason = ?,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
            )
            .bind(rpcHash, candidatesJson, revertReason, request.payoutId)
            .run();

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
           WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
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

    if (row.state === 'SIGNING') {
      const hasPersistedPayload =
        Boolean(row.tx_hash) ||
        Boolean(row.signed_raw_tx) ||
        Boolean(row.turnkey_activity_id);

      if (options?.passiveOnly) {
        return {
          payoutId: row.payout_id,
          chain: row.chain,
          state: 'SIGNING',
          action: 'NO_RECOVERY_NEEDED',
          txHash: row.tx_hash,
          assignedNonce: row.assigned_nonce,
          stellarSequence: row.stellar_sequence,
          timeboundsMaxUnix: row.timebounds_max_unix,
          reason:
            'Passive reconciliation never aborts an active SIGNING claim; operator verification required',
        };
      }

      if (hasPersistedPayload) {
        return {
          payoutId: row.payout_id,
          chain: row.chain,
          state: 'SIGNING',
          action: 'NO_RECOVERY_NEEDED',
          txHash: row.tx_hash,
          assignedNonce: row.assigned_nonce,
          stellarSequence: row.stellar_sequence,
          timeboundsMaxUnix: row.timebounds_max_unix,
          reason:
            'SIGNING record holds a signed payload or Turnkey activity reference; refusing to release an uncertain signature',
        };
      }

      const nowUnixForSigning = options?.nowUnix ?? this.nowUnixProvider();
      const staleAfterSeconds = Math.max(
        0,
        options?.signingStaleTimeoutSeconds ?? SIGNING_STALE_ABORT_AFTER_SECONDS
      );
      const signingUpdatedAtUnix = parseD1TimestampUnixSeconds(row.updated_at);
      const signingAgeSeconds =
        signingUpdatedAtUnix === null ? null : nowUnixForSigning - signingUpdatedAtUnix;
      if (signingAgeSeconds === null || signingAgeSeconds < staleAfterSeconds) {
        return {
          payoutId: row.payout_id,
          chain: row.chain,
          state: 'SIGNING',
          action: 'NO_RECOVERY_NEEDED',
          txHash: null,
          assignedNonce: row.assigned_nonce,
          stellarSequence: row.stellar_sequence,
          timeboundsMaxUnix: row.timebounds_max_unix,
          reason:
            signingAgeSeconds === null
              ? 'SIGNING claim age cannot be established from updated_at; refusing to abort an active claim'
              : `SIGNING claim is younger than the ${staleAfterSeconds}s staleness window; refusing to abort an active claim`,
        };
      }

      const abortReason =
        row.error_reason ??
        `Stale SIGNING record (age ${signingAgeSeconds}s >= ${staleAfterSeconds}s) with zero signed/broadcast payload aborted during recovery`;
      // Claim the abort via the conditional transition FIRST, so a concurrent isolate that still
      // owns this `SIGNING` claim can never proceed to broadcast after its nonce/sequence is rolled back.
      const abortUpdate = await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'FAILED_ABORTED',
               assigned_nonce = NULL,
               stellar_sequence = NULL,
               timebounds_max_unix = NULL,
               error_reason = ?,
               updated_at = datetime('now')
           WHERE payout_id = ?
             AND state = 'SIGNING'
             AND tx_hash IS NULL
             AND signed_raw_tx IS NULL
             AND turnkey_activity_id IS NULL`
        )
        .bind(abortReason, payoutId)
        .run();

      if (typeof abortUpdate.meta?.changes === 'number' && abortUpdate.meta.changes !== 1) {
        const currentRow = await this.getSettlementRecord(payoutId);
        return {
          payoutId: row.payout_id,
          chain: currentRow?.chain ?? row.chain,
          state: currentRow?.state ?? row.state,
          action: 'NO_RECOVERY_NEEDED',
          txHash: currentRow?.tx_hash ?? row.tx_hash,
          assignedNonce: currentRow?.assigned_nonce ?? row.assigned_nonce,
          stellarSequence: currentRow?.stellar_sequence ?? row.stellar_sequence,
          timeboundsMaxUnix: currentRow?.timebounds_max_unix ?? row.timebounds_max_unix,
          reason: currentRow?.error_reason ??
            'SIGNING claim was resolved concurrently before the stale abort could claim it',
        };
      }

      await this.reclaimPreBroadcastNonceOrSequence({
        chain: row.chain,
        signerAddress: row.signer_address,
        assignedNonce: row.assigned_nonce,
        stellarSequence: row.stellar_sequence,
      });

      return {
        payoutId: row.payout_id,
        chain: row.chain,
        state: 'FAILED_ABORTED',
        action: 'FAILED_PRE_BROADCAST_ABORTED',
        txHash: null,
        assignedNonce: null,
        stellarSequence: null,
        timeboundsMaxUnix: null,
        reason: abortReason,
      };
    }

    if (
      row.state === 'EXPIRED_RECOVERED' &&
      row.chain === 'stellar' &&
      options?.reexecuteExpired &&
      !options.passiveOnly
    ) {
      const nowUnixForReexec = options.nowUnix ?? this.nowUnixProvider();
      const reexec = await this.executeSettlementLocked({
        payoutId: row.payout_id,
        idempotencyKey: row.idempotency_key,
        affiliateId: row.affiliate_id,
        chain: 'stellar',
        recipientAddress: row.recipient_address,
        amountUnits1e8: BigInt(row.amount_units_1e8),
        lockBatchId: row.lock_batch_id ?? null,
        usdcReferencePriceUsd: options.usdcReferencePriceUsd,
        nowUnix: nowUnixForReexec,
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
             WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
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
             WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
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
      const expiredUpdate = await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'EXPIRED_RECOVERED',
               error_reason = ?,
               updated_at = datetime('now')
           WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
        )
        .bind(expiredReason, payoutId)
        .run();
      if (typeof expiredUpdate.meta?.changes === 'number' && expiredUpdate.meta.changes !== 1) {
        // A concurrent isolate already resolved this record (e.g. receipt confirmed, or passive
        // reconciliation reverted the lock). Never re-execute a transition this call did not own.
        const currentRow = await this.getSettlementRecord(payoutId);
        return {
          payoutId: row.payout_id,
          chain: 'stellar',
          state: currentRow?.state ?? row.state,
          action: 'NO_RECOVERY_NEEDED',
          txHash: currentRow?.tx_hash ?? row.tx_hash,
          assignedNonce: null,
          stellarSequence: currentRow?.stellar_sequence ?? row.stellar_sequence,
          timeboundsMaxUnix: currentRow?.timebounds_max_unix ?? maxUnix,
          reason:
            currentRow?.error_reason ??
            'BROADCAST_PENDING record was resolved concurrently before the expiry transition could claim it',
        };
      }

      if (options?.reexecuteExpired && !options.passiveOnly) {
        const reexec = await this.executeSettlementLocked({
          payoutId: row.payout_id,
          idempotencyKey: row.idempotency_key,
          affiliateId: row.affiliate_id,
          chain: 'stellar',
          recipientAddress: row.recipient_address,
          amountUnits1e8: BigInt(row.amount_units_1e8),
          lockBatchId: row.lock_batch_id ?? null,
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

    const allCandidateHashes = collectCandidateHashes(row);
    let receiptCheck: {
      found: boolean;
      confirmed: boolean;
      reverted: boolean;
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
      await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'CONFIRMED',
               tx_hash = ?,
               error_reason = NULL,
               updated_at = datetime('now')
           WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
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

    if (receiptCheck.found && receiptCheck.reverted) {
      await this.db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'FAILED_ABORTED',
               tx_hash = ?,
               error_reason = 'EVM transaction reverted on-chain (status 0x0)',
               updated_at = datetime('now')
           WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
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

    // 2b. Receipt not found: passive reconciliation must never sign or broadcast.
    if (options?.passiveOnly) {
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
          const rebroadcastHash = await adapter.broadcastSignedTransaction(cachedSignedRawTx);
          const updatedCandidates = collectCandidateHashes(row, [rebroadcastHash]);
          const updatedCandidatesJson = JSON.stringify(updatedCandidates);
          const rebroadcastReceipt = await this.lookupAnyCandidateEvmReceipt(
            adapter,
            updatedCandidates
          ).catch(() => null);

          if (rebroadcastReceipt?.found && rebroadcastReceipt.confirmed) {
            const finalHash = rebroadcastReceipt.matchedTxHash ?? rebroadcastHash;
            await this.db
              .prepare(
                `UPDATE settlement_broadcasts
                 SET state = 'CONFIRMED',
                     tx_hash = ?,
                     candidate_tx_hashes = ?,
                     error_reason = NULL,
                     updated_at = datetime('now')
                 WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
              )
              .bind(finalHash, updatedCandidatesJson, payoutId)
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
            await this.db
              .prepare(
                `UPDATE settlement_broadcasts
                 SET state = 'FAILED_ABORTED',
                     tx_hash = ?,
                     candidate_tx_hashes = ?,
                     error_reason = ?,
                     updated_at = datetime('now')
                 WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
              )
              .bind(finalHash, updatedCandidatesJson, revertReason, payoutId)
              .run();

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
            await this.db
              .prepare(
                `UPDATE settlement_broadcasts
                 SET state = 'CONFIRMED',
                     tx_hash = ?,
                     error_reason = NULL,
                     updated_at = datetime('now')
                 WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
              )
              .bind(minedHash, payoutId)
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
            await this.db
              .prepare(
                `UPDATE settlement_broadcasts
                 SET state = 'FAILED_ABORTED',
                     tx_hash = ?,
                     error_reason = ?,
                     updated_at = datetime('now')
                 WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
              )
              .bind(minedHash, revertReason, payoutId)
              .run();

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
        db: this.db,
        payoutId: row.payout_id,
        chain: row.chain,
        amountUnits1e8: BigInt(row.amount_units_1e8),
        digestHex: rbfEnvelope.signingDigestHex,
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
        const rbfHash = await adapter.broadcastSignedTransaction(rbfAssembled.signedRawTxHex);
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
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'CONFIRMED',
                   tx_hash = ?,
                   rbf_candidate_tx_hash = ?,
                   candidate_tx_hashes = ?,
                   error_reason = NULL,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
            )
            .bind(finalHash, rbfAssembled.txHash, postBroadcastCandidatesJson, payoutId)
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
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'FAILED_ABORTED',
                   tx_hash = ?,
                   rbf_candidate_tx_hash = ?,
                   candidate_tx_hashes = ?,
                   error_reason = ?,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
            )
            .bind(
              finalHash,
              rbfAssembled.txHash,
              postBroadcastCandidatesJson,
              revertReason,
              payoutId
            )
            .run();

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
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'CONFIRMED',
                   tx_hash = ?,
                   error_reason = NULL,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
            )
            .bind(minedHash, payoutId)
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
          await this.db
            .prepare(
              `UPDATE settlement_broadcasts
               SET state = 'FAILED_ABORTED',
                   tx_hash = ?,
                   error_reason = ?,
                   updated_at = datetime('now')
               WHERE payout_id = ? AND state = 'BROADCAST_PENDING'`
            )
            .bind(minedHash, revertReason, payoutId)
            .run();

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
   * Resolves a Safe{Wallet} 2-of-3 `QUEUED_COLD_SAFE` broadcast record once the cold multisig
   * transaction is either confirmed on-chain (`CONFIRMED` + `txHash`) or cancelled (`FAILED_ABORTED`).
   */
  async resolveColdSafeBroadcast(params: {
    payoutId: string;
    resolution: 'CONFIRMED' | 'CANCELLED';
    txHash?: string;
    reason?: string;
    strictColdSafeVerification?: boolean;
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

        // Require verified on-chain confirmation before finalizing a cold Safe multisig payout!
        if (row.chain === 'stellar') {
          if (!this.stellarTransport) {
            throw new Error('Missing StellarBroadcastTransport to verify cold Safe settlement');
          }
          const lookup = await this.stellarTransport.lookupTransaction(cleanHash);
          if (!lookup.found || !lookup.successful) {
            throw new Error(
              `Cannot confirm cold Safe Stellar payout ${params.payoutId}: transaction '${cleanHash}' is not confirmed on Horizon`
            );
          }
          verifyColdSafeTransferDetails({
            payoutId: params.payoutId,
            chain: 'stellar',
            txHash: cleanHash,
            expectedRecipient: row.recipient_address,
            expectedChainTokenUnits: row.chain_token_units,
            payload: lookup,
            strictColdSafeVerification: params.strictColdSafeVerification,
          });
        } else {
          const adapter = this.evmAdapters[row.chain];
          if (!adapter) {
            throw new Error(
              `Missing ArbitrumBaseUsdcAdapter for ${row.chain} to verify cold Safe settlement`
            );
          }
          const receipt = await adapter.getTransactionReceipt(cleanHash);
          if (!receipt.found || !receipt.confirmed) {
            throw new Error(
              `Cannot confirm cold Safe ${row.chain} payout ${params.payoutId}: transaction '${cleanHash}' does not have a confirmed on-chain receipt (status 0x1)`
            );
          }
          verifyColdSafeTransferDetails({
            payoutId: params.payoutId,
            chain: row.chain,
            txHash: cleanHash,
            expectedRecipient: row.recipient_address,
            expectedChainTokenUnits: row.chain_token_units,
            expectedEvmUsdcContract: adapter.usdcContractAddress,
            payload: receipt as ColdSafeTransferVerificationPayload,
            strictColdSafeVerification: params.strictColdSafeVerification,
          });
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

        // If an optional candidate txHash was supplied (or already recorded), refuse cancellation if it succeeded on-chain!
        const checkHash = (params.txHash ?? row.tx_hash ?? '').trim();
        if (checkHash) {
          if (row.chain === 'stellar' && this.stellarTransport) {
            const lookup = await this.stellarTransport.lookupTransaction(checkHash);
            if (lookup.found && lookup.successful) {
              throw new Error(
                `Refusing to cancel cold Safe Stellar payout ${params.payoutId}: transaction '${checkHash}' already succeeded on Horizon`
              );
            }
          } else if (row.chain !== 'stellar') {
            const adapter = this.evmAdapters[row.chain];
            if (adapter) {
              const receipt = await adapter.getTransactionReceipt(checkHash);
              if (receipt.found && receipt.confirmed) {
                throw new Error(
                  `Refusing to cancel cold Safe ${row.chain} payout ${params.payoutId}: transaction '${checkHash}' already confirmed on-chain`
                );
              }
            }
          }
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
