/**
 * Unit & Resilience Tests for Exchange Crawler Adapters
 * Tests normalization, denormalization, fee structures, fallback triggers, and mock API parsing
 */

import {
  BinanceCrawlerAdapter,
  BybitCrawlerAdapter,
  OKXCrawlerAdapter,
  KuCoinCrawlerAdapter,
} from '../adapters';
import {
  MOCK_BINANCE_SPOT_EXCHANGE_INFO,
  MOCK_BINANCE_FUTURES_EXCHANGE_INFO,
  MOCK_BYBIT_SPOT_INSTRUMENTS,
  MOCK_BYBIT_LINEAR_INSTRUMENTS,
  MOCK_OKX_SPOT_INSTRUMENTS,
  MOCK_OKX_SWAP_INSTRUMENTS,
  MOCK_KUCOIN_SPOT_SYMBOLS,
  MOCK_KUCOIN_CONTRACTS,
} from '../fixtures';

describe('Exchange Crawler Adapters', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('BinanceCrawlerAdapter', () => {
    const adapter = new BinanceCrawlerAdapter();

    test('has correct metadata and supported markets', () => {
      expect(adapter.exchange).toBe('binance');
      expect(adapter.supportedMarkets).toEqual(['spot', 'futures']);
    });

    test('normalizes pairs correctly', () => {
      expect(adapter.normalizePair('BTCUSDT', 'spot')).toBe('BTC/USDT');
      expect(adapter.normalizePair('ETHUSDT', 'futures')).toBe('ETH/USDT');
      expect(adapter.normalizePair('SOLUSDC', 'spot')).toBe('SOL/USDC');
      expect(adapter.normalizePair('BNBFDUSD', 'spot')).toBe('BNB/FDUSD');
      expect(adapter.normalizePair('BTC/USDT', 'spot')).toBe('BTC/USDT');
    });

    test('denormalizes pairs correctly', () => {
      expect(adapter.denormalizePair('BTC/USDT', 'spot')).toBe('BTCUSDT');
      expect(adapter.denormalizePair('ETH/USDT', 'futures')).toBe('ETHUSDT');
    });

    test('returns deterministic fallback fixtures', () => {
      const allCards = adapter.getFallbackFixtures();
      expect(allCards.length).toBeGreaterThan(0);

      const spotCards = adapter.getFallbackFixtures('spot');
      expect(spotCards.every((c) => c.marketType === 'spot')).toBe(true);

      const btcSpotVip0 = spotCards.find(
        (c) => c.pair === 'BTC/USDT' && c.vipTier === 'VIP0'
      );
      expect(btcSpotVip0).toBeDefined();
      expect(btcSpotVip0?.makerFee).toBe(0.0010);
      expect(btcSpotVip0?.takerFee).toBe(0.0010);
      expect(btcSpotVip0?.defaultCashbackPct).toBe(20.0);
      expect(btcSpotVip0?.promotionalDiscountPct).toBe(25.0);

      const btcFuturesVip0 = adapter.getFallbackFixtures('futures').find(
        (c) => c.pair === 'BTC/USDT' && c.vipTier === 'VIP0'
      );
      expect(btcFuturesVip0).toBeDefined();
      expect(btcFuturesVip0?.makerFee).toBe(0.0002);
      expect(btcFuturesVip0?.takerFee).toBe(0.0005);
      expect(btcFuturesVip0?.defaultCashbackPct).toBe(20.0);
    });

    test('forceFallback option immediately returns fixtures without network request', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy;

      const result = await adapter.crawlRateCards({ forceFallback: true });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.exchange).toBe('binance');
      expect(result.fromFallback).toBe(true);
      expect(result.rateCards.length).toBeGreaterThan(0);
      expect(result.itemsCount).toBe(result.rateCards.length);
    });

    test('parses live API mock response for spot and futures', async () => {
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('fapi.binance.com')) {
          return Promise.resolve(new Response(JSON.stringify(MOCK_BINANCE_FUTURES_EXCHANGE_INFO)));
        }
        return Promise.resolve(new Response(JSON.stringify(MOCK_BINANCE_SPOT_EXCHANGE_INFO)));
      });

      const result = await adapter.crawlRateCards();
      expect(result.fromFallback).toBe(false);
      expect(result.rateCards.length).toBeGreaterThan(0);
      expect(result.rateCards.some((c) => c.pair === 'BTC/USDT')).toBe(true);
    });

    test('gracefully falls back when API returns 429 Too Many Requests', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' })
      );

      const result = await adapter.crawlRateCards();
      expect(result.fromFallback).toBe(true);
      expect(result.error).toContain('429');
      expect(result.rateCards.length).toBeGreaterThan(0);
    });

    test('gracefully falls back on network timeout / abort', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('The user aborted a request.'));

      const result = await adapter.crawlRateCards({ timeoutMs: 100 });
      expect(result.fromFallback).toBe(true);
      expect(result.error).toContain('aborted');
      expect(result.rateCards.length).toBeGreaterThan(0);
    });

    test('filters by specific pairs', async () => {
      const result = await adapter.crawlRateCards({
        forceFallback: true,
        pairs: ['BTC/USDT', 'ETH/USDT'],
      });
      expect(result.rateCards.every((c) => c.pair === 'BTC/USDT' || c.pair === 'ETH/USDT')).toBe(true);
    });
  });

  describe('BybitCrawlerAdapter', () => {
    const adapter = new BybitCrawlerAdapter();

    test('has correct metadata and supported markets', () => {
      expect(adapter.exchange).toBe('bybit');
      expect(adapter.supportedMarkets).toEqual(['spot', 'futures']);
    });

    test('normalizes and denormalizes pairs', () => {
      expect(adapter.normalizePair('BTCUSDT', 'spot')).toBe('BTC/USDT');
      expect(adapter.normalizePair('SOLUSDT', 'futures')).toBe('SOL/USDT');
      expect(adapter.denormalizePair('BTC/USDT', 'spot')).toBe('BTCUSDT');
    });

    test('returns deterministic fallback fixtures with 40% partner cashback', () => {
      const spotCards = adapter.getFallbackFixtures('spot');
      const btcSpot = spotCards.find((c) => c.pair === 'BTC/USDT' && c.vipTier === 'VIP0');
      expect(btcSpot).toBeDefined();
      expect(btcSpot?.makerFee).toBe(0.0010);
      expect(btcSpot?.takerFee).toBe(0.0010);
      expect(btcSpot?.defaultCashbackPct).toBe(40.0);

      const btcFutures = adapter.getFallbackFixtures('futures').find(
        (c) => c.pair === 'BTC/USDT' && c.vipTier === 'VIP0'
      );
      expect(btcFutures).toBeDefined();
      expect(btcFutures?.makerFee).toBe(0.0002);
      expect(btcFutures?.takerFee).toBe(0.00055);
      expect(btcFutures?.defaultCashbackPct).toBe(40.0);
    });

    test('parses Bybit v5 instruments API response', async () => {
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('linear')) {
          return Promise.resolve(new Response(JSON.stringify(MOCK_BYBIT_LINEAR_INSTRUMENTS)));
        }
        return Promise.resolve(new Response(JSON.stringify(MOCK_BYBIT_SPOT_INSTRUMENTS)));
      });

      const result = await adapter.crawlRateCards();
      expect(result.fromFallback).toBe(false);
      expect(result.rateCards.length).toBeGreaterThan(0);
      expect(result.rateCards.some((c) => c.pair === 'SOL/USDT')).toBe(true);
    });

    test('falls back on API 500 error', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' })
      );

      const result = await adapter.crawlRateCards();
      expect(result.fromFallback).toBe(true);
      expect(result.error).toContain('500');
    });
  });

  describe('OKXCrawlerAdapter', () => {
    const adapter = new OKXCrawlerAdapter();

    test('has correct metadata and supported markets', () => {
      expect(adapter.exchange).toBe('okx');
      expect(adapter.supportedMarkets).toEqual(['spot', 'futures']);
    });

    test('normalizes OKX symbols correctly', () => {
      expect(adapter.normalizePair('BTC-USDT', 'spot')).toBe('BTC/USDT');
      expect(adapter.normalizePair('BTC-USDT-SWAP', 'futures')).toBe('BTC/USDT');
      expect(adapter.normalizePair('ETH-USDT-SWAP', 'futures')).toBe('ETH/USDT');
    });

    test('denormalizes OKX symbols correctly', () => {
      expect(adapter.denormalizePair('BTC/USDT', 'spot')).toBe('BTC-USDT');
      expect(adapter.denormalizePair('BTC/USDT', 'futures')).toBe('BTC-USDT-SWAP');
    });

    test('returns deterministic fallback fixtures with 30% cashback and OKB discount rates', () => {
      const btcSpot = adapter.getFallbackFixtures('spot').find(
        (c) => c.pair === 'BTC/USDT' && c.vipTier === 'VIP0'
      );
      expect(btcSpot).toBeDefined();
      expect(btcSpot?.makerFee).toBe(0.0008);
      expect(btcSpot?.takerFee).toBe(0.0010);
      expect(btcSpot?.defaultCashbackPct).toBe(30.0);
      expect(btcSpot?.promotionalDiscountPct).toBe(20.0);

      const btcSwap = adapter.getFallbackFixtures('futures').find(
        (c) => c.pair === 'BTC/USDT' && c.vipTier === 'VIP0'
      );
      expect(btcSwap).toBeDefined();
      expect(btcSwap?.makerFee).toBe(0.0002);
      expect(btcSwap?.takerFee).toBe(0.0005);
    });

    test('parses OKX v5 instruments API response', async () => {
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('SWAP')) {
          return Promise.resolve(new Response(JSON.stringify(MOCK_OKX_SWAP_INSTRUMENTS)));
        }
        return Promise.resolve(new Response(JSON.stringify(MOCK_OKX_SPOT_INSTRUMENTS)));
      });

      const result = await adapter.crawlRateCards();
      expect(result.fromFallback).toBe(false);
      expect(result.rateCards.length).toBeGreaterThan(0);
    });

    test('falls back gracefully on network error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const result = await adapter.crawlRateCards();
      expect(result.fromFallback).toBe(true);
      expect(result.error).toContain('Connection refused');
    });
  });

  describe('KuCoinCrawlerAdapter', () => {
    const adapter = new KuCoinCrawlerAdapter();

    test('has correct metadata and supported markets', () => {
      expect(adapter.exchange).toBe('kucoin');
      expect(adapter.supportedMarkets).toEqual(['spot', 'futures']);
    });

    test('normalizes KuCoin symbols correctly including XBT/contract format', () => {
      expect(adapter.normalizePair('BTC-USDT', 'spot')).toBe('BTC/USDT');
      expect(adapter.normalizePair('XBTUSDTM', 'futures')).toBe('BTC/USDT');
      expect(adapter.normalizePair('ETHUSDTM', 'futures')).toBe('ETH/USDT');
      expect(adapter.normalizePair('SOLUSDTM', 'futures')).toBe('SOL/USDT');
    });

    test('denormalizes KuCoin symbols correctly', () => {
      expect(adapter.denormalizePair('BTC/USDT', 'spot')).toBe('BTC-USDT');
      expect(adapter.denormalizePair('BTC/USDT', 'futures')).toBe('XBTUSDTM');
      expect(adapter.denormalizePair('ETH/USDT', 'futures')).toBe('ETHUSDTM');
    });

    test('returns deterministic fallback fixtures with 25% cashback', () => {
      const btcSpot = adapter.getFallbackFixtures('spot').find(
        (c) => c.pair === 'BTC/USDT' && c.vipTier === 'VIP0'
      );
      expect(btcSpot).toBeDefined();
      expect(btcSpot?.makerFee).toBe(0.0010);
      expect(btcSpot?.takerFee).toBe(0.0010);
      expect(btcSpot?.defaultCashbackPct).toBe(25.0);
      expect(btcSpot?.promotionalDiscountPct).toBe(20.0);

      const btcContract = adapter.getFallbackFixtures('futures').find(
        (c) => c.pair === 'BTC/USDT' && c.vipTier === 'VIP0'
      );
      expect(btcContract).toBeDefined();
      expect(btcContract?.makerFee).toBe(0.0002);
      expect(btcContract?.takerFee).toBe(0.0006);
    });

    test('parses KuCoin API response for spot and contracts', async () => {
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('contracts')) {
          return Promise.resolve(new Response(JSON.stringify(MOCK_KUCOIN_CONTRACTS)));
        }
        return Promise.resolve(new Response(JSON.stringify(MOCK_KUCOIN_SPOT_SYMBOLS)));
      });

      const result = await adapter.crawlRateCards();
      expect(result.fromFallback).toBe(false);
      expect(result.rateCards.length).toBeGreaterThan(0);
    });

    test('falls back on 429 status code', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        new Response('Too Many Requests', { status: 429, statusText: 'Rate limit exceeded' })
      );

      const result = await adapter.crawlRateCards();
      expect(result.fromFallback).toBe(true);
      expect(result.error).toContain('429');
    });
  });
});
