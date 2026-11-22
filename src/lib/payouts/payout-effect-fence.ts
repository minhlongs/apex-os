import type { D1Database } from '@/lib/auth/adapters/d1-adapter';

export type PayoutEffectKind =
  | 'TURNKEY_SIGN' | 'STELLAR_SIGN' | 'EVM_BROADCAST' | 'EVM_REBROADCAST'
  | 'EVM_RBF_SIGN' | 'EVM_RBF_BROADCAST' | 'STELLAR_SUBMIT' | 'COLD_SUBMIT';

export class PayoutEffectBlockedError extends Error {
  readonly code = 'PAYOUT_EFFECT_BLOCKED';
  readonly cause?: unknown;
  constructor(reason: string, cause?: unknown) {
    super(`Payout effect denied: ${reason}`);
    this.name = 'PayoutEffectBlockedError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function isPayoutEffectBlockedError(error: unknown): error is PayoutEffectBlockedError {
  return error instanceof PayoutEffectBlockedError;
}

const OPEN_CONTROLS_SQL = `
  (SELECT COUNT(*) FROM system_runtime_flags
   WHERE flag_key IN ('EMERGENCY_PAUSE', 'EMERGENCY_LEDGER_FREEZE')) = 2
  AND (SELECT COUNT(*) FROM system_runtime_flags
       WHERE flag_key IN ('EMERGENCY_PAUSE', 'EMERGENCY_LEDGER_FREEZE')
         AND flag_value = 'false') = 2`;

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PayoutEffectBlockedError('control/grant timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Opaque workflow identity. The epoch is pinned before async preparation, not per effect. */
export interface PayoutWorkflow {
  readonly attemptId: string;
  readonly payoutId: string;
  readonly epoch: number;
}

interface LocalOwnership {
  db: D1Database;
  workerId: string;
  admitted: boolean;
  unresolved: boolean;
  closed: boolean;
  inFlight: boolean;
}
const owners = new WeakMap<PayoutWorkflow, LocalOwnership>();

/**
 * Own the entire sign -> persist -> send -> persist workflow. No TTL takeover.
 * Ambiguous DB/provider outcomes retain the durable owner for explicit reconciliation.
 * A later invocation never revives this token after pause -> resume.
 */
export async function withPayoutWorkflow<T>(
  db: D1Database,
  payoutId: string,
  invoke: (workflow: PayoutWorkflow) => Promise<T>,
  timeoutMs = 5_000
): Promise<T> {
  if (!payoutId || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PayoutEffectBlockedError('invalid workflow context');
  }
  let workflow: PayoutWorkflow;
  const workerId = crypto.randomUUID();
  try {
    const control = await bounded(db.prepare(
      `SELECT epoch FROM system_safety_epoch WHERE singleton = 1 AND ${OPEN_CONTROLS_SQL}`
    ).first<{ epoch: number }>(), timeoutMs);
    if (!control || !Number.isSafeInteger(control.epoch) || control.epoch < 1) {
      throw new PayoutEffectBlockedError('mandatory emergency controls missing, invalid, or active');
    }
    const claim = await bounded(db.prepare(`
      INSERT INTO payout_effect_attempts (attempt_id, payout_id, safety_epoch, worker_id, lock_batch_id, owner_id, owner_type)
      SELECT ?, l.payout_id, epoch, ?, l.id, json_extract(l.metadata, '$.ownerId'), json_extract(l.metadata, '$.ownerType')
      FROM system_safety_epoch JOIN ledger_journal_batches l ON l.payout_id = ?
      WHERE singleton = 1 AND epoch = ? AND ${OPEN_CONTROLS_SQL}
        AND NOT EXISTS (SELECT 1 FROM payout_effect_attempts terminal
                        WHERE terminal.lock_batch_id = l.id AND terminal.failed_tx_hash IS NOT NULL)
        AND l.journal_type = 'WITHDRAWAL_LOCK' AND l.status = 'INFLIGHT'
        AND json_extract(l.metadata, '$.payoutId') = l.payout_id
        AND json_extract(l.metadata, '$.ownerId') <> ''
        AND json_extract(l.metadata, '$.ownerType') IN ('trader', 'affiliate', 'agency')
      ON CONFLICT(payout_id) WHERE active = 1 DO UPDATE SET worker_id = excluded.worker_id
      WHERE payout_effect_attempts.worker_id IS NULL
        AND payout_effect_attempts.safety_epoch = excluded.safety_epoch
        AND payout_effect_attempts.lock_batch_id = excluded.lock_batch_id
        AND payout_effect_attempts.owner_id = excluded.owner_id
        AND payout_effect_attempts.owner_type = excluded.owner_type
      RETURNING attempt_id, safety_epoch
    `).bind(crypto.randomUUID(), workerId, payoutId, control.epoch)
      .first<{ attempt_id: string; safety_epoch: number }>(), timeoutMs);
    if (!claim) throw new PayoutEffectBlockedError('workflow ownership unconfirmed or stale');
    workflow = Object.freeze({ attemptId: claim.attempt_id, payoutId, epoch: claim.safety_epoch });
  } catch (error) {
    if (isPayoutEffectBlockedError(error)) throw error;
    throw new PayoutEffectBlockedError('workflow storage unavailable');
  }
  const owner: LocalOwnership = { db, workerId, admitted: false, unresolved: false, closed: false, inFlight: false };
  owners.set(workflow, owner);
  let completed = false;
  try {
    const result = await invoke(workflow);
    completed = true;
    return result;
  } finally {
    owner.closed = true;
    if (!owner.unresolved && !owner.inFlight && (completed || !owner.admitted)) {
      // Release only the worker slot, never the attempt or its original epoch.
      await bounded(db.prepare(
        'UPDATE payout_effect_attempts SET worker_id = NULL WHERE attempt_id = ? AND worker_id = ?'
      ).bind(workflow.attemptId, workerId).run(), timeoutMs).catch(() => undefined);
    }
  }
}

export function hasAdmittedPayoutEffect(workflow: PayoutWorkflow): boolean {
  return owners.get(workflow)?.admitted === true;
}

export interface PayoutEffectRequest {
  db: D1Database;
  payoutId: string;
  effect: PayoutEffectKind;
  payload: string;
  chain?: string;
  signerAddress?: string;
  amountUnits1e8?: bigint;
  assignedNonce?: number;
  stellarSequence?: string;
  expectedHash?: string;
  workflow?: PayoutWorkflow;
  timeoutMs?: number;
}

/**
 * One primary-D1 grant for one callback invocation. Transport must disable retries/redirects.
 * D1 and HTTP are not atomic: a request admitted before freeze may reach a provider later.
 * Caller must keep its workflow until the late result is durably recorded.
 */
export async function withPayoutEffect<T>(request: PayoutEffectRequest, invokeOnce: () => Promise<T>): Promise<T> {
  const { db, payoutId, effect, payload } = request;
  const timeoutMs = request.timeoutMs ?? 5_000;
  if (!request.workflow) {
    return withPayoutWorkflow(db, payoutId, (workflow) => withPayoutEffect({ ...request, workflow }, invokeOnce), timeoutMs);
  }
  const workflow = request.workflow;
  const owner = owners.get(workflow);
  if (!owner || owner.db !== db || owner.closed || owner.unresolved || owner.inFlight || workflow.payoutId !== payoutId || !payload) {
    throw new PayoutEffectBlockedError('invalid, closed, or unresolved workflow owner');
  }
  owner.inFlight = true;
  let granted = false;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const row = await bounded(db.prepare(`
      SELECT state, assigned_nonce, stellar_sequence, tx_hash, lock_batch_id, affiliate_id, chain, signer_address
      FROM settlement_broadcasts WHERE payout_id = ?
    `).bind(payoutId).first<{
      state: string; assigned_nonce: number | null; stellar_sequence: string | null;
      tx_hash: string | null; lock_batch_id: string; affiliate_id: string; chain: string; signer_address: string;
    }>(), timeoutMs);
    if (!row) throw new PayoutEffectBlockedError('payout missing');
    owner.unresolved = true;
    const result = await bounded(db.prepare(
      `INSERT OR IGNORE INTO payout_effect_grants
         (grant_id, payout_id, attempt_id, effect_kind, payload_sha256, safety_epoch, tx_hash)
       SELECT ?, a.payout_id, a.attempt_id, ?, ?, a.safety_epoch, ?
       FROM payout_effect_attempts a JOIN settlement_broadcasts b ON b.payout_id = a.payout_id
       JOIN ledger_journal_batches l ON l.id = b.lock_batch_id
       WHERE a.attempt_id = ? AND a.payout_id = ? AND a.active = 1 AND a.safety_epoch = ? AND a.worker_id = ?
         AND b.state = ? AND b.assigned_nonce IS ? AND b.stellar_sequence IS ? AND b.tx_hash IS ?
         AND b.lock_batch_id = ? AND b.affiliate_id = ? AND b.chain = ? AND b.signer_address = ?
         AND l.payout_id = b.payout_id AND l.journal_type = 'WITHDRAWAL_LOCK' AND l.status = 'INFLIGHT'
         AND l.gross_commission_units = b.amount_units_1e8 AND json_valid(l.metadata)
         AND json_extract(l.metadata, '$.payoutId') = b.payout_id
         AND json_extract(l.metadata, '$.ownerId') = b.affiliate_id
         AND json_extract(l.metadata, '$.ownerType') IN ('trader', 'affiliate', 'agency')
         AND (json_type(l.metadata, '$.chain') IS NULL OR json_extract(l.metadata, '$.chain') = b.chain)
         AND json_extract(l.metadata, '$.lockedAmountUnits') = CAST(l.gross_commission_units AS TEXT)
         AND a.lock_batch_id = l.id AND a.owner_id = b.affiliate_id
         AND a.owner_type = json_extract(l.metadata, '$.ownerType')
         AND (a.signer_address IS NULL OR (a.chain = b.chain
           AND a.signer_address = b.signer_address AND a.assigned_nonce IS b.assigned_nonce
           AND a.stellar_sequence IS b.stellar_sequence))
         AND ((b.chain = 'stellar' AND b.stellar_sequence IS NOT NULL AND b.assigned_nonce IS NULL
                    AND ? IN ('STELLAR_SIGN', 'STELLAR_SUBMIT'))
           OR (b.chain IN ('arbitrum', 'base') AND b.assigned_nonce >= 0 AND b.stellar_sequence IS NULL
                    AND ? IN ('TURNKEY_SIGN','EVM_RBF_SIGN','EVM_BROADCAST','EVM_REBROADCAST','EVM_RBF_BROADCAST')))
         AND ((? IN ('TURNKEY_SIGN','STELLAR_SIGN') AND b.state = 'SIGNING')
           OR (? IN ('EVM_RBF_SIGN','EVM_BROADCAST','EVM_REBROADCAST','EVM_RBF_BROADCAST','STELLAR_SUBMIT') AND b.state = 'BROADCAST_PENDING'))
         AND (? IS NULL OR b.chain = ?) AND (? IS NULL OR lower(b.signer_address) = lower(?))
         AND (? IS NULL OR CAST(b.amount_units_1e8 AS TEXT) = ?)
         AND (? IS NULL OR b.assigned_nonce = ?) AND (? IS NULL OR b.stellar_sequence = ?)
         AND (? IS NULL OR lower(b.tx_hash) = lower(?) OR lower(b.rbf_candidate_tx_hash) = lower(?))
         AND (? NOT IN ('EVM_BROADCAST','EVM_REBROADCAST','EVM_RBF_BROADCAST','STELLAR_SUBMIT') OR b.signed_raw_tx = ?)
         AND EXISTS (SELECT 1 FROM system_safety_epoch WHERE singleton = 1 AND epoch = a.safety_epoch)
         AND ${OPEN_CONTROLS_SQL}`
    ).bind(crypto.randomUUID(), effect, hash, request.expectedHash ?? null, workflow.attemptId, payoutId, workflow.epoch, owner.workerId,
      row.state, row.assigned_nonce, row.stellar_sequence, row.tx_hash,
      row.lock_batch_id, row.affiliate_id, row.chain, row.signer_address, effect, effect, effect, effect,
      request.chain ?? null, request.chain ?? null, request.signerAddress ?? null, request.signerAddress ?? null,
      request.amountUnits1e8?.toString() ?? null, request.amountUnits1e8?.toString() ?? null,
      request.assignedNonce ?? null, request.assignedNonce ?? null, request.stellarSequence ?? null, request.stellarSequence ?? null,
      request.expectedHash ?? null, request.expectedHash ?? null, request.expectedHash ?? null, effect, payload).run(), timeoutMs);
    if (result?.success !== true || result.meta?.changes !== 1) {
      owner.unresolved = !(result?.success === true && result.meta?.changes === 0);
      throw new PayoutEffectBlockedError('final grant denied or unconfirmed');
    }
    granted = true;
    owner.admitted = true;
    const value = await invokeOnce();
    owner.unresolved = false;
    return value;
  } catch (error) {
    if (isPayoutEffectBlockedError(error)) throw error;
    // Provider exceptions do not establish non-execution. Keep owner and nonce; no automatic takeover.
    // Preserve provider error as `cause` so callers can record diagnostic activityId/outcomeState without relaxing the fence.
    throw new PayoutEffectBlockedError(
      granted ? 'provider outcome uncertain; reconcile retained owner' : 'grant storage unavailable',
      error
    );
  } finally {
    owner.inFlight = false;
  }
}
