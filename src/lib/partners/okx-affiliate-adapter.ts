import {
  computePayloadEvidence,
  ForbiddenPartnerEndpointError,
  normalizeCommissionDecimal,
  normalizeTimestampToIso,
  normalizeVolumeDecimal,
  NormalizedPartnerCommissionRow,
  PartnerAdapterCapabilities,
  PartnerIngestionAdapter,
  PartnerIngestionBatchResult,
  PartnerParseOptions,
  PartnerPayloadValidationError,
  PartnerPollRequest,
  PartnerUpstreamApiError,
  signHmacSha256,
} from './types';

const DEFAULT_OKX_BASE_URL = 'https://www.okx.com';

export const ALLOWED_OKX_PARTNER_ENDPOINTS = [
  '/api/v5/affiliate/invitee/detail',
  '/api/v5/broker/fd/rebate-per-orders',
] as const;

interface OkxRawRecord {
  uid?: string | number;
  subAcct?: string;
  inviterCode?: string | null;
  affiliateCode?: string | null;
  subAffiliateCode?: string | null;
  ccy?: string;
  feeCcy?: string;
  rebateCcy?: string;
  rebate?: string | number;
  netFee?: string | number;
  totalCommission?: string | number;
  commission?: string | number;
  vol?: string | number;
  tradeVol?: string | number;
  fillSz?: string | number;
  billId?: string | number;
  ordId?: string | number;
  tradeId?: string | number;
  id?: string | number;
  ts?: string | number;
  joinTime?: string | number;
  cTime?: string | number;
}

interface OkxV5Envelope {
  code?: string;
  msg?: string;
  data?: Array<
    OkxRawRecord & {
      details?: OkxRawRecord[];
      nextCursor?: string;
      page?: string;
      totalPage?: string;
    }
  >;
}

export function assertAllowedOkxPartnerEndpoint(endpointPath: string): void {
  const normalizedPath = endpointPath.split('?')[0].trim();
  if (!(ALLOWED_OKX_PARTNER_ENDPOINTS as readonly string[]).includes(normalizedPath)) {
    throw new ForbiddenPartnerEndpointError(
      'okx',
      normalizedPath,
      `Endpoint '${normalizedPath}' is forbidden. Only official read-only OKX Partner v5 endpoints (${ALLOWED_OKX_PARTNER_ENDPOINTS.join(', ')}) are permitted; personal trade endpoints are prohibited.`
    );
  }
}

export async function buildOkxPartnerSignedHeaders(params: {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  method: 'GET';
  requestPathWithQuery: string;
  timestampIso: string;
}): Promise<Record<string, string>> {
  const apiKey = params.apiKey.trim();
  const apiSecret = params.apiSecret.trim();
  const passphrase = params.passphrase.trim();
  if (!apiKey || !apiSecret || !passphrase) {
    throw new PartnerPayloadValidationError(
      'okx',
      'Missing OKX Partner credentials (apiKey, apiSecret, and passphrase are required)'
    );
  }

  const prehash = `${params.timestampIso}${params.method}${params.requestPathWithQuery}`;
  const signatureBase64 = await signHmacSha256(apiSecret, prehash, 'base64');

  return {
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': signatureBase64,
    'OK-ACCESS-TIMESTAMP': params.timestampIso,
    'OK-ACCESS-PASSPHRASE': passphrase,
    Accept: 'application/json',
  };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (inQuotes) {
    throw new PartnerPayloadValidationError('okx', 'Unterminated quoted field in OKX CSV statement');
  }

  fields.push(current.trim());
  return fields;
}

function findColumnIndex(headers: string[], candidates: readonly string[]): number {
  for (const candidate of candidates) {
    const target = candidate.toLowerCase();
    const idx = headers.findIndex((h) => h.toLowerCase() === target);
    if (idx !== -1) {
      return idx;
    }
  }
  return -1;
}

export async function parseOkxStatementCsv(
  rawCsv: string,
  options?: PartnerParseOptions
): Promise<PartnerIngestionBatchResult> {
  const evidence = await computePayloadEvidence(rawCsv, 'csv_statement', options?.capturedAtIso);

  const normalizedLines = rawCsv
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (normalizedLines.length === 0) {
    throw new PartnerPayloadValidationError('okx', 'OKX CSV statement is empty');
  }

  const rawHeaders = parseCsvLine(normalizedLines[0]);
  const uidIdx = findColumnIndex(rawHeaders, ['uid', 'subAcct', 'inviteeUid']);
  const rebateIdx = findColumnIndex(rawHeaders, ['rebate', 'netFee', 'commission', 'netCommission']);
  const ccyIdx = findColumnIndex(rawHeaders, ['ccy', 'rebateCcy', 'feeCcy', 'coin']);
  const tsIdx = findColumnIndex(rawHeaders, ['ts', 'cTime', 'timestamp', 'fillTime']);
  const idIdx = findColumnIndex(rawHeaders, ['billId', 'ordId', 'tradeId', 'id']);
  const volIdx = findColumnIndex(rawHeaders, ['vol', 'tradeVol', 'fillSz', 'volume']);
  const subCodeIdx = findColumnIndex(rawHeaders, [
    'subAffiliateCode',
    'affiliateCode',
    'inviterCode',
  ]);

  if (uidIdx === -1) {
    throw new PartnerPayloadValidationError(
      'okx',
      'OKX CSV header missing required trader identifier column (uid or subAcct)'
    );
  }
  if (rebateIdx === -1) {
    throw new PartnerPayloadValidationError(
      'okx',
      'OKX CSV header missing required commission column (rebate or netFee)'
    );
  }
  if (ccyIdx === -1) {
    throw new PartnerPayloadValidationError(
      'okx',
      'OKX CSV header missing required currency column (ccy)'
    );
  }
  if (tsIdx === -1 && idIdx === -1) {
    throw new PartnerPayloadValidationError(
      'okx',
      'OKX CSV header missing required timestamp or billId column (ts or billId)'
    );
  }

  const rows: NormalizedPartnerCommissionRow[] = [];

  for (let lineIdx = 1; lineIdx < normalizedLines.length; lineIdx += 1) {
    const cells = parseCsvLine(normalizedLines[lineIdx]);
    if (cells.length !== rawHeaders.length) {
      throw new PartnerPayloadValidationError(
        'okx',
        `OKX CSV row ${lineIdx} column count (${cells.length}) does not match header count (${rawHeaders.length})`
      );
    }

    const traderUid = (cells[uidIdx] ?? '').trim();
    if (!traderUid) {
      throw new PartnerPayloadValidationError(
        'okx',
        `OKX CSV row ${lineIdx} missing uid/subAcct value`
      );
    }

    const commissionAsset = (cells[ccyIdx] ?? '').trim().toUpperCase();
    if (!commissionAsset) {
      throw new PartnerPayloadValidationError('okx', `OKX CSV row ${lineIdx} missing ccy value`);
    }

    const commissionNorm = normalizeCommissionDecimal('okx', cells[rebateIdx], 'rebate');
    const tradeVolumeDecimal =
      volIdx !== -1 ? normalizeVolumeDecimal('okx', cells[volIdx]) : '0';

    const eventTimestampIso = normalizeTimestampToIso(
      'okx',
      tsIdx !== -1 ? cells[tsIdx] : undefined,
      options?.periodEndIso ?? evidence.capturedAtIso
    );

    const subAffiliateCode =
      subCodeIdx !== -1 && cells[subCodeIdx] && cells[subCodeIdx].trim().length > 0
        ? cells[subCodeIdx].trim()
        : null;

    const rawId = idIdx !== -1 ? (cells[idIdx] ?? '').trim() : '';
    const externalRecordId = rawId
      ? `okx:csv:${rawId}`
      : `okx:csv:${evidence.payloadSha256.slice(0, 16)}:row-${lineIdx}:${traderUid}`;

    rows.push({
      exchange: 'okx',
      traderUid,
      subAffiliateCode,
      commissionAsset,
      netCommissionDecimal: commissionNorm.decimalString,
      isClawbackOrAdjustment: commissionNorm.isClawbackOrAdjustment,
      signedUnits1e8: commissionNorm.signedUnits1e8,
      tradeVolumeDecimal,
      eventTimestampIso,
      externalRecordId,
    });
  }

  return {
    exchange: 'okx',
    rows,
    nextCursor: null,
    evidence,
  };
}

function normalizeOkxRecord(
  item: OkxRawRecord,
  fallbackIso: string,
  index: number
): NormalizedPartnerCommissionRow {
  const rawUid = item.uid ?? item.subAcct;
  const traderUid = rawUid !== undefined && rawUid !== null ? String(rawUid).trim() : '';
  if (!traderUid) {
    throw new PartnerPayloadValidationError('okx', `OKX data[${index}] missing uid/subAcct`);
  }

  const rawCommission =
    item.rebate ?? item.netFee ?? item.commission ?? item.totalCommission;
  const commissionNorm = normalizeCommissionDecimal('okx', rawCommission, 'rebate');

  const tradeVolumeDecimal = normalizeVolumeDecimal(
    'okx',
    item.tradeVol ?? item.vol ?? item.fillSz ?? '0'
  );

  const commissionAsset = String(item.ccy ?? item.rebateCcy ?? item.feeCcy ?? 'USDT')
    .trim()
    .toUpperCase();
  if (!commissionAsset) {
    throw new PartnerPayloadValidationError('okx', `OKX data[${index}] missing currency`);
  }

  const eventTimestampIso = normalizeTimestampToIso(
    'okx',
    item.ts ?? item.cTime ?? item.joinTime,
    fallbackIso
  );

  const rawSub = item.subAffiliateCode ?? item.affiliateCode ?? item.inviterCode;
  const subAffiliateCode =
    typeof rawSub === 'string' && rawSub.trim().length > 0 ? rawSub.trim() : null;

  const rawId = item.billId ?? item.ordId ?? item.tradeId ?? item.id;
  const externalRecordId =
    rawId !== undefined && rawId !== null && String(rawId).trim() !== ''
      ? `okx:${String(rawId).trim()}`
      : `okx:${traderUid}:${commissionAsset}:${eventTimestampIso}`;

  return {
    exchange: 'okx',
    traderUid,
    subAffiliateCode,
    commissionAsset,
    netCommissionDecimal: commissionNorm.decimalString,
    isClawbackOrAdjustment: commissionNorm.isClawbackOrAdjustment,
    signedUnits1e8: commissionNorm.signedUnits1e8,
    tradeVolumeDecimal,
    eventTimestampIso,
    externalRecordId,
  };
}

export class OkxAffiliateAdapter implements PartnerIngestionAdapter {
  public readonly exchange = 'okx' as const;
  public readonly status = 'ACTIVE' as const;
  public readonly capabilities: PartnerAdapterCapabilities = Object.freeze({
    supportsRestPolling: true,
    supportsCsvImport: true,
    requiresUserTradeApiKey: false,
    usesWebScraping: false,
  });

  public async pollCommissions(request: PartnerPollRequest): Promise<PartnerIngestionBatchResult> {
    const endpointPath = request.endpointPath ?? '/api/v5/affiliate/invitee/detail';
    assertAllowedOkxPartnerEndpoint(endpointPath);

    const searchParams = new URLSearchParams();
    if (request.startTimeMs !== undefined) {
      searchParams.set('begin', String(Math.trunc(request.startTimeMs)));
    }
    if (request.endTimeMs !== undefined) {
      searchParams.set('end', String(Math.trunc(request.endTimeMs)));
    }
    if (request.limit !== undefined) {
      searchParams.set('limit', String(request.limit));
    }
    if (request.cursor) {
      searchParams.set('page', request.cursor);
    }

    const queryString = searchParams.toString();
    const requestPathWithQuery = queryString
      ? `${endpointPath}?${queryString}`
      : endpointPath;

    const nowMs = request.nowMs ?? Date.now();
    const timestampIso = new Date(nowMs).toISOString();
    const headers = await buildOkxPartnerSignedHeaders({
      apiKey: request.credentials.apiKey,
      apiSecret: request.credentials.apiSecret,
      passphrase: request.credentials.passphrase ?? '',
      method: 'GET',
      requestPathWithQuery,
      timestampIso,
    });

    const baseUrl = (request.credentials.baseUrl ?? DEFAULT_OKX_BASE_URL).replace(/\/+$/, '');
    const fetchFn = request.fetchImpl ?? globalThis.fetch;
    const response = await fetchFn(`${baseUrl}${requestPathWithQuery}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new PartnerUpstreamApiError(
        'okx',
        `HTTP_${response.status}`,
        `OKX Partner v5 HTTP error ${response.status}`
      );
    }

    const rawBody = await response.text();
    return this.parsePayload(rawBody, {
      periodEndIso:
        request.endTimeMs !== undefined ? new Date(request.endTimeMs).toISOString() : timestampIso,
      capturedAtIso: timestampIso,
    });
  }

  public async parsePayload(
    rawPayload: string,
    options?: PartnerParseOptions
  ): Promise<PartnerIngestionBatchResult> {
    const trimmed = rawPayload.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return parseOkxStatementCsv(rawPayload, options);
    }

    const evidence = await computePayloadEvidence(rawPayload, 'rest_poll', options?.capturedAtIso);

    let parsed: OkxV5Envelope;
    try {
      parsed = JSON.parse(rawPayload) as OkxV5Envelope;
    } catch {
      throw new PartnerPayloadValidationError('okx', 'Malformed JSON in OKX v5 response');
    }

    if (typeof parsed !== 'object' || parsed === null || parsed.code !== '0') {
      throw new PartnerUpstreamApiError(
        'okx',
        String(parsed?.code ?? 'UNKNOWN'),
        parsed?.msg ?? 'OKX Partner v5 returned non-zero code'
      );
    }

    const fallbackIso = options?.periodEndIso ?? evidence.capturedAtIso;
    const dataArray = Array.isArray(parsed.data) ? parsed.data : [];
    const rows: NormalizedPartnerCommissionRow[] = [];
    let nextCursor: string | null = null;

    dataArray.forEach((entry, idx) => {
      if (typeof entry.nextCursor === 'string' && entry.nextCursor.trim()) {
        nextCursor = entry.nextCursor.trim();
      } else if (entry.page && entry.totalPage && Number(entry.page) < Number(entry.totalPage)) {
        nextCursor = String(Number(entry.page) + 1);
      }

      if (Array.isArray(entry.details)) {
        entry.details.forEach((detail, detailIdx) => {
          rows.push(normalizeOkxRecord(detail, fallbackIso, idx * 1000 + detailIdx));
        });
      } else {
        rows.push(normalizeOkxRecord(entry, fallbackIso, idx));
      }
    });

    return {
      exchange: 'okx',
      rows,
      nextCursor,
      evidence,
    };
  }
}
