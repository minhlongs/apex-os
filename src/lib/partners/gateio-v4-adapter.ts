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
  sha512Hex,
  signHmacSha512Hex,
  validatePartnerApiBaseUrl,
  validateUsdStablecoinCommissionAsset,
} from './types';

const DEFAULT_GATEIO_BASE_URL = 'https://api.gateio.ws';
const DEFAULT_GATEIO_PAGE_LIMIT = 100;

export const ALLOWED_GATEIO_PARTNER_ENDPOINTS = [
  '/api/v4/rebate/agency/commission_history',
  '/api/v4/rebate/agency/transaction_history',
  '/api/v4/rebate/partner/commission_history',
  '/api/v4/rebate/broker/commission_history',
] as const;

interface GateioRawCommissionItem {
  user_id?: string | number;
  uid?: string | number;
  sub_uid?: string | number;
  invite_code?: string | null;
  sub_affiliate_code?: string | null;
  channel_code?: string | null;
  currency?: string;
  commission_asset?: string;
  asset?: string;
  commission?: string | number;
  rebate?: string | number;
  net_commission?: string | number;
  amount?: string | number;
  fee?: string | number;
  vol?: string | number;
  trade_volume?: string | number;
  source?: string;
  id?: string | number;
  commission_id?: string | number;
  record_id?: string | number;
  order_id?: string | number;
  commission_time?: string | number;
  transaction_time?: string | number;
  create_time?: string | number;
}

interface GateioV4ObjectEnvelope {
  total?: number;
  list?: GateioRawCommissionItem[];
  data?: GateioRawCommissionItem[];
  next_cursor?: string;
  label?: string;
  message?: string;
}

export function assertAllowedGateioPartnerEndpoint(endpointPath: string): void {
  const normalizedPath = endpointPath.split('?')[0].trim();
  if (!(ALLOWED_GATEIO_PARTNER_ENDPOINTS as readonly string[]).includes(normalizedPath)) {
    throw new ForbiddenPartnerEndpointError(
      'gateio',
      normalizedPath,
      `Endpoint '${normalizedPath}' is forbidden. Only official read-only Gate.io Rebate/Partner v4 endpoints (${ALLOWED_GATEIO_PARTNER_ENDPOINTS.join(', ')}) are permitted; personal spot/futures trade and withdrawal endpoints are prohibited.`
    );
  }
}

export async function buildGateioPartnerSignedHeaders(params: {
  apiKey: string;
  apiSecret: string;
  method: 'GET';
  endpointPath: string;
  queryString: string;
  bodyPayload?: string;
  timestampSeconds: number;
}): Promise<Record<string, string>> {
  const apiKey = params.apiKey.trim();
  const apiSecret = params.apiSecret.trim();
  if (!apiKey || !apiSecret) {
    throw new PartnerPayloadValidationError(
      'gateio',
      'Missing Gate.io Partner v4 credentials (apiKey and apiSecret are required)'
    );
  }

  const timestampStr = String(Math.trunc(params.timestampSeconds));
  const hashedBodyHex = await sha512Hex(params.bodyPayload ?? '');
  const prehash = [
    params.method,
    params.endpointPath,
    params.queryString,
    hashedBodyHex,
    timestampStr,
  ].join('\n');

  const signatureHex = await signHmacSha512Hex(apiSecret, prehash);

  return {
    KEY: apiKey,
    Timestamp: timestampStr,
    SIGN: signatureHex,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

export class GateioV4Adapter implements PartnerIngestionAdapter {
  public readonly exchange = 'gateio' as const;
  public readonly status = 'SHADOW_ONLY' as const;
  public readonly capabilities: PartnerAdapterCapabilities = Object.freeze({
    supportsRestPolling: true,
    supportsCsvImport: false,
    requiresUserTradeApiKey: false,
    usesWebScraping: false,
  });

  public async pollCommissions(request: PartnerPollRequest): Promise<PartnerIngestionBatchResult> {
    const endpointPath = request.endpointPath ?? '/api/v4/rebate/agency/commission_history';
    assertAllowedGateioPartnerEndpoint(endpointPath);

    const searchParams = new URLSearchParams();
    if (request.startTimeMs !== undefined) {
      searchParams.set('from', String(Math.floor(request.startTimeMs / 1000)));
    }
    if (request.endTimeMs !== undefined) {
      searchParams.set('to', String(Math.floor(request.endTimeMs / 1000)));
    }
    if (request.limit !== undefined) {
      searchParams.set('limit', String(request.limit));
    }
    if (request.cursor) {
      searchParams.set('offset', request.cursor);
    }

    const queryString = searchParams.toString();
    const nowMs = request.nowMs ?? Date.now();
    const timestampSeconds = Math.floor(nowMs / 1000);
    const headers = await buildGateioPartnerSignedHeaders({
      apiKey: request.credentials.apiKey,
      apiSecret: request.credentials.apiSecret,
      method: 'GET',
      endpointPath,
      queryString,
      bodyPayload: '',
      timestampSeconds,
    });

    const baseUrl = validatePartnerApiBaseUrl(
      'gateio',
      request.credentials.baseUrl,
      DEFAULT_GATEIO_BASE_URL
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
        'gateio',
        `HTTP_${response.status}`,
        `Gate.io Partner v4 HTTP error ${response.status}`
      );
    }

    const rawBody = await response.text();
    const currentOffset =
      request.cursor !== undefined && /^\d+$/.test(request.cursor.trim())
        ? Number.parseInt(request.cursor.trim(), 10)
        : 0;
    return this.parsePayload(rawBody, {
      periodEndIso:
        request.endTimeMs !== undefined
          ? new Date(request.endTimeMs).toISOString()
          : new Date(nowMs).toISOString(),
      capturedAtIso: new Date(nowMs).toISOString(),
      limit: request.limit,
      offset: currentOffset,
    });
  }

  public async parsePayload(
    rawPayload: string,
    options?: PartnerParseOptions & { limit?: number; offset?: number }
  ): Promise<PartnerIngestionBatchResult> {
    const evidence = await computePayloadEvidence(
      rawPayload,
      'rest_poll',
      options?.capturedAtIso
    );

    let parsed: GateioRawCommissionItem[] | GateioV4ObjectEnvelope;
    try {
      parsed = JSON.parse(rawPayload) as GateioRawCommissionItem[] | GateioV4ObjectEnvelope;
    } catch {
      throw new PartnerPayloadValidationError('gateio', 'Malformed JSON in Gate.io v4 response');
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new PartnerPayloadValidationError('gateio', 'Invalid Gate.io v4 JSON root');
    }

    if (!Array.isArray(parsed) && typeof parsed.label === 'string' && parsed.label.trim() !== '') {
      throw new PartnerUpstreamApiError(
        'gateio',
        parsed.label.trim(),
        parsed.message ?? 'Gate.io Partner v4 returned upstream error label'
      );
    }

    const fallbackIso = options?.periodEndIso ?? evidence.capturedAtIso;
    const effectiveLimit =
      options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.trunc(options.limit)
        : DEFAULT_GATEIO_PAGE_LIMIT;
    const currentOffset =
      options?.offset !== undefined && Number.isFinite(options.offset) && options.offset >= 0
        ? Math.trunc(options.offset)
        : 0;
    let rawItems: GateioRawCommissionItem[] = [];
    let nextCursor: string | null = null;

    if (Array.isArray(parsed)) {
      rawItems = parsed;
      if (rawItems.length >= effectiveLimit) {
        nextCursor = String(currentOffset + rawItems.length);
      }
    } else {
      if (Array.isArray(parsed.list)) {
        rawItems = parsed.list;
      } else if (Array.isArray(parsed.data)) {
        rawItems = parsed.data;
      }
      if (typeof parsed.next_cursor === 'string' && parsed.next_cursor.trim()) {
        nextCursor = parsed.next_cursor.trim();
      }
    }

    const rows: NormalizedPartnerCommissionRow[] = rawItems.map((item, index) => {
      const rawUid = item.user_id ?? item.uid ?? item.sub_uid;
      const traderUid = rawUid !== undefined && rawUid !== null ? String(rawUid).trim() : '';
      if (!traderUid) {
        throw new PartnerPayloadValidationError(
          'gateio',
          `Gate.io item[${index}] missing user_id/uid`
        );
      }

      const rawCommission =
        item.net_commission ?? item.commission ?? item.rebate ?? item.amount;
      const commissionNorm = normalizeCommissionDecimal(
        'gateio',
        rawCommission,
        'commission'
      );

      const commissionAsset = validateUsdStablecoinCommissionAsset(
        'gateio',
        item.currency ?? item.commission_asset ?? item.asset,
        `Gate.io item[${index}]`
      );

      const tradeVolumeDecimal = normalizeVolumeDecimal(
        'gateio',
        item.vol ?? item.trade_volume
      );

      const eventTimestampIso = normalizeTimestampToIso(
        'gateio',
        item.commission_time ?? item.transaction_time ?? item.create_time,
        fallbackIso
      );

      const rawSubCode = item.sub_affiliate_code ?? item.invite_code ?? item.channel_code;
      const subAffiliateCode =
        typeof rawSubCode === 'string' && rawSubCode.trim().length > 0 ? rawSubCode.trim() : null;

      const rawId = item.commission_id ?? item.record_id ?? item.id ?? item.order_id;
      const externalRecordId =
        rawId !== undefined && rawId !== null && String(rawId).trim() !== ''
          ? `gateio:${String(rawId).trim()}`
          : `gateio:${traderUid}:${commissionAsset}:${eventTimestampIso}`;

      return {
        exchange: 'gateio',
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
      exchange: 'gateio',
      rows,
      nextCursor,
      evidence,
      rawPayload,
    };
  }
}

export { GateioV4Adapter as GateioPartnerAdapter };

