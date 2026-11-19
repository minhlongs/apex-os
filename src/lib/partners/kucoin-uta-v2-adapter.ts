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

const DEFAULT_KUCOIN_BASE_URL = 'https://api.kucoin.com';
const DEFAULT_KUCOIN_KEY_VERSION = '2';

export const ALLOWED_KUCOIN_PARTNER_ENDPOINTS = [
  '/api/v2/affiliate/inviter/statistics',
  '/api/v3/broker/nd/rebase/download',
  '/api/v1/broker/nd/account',
] as const;

interface KucoinRawCommissionItem {
  uid?: string | number;
  userId?: string | number;
  subUid?: string | number;
  vipLevel?: string | number;
  level?: string | number;
  feeLevel?: string | number;
  userLevel?: string;
  tier?: string;
  isPrime?: boolean;
  isVipExcluded?: boolean;
  subAffiliateCode?: string | null;
  referralCode?: string | null;
  rcode?: string | null;
  currency?: string;
  coin?: string;
  rebateAsset?: string;
  rebate?: string | number;
  commission?: string | number;
  netCommission?: string | number;
  brokerRebate?: string | number;
  tradeVolume?: string | number;
  volume?: string | number;
  turnover?: string | number;
  tradeId?: string | number;
  recordId?: string | number;
  orderId?: string | number;
  id?: string | number;
  createdAt?: string | number;
  tradeTime?: string | number;
  date?: string | number;
  ts?: string | number;
}

/**
 * KuCoin Affiliate UTA v2 excludes LV4+ VIP, Prime, and Market-Maker institutional
 * accounts from partner rebate eligibility. Rows tagged LV4+ or Prime are filtered out
 * deterministically before commission ingestion.
 */
export function isKucoinLv4OrPrimeExcluded(item: KucoinRawCommissionItem): boolean {
  if (item.isVipExcluded === true || item.isPrime === true) {
    return true;
  }

  const rawCandidates = [item.vipLevel, item.level, item.feeLevel, item.userLevel, item.tier];
  for (const candidate of rawCandidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      if (candidate >= 4) return true;
      continue;
    }
    const str = String(candidate).trim();
    if (!str) continue;
    if (/^\d+$/.test(str) && Number(str) >= 4) {
      return true;
    }
    const levelMatch = /^(?:lv|vip)[\s_-]*(\d+)$/i.exec(str);
    if (levelMatch && Number(levelMatch[1]) >= 4) {
      return true;
    }
    if (/^(?:prime|market[\s_-]*maker|mm\b)/i.test(str)) {
      return true;
    }
  }

  return false;
}

interface KucoinV2Envelope {
  code?: string;
  msg?: string;
  data?:
    | KucoinRawCommissionItem[]
    | {
        items?: KucoinRawCommissionItem[];
        list?: KucoinRawCommissionItem[];
        dataList?: KucoinRawCommissionItem[];
        currentPage?: number;
        totalPage?: number;
        nextCursor?: string;
      };
}

export function assertAllowedKucoinPartnerEndpoint(endpointPath: string): void {
  const normalizedPath = endpointPath.split('?')[0].trim();
  if (!(ALLOWED_KUCOIN_PARTNER_ENDPOINTS as readonly string[]).includes(normalizedPath)) {
    throw new ForbiddenPartnerEndpointError(
      'kucoin',
      normalizedPath,
      `Endpoint '${normalizedPath}' is forbidden. Only official read-only KuCoin Partner/Broker UTA v2 endpoints (${ALLOWED_KUCOIN_PARTNER_ENDPOINTS.join(', ')}) are permitted; personal trade and withdrawal endpoints are prohibited.`
    );
  }
}

export async function buildKucoinPartnerSignedHeaders(params: {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  partnerId?: string;
  keyVersion?: string;
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
      'kucoin',
      'Missing KuCoin Partner credentials (apiKey, apiSecret, and passphrase are required)'
    );
  }

  const timestampStr = String(Math.trunc(params.timestampMs));
  const requestPathWithQuery = params.queryString
    ? `${params.endpointPath}?${params.queryString}`
    : params.endpointPath;
  const prehash = `${timestampStr}${params.method}${requestPathWithQuery}`;
  const signatureBase64 = await signHmacSha256(apiSecret, prehash, 'base64');
  const encryptedPassphraseBase64 = await signHmacSha256(apiSecret, passphrase, 'base64');
  const keyVersion = (params.keyVersion ?? DEFAULT_KUCOIN_KEY_VERSION).trim() || '2';

  const headers: Record<string, string> = {
    'KC-API-KEY': apiKey,
    'KC-API-SIGN': signatureBase64,
    'KC-API-TIMESTAMP': timestampStr,
    'KC-API-PASSPHRASE': encryptedPassphraseBase64,
    'KC-API-KEY-VERSION': keyVersion,
    Accept: 'application/json',
  };

  if (params.partnerId && params.partnerId.trim()) {
    const partnerId = params.partnerId.trim();
    const partnerPrehash = `${timestampStr}${partnerId}${apiKey}`;
    const partnerSignBase64 = await signHmacSha256(apiSecret, partnerPrehash, 'base64');
    headers['KC-API-PARTNER'] = partnerId;
    headers['KC-API-PARTNER-SIGN'] = partnerSignBase64;
    headers['KC-API-PARTNER-VERIFY'] = 'true';
  }

  return headers;
}

export class KucoinUtaV2Adapter implements PartnerIngestionAdapter {
  public readonly exchange = 'kucoin' as const;
  public readonly status = 'SHADOW_ONLY' as const;
  public readonly capabilities: PartnerAdapterCapabilities = Object.freeze({
    supportsRestPolling: true,
    supportsCsvImport: false,
    requiresUserTradeApiKey: false,
    usesWebScraping: false,
  });

  public async pollCommissions(request: PartnerPollRequest): Promise<PartnerIngestionBatchResult> {
    const endpointPath = request.endpointPath ?? '/api/v2/affiliate/inviter/statistics';
    assertAllowedKucoinPartnerEndpoint(endpointPath);

    const searchParams = new URLSearchParams();
    if (request.startTimeMs !== undefined) {
      searchParams.set('begin', String(Math.trunc(request.startTimeMs)));
    }
    if (request.endTimeMs !== undefined) {
      searchParams.set('end', String(Math.trunc(request.endTimeMs)));
    }
    if (request.limit !== undefined) {
      searchParams.set('pageSize', String(request.limit));
    }
    if (request.cursor) {
      searchParams.set('currentPage', request.cursor);
    }

    const queryString = searchParams.toString();
    const nowMs = request.nowMs ?? Date.now();
    const headers = await buildKucoinPartnerSignedHeaders({
      apiKey: request.credentials.apiKey,
      apiSecret: request.credentials.apiSecret,
      passphrase: request.credentials.passphrase ?? '',
      partnerId: request.credentials.partnerId,
      keyVersion: request.credentials.keyVersion,
      method: 'GET',
      endpointPath,
      queryString,
      timestampMs: nowMs,
    });

    const baseUrl = validatePartnerApiBaseUrl(
      'kucoin',
      request.credentials.baseUrl,
      DEFAULT_KUCOIN_BASE_URL
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
        'kucoin',
        `HTTP_${response.status}`,
        `KuCoin Partner UTA v2 HTTP error ${response.status}`
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

    let parsed: KucoinV2Envelope;
    try {
      parsed = JSON.parse(rawPayload) as KucoinV2Envelope;
    } catch {
      throw new PartnerPayloadValidationError('kucoin', 'Malformed JSON in KuCoin v2 response');
    }

    if (typeof parsed !== 'object' || parsed === null || parsed.code !== '200000') {
      throw new PartnerUpstreamApiError(
        'kucoin',
        String(parsed?.code ?? 'UNKNOWN'),
        parsed?.msg ?? 'KuCoin Partner UTA v2 returned non-200000 code'
      );
    }

    const fallbackIso = options?.periodEndIso ?? evidence.capturedAtIso;
    let rawItems: KucoinRawCommissionItem[] = [];
    let nextCursor: string | null = null;

    if (Array.isArray(parsed.data)) {
      rawItems = parsed.data;
    } else if (parsed.data && typeof parsed.data === 'object') {
      if (Array.isArray(parsed.data.items)) {
        rawItems = parsed.data.items;
      } else if (Array.isArray(parsed.data.list)) {
        rawItems = parsed.data.list;
      } else if (Array.isArray(parsed.data.dataList)) {
        rawItems = parsed.data.dataList;
      }

      if (typeof parsed.data.nextCursor === 'string' && parsed.data.nextCursor.trim()) {
        nextCursor = parsed.data.nextCursor.trim();
      } else if (
        typeof parsed.data.currentPage === 'number' &&
        typeof parsed.data.totalPage === 'number' &&
        parsed.data.currentPage < parsed.data.totalPage
      ) {
        nextCursor = String(parsed.data.currentPage + 1);
      }
    }

    const eligibleItems = rawItems.filter((item) => !isKucoinLv4OrPrimeExcluded(item));

    const rows: NormalizedPartnerCommissionRow[] = eligibleItems.map((item, index) => {
      const rawUid = item.uid ?? item.userId ?? item.subUid;
      const traderUid = rawUid !== undefined && rawUid !== null ? String(rawUid).trim() : '';
      if (!traderUid) {
        throw new PartnerPayloadValidationError(
          'kucoin',
          `KuCoin item[${index}] missing uid/userId/subUid`
        );
      }

      const rawCommission =
        item.netCommission ?? item.rebate ?? item.brokerRebate ?? item.commission;
      const commissionNorm = normalizeCommissionDecimal(
        'kucoin',
        rawCommission,
        'rebate/commission'
      );

      const commissionAsset = validateUsdStablecoinCommissionAsset(
        'kucoin',
        item.currency ?? item.coin ?? item.rebateAsset,
        `KuCoin item[${index}]`
      );

      const tradeVolumeDecimal = normalizeVolumeDecimal(
        'kucoin',
        item.tradeVolume ?? item.volume ?? item.turnover
      );

      const eventTimestampIso = normalizeTimestampToIso(
        'kucoin',
        item.tradeTime ?? item.createdAt ?? item.ts ?? item.date,
        fallbackIso
      );

      const rawSubCode = item.subAffiliateCode ?? item.referralCode ?? item.rcode;
      const subAffiliateCode =
        typeof rawSubCode === 'string' && rawSubCode.trim().length > 0 ? rawSubCode.trim() : null;

      const rawId = item.recordId ?? item.tradeId ?? item.orderId ?? item.id;
      const externalRecordId =
        rawId !== undefined && rawId !== null && String(rawId).trim() !== ''
          ? `kucoin:${String(rawId).trim()}`
          : `kucoin:${traderUid}:${commissionAsset}:${eventTimestampIso}`;

      return {
        exchange: 'kucoin',
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
      exchange: 'kucoin',
      rows,
      nextCursor,
      evidence,
      rawPayload,
    };
  }
}

export { KucoinUtaV2Adapter as KucoinBrokerAdapter };

