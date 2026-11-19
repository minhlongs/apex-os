import {
  computePayloadEvidence,
  ForbiddenPartnerEndpointError,
  normalizeCommissionDecimal,
  normalizeTimestampToIso,
  normalizeVolumeDecimal,
  PartnerAdapterCapabilities,
  PartnerIngestionAdapter,
  PartnerIngestionBatchResult,
  PartnerParseOptions,
  PartnerPayloadValidationError,
  PartnerPollRequest,
  PartnerUpstreamApiError,
  NormalizedPartnerCommissionRow,
  signHmacSha256,
  validatePartnerApiBaseUrl,
  validateUsdStablecoinCommissionAsset,
} from './types';

const DEFAULT_BYBIT_BASE_URL = 'https://api.bybit.com';
const DEFAULT_RECV_WINDOW_MS = 5000;

export const ALLOWED_BYBIT_AFFILIATE_ENDPOINTS = [
  '/v5/affiliate/aff-user-list',
  '/v5/affiliate/aff-customer-info',
] as const;

interface BybitRawAffiliateItem {
  userId?: string | number;
  uid?: string | number;
  subAffiliateCode?: string | null;
  refCode?: string | null;
  coin?: string;
  currency?: string;
  netCommission?: string | number;
  commissions?: string | number;
  commission?: string | number;
  takerVol365Day?: string | number;
  tradeVol?: string | number;
  makerVol365Day?: string | number;
  recordId?: string | number;
  id?: string | number;
  registerTime?: string | number;
  updateTime?: string | number;
  timestamp?: string | number;
}

interface BybitV5Envelope {
  retCode?: number;
  retMsg?: string;
  time?: number;
  result?: {
    list?: BybitRawAffiliateItem[];
    nextPageCursor?: string;
    uid?: string | number;
    userId?: string | number;
    takerVol365Day?: string | number;
    tradeVol?: string | number;
    commissions?: string | number;
    netCommission?: string | number;
    coin?: string;
  };
}

export function assertAllowedBybitAffiliateEndpoint(endpointPath: string): void {
  const normalizedPath = endpointPath.split('?')[0].trim();
  if (
    normalizedPath.includes('/v5/execution') ||
    normalizedPath.includes('/v5/order') ||
    normalizedPath.includes('/v5/position') ||
    !(ALLOWED_BYBIT_AFFILIATE_ENDPOINTS as readonly string[]).includes(normalizedPath)
  ) {
    throw new ForbiddenPartnerEndpointError(
      'bybit',
      normalizedPath,
      `Endpoint '${normalizedPath}' is forbidden. Only official read-only Bybit Partner Affiliate v5 endpoints (${ALLOWED_BYBIT_AFFILIATE_ENDPOINTS.join(', ')}) are permitted; personal trade endpoints such as /v5/execution/list are strictly prohibited.`
    );
  }
}

export async function buildBybitAffiliateSignedHeaders(params: {
  apiKey: string;
  apiSecret: string;
  queryString: string;
  timestampMs: number;
  recvWindowMs?: number;
}): Promise<Record<string, string>> {
  const apiKey = params.apiKey.trim();
  const apiSecret = params.apiSecret.trim();
  if (!apiKey || !apiSecret) {
    throw new PartnerPayloadValidationError('bybit', 'Missing Bybit Partner API credentials');
  }

  const timestampStr = String(Math.trunc(params.timestampMs));
  const recvWindowStr = String(params.recvWindowMs ?? DEFAULT_RECV_WINDOW_MS);
  const prehash = `${timestampStr}${apiKey}${recvWindowStr}${params.queryString}`;
  const signature = await signHmacSha256(apiSecret, prehash, 'hex');

  return {
    'X-BAPI-API-KEY': apiKey,
    'X-BAPI-SIGN': signature,
    'X-BAPI-SIGN-TYPE': '2',
    'X-BAPI-TIMESTAMP': timestampStr,
    'X-BAPI-RECV-WINDOW': recvWindowStr,
    Accept: 'application/json',
  };
}

export class BybitAffiliateAdapter implements PartnerIngestionAdapter {
  public readonly exchange = 'bybit' as const;
  public readonly status = 'ACTIVE' as const;
  public readonly capabilities: PartnerAdapterCapabilities = Object.freeze({
    supportsRestPolling: true,
    supportsCsvImport: false,
    requiresUserTradeApiKey: false,
    usesWebScraping: false,
  });

  public async pollCommissions(request: PartnerPollRequest): Promise<PartnerIngestionBatchResult> {
    const endpointPath = request.endpointPath ?? '/v5/affiliate/aff-user-list';
    assertAllowedBybitAffiliateEndpoint(endpointPath);

    const searchParams = new URLSearchParams();
    if (request.limit !== undefined) {
      searchParams.set('size', String(request.limit));
    } else {
      searchParams.set('size', '100');
    }
    if (request.cursor) {
      searchParams.set('cursor', request.cursor);
    }
    if (request.startTimeMs !== undefined) {
      searchParams.set('startDate', new Date(request.startTimeMs).toISOString().slice(0, 10));
    }
    if (request.endTimeMs !== undefined) {
      searchParams.set('endDate', new Date(request.endTimeMs).toISOString().slice(0, 10));
    }

    const queryString = searchParams.toString();
    const nowMs = request.nowMs ?? Date.now();
    const headers = await buildBybitAffiliateSignedHeaders({
      apiKey: request.credentials.apiKey,
      apiSecret: request.credentials.apiSecret,
      queryString,
      timestampMs: nowMs,
      recvWindowMs: request.credentials.recvWindowMs,
    });

    const baseUrl = validatePartnerApiBaseUrl(
      'bybit',
      request.credentials.baseUrl,
      DEFAULT_BYBIT_BASE_URL
    );
    const requestUrl = queryString
      ? `${baseUrl}${endpointPath}?${queryString}`
      : `${baseUrl}${endpointPath}`;

    const fetchFn = request.fetchImpl ?? globalThis.fetch;
    const response = await fetchFn(requestUrl, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new PartnerUpstreamApiError(
        'bybit',
        `HTTP_${response.status}`,
        `Bybit Affiliate v5 HTTP error ${response.status}`
      );
    }

    const rawBody = await response.text();
    return this.parsePayload(rawBody, {
      periodEndIso:
        request.endTimeMs !== undefined
          ? new Date(request.endTimeMs).toISOString()
          : new Date(nowMs).toISOString(),
      capturedAtIso: new Date(nowMs).toISOString(),
    });
  }

  public async parsePayload(
    rawPayload: string,
    options?: PartnerParseOptions
  ): Promise<PartnerIngestionBatchResult> {
    const evidence = await computePayloadEvidence(
      rawPayload,
      'rest_poll',
      options?.capturedAtIso
    );

    let parsed: BybitV5Envelope;
    try {
      parsed = JSON.parse(rawPayload) as BybitV5Envelope;
    } catch {
      throw new PartnerPayloadValidationError('bybit', 'Malformed JSON in Bybit v5 response');
    }

    if (typeof parsed !== 'object' || parsed === null || parsed.retCode !== 0) {
      throw new PartnerUpstreamApiError(
        'bybit',
        String(parsed?.retCode ?? 'UNKNOWN'),
        parsed?.retMsg ?? 'Bybit Affiliate v5 returned non-zero retCode'
      );
    }

    const envelopeFallbackIso =
      parsed.time !== undefined
        ? normalizeTimestampToIso('bybit', parsed.time)
        : options?.periodEndIso ?? evidence.capturedAtIso;

    const rawItems: BybitRawAffiliateItem[] = Array.isArray(parsed.result?.list)
      ? parsed.result.list
      : parsed.result && (parsed.result.userId !== undefined || parsed.result.uid !== undefined)
        ? [parsed.result]
        : [];

    const rows: NormalizedPartnerCommissionRow[] = rawItems.map((item, idx) => {
      const rawUid = item.userId ?? item.uid;
      const traderUid = rawUid !== undefined && rawUid !== null ? String(rawUid).trim() : '';
      if (!traderUid) {
        throw new PartnerPayloadValidationError(
          'bybit',
          `Bybit result.list[${idx}] missing customer userId`
        );
      }

      const rawCommission = item.netCommission ?? item.commissions ?? item.commission;
      const commissionNorm = normalizeCommissionDecimal('bybit', rawCommission, 'netCommission');

      const rawVolume = item.tradeVol ?? item.takerVol365Day ?? '0';
      const tradeVolumeDecimal = normalizeVolumeDecimal('bybit', rawVolume);

      const commissionAsset = validateUsdStablecoinCommissionAsset(
        'bybit',
        item.coin ?? item.currency,
        `Bybit result.list[${idx}]`
      );

      const eventTimestampIso = normalizeTimestampToIso(
        'bybit',
        item.timestamp ?? item.updateTime ?? item.registerTime,
        envelopeFallbackIso
      );

      const subAffiliateCode =
        typeof item.subAffiliateCode === 'string' && item.subAffiliateCode.trim()
          ? item.subAffiliateCode.trim()
          : typeof item.refCode === 'string' && item.refCode.trim()
            ? item.refCode.trim()
            : null;

      const rawRecordId = item.recordId ?? item.id;
      const externalRecordId =
        rawRecordId !== undefined && rawRecordId !== null && String(rawRecordId).trim() !== ''
          ? `bybit:${String(rawRecordId).trim()}`
          : `bybit:${traderUid}:${commissionAsset}:${eventTimestampIso}`;

      return {
        exchange: 'bybit',
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
    });

    const rawCursor = parsed.result?.nextPageCursor;
    const nextCursor =
      typeof rawCursor === 'string' && rawCursor.trim().length > 0 ? rawCursor.trim() : null;

    return {
      exchange: 'bybit',
      rows,
      nextCursor,
      evidence,
      rawPayload,
    };
  }
}
