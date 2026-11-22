/**
 * Atomic Double-Entry Ledger Service (Cloudflare D1 + SQLite Sandbox Adapter)
 *
 * Implements:
 * - Emergency kill-switch gate (`EMERGENCY_LEDGER_FREEZE` in `system_runtime_flags`)
 * - Formance-style idempotency with SHA-256 canonical payload fingerprinting (`422` on mismatch)
 * - Blnk-style two-phase `T+7` hold (`COMMISSION_INFLIGHT` -> `SETTLED`)
 * - Proportional inflight clawback (`COMMISSION_VOID_CLAWBACK`) & reserve-first
 *   post-settlement clawback (`POST_SETTLEMENT_CLAWBACK`) with zero negative user balances
 * - Withdrawal locking, on-chain finalization, and failure reversion
 * - Trial balance & period conservation invariant verifier (`verifyLedgerInvariants`)
 *   that automatically flips `EMERGENCY_LEDGER_FREEZE = 'true'` on any drift.
 */

import type {
  D1Database,
  D1ExecResult,
  D1Meta,
  D1PreparedStatement,
  D1QueryResult,
  D1Result,
} from '@/lib/auth/adapters/d1-adapter';
import { error as logError, warn as logWarn } from '@/lib/logger';
import {
  computeSha256Hex,
  isSupportedPartnerExchange,
  type R2BucketLike,
  type SupportedPartnerExchange,
} from './evidence-vault';
import { assertReconciliationEligibleForMinting } from './reconciliation-service';
import {
  BI_ZERO,
  fromSqlInteger,
  LedgerUnitValidationError,
  MIN_WITHDRAWAL_UNITS_1E8,
  toSafeSqlInteger,
} from './units';
import {
  computeSafeSpreadWaterfall,
  type WaterfallBreakdown,
  type WaterfallConfig,
} from './waterfall';

export type LedgerAccountOwnerType =
  | 'system'
  | 'trader'
  | 'affiliate'
  | 'agency'
  | 'treasury'
  | 'reserve';

export type LedgerJournalType =
  | 'COMMISSION_INFLIGHT'
  | 'COMMISSION_SETTLED'
  | 'COMMISSION_VOID_CLAWBACK'
  | 'POST_SETTLEMENT_CLAWBACK'
  | 'WITHDRAWAL_LOCK'
  | 'WITHDRAWAL_FINALIZED'
  | 'WITHDRAWAL_REVERTED';

export type LedgerBatchStatus = 'INFLIGHT' | 'SETTLED' | 'VOIDED';
export type PostingDirection = 'DEBIT' | 'CREDIT';

/** T+7 hold duration in milliseconds (`7 * 24 * 60 * 60 * 1000`). */
export const T_PLUS_7_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

export class LedgerFrozenError extends Error {
  public readonly statusCode = 503;
  constructor(reason?: string) {
    super(
      `Ledger mutations are halted by EMERGENCY_LEDGER_FREEZE${reason ? `: ${reason}` : ''}`
    );
    this.name = 'LedgerFrozenError';
  }
}

export class IdempotencyConflictError extends Error {
  public readonly code = 'IDEMPOTENCY_CONFLICT' as const;
  public readonly statusCode = 422;
  public readonly idempotencyKey: string;
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key "${idempotencyKey}" was already used with a different payload fingerprint`
    );
    this.name = 'IdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

export class HoldPeriodNotMaturedError extends Error {
  public readonly statusCode = 409;
  constructor(batchId: string, holdUntil: string, nowIso: string) {
    super(
      `Batch "${batchId}" cannot settle at ${nowIso}; T+7 hold matures at ${holdUntil}`
    );
    this.name = 'HoldPeriodNotMaturedError';
  }
}

export class InsufficientSettledBalanceError extends Error {
  public readonly statusCode = 422;
  constructor(accountCode: string, requested: bigint, available: bigint) {
    super(
      `Account "${accountCode}" has insufficient settled balance: requested ${requested.toString()}, available ${available.toString()}`
    );
    this.name = 'InsufficientSettledBalanceError';
  }
}

export class LedgerInvariantError extends Error {
  public readonly statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = 'LedgerInvariantError';
  }
}

export class LedgerStateTransitionError extends Error {
  public readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'LedgerStateTransitionError';
  }
}

// ============================================================================
// SQLite -> Cloudflare D1 Adapter (zero runtime import of better-sqlite3)
// ============================================================================

export interface SqliteStatementLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  exec(sql: string): unknown;
  pragma?(pragmaStr: string): unknown;
  transaction<T>(fn: () => T): () => T;
  close?(): void;
}

interface InternalExecutableStatement extends D1PreparedStatement {
  _executeSync(): D1Result;
}

class SqliteBoundStatement implements InternalExecutableStatement {
  private readonly sqlite: SqliteDatabaseLike;
  private readonly query: string;
  private readonly boundValues: readonly unknown[];

  constructor(sqlite: SqliteDatabaseLike, query: string, boundValues: readonly unknown[] = []) {
    this.sqlite = sqlite;
    this.query = query;
    this.boundValues = boundValues;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteBoundStatement(this.sqlite, this.query, values);
  }

  _executeSync(): D1Result {
    const start = performance.now();
    const stmt = this.sqlite.prepare(this.query);
    const trimmed = this.query.trimStart().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('EXPLAIN') || trimmed.startsWith('PRAGMA')) {
      const rows = stmt.all(...this.boundValues);
      const duration = performance.now() - start;
      const meta: D1Meta = {
        last_row_id: 0,
        rows_written: 0,
        changes: 0,
        duration,
      };
      return {
        success: true,
        meta,
        changes: 0,
        results: rows,
      } as D1Result;
    }

    const info = stmt.run(...this.boundValues);
    const duration = performance.now() - start;
    const meta: D1Meta = {
      last_row_id: Number(info.lastInsertRowid),
      rows_written: info.changes,
      changes: info.changes,
      duration,
    };
    return {
      success: true,
      meta,
      changes: info.changes,
    };
  }

  async first<T = unknown>(): Promise<T | undefined> {
    const stmt = this.sqlite.prepare(this.query);
    const row = stmt.get(...this.boundValues);
    return (row === undefined ? undefined : (row as T));
  }

  async all<T = unknown>(): Promise<D1QueryResult<T>> {
    const start = performance.now();
    const stmt = this.sqlite.prepare(this.query);
    const rows = stmt.all(...this.boundValues) as T[];
    const duration = performance.now() - start;
    return {
      results: rows,
      meta: {
        last_row_id: 0,
        rows_written: 0,
        changes: 0,
        duration,
      },
    };
  }

  async run(): Promise<D1ExecResult> {
    const res = this._executeSync();
    return {
      success: res.success,
      meta: res.meta,
    };
  }

  async *raw<T = unknown>(): AsyncIterable<T> {
    const stmt = this.sqlite.prepare(this.query);
    const rows = stmt.all(...this.boundValues) as T[];
    for (const row of rows) {
      yield row;
    }
  }
}

/**
 * Wraps a synchronous `better-sqlite3` `Database` instance in the asynchronous
 * Cloudflare `D1Database` contract where `db.batch([...])` executes inside an
 * atomic SQLite transaction (`BEGIN IMMEDIATE ... COMMIT / ROLLBACK`).
 */
export class SqliteD1Adapter implements D1Database {
  private readonly sqlite: SqliteDatabaseLike;

  constructor(sqlite: SqliteDatabaseLike) {
    this.sqlite = sqlite;
    if (typeof this.sqlite.pragma === 'function') {
      this.sqlite.pragma('foreign_keys = ON');
    } else {
      this.sqlite.exec('PRAGMA foreign_keys = ON;');
    }
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteBoundStatement(this.sqlite, query, []);
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const start = performance.now();
    this.sqlite.exec(sql);
    return {
      success: true,
      meta: {
        last_row_id: 0,
        rows_written: 0,
        changes: 0,
        duration: performance.now() - start,
      },
    };
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const tx = this.sqlite.transaction((): D1Result[] => {
      const results: D1Result[] = [];
      for (const stmt of statements) {
        const internal = stmt as unknown as Partial<InternalExecutableStatement>;
        if (typeof internal._executeSync !== 'function') {
          throw new Error('SqliteD1Adapter.batch received a foreign prepared statement');
        }
        results.push(internal._executeSync());
      }
      return results;
    });
    return tx();
  }

  async dump(): Promise<string> {
    return '';
  }

  async close(): Promise<void> {
    if (typeof this.sqlite.close === 'function') {
      this.sqlite.close();
    }
  }
}

// ============================================================================
// Domain Types
// ============================================================================

export interface LedgerAccountRecord {
  id: string;
  ownerType: LedgerAccountOwnerType;
  ownerId: string;
  accountCode: string;
  currency: string;
  settledBalanceUnits: bigint;
  inflightBalanceUnits: bigint;
  allowNegative: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerPostingRecord {
  id: string;
  batchId: string;
  accountId: string;
  direction: PostingDirection;
  amountUnits: bigint;
  legRole: string;
  createdAt: string;
}

export interface CommissionBatchMetadata {
  traderId: string;
  l1AffiliateId: string | null;
  b2bAgencyId: string | null;
  waterfallConfig: WaterfallConfig;
  initialLegs: {
    cashCollectedUnits: string;
    reserveUnits: string;
    traderCashbackUnits: string;
    l1CommissionUnits: string;
    l2CommissionUnits: string;
    platformNetUnits: string;
  };
  remainingLegs: {
    grossUnits: string;
    reserveUnits: string;
    traderCashbackUnits: string;
    l1CommissionUnits: string;
    l2CommissionUnits: string;
    platformNetUnits: string;
  };
  clawedBackUnits: string;
}

export interface LedgerJournalBatchRecord {
  id: string;
  idempotencyKey: string;
  payloadFingerprint: string;
  journalType: LedgerJournalType;
  status: LedgerBatchStatus;
  exchange: SupportedPartnerExchange | null;
  traderUid: string | null;
  reconciliationId: string | null;
  evidenceId: string | null;
  grossCommissionUnits: bigint;
  holdUntil: string | null;
  settledTxHash: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RecordVerifiedCommissionInput {
  idempotencyKey: string;
  exchange: SupportedPartnerExchange;
  traderUid: string;
  traderId: string;
  l1AffiliateId?: string | null;
  b2bAgencyId?: string | null;
  reconciliationId: string;
  evidenceId: string;
  grossCommissionUnits: bigint;
  waterfallConfig?: Partial<WaterfallConfig>;
  createdAt?: string;
  r2?: R2BucketLike;
}

export interface RecordCommissionResult {
  batch: LedgerJournalBatchRecord;
  postings: LedgerPostingRecord[];
  waterfall: WaterfallBreakdown;
  isReplay: boolean;
}

export interface ReleaseInflightResult {
  batch: LedgerJournalBatchRecord;
  settledUnits: bigint;
  isReplay: boolean;
}

export interface ApplyClawbackInput {
  idempotencyKey: string;
  originalBatchId: string;
  clawbackUnits: bigint;
  reason: string;
  nowIso?: string;
  recoverFromFutureInflight?: boolean;
}

export interface ApplyClawbackResult {
  clawbackBatch: LedgerJournalBatchRecord;
  postings: LedgerPostingRecord[];
  mode: 'INFLIGHT_VOID' | 'POST_SETTLEMENT_RESERVE';
  reserveDebitedUnits: bigint;
  futureInflightRecoveredUnits: bigint;
  platformAbsorbedUnits: bigint;
  unrecoveredExpenseUnits: bigint;
  isReplay: boolean;
}

export interface WithdrawalLockInput {
  idempotencyKey: string;
  ownerType: 'trader' | 'affiliate' | 'agency';
  ownerId: string;
  amountUnits: bigint;
  payoutId: string;
  chain?: 'stellar' | 'arbitrum' | 'base';
  enforceMinimumThreshold?: boolean;
  nowIso?: string;
}

export interface WithdrawalMutationResult {
  batch: LedgerJournalBatchRecord;
  postings: LedgerPostingRecord[];
  isReplay: boolean;
}

export interface TrialBalanceReport {
  valid: boolean;
  totalDebitUnits: bigint;
  totalCreditUnits: bigint;
  unbalancedBatchIds: string[];
  negativeUserAccountCodes: string[];
  accountPostingDriftCodes: string[];
  periodEquation: {
    openingUnits: bigint;
    verifiedUnits: bigint;
    reversalUnits: bigint;
    settledWithdrawalUnits: bigint;
    expectedClosingUnits: bigint;
    actualClosingUnits: bigint;
    driftUnits: bigint;
  };
  emergencyFreezeTriggered: boolean;
}

// ============================================================================
// Raw SQL Row Mappers & Canonical Helpers
// ============================================================================

interface RawAccountRow {
  id: string;
  owner_type: LedgerAccountOwnerType;
  owner_id: string;
  account_code: string;
  currency: string;
  settled_balance_units: number;
  inflight_balance_units: number;
  allow_negative: number;
  created_at: string;
  updated_at: string;
}

interface RawBatchRow {
  id: string;
  idempotency_key: string;
  payload_fingerprint: string;
  journal_type: LedgerJournalType;
  status: LedgerBatchStatus;
  exchange: SupportedPartnerExchange | null;
  trader_uid: string | null;
  reconciliation_id: string | null;
  evidence_id: string | null;
  gross_commission_units: number;
  hold_until: string | null;
  settled_tx_hash: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface RawPostingRow {
  id: string;
  batch_id: string;
  account_id: string;
  direction: PostingDirection;
  amount_units: number;
  leg_role: string;
  created_at: string;
}

function mapAccountRow(row: RawAccountRow): LedgerAccountRecord {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    accountCode: row.account_code,
    currency: row.currency,
    settledBalanceUnits: fromSqlInteger(row.settled_balance_units, 'settled_balance_units'),
    inflightBalanceUnits: fromSqlInteger(row.inflight_balance_units, 'inflight_balance_units'),
    allowNegative: row.allow_negative === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function mapBatchRow(row: RawBatchRow): LedgerJournalBatchRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    payloadFingerprint: row.payload_fingerprint,
    journalType: row.journal_type,
    status: row.status,
    exchange: row.exchange,
    traderUid: row.trader_uid,
    reconciliationId: row.reconciliation_id,
    evidenceId: row.evidence_id,
    grossCommissionUnits: fromSqlInteger(
      row.gross_commission_units,
      'gross_commission_units'
    ),
    holdUntil: row.hold_until,
    settledTxHash: row.settled_tx_hash,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPostingRow(row: RawPostingRow): LedgerPostingRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    accountId: row.account_id,
    direction: row.direction,
    amountUnits: fromSqlInteger(row.amount_units, 'amount_units'),
    legRole: row.leg_role,
    createdAt: row.created_at,
  };
}

function canonicalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      if (record[k] !== undefined) {
        out[k] = canonicalizeValue(record[k]);
      }
    }
    return out;
  }
  return value;
}

export async function computePayloadFingerprint(payload: Record<string, unknown>): Promise<string> {
  const canonicalJson = JSON.stringify(canonicalizeValue(payload));
  return computeSha256Hex(canonicalJson);
}

/**
 * Translate a transaction rollback raised by the `CASE ... ELSE NULL END` status
 * guard inside `applyClawback` into the ledger's domain errors.
 *
 * The guard writes `NULL` into `ledger_journal_batches.status` (declared
 * `NOT NULL`) whenever the batch moved, its cumulative clawback metadata
 * changed, or the cumulative clawback cap would be exceeded. SQLite aborts the
 * whole `db.batch(...)` transaction on that constraint violation, so mapping
 * the message back to `CONCURRENT` vs `CAP` preserves the caller's 409/400
 * semantics without ever leaving a partially applied clawback behind.
 */
function translateClawbackConstraintError(
  err: unknown,
  originalBatchId: string,
  clawbackUnits: bigint
): Error {
  const message = err instanceof Error ? err.message : String(err);
  const isNotNullConstraint =
    message.includes('NOT NULL constraint failed') &&
    message.includes('ledger_journal_batches.status');
  if (!isNotNullConstraint) {
    return err instanceof Error ? err : new Error(message);
  }
  return new LedgerConcurrentClawbackError(originalBatchId, clawbackUnits, message);
}

/**
 * Raised when a clawback cannot be applied because the original batch was
 * concurrently mutated or the cumulative clawback cap was reached at commit time.
 * Status `409` keeps retry semantics for the optimistic-lock race; the message
 * names the batch so operators can reconcile the statement out-of-band.
 */
export class LedgerConcurrentClawbackError extends LedgerStateTransitionError {
  public readonly originalBatchId: string;
  public readonly clawbackUnits: bigint;
  constructor(originalBatchId: string, clawbackUnits: bigint, detail?: string) {
    super(
      `Clawback of ${clawbackUnits.toString()} units on batch "${originalBatchId}" was rejected by the atomic cumulative guard${
        detail ? ` (${detail})` : ''
      }`
    );
    this.name = 'LedgerConcurrentClawbackError';
    this.originalBatchId = originalBatchId;
    this.clawbackUnits = clawbackUnits;
  }
}

interface AccountSpec {
  id: string;
  ownerType: LedgerAccountOwnerType;
  ownerId: string;
  accountCode: string;
  allowNegative: 0 | 1;
}

function buildAccountSpec(
  ownerType: LedgerAccountOwnerType,
  ownerId: string,
  allowNegative: boolean
): AccountSpec {
  const accountCode = `${ownerType}:${ownerId}`;
  return {
    id: `acct_${ownerType}_${ownerId}`,
    ownerType,
    ownerId,
    accountCode,
    allowNegative: allowNegative ? 1 : 0,
  };
}

const CLAWBACK_POOL_ACCOUNT = buildAccountSpec('reserve', 'clawback_pool', false);
const PLATFORM_REVENUE_ACCOUNT = buildAccountSpec('system', 'platform_revenue', false);
const UNRECOVERED_CLAWBACK_ACCOUNT = buildAccountSpec(
  'system',
  'unrecovered_clawback_expense',
  true
);
const WITHDRAWAL_ESCROW_ACCOUNT = buildAccountSpec('treasury', 'withdrawal_escrow', false);
const EXTERNAL_SETTLEMENT_ACCOUNT = buildAccountSpec(
  'treasury',
  'external_settlement',
  true
);

function partnerReceivableAccount(exchange: SupportedPartnerExchange): AccountSpec {
  return buildAccountSpec('system', `partner_receivable:${exchange}`, true);
}

interface PlannedPosting {
  id: string;
  account: AccountSpec;
  direction: PostingDirection;
  amountUnits: bigint;
  legRole: string;
  balanceBucket: 'inflight' | 'settled';
}

function assertBalancedPostings(postings: PlannedPosting[]): {
  debitSum: bigint;
  creditSum: bigint;
} {
  if (postings.length < 2) {
    throw new LedgerInvariantError('Double-entry batch requires at least 2 posting legs');
  }
  let debitSum = BI_ZERO;
  let creditSum = BI_ZERO;
  for (const p of postings) {
    if (p.amountUnits <= BI_ZERO) {
      throw new LedgerInvariantError(
        `Posting leg "${p.legRole}" has non-positive amountUnits=${p.amountUnits.toString()}`
      );
    }
    if (p.direction === 'DEBIT') {
      debitSum += p.amountUnits;
    } else {
      creditSum += p.amountUnits;
    }
  }
  if (debitSum !== creditSum) {
    throw new LedgerInvariantError(
      `Unbalanced postings detected prior to commit: DEBIT=${debitSum.toString()} !== CREDIT=${creditSum.toString()}`
    );
  }
  return { debitSum, creditSum };
}

/**
 * Proportional integer allocation of `targetTotal` across `capacities` such that
 * `0 <= alloc_i <= cap_i` for every leg and `sum(alloc_i) === targetTotal`.
 */
function allocateProportionalReduction(
  capacities: readonly bigint[],
  targetTotal: bigint,
  remainingGross: bigint
): bigint[] {
  if (targetTotal === remainingGross) {
    return capacities.map((c) => c);
  }
  const allocated = capacities.map((cap) => (cap * targetTotal) / remainingGross);
  let sumAllocated = BI_ZERO;
  for (const a of allocated) {
    sumAllocated += a;
  }
  let remainder = targetTotal - sumAllocated;

  // Priority order for 1-unit floor residue: platform (4), reserve (0), trader (1), l1 (2), l2 (3)
  const priorityOrder = [4, 0, 1, 2, 3];
  while (remainder > BI_ZERO) {
    let progressed = false;
    for (const idx of priorityOrder) {
      if (idx < allocated.length && allocated[idx] < capacities[idx]) {
        allocated[idx] += BigInt(1);
        remainder -= BigInt(1);
        progressed = true;
        if (remainder === BI_ZERO) {
          break;
        }
      }
    }
    if (!progressed) {
      throw new LedgerInvariantError(
        'Proportional clawback allocation failed capacity conservation'
      );
    }
  }
  return allocated;
}

// ============================================================================
// Runtime Freeze Helpers
// ============================================================================

export async function isLedgerFrozen(
  db: D1Database
): Promise<{ frozen: boolean; reason: string | null }> {
  const row = await db
    .prepare(
      `SELECT flag_value, reason
       FROM system_runtime_flags
       WHERE flag_key = ?`
    )
    .bind('EMERGENCY_LEDGER_FREEZE')
    .first<{ flag_value: string; reason: string | null }>();

  if (!row) {
    return { frozen: false, reason: null };
  }
  return {
    frozen: row.flag_value.toLowerCase() === 'true',
    reason: row.reason,
  };
}

export async function assertLedgerNotFrozen(db: D1Database): Promise<void> {
  const state = await isLedgerFrozen(db);
  if (state.frozen) {
    throw new LedgerFrozenError(state.reason ?? undefined);
  }
}

export async function setEmergencyLedgerFreeze(
  db: D1Database,
  frozen: boolean,
  reason: string,
  updatedBy = 'ledger_guardian'
): Promise<void> {
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO system_runtime_flags (flag_key, flag_value, reason, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(flag_key) DO UPDATE SET
         flag_value = excluded.flag_value,
         reason = excluded.reason,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`
    )
    .bind('EMERGENCY_LEDGER_FREEZE', frozen ? 'true' : 'false', reason, updatedBy, nowIso)
    .run();
}

// ============================================================================
// DoubleEntryLedgerService
// ============================================================================

export class DoubleEntryLedgerService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async getAccountByCode(accountCode: string): Promise<LedgerAccountRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, owner_type, owner_id, account_code, currency,
                settled_balance_units, inflight_balance_units,
                allow_negative, created_at, updated_at
         FROM ledger_accounts
         WHERE account_code = ?`
      )
      .bind(accountCode)
      .first<RawAccountRow>();
    return row ? mapAccountRow(row) : null;
  }

  async getAccountByOwner(
    ownerType: LedgerAccountOwnerType,
    ownerId: string
  ): Promise<LedgerAccountRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, owner_type, owner_id, account_code, currency,
                settled_balance_units, inflight_balance_units,
                allow_negative, created_at, updated_at
         FROM ledger_accounts
         WHERE owner_type = ? AND owner_id = ?`
      )
      .bind(ownerType, ownerId)
      .first<RawAccountRow>();
    return row ? mapAccountRow(row) : null;
  }

  async getBatchById(batchId: string): Promise<LedgerJournalBatchRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, idempotency_key, payload_fingerprint, journal_type, status,
                exchange, trader_uid, reconciliation_id, evidence_id,
                gross_commission_units, hold_until, settled_tx_hash,
                metadata, created_at, updated_at
         FROM ledger_journal_batches
         WHERE id = ?`
      )
      .bind(batchId)
      .first<RawBatchRow>();
    return row ? mapBatchRow(row) : null;
  }

  async getBatchByIdempotencyKey(
    idempotencyKey: string
  ): Promise<LedgerJournalBatchRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, idempotency_key, payload_fingerprint, journal_type, status,
                exchange, trader_uid, reconciliation_id, evidence_id,
                gross_commission_units, hold_until, settled_tx_hash,
                metadata, created_at, updated_at
         FROM ledger_journal_batches
         WHERE idempotency_key = ?`
      )
      .bind(idempotencyKey)
      .first<RawBatchRow>();
    return row ? mapBatchRow(row) : null;
  }

  async getActiveWithdrawalLockByPayoutId(
    payoutId: string
  ): Promise<LedgerJournalBatchRecord | null> {
    const trimmed = payoutId.trim();
    if (!trimmed) {
      return null;
    }
    const row = await this.db
      .prepare(
        `SELECT id, idempotency_key, payload_fingerprint, journal_type, status,
                exchange, trader_uid, reconciliation_id, evidence_id,
                gross_commission_units, hold_until, settled_tx_hash,
                metadata, created_at, updated_at
         FROM ledger_journal_batches
         WHERE journal_type = 'WITHDRAWAL_LOCK'
           AND payout_id = ?
           AND status IN ('INFLIGHT', 'SETTLED')
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .bind(trimmed)
      .first<RawBatchRow>();
    return row ? mapBatchRow(row) : null;
  }

  async getPostingsForBatch(batchId: string): Promise<LedgerPostingRecord[]> {
    const res = await this.db
      .prepare(
        `SELECT id, batch_id, account_id, direction, amount_units, leg_role, created_at
         FROM ledger_postings
         WHERE batch_id = ?`
      )
      .bind(batchId)
      .all<RawPostingRow>();
    return (res.results ?? []).map(mapPostingRow);
  }

  async listMaturedInflightBatches(
    nowIso: string,
    limit = 100
  ): Promise<LedgerJournalBatchRecord[]> {
    const clamped = Math.max(1, Math.min(500, Math.trunc(limit)));
    const res = await this.db
      .prepare(
        `SELECT id, idempotency_key, payload_fingerprint, journal_type, status,
                exchange, trader_uid, reconciliation_id, evidence_id,
                gross_commission_units, hold_until, settled_tx_hash,
                metadata, created_at, updated_at
         FROM ledger_journal_batches
         WHERE status = 'INFLIGHT' AND hold_until <= ?
         ORDER BY hold_until ASC
         LIMIT ?`
      )
      .bind(nowIso, clamped)
      .all<RawBatchRow>();
    return (res.results ?? []).map(mapBatchRow);
  }

  private async checkIdempotencyReplay(
    idempotencyKey: string,
    expectedFingerprint: string
  ): Promise<LedgerJournalBatchRecord | null> {
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new LedgerUnitValidationError('idempotencyKey must be a non-empty string');
    }
    const existing = await this.getBatchByIdempotencyKey(idempotencyKey);
    if (!existing) {
      return null;
    }
    if (existing.payloadFingerprint !== expectedFingerprint) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    return existing;
  }

  private buildEnsureAccountStatement(spec: AccountSpec, nowIso: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO ledger_accounts (
          id, owner_type, owner_id, account_code, currency,
          settled_balance_units, inflight_balance_units, allow_negative,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'USDC', 0, 0, ?, ?, ?)`
      )
      .bind(
        spec.id,
        spec.ownerType,
        spec.ownerId,
        spec.accountCode,
        spec.allowNegative,
        nowIso,
        nowIso
      );
  }

  private buildPostingAndBalanceStatements(
    batchId: string,
    postings: PlannedPosting[],
    nowIso: string
  ): D1PreparedStatement[] {
    assertBalancedPostings(postings);
    const statements: D1PreparedStatement[] = [];
    const seenAccounts = new Set<string>();

    for (const p of postings) {
      if (!seenAccounts.has(p.account.id)) {
        seenAccounts.add(p.account.id);
        statements.push(this.buildEnsureAccountStatement(p.account, nowIso));
      }
    }

    for (const p of postings) {
      const amountInt = toSafeSqlInteger(p.amountUnits, p.legRole);
      statements.push(
        this.db
          .prepare(
            `INSERT INTO ledger_postings (
              id, batch_id, account_id, direction, amount_units, leg_role, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(p.id, batchId, p.account.id, p.direction, amountInt, p.legRole, nowIso)
      );

      const signedDelta = p.direction === 'CREDIT' ? amountInt : -amountInt;
      if (p.balanceBucket === 'inflight') {
        statements.push(
          this.db
            .prepare(
              `UPDATE ledger_accounts
               SET inflight_balance_units = CASE
                     WHEN allow_negative = 1 OR inflight_balance_units + ? >= 0
                     THEN inflight_balance_units + ?
                     ELSE NULL
                   END,
                   updated_at = ?
               WHERE id = ?`
            )
            .bind(signedDelta, signedDelta, nowIso, p.account.id)
        );
      } else {
        statements.push(
          this.db
            .prepare(
              `UPDATE ledger_accounts
               SET settled_balance_units = CASE
                     WHEN allow_negative = 1 OR settled_balance_units + ? >= 0
                     THEN settled_balance_units + ?
                     ELSE NULL
                   END,
                   updated_at = ?
               WHERE id = ?`
            )
            .bind(signedDelta, signedDelta, nowIso, p.account.id)
        );
      }
    }

    return statements;
  }

  /**
   * Record a reconciled partner commission batch in two-phase `INFLIGHT` state
   * with a `T+7` hold (`hold_until = createdAt + 7 days`).
   */
  async recordVerifiedCommissionInflight(
    input: RecordVerifiedCommissionInput
  ): Promise<RecordCommissionResult> {
    await assertLedgerNotFrozen(this.db);

    if (!isSupportedPartnerExchange(input.exchange)) {
      throw new LedgerUnitValidationError(`Unsupported exchange: "${String(input.exchange)}"`);
    }
    if (!input.traderUid || input.traderUid.trim() === '') {
      throw new LedgerUnitValidationError('traderUid must be a non-empty string');
    }
    if (!input.traderId || input.traderId.trim() === '') {
      throw new LedgerUnitValidationError('traderId must be a non-empty string');
    }
    if (
      typeof input.grossCommissionUnits !== 'bigint' ||
      input.grossCommissionUnits <= BI_ZERO
    ) {
      throw new LedgerUnitValidationError(
        'grossCommissionUnits must be a positive bigint (> 0)'
      );
    }

    const l1AffiliateId = input.l1AffiliateId?.trim() || null;
    const b2bAgencyId = input.b2bAgencyId?.trim() || null;

    const waterfall = computeSafeSpreadWaterfall(input.grossCommissionUnits, {
      config: input.waterfallConfig,
      hasL1Referrer: l1AffiliateId !== null,
      hasB2bAgencyPartner: b2bAgencyId !== null,
    });

    // `reconciliationId` and `evidenceId` identify the statement batch that
    // reported the trade, not the trade itself. A poller lookback window can
    // legitimately re-ingest the same trade under a new batch id, and that
    // replay must resolve to the same idempotency fingerprint instead of
    // minting a duplicate inflight batch. Every economically meaningful field
    // stays in the fingerprint so a mutated amount or attribution still raises
    // `IdempotencyConflictError`.
    const fingerprint = await computePayloadFingerprint({
      op: 'COMMISSION_INFLIGHT',
      exchange: input.exchange,
      traderUid: input.traderUid.trim(),
      traderId: input.traderId.trim(),
      l1AffiliateId,
      b2bAgencyId,
      grossCommissionUnits: input.grossCommissionUnits,
      waterfallConfig: waterfall.config,
    });

    const replayBatch = await this.checkIdempotencyReplay(input.idempotencyKey, fingerprint);
    if (replayBatch) {
      const replayPostings = await this.getPostingsForBatch(replayBatch.id);
      return {
        batch: replayBatch,
        postings: replayPostings,
        waterfall,
        isReplay: true,
      };
    }

    // Enforce Gate G2 / G9 CASH_COLLECTED & R2 SHA-256 trust boundary
    await assertReconciliationEligibleForMinting(this.db, {
      reconciliationId: input.reconciliationId,
      evidenceId: input.evidenceId,
      exchange: input.exchange,
      grossCommissionUnits: input.grossCommissionUnits,
      r2: input.r2,
    });

    const createdAt = input.createdAt ?? new Date().toISOString();
    const createdMs = Date.parse(createdAt);
    if (Number.isNaN(createdMs)) {
      throw new LedgerUnitValidationError(`Invalid createdAt ISO string: "${createdAt}"`);
    }
    const holdUntil = new Date(createdMs + T_PLUS_7_HOLD_MS).toISOString();
    const batchId = `lbatch_${globalThis.crypto.randomUUID()}`;

    const metadata: CommissionBatchMetadata = {
      traderId: input.traderId.trim(),
      l1AffiliateId,
      b2bAgencyId,
      waterfallConfig: waterfall.config,
      initialLegs: {
        cashCollectedUnits: waterfall.cashCollectedUnits.toString(),
        reserveUnits: waterfall.reserveUnits.toString(),
        traderCashbackUnits: waterfall.traderCashbackUnits.toString(),
        l1CommissionUnits: waterfall.l1CommissionUnits.toString(),
        l2CommissionUnits: waterfall.l2CommissionUnits.toString(),
        platformNetUnits: waterfall.platformNetUnits.toString(),
      },
      remainingLegs: {
        grossUnits: waterfall.cashCollectedUnits.toString(),
        reserveUnits: waterfall.reserveUnits.toString(),
        traderCashbackUnits: waterfall.traderCashbackUnits.toString(),
        l1CommissionUnits: waterfall.l1CommissionUnits.toString(),
        l2CommissionUnits: waterfall.l2CommissionUnits.toString(),
        platformNetUnits: waterfall.platformNetUnits.toString(),
      },
      clawedBackUnits: '0',
    };

    const receivableSpec = partnerReceivableAccount(input.exchange);
    const traderSpec = buildAccountSpec('trader', input.traderId.trim(), false);

    const plannedPostings: PlannedPosting[] = [
      {
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: receivableSpec,
        direction: 'DEBIT',
        amountUnits: waterfall.cashCollectedUnits,
        legRole: 'PARTNER_RECEIVABLE_INFLIGHT',
        balanceBucket: 'inflight',
      },
    ];

    if (waterfall.reserveUnits > BI_ZERO) {
      plannedPostings.push({
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: CLAWBACK_POOL_ACCOUNT,
        direction: 'CREDIT',
        amountUnits: waterfall.reserveUnits,
        legRole: 'CLAWBACK_RESERVE',
        balanceBucket: 'inflight',
      });
    }

    if (waterfall.traderCashbackUnits > BI_ZERO) {
      plannedPostings.push({
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: traderSpec,
        direction: 'CREDIT',
        amountUnits: waterfall.traderCashbackUnits,
        legRole: 'TRADER_CASHBACK',
        balanceBucket: 'inflight',
      });
    }

    if (waterfall.l1CommissionUnits > BI_ZERO && l1AffiliateId) {
      plannedPostings.push({
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: buildAccountSpec('affiliate', l1AffiliateId, false),
        direction: 'CREDIT',
        amountUnits: waterfall.l1CommissionUnits,
        legRole: 'L1_AFFILIATE_COMMISSION',
        balanceBucket: 'inflight',
      });
    }

    if (waterfall.l2CommissionUnits > BI_ZERO && b2bAgencyId) {
      plannedPostings.push({
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: buildAccountSpec('agency', b2bAgencyId, false),
        direction: 'CREDIT',
        amountUnits: waterfall.l2CommissionUnits,
        legRole: 'B2B_AGENCY_OVERRIDE',
        balanceBucket: 'inflight',
      });
    }

    if (waterfall.platformNetUnits > BI_ZERO) {
      plannedPostings.push({
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: PLATFORM_REVENUE_ACCOUNT,
        direction: 'CREDIT',
        amountUnits: waterfall.platformNetUnits,
        legRole: 'PLATFORM_NET_REVENUE',
        balanceBucket: 'inflight',
      });
    }

    const grossUnitsInt = toSafeSqlInteger(
      waterfall.cashCollectedUnits,
      'gross_commission_units'
    );
    const atomicReconCapStmt = this.db
      .prepare(
        `UPDATE partner_cash_reconciliations
         SET minted_gross_units = CASE
               WHEN status = 'MATCHED'
                AND minted_gross_units + ? <= uid_allocated_units
                AND minted_gross_units + ? <= wallet_cash_collected_units + clawback_offset_units
               THEN minted_gross_units + ?
               ELSE NULL
             END
         WHERE id = ?`
      )
      .bind(grossUnitsInt, grossUnitsInt, grossUnitsInt, input.reconciliationId);

    const batchInsertStmt = this.db
      .prepare(
        `INSERT INTO ledger_journal_batches (
          id, idempotency_key, payload_fingerprint, journal_type, status,
          exchange, trader_uid, reconciliation_id, evidence_id,
          gross_commission_units, hold_until, settled_tx_hash,
          metadata, created_at, updated_at
        ) VALUES (?, ?, ?, 'COMMISSION_INFLIGHT', 'INFLIGHT', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .bind(
        batchId,
        input.idempotencyKey,
        fingerprint,
        input.exchange,
        input.traderUid.trim(),
        input.reconciliationId,
        input.evidenceId,
        grossUnitsInt,
        holdUntil,
        JSON.stringify(metadata),
        createdAt,
        createdAt
      );

    const postingStmts = this.buildPostingAndBalanceStatements(
      batchId,
      plannedPostings,
      createdAt
    );

    // Atomic batch enforces both reconciliation cap (via NOT NULL CASE rollback) and balanced postings!
    await this.db.batch([atomicReconCapStmt, batchInsertStmt, ...postingStmts]);

    const committedBatch = await this.getBatchById(batchId);
    const committedPostings = await this.getPostingsForBatch(batchId);
    if (!committedBatch) {
      throw new LedgerInvariantError(`Committed batch "${batchId}" missing after atomic batch`);
    }

    return {
      batch: committedBatch,
      postings: committedPostings,
      waterfall,
      isReplay: false,
    };
  }

  /**
   * Release a matured `COMMISSION_INFLIGHT` batch (`nowIso >= hold_until`),
   * atomically moving remaining `inflight_balance_units` -> `settled_balance_units`
   * and marking the batch `'SETTLED'`.
   */
  async releaseMaturedInflightBatch(
    batchId: string,
    nowIso: string = new Date().toISOString()
  ): Promise<ReleaseInflightResult> {
    await assertLedgerNotFrozen(this.db);

    const nowMs = Date.parse(nowIso);
    if (Number.isNaN(nowMs)) {
      throw new LedgerUnitValidationError(`Invalid nowIso timestamp: "${nowIso}"`);
    }

    const batch = await this.getBatchById(batchId);
    if (!batch) {
      throw new LedgerStateTransitionError(`Batch "${batchId}" does not exist`);
    }
    if (batch.journalType !== 'COMMISSION_INFLIGHT') {
      throw new LedgerStateTransitionError(
        `Batch "${batchId}" has journal_type "${batch.journalType}"; only COMMISSION_INFLIGHT batches settle after T+7`
      );
    }

    const meta = batch.metadata as unknown as Partial<CommissionBatchMetadata>;
    const rem = meta.remainingLegs;
    if (!rem || !meta.traderId || !batch.exchange) {
      throw new LedgerInvariantError(`Batch "${batchId}" is missing commission leg metadata`);
    }

    const remGross = BigInt(rem.grossUnits);
    if (batch.status === 'SETTLED') {
      return {
        batch,
        settledUnits: remGross,
        isReplay: true,
      };
    }
    if (batch.status === 'VOIDED') {
      throw new LedgerStateTransitionError(
        `Cannot settle batch "${batchId}" because it was VOIDED by clawback`
      );
    }

    if (!batch.holdUntil || nowMs < Date.parse(batch.holdUntil)) {
      throw new HoldPeriodNotMaturedError(batchId, batch.holdUntil ?? 'UNSET', nowIso);
    }

    const remReserve = BigInt(rem.reserveUnits);
    const remTrader = BigInt(rem.traderCashbackUnits);
    const remL1 = BigInt(rem.l1CommissionUnits);
    const remL2 = BigInt(rem.l2CommissionUnits);
    const remPlatform = BigInt(rem.platformNetUnits);

    if (remReserve + remTrader + remL1 + remL2 + remPlatform !== remGross) {
      throw new LedgerInvariantError(
        `Batch "${batchId}" remaining legs do not sum to remaining gross units`
      );
    }

    const stmts: D1PreparedStatement[] = [];

    const addTransition = (spec: AccountSpec, creditUnits: bigint, isDebit: boolean) => {
      if (creditUnits === BI_ZERO) {
        return;
      }
      const amt = toSafeSqlInteger(creditUnits, spec.accountCode);
      const signed = isDebit ? -amt : amt;
      stmts.push(
        this.db
          .prepare(
            `UPDATE ledger_accounts
             SET inflight_balance_units = CASE
                   WHEN allow_negative = 1 OR inflight_balance_units - ? >= 0
                   THEN inflight_balance_units - ?
                   ELSE NULL
                 END,
                 settled_balance_units = settled_balance_units + ?,
                 updated_at = ?
             WHERE id = ?`
          )
          .bind(signed, signed, signed, nowIso, spec.id)
      );
    };

    addTransition(partnerReceivableAccount(batch.exchange), remGross, true);
    addTransition(CLAWBACK_POOL_ACCOUNT, remReserve, false);
    addTransition(buildAccountSpec('trader', meta.traderId, false), remTrader, false);
    if (meta.l1AffiliateId && remL1 > BI_ZERO) {
      addTransition(buildAccountSpec('affiliate', meta.l1AffiliateId, false), remL1, false);
    }
    if (meta.b2bAgencyId && remL2 > BI_ZERO) {
      addTransition(buildAccountSpec('agency', meta.b2bAgencyId, false), remL2, false);
    }
    addTransition(PLATFORM_REVENUE_ACCOUNT, remPlatform, false);

    stmts.push(
      this.db
        .prepare(
          `UPDATE ledger_journal_batches
           SET status = CASE WHEN status = 'INFLIGHT' AND updated_at = ? THEN 'SETTLED' ELSE NULL END,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(batch.updatedAt, nowIso, batchId)
    );

    const results = await this.db.batch(stmts);
    const statusUpdateResult = results[results.length - 1];
    if (!statusUpdateResult || statusUpdateResult.meta.changes !== 1) {
      throw new LedgerStateTransitionError(
        `Concurrent state change prevented settling batch "${batchId}"`
      );
    }

    const updatedBatch = await this.getBatchById(batchId);
    if (!updatedBatch) {
      throw new LedgerInvariantError(`Settled batch "${batchId}" missing after update`);
    }

    return {
      batch: updatedBatch,
      settledUnits: remGross,
      isReplay: false,
    };
  }

  /**
   * Apply a partner commission clawback against `originalBatchId`:
   * - If `originalBatch.status === 'INFLIGHT'` (`< T+7`): reverses proportional
   *   `inflight_balance_units` cleanly (`COMMISSION_VOID_CLAWBACK`) without
   *   touching `settled_balance_units`.
   * - If `originalBatch.status === 'SETTLED'` (`>= T+7`): debits `reserve:clawback_pool`
   *   first (`POST_SETTLEMENT_CLAWBACK`), optionally recovers from open trader inflight
   *   batches if `recoverFromFutureInflight === true`, then absorbs from
   *   `system:platform_revenue` and `system:unrecovered_clawback_expense` so no user's
   *   `settled_balance_units` ever drops `< 0`.
   */
  async applyClawback(input: ApplyClawbackInput): Promise<ApplyClawbackResult> {
    await assertLedgerNotFrozen(this.db);

    if (typeof input.clawbackUnits !== 'bigint' || input.clawbackUnits <= BI_ZERO) {
      throw new LedgerUnitValidationError('clawbackUnits must be a positive bigint (> 0)');
    }
    if (!input.reason || input.reason.trim() === '') {
      throw new LedgerUnitValidationError('Clawback reason must be a non-empty string');
    }

    const fingerprint = await computePayloadFingerprint({
      op: 'CLAWBACK',
      originalBatchId: input.originalBatchId,
      clawbackUnits: input.clawbackUnits,
      reason: input.reason.trim(),
      recoverFromFutureInflight: Boolean(input.recoverFromFutureInflight),
    });

    const replayBatch = await this.checkIdempotencyReplay(input.idempotencyKey, fingerprint);
    if (replayBatch) {
      const replayPostings = await this.getPostingsForBatch(replayBatch.id);
      const rMeta = replayBatch.metadata;
      return {
        clawbackBatch: replayBatch,
        postings: replayPostings,
        mode:
          replayBatch.journalType === 'COMMISSION_VOID_CLAWBACK'
            ? 'INFLIGHT_VOID'
            : 'POST_SETTLEMENT_RESERVE',
        reserveDebitedUnits: BigInt(String(rMeta.reserveDebitedUnits ?? '0')),
        futureInflightRecoveredUnits: BigInt(
          String(rMeta.futureInflightRecoveredUnits ?? '0')
        ),
        platformAbsorbedUnits: BigInt(String(rMeta.platformAbsorbedUnits ?? '0')),
        unrecoveredExpenseUnits: BigInt(String(rMeta.unrecoveredExpenseUnits ?? '0')),
        isReplay: true,
      };
    }

    const original = await this.getBatchById(input.originalBatchId);
    if (!original || original.journalType !== 'COMMISSION_INFLIGHT' || !original.exchange) {
      throw new LedgerStateTransitionError(
        `Original COMMISSION_INFLIGHT batch "${input.originalBatchId}" not found`
      );
    }

    const origMeta = original.metadata as unknown as CommissionBatchMetadata;
    const metaRemGross = BigInt(origMeta.remainingLegs.grossUnits);
    const metaClawedBack = BigInt(origMeta.clawedBackUnits);

    const priorClawbackRow = await this.db
      .prepare(
        `SELECT COALESCE(SUM(gross_commission_units), 0) AS total_clawed_units
         FROM ledger_journal_batches
         WHERE journal_type IN ('COMMISSION_VOID_CLAWBACK', 'POST_SETTLEMENT_CLAWBACK')
           AND status = 'SETTLED'
           AND json_extract(metadata, '$.originalBatchId') = ?`
      )
      .bind(original.id)
      .first<{ total_clawed_units: number }>();

    const ledgerSumClawedUnits = fromSqlInteger(
      priorClawbackRow?.total_clawed_units ?? 0,
      'total_clawed_units'
    );
    const alreadyClawedUnits =
      ledgerSumClawedUnits >= metaClawedBack ? ledgerSumClawedUnits : metaClawedBack;
    const capRemGross =
      original.grossCommissionUnits > alreadyClawedUnits
        ? original.grossCommissionUnits - alreadyClawedUnits
        : BI_ZERO;
    const remGross = metaRemGross <= capRemGross ? metaRemGross : capRemGross;

    if (original.status === 'VOIDED' || remGross === BI_ZERO) {
      throw new LedgerStateTransitionError(
        `Batch "${original.id}" has already been 100% clawed back`
      );
    }
    if (
      input.clawbackUnits > remGross ||
      alreadyClawedUnits + input.clawbackUnits > original.grossCommissionUnits
    ) {
      throw new LedgerUnitValidationError(
        `Clawback amount ${input.clawbackUnits.toString()} exceeds remaining clawbackable gross ${remGross.toString()} on batch "${original.id}"`
      );
    }

    const nowIso = input.nowIso ?? new Date().toISOString();
    const clawbackBatchId = `lbatch_${globalThis.crypto.randomUUID()}`;
    const clawbackUnitsInt = toSafeSqlInteger(input.clawbackUnits, 'clawback_units');
    const receivableSpec = partnerReceivableAccount(original.exchange);

    if (original.status === 'INFLIGHT') {
      const remReserve = BigInt(origMeta.remainingLegs.reserveUnits);
      const remTrader = BigInt(origMeta.remainingLegs.traderCashbackUnits);
      const remL1 = BigInt(origMeta.remainingLegs.l1CommissionUnits);
      const remL2 = BigInt(origMeta.remainingLegs.l2CommissionUnits);
      const remPlatform = BigInt(origMeta.remainingLegs.platformNetUnits);

      const [dReserve, dTrader, dL1, dL2, dPlatform] = allocateProportionalReduction(
        [remReserve, remTrader, remL1, remL2, remPlatform],
        input.clawbackUnits,
        remGross
      );

      const plannedPostings: PlannedPosting[] = [
        {
          id: `lpost_${globalThis.crypto.randomUUID()}`,
          account: receivableSpec,
          direction: 'CREDIT',
          amountUnits: input.clawbackUnits,
          legRole: 'PARTNER_RECEIVABLE_CLAWBACK',
          balanceBucket: 'inflight',
        },
      ];

      if (dReserve > BI_ZERO) {
        plannedPostings.push({
          id: `lpost_${globalThis.crypto.randomUUID()}`,
          account: CLAWBACK_POOL_ACCOUNT,
          direction: 'DEBIT',
          amountUnits: dReserve,
          legRole: 'CLAWBACK_RESERVE_REVERSAL',
          balanceBucket: 'inflight',
        });
      }
      if (dTrader > BI_ZERO) {
        plannedPostings.push({
          id: `lpost_${globalThis.crypto.randomUUID()}`,
          account: buildAccountSpec('trader', origMeta.traderId, false),
          direction: 'DEBIT',
          amountUnits: dTrader,
          legRole: 'TRADER_INFLIGHT_REVERSAL',
          balanceBucket: 'inflight',
        });
      }
      if (dL1 > BI_ZERO && origMeta.l1AffiliateId) {
        plannedPostings.push({
          id: `lpost_${globalThis.crypto.randomUUID()}`,
          account: buildAccountSpec('affiliate', origMeta.l1AffiliateId, false),
          direction: 'DEBIT',
          amountUnits: dL1,
          legRole: 'L1_INFLIGHT_REVERSAL',
          balanceBucket: 'inflight',
        });
      }
      if (dL2 > BI_ZERO && origMeta.b2bAgencyId) {
        plannedPostings.push({
          id: `lpost_${globalThis.crypto.randomUUID()}`,
          account: buildAccountSpec('agency', origMeta.b2bAgencyId, false),
          direction: 'DEBIT',
          amountUnits: dL2,
          legRole: 'B2B_INFLIGHT_REVERSAL',
          balanceBucket: 'inflight',
        });
      }
      if (dPlatform > BI_ZERO) {
        plannedPostings.push({
          id: `lpost_${globalThis.crypto.randomUUID()}`,
          account: PLATFORM_REVENUE_ACCOUNT,
          direction: 'DEBIT',
          amountUnits: dPlatform,
          legRole: 'PLATFORM_INFLIGHT_REVERSAL',
          balanceBucket: 'inflight',
        });
      }

      const newRemGross = remGross - input.clawbackUnits;
      const updatedOrigMeta: CommissionBatchMetadata = {
        ...origMeta,
        remainingLegs: {
          grossUnits: newRemGross.toString(),
          reserveUnits: (remReserve - dReserve).toString(),
          traderCashbackUnits: (remTrader - dTrader).toString(),
          l1CommissionUnits: (remL1 - dL1).toString(),
          l2CommissionUnits: (remL2 - dL2).toString(),
          platformNetUnits: (remPlatform - dPlatform).toString(),
        },
        clawedBackUnits: (
          alreadyClawedUnits + input.clawbackUnits
        ).toString(),
      };

      const newOrigStatus: LedgerBatchStatus = newRemGross === BI_ZERO ? 'VOIDED' : 'INFLIGHT';
      const clawbackMetadata = {
        originalBatchId: original.id,
        reason: input.reason.trim(),
        clawbackUnits: input.clawbackUnits.toString(),
        reserveDebitedUnits: dReserve.toString(),
        futureInflightRecoveredUnits: '0',
        platformAbsorbedUnits: dPlatform.toString(),
        unrecoveredExpenseUnits: '0',
      };

      const insertClawbackBatchStmt = this.db
        .prepare(
          `INSERT INTO ledger_journal_batches (
            id, idempotency_key, payload_fingerprint, journal_type, status,
            exchange, trader_uid, reconciliation_id, evidence_id,
            gross_commission_units, hold_until, settled_tx_hash,
            metadata, created_at, updated_at
          ) VALUES (?, ?, ?, 'COMMISSION_VOID_CLAWBACK', 'SETTLED', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
        )
        .bind(
          clawbackBatchId,
          input.idempotencyKey,
          fingerprint,
          original.exchange,
          original.traderUid,
          original.reconciliationId,
          original.evidenceId,
          toSafeSqlInteger(input.clawbackUnits, 'clawback_units'),
          JSON.stringify(clawbackMetadata),
          nowIso,
          nowIso
        );

      const updateOriginalStmt = this.db
        .prepare(
          `UPDATE ledger_journal_batches AS orig
           SET status = CASE
                 WHEN orig.status = 'INFLIGHT'
                  AND orig.updated_at = ?
                  AND json_extract(orig.metadata, '$.clawedBackUnits') = ?
                  AND json_extract(orig.metadata, '$.remainingLegs.grossUnits') = ?
                  AND CAST(json_extract(orig.metadata, '$.clawedBackUnits') AS INTEGER) + ? <= orig.gross_commission_units
                  AND (
                        SELECT COALESCE(SUM(cb.gross_commission_units), 0)
                        FROM ledger_journal_batches cb
                        WHERE cb.journal_type IN ('COMMISSION_VOID_CLAWBACK', 'POST_SETTLEMENT_CLAWBACK')
                          AND cb.status = 'SETTLED'
                          AND json_extract(cb.metadata, '$.originalBatchId') = ?
                      ) <= orig.gross_commission_units
                 THEN ?
                 ELSE NULL
               END,
               metadata = ?,
               updated_at = ?
           WHERE orig.id = ?`
        )
        .bind(
          original.updatedAt,
          origMeta.clawedBackUnits,
          origMeta.remainingLegs.grossUnits,
          clawbackUnitsInt,
          original.id,
          newOrigStatus,
          JSON.stringify(updatedOrigMeta),
          nowIso,
          original.id
        );

      const postingStmts = this.buildPostingAndBalanceStatements(
        clawbackBatchId,
        plannedPostings,
        nowIso
      );

      let inflightBatchResults: D1Result[];
      try {
        // Order `updateOriginalStmt` AFTER `insertClawbackBatchStmt` so the cumulative
        // `SUM(cb.gross_commission_units)` subquery includes the newly inserted clawback row.
        inflightBatchResults = await this.db.batch([
          insertClawbackBatchStmt,
          updateOriginalStmt,
          ...postingStmts,
        ]);
      } catch (err) {
        throw translateClawbackConstraintError(err, original.id, input.clawbackUnits);
      }

      const inflightOriginalResult = inflightBatchResults[1];
      if (!inflightOriginalResult || inflightOriginalResult.meta.changes !== 1) {
        throw new LedgerStateTransitionError(
          `Concurrent state change prevented applying clawback to batch "${original.id}"`
        );
      }

      const committed = await this.getBatchById(clawbackBatchId);
      const committedPostings = await this.getPostingsForBatch(clawbackBatchId);
      if (!committed) {
        throw new LedgerInvariantError('Clawback batch missing after commit');
      }

      return {
        clawbackBatch: committed,
        postings: committedPostings,
        mode: 'INFLIGHT_VOID',
        reserveDebitedUnits: dReserve,
        futureInflightRecoveredUnits: BI_ZERO,
        platformAbsorbedUnits: dPlatform,
        unrecoveredExpenseUnits: BI_ZERO,
        isReplay: false,
      };
    }

    // Post-settlement clawback (`original.status === 'SETTLED'`):
    // 1) Debit `reserve:clawback_pool` first (up to settled reserve balance)
    const reserveAcct = await this.getAccountByCode(CLAWBACK_POOL_ACCOUNT.accountCode);
    const availableReserve = reserveAcct ? reserveAcct.settledBalanceUnits : BI_ZERO;
    const reserveDebitedUnits =
      availableReserve >= input.clawbackUnits ? input.clawbackUnits : availableReserve;
    let remainingToCover = input.clawbackUnits - reserveDebitedUnits;

    // 2) Optional recovery from open INFLIGHT batches of the same trader
    let futureInflightRecoveredUnits = BI_ZERO;
    const extraBatchUpdateStmts: D1PreparedStatement[] = [];
    const plannedPostings: PlannedPosting[] = [];

    if (remainingToCover > BI_ZERO && input.recoverFromFutureInflight && original.traderUid) {
      const openTraderBatchesRes = await this.db
        .prepare(
          `SELECT id, idempotency_key, payload_fingerprint, journal_type, status,
                  exchange, trader_uid, reconciliation_id, evidence_id,
                  gross_commission_units, hold_until, settled_tx_hash,
                  metadata, created_at, updated_at
           FROM ledger_journal_batches
           WHERE exchange = ? AND trader_uid = ?
           ORDER BY created_at ASC`
        )
        .bind(original.exchange, original.traderUid)
        .all<RawBatchRow>();

      const traderSpec = buildAccountSpec('trader', origMeta.traderId, false);
      for (const candidateRow of openTraderBatchesRes.results ?? []) {
        if (remainingToCover === BI_ZERO) {
          break;
        }
        if (
          candidateRow.status !== 'INFLIGHT' ||
          candidateRow.journal_type !== 'COMMISSION_INFLIGHT'
        ) {
          continue;
        }
        const candMeta = parseJsonObject(
          candidateRow.metadata
        ) as unknown as CommissionBatchMetadata;
        const candTraderRem = BigInt(candMeta.remainingLegs.traderCashbackUnits);
        const candGrossRem = BigInt(candMeta.remainingLegs.grossUnits);
        if (candTraderRem <= BI_ZERO) {
          continue;
        }
        const take =
          candTraderRem >= remainingToCover ? remainingToCover : candTraderRem;

        // Move `take` on the candidate batch from trader leg into receivable? Wait:
        // On a post-settlement clawback, `receivable.settled` is credited for the full `clawbackUnits`.
        // If we debit `trader.inflight` by `take`, then when `candidateRow` later settles,
        // `candidateRow` has `candTraderRem - take` trader cashback and `candPlatformRem + take`?
        // Wait: if `candGrossRem` stays backed by `receivable.inflight`, reducing ONLY `candTraderRem`
        // without reducing `candGrossRem` would unbalance `candidateRow`!
        // Instead, we reduce `candTraderRem` by `take` AND increase `candPlatformRem` by `take`? No,
        // if we debit `trader.inflight` by `take`, `trader.inflight` drops by `take`, so `candidateRow`'s
        // trader leg drops by `take` AND `receivable` needs to match: we credit `receivable.inflight` by `take`
        // and only credit `receivable.settled` by `clawbackUnits - futureInflightRecoveredUnits`!
        const newCandGross = candGrossRem - take;
        const updatedCandMeta: CommissionBatchMetadata = {
          ...candMeta,
          remainingLegs: {
            ...candMeta.remainingLegs,
            grossUnits: newCandGross.toString(),
            traderCashbackUnits: (candTraderRem - take).toString(),
          },
          clawedBackUnits: (BigInt(candMeta.clawedBackUnits) + take).toString(),
        };
        const newCandStatus: LedgerBatchStatus =
          newCandGross === BI_ZERO ? 'VOIDED' : 'INFLIGHT';

        extraBatchUpdateStmts.push(
          this.db
            .prepare(
              `UPDATE ledger_journal_batches
               SET status = CASE WHEN status = 'INFLIGHT' AND updated_at = ? THEN ? ELSE NULL END,
                   metadata = ?,
                   updated_at = ?
               WHERE id = ?`
            )
            .bind(
              candidateRow.updated_at,
              newCandStatus,
              JSON.stringify(updatedCandMeta),
              nowIso,
              candidateRow.id
            )
        );

        plannedPostings.push({
          id: `lpost_${globalThis.crypto.randomUUID()}`,
          account: traderSpec,
          direction: 'DEBIT',
          amountUnits: take,
          legRole: 'POST_SETTLEMENT_FUTURE_INFLIGHT_RECOVERY',
          balanceBucket: 'inflight',
        });

        futureInflightRecoveredUnits += take;
        remainingToCover -= take;
      }
    }

    // 3) Absorb remaining from `system:platform_revenue` settled balance
    const platformAcct = await this.getAccountByCode(PLATFORM_REVENUE_ACCOUNT.accountCode);
    const availablePlatform = platformAcct ? platformAcct.settledBalanceUnits : BI_ZERO;
    const platformAbsorbedUnits =
      availablePlatform >= remainingToCover ? remainingToCover : availablePlatform;
    remainingToCover -= platformAbsorbedUnits;

    // 4) Any excess beyond reserve + future inflight + platform revenue hits system expense
    const unrecoveredExpenseUnits = remainingToCover;

    const settledReceivableCredit = input.clawbackUnits - futureInflightRecoveredUnits;
    if (settledReceivableCredit > BI_ZERO) {
      plannedPostings.push({
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: receivableSpec,
        direction: 'CREDIT',
        amountUnits: settledReceivableCredit,
        legRole: 'PARTNER_RECEIVABLE_POST_SETTLEMENT_CLAWBACK',
        balanceBucket: 'settled',
      });
    }
    if (futureInflightRecoveredUnits > BI_ZERO) {
      plannedPostings.push({
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: receivableSpec,
        direction: 'CREDIT',
        amountUnits: futureInflightRecoveredUnits,
        legRole: 'PARTNER_RECEIVABLE_INFLIGHT_OFFSET',
        balanceBucket: 'inflight',
      });
    }
    if (reserveDebitedUnits > BI_ZERO) {
      plannedPostings.push({
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: CLAWBACK_POOL_ACCOUNT,
        direction: 'DEBIT',
        amountUnits: reserveDebitedUnits,
        legRole: 'CLAWBACK_RESERVE_ABSORPTION',
        balanceBucket: 'settled',
      });
    }
    if (platformAbsorbedUnits > BI_ZERO) {
      plannedPostings.push({
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: PLATFORM_REVENUE_ACCOUNT,
        direction: 'DEBIT',
        amountUnits: platformAbsorbedUnits,
        legRole: 'PLATFORM_REVENUE_CLAWBACK_ABSORPTION',
        balanceBucket: 'settled',
      });
    }
    if (unrecoveredExpenseUnits > BI_ZERO) {
      plannedPostings.push({
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: UNRECOVERED_CLAWBACK_ACCOUNT,
        direction: 'DEBIT',
        amountUnits: unrecoveredExpenseUnits,
        legRole: 'UNRECOVERED_CLAWBACK_DEFICIT',
        balanceBucket: 'settled',
      });
    }

    const settledNewRemGross = remGross - input.clawbackUnits;
    const updatedSettledOrigMeta: CommissionBatchMetadata = {
      ...origMeta,
      remainingLegs: {
        ...origMeta.remainingLegs,
        grossUnits: settledNewRemGross.toString(),
      },
      clawedBackUnits: (
        alreadyClawedUnits + input.clawbackUnits
      ).toString(),
    };
    const newSettledOrigStatus: LedgerBatchStatus =
      settledNewRemGross === BI_ZERO ? 'VOIDED' : 'SETTLED';

    const postMetadata = {
      originalBatchId: original.id,
      reason: input.reason.trim(),
      clawbackUnits: input.clawbackUnits.toString(),
      reserveDebitedUnits: reserveDebitedUnits.toString(),
      futureInflightRecoveredUnits: futureInflightRecoveredUnits.toString(),
      platformAbsorbedUnits: platformAbsorbedUnits.toString(),
      unrecoveredExpenseUnits: unrecoveredExpenseUnits.toString(),
    };

    const insertPostClawbackStmt = this.db
      .prepare(
        `INSERT INTO ledger_journal_batches (
          id, idempotency_key, payload_fingerprint, journal_type, status,
          exchange, trader_uid, reconciliation_id, evidence_id,
          gross_commission_units, hold_until, settled_tx_hash,
          metadata, created_at, updated_at
        ) VALUES (?, ?, ?, 'POST_SETTLEMENT_CLAWBACK', 'SETTLED', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
      )
      .bind(
        clawbackBatchId,
        input.idempotencyKey,
        fingerprint,
        original.exchange,
        original.traderUid,
        original.reconciliationId,
        original.evidenceId,
        toSafeSqlInteger(input.clawbackUnits, 'clawback_units'),
        JSON.stringify(postMetadata),
        nowIso,
        nowIso
      );

    const updateSettledOrigStmt = this.db
      .prepare(
        `UPDATE ledger_journal_batches AS orig
         SET status = CASE
               WHEN orig.status = 'SETTLED'
                AND orig.updated_at = ?
                AND json_extract(orig.metadata, '$.clawedBackUnits') = ?
                AND json_extract(orig.metadata, '$.remainingLegs.grossUnits') = ?
                AND CAST(json_extract(orig.metadata, '$.clawedBackUnits') AS INTEGER) + ? <= orig.gross_commission_units
                AND (
                      SELECT COALESCE(SUM(cb.gross_commission_units), 0)
                      FROM ledger_journal_batches cb
                      WHERE cb.journal_type IN ('COMMISSION_VOID_CLAWBACK', 'POST_SETTLEMENT_CLAWBACK')
                        AND cb.status = 'SETTLED'
                        AND json_extract(cb.metadata, '$.originalBatchId') = ?
                    ) <= orig.gross_commission_units
               THEN ?
               ELSE NULL
             END,
             metadata = ?,
             updated_at = ?
         WHERE orig.id = ?`
      )
      .bind(
        original.updatedAt,
        origMeta.clawedBackUnits,
        origMeta.remainingLegs.grossUnits,
        clawbackUnitsInt,
        original.id,
        newSettledOrigStatus,
        JSON.stringify(updatedSettledOrigMeta),
        nowIso,
        original.id
      );

    const postingStmts = this.buildPostingAndBalanceStatements(
      clawbackBatchId,
      plannedPostings,
      nowIso
    );

    let settledBatchResults: D1Result[];
    try {
      // Order `updateSettledOrigStmt` AFTER `insertPostClawbackStmt` so the cumulative
      // `SUM(cb.gross_commission_units)` subquery includes the newly inserted clawback row.
      settledBatchResults = await this.db.batch([
        insertPostClawbackStmt,
        updateSettledOrigStmt,
        ...extraBatchUpdateStmts,
        ...postingStmts,
      ]);
    } catch (err) {
      throw translateClawbackConstraintError(err, original.id, input.clawbackUnits);
    }

    const settledOriginalResult = settledBatchResults[1];
    if (!settledOriginalResult || settledOriginalResult.meta.changes !== 1) {
      throw new LedgerStateTransitionError(
        `Concurrent state change prevented applying clawback to batch "${original.id}"`
      );
    }

    const committed = await this.getBatchById(clawbackBatchId);
    const committedPostings = await this.getPostingsForBatch(clawbackBatchId);
    if (!committed) {
      throw new LedgerInvariantError('Post-settlement clawback batch missing after commit');
    }

    return {
      clawbackBatch: committed,
      postings: committedPostings,
      mode: 'POST_SETTLEMENT_RESERVE',
      reserveDebitedUnits,
      futureInflightRecoveredUnits,
      platformAbsorbedUnits,
      unrecoveredExpenseUnits,
      isReplay: false,
    };
  }

  /**
   * Atomically lock settled user funds into `treasury:withdrawal_escrow` prior to
   * Turnkey/Safe signing, guaranteeing `settled_balance_units >= 0`.
   */
  async lockSettledForWithdrawal(
    input: WithdrawalLockInput
  ): Promise<WithdrawalMutationResult> {
    await assertLedgerNotFrozen(this.db);

    if (typeof input.amountUnits !== 'bigint' || input.amountUnits <= BI_ZERO) {
      throw new LedgerUnitValidationError('Withdrawal amountUnits must be > 0');
    }
    const enforceMin = input.enforceMinimumThreshold ?? true;
    if (enforceMin && input.amountUnits < MIN_WITHDRAWAL_UNITS_1E8) {
      throw new LedgerUnitValidationError(
        `Withdrawal amount ${input.amountUnits.toString()} is below minimum $10.00 USDC threshold (${MIN_WITHDRAWAL_UNITS_1E8.toString()})`
      );
    }
    if (!input.ownerId || input.ownerId.trim() === '') {
      throw new LedgerUnitValidationError('ownerId must be a non-empty string');
    }
    if (!input.payoutId || input.payoutId.trim() === '') {
      throw new LedgerUnitValidationError('payoutId must be a non-empty string');
    }

    const fingerprint = await computePayloadFingerprint({
      op: 'WITHDRAWAL_LOCK',
      ownerType: input.ownerType,
      ownerId: input.ownerId.trim(),
      amountUnits: input.amountUnits,
      payoutId: input.payoutId.trim(),
    });

    const replayBatch = await this.checkIdempotencyReplay(input.idempotencyKey, fingerprint);
    if (replayBatch) {
      if (replayBatch.metadata.chain !== undefined && input.chain !== replayBatch.metadata.chain) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      return {
        batch: replayBatch,
        postings: await this.getPostingsForBatch(replayBatch.id),
        isReplay: true,
      };
    }

    const trimmedPayoutId = input.payoutId.trim();
    const existingPayoutLock = await this.getActiveWithdrawalLockByPayoutId(trimmedPayoutId);
    if (existingPayoutLock) {
      throw new IdempotencyConflictError(
        `payoutId:${trimmedPayoutId} already has an active or finalized withdrawal lock (${existingPayoutLock.id})`
      );
    }

    const userSpec = buildAccountSpec(input.ownerType, input.ownerId.trim(), false);
    const existingAcct = await this.getAccountByCode(userSpec.accountCode);
    const available = existingAcct ? existingAcct.settledBalanceUnits : BI_ZERO;
    if (available < input.amountUnits) {
      throw new InsufficientSettledBalanceError(
        userSpec.accountCode,
        input.amountUnits,
        available
      );
    }

    const nowIso = input.nowIso ?? new Date().toISOString();
    const batchId = `lbatch_${globalThis.crypto.randomUUID()}`;
    const metadata = {
      ownerType: input.ownerType,
      ownerId: input.ownerId.trim(),
      payoutId: trimmedPayoutId,
      lockedAmountUnits: input.amountUnits.toString(),
      ...(input.chain ? { chain: input.chain } : {}),
      resolution: 'LOCKED',
    };

    const plannedPostings: PlannedPosting[] = [
      {
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: userSpec,
        direction: 'DEBIT',
        amountUnits: input.amountUnits,
        legRole: 'USER_WITHDRAWAL_LOCK',
        balanceBucket: 'settled',
      },
      {
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: WITHDRAWAL_ESCROW_ACCOUNT,
        direction: 'CREDIT',
        amountUnits: input.amountUnits,
        legRole: 'TREASURY_ESCROW_LOCK',
        balanceBucket: 'settled',
      },
    ];

    const insertBatchStmt = this.db
      .prepare(
        `INSERT INTO ledger_journal_batches (
          id, idempotency_key, payload_fingerprint, journal_type, status,
          exchange, trader_uid, reconciliation_id, evidence_id,
          gross_commission_units, hold_until, settled_tx_hash, payout_id,
          metadata, created_at, updated_at
        ) VALUES (?, ?, ?, 'WITHDRAWAL_LOCK', 'INFLIGHT', NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?, ?)`
      )
      .bind(
        batchId,
        input.idempotencyKey,
        fingerprint,
        toSafeSqlInteger(input.amountUnits, 'withdrawal_amount_units'),
        trimmedPayoutId,
        JSON.stringify(metadata),
        nowIso,
        nowIso
      );

    const postingStmts = this.buildPostingAndBalanceStatements(
      batchId,
      plannedPostings,
      nowIso
    );

    await this.db.batch([insertBatchStmt, ...postingStmts]);

    const committed = await this.getBatchById(batchId);
    if (!committed) {
      throw new LedgerInvariantError('Withdrawal lock batch missing after commit');
    }

    return {
      batch: committed,
      postings: await this.getPostingsForBatch(batchId),
      isReplay: false,
    };
  }

  /**
   * Finalize a locked withdrawal after on-chain confirmation, recording `txHash`
   * and disbursing `treasury:withdrawal_escrow` -> `treasury:external_settlement`.
   */
  async finalizeWithdrawal(params: {
    idempotencyKey: string;
    lockBatchId: string;
    txHash: string;
    nowIso?: string;
  }): Promise<WithdrawalMutationResult> {
    await assertLedgerNotFrozen(this.db);

    if (!params.txHash || params.txHash.trim() === '') {
      throw new LedgerUnitValidationError('txHash must be a non-empty string');
    }

    const fingerprint = await computePayloadFingerprint({
      op: 'WITHDRAWAL_FINALIZED',
      lockBatchId: params.lockBatchId,
      txHash: params.txHash.trim(),
    });

    const replayBatch = await this.checkIdempotencyReplay(params.idempotencyKey, fingerprint);
    if (replayBatch) {
      return {
        batch: replayBatch,
        postings: await this.getPostingsForBatch(replayBatch.id),
        isReplay: true,
      };
    }

    const lockBatch = await this.getBatchById(params.lockBatchId);
    if (!lockBatch || lockBatch.journalType !== 'WITHDRAWAL_LOCK') {
      throw new LedgerStateTransitionError(
        `Withdrawal lock batch "${params.lockBatchId}" not found`
      );
    }
    if (lockBatch.status !== 'INFLIGHT') {
      throw new LedgerStateTransitionError(
        `Withdrawal lock batch "${params.lockBatchId}" is already resolved (${lockBatch.status})`
      );
    }

    const amountUnits = lockBatch.grossCommissionUnits;
    const nowIso = params.nowIso ?? new Date().toISOString();
    const finalizeBatchId = `lbatch_${globalThis.crypto.randomUUID()}`;

    const plannedPostings: PlannedPosting[] = [
      {
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: WITHDRAWAL_ESCROW_ACCOUNT,
        direction: 'DEBIT',
        amountUnits,
        legRole: 'TREASURY_ESCROW_RELEASE',
        balanceBucket: 'settled',
      },
      {
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: EXTERNAL_SETTLEMENT_ACCOUNT,
        direction: 'CREDIT',
        amountUnits,
        legRole: 'ONCHAIN_SETTLEMENT_DISBURSED',
        balanceBucket: 'settled',
      },
    ];

    const updatedLockMeta = {
      ...lockBatch.metadata,
      resolution: 'FINALIZED',
      finalizeBatchId,
    };

    const insertFinalizeStmt = this.db
      .prepare(
        `INSERT INTO ledger_journal_batches (
          id, idempotency_key, payload_fingerprint, journal_type, status,
          exchange, trader_uid, reconciliation_id, evidence_id,
          gross_commission_units, hold_until, settled_tx_hash,
          metadata, created_at, updated_at
        ) VALUES (?, ?, ?, 'WITHDRAWAL_FINALIZED', 'SETTLED', NULL, NULL, NULL, NULL, ?, NULL, ?, ?, ?, ?)`
      )
      .bind(
        finalizeBatchId,
        params.idempotencyKey,
        fingerprint,
        toSafeSqlInteger(amountUnits, 'finalized_withdrawal_units'),
        params.txHash.trim(),
        JSON.stringify({ lockBatchId: lockBatch.id, payoutId: lockBatch.metadata.payoutId }),
        nowIso,
        nowIso
      );

    const updateLockStmt = this.db
      .prepare(
        `UPDATE ledger_journal_batches
         SET status = CASE WHEN status = 'INFLIGHT' AND updated_at = ? THEN 'SETTLED' ELSE NULL END,
             settled_tx_hash = ?,
             metadata = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(
        lockBatch.updatedAt,
        params.txHash.trim(),
        JSON.stringify(updatedLockMeta),
        nowIso,
        lockBatch.id
      );

    const postingStmts = this.buildPostingAndBalanceStatements(
      finalizeBatchId,
      plannedPostings,
      nowIso
    );

    const batchResults = await this.db.batch([
      insertFinalizeStmt,
      updateLockStmt,
      ...postingStmts,
    ]);
    if (batchResults[1]?.meta.changes !== 1) {
      throw new LedgerStateTransitionError(
        `Concurrent update prevented finalizing withdrawal lock "${lockBatch.id}"`
      );
    }

    const committed = await this.getBatchById(finalizeBatchId);
    if (!committed) {
      throw new LedgerInvariantError('Finalized withdrawal batch missing after commit');
    }

    return {
      batch: committed,
      postings: await this.getPostingsForBatch(finalizeBatchId),
      isReplay: false,
    };
  }

  /**
   * Revert a locked withdrawal when broadcast expires/aborts, returning funds
   * from `treasury:withdrawal_escrow` back to the user's `settled_balance_units`.
   */
  async revertWithdrawal(params: {
    idempotencyKey: string;
    lockBatchId: string;
    reason: string;
    nowIso?: string;
  }): Promise<WithdrawalMutationResult> {
    await assertLedgerNotFrozen(this.db);

    if (!params.reason || params.reason.trim() === '') {
      throw new LedgerUnitValidationError('Revert reason must be a non-empty string');
    }

    const fingerprint = await computePayloadFingerprint({
      op: 'WITHDRAWAL_REVERTED',
      lockBatchId: params.lockBatchId,
      reason: params.reason.trim(),
    });

    const replayBatch = await this.checkIdempotencyReplay(params.idempotencyKey, fingerprint);
    if (replayBatch) {
      return {
        batch: replayBatch,
        postings: await this.getPostingsForBatch(replayBatch.id),
        isReplay: true,
      };
    }

    const lockBatch = await this.getBatchById(params.lockBatchId);
    if (!lockBatch || lockBatch.journalType !== 'WITHDRAWAL_LOCK') {
      throw new LedgerStateTransitionError(
        `Withdrawal lock batch "${params.lockBatchId}" not found`
      );
    }
    if (lockBatch.status !== 'INFLIGHT') {
      throw new LedgerStateTransitionError(
        `Withdrawal lock batch "${params.lockBatchId}" is already resolved (${lockBatch.status})`
      );
    }

    const ownerType = lockBatch.metadata.ownerType as 'trader' | 'affiliate' | 'agency';
    const ownerId = String(lockBatch.metadata.ownerId ?? '');
    if (!ownerType || !ownerId) {
      throw new LedgerInvariantError(
        `Withdrawal lock batch "${lockBatch.id}" missing owner metadata`
      );
    }

    const amountUnits = lockBatch.grossCommissionUnits;
    const nowIso = params.nowIso ?? new Date().toISOString();
    const revertBatchId = `lbatch_${globalThis.crypto.randomUUID()}`;
    const userSpec = buildAccountSpec(ownerType, ownerId, false);

    const plannedPostings: PlannedPosting[] = [
      {
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: WITHDRAWAL_ESCROW_ACCOUNT,
        direction: 'DEBIT',
        amountUnits,
        legRole: 'TREASURY_ESCROW_REVERT',
        balanceBucket: 'settled',
      },
      {
        id: `lpost_${globalThis.crypto.randomUUID()}`,
        account: userSpec,
        direction: 'CREDIT',
        amountUnits,
        legRole: 'USER_WITHDRAWAL_REFUND',
        balanceBucket: 'settled',
      },
    ];

    const updatedLockMeta = {
      ...lockBatch.metadata,
      resolution: 'REVERTED',
      revertBatchId,
      revertReason: params.reason.trim(),
    };

    const insertRevertStmt = this.db
      .prepare(
        `INSERT INTO ledger_journal_batches (
          id, idempotency_key, payload_fingerprint, journal_type, status,
          exchange, trader_uid, reconciliation_id, evidence_id,
          gross_commission_units, hold_until, settled_tx_hash,
          metadata, created_at, updated_at
        ) VALUES (?, ?, ?, 'WITHDRAWAL_REVERTED', 'SETTLED', NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?)`
      )
      .bind(
        revertBatchId,
        params.idempotencyKey,
        fingerprint,
        toSafeSqlInteger(amountUnits, 'reverted_withdrawal_units'),
        JSON.stringify({ lockBatchId: lockBatch.id, reason: params.reason.trim() }),
        nowIso,
        nowIso
      );

    const updateLockStmt = this.db
      .prepare(
        `UPDATE ledger_journal_batches
         SET status = CASE WHEN status = 'INFLIGHT' AND updated_at = ? THEN 'VOIDED' ELSE NULL END,
             metadata = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(lockBatch.updatedAt, JSON.stringify(updatedLockMeta), nowIso, lockBatch.id);

    const postingStmts = this.buildPostingAndBalanceStatements(
      revertBatchId,
      plannedPostings,
      nowIso
    );

    const batchResults = await this.db.batch([
      insertRevertStmt,
      updateLockStmt,
      ...postingStmts,
    ]);
    if (batchResults[1]?.meta.changes !== 1) {
      throw new LedgerStateTransitionError(
        `Concurrent update prevented reverting withdrawal lock "${lockBatch.id}"`
      );
    }

    const committed = await this.getBatchById(revertBatchId);
    if (!committed) {
      throw new LedgerInvariantError('Reverted withdrawal batch missing after commit');
    }

    return {
      batch: committed,
      postings: await this.getPostingsForBatch(revertBatchId),
      isReplay: false,
    };
  }
}

// ============================================================================
// Trial Balance & Audit Invariant Verifier (Auto-Freezes on Drift)
// ============================================================================

/**
 * Verify all ledger invariants using indexed queries (`idx_ledger_accounts_owner`,
 * `idx_ledger_postings_account_created`, `idx_ledger_batches_status_hold`,
 * `idx_ledger_postings_batch`):
 *  (a) `SUM(DEBIT) === SUM(CREDIT)` globally and per `batch_id`
 *  (b) `settled_balance_units >= 0` & `inflight_balance_units >= 0` for all user/reserve accounts,
 *      AND `SUM(CREDIT) - SUM(DEBIT) === settled + inflight` per account
 *  (c) Exact period conservation equation:
 *      `Opening + Verified - Reversals - SettledWithdrawals === Closing` (`0` unit drift)
 *
 * Automatically flips `EMERGENCY_LEDGER_FREEZE = 'true'` if any invariant fails.
 */
export async function verifyLedgerInvariants(
  db: D1Database,
  openingUnits: bigint = BI_ZERO
): Promise<TrialBalanceReport> {
  // 1. Account-level posting sums joined via `idx_ledger_accounts_owner` + `idx_ledger_postings_account_created`
  const accountRowsRes = await db
    .prepare(
      `SELECT
         la.id,
         la.owner_type,
         la.owner_id,
         la.account_code,
         la.settled_balance_units,
         la.inflight_balance_units,
         la.allow_negative,
         COALESCE(SUM(CASE WHEN lp.direction = 'DEBIT' THEN lp.amount_units ELSE 0 END), 0) AS debit_sum,
         COALESCE(SUM(CASE WHEN lp.direction = 'CREDIT' THEN lp.amount_units ELSE 0 END), 0) AS credit_sum
       FROM ledger_accounts la INDEXED BY idx_ledger_accounts_owner
       LEFT JOIN ledger_postings lp INDEXED BY idx_ledger_postings_account_created
         ON lp.account_id = la.id
       WHERE la.owner_type IN ('system', 'trader', 'affiliate', 'agency', 'treasury', 'reserve')
       GROUP BY la.id`
    )
    .all<{
      id: string;
      owner_type: LedgerAccountOwnerType;
      owner_id: string;
      account_code: string;
      settled_balance_units: number;
      inflight_balance_units: number;
      allow_negative: number;
      debit_sum: number;
      credit_sum: number;
    }>();

  let totalDebitUnits = BI_ZERO;
  let totalCreditUnits = BI_ZERO;
  let actualClosingUnits = BI_ZERO;
  const negativeUserAccountCodes: string[] = [];
  const accountPostingDriftCodes: string[] = [];

  for (const row of accountRowsRes.results ?? []) {
    const settled = fromSqlInteger(row.settled_balance_units, 'settled_balance_units');
    const inflight = fromSqlInteger(row.inflight_balance_units, 'inflight_balance_units');
    const debitSum = fromSqlInteger(row.debit_sum, 'debit_sum');
    const creditSum = fromSqlInteger(row.credit_sum, 'credit_sum');

    totalDebitUnits += debitSum;
    totalCreditUnits += creditSum;

    const netPostings = creditSum - debitSum;
    if (netPostings !== settled + inflight) {
      accountPostingDriftCodes.push(row.account_code);
    }

    const isNonNegativeAccount =
      row.allow_negative === 0 ||
      row.owner_type === 'trader' ||
      row.owner_type === 'affiliate' ||
      row.owner_type === 'agency' ||
      row.owner_type === 'reserve';

    if (isNonNegativeAccount && (settled < BI_ZERO || inflight < BI_ZERO)) {
      negativeUserAccountCodes.push(row.account_code);
    }

    // Internal payee/pool closing excludes external inflow (`system:partner_receivable:*`)
    // and external on-chain outflow (`treasury:external_settlement`).
    const isExternalCounterparty =
      (row.owner_type === 'system' && row.owner_id.startsWith('partner_receivable:')) ||
      (row.owner_type === 'treasury' && row.owner_id === 'external_settlement');

    if (!isExternalCounterparty) {
      actualClosingUnits += settled + inflight;
    }
  }

  // 2. Per-batch balance check using `idx_ledger_batches_status_hold` + `idx_ledger_postings_batch`
  const unbalancedRes = await db
    .prepare(
      `SELECT b.id AS batch_id,
              COALESCE(SUM(CASE WHEN lp.direction = 'DEBIT' THEN lp.amount_units ELSE 0 END), 0) AS debit_units,
              COALESCE(SUM(CASE WHEN lp.direction = 'CREDIT' THEN lp.amount_units ELSE 0 END), 0) AS credit_units
       FROM ledger_journal_batches b INDEXED BY idx_ledger_batches_status_hold
       LEFT JOIN ledger_postings lp INDEXED BY idx_ledger_postings_batch
         ON lp.batch_id = b.id
       WHERE b.status IN ('INFLIGHT', 'SETTLED', 'VOIDED')
       GROUP BY b.id
       HAVING debit_units != credit_units OR debit_units = 0`
    )
    .all<{ batch_id: string; debit_units: number; credit_units: number }>();

  const unbalancedBatchIds = (unbalancedRes.results ?? []).map((r) => r.batch_id);

  // 3. Period equation aggregates using `idx_ledger_batches_status_hold`
  const periodSumsRes = await db
    .prepare(
      `SELECT journal_type, COALESCE(SUM(gross_commission_units), 0) AS total_units
       FROM ledger_journal_batches INDEXED BY idx_ledger_batches_status_hold
       WHERE status IN ('INFLIGHT', 'SETTLED', 'VOIDED')
       GROUP BY journal_type`
    )
    .all<{ journal_type: LedgerJournalType; total_units: number }>();

  let verifiedUnits = BI_ZERO;
  let reversalUnits = BI_ZERO;
  let settledWithdrawalUnits = BI_ZERO;

  for (const row of periodSumsRes.results ?? []) {
    const units = fromSqlInteger(row.total_units, row.journal_type);
    if (row.journal_type === 'COMMISSION_INFLIGHT') {
      verifiedUnits += units;
    } else if (
      row.journal_type === 'COMMISSION_VOID_CLAWBACK' ||
      row.journal_type === 'POST_SETTLEMENT_CLAWBACK'
    ) {
      reversalUnits += units;
    } else if (row.journal_type === 'WITHDRAWAL_FINALIZED') {
      settledWithdrawalUnits += units;
    }
  }

  const expectedClosingUnits =
    openingUnits + verifiedUnits - reversalUnits - settledWithdrawalUnits;
  const driftUnits = actualClosingUnits - expectedClosingUnits;

  const valid =
    totalDebitUnits === totalCreditUnits &&
    unbalancedBatchIds.length === 0 &&
    negativeUserAccountCodes.length === 0 &&
    accountPostingDriftCodes.length === 0 &&
    driftUnits === BI_ZERO;

  let emergencyFreezeTriggered = false;
  if (!valid) {
    const reasons: string[] = [];
    if (totalDebitUnits !== totalCreditUnits) {
      reasons.push(
        `TrialBalanceMismatch(D=${totalDebitUnits.toString()},C=${totalCreditUnits.toString()})`
      );
    }
    if (unbalancedBatchIds.length > 0) {
      reasons.push(`UnbalancedBatches(${unbalancedBatchIds.length})`);
    }
    if (negativeUserAccountCodes.length > 0) {
      reasons.push(`NegativeAccounts(${negativeUserAccountCodes.join(',')})`);
    }
    if (accountPostingDriftCodes.length > 0) {
      reasons.push(`AccountPostingDrift(${accountPostingDriftCodes.join(',')})`);
    }
    if (driftUnits !== BI_ZERO) {
      reasons.push(`PeriodEquationDrift(${driftUnits.toString()})`);
    }
    const freezeReason = `verifyLedgerInvariants failed: ${reasons.join('; ')}`;
    logError('[LedgerInvariantVerifier] Triggering EMERGENCY_LEDGER_FREEZE', freezeReason);
    logWarn('[LedgerInvariantVerifier] Ledger frozen due to invariant failure');
    await setEmergencyLedgerFreeze(db, true, freezeReason, 'verifyLedgerInvariants');
    emergencyFreezeTriggered = true;
  }

  return {
    valid,
    totalDebitUnits,
    totalCreditUnits,
    unbalancedBatchIds,
    negativeUserAccountCodes,
    accountPostingDriftCodes,
    periodEquation: {
      openingUnits,
      verifiedUnits,
      reversalUnits,
      settledWithdrawalUnits,
      expectedClosingUnits,
      actualClosingUnits,
      driftUnits,
    },
    emergencyFreezeTriggered,
  };
}
