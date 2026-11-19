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
  validatePartnerApiBaseUrl,
  validateUsdStablecoinCommissionAsset,
} from './types';

const DEFAULT_BITGET_BASE_URL = 'https://api.bitget.com';

export const ALLOWED_BITGET_BROKER_ENDPOINTS = [
  '/api/v2/broker/customer-commissions',
  '/api/v2/Mix/broker/account-sub-commissions',
  '/api/v2/agent/customer-commissions',
] as const;

interface BitgetRawCommissionItem {
  uid?: string | number;
  userId?: string | number;
  subUid?: string | number;
  subAffiliateCode?: string | null;
  channelCode?: string | null;
  coin?: string;
  tokenId?: string;
  commission?: string | number;
  netFee?: string | number;
  rebateAmount?: string | number;
  tradeVol?: string | number;
  dealSize?: string | number;
  volume?: string | number;
  tradeId?: string | number;
  id?: string | number;
  orderId?: string | number;
  cTime?: string | number;
  uTime?: string | number;
}

interface BitgetV2Envelope {
  code?: string;
  msg?: string;
  requestTime?: number;
  data?:
    | BitgetRawCommissionItem[]
    | {
        list?: BitgetRawCommissionItem[];
        endId?: string;
        nextCursor?: string;
      };
}

export function assertAllowedBitgetBrokerEndpoint(endpointPath: string): void {
  const normalizedPath = endpointPath.split('?')[0].trim();
  if (!(ALLOWED_BITGET_BROKER_ENDPOINTS as readonly string[]).includes(normalizedPath)) {
    throw new ForbiddenPartnerEndpointError(
      'bitget',
      normalizedPath,
      `Endpoint '${normalizedPath}' is forbidden. Only official read-only Bitget Broker/Agent v2 endpoints (${ALLOWED_BITGET_BROKER_ENDPOINTS.join(', ')}) are permitted; personal trade endpoints are prohibited.`
    );
  }
}

export async function buildBitgetPartnerSignedHeaders(params: {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  method: 'GET';
  endpointPath: string;
  queryString: string;
  timestampMs: number;
}): Promise<Record<string, string>> {
  const apiKey = params.apiKey.trim();
  const apiSecret = params.apiSecret.trim();
  const passphrase = params.passphrase.trim();
  if (!apiKey || !apiSecret || !passphrase) {
    throw new PartnerPayloadValidationError(
      'bitget',
      'Missing Bitget Partner credentials (apiKey, apiSecret, and passphrase are required)'
    );
  }

  const timestampStr = String(Math.trunc(params.timestampMs));
  const pathPart = params.queryString
    ? `${params.endpointPath}?${params.queryString}`
    : params.endpointPath;
  const prehash = `${timestampStr}${params.method}${pathPart}`;
  const signatureBase64 = await signHmacSha256(apiSecret, prehash, 'base64');

  return {
    'ACCESS-KEY': apiKey,
    'ACCESS-SIGN': signatureBase64,
    'ACCESS-TIMESTAMP': timestampStr,
    'ACCESS-PASSPHRASE': passphrase,
    'Content-Type': 'application/json',
    locale: 'en-US',
  };
}

export class BitgetBrokerAdapter implements PartnerIngestionAdapter {
  public readonly exchange = 'bitget' as const;
  public readonly status = 'ACTIVE' as const;
  public readonly capabilities: PartnerAdapterCapabilities = Object.freeze({
    supportsRestPolling: true,
    supportsCsvImport: false,
    requiresUserTradeApiKey: false,
    usesWebScraping: false,
  });

  public async pollCommissions(request: PartnerPollRequest): Promise<PartnerIngestionBatchResult> {
    const endpointPath = request.endpointPath ?? '/api/v2/broker/customer-commissions';
    assertAllowedBitgetBrokerEndpoint(endpointPath);

    const searchParams = new URLSearchParams();
    if (request.startTimeMs !== undefined) {
      searchParams.set('startTime', String(Math.trunc(request.startTimeMs)));
    }
    if (request.endTimeMs !== undefined) {
      searchParams.set('endTime', String(Math.trunc(request.endTimeMs)));
    }
    if (request.limit !== undefined) {
      searchParams.set('limit', String(request.limit));
    }
    if (request.cursor) {
      searchParams.set('idLessThan', request.cursor);
    }

    const queryString = searchParams.toString();
    const nowMs = request.nowMs ?? Date.now();
    const headers = await buildBitgetPartnerSignedHeaders({
      apiKey: request.credentials.apiKey,
      apiSecret: request.credentials.apiSecret,
      passphrase: request.credentials.passphrase ?? '',
      method: 'GET',
      endpointPath,
      queryString,
      timestampMs: nowMs,
    });

    const baseUrl = validatePartnerApiBaseUrl(
      'bitget',
      request.credentials.baseUrl,
      DEFAULT_BITGET_BASE_URL
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
        'bitget',
        `HTTP_${response.status}`,
        `Bitget Broker v2 HTTP error ${response.status}`
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

    let parsed: BitgetV2Envelope;
    try {
      parsed = JSON.parse(rawPayload) as BitgetV2Envelope;
    } catch {
      throw new PartnerPayloadValidationError('bitget', 'Malformed JSON in Bitget v2 response');
    }

    if (typeof parsed !== 'object' || parsed === null || parsed.code !== '00000') {
      throw new PartnerUpstreamApiError(
        'bitget',
        String(parsed?.code ?? 'UNKNOWN'),
        parsed?.msg ?? 'Bitget Broker v2 returned non-00000 code'
      );
    }

    const fallbackIso =
      parsed.requestTime !== undefined
        ? normalizeTimestampToIso('bitget', parsed.requestTime)
        : options?.periodEndIso ?? evidence.capturedAtIso;

    let rawItems: BitgetRawCommissionItem[] = [];
    let nextCursor: string | null = null;

    if (Array.isArray(parsed.data)) {
      rawItems = parsed.data;
    } else if (parsed.data && typeof parsed.data === 'object') {
      rawItems = Array.isArray(parsed.data.list) ? parsed.data.list : [];
      const cursorCandidate = parsed.data.endId ?? parsed.data.nextCursor;
      if (typeof cursorCandidate === 'string' && cursorCandidate.trim().length > 0) {
        nextCursor = cursorCandidate.trim();
      }
    }

    const rows: NormalizedPartnerCommissionRow[] = rawItems.map((item, idx) => {
      const rawUid = item.uid ?? item.userId ?? item.subUid;
      const traderUid = rawUid !== undefined && rawUid !== null ? String(rawUid).trim() : '';
      if (!traderUid) {
        throw new PartnerPayloadValidationError('bitget', `Bitget data.list[${idx}] missing uid`);
      }

      const rawCommission = item.commission ?? item.netFee ?? item.rebateAmount;
      const commissionNorm = normalizeCommissionDecimal('bitget', rawCommission, 'commission');

      const tradeVolumeDecimal = normalizeVolumeDecimal(
        'bitget',
        item.tradeVol ?? item.volume ?? item.dealSize ?? '0'
      );

      const commissionAsset = validateUsdStablecoinCommissionAsset(
        'bitget',
        item.coin ?? item.tokenId,
        `Bitget data.list[${idx}]`
      );

      const eventTimestampIso = normalizeTimestampToIso(
        'bitget',
        item.cTime ?? item.uTime,
        fallbackIso
      );

      const rawSub = item.subAffiliateCode ?? item.channelCode;
      const subAffiliateCode =
        typeof rawSub === 'string' && rawSub.trim().length > 0 ? rawSub.trim() : null;

      const rawId = item.tradeId ?? item.id ?? item.orderId;
      const externalRecordId =
        rawId !== undefined && rawId !== null && String(rawId).trim() !== ''
          ? `bitget:${String(rawId).trim()}`
          : `bitget:${traderUid}:${commissionAsset}:${eventTimestampIso}`;

      return {
        exchange: 'bitget',
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

    return {
      exchange: 'bitget',
      rows,
      nextCursor,
      evidence,
      rawPayload,
    };
  }
}
