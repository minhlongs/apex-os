import { BinanceStandardBlockedAdapter } from './binance-standard-blocked-adapter';
import { BitgetBrokerAdapter } from './bitget-broker-adapter';
import { BybitAffiliateAdapter } from './bybit-affiliate-adapter';
import { GateioV4Adapter } from './gateio-v4-adapter';
import { KucoinUtaV2Adapter } from './kucoin-uta-v2-adapter';
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
const kucoinAdapter = new KucoinUtaV2Adapter();
const gateioAdapter = new GateioV4Adapter();
const binanceBlockedAdapter = new BinanceStandardBlockedAdapter();

const ADAPTER_REGISTRY: Readonly<Record<PartnerExchangeId, PartnerIngestionAdapter>> =
  Object.freeze({
    bybit: bybitAdapter,
    okx: okxAdapter,
    bitget: bitgetAdapter,
    kucoin: kucoinAdapter,
    gateio: gateioAdapter,
    binance_referral_pro: binanceBlockedAdapter,
  });

export const POLLABLE_PARTNER_EXCHANGES: readonly ActivePartnerExchangeId[] = Object.freeze([
  'bybit',
  'okx',
  'bitget',
  'kucoin',
  'gateio',
]);

export function getPartnerAdapter(exchange: string): PartnerIngestionAdapter {
  const normalized = exchange.trim().toLowerCase();
  if (normalized === 'binance' || normalized === 'binance_referral_pro') {
    return ADAPTER_REGISTRY.binance_referral_pro;
  }
  if (normalized === 'gate.io') {
    return ADAPTER_REGISTRY.gateio;
  }
  if (
    normalized === 'bybit' ||
    normalized === 'okx' ||
    normalized === 'bitget' ||
    normalized === 'kucoin' ||
    normalized === 'gateio'
  ) {
    return ADAPTER_REGISTRY[normalized];
  }
  throw new PartnerPayloadValidationError(
    'bybit',
    `Unsupported partner exchange identifier: '${exchange}'`
  );
}

/**
 * Lists Phase 1 core adapters (`ACTIVE` + `BLOCKED`) by default so Phase 1 Gate G1
 * contract assertions remain deterministic; pass `{ includeShadow: true }` to include
 * Phase 2 `SHADOW_ONLY` adapters (`kucoin`, `gateio`).
 */
export function listAllPartnerAdapters(options?: {
  includeShadow?: boolean;
}): readonly PartnerIngestionAdapter[] {
  const all = Object.values(ADAPTER_REGISTRY);
  if (options?.includeShadow) {
    return all;
  }
  return all.filter((adapter) => adapter.status !== 'SHADOW_ONLY');
}

export function listRegisteredPartnerAdapters(): readonly PartnerIngestionAdapter[] {
  return Object.values(ADAPTER_REGISTRY);
}

export function listActivePartnerAdapters(): readonly PartnerIngestionAdapter[] {
  return Object.values(ADAPTER_REGISTRY).filter((adapter) => adapter.status === 'ACTIVE');
}

export function listShadowPartnerAdapters(): readonly PartnerIngestionAdapter[] {
  return Object.values(ADAPTER_REGISTRY).filter((adapter) => adapter.status === 'SHADOW_ONLY');
}

export function listPollablePartnerAdapters(): readonly PartnerIngestionAdapter[] {
  return POLLABLE_PARTNER_EXCHANGES.map((exchange) => ADAPTER_REGISTRY[exchange]);
}

export function isActivePartnerExchange(exchange: string): exchange is ActivePartnerExchangeId {
  return (POLLABLE_PARTNER_EXCHANGES as readonly string[]).includes(exchange);
}
