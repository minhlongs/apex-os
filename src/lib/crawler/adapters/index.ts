/**
 * Exchange Crawler Adapters Index
 * Module: ApexOS Multi-Exchange Crawler Engine
 */

import type { ExchangeName } from '@/types/arbitrage';
import type { ExchangeCrawlerAdapter } from '../types';
import { BinanceCrawlerAdapter } from './binance';
import { BybitCrawlerAdapter } from './bybit';
import { OKXCrawlerAdapter } from './okx';
import { KuCoinCrawlerAdapter } from './kucoin';

export * from './binance';
export * from './bybit';
export * from './okx';
export * from './kucoin';

/**
 * Creates default set of all supported crawler adapters
 */
export function createDefaultAdapters(): Map<ExchangeName, ExchangeCrawlerAdapter> {
  const map = new Map<ExchangeName, ExchangeCrawlerAdapter>();
  map.set('binance', new BinanceCrawlerAdapter());
  map.set('bybit', new BybitCrawlerAdapter());
  map.set('okx', new OKXCrawlerAdapter());
  map.set('kucoin', new KuCoinCrawlerAdapter());
  return map;
}
