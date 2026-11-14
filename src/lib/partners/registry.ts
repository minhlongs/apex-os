import { BinanceStandardBlockedAdapter } from './binance-standard-blocked-adapter';
import { BitgetBrokerAdapter } from './bitget-broker-adapter';
import { BybitAffiliateAdapter } from './bybit-affiliate-adapter';
import { OkxAffiliateAdapter } from './okx-affiliate-adapter';
import {
  ActivePartnerExchangeId,
  PartnerExchangeId,
  PartnerIngestionAdapter,
  PartnerPayloadValidationError,
} from './types';

const bybitAdapter = new BybitAffiliateAdapter();
const okxAdapter = new OkxAffiliateAdapter();
const bitgetAdapter = new BitgetBrokerAdapter();
const binanceBlockedAdapter = new BinanceStandardBlockedAdapter();

const ADAPTER_REGISTRY: Readonly<Record<PartnerExchangeId, PartnerIngestionAdapter>> =
  Object.freeze({
    bybit: bybitAdapter,
    okx: okxAdapter,
    bitget: bitgetAdapter,
    binance_referral_pro: binanceBlockedAdapter,
  });

export function getPartnerAdapter(exchange: string): PartnerIngestionAdapter {
  const normalized = exchange.trim().toLowerCase();
  if (normalized === 'binance' || normalized === 'binance_referral_pro') {
    return ADAPTER_REGISTRY.binance_referral_pro;
  }
  if (normalized === 'bybit' || normalized === 'okx' || normalized === 'bitget') {
    return ADAPTER_REGISTRY[normalized];
  }
  throw new PartnerPayloadValidationError(
    'bybit',
    `Unsupported partner exchange identifier: '${exchange}'`
  );
}

export function listAllPartnerAdapters(): readonly PartnerIngestionAdapter[] {
  return Object.values(ADAPTER_REGISTRY);
}

export function listActivePartnerAdapters(): readonly PartnerIngestionAdapter[] {
  return Object.values(ADAPTER_REGISTRY).filter((adapter) => adapter.status === 'ACTIVE');
}

export function isActivePartnerExchange(exchange: string): exchange is ActivePartnerExchangeId {
  return exchange === 'bybit' || exchange === 'okx' || exchange === 'bitget';
}
