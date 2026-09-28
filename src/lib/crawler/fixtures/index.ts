/**
 * Deterministic Fallback Fixtures Index
 * Module: ApexOS Exchange Rate Card Crawler
 */

import type { ExchangeName, MarketType, RateCard } from '@/types/arbitrage';
import {
  BINANCE_DEFAULT_CASHBACK_PCT,
  BINANCE_CORE_PAIRS,
  BINANCE_FALLBACK_RATE_CARDS,
  MOCK_BINANCE_SPOT_EXCHANGE_INFO,
  MOCK_BINANCE_FUTURES_EXCHANGE_INFO,
} from './binance';
import {
  BYBIT_DEFAULT_CASHBACK_PCT,
  BYBIT_CORE_PAIRS,
  BYBIT_FALLBACK_RATE_CARDS,
  MOCK_BYBIT_SPOT_INSTRUMENTS,
  MOCK_BYBIT_LINEAR_INSTRUMENTS,
} from './bybit';
import {
  OKX_DEFAULT_CASHBACK_PCT,
  OKX_CORE_PAIRS,
  OKX_FALLBACK_RATE_CARDS,
  MOCK_OKX_SPOT_INSTRUMENTS,
  MOCK_OKX_SWAP_INSTRUMENTS,
} from './okx';
import {
  KUCOIN_DEFAULT_CASHBACK_PCT,
  KUCOIN_CORE_PAIRS,
  KUCOIN_FALLBACK_RATE_CARDS,
  MOCK_KUCOIN_SPOT_SYMBOLS,
  MOCK_KUCOIN_CONTRACTS,
} from './kucoin';

export * from './binance';
export * from './bybit';
export * from './okx';
export * from './kucoin';

export const ALL_FALLBACK_RATE_CARDS: Record<ExchangeName, RateCard[]> = {
  binance: BINANCE_FALLBACK_RATE_CARDS,
  bybit: BYBIT_FALLBACK_RATE_CARDS,
  okx: OKX_FALLBACK_RATE_CARDS,
  kucoin: KUCOIN_FALLBACK_RATE_CARDS,
};

export const DEFAULT_CASHBACK_MAP: Record<ExchangeName, number> = {
  binance: BINANCE_DEFAULT_CASHBACK_PCT,
  bybit: BYBIT_DEFAULT_CASHBACK_PCT,
  okx: OKX_DEFAULT_CASHBACK_PCT,
  kucoin: KUCOIN_DEFAULT_CASHBACK_PCT,
};

/**
 * Get fallback fixtures filtered by exchange and optional market type
 */
export function getExchangeFallbackFixtures(
  exchange: ExchangeName,
  marketType?: MarketType
): RateCard[] {
  const cards = ALL_FALLBACK_RATE_CARDS[exchange] || [];
  if (!marketType) return cards;
  return cards.filter((c) => c.marketType === marketType);
}
