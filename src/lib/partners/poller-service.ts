/**
 * Automated Partner HTTP Poller & 30-Day Shadow Reconciliation Service
 *
 * Orchestrates scheduled (`0 * * * *`) and Passkey-authenticated admin manual polling
 * across Bybit Affiliate v5, OKX Affiliate/Broker v5, Bitget Broker v2, KuCoin UTA v2,
 * and Gate.io Partner v4:
 *
 * 1. Credential Resolution:
 *    Reads read-only partner credentials from Cloudflare Worker env / `process.env`.
 *    Missing credentials never throw — records `SKIPPED_MISSING_CREDENTIALS` in
 *    `partner_poller_runs` and moves to the next exchange.
 * 2. Shadow-to-Live Promotion Gate (`system_runtime_flags`):
 *    - `bybit`, `okx`, `bitget` default to `ACTIVE` unless `forceShadow` is requested or
 *      `EMERGENCY_LEDGER_FREEZE === 'true'`.
 *    - `kucoin` (`PARTNER_KUCOIN_LIVE`) and `gateio` (`PARTNER_GATEIO_LIVE`) default to
 *      `SHADOW_ONLY` until promoted to `'true'` via Passkey step-up after 30-day shadow audit.
 * 3. D1 UID & Attribution Resolution:
 *    Resolves `trader_exchange_uids` (`PENDING_FIRST_TRADE` | `VERIFIED_BY_PARTNER`),
 *    `short_links` (`linked_short_code` / `subAffiliateCode`), `referral_tree`, and `profiles`.
 * 4. Shadow Execution (`SHADOW_ONLY`):
 *    Stores raw partner payload in R2 (`r2_evidence_objects`), logs simulated reconciliation
 *    metrics into `partner_shadow_reconciliations`, and NEVER mints `ledger_journal_batches`
 *    or `ledger_postings`.
 * 5. Active Execution (`ACTIVE`):
 *    Requires an independent wallet cash credit statement (never self-attests wallet cash from
 *    commission rows), validates UID mappings + clawback targets before minting, reconciles via
 *    `reconcilePartnerCashBatch` ($0.01 tolerance), runs `M2SybilGraphEngine`, mints T+7 inflight
 *    batches via `DoubleEntryLedgerService`, and promotes `PENDING_FIRST_TRADE` -> `VERIFIED_BY_PARTNER`.
 */

import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import type { D1Database as LegacyD1Database } from '@/lib/db';
import {
  createFraudTelemetryBatchCache,
  loadAttributionFraudTelemetry,
  type FraudTelemetryD1Like,
} from '@/lib/fraud/d1-fraud-telemetry';
import type {
  M2FraudEvaluationVerdict,
  M2SybilGraphEngine,
} from '@/lib/fraud/m2-sybil-graph-engine';
import {
  BI_ZERO,
  DoubleEntryLedgerService,
  evaluateCashReconciliation,
  formatLedgerUnitsToUsd,
  fromSqlInteger,
  getB2bAgencyContractByProfileId,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  toSafeSqlInteger,
  type R2BucketLike,
  type SupportedPartnerExchange,
  type WaterfallConfig,
} from '@/lib/ledger';
import { buildBitgetPartnerSignedHeaders } from './bitget-broker-adapter';
import { buildBybitAffiliateSignedHeaders } from './bybit-affiliate-adapter';
import { buildGateioPartnerSignedHeaders } from './gateio-v4-adapter';
import { buildKucoinPartnerSignedHeaders } from './kucoin-uta-v2-adapter';
import { buildOkxPartnerSignedHeaders } from './okx-affiliate-adapter';
import { getPartnerAdapter, POLLABLE_PARTNER_EXCHANGES } from './registry';
import {
  computePayloadEvidence,
  validatePartnerApiBaseUrl,
  type ActivePartnerExchangeId,
  type NormalizedPartnerCommissionRow,
  type PartnerApiCredentials,
  type PartnerIngestionBatchResult,
} from './types';
import {
  normalizeWalletDepositRows,
  type NormalizedWalletDeposit,
} from './wallet-deposit-normalizer';

export const MAX_POLL_PAGES = 50;

export type PartnerIntegrationErrorCode =
  | 'CLAWBACK_TARGET_BATCH_NOT_FOUND'
  | 'INVALID_CLAWBACK_TARGET_BATCH'
  | 'CLAWBACK_EXCEEDS_ORIGINAL_BATCH'
  | 'POLLER_INTEGRATION_ERROR';

export class PartnerIntegrationError extends Error {
  public readonly code: PartnerIntegrationErrorCode | string;
  public readonly exchange?: ActivePartnerExchangeId;
  public readonly statusCode = 422;
  /** Populated by `runSingleExchangePoll` so a cycle can still report the failed run. */
  public runSummary?: PartnerPollerRunSummary;

  constructor(
    code: PartnerIntegrationErrorCode | string,
    message: string,
    exchange?: ActivePartnerExchangeId
  ) {
    super(message);
    this.name = 'PartnerIntegrationError';
    this.code = code;
    this.exchange = exchange;
  }
}

export type PollerTriggerSource = 'cron' | 'admin_manual';

export type PollerExecutionMode =
  | 'ACTIVE'
  | 'SHADOW_ONLY'
  | 'SKIPPED_MISSING_CREDENTIALS'
  | 'HALTED_FLAG';

export type PollerRunStatus =
  | 'SUCCESS'
  | 'SKIPPED_MISSING_CREDENTIALS'
  | 'DISCREPANCY_HALTED'
  | 'ERROR';

export type ShadowReconciliationStatus =
  | 'SHADOW_LOGGED'
  | 'SHADOW_DISCREPANCY'
  | 'PROMOTED_READY';

export interface ResolvedUidAttribution {
  uidRecordId?: string;
  verificationStatus?: 'PENDING_FIRST_TRADE' | 'VERIFIED_BY_PARTNER';
  traderProfileId: string;
  l1AffiliateId: string | null;
  b2bAgencyId: string | null;
  waterfallConfig?: Partial<WaterfallConfig>;
  traderEmail?: string;
  referrerEmail?: string;
}

export interface WalletStatementSnapshot {
  rawWalletStatementPayload: string;
  walletCashCollectedUsd: string;
  consumedDepositIds?: string[];
}

export interface WalletDepositQueryWindow {
  queryStartTimeMs: number;
  queryEndTimeMs: number;
  preferredStartTimeMs: number;
  preferredEndTimeMs: number;
}

export interface ResolveWalletDepositCashInput {
  db: AuthD1Database;
  exchange: ActivePartnerExchangeId;
  startTimeMs: number;
  endTimeMs: number;
  nowMs?: number;
  credentials?: PartnerApiCredentials | null;
  envBag?: Record<string, string | undefined>;
  walletDeposits?: ReadonlyArray<Record<string, unknown>> | string;
  depositEndpointPath?: string;
  expectedCashUnits?: bigint;
  fetchImpl?: typeof fetch;
}

export interface ResolvedWalletDepositCash extends WalletStatementSnapshot {
  consumedDepositIds: string[];
  excludedDepositIds: string[];
  queryWindow: WalletDepositQueryWindow;
}

export interface ExchangePollerOverride {
  rawPartnerPayload?: string;
  walletStatement?: WalletStatementSnapshot;
  walletDeposits?: ReadonlyArray<Record<string, unknown>> | string;
  depositEndpointPath?: string;
  uidToProfileMap?: Record<string, ResolvedUidAttribution>;
  clawbackOriginalBatchMap?: Record<string, string>;
  recoverClawbackFromFutureInflight?: boolean;
  forceShadow?: boolean;
  startTimeMs?: number;
  endTimeMs?: number;
  endpointPath?: string;
}

export interface PartnerPollerCycleInput {
  db: AuthD1Database;
  r2?: R2BucketLike | null;
  env?: Record<string, string | undefined>;
  triggerSource: PollerTriggerSource;
  exchanges?: readonly ActivePartnerExchangeId[];
  overrides?: Partial<Record<ActivePartnerExchangeId, ExchangePollerOverride>>;
  forceShadow?: boolean;
  nowMs?: number;
  lookbackMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PartnerPollerRunSummary {
  runId: string;
  triggerSource: PollerTriggerSource;
  exchange: ActivePartnerExchangeId;
  mode: PollerExecutionMode;
  status: PollerRunStatus;
  fetchedRows: number;
  mintedBatches: number;
  clawbackBatches: number;
  blockedByFraud: number;
  mappedUidCount: number;
  unmappedUidCount: number;
  evidenceId: string | null;
  walletEvidenceId: string | null;
  reconciliationId: string | null;
  shadowReconciliationId: string | null;
  errorCode: string | null;
  details: string | null;
  startedAt: string;
  completedAt: string;
}

export interface PartnerPollerCycleResult {
  triggerSource: PollerTriggerSource;
  startedAt: string;
  completedAt: string;
  runs: PartnerPollerRunSummary[];
}

const DEFAULT_LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2 hours overlap window (idempotency-deduplicated)

const SHADOW_GATED_EXCHANGE_FLAGS: Partial<Record<ActivePartnerExchangeId, string>> = {
  kucoin: 'PARTNER_KUCOIN_LIVE',
  gateio: 'PARTNER_GATEIO_LIVE',
};

function readEnvString(
  envBag: Record<string, string | undefined>,
  key: string
): string | undefined {
  const val = envBag[key];
  if (typeof val === 'string' && val.trim().length > 0) {
    return val.trim();
  }
  if (typeof process !== 'undefined' && process.env) {
    const procVal = process.env[key];
    if (typeof procVal === 'string' && procVal.trim().length > 0) {
      return procVal.trim();
    }
  }
  return undefined;
}

export function resolvePartnerCredentialsFromEnv(
  exchange: ActivePartnerExchangeId,
  envBag: Record<string, string | undefined> = {}
): PartnerApiCredentials | null {
  const prefix = exchange.toUpperCase();
  const apiKey =
    readEnvString(envBag, `${prefix}_PARTNER_API_KEY`) ??
    readEnvString(envBag, `${prefix}_BROKER_API_KEY`);
  const apiSecret =
    readEnvString(envBag, `${prefix}_PARTNER_API_SECRET`) ??
    readEnvString(envBag, `${prefix}_BROKER_API_SECRET`);

  if (!apiKey || !apiSecret) {
    return null;
  }

  const passphrase =
    readEnvString(envBag, `${prefix}_PARTNER_PASSPHRASE`) ??
    readEnvString(envBag, `${prefix}_BROKER_PASSPHRASE`);

  if ((exchange === 'okx' || exchange === 'bitget' || exchange === 'kucoin') && !passphrase) {
    return null;
  }

  return {
    apiKey,
    apiSecret,
    passphrase,
    partnerId: readEnvString(envBag, `${prefix}_PARTNER_ID`),
    keyVersion: readEnvString(envBag, `${prefix}_PARTNER_KEY_VERSION`),
    baseUrl: readEnvString(envBag, `${prefix}_PARTNER_BASE_URL`),
  };
}

export function resolveWalletStatementFromEnv(
  exchange: ActivePartnerExchangeId,
  envBag: Record<string, string | undefined> = {}
): WalletStatementSnapshot | null {
  const prefix = exchange.toUpperCase();
  const rawWalletStatementPayload = readEnvString(
    envBag,
    `${prefix}_WALLET_STATEMENT_PAYLOAD`
  );
  const walletCashCollectedUsd = readEnvString(
    envBag,
    `${prefix}_WALLET_CASH_COLLECTED_USD`
  );
  if (!rawWalletStatementPayload || !walletCashCollectedUsd) {
    return null;
  }
  return {
    rawWalletStatementPayload,
    walletCashCollectedUsd,
  };
}

const WALLET_DEPOSIT_LOOKBACK_MS = 36 * 3600 * 1000;
const WALLET_DEPOSIT_FORWARD_MS = 12 * 3600 * 1000;
const WALLET_DEPOSIT_PREFERRED_LEAD_MS = 5 * 60 * 1000;
const CONSUMED_DEPOSIT_LOOKBACK_RUNS = 50;
const D1_IN_CLAUSE_CHUNK_SIZE = 80;

/**
 * Queries `ledger_journal_batches` for already-applied idempotency keys in chunks
 * of at most 80 bind parameters so large lookback windows stay under D1's variable
 * limit and never re-count settled rows toward a new cash batch.
 */
export async function findExistingLedgerIdempotencyKeys(
  db: AuthD1Database,
  idempotencyKeys: readonly string[]
): Promise<Set<string>> {
  const uniqueKeys = Array.from(
    new Set(idempotencyKeys.map((key) => key.trim()).filter(Boolean))
  );
  const existing = new Set<string>();
  for (let offset = 0; offset < uniqueKeys.length; offset += D1_IN_CLAUSE_CHUNK_SIZE) {
    const chunk = uniqueKeys.slice(offset, offset + D1_IN_CLAUSE_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db
      .prepare(
        `SELECT idempotency_key FROM ledger_journal_batches WHERE idempotency_key IN (${placeholders})`
      )
      .bind(...chunk)
      .all<{ idempotency_key: string }>();
    for (const row of result.results ?? []) {
      if (row.idempotency_key) existing.add(row.idempotency_key);
    }
  }
  return existing;
}

/**
 * Computes the settlement-lag tolerant deposit query window: partner payouts can
 * land up to 36 hours after the commission window closes (and, for overlapping
 * settlements, slightly before it opens), while never extending past the poller
 * clock or more than 12 hours beyond the commission window end.
 */
export function computeWalletDepositQueryWindow(
  startTimeMs: number,
  endTimeMs: number,
  nowMs: number
): WalletDepositQueryWindow {
  const queryEndTimeMs = Math.min(nowMs, endTimeMs + WALLET_DEPOSIT_FORWARD_MS);
  const queryStartTimeMs = startTimeMs - WALLET_DEPOSIT_LOOKBACK_MS;
  const preferredEndTimeMs = queryEndTimeMs;
  const preferredStartTimeMs = startTimeMs - WALLET_DEPOSIT_PREFERRED_LEAD_MS;
  return {
    queryStartTimeMs,
    queryEndTimeMs,
    preferredStartTimeMs,
    preferredEndTimeMs: Math.max(preferredStartTimeMs, preferredEndTimeMs),
  };
}

const DEFAULT_PARTNER_BASE_URLS: Record<ActivePartnerExchangeId, string> = {
  bybit: 'https://api.bybit.com',
  okx: 'https://www.okx.com',
  bitget: 'https://api.bitget.com',
  kucoin: 'https://api.kucoin.com',
  gateio: 'https://api.gateio.ws',
};

const DEFAULT_DEPOSIT_ENDPOINTS: Record<SupportedPartnerExchange, string> = {
  bybit: '/v5/asset/deposit/query-record',
  okx: '/api/v5/asset/deposit-history',
  bitget: '/api/v2/spot/wallet/deposit-records',
  kucoin: '/api/v1/deposits',
  gateio: '/api/v4/wallet/deposits',
};

/** Explicit allowlist prevents credential-bearing requests to unrelated APIs. */
export const ALLOWED_PARTNER_DEPOSIT_ENDPOINTS: Readonly<
  Record<SupportedPartnerExchange, ReadonlySet<string>>
> = Object.freeze({
  bybit: new Set([
    DEFAULT_DEPOSIT_ENDPOINTS.bybit,
    '/v5/asset/deposit/query-sub-uid-record',
    '/v5/asset/deposit/query-sub-member-record',
    '/v5/asset/deposit/query-internal-record',
  ]),
  okx: new Set([
    DEFAULT_DEPOSIT_ENDPOINTS.okx,
    '/api/v5/broker/nd/subaccount-deposit-history',
  ]),
  bitget: new Set([
    DEFAULT_DEPOSIT_ENDPOINTS.bitget,
    '/api/v2/spot/wallet/subaccount-deposit-records',
    '/api/v2/spot/account/deposit-records',
  ]),
  kucoin: new Set([
    DEFAULT_DEPOSIT_ENDPOINTS.kucoin,
    '/api/v1/hist-deposits',
  ]),
  gateio: new Set([
    DEFAULT_DEPOSIT_ENDPOINTS.gateio,
  ]),
});

function extractDepositRecordArray(
  node: unknown,
  depth = 0
): ReadonlyArray<Record<string, unknown>> | null {
  if (depth > 3 || node === null || node === undefined) return null;
  if (Array.isArray(node)) {
    return node.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    );
  }
  if (typeof node === 'object') {
    const container = node as Record<string, unknown>;
    for (const key of ['deposits', 'rows', 'list', 'items', 'data', 'result'] as const) {
      if (!(key in container)) continue;
      const extracted = extractDepositRecordArray(container[key], depth + 1);
      if (extracted !== null) {
        return extracted;
      }
    }
  }
  return null;
}

function parseWalletDepositsPayload(
  payload: ReadonlyArray<Record<string, unknown>> | string | undefined
): ReadonlyArray<Record<string, unknown>> {
  if (payload === undefined) return [];
  if (typeof payload !== 'string') return payload;
  try {
    const parsed: unknown = JSON.parse(payload);
    return extractDepositRecordArray(parsed) ?? [];
  } catch {
    return [];
  }
}

function formatUtcDateYmd(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function buildDepositWindowQueryString(
  exchange: ActivePartnerExchangeId,
  window: WalletDepositQueryWindow
): string {
  const params = new URLSearchParams();
  switch (exchange) {
    case 'bybit':
      params.set('startDate', formatUtcDateYmd(window.queryStartTimeMs));
      params.set('endDate', formatUtcDateYmd(window.queryEndTimeMs));
      params.set('startTime', String(Math.trunc(window.queryStartTimeMs)));
      params.set('endTime', String(Math.trunc(window.queryEndTimeMs)));
      break;
    case 'okx':
    case 'kucoin':
      params.set('begin', String(Math.trunc(window.queryStartTimeMs)));
      params.set('end', String(Math.trunc(window.queryEndTimeMs)));
      break;
    case 'bitget':
      params.set('startTime', String(Math.trunc(window.queryStartTimeMs)));
      params.set('endTime', String(Math.trunc(window.queryEndTimeMs)));
      break;
    case 'gateio':
      params.set('from', String(Math.floor(window.queryStartTimeMs / 1000)));
      params.set('to', String(Math.ceil(window.queryEndTimeMs / 1000)));
      break;
  }
  return params.toString();
}

async function fetchWalletDepositsFromPartnerEndpoint(params: {
  exchange: ActivePartnerExchangeId;
  credentials: PartnerApiCredentials;
  depositEndpointPath: string;
  queryWindow: WalletDepositQueryWindow;
  nowMs: number;
  fetchImpl?: typeof fetch;
}): Promise<ReadonlyArray<Record<string, unknown>>> {
  const { exchange, credentials, queryWindow, nowMs } = params;
  const rawPath = params.depositEndpointPath;
  if (
    !rawPath.startsWith('/') ||
    rawPath.includes('..') ||
    rawPath.includes('//') ||
    rawPath.includes('\\') ||
    /\s/.test(rawPath)
  ) {
    throw new PartnerIntegrationError(
      'POLLER_INTEGRATION_ERROR',
      `Deposit endpoint path for ${exchange} contains an invalid path`,
      exchange
    );
  }
  const [endpointPath, inlineQuery] = rawPath.split('?', 2);
  if (!ALLOWED_PARTNER_DEPOSIT_ENDPOINTS[exchange].has(endpointPath)) {
    throw new PartnerIntegrationError(
      'POLLER_INTEGRATION_ERROR',
      `Deposit endpoint path '${endpointPath}' is not allowlisted for ${exchange}`,
      exchange
    );
  }
  const windowQuery = buildDepositWindowQueryString(exchange, queryWindow);
  const queryString = inlineQuery
    ? `${inlineQuery}&${windowQuery}`
    : windowQuery;
  const requestPathWithQuery = queryString
    ? `${endpointPath}?${queryString}`
    : endpointPath;

  const baseUrl = validatePartnerApiBaseUrl(
    exchange,
    credentials.baseUrl,
    DEFAULT_PARTNER_BASE_URLS[exchange]
  );

  let headers: Record<string, string>;
  switch (exchange) {
    case 'bybit':
      headers = await buildBybitAffiliateSignedHeaders({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        queryString,
        timestampMs: nowMs,
        recvWindowMs: credentials.recvWindowMs,
      });
      break;
    case 'okx':
      headers = await buildOkxPartnerSignedHeaders({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        passphrase: credentials.passphrase ?? '',
        method: 'GET',
        requestPathWithQuery,
        timestampIso: new Date(nowMs).toISOString(),
      });
      break;
    case 'bitget':
      headers = await buildBitgetPartnerSignedHeaders({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        passphrase: credentials.passphrase ?? '',
        method: 'GET',
        endpointPath,
        queryString,
        timestampMs: nowMs,
      });
      break;
    case 'kucoin':
      headers = await buildKucoinPartnerSignedHeaders({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        passphrase: credentials.passphrase ?? '',
        partnerId: credentials.partnerId,
        keyVersion: credentials.keyVersion,
        method: 'GET',
        endpointPath,
        queryString,
        timestampMs: nowMs,
      });
      break;
    case 'gateio':
      headers = await buildGateioPartnerSignedHeaders({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        method: 'GET',
        endpointPath,
        queryString,
        timestampSeconds: Math.floor(nowMs / 1000),
      });
      break;
  }

  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const response = await fetchFn(`${baseUrl}${requestPathWithQuery}`, {
    method: 'GET',
    headers,
  });
  if (!response.ok) {
    throw new PartnerIntegrationError(
      'POLLER_INTEGRATION_ERROR',
      `Failed to fetch wallet deposits for ${exchange}: HTTP ${response.status}`,
      exchange
    );
  }
  const responseText = await response.text();
  return parseWalletDepositsPayload(responseText);
}

/**
 * Loads `consumedDepositIds` recorded by earlier `MATCHED` poller runs so a
 * late-settling payout is only ever counted toward one reconciliation.
 *
 * `partner_poller_runs` carries the JSON blob in `details`; deployments that add
 * a dedicated `details_json` column are also honoured through a tolerant `SELECT *`.
 */
export async function loadConsumedDepositIds(
  db: AuthD1Database,
  exchange: ActivePartnerExchangeId
): Promise<Set<string>> {
  const consumed = new Set<string>();

  try {
    const claimedRes = await db
      .prepare(
        `SELECT deposit_id FROM partner_reconciliation_deposits
         WHERE exchange = ?`
      )
      .bind(exchange)
      .all<{ deposit_id: string }>();
    for (const row of claimedRes.results ?? []) {
      if (typeof row.deposit_id === 'string' && row.deposit_id.trim().length > 0) {
        consumed.add(row.deposit_id.trim());
      }
    }
  } catch {
    // Legacy unit-test mocks without `partner_reconciliation_deposits` fall back
    // to scanning `partner_poller_runs` below.
  }

  let rows: Array<Record<string, unknown>> = [];
  try {
    const res = await db
      .prepare(
        `SELECT * FROM partner_poller_runs
         WHERE exchange = ? AND status IN ('SUCCESS', 'MATCHED')
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .bind(exchange, CONSUMED_DEPOSIT_LOOKBACK_RUNS)
      .all<Record<string, unknown>>();
    rows = res.results ?? [];
  } catch {
    return consumed;
  }

  for (const row of rows) {
    let matched = String(row.status ?? '').trim() === 'MATCHED';
    const recordedIds: string[] = [];
    for (const column of ['details_json', 'details'] as const) {
      const raw = row[column];
      if (typeof raw !== 'string' || raw.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') continue;
        const record = parsed as {
          consumedDepositIds?: unknown;
          reconciliationStatus?: unknown;
        };
        if (
          String(record.reconciliationStatus ?? '').trim() === 'MATCHED' &&
          row.reconciliation_id
        ) {
          matched = true;
        }
        if (!Array.isArray(record.consumedDepositIds)) continue;
        for (const id of record.consumedDepositIds) {
          if (typeof id === 'string' && id.trim().length > 0) {
            recordedIds.push(id.trim());
          }
        }
      } catch {
        // Legacy human-readable details rows are not JSON; ignore them.
      }
    }

    if (!matched) continue;
    for (const id of recordedIds) {
      consumed.add(id);
    }
  }

  return consumed;
}

/**
 * Resolves the independent wallet cash figure from exchange deposit records.
 *
 * Partner payouts frequently settle up to 36 hours after the trade window closes,
 * so the query window is widened, deposits already reconciled by an earlier poll
 * are excluded, and deposits landing inside the primary `[start - 5m, end + 12h]`
 * window are preferred over older tail-of-window settlements.
 */
export async function resolveWalletDepositCash(
  input: ResolveWalletDepositCashInput
): Promise<ResolvedWalletDepositCash> {
  const nowMs = input.nowMs ?? Date.now();
  const queryWindow = computeWalletDepositQueryWindow(
    input.startTimeMs,
    input.endTimeMs,
    nowMs
  );

  const envPayload = readEnvString(
    input.envBag ?? {},
    `${input.exchange.toUpperCase()}_WALLET_DEPOSITS_PAYLOAD`
  );
  let rawDeposits: ReadonlyArray<Record<string, unknown>>;
  if (input.walletDeposits !== undefined || envPayload !== undefined) {
    rawDeposits = parseWalletDepositsPayload(input.walletDeposits ?? envPayload);
  } else if (input.depositEndpointPath && input.credentials) {
    rawDeposits = await fetchWalletDepositsFromPartnerEndpoint({
      exchange: input.exchange,
      credentials: input.credentials,
      depositEndpointPath: input.depositEndpointPath,
      queryWindow,
      nowMs,
      fetchImpl: input.fetchImpl,
    });
  } else {
    rawDeposits = [];
  }
  const deposits = normalizeWalletDepositRows(rawDeposits, {
    exchange: input.exchange,
    depositEndpointPath: input.depositEndpointPath,
  });
  const consumed = await loadConsumedDepositIds(input.db, input.exchange);

  const excludedDepositIds: string[] = [];
  const inWindow: NormalizedWalletDeposit[] = [];
  for (const deposit of deposits) {
    if (consumed.has(deposit.depositId)) {
      excludedDepositIds.push(deposit.depositId);
      continue;
    }
    if (deposit.timestampMs === null) {
      inWindow.push(deposit);
      continue;
    }
    if (
      deposit.timestampMs < queryWindow.queryStartTimeMs ||
      deposit.timestampMs > queryWindow.queryEndTimeMs
    ) {
      continue;
    }
    inWindow.push(deposit);
  }

  const preferred = inWindow.filter(
    (deposit) =>
      deposit.timestampMs !== null &&
      deposit.timestampMs >= queryWindow.preferredStartTimeMs &&
      deposit.timestampMs <= queryWindow.preferredEndTimeMs
  );
  const selected = preferred.length > 0 ? preferred : inWindow;

  let totalUnits = BI_ZERO;
  const ledgerEntries: Array<{ depositId: string; amountUsd: string; timestampMs: number | null }> =
    [];
  for (const deposit of selected) {
    totalUnits += parseUsdToLedgerUnits(deposit.amountUsd);
    ledgerEntries.push({
      depositId: deposit.depositId,
      amountUsd: deposit.amountUsd,
      timestampMs: deposit.timestampMs,
    });
  }

  return {
    rawWalletStatementPayload: JSON.stringify({
      exchange: input.exchange,
      source: 'wallet_deposits',
      queryWindow,
      deposits: ledgerEntries,
      excludedDepositIds,
      totalUsd: formatLedgerUnitsToUsd(totalUnits),
    }),
    walletCashCollectedUsd: formatLedgerUnitsToUsd(totalUnits),
    consumedDepositIds: ledgerEntries.map((entry) => entry.depositId),
    excludedDepositIds,
    queryWindow,
  };
}

interface ResolvedB2bAgencyOverride {
  b2bAgencyId: string;
  tier2ShareOfSpread: string;
  waterfallConfig?: Partial<WaterfallConfig>;
}

async function resolveUpstreamParentProfileId(
  db: AuthD1Database,
  childProfileId: string
): Promise<string | null> {
  try {
    const treeParent = await db
      .prepare(
        `SELECT rt_parent.affiliate_id AS parent_affiliate_id
         FROM referral_tree rt_child
         JOIN referral_tree rt_parent ON rt_child.parent_id = rt_parent.id
         WHERE rt_child.affiliate_id = ? AND COALESCE(rt_child.is_active, 1) = 1
         LIMIT 1`
      )
      .bind(childProfileId)
      .first<{ parent_affiliate_id: string | null }>();
    const parentId = treeParent?.parent_affiliate_id?.trim();
    if (parentId) {
      return parentId;
    }
  } catch {
    // Optional referral_tree table
  }

  try {
    const childRow = await db
      .prepare(`SELECT referred_by FROM profiles WHERE id = ? LIMIT 1`)
      .bind(childProfileId)
      .first<{ referred_by: string | null }>();
    const referredBy = childRow?.referred_by?.trim();
    if (!referredBy) {
      return null;
    }
    if (referredBy === childProfileId) {
      return referredBy;
    }
    try {
      const parentRow = await db
        .prepare(`SELECT id FROM profiles WHERE id = ? OR referral_code = ? LIMIT 1`)
        .bind(referredBy, referredBy)
        .first<{ id: string }>();
      return parentRow?.id ?? referredBy;
    } catch {
      return referredBy;
    }
  } catch {
    return null;
  }
}

function normalizeTier2Share(rawValue: string): string | null {
  const numeric = Number(rawValue.trim());
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 0.1) {
    return null;
  }
  return String(numeric);
}

/**
 * Resolves a Decree 40/2018/ND-CP compliant B2B agency override for the L1
 * affiliate's upstream parent. Retail second-level affiliates are never treated
 * as agencies: D1 must explicitly provision the candidate through a
 * `B2B_AGENCY_OVERRIDE_SHARE_<id>` flag, a `ledger_accounts` agency account, or
 * an `agency` profile role.
 */
export async function resolveB2bAgencyOverrideForL1(
  db: AuthD1Database,
  l1AffiliateId: string | null | undefined,
  traderProfileId: string | null | undefined
): Promise<ResolvedB2bAgencyOverride | null> {
  const l1Id = l1AffiliateId?.trim();
  if (!l1Id) {
    return null;
  }

  const candidateAgencyId = await resolveUpstreamParentProfileId(db, l1Id);
  if (
    !candidateAgencyId ||
    candidateAgencyId === l1Id ||
    (traderProfileId && candidateAgencyId === traderProfileId.trim())
  ) {
    return null;
  }

  // Authoritative check: White-Label B2B Agency Split Contracts (`b2b_agency_contracts`)
  try {
    const b2bContract = await getB2bAgencyContractByProfileId(db, candidateAgencyId);
    if (b2bContract) {
      if (b2bContract.status !== 'ACTIVE') {
        return null;
      }
      return {
        b2bAgencyId: candidateAgencyId,
        tier2ShareOfSpread: b2bContract.waterfallConfig.tier2ShareOfSpread,
        waterfallConfig: b2bContract.waterfallConfig,
      };
    }
  } catch {
    // Graceful fallback when running against pre-031 SQLite test fixtures
  }

  const shareFlagValue = await getRuntimeFlagValue(
    db,
    `B2B_AGENCY_OVERRIDE_SHARE_${candidateAgencyId}`
  );
  if (shareFlagValue) {
    const tier2Share = normalizeTier2Share(shareFlagValue);
    if (tier2Share) {
      return { b2bAgencyId: candidateAgencyId, tier2ShareOfSpread: tier2Share };
    }
  }

  let isProvisionedAgency = false;
  try {
    const agencyAccount = await db
      .prepare(
        `SELECT id FROM ledger_accounts
         WHERE owner_type = 'agency' AND owner_id = ? AND is_active = 1
         LIMIT 1`
      )
      .bind(candidateAgencyId)
      .first<{ id: string }>();
    isProvisionedAgency = Boolean(agencyAccount?.id);
  } catch {
    // `ledger_accounts` has no `is_active` column in the base schema.
    try {
      const agencyAccount = await db
        .prepare(
          `SELECT id FROM ledger_accounts
           WHERE owner_type = 'agency' AND owner_id = ?
           LIMIT 1`
        )
        .bind(candidateAgencyId)
        .first<{ id: string }>();
      isProvisionedAgency = Boolean(agencyAccount?.id);
    } catch {
      isProvisionedAgency = false;
    }
  }

  if (!isProvisionedAgency) {
    try {
      const agencyProfile = await db
        .prepare(`SELECT role FROM profiles WHERE id = ? LIMIT 1`)
        .bind(candidateAgencyId)
        .first<{ role: string | null }>();
      isProvisionedAgency = (agencyProfile?.role ?? '').trim().toLowerCase() === 'agency';
    } catch {
      isProvisionedAgency = false;
    }
  }

  if (!isProvisionedAgency) {
    return null;
  }

  return { b2bAgencyId: candidateAgencyId, tier2ShareOfSpread: '0.10' };
}


export async function getRuntimeFlagValue(
  db: AuthD1Database,
  flagKey: string
): Promise<string | null> {
  try {
    const row = await db
      .prepare(`SELECT flag_value FROM system_runtime_flags WHERE flag_key = ? LIMIT 1`)
      .bind(flagKey)
      .first<{ flag_value: string }>();
    return row?.flag_value ?? null;
  } catch {
    return null;
  }
}

export async function resolveExchangeExecutionMode(
  db: AuthD1Database,
  exchange: ActivePartnerExchangeId,
  options?: { forceShadow?: boolean }
): Promise<{ mode: 'ACTIVE' | 'SHADOW_ONLY' | 'HALTED_FLAG'; haltCode?: string }> {
  const freezeVal = await getRuntimeFlagValue(db, 'EMERGENCY_LEDGER_FREEZE');
  if (freezeVal && freezeVal.trim().toLowerCase() === 'true') {
    return { mode: 'HALTED_FLAG', haltCode: 'EMERGENCY_LEDGER_FREEZE' };
  }

  const perExchangeHalt = await getRuntimeFlagValue(
    db,
    `PARTNER_${exchange.toUpperCase()}_HALTED`
  );
  if (perExchangeHalt && perExchangeHalt.trim().toLowerCase() === 'true') {
    return {
      mode: 'HALTED_FLAG',
      haltCode: `PARTNER_${exchange.toUpperCase()}_HALTED`,
    };
  }

  if (options?.forceShadow) {
    return { mode: 'SHADOW_ONLY' };
  }

  const shadowFlagKey = SHADOW_GATED_EXCHANGE_FLAGS[exchange];
  if (shadowFlagKey) {
    const liveVal = await getRuntimeFlagValue(db, shadowFlagKey);
    if (liveVal && liveVal.trim().toLowerCase() === 'true') {
      return { mode: 'ACTIVE' };
    }
    return { mode: 'SHADOW_ONLY' };
  }

  return { mode: 'ACTIVE' };
}

interface RawTraderExchangeUidRow {
  id: string;
  profile_id: string;
  exchange: string;
  exchange_uid: string;
  linked_short_code: string | null;
  verification_status: 'PENDING_FIRST_TRADE' | 'VERIFIED_BY_PARTNER' | 'REJECTED';
  trader_email: string | null;
  trader_referred_by: string | null;
  short_link_affiliate_id: string | null;
}

/**
 * Resolves `traderUid -> ResolvedUidAttribution` from D1 `trader_exchange_uids`,
 * `short_links`, `referral_tree`, and `profiles`, merged with any explicit caller
 * overrides (`explicitUidMap`).
 */
export async function resolveD1UidAttributions(
  db: AuthD1Database,
  exchange: ActivePartnerExchangeId,
  rows: readonly NormalizedPartnerCommissionRow[],
  explicitUidMap?: Record<string, ResolvedUidAttribution>
): Promise<Map<string, ResolvedUidAttribution>> {
  const result = new Map<string, ResolvedUidAttribution>();

  if (explicitUidMap) {
    for (const [uid, mapping] of Object.entries(explicitUidMap)) {
      if (mapping && mapping.traderProfileId && mapping.traderProfileId.trim() !== '') {
        result.set(uid, mapping);
      }
    }
  }

  const missingRows = rows.filter((r) => !result.has(r.traderUid));
  if (missingRows.length === 0) {
    return result;
  }

  const uniqueUids = Array.from(new Set(missingRows.map((r) => r.traderUid)));
  const subCodeByUid = new Map<string, string>();
  for (const row of missingRows) {
    if (row.subAffiliateCode && !subCodeByUid.has(row.traderUid)) {
      subCodeByUid.set(row.traderUid, row.subAffiliateCode);
    }
  }

  for (const traderUid of uniqueUids) {
    let uidRow: RawTraderExchangeUidRow | undefined;
    try {
      uidRow = await db
        .prepare(
          `SELECT
             teu.id,
             teu.profile_id,
             teu.exchange,
             teu.exchange_uid,
             teu.linked_short_code,
             teu.verification_status,
             p.email AS trader_email,
             p.referred_by AS trader_referred_by,
             sl.affiliate_id AS short_link_affiliate_id
           FROM trader_exchange_uids teu
           JOIN profiles p ON p.id = teu.profile_id
           LEFT JOIN short_links sl ON sl.code = teu.linked_short_code AND sl.is_active = 1
           WHERE teu.exchange = ? AND teu.exchange_uid = ?
           LIMIT 1`
        )
        .bind(exchange, traderUid)
        .first<RawTraderExchangeUidRow>();
    } catch {
      uidRow = undefined;
    }

    if (!uidRow || uidRow.verification_status === 'REJECTED') {
      continue;
    }

    let l1AffiliateId: string | null = uidRow.short_link_affiliate_id ?? null;

    // Fallback 1: subAffiliateCode from partner commission row matching `short_links.code`
    if (!l1AffiliateId) {
      const candidateSubCode = subCodeByUid.get(traderUid);
      if (candidateSubCode) {
        try {
          const slRow = await db
            .prepare(
              `SELECT affiliate_id FROM short_links WHERE code = ? AND is_active = 1 LIMIT 1`
            )
            .bind(candidateSubCode)
            .first<{ affiliate_id: string }>();
          if (slRow?.affiliate_id) {
            l1AffiliateId = slRow.affiliate_id;
          }
        } catch {
          // Optional fallback
        }
      }
    }

    // Fallback 2: `referral_tree` parent affiliate
    if (!l1AffiliateId) {
      try {
        const treeParent = await db
          .prepare(
            `SELECT rt_parent.affiliate_id AS parent_affiliate_id
             FROM referral_tree rt_child
             JOIN referral_tree rt_parent ON rt_child.parent_id = rt_parent.id
             WHERE rt_child.affiliate_id = ? AND rt_child.is_active = 1
             LIMIT 1`
          )
          .bind(uidRow.profile_id)
          .first<{ parent_affiliate_id: string }>();
        if (treeParent?.parent_affiliate_id) {
          l1AffiliateId = treeParent.parent_affiliate_id;
        }
      } catch {
        // Optional table fallback
      }
    }

    // Fallback 3: `profiles.referred_by` (either profile id or referral_code)
    if (!l1AffiliateId && uidRow.trader_referred_by) {
      try {
        const refProfile = await db
          .prepare(
            `SELECT id FROM profiles WHERE id = ? OR referral_code = ? LIMIT 1`
          )
          .bind(uidRow.trader_referred_by, uidRow.trader_referred_by)
          .first<{ id: string }>();
        if (refProfile?.id) {
          l1AffiliateId = refProfile.id;
        }
      } catch {
        // Optional fallback
      }
    }

    let referrerEmail: string | undefined;
    if (l1AffiliateId) {
      try {
        const refEmailRow = await db
          .prepare(`SELECT email FROM profiles WHERE id = ? LIMIT 1`)
          .bind(l1AffiliateId)
          .first<{ email: string }>();
        referrerEmail = refEmailRow?.email ?? undefined;
      } catch {
        referrerEmail = undefined;
      }
    }

    // Decree 40/2018/ND-CP: an L2 leg is only ever paid to an explicitly
    // provisioned B2B agency upstream of the L1 affiliate. Ordinary retail
    // second-level parents stay `null` so no multi-level payout arises.
    let b2bAgencyId: string | null = null;
    let waterfallConfig: Partial<WaterfallConfig> | undefined;
    if (l1AffiliateId) {
      const agencyOverride = await resolveB2bAgencyOverrideForL1(
        db,
        l1AffiliateId,
        uidRow.profile_id
      );
      if (agencyOverride) {
        b2bAgencyId = agencyOverride.b2bAgencyId;
        waterfallConfig = agencyOverride.waterfallConfig ?? {
          tier2ShareOfSpread: agencyOverride.tier2ShareOfSpread,
        };
      }
    }

    result.set(traderUid, {
      uidRecordId: uidRow.id,
      verificationStatus: uidRow.verification_status,
      traderProfileId: uidRow.profile_id,
      l1AffiliateId,
      b2bAgencyId,
      waterfallConfig,
      traderEmail: uidRow.trader_email ?? undefined,
      referrerEmail,
    });
  }

  return result;
}

async function persistPollerRunTelemetry(
  db: AuthD1Database,
  summary: PartnerPollerRunSummary
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO partner_poller_runs (
         id, trigger_source, exchange, mode, status,
         fetched_rows, minted_batches, evidence_id, reconciliation_id,
         error_code, details, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      summary.runId,
      summary.triggerSource,
      summary.exchange,
      summary.mode,
      summary.status,
      summary.fetchedRows,
      summary.mintedBatches,
      summary.evidenceId,
      summary.reconciliationId,
      summary.errorCode,
      summary.details,
      summary.startedAt,
      summary.completedAt
    )
    .run();
}

interface ClaimReconciliationDepositsResult {
  claimed: boolean;
  conflictDepositId: string | null;
  tableAvailable: boolean;
}

/**
 * Atomically claims `(exchange, deposit_id)` pairs in `partner_reconciliation_deposits`
 * using its composite primary key + `INSERT OR IGNORE` and checks `meta.changes` so
 * concurrent or >50-run-old polls can never double-count the same wallet deposit.
 *
 * Gracefully degrades if `partner_reconciliation_deposits` does not exist in legacy
 * unit-test mocks (`no such table`).
 */
async function claimReconciliationDeposits(
  db: AuthD1Database,
  params: {
    exchange: ActivePartnerExchangeId;
    reconciliationId: string;
    depositIds: readonly string[];
    claimedAt: string;
  }
): Promise<ClaimReconciliationDepositsResult> {
  const uniqueIds = Array.from(
    new Set(params.depositIds.map((id) => id.trim()).filter((id) => id.length > 0))
  );
  if (uniqueIds.length === 0) {
    return { claimed: true, conflictDepositId: null, tableAvailable: true };
  }

  const insertedIds: string[] = [];
  for (const depositId of uniqueIds) {
    try {
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO partner_reconciliation_deposits (
             exchange, deposit_id, reconciliation_id, claimed_at
           ) VALUES (?, ?, ?, ?)`
        )
        .bind(params.exchange, depositId, params.reconciliationId, params.claimedAt)
        .run();
      const changes =
        typeof result?.meta?.changes === 'number' ? result.meta.changes : 1;
      if (changes === 0) {
        if (insertedIds.length > 0) {
          try {
            await db
              .prepare(
                `DELETE FROM partner_reconciliation_deposits
                 WHERE exchange = ? AND reconciliation_id = ?`
              )
              .bind(params.exchange, params.reconciliationId)
              .run();
          } catch {
            // Best-effort rollback of partial claims in this batch.
          }
        }
        return { claimed: false, conflictDepositId: depositId, tableAvailable: true };
      }
      insertedIds.push(depositId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(message)) {
        return { claimed: true, conflictDepositId: null, tableAvailable: false };
      }
      throw err;
    }
  }

  return { claimed: true, conflictDepositId: null, tableAvailable: true };
}

/**
 * Records the deposit IDs consumed by a `MATCHED` run so a late-settling partner
 * payout is never counted twice. `partner_poller_runs.details` is the portable
 * location (migration 031 only has `details`); deployments that add a dedicated
 * `details_json` column get it updated too, best-effort.
 */
async function persistConsumedDepositIds(
  db: AuthD1Database,
  runId: string,
  payload: {
    consumedDepositIds: string[];
    excludedDepositIds: string[];
    summaryDetails: string | null;
  }
): Promise<void> {
  const serialized = JSON.stringify({
    summaryText: payload.summaryDetails,
    reconciliationStatus: 'MATCHED',
    consumedDepositIds: payload.consumedDepositIds,
    excludedDepositIds: payload.excludedDepositIds,
  });
  try {
    await db
      .prepare(`UPDATE partner_poller_runs SET details = ? WHERE id = ?`)
      .bind(serialized, runId)
      .run();
  } catch {
    // Legacy deployments without a writable details column still reconcile the
    // current run; only future-run double-count protection is lost.
  }
  try {
    await db
      .prepare(`UPDATE partner_poller_runs SET details_json = ? WHERE id = ?`)
      .bind(serialized, runId)
      .run();
  } catch {
    // `details_json` is an optional extension column.
  }
}

async function recordShadowReconciliationBatch(
  db: AuthD1Database,
  params: {
    exchange: ActivePartnerExchangeId;
    evidenceId: string;
    walletEvidenceId: string | null;
    rowCount: number;
    mappedUidCount: number;
    unmappedUidCount: number;
    simulatedGrossUnits: bigint;
    walletCashCollectedUnits: bigint;
    discrepancyUnits: bigint;
    status: ShadowReconciliationStatus;
    notes: string;
    createdAt: string;
  }
): Promise<string> {
  const shadowId = `shdw_${globalThis.crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO partner_shadow_reconciliations (
         id, exchange, evidence_id, wallet_evidence_id,
         row_count, mapped_uid_count, unmapped_uid_count,
         simulated_gross_units, wallet_cash_collected_units, discrepancy_units,
         status, notes, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      shadowId,
      params.exchange,
      params.evidenceId,
      params.walletEvidenceId,
      params.rowCount,
      params.mappedUidCount,
      params.unmappedUidCount,
      toSafeSqlInteger(params.simulatedGrossUnits, 'simulated_gross_units'),
      toSafeSqlInteger(params.walletCashCollectedUnits, 'wallet_cash_collected_units'),
      toSafeSqlInteger(params.discrepancyUnits, 'discrepancy_units'),
      params.status,
      params.notes,
      params.createdAt
    )
    .run();
  return shadowId;
}

export async function runSingleExchangePoll(params: {
  db: AuthD1Database;
  r2?: R2BucketLike | null;
  envBag: Record<string, string | undefined>;
  triggerSource: PollerTriggerSource;
  exchange: ActivePartnerExchangeId;
  override?: ExchangePollerOverride;
  forceShadow?: boolean;
  nowMs: number;
  lookbackMs: number;
  fetchImpl?: typeof fetch;
}): Promise<PartnerPollerRunSummary> {
  const {
    db,
    r2,
    envBag,
    triggerSource,
    exchange,
    override,
    forceShadow,
    nowMs,
    lookbackMs,
    fetchImpl,
  } = params;

  const runId = `prun_${globalThis.crypto.randomUUID()}`;
  const startedAt = new Date(nowMs).toISOString();

  // 1. Check runtime emergency freeze & shadow promotion flags
  const modeDecision = await resolveExchangeExecutionMode(db, exchange, {
    forceShadow: Boolean(forceShadow || override?.forceShadow),
  });

  if (modeDecision.mode === 'HALTED_FLAG') {
    const completedAt = new Date().toISOString();
    const summary: PartnerPollerRunSummary = {
      runId,
      triggerSource,
      exchange,
      mode: 'HALTED_FLAG',
      status: 'ERROR',
      fetchedRows: 0,
      mintedBatches: 0,
      clawbackBatches: 0,
      blockedByFraud: 0,
      mappedUidCount: 0,
      unmappedUidCount: 0,
      evidenceId: null,
      walletEvidenceId: null,
      reconciliationId: null,
      shadowReconciliationId: null,
      errorCode: modeDecision.haltCode ?? 'HALTED_FLAG',
      details: `Partner poller halted by runtime flag ${modeDecision.haltCode ?? 'HALTED_FLAG'}`,
      startedAt,
      completedAt,
    };
    await persistPollerRunTelemetry(db, summary);
    return summary;
  }

  // 2. Resolve credentials unless an explicit rawPartnerPayload override was supplied
  const credentials = resolvePartnerCredentialsFromEnv(exchange, envBag);
  if (!override?.rawPartnerPayload && !credentials) {
    const completedAt = new Date().toISOString();
    const summary: PartnerPollerRunSummary = {
      runId,
      triggerSource,
      exchange,
      mode: 'SKIPPED_MISSING_CREDENTIALS',
      status: 'SKIPPED_MISSING_CREDENTIALS',
      fetchedRows: 0,
      mintedBatches: 0,
      clawbackBatches: 0,
      blockedByFraud: 0,
      mappedUidCount: 0,
      unmappedUidCount: 0,
      evidenceId: null,
      walletEvidenceId: null,
      reconciliationId: null,
      shadowReconciliationId: null,
      errorCode: null,
      details: `Skipped ${exchange}: read-only partner API credentials not configured`,
      startedAt,
      completedAt,
    };
    await persistPollerRunTelemetry(db, summary);
    return summary;
  }

  // 3. Fail closed if R2 evidence bucket is absent when polling will occur
  if (!r2) {
    const completedAt = new Date().toISOString();
    const summary: PartnerPollerRunSummary = {
      runId,
      triggerSource,
      exchange,
      mode: modeDecision.mode,
      status: 'ERROR',
      fetchedRows: 0,
      mintedBatches: 0,
      clawbackBatches: 0,
      blockedByFraud: 0,
      mappedUidCount: 0,
      unmappedUidCount: 0,
      evidenceId: null,
      walletEvidenceId: null,
      reconciliationId: null,
      shadowReconciliationId: null,
      errorCode: 'EVIDENCE_STORAGE_UNAVAILABLE',
      details: 'Immutable R2 evidence vault binding (STORAGE) is required before polling partner statements',
      startedAt,
      completedAt,
    };
    await persistPollerRunTelemetry(db, summary);
    return summary;
  }

  const endTimeMs = override?.endTimeMs ?? nowMs;
  const startTimeMs = override?.startTimeMs ?? Math.max(0, endTimeMs - lookbackMs);
  const statementPeriodStart = new Date(startTimeMs).toISOString();
  const statementPeriodEnd = new Date(endTimeMs).toISOString();

  try {
    const adapter = getPartnerAdapter(exchange);
    let parsedBatch: PartnerIngestionBatchResult;
    let rawPartnerPayloadText: string;

    if (override?.rawPartnerPayload) {
      parsedBatch = await adapter.parsePayload(override.rawPartnerPayload, {
        periodEndIso: statementPeriodEnd,
        capturedAtIso: startedAt,
      });
      rawPartnerPayloadText = override.rawPartnerPayload;
    } else {
      const mergedRows: NormalizedPartnerCommissionRow[] = [];
      const seenExternalRecordIds = new Set<string>();
      const seenCursors = new Set<string>();
      const pageRawPayloads: string[] = [];
      let cursor: string | undefined = undefined;
      let pageCount = 0;
      let firstPage: PartnerIngestionBatchResult | null = null;
      let lastNextCursor: string | null = null;

      while (pageCount < MAX_POLL_PAGES) {
        pageCount += 1;
        const page = await adapter.pollCommissions({
          credentials: credentials!,
          startTimeMs,
          endTimeMs,
          cursor,
          endpointPath: override?.endpointPath,
          nowMs,
          fetchImpl,
        });
        if (!firstPage) {
          firstPage = page;
        }
        if (page.rawPayload !== undefined) {
          pageRawPayloads.push(page.rawPayload);
        }
        for (const row of page.rows) {
          if (seenExternalRecordIds.has(row.externalRecordId)) continue;
          seenExternalRecordIds.add(row.externalRecordId);
          mergedRows.push(row);
        }

        const nextCursor =
          typeof page.nextCursor === 'string' && page.nextCursor.trim().length > 0
            ? page.nextCursor.trim()
            : null;
        lastNextCursor = nextCursor;

        if (!nextCursor || seenCursors.has(nextCursor)) {
          break;
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      if (pageCount === 1 && firstPage) {
        parsedBatch = {
          ...firstPage,
          rows: mergedRows,
          nextCursor: lastNextCursor,
        };
        rawPartnerPayloadText =
          firstPage.rawPayload ??
          JSON.stringify({ rows: mergedRows.length, sha256: firstPage.evidence.payloadSha256 });
      } else {
        rawPartnerPayloadText = JSON.stringify({
          exchange,
          pageCount,
          pages: pageRawPayloads,
        });
        const mergedEvidence = await computePayloadEvidence(
          rawPartnerPayloadText,
          firstPage?.evidence.sourceKind ?? 'rest_poll',
          startedAt
        );
        parsedBatch = {
          exchange,
          rows: mergedRows,
          nextCursor: lastNextCursor,
          evidence: mergedEvidence,
          rawPayload: rawPartnerPayloadText,
        };
      }
    }

    // Resolve UID attributions from D1 `trader_exchange_uids` + `short_links` + `referral_tree`
    const uidMap = await resolveD1UidAttributions(
      db,
      exchange,
      parsedBatch.rows,
      override?.uidToProfileMap
    );

    const activeExecution = modeDecision.mode === 'ACTIVE';
    const ledgerKeysByExternalRecord = new Map<string, string[]>();
    for (const row of parsedBatch.rows) {
      if (!row.isClawbackOrAdjustment && row.signedUnits1e8 > BI_ZERO) {
        ledgerKeysByExternalRecord.set(row.externalRecordId, [
          `ingest:${row.externalRecordId}`,
        ]);
      } else if (row.isClawbackOrAdjustment && row.signedUnits1e8 < BI_ZERO) {
        ledgerKeysByExternalRecord.set(row.externalRecordId, [
          `ingest_clawback:${row.externalRecordId}`,
          `poller_void:${row.externalRecordId}`,
          `poller_post:${row.externalRecordId}`,
          `ingest_void:${row.externalRecordId}`,
          `ingest_post:${row.externalRecordId}`,
        ]);
      }
    }
    const existingLedgerKeys = activeExecution
      ? await findExistingLedgerIdempotencyKeys(
          db,
          Array.from(ledgerKeysByExternalRecord.values()).flat()
        )
      : new Set<string>();
    const isRowAlreadyApplied = (externalRecordId: string): boolean =>
      (ledgerKeysByExternalRecord.get(externalRecordId) ?? []).some((key) =>
        existingLedgerKeys.has(key)
      );

    const positiveTraderUids = new Set<string>();
    let positiveAllocatedSum = BI_ZERO;
    let totalClawbackUnits = BI_ZERO;
    let netSignedSimulatedUnits = BI_ZERO;

    for (const row of parsedBatch.rows) {
      netSignedSimulatedUnits += row.signedUnits1e8;
      if (activeExecution && isRowAlreadyApplied(row.externalRecordId)) continue;
      if (!row.isClawbackOrAdjustment && row.signedUnits1e8 > BI_ZERO) {
        positiveAllocatedSum += row.signedUnits1e8;
        positiveTraderUids.add(row.traderUid);
      } else if (row.isClawbackOrAdjustment && row.signedUnits1e8 < BI_ZERO) {
        totalClawbackUnits += -row.signedUnits1e8;
      }
    }

    const unmintedPositiveRows = parsedBatch.rows.filter(
      (row) =>
        !row.isClawbackOrAdjustment &&
        row.signedUnits1e8 > BI_ZERO &&
        !isRowAlreadyApplied(row.externalRecordId)
    );
    const unappliedClawbackRows = parsedBatch.rows.filter(
      (row) =>
        row.isClawbackOrAdjustment &&
        row.signedUnits1e8 < BI_ZERO &&
        !isRowAlreadyApplied(row.externalRecordId)
    );
    if (
      activeExecution &&
      parsedBatch.rows.length > 0 &&
      unmintedPositiveRows.length === 0 &&
      unappliedClawbackRows.length === 0
    ) {
      const completedAt = new Date().toISOString();
      const summary: PartnerPollerRunSummary = {
        runId,
        triggerSource,
        exchange,
        mode: 'ACTIVE',
        status: 'SUCCESS',
        fetchedRows: parsedBatch.rows.length,
        mintedBatches: 0,
        clawbackBatches: 0,
        blockedByFraud: 0,
        mappedUidCount: 0,
        unmappedUidCount: 0,
        evidenceId: null,
        walletEvidenceId: null,
        reconciliationId: null,
        shadowReconciliationId: null,
        errorCode: null,
        details: `Skipped ${parsedBatch.rows.length} already-applied partner record(s) for ${exchange}`,
        startedAt,
        completedAt,
      };
      await persistPollerRunTelemetry(db, summary);
      return summary;
    }

    let mappedUidCount = 0;
    const unmappedUids: string[] = [];
    for (const uid of positiveTraderUids) {
      if (uidMap.has(uid)) {
        mappedUidCount += 1;
      } else {
        unmappedUids.push(uid);
      }
    }
    const unmappedUidCount = unmappedUids.length;

    const envBagTyped = envBag as Record<string, string | undefined>;
    const depositPayloadPresent =
      override?.walletDeposits !== undefined ||
      readEnvString(envBagTyped, `${exchange.toUpperCase()}_WALLET_DEPOSITS_PAYLOAD`) !==
        undefined;
    const depositEndpointPath =
      override?.depositEndpointPath ??
      readEnvString(envBagTyped, `${exchange.toUpperCase()}_WALLET_DEPOSITS_ENDPOINT_PATH`);
    const shouldResolveDeposits =
      override?.walletStatement === undefined &&
      (depositPayloadPresent || Boolean(depositEndpointPath && credentials));

    let walletStatement: WalletStatementSnapshot | null =
      override?.walletStatement ??
      resolveWalletStatementFromEnv(exchange, envBag) ??
      null;
    let resolvedDepositCash: ResolvedWalletDepositCash | null = null;
    if (!walletStatement && shouldResolveDeposits) {
      resolvedDepositCash = await resolveWalletDepositCash({
        db,
        exchange,
        startTimeMs,
        endTimeMs,
        nowMs,
        credentials,
        envBag: envBagTyped,
        walletDeposits: override?.walletDeposits,
        depositEndpointPath,
        fetchImpl,
      });
      walletStatement = resolvedDepositCash;
    }

    // =========================================================================
    // SHADOW_ONLY Execution Path (Zero Live Ledger Minting)
    // =========================================================================
    if (modeDecision.mode === 'SHADOW_ONLY') {
      const partnerEvidence = await storeEvidenceObject(db, r2, {
        exchange,
        sourceKind: parsedBatch.evidence.sourceKind,
        rawBytes: rawPartnerPayloadText,
        statementPeriodStart,
        statementPeriodEnd,
        createdAt: startedAt,
      });

      let walletEvidenceId: string | null = null;
      let walletCashUnits = BI_ZERO;
      let discrepancyUnits = BI_ZERO;
      let shadowStatus: ShadowReconciliationStatus = 'SHADOW_LOGGED';
      let notes = `Shadow poll logged (${parsedBatch.rows.length} rows, ${mappedUidCount} mapped UIDs, ${unmappedUidCount} unmapped UIDs)`;

      if (walletStatement) {
        walletCashUnits = parseUsdToLedgerUnits(walletStatement.walletCashCollectedUsd);
        const walletEvidence = await storeEvidenceObject(db, r2, {
          exchange,
          sourceKind: 'wallet_statement',
          rawBytes: walletStatement.rawWalletStatementPayload,
          statementPeriodStart,
          statementPeriodEnd,
          createdAt: startedAt,
        });
        walletEvidenceId = walletEvidence.id;

        const evalResult = evaluateCashReconciliation(
          positiveAllocatedSum,
          walletCashUnits,
          totalClawbackUnits
        );
        discrepancyUnits = evalResult.discrepancyUnits;
        if (evalResult.status === 'DISCREPANCY_HALTED') {
          shadowStatus = 'SHADOW_DISCREPANCY';
          notes = `Shadow discrepancy detected: discrepancyUnits=${discrepancyUnits.toString()}`;
        } else if (unmappedUidCount === 0) {
          shadowStatus = 'PROMOTED_READY';
          notes = `Shadow batch reconciled within $0.01 tolerance and all ${mappedUidCount} UIDs mapped`;
        }
      }

      const shadowReconId = await recordShadowReconciliationBatch(db, {
        exchange,
        evidenceId: partnerEvidence.id,
        walletEvidenceId,
        rowCount: parsedBatch.rows.length,
        mappedUidCount,
        unmappedUidCount,
        simulatedGrossUnits: netSignedSimulatedUnits >= BI_ZERO ? netSignedSimulatedUnits : BI_ZERO,
        walletCashCollectedUnits: walletCashUnits,
        discrepancyUnits,
        status: shadowStatus,
        notes,
        createdAt: startedAt,
      });

      const completedAt = new Date().toISOString();
      const summary: PartnerPollerRunSummary = {
        runId,
        triggerSource,
        exchange,
        mode: 'SHADOW_ONLY',
        status: shadowStatus === 'SHADOW_DISCREPANCY' ? 'DISCREPANCY_HALTED' : 'SUCCESS',
        fetchedRows: parsedBatch.rows.length,
        mintedBatches: 0,
        clawbackBatches: 0,
        blockedByFraud: 0,
        mappedUidCount,
        unmappedUidCount,
        evidenceId: partnerEvidence.id,
        walletEvidenceId,
        reconciliationId: null,
        shadowReconciliationId: shadowReconId,
        errorCode: shadowStatus === 'SHADOW_DISCREPANCY' ? 'SHADOW_DISCREPANCY' : null,
        details: notes,
        startedAt,
        completedAt,
      };
      await persistPollerRunTelemetry(db, summary);
      return summary;
    }

    // =========================================================================
    // ACTIVE Execution Path (Fail-Closed CASH_COLLECTED Gate + T+7 Ledger Mint)
    // =========================================================================

    // If there are zero rows and no wallet statement, record empty clean poll in R2
    if (parsedBatch.rows.length === 0 && !walletStatement) {
      const partnerEvidence = await storeEvidenceObject(db, r2, {
        exchange,
        sourceKind: parsedBatch.evidence.sourceKind,
        rawBytes: rawPartnerPayloadText,
        statementPeriodStart,
        statementPeriodEnd,
        createdAt: startedAt,
      });
      const completedAt = new Date().toISOString();
      const summary: PartnerPollerRunSummary = {
        runId,
        triggerSource,
        exchange,
        mode: 'ACTIVE',
        status: 'SUCCESS',
        fetchedRows: 0,
        mintedBatches: 0,
        clawbackBatches: 0,
        blockedByFraud: 0,
        mappedUidCount: 0,
        unmappedUidCount: 0,
        evidenceId: partnerEvidence.id,
        walletEvidenceId: null,
        reconciliationId: null,
        shadowReconciliationId: null,
        errorCode: null,
        details: `Polled 0 commission rows for ${exchange}`,
        startedAt,
        completedAt,
      };
      await persistPollerRunTelemetry(db, summary);
      return summary;
    }

    // Never self-attest wallet cash from partner commission rows!
    if (!walletStatement) {
      const partnerEvidence = await storeEvidenceObject(db, r2, {
        exchange,
        sourceKind: parsedBatch.evidence.sourceKind,
        rawBytes: rawPartnerPayloadText,
        statementPeriodStart,
        statementPeriodEnd,
        createdAt: startedAt,
      });
      const shadowReconId = await recordShadowReconciliationBatch(db, {
        exchange,
        evidenceId: partnerEvidence.id,
        walletEvidenceId: null,
        rowCount: parsedBatch.rows.length,
        mappedUidCount,
        unmappedUidCount,
        simulatedGrossUnits: positiveAllocatedSum,
        walletCashCollectedUnits: BI_ZERO,
        discrepancyUnits: positiveAllocatedSum,
        status: 'SHADOW_DISCREPANCY',
        notes: 'Active poll halted before minting: independent wallet cash statement not provided',
        createdAt: startedAt,
      });
      const completedAt = new Date().toISOString();
      const summary: PartnerPollerRunSummary = {
        runId,
        triggerSource,
        exchange,
        mode: 'ACTIVE',
        status: 'DISCREPANCY_HALTED',
        fetchedRows: parsedBatch.rows.length,
        mintedBatches: 0,
        clawbackBatches: 0,
        blockedByFraud: 0,
        mappedUidCount,
        unmappedUidCount,
        evidenceId: partnerEvidence.id,
        walletEvidenceId: null,
        reconciliationId: null,
        shadowReconciliationId: shadowReconId,
        errorCode: 'MISSING_WALLET_CASH_STATEMENT',
        details:
          'Active commission rows captured in R2, but independent wallet cash statement is required before CASH_COLLECTED minting',
        startedAt,
        completedAt,
      };
      await persistPollerRunTelemetry(db, summary);
      return summary;
    }

    // Pre-validate unmapped UIDs & clawback target batches BEFORE burning a MATCHED reconciliation
    if (unmappedUidCount > 0) {
      const partnerEvidence = await storeEvidenceObject(db, r2, {
        exchange,
        sourceKind: parsedBatch.evidence.sourceKind,
        rawBytes: rawPartnerPayloadText,
        statementPeriodStart,
        statementPeriodEnd,
        createdAt: startedAt,
      });
      const completedAt = new Date().toISOString();
      const summary: PartnerPollerRunSummary = {
        runId,
        triggerSource,
        exchange,
        mode: 'ACTIVE',
        status: 'DISCREPANCY_HALTED',
        fetchedRows: parsedBatch.rows.length,
        mintedBatches: 0,
        clawbackBatches: 0,
        blockedByFraud: 0,
        mappedUidCount,
        unmappedUidCount,
        evidenceId: partnerEvidence.id,
        walletEvidenceId: null,
        reconciliationId: null,
        shadowReconciliationId: null,
        errorCode: 'UNMAPPED_TRADER_UIDS',
        details: JSON.stringify({ unmappedUids }),
        startedAt,
        completedAt,
      };
      await persistPollerRunTelemetry(db, summary);
      return summary;
    }

    const ledger = new DoubleEntryLedgerService(db);
    const clawbackMap = override?.clawbackOriginalBatchMap ?? {};
    const resolvedClawbacks = new Map<string, string>();
    const cumulativeClawbackPerBatch = new Map<string, bigint>();

    for (const row of parsedBatch.rows) {
      if (isRowAlreadyApplied(row.externalRecordId)) continue;
      if (row.isClawbackOrAdjustment && row.signedUnits1e8 < BI_ZERO) {
        const clawbackUnits = -row.signedUnits1e8;
        let targetBatchId: string | undefined =
          clawbackMap[row.externalRecordId] ?? clawbackMap[row.traderUid];
        if (!targetBatchId) {
          const latestBatchRow = await db
            .prepare(
              `SELECT id FROM ledger_journal_batches
               WHERE exchange = ?
                 AND trader_uid = ?
                 AND journal_type = 'COMMISSION_INFLIGHT'
                 AND status IN ('INFLIGHT', 'SETTLED')
               ORDER BY created_at DESC
               LIMIT 1`
            )
            .bind(exchange, row.traderUid)
            .first<{ id: string }>();
          targetBatchId = latestBatchRow?.id ?? undefined;
        }

        if (!targetBatchId) {
          throw new PartnerIntegrationError(
            'CLAWBACK_TARGET_BATCH_NOT_FOUND',
            `Missing original commission batch for clawback ${row.externalRecordId} (trader ${row.traderUid})`,
            exchange
          );
        }

        const origBatch = await ledger.getBatchById(targetBatchId);
        const origBatchStatus = String(origBatch?.status ?? '').trim().toUpperCase();
        if (
          !origBatch ||
          origBatch.journalType !== 'COMMISSION_INFLIGHT' ||
          origBatchStatus === 'VOIDED' ||
          origBatchStatus === 'REVERSED' ||
          origBatch.exchange !== exchange
        ) {
          throw new PartnerIntegrationError(
            'INVALID_CLAWBACK_TARGET_BATCH',
            `Original batch ${targetBatchId} is missing, voided/reversed, or from a different exchange`,
            exchange
          );
        }

        if (clawbackUnits > origBatch.grossCommissionUnits) {
          throw new PartnerIntegrationError(
            'CLAWBACK_EXCEEDS_ORIGINAL_BATCH',
            `Clawback ${clawbackUnits.toString()} exceeds original batch gross ${origBatch.grossCommissionUnits.toString()} on ${targetBatchId}`,
            exchange
          );
        }

        const remLegs = origBatch.metadata.remainingLegs as
          | { grossUnits?: string }
          | undefined;
        const remainingGross = BigInt(String(remLegs?.grossUnits ?? '0'));
        const projectedBatchClawback =
          (cumulativeClawbackPerBatch.get(targetBatchId) ?? BI_ZERO) + clawbackUnits;
        if (projectedBatchClawback > remainingGross) {
          throw new PartnerIntegrationError(
            'CLAWBACK_EXCEEDS_ORIGINAL_BATCH',
            `Clawback ${projectedBatchClawback.toString()} exceeds remaining gross ${remainingGross.toString()} on ${targetBatchId}`,
            exchange
          );
        }

        cumulativeClawbackPerBatch.set(targetBatchId, projectedBatchClawback);
        resolvedClawbacks.set(row.externalRecordId, targetBatchId);
      }
    }

    const walletCashUnits = parseUsdToLedgerUnits(walletStatement.walletCashCollectedUsd);

    const partnerEvidence = await storeEvidenceObject(db, r2, {
      exchange,
      sourceKind: parsedBatch.evidence.sourceKind,
      rawBytes: rawPartnerPayloadText,
      statementPeriodStart,
      statementPeriodEnd,
      createdAt: startedAt,
    });
    const walletEvidence = await storeEvidenceObject(db, r2, {
      exchange,
      sourceKind: 'wallet_statement',
      rawBytes: walletStatement.rawWalletStatementPayload,
      statementPeriodStart,
      statementPeriodEnd,
      createdAt: startedAt,
    });

    const reconciliation = await reconcilePartnerCashBatch(db, {
      exchange,
      evidenceId: partnerEvidence.id,
      walletEvidenceId: walletEvidence.id,
      uidAllocatedUnits: positiveAllocatedSum,
      walletCashCollectedUnits: walletCashUnits,
      clawbackOffsetUnits: totalClawbackUnits,
      r2,
    });

    if (reconciliation.status !== 'MATCHED') {
      const completedAt = new Date().toISOString();
      const summary: PartnerPollerRunSummary = {
        runId,
        triggerSource,
        exchange,
        mode: 'ACTIVE',
        status: 'DISCREPANCY_HALTED',
        fetchedRows: parsedBatch.rows.length,
        mintedBatches: 0,
        clawbackBatches: 0,
        blockedByFraud: 0,
        mappedUidCount,
        unmappedUidCount,
        evidenceId: partnerEvidence.id,
        walletEvidenceId: walletEvidence.id,
        reconciliationId: reconciliation.id,
        shadowReconciliationId: null,
        errorCode: 'RECONCILIATION_DISCREPANCY_HALTED',
        details: `Reconciliation halted: discrepancyUnits=${reconciliation.discrepancyUnits.toString()}`,
        startedAt,
        completedAt,
      };
      await persistPollerRunTelemetry(db, summary);
      return summary;
    }

    const consumedDepositIdsToPersist =
      walletStatement?.consumedDepositIds ?? resolvedDepositCash?.consumedDepositIds;
    if (consumedDepositIdsToPersist && consumedDepositIdsToPersist.length > 0) {
      const claimResult = await claimReconciliationDeposits(db, {
        exchange,
        reconciliationId: reconciliation.id,
        depositIds: consumedDepositIdsToPersist,
        claimedAt: startedAt,
      });
      if (!claimResult.claimed) {
        const completedAt = new Date().toISOString();
        const summary: PartnerPollerRunSummary = {
          runId,
          triggerSource,
          exchange,
          mode: 'ACTIVE',
          status: 'DISCREPANCY_HALTED',
          fetchedRows: parsedBatch.rows.length,
          mintedBatches: 0,
          clawbackBatches: 0,
          blockedByFraud: 0,
          mappedUidCount,
          unmappedUidCount,
          evidenceId: partnerEvidence.id,
          walletEvidenceId: walletEvidence.id,
          reconciliationId: reconciliation.id,
          shadowReconciliationId: null,
          errorCode: 'RECONCILIATION_DISCREPANCY_HALTED',
          details: `Duplicate deposit claim conflict on ${exchange}:${claimResult.conflictDepositId ?? 'unknown'}`,
          startedAt,
          completedAt,
        };
        await persistPollerRunTelemetry(db, summary);
        return summary;
      }
    }

    // Loaded lazily: `json-rules-engine` publishes ESM-only entrypoints that the
    // jsdom Jest environment cannot parse, so a static import here would break
    // every suite that merely imports the partner registry.
    const { M2SybilGraphEngine: M2SybilGraphEngineRuntime } = await import(
      '@/lib/fraud/m2-sybil-graph-engine'
    );
    const fraudEngine: M2SybilGraphEngine = new M2SybilGraphEngineRuntime();
    const telemetryCache = createFraudTelemetryBatchCache();
    const fraudVerdicts = new Map<
      string,
      Promise<M2FraudEvaluationVerdict>
    >();
    const evaluateAttribution = (
      traderId: string,
      referrerId: string,
      evaluate: () => Promise<M2FraudEvaluationVerdict>
    ): Promise<M2FraudEvaluationVerdict> => {
      const key = `${traderId.trim()}\u0000${referrerId.trim()}`;
      const existing = fraudVerdicts.get(key);
      if (existing) return existing;
      const pending = evaluate();
      fraudVerdicts.set(key, pending);
      void pending.catch(() => fraudVerdicts.delete(key));
      return pending;
    };
    let mintedBatches = 0;
    let clawbackBatches = 0;
    let blockedByFraud = 0;
    const verifiedUidRecordIds = new Set<string>();

    for (const row of parsedBatch.rows) {
      if (isRowAlreadyApplied(row.externalRecordId)) {
        continue;
      }
      if (row.isClawbackOrAdjustment && row.signedUnits1e8 < BI_ZERO) {
        const clawbackUnits = -row.signedUnits1e8;
        const resolvedOriginalBatchId = resolvedClawbacks.get(row.externalRecordId)!;
        await ledger.applyClawback({
          idempotencyKey: `ingest_clawback:${row.externalRecordId}`,
          originalBatchId: resolvedOriginalBatchId,
          clawbackUnits,
          reason: `Partner adjustment ${exchange}:${row.externalRecordId}`,
          recoverFromFutureInflight: Boolean(override?.recoverClawbackFromFutureInflight),
        });
        clawbackBatches += 1;
        continue;
      }

      if (row.signedUnits1e8 <= BI_ZERO) {
        continue;
      }

      const mapped = uidMap.get(row.traderUid)!;
      let effectiveL1AffiliateId = mapped.l1AffiliateId ?? null;
      let effectiveB2bAgencyId = mapped.b2bAgencyId ?? null;
      let effectiveWaterfallConfig = mapped.waterfallConfig;
      if (effectiveL1AffiliateId) {
        const l1AffiliateId = effectiveL1AffiliateId;
        const fraudVerdict = await evaluateAttribution(
          mapped.traderProfileId,
          l1AffiliateId,
          async () => {
            const telemetry = await loadAttributionFraudTelemetry(
              db as unknown as FraudTelemetryD1Like,
              {
                traderId: mapped.traderProfileId,
                referrerId: l1AffiliateId,
                traderEmail: mapped.traderEmail,
                referrerEmail: mapped.referrerEmail,
              },
              telemetryCache
            );
            return fraudEngine.evaluate(
              db as unknown as LegacyD1Database,
              {
                eventType: 'referral_attribution',
                idempotencyKey: `poller_attribution:${exchange}:${row.externalRecordId}`,
                traderId: mapped.traderProfileId,
                referrerId: l1AffiliateId,
                traderEmail: telemetry.traderEmail,
                referrerEmail: telemetry.referrerEmail,
                traderIpHash: telemetry.traderIpHash,
                referrerIpHash: telemetry.referrerIpHash,
                traderDeviceHash: telemetry.traderDeviceHash,
                referrerDeviceHash: telemetry.referrerDeviceHash,
                signupDeltaMinutes: telemetry.signupDeltaMinutes,
                sameDeviceRecentSignups10m: telemetry.sameDeviceRecentSignups10m,
                subSecondClickBurstCount: telemetry.subSecondClickBurstCount,
              }
            );
          }
        );
        if (!fraudVerdict.allowed) {
          // A blocked L1 cannot pass an override through to its own upstream agency.
          effectiveL1AffiliateId = null;
          effectiveB2bAgencyId = null;
          effectiveWaterfallConfig = undefined;
          blockedByFraud += 1;
        }
      }

      if (effectiveB2bAgencyId) {
        const b2bAgencyId = effectiveB2bAgencyId;
        const agencyVerdict = await evaluateAttribution(
          mapped.traderProfileId,
          b2bAgencyId,
          async () => {
            const agencyTelemetry = await loadAttributionFraudTelemetry(
              db as unknown as FraudTelemetryD1Like,
              {
                traderId: mapped.traderProfileId,
                referrerId: b2bAgencyId,
                traderEmail: mapped.traderEmail,
                referrerEmail: null,
              },
              telemetryCache
            );
            return fraudEngine.evaluate(
              db as unknown as LegacyD1Database,
              {
                eventType: 'referral_attribution',
                idempotencyKey: `poller_agency_attribution:${exchange}:${row.externalRecordId}`,
                traderId: mapped.traderProfileId,
                referrerId: b2bAgencyId,
                traderEmail: agencyTelemetry.traderEmail,
                referrerEmail: agencyTelemetry.referrerEmail,
                traderIpHash: agencyTelemetry.traderIpHash,
                referrerIpHash: agencyTelemetry.referrerIpHash,
                traderDeviceHash: agencyTelemetry.traderDeviceHash,
                referrerDeviceHash: agencyTelemetry.referrerDeviceHash,
                signupDeltaMinutes: agencyTelemetry.signupDeltaMinutes,
                sameDeviceRecentSignups10m: agencyTelemetry.sameDeviceRecentSignups10m,
                subSecondClickBurstCount: agencyTelemetry.subSecondClickBurstCount,
              }
            );
          }
        );
        if (!agencyVerdict.allowed) {
          effectiveB2bAgencyId = null;
          effectiveWaterfallConfig = undefined;
          blockedByFraud += 1;
        }
      }

      await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: `ingest:${row.externalRecordId}`,
        exchange,
        traderUid: row.traderUid,
        traderId: mapped.traderProfileId,
        l1AffiliateId: effectiveL1AffiliateId,
        b2bAgencyId: effectiveB2bAgencyId,
        waterfallConfig: effectiveWaterfallConfig,
        reconciliationId: reconciliation.id,
        evidenceId: partnerEvidence.id,
        grossCommissionUnits: row.signedUnits1e8,
        r2,
      });
      mintedBatches += 1;

      if (mapped.uidRecordId && mapped.verificationStatus === 'PENDING_FIRST_TRADE') {
        verifiedUidRecordIds.add(mapped.uidRecordId);
      }
    }

    const verifiedAtIso = new Date().toISOString();
    for (const uidRecordId of verifiedUidRecordIds) {
      try {
        await db
          .prepare(
            `UPDATE trader_exchange_uids
             SET verification_status = 'VERIFIED_BY_PARTNER',
                 verified_at = COALESCE(verified_at, ?),
                 updated_at = ?
             WHERE id = ? AND verification_status = 'PENDING_FIRST_TRADE'`
          )
          .bind(verifiedAtIso, verifiedAtIso, uidRecordId)
          .run();
      } catch {
        // Non-fatal metadata promotion
      }
    }

    const completedAt = new Date().toISOString();
    const summary: PartnerPollerRunSummary = {
      runId,
      triggerSource,
      exchange,
      mode: 'ACTIVE',
      status: 'SUCCESS',
      fetchedRows: parsedBatch.rows.length,
      mintedBatches,
      clawbackBatches,
      blockedByFraud,
      mappedUidCount,
      unmappedUidCount,
      evidenceId: partnerEvidence.id,
      walletEvidenceId: walletEvidence.id,
      reconciliationId: reconciliation.id,
      shadowReconciliationId: null,
      errorCode: null,
      details: `Reconciled MATCHED batch ${reconciliation.id}: minted=${mintedBatches}, clawbacks=${clawbackBatches}, fraudBlocked=${blockedByFraud}`,
      startedAt,
      completedAt,
    };
    await persistPollerRunTelemetry(db, summary);
    if (consumedDepositIdsToPersist && consumedDepositIdsToPersist.length > 0) {
      await persistConsumedDepositIds(db, runId, {
        consumedDepositIds: consumedDepositIdsToPersist,
        excludedDepositIds: resolvedDepositCash?.excludedDepositIds ?? [],
        summaryDetails: summary.details,
      });
    }
    return summary;
  } catch (err) {
    const completedAt = new Date().toISOString();
    const errCode =
      err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? ((err as { code: string }).code)
        : 'POLLER_EXECUTION_ERROR';
    const errMsg = err instanceof Error ? err.message : String(err);

    const summary: PartnerPollerRunSummary = {
      runId,
      triggerSource,
      exchange,
      mode: modeDecision.mode,
      status: 'ERROR',
      fetchedRows: 0,
      mintedBatches: 0,
      clawbackBatches: 0,
      blockedByFraud: 0,
      mappedUidCount: 0,
      unmappedUidCount: 0,
      evidenceId: null,
      walletEvidenceId: null,
      reconciliationId: null,
      shadowReconciliationId: null,
      errorCode: errCode,
      details: errMsg.slice(0, 500),
      startedAt,
      completedAt,
    };
    await persistPollerRunTelemetry(db, summary);
    if (err instanceof PartnerIntegrationError) {
      err.runSummary = summary;
      throw err;
    }
    return summary;
  }
}

export async function runPartnerPollerCycle(
  input: PartnerPollerCycleInput
): Promise<PartnerPollerCycleResult> {
  const nowMs = input.nowMs ?? Date.now();
  const lookbackMs = input.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const startedAt = new Date(nowMs).toISOString();
  const envBag = input.env ?? {};
  const exchanges = input.exchanges ?? POLLABLE_PARTNER_EXCHANGES;

  const runs: PartnerPollerRunSummary[] = [];
  for (const exchange of exchanges) {
    try {
      const summary = await runSingleExchangePoll({
        db: input.db,
        r2: input.r2,
        envBag,
        triggerSource: input.triggerSource,
        exchange,
        override: input.overrides?.[exchange],
        forceShadow: input.forceShadow,
        nowMs,
        lookbackMs,
        fetchImpl: input.fetchImpl,
      });
      runs.push(summary);
    } catch (err) {
      // One exchange's clawback pre-validation failure must not abort the
      // remaining exchanges' poll in the same cron tick; the failed run's ERROR
      // telemetry was already persisted by `runSingleExchangePoll`.
      if (!(err instanceof PartnerIntegrationError)) {
        throw err;
      }
      if (err.runSummary) {
        runs.push(err.runSummary);
      }
    }
  }

  return {
    triggerSource: input.triggerSource,
    startedAt,
    completedAt: new Date().toISOString(),
    runs,
  };
}

export interface ShadowPromotionSummary {
  exchange: ActivePartnerExchangeId;
  flagKey: string | null;
  liveEnabled: boolean;
  totalShadowBatches: number;
  promotedReadyBatches: number;
  discrepancyBatches: number;
  earliestShadowAt: string | null;
  latestShadowAt: string | null;
  totalSimulatedGrossUnits: string;
}

export function inspectPartnerCredentialPresence(
  envBag: Record<string, string | undefined> = typeof process !== 'undefined' && process.env
    ? (process.env as Record<string, string | undefined>)
    : {}
): Record<ActivePartnerExchangeId, boolean> {
  return {
    bybit: resolvePartnerCredentialsFromEnv('bybit', envBag) !== null,
    okx: resolvePartnerCredentialsFromEnv('okx', envBag) !== null,
    bitget: resolvePartnerCredentialsFromEnv('bitget', envBag) !== null,
    kucoin: resolvePartnerCredentialsFromEnv('kucoin', envBag) !== null,
    gateio: resolvePartnerCredentialsFromEnv('gateio', envBag) !== null,
  };
}

export async function listPartnerPollerStatus(
  db: AuthD1Database,
  envBag?: Record<string, string | undefined>
): Promise<{
  credentialPresence: Record<ActivePartnerExchangeId, boolean>;
  recentRuns: Array<{
    id: string;
    triggerSource: string;
    exchange: string;
    mode: string;
    status: string;
    fetchedRows: number;
    mintedBatches: number;
    evidenceId: string | null;
    reconciliationId: string | null;
    errorCode: string | null;
    details: string | null;
    startedAt: string;
    completedAt: string | null;
  }>;
  shadowSummary: ShadowPromotionSummary[];
}> {
  const runsRes = await db
    .prepare(
      `SELECT
         id, trigger_source, exchange, mode, status,
         fetched_rows, minted_batches, evidence_id, reconciliation_id,
         error_code, details, started_at, completed_at
       FROM partner_poller_runs
       ORDER BY started_at DESC
       LIMIT 50`
    )
    .all<{
      id: string;
      trigger_source: string;
      exchange: string;
      mode: string;
      status: string;
      fetched_rows: number;
      minted_batches: number;
      evidence_id: string | null;
      reconciliation_id: string | null;
      error_code: string | null;
      details: string | null;
      started_at: string;
      completed_at: string | null;
    }>();

  const shadowSummary: ShadowPromotionSummary[] = [];
  for (const exchange of ['kucoin', 'gateio'] as const) {
    const flagKey = SHADOW_GATED_EXCHANGE_FLAGS[exchange] ?? null;
    const liveVal = flagKey ? await getRuntimeFlagValue(db, flagKey) : null;
    const agg = await db
      .prepare(
        `SELECT
           COUNT(*) AS total_batches,
           SUM(CASE WHEN status = 'PROMOTED_READY' THEN 1 ELSE 0 END) AS ready_batches,
           SUM(CASE WHEN status = 'SHADOW_DISCREPANCY' THEN 1 ELSE 0 END) AS discrepancy_batches,
           MIN(created_at) AS earliest_at,
           MAX(created_at) AS latest_at,
           COALESCE(SUM(simulated_gross_units), 0) AS total_gross_units
         FROM partner_shadow_reconciliations
         WHERE exchange = ?`
      )
      .bind(exchange)
      .first<{
        total_batches: number;
        ready_batches: number | null;
        discrepancy_batches: number | null;
        earliest_at: string | null;
        latest_at: string | null;
        total_gross_units: number;
      }>();

    shadowSummary.push({
      exchange,
      flagKey,
      liveEnabled: Boolean(liveVal && liveVal.trim().toLowerCase() === 'true'),
      totalShadowBatches: Number(agg?.total_batches ?? 0),
      promotedReadyBatches: Number(agg?.ready_batches ?? 0),
      discrepancyBatches: Number(agg?.discrepancy_batches ?? 0),
      earliestShadowAt: agg?.earliest_at ?? null,
      latestShadowAt: agg?.latest_at ?? null,
      totalSimulatedGrossUnits: fromSqlInteger(
        agg?.total_gross_units ?? 0,
        'total_gross_units'
      ).toString(),
    });
  }

  const mergedEnv: Record<string, string | undefined> = {
    ...(typeof process !== 'undefined' && process.env
      ? (process.env as Record<string, string | undefined>)
      : {}),
    ...(envBag ?? {}),
  };

  return {
    credentialPresence: inspectPartnerCredentialPresence(mergedEnv),
    recentRuns: (runsRes.results ?? []).map((r) => ({
      id: r.id,
      triggerSource: r.trigger_source,
      exchange: r.exchange,
      mode: r.mode,
      status: r.status,
      fetchedRows: Number(r.fetched_rows),
      mintedBatches: Number(r.minted_batches),
      evidenceId: r.evidence_id,
      reconciliationId: r.reconciliation_id,
      errorCode: r.error_code,
      details: (() => {
        if (!r.details) return null;
        try {
          const parsed: unknown = JSON.parse(r.details);
          if (
            parsed &&
            typeof parsed === 'object' &&
            'summaryText' in parsed &&
            typeof parsed.summaryText === 'string'
          ) {
            return parsed.summaryText;
          }
        } catch {
          // Keep legacy human-readable details unchanged.
        }
        return r.details;
      })(),
      startedAt: r.started_at,
      completedAt: r.completed_at,
    })),
    shadowSummary,
  };
}

export class PartnerHttpPollerService {
  private readonly db: AuthD1Database;
  private readonly r2: R2BucketLike | null | undefined;
  private readonly envBag: Record<string, string | undefined> | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(params: {
    db: AuthD1Database;
    r2?: R2BucketLike | null;
    envBag?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  }) {
    this.db = params.db;
    this.r2 = params.r2;
    this.envBag = params.envBag;
    this.fetchImpl = params.fetchImpl;
  }

  public inspectCredentialPresence(): Record<ActivePartnerExchangeId, boolean> {
    return inspectPartnerCredentialPresence(this.envBag);
  }

  public async getStatus() {
    return listPartnerPollerStatus(this.db, this.envBag);
  }

  public async runCycle(options?: {
    triggerSource?: PollerTriggerSource;
    exchanges?: readonly ActivePartnerExchangeId[];
    overrides?: Partial<Record<ActivePartnerExchangeId, ExchangePollerOverride>>;
    forceShadow?: boolean;
    nowMs?: number;
    lookbackMs?: number;
  }): Promise<PartnerPollerCycleResult> {
    return runPartnerPollerCycle({
      db: this.db,
      r2: this.r2,
      env: this.envBag,
      triggerSource: options?.triggerSource ?? 'cron',
      exchanges: options?.exchanges,
      overrides: options?.overrides,
      forceShadow: options?.forceShadow,
      nowMs: options?.nowMs,
      lookbackMs: options?.lookbackMs,
      fetchImpl: this.fetchImpl,
    });
  }
}

