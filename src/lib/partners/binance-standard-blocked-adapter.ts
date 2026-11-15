import {
  PartnerAdapterCapabilities,
  PartnerIngestionAdapter,
  PartnerIngestionBatchResult,
  PartnerIntegrationBlockedError,
  PartnerParseOptions,
  PartnerPollRequest,
} from './types';

export const BINANCE_REFERRAL_PRO_BLOCK_REASON =
  'Binance Standard Referral Pro automated ingestion is hard-blocked: /sapi/v1/rebate/taxQuery (request weight 12000) omits customer trader UID, preventing deterministic per-trader attribution. Upgrade to an official Binance Link / Broker / CaaS institutional agreement (/sapi/v1/broker/*) before enabling automated ingestion.';

export class BinanceStandardBlockedAdapter implements PartnerIngestionAdapter {
  public readonly exchange = 'binance_referral_pro' as const;
  public readonly status = 'BLOCKED' as const;
  public readonly capabilities: PartnerAdapterCapabilities = Object.freeze({
    supportsRestPolling: false,
    supportsCsvImport: false,
    requiresUserTradeApiKey: false,
    usesWebScraping: false,
  });

  public async pollCommissions(_request: PartnerPollRequest): Promise<PartnerIngestionBatchResult> {
    throw new PartnerIntegrationBlockedError(BINANCE_REFERRAL_PRO_BLOCK_REASON);
  }

  public async parsePayload(
    _rawPayload: string,
    _options?: PartnerParseOptions
  ): Promise<PartnerIngestionBatchResult> {
    throw new PartnerIntegrationBlockedError(BINANCE_REFERRAL_PRO_BLOCK_REASON);
  }
}
