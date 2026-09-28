/**
 * Deterministic Edge Fallback Fixture for OKX
 * Covers Spot and SWAP Perpetual fee schedules across VIP tiers and key trading pairs
 */

import type { RateCard } from '@/types/arbitrage';

export const OKX_DEFAULT_CASHBACK_PCT = 30.0;

export const OKX_CORE_PAIRS = [
  'BTC/USDT',
  'ETH/USDT',
  'SOL/USDT',
  'BNB/USDT',
  'XRP/USDT',
  'DOGE/USDT',
];

export const OKX_FALLBACK_RATE_CARDS: RateCard[] = [
  // --- SPOT REGULAR (VIP0) ---
  {
    exchange: 'okx',
    marketType: 'spot',
    pair: 'BTC/USDT',
    rawSymbol: 'BTC-USDT',
    makerFee: 0.0008, // 8 bps
    takerFee: 0.0010, // 10 bps
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    promotionalDiscountPct: 20.0, // OKB deduction tier
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'BTC-USDT', instType: 'SPOT', okbDiscountAvailable: true },
  },
  {
    exchange: 'okx',
    marketType: 'spot',
    pair: 'ETH/USDT',
    rawSymbol: 'ETH-USDT',
    makerFee: 0.0008,
    takerFee: 0.0010,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    promotionalDiscountPct: 20.0,
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'ETH-USDT', instType: 'SPOT', okbDiscountAvailable: true },
  },
  {
    exchange: 'okx',
    marketType: 'spot',
    pair: 'SOL/USDT',
    rawSymbol: 'SOL-USDT',
    makerFee: 0.0008,
    takerFee: 0.0010,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    promotionalDiscountPct: 20.0,
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'SOL-USDT', instType: 'SPOT', okbDiscountAvailable: true },
  },
  {
    exchange: 'okx',
    marketType: 'spot',
    pair: 'BNB/USDT',
    rawSymbol: 'BNB-USDT',
    makerFee: 0.0008,
    takerFee: 0.0010,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    promotionalDiscountPct: 20.0,
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'BNB-USDT', instType: 'SPOT', okbDiscountAvailable: true },
  },
  {
    exchange: 'okx',
    marketType: 'spot',
    pair: 'XRP/USDT',
    rawSymbol: 'XRP-USDT',
    makerFee: 0.0008,
    takerFee: 0.0010,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    promotionalDiscountPct: 20.0,
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'XRP-USDT', instType: 'SPOT', okbDiscountAvailable: true },
  },
  {
    exchange: 'okx',
    marketType: 'spot',
    pair: 'DOGE/USDT',
    rawSymbol: 'DOGE-USDT',
    makerFee: 0.0008,
    takerFee: 0.0010,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    promotionalDiscountPct: 20.0,
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'DOGE-USDT', instType: 'SPOT', okbDiscountAvailable: true },
  },

  // --- SPOT VIP1 ---
  {
    exchange: 'okx',
    marketType: 'spot',
    pair: 'BTC/USDT',
    rawSymbol: 'BTC-USDT',
    makerFee: 0.0004,
    takerFee: 0.0005,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP1',
    volume30dUsd: 10000000,
    isActive: 1,
  },
  {
    exchange: 'okx',
    marketType: 'spot',
    pair: 'ETH/USDT',
    rawSymbol: 'ETH-USDT',
    makerFee: 0.0004,
    takerFee: 0.0005,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP1',
    volume30dUsd: 10000000,
    isActive: 1,
  },

  // --- SPOT VIP2 ---
  {
    exchange: 'okx',
    marketType: 'spot',
    pair: 'BTC/USDT',
    rawSymbol: 'BTC-USDT',
    makerFee: 0.0003,
    takerFee: 0.0004,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP2',
    volume30dUsd: 20000000,
    isActive: 1,
  },

  // --- FUTURES (SWAP) REGULAR (VIP0) ---
  {
    exchange: 'okx',
    marketType: 'futures',
    pair: 'BTC/USDT',
    rawSymbol: 'BTC-USDT-SWAP',
    makerFee: 0.0002, // 2 bps
    takerFee: 0.0005, // 5 bps
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'BTC-USDT-SWAP', instType: 'SWAP' },
  },
  {
    exchange: 'okx',
    marketType: 'futures',
    pair: 'ETH/USDT',
    rawSymbol: 'ETH-USDT-SWAP',
    makerFee: 0.0002,
    takerFee: 0.0005,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'ETH-USDT-SWAP', instType: 'SWAP' },
  },
  {
    exchange: 'okx',
    marketType: 'futures',
    pair: 'SOL/USDT',
    rawSymbol: 'SOL-USDT-SWAP',
    makerFee: 0.0002,
    takerFee: 0.0005,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'SOL-USDT-SWAP', instType: 'SWAP' },
  },
  {
    exchange: 'okx',
    marketType: 'futures',
    pair: 'BNB/USDT',
    rawSymbol: 'BNB-USDT-SWAP',
    makerFee: 0.0002,
    takerFee: 0.0005,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'BNB-USDT-SWAP', instType: 'SWAP' },
  },
  {
    exchange: 'okx',
    marketType: 'futures',
    pair: 'XRP/USDT',
    rawSymbol: 'XRP-USDT-SWAP',
    makerFee: 0.0002,
    takerFee: 0.0005,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'XRP-USDT-SWAP', instType: 'SWAP' },
  },
  {
    exchange: 'okx',
    marketType: 'futures',
    pair: 'DOGE/USDT',
    rawSymbol: 'DOGE-USDT-SWAP',
    makerFee: 0.0002,
    takerFee: 0.0005,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP0',
    volume30dUsd: 0,
    isActive: 1,
    metadata: { instId: 'DOGE-USDT-SWAP', instType: 'SWAP' },
  },

  // --- FUTURES (SWAP) VIP1 ---
  {
    exchange: 'okx',
    marketType: 'futures',
    pair: 'BTC/USDT',
    rawSymbol: 'BTC-USDT-SWAP',
    makerFee: 0.00015,
    takerFee: 0.00035,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP1',
    volume30dUsd: 10000000,
    isActive: 1,
  },
  {
    exchange: 'okx',
    marketType: 'futures',
    pair: 'ETH/USDT',
    rawSymbol: 'ETH-USDT-SWAP',
    makerFee: 0.00015,
    takerFee: 0.00035,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP1',
    volume30dUsd: 10000000,
    isActive: 1,
  },

  // --- FUTURES (SWAP) VIP2 ---
  {
    exchange: 'okx',
    marketType: 'futures',
    pair: 'BTC/USDT',
    rawSymbol: 'BTC-USDT-SWAP',
    makerFee: 0.00010,
    takerFee: 0.00030,
    defaultCashbackPct: OKX_DEFAULT_CASHBACK_PCT,
    vipTier: 'VIP2',
    volume30dUsd: 20000000,
    isActive: 1,
  },
];

/**
 * Mock API payloads simulating OKX v5 public instruments responses
 */
export const MOCK_OKX_SPOT_INSTRUMENTS = {
  code: '0',
  msg: '',
  data: [
    { instId: 'BTC-USDT', instType: 'SPOT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live' },
    { instId: 'ETH-USDT', instType: 'SPOT', baseCcy: 'ETH', quoteCcy: 'USDT', state: 'live' },
    { instId: 'SOL-USDT', instType: 'SPOT', baseCcy: 'SOL', quoteCcy: 'USDT', state: 'live' },
    { instId: 'BNB-USDT', instType: 'SPOT', baseCcy: 'BNB', quoteCcy: 'USDT', state: 'live' },
    { instId: 'XRP-USDT', instType: 'SPOT', baseCcy: 'XRP', quoteCcy: 'USDT', state: 'live' },
    { instId: 'DOGE-USDT', instType: 'SPOT', baseCcy: 'DOGE', quoteCcy: 'USDT', state: 'live' },
  ],
};

export const MOCK_OKX_SWAP_INSTRUMENTS = {
  code: '0',
  msg: '',
  data: [
    { instId: 'BTC-USDT-SWAP', instType: 'SWAP', uly: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live' },
    { instId: 'ETH-USDT-SWAP', instType: 'SWAP', uly: 'ETH-USDT', baseCcy: 'ETH', quoteCcy: 'USDT', state: 'live' },
    { instId: 'SOL-USDT-SWAP', instType: 'SWAP', uly: 'SOL-USDT', baseCcy: 'SOL', quoteCcy: 'USDT', state: 'live' },
    { instId: 'BNB-USDT-SWAP', instType: 'SWAP', uly: 'BNB-USDT', baseCcy: 'BNB', quoteCcy: 'USDT', state: 'live' },
    { instId: 'XRP-USDT-SWAP', instType: 'SWAP', uly: 'XRP-USDT', baseCcy: 'XRP', quoteCcy: 'USDT', state: 'live' },
    { instId: 'DOGE-USDT-SWAP', instType: 'SWAP', uly: 'DOGE-USDT', baseCcy: 'DOGE', quoteCcy: 'USDT', state: 'live' },
  ],
};
