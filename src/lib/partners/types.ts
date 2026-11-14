import Decimal from 'decimal.js';

export type ActivePartnerExchangeId = 'bybit' | 'okx' | 'bitget';

export type PartnerExchangeId = ActivePartnerExchangeId | 'binance_referral_pro';

export type PartnerAdapterStatus = 'ACTIVE' | 'BLOCKED';

export interface PartnerAdapterCapabilities {
  readonly supportsRestPolling: boolean;
  readonly supportsCsvImport: boolean;
  readonly requiresUserTradeApiKey: false;
  readonly usesWebScraping: false;
}

export interface NormalizedPartnerCommissionRow {
  exchange: ActivePartnerExchangeId;
  traderUid: string;
  subAffiliateCode: string | null;
  commissionAsset: string;
  netCommissionDecimal: string;
  isClawbackOrAdjustment: boolean;
  signedUnits1e8: bigint;
  tradeVolumeDecimal: string;
  eventTimestampIso: string;
  externalRecordId: string;
}

export interface RawEvidenceMetadata {
  sourceKind: 'rest_poll' | 'csv_statement';
  payloadSha256: string;
  byteLength: number;
  capturedAtIso: string;
}

export interface PartnerIngestionBatchResult {
  exchange: ActivePartnerExchangeId;
  rows: NormalizedPartnerCommissionRow[];
  nextCursor: string | null;
  evidence: RawEvidenceMetadata;
}

export interface PartnerApiCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  baseUrl?: string;
  recvWindowMs?: number;
}

export interface PartnerPollRequest {
  credentials: PartnerApiCredentials;
  startTimeMs?: number;
  endTimeMs?: number;
  cursor?: string;
  limit?: number;
  endpointPath?: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PartnerParseOptions {
  periodEndIso?: string;
  capturedAtIso?: string;
}

export interface PartnerIngestionAdapter {
  readonly exchange: PartnerExchangeId;
  readonly status: PartnerAdapterStatus;
  readonly capabilities: PartnerAdapterCapabilities;
  pollCommissions(request: PartnerPollRequest): Promise<PartnerIngestionBatchResult>;
  parsePayload(rawPayload: string, options?: PartnerParseOptions): Promise<PartnerIngestionBatchResult>;
}

export class PartnerIntegrationBlockedError extends Error {
  public readonly code = 'BINANCE_REFERRAL_PRO_UID_UNAVAILABLE' as const;
  public readonly exchange = 'binance_referral_pro' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PartnerIntegrationBlockedError';
  }
}

export class ForbiddenPartnerEndpointError extends Error {
  public readonly code = 'FORBIDDEN_PERSONAL_TRADE_ENDPOINT' as const;
  public readonly exchange: PartnerExchangeId;
  public readonly endpoint: string;

  constructor(exchange: PartnerExchangeId, endpoint: string, message: string) {
    super(message);
    this.name = 'ForbiddenPartnerEndpointError';
    this.exchange = exchange;
    this.endpoint = endpoint;
  }
}

export class PartnerPayloadValidationError extends Error {
  public readonly code = 'INVALID_PARTNER_PAYLOAD' as const;
  public readonly exchange: PartnerExchangeId;

  constructor(exchange: PartnerExchangeId, message: string) {
    super(message);
    this.name = 'PartnerPayloadValidationError';
    this.exchange = exchange;
  }
}

export class PartnerUpstreamApiError extends Error {
  public readonly code = 'PARTNER_UPSTREAM_API_ERROR' as const;
  public readonly exchange: PartnerExchangeId;
  public readonly upstreamCode: string;

  constructor(exchange: PartnerExchangeId, upstreamCode: string, message: string) {
    super(message);
    this.name = 'PartnerUpstreamApiError';
    this.exchange = exchange;
    this.upstreamCode = upstreamCode;
  }
}

export const PartnerDecimal = Decimal.clone({
  precision: 36,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -36,
  toExpPos: 36,
});

const UNITS_1E8 = new PartnerDecimal('100000000');

export function normalizeCommissionDecimal(
  exchange: PartnerExchangeId,
  rawAmount: unknown,
  fieldName: string
): {
  decimalString: string;
  signedUnits1e8: bigint;
  isClawbackOrAdjustment: boolean;
} {
  if (rawAmount === null || rawAmount === undefined || String(rawAmount).trim() === '') {
    throw new PartnerPayloadValidationError(exchange, `Missing required decimal field: ${fieldName}`);
  }

  const rawText = String(rawAmount).trim();
  let parsed: InstanceType<typeof PartnerDecimal>;
  try {
    parsed = new PartnerDecimal(rawText);
  } catch {
    throw new PartnerPayloadValidationError(
      exchange,
      `Invalid decimal value '${rawText}' for field ${fieldName}`
    );
  }

  if (!parsed.isFinite() || parsed.isNaN()) {
    throw new PartnerPayloadValidationError(
      exchange,
      `Non-finite decimal value '${rawText}' for field ${fieldName}`
    );
  }

  const scaledIntStr = parsed
    .mul(UNITS_1E8)
    .toDecimalPlaces(0, PartnerDecimal.ROUND_HALF_EVEN)
    .toFixed(0);
  const signedUnits1e8 = BigInt(scaledIntStr);
  const isClawbackOrAdjustment = parsed.lte(0);

  return {
    decimalString: parsed.toFixed(),
    signedUnits1e8,
    isClawbackOrAdjustment,
  };
}

export function normalizeVolumeDecimal(
  exchange: PartnerExchangeId,
  rawVolume: unknown
): string {
  if (rawVolume === null || rawVolume === undefined || String(rawVolume).trim() === '') {
    return '0';
  }
  const rawText = String(rawVolume).trim();
  let parsed: InstanceType<typeof PartnerDecimal>;
  try {
    parsed = new PartnerDecimal(rawText);
  } catch {
    throw new PartnerPayloadValidationError(
      exchange,
      `Invalid trade volume decimal '${rawText}'`
    );
  }
  if (!parsed.isFinite() || parsed.isNaN() || parsed.isNegative()) {
    throw new PartnerPayloadValidationError(
      exchange,
      `Invalid negative or non-finite trade volume '${rawText}'`
    );
  }
  return parsed.toFixed();
}

export function normalizeTimestampToIso(
  exchange: PartnerExchangeId,
  rawTimestamp: unknown,
  fallbackIso?: string
): string {
  const candidate =
    rawTimestamp !== null && rawTimestamp !== undefined && String(rawTimestamp).trim() !== ''
      ? rawTimestamp
      : fallbackIso;

  if (candidate === undefined || candidate === null || String(candidate).trim() === '') {
    throw new PartnerPayloadValidationError(exchange, 'Missing event timestamp');
  }

  const text = String(candidate).trim();
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    const ms = text.length <= 10 ? num * 1000 : num;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) {
      throw new PartnerPayloadValidationError(exchange, `Invalid numeric timestamp '${text}'`);
    }
    return date.toISOString();
  }

  const parsedMs = Date.parse(text);
  if (Number.isNaN(parsedMs)) {
    throw new PartnerPayloadValidationError(exchange, `Invalid ISO timestamp '${text}'`);
  }
  return new Date(parsedMs).toISOString();
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SubtleCrypto is unavailable in current runtime');
  }
  return subtle;
}

export async function computePayloadEvidence(
  rawPayload: string,
  sourceKind: 'rest_poll' | 'csv_statement',
  capturedAtIso?: string
): Promise<RawEvidenceMetadata> {
  const encoded = new TextEncoder().encode(rawPayload);
  const digest = await getSubtleCrypto().digest('SHA-256', toExactArrayBuffer(encoded));
  const hashBytes = new Uint8Array(digest);
  let payloadSha256 = '';
  for (let i = 0; i < hashBytes.length; i += 1) {
    payloadSha256 += hashBytes[i].toString(16).padStart(2, '0');
  }
  return {
    sourceKind,
    payloadSha256,
    byteLength: encoded.byteLength,
    capturedAtIso: capturedAtIso ?? new Date().toISOString(),
  };
}

export async function signHmacSha256(
  secret: string,
  message: string,
  encoding: 'hex' | 'base64'
): Promise<string> {
  const subtle = getSubtleCrypto();
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(secret);
  const msgBytes = encoder.encode(message);

  const cryptoKey = await subtle.importKey(
    'raw',
    toExactArrayBuffer(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuffer = await subtle.sign('HMAC', cryptoKey, toExactArrayBuffer(msgBytes));
  const sigBytes = new Uint8Array(sigBuffer);

  if (encoding === 'hex') {
    let hex = '';
    for (let i = 0; i < sigBytes.length; i += 1) {
      hex += sigBytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(sigBytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < sigBytes.length; i += 1) {
    binary += String.fromCharCode(sigBytes[i]);
  }
  return btoa(binary);
}
