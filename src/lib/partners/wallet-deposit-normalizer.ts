/**
 * Source-Verified Fail-Closed Partner Wallet Deposit Normalizer
 *
 * Enforces strict deposit eligibility before any wallet row can back a
 * `CASH_COLLECTED` reconciliation across the 5 approved partner exchanges:
 *   1. Non-empty unique deposit identifier.
 *   2. Explicit USD-stablecoin asset (`USDC`, `USDT`, `USD`) — rows with an
 *      absent, blank, or non-USD asset (including OKX `ccy`) are rejected.
 *   3. Strictly positive USD decimal amount (`> 0` in `10^-8` ledger units).
 *   4. Exchange-specific terminal credited status (absent, pending, reviewing,
 *      processing, cancelled, or failed deposits are never credited):
 *        - Bybit v5 on-chain / sub-member (`/v5/asset/deposit/query-record`,
 *          `/v5/asset/deposit/query-sub-uid-record`,
 *          `/v5/asset/deposit/query-sub-member-record`, and default): `status === '3'`
 *          (`0` unknown, `1` toBeConfirmed, `2` processing, `3` success, `4` failed,
 *          `10011` pending credit, `10012` credited to funding pool pending audit).
 *        - Bybit v5 internal transfer deposit (`/v5/asset/deposit/query-internal-record`):
 *          `status === '2'` (`1` processing, `2` success, `3` deposit failed).
 *        - OKX v5 (`/api/v5/asset/deposit-history`,
 *          `/api/v5/broker/nd/subaccount-deposit-history`): `state === '2'`
 *          (`0` waiting, `1` deposit credited/unwithdrawable, `2` deposit successful).
 *        - Bitget v2 (`/api/v2/spot/wallet/deposit-records`,
 *          `/api/v2/spot/wallet/subaccount-deposit-records`,
 *          `/api/v2/spot/account/deposit-records`): `status` case-insensitive `'success'`.
 *        - KuCoin (`/api/v1/deposits`, `/api/v1/hist-deposits`): `status` case-insensitive `'SUCCESS'`.
 *        - Gate.io v4 (`/api/v4/wallet/deposits`): `status` case-insensitive `'DONE'`.
 */

import { BI_ZERO, parseUsdToLedgerUnits } from '@/lib/ledger';
import {
  ALLOWED_PARTNER_COMMISSION_ASSETS,
  type ActivePartnerExchangeId,
  type AllowedPartnerCommissionAsset,
} from './types';

export interface NormalizedWalletDeposit {
  depositId: string;
  asset: AllowedPartnerCommissionAsset;
  amountUsd: string;
  timestampMs: number | null;
}

export interface NormalizeWalletDepositOptions {
  exchange: ActivePartnerExchangeId;
  depositEndpointPath?: string;
}

const DEPOSIT_ID_FIELDS = [
  'txId',
  'txID',
  'tx_id',
  'walletTxId',
  'wallet_tx_id',
  'depId',
  'dep_id',
  'depositId',
  'deposit_id',
  'transactionId',
  'transaction_id',
  'txHash',
  'tx_hash',
  'id',
] as const;

const DEPOSIT_AMOUNT_FIELDS = [
  'amountUsd',
  'amount_usd',
  'creditedUsd',
  'credited_usd',
  'credit',
  'amount',
  'amt',
  'size',
  'creditAmount',
] as const;

const DEPOSIT_TIMESTAMP_FIELDS = [
  'timestampMs',
  'timestamp',
  'ts',
  'successAt',
  'success_at',
  'cTime',
  'uTime',
  'depositTime',
  'deposit_time',
  'creditedAt',
  'credited_at',
  'createdAt',
  'created_at',
  'txTime',
  'tx_time',
  'settleTime',
  'settle_time',
  'time',
] as const;

const DEPOSIT_ASSET_FIELDS = [
  'currency',
  'coin',
  'ccy',
  'asset',
  'rebateAsset',
  'rebate_asset',
  'commissionAsset',
  'commission_asset',
] as const;

const BYBIT_INTERNAL_DEPOSIT_ENDPOINT = '/v5/asset/deposit/query-internal-record';

export function parseDepositTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds-precision exchange timestamps are promoted to milliseconds.
    return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return null;
      return numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
    }
    const normalized =
      !trimmed.includes('T') && trimmed.includes(' ')
        ? `${trimmed.replace(' ', 'T')}Z`
        : trimmed;
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function coercePositiveDepositUsdDecimal(value: unknown): string | null {
  let candidate: string | null = null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      candidate = trimmed;
    }
  } else if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    candidate = value.toFixed(8);
  }
  if (candidate === null) {
    return null;
  }
  try {
    const units = parseUsdToLedgerUnits(candidate);
    if (units <= BI_ZERO) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function normalizeEndpointPath(rawEndpointPath: string | undefined): string {
  if (!rawEndpointPath) return '';
  return rawEndpointPath.split('?', 1)[0]?.trim() ?? '';
}

function extractRawStatusToken(
  row: Record<string, unknown>,
  fields: readonly string[]
): string | null {
  for (const field of fields) {
    const candidate = row[field];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(Math.trunc(candidate));
    }
  }
  return null;
}

/**
 * Evaluates whether a raw exchange deposit record has reached its exchange-specific
 * terminal credited state. Missing, unrecognized, pending, or failed status codes
 * always return `false`.
 */
export function isTerminalCreditedDepositStatus(
  row: Record<string, unknown>,
  options: NormalizeWalletDepositOptions
): boolean {
  const endpointPath = normalizeEndpointPath(options.depositEndpointPath);
  switch (options.exchange) {
    case 'bybit': {
      const status = extractRawStatusToken(row, ['status']);
      if (status === null) return false;
      if (endpointPath === BYBIT_INTERNAL_DEPOSIT_ENDPOINT) {
        return status === '2';
      }
      return status === '3';
    }
    case 'okx': {
      const state = extractRawStatusToken(row, ['state']);
      return state === '2';
    }
    case 'bitget': {
      const status = extractRawStatusToken(row, ['status']);
      return status !== null && status.toLowerCase() === 'success';
    }
    case 'kucoin': {
      const status = extractRawStatusToken(row, ['status']);
      return status !== null && status.toUpperCase() === 'SUCCESS';
    }
    case 'gateio': {
      const status = extractRawStatusToken(row, ['status']);
      return status !== null && status.toUpperCase() === 'DONE';
    }
  }
}

function resolveValidatedDepositAsset(
  row: Record<string, unknown>
): AllowedPartnerCommissionAsset | null {
  for (const field of DEPOSIT_ASSET_FIELDS) {
    const candidate = row[field];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const normalized = candidate.trim().toUpperCase();
      if ((ALLOWED_PARTNER_COMMISSION_ASSETS as readonly string[]).includes(normalized)) {
        return normalized as AllowedPartnerCommissionAsset;
      }
      return null;
    }
  }
  return null;
}

/**
 * Normalizes raw wallet deposit records fail-closed: only rows with a non-empty ID,
 * an explicit USD-stablecoin asset (`USDC` / `USDT` / `USD`), a strictly positive
 * USD amount (`> 0`), and a source-verified terminal credited status for the target
 * exchange are returned.
 */
export function normalizeWalletDepositRows(
  rawDeposits: ReadonlyArray<Record<string, unknown>>,
  options: NormalizeWalletDepositOptions
): NormalizedWalletDeposit[] {
  const normalized: NormalizedWalletDeposit[] = [];
  const seenDepositIds = new Set<string>();

  for (const row of rawDeposits) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;

    let depositId: string | null = null;
    for (const field of DEPOSIT_ID_FIELDS) {
      const candidate = row[field];
      if (
        (typeof candidate === 'string' && candidate.trim().length > 0) ||
        (typeof candidate === 'number' && Number.isFinite(candidate))
      ) {
        depositId = String(candidate).trim();
        break;
      }
    }
    if (!depositId || seenDepositIds.has(depositId)) continue;

    const asset = resolveValidatedDepositAsset(row);
    if (asset === null) continue;

    if (!isTerminalCreditedDepositStatus(row, options)) continue;

    let amountUsd: string | null = null;
    for (const field of DEPOSIT_AMOUNT_FIELDS) {
      amountUsd = coercePositiveDepositUsdDecimal(row[field]);
      if (amountUsd !== null) break;
    }
    if (amountUsd === null) continue;

    let timestampMs: number | null = null;
    for (const field of DEPOSIT_TIMESTAMP_FIELDS) {
      timestampMs = parseDepositTimestampMs(row[field]);
      if (timestampMs !== null) break;
    }

    seenDepositIds.add(depositId);
    normalized.push({ depositId, asset, amountUsd, timestampMs });
  }

  return normalized;
}
