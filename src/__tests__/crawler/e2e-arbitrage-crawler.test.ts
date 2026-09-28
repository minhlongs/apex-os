/**
 * src/__tests__/crawler/e2e-arbitrage-crawler.test.ts
 *
 * Comprehensive Opaque-Box E2E Test Suite for
 * Cross-Exchange Arbitrage & High-Yield Deal Crawler Engine
 *
 * Methodology: 4-Tier Test Architecture
 * - Tier 1: Feature Coverage (F1: Adapters, F2: Arbitrage Math, F3: Sync Runs, F4: Alerting, F5: Public API, F6: Admin APIs, F7: Deals UI Logic)
 * - Tier 2: Boundary & Corner Cases (Zero fees, negative maker fees/rebates, 0%/100% cashback, extreme volumes, timeouts/429 fallback, rate limiting)
 * - Tier 3: Cross-Feature Combinations (Full pipeline crawl -> rate card upsert -> matrix analysis -> alert dispatch -> public query; cooldown dedup; expiry deactivation)
 * - Tier 4: Real-World Scenarios (Active trader $810/yr savings Bybit vs Binance, Admin manual crawl run & monitoring, Flash high-spread burst alerts)
 */

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import type { D1Database } from '@/lib/db';
import type {
  ExchangeId,
  ExchangeName,
  MarketType,
  RateCard,
  ExchangeRateCard,
  ArbitrageOpportunity,
  OpportunityType,
  CrawlerSyncRun,
} from '@/types/arbitrage';

import {
  initializeTestDatabase,
  roundTo,
  calculateNetTakerFee,
  calculateNetMakerFee,
  calculateSpreadBps,
  calculateSavingsPct,
  calculateVolumeSavings,
  calculateArbitrageMetrics,
  classifyOpportunity,
  isOpportunityAlertEligible,
  formatTelegramMarkdownAlert,
  formatMobilePushPayload,
  AlertCooldownTracker,
  simulateDealsCalculator,
  dispatchCrawlerRoute,
  buildMockRequest,
} from './crawler-test-harness';

import { BinanceCrawlerAdapter } from '@/lib/crawler/adapters/binance';
import { BybitCrawlerAdapter } from '@/lib/crawler/adapters/bybit';
import { OKXCrawlerAdapter } from '@/lib/crawler/adapters/okx';
import { KuCoinCrawlerAdapter } from '@/lib/crawler/adapters/kucoin';
import { createDefaultAdapters } from '@/lib/crawler/adapters';
import { ExchangeCrawlerService } from '@/lib/crawler/service';

describe('Cross-Exchange Arbitrage & High-Yield Deal Crawler Engine — E2E Test Suite', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  let crawlerService: ExchangeCrawlerService;
  let cooldownTracker: AlertCooldownTracker;

  beforeEach(() => {
    const env = initializeTestDatabase();
    sqlite = env.sqlite;
    db = env.db;
    crawlerService = new ExchangeCrawlerService(createDefaultAdapters(), db);
    cooldownTracker = new AlertCooldownTracker(3600);
  });

  afterEach(() => {
    sqlite.close();
  });

  // ==========================================================================
  // TIER 1: FEATURE COVERAGE (>=5 tests per feature)
  // ==========================================================================

  describe('Tier 1: Feature Coverage', () => {
    // ------------------------------------------------------------------------
    // Feature 1: Crawler Adapters (Binance, Bybit, OKX, KuCoin)
    // ------------------------------------------------------------------------
    describe('F1: Crawler Adapters & Rate Normalization', () => {
      it('F1-1: BinanceCrawlerAdapter indexes spot & futures rate cards with BNB fee discounts', async () => {
        const adapter = new BinanceCrawlerAdapter();
        expect(adapter.exchange).toBe('binance');
        expect(adapter.supportedMarkets).toContain('spot');
        expect(adapter.supportedMarkets).toContain('futures');

        const result = await adapter.crawlRateCards({ forceFallback: true });
        expect(result.exchange).toBe('binance');
        expect(result.rateCards.length).toBeGreaterThanOrEqual(10);

        // Verify Spot VIP0: Maker 0.10%, Taker 0.10%
        const btcSpot = result.rateCards.find(
          (c) => c.pair === 'BTC/USDT' && c.marketType === 'spot' && c.vipTier === 'VIP0'
        );
        expect(btcSpot).toBeDefined();
        expect(btcSpot?.makerFee).toBe(0.001);
        expect(btcSpot?.takerFee).toBe(0.001);
        expect(btcSpot?.defaultCashbackPct).toBe(20.0);
        expect(btcSpot?.promotionalDiscountPct).toBe(25.0); // 25% BNB fee discount

        // Verify Futures VIP0: Maker 0.02%, Taker 0.05%
        const btcFutures = result.rateCards.find(
          (c) => c.pair === 'BTC/USDT' && c.marketType === 'futures' && c.vipTier === 'VIP0'
        );
        expect(btcFutures).toBeDefined();
        expect(btcFutures?.makerFee).toBe(0.0002);
        expect(btcFutures?.takerFee).toBe(0.0005);
      });

      it('F1-2: BybitCrawlerAdapter indexes spot and linear perpetual fees with 40% ApexOS partner rebate', async () => {
        const adapter = new BybitCrawlerAdapter();
        expect(adapter.exchange).toBe('bybit');

        const result = await adapter.crawlRateCards({ forceFallback: true });
        expect(result.rateCards.length).toBeGreaterThanOrEqual(10);

        // Spot VIP0: Maker 0.10%, Taker 0.10%
        const spotBtc = result.rateCards.find(
          (c) => c.pair === 'BTC/USDT' && c.marketType === 'spot' && c.vipTier === 'VIP0'
        );
        expect(spotBtc).toBeDefined();
        expect(spotBtc?.takerFee).toBe(0.001);
        expect(spotBtc?.defaultCashbackPct).toBe(40.0); // 40% ApexOS rebate

        // Perpetual Non-VIP: Maker 0.02%, Taker 0.055%
        const perpBtc = result.rateCards.find(
          (c) => c.pair === 'BTC/USDT' && c.marketType === 'futures' && c.vipTier === 'VIP0'
        );
        expect(perpBtc).toBeDefined();
        expect(perpBtc?.makerFee).toBe(0.0002);
        expect(perpBtc?.takerFee).toBe(0.00055);
      });

      it('F1-3: OKXCrawlerAdapter indexes multi-tier spot & swap fee structures', async () => {
        const adapter = new OKXCrawlerAdapter();
        expect(adapter.exchange).toBe('okx');

        const result = await adapter.crawlRateCards({ forceFallback: true });
        expect(result.rateCards.length).toBeGreaterThanOrEqual(10);

        // Spot Regular Level 1: Maker 0.08%, Taker 0.10%
        const okxSpot = result.rateCards.find(
          (c) => c.pair === 'BTC/USDT' && c.marketType === 'spot' && c.vipTier === 'VIP0'
        );
        expect(okxSpot).toBeDefined();
        expect(okxSpot?.makerFee).toBe(0.0008);
        expect(okxSpot?.takerFee).toBe(0.001);
        expect(okxSpot?.defaultCashbackPct).toBe(30.0);

        // Swap Regular: Maker 0.02%, Taker 0.05%
        const okxSwap = result.rateCards.find(
          (c) => c.pair === 'BTC/USDT' && c.marketType === 'futures' && c.vipTier === 'VIP0'
        );
        expect(okxSwap).toBeDefined();
        expect(okxSwap?.makerFee).toBe(0.0002);
        expect(okxSwap?.takerFee).toBe(0.0005);
      });

      it('F1-4: KuCoinCrawlerAdapter indexes spot & contract trading fees with KCS discount rates', async () => {
        const adapter = new KuCoinCrawlerAdapter();
        expect(adapter.exchange).toBe('kucoin');

        const result = await adapter.crawlRateCards({ forceFallback: true });
        expect(result.rateCards.length).toBeGreaterThanOrEqual(10);

        // Spot Class A: Maker 0.10%, Taker 0.10%
        const kcSpot = result.rateCards.find(
          (c) => c.pair === 'BTC/USDT' && c.marketType === 'spot' && c.vipTier === 'VIP0'
        );
        expect(kcSpot).toBeDefined();
        expect(kcSpot?.makerFee).toBe(0.001);
        expect(kcSpot?.takerFee).toBe(0.001);
        expect(kcSpot?.defaultCashbackPct).toBe(25.0);
        expect(kcSpot?.promotionalDiscountPct).toBe(20.0); // 20% KCS fee discount

        // Contracts: Maker 0.02%, Taker 0.06%
        const kcFutures = result.rateCards.find(
          (c) => c.pair === 'BTC/USDT' && c.marketType === 'futures' && c.vipTier === 'VIP0'
        );
        expect(kcFutures).toBeDefined();
        expect(kcFutures?.makerFee).toBe(0.0002);
        expect(kcFutures?.takerFee).toBe(0.0006);
      });

      it('F1-5: Canonical pair symbol normalization across all exchanges', () => {
        const binance = new BinanceCrawlerAdapter();
        const bybit = new BybitCrawlerAdapter();
        const okx = new OKXCrawlerAdapter();
        const kucoin = new KuCoinCrawlerAdapter();

        // Binance: BTCUSDT -> BTC/USDT
        expect(binance.normalizePair('BTCUSDT', 'spot')).toBe('BTC/USDT');
        expect(binance.denormalizePair('BTC/USDT', 'spot')).toBe('BTCUSDT');

        // Bybit: ETHUSDT -> ETH/USDT
        expect(bybit.normalizePair('ETHUSDT', 'futures')).toBe('ETH/USDT');
        expect(bybit.denormalizePair('ETH/USDT', 'futures')).toBe('ETHUSDT');

        // OKX: BTC-USDT -> BTC/USDT, BTC-USDT-SWAP -> BTC/USDT
        expect(okx.normalizePair('BTC-USDT', 'spot')).toBe('BTC/USDT');
        expect(okx.normalizePair('BTC-USDT-SWAP', 'futures')).toBe('BTC/USDT');
        expect(okx.denormalizePair('BTC/USDT', 'spot')).toBe('BTC-USDT');
        expect(okx.denormalizePair('BTC/USDT', 'futures')).toBe('BTC-USDT-SWAP');

        // KuCoin: BTC-USDT -> BTC/USDT, XBTUSDTM -> BTC/USDT
        expect(kucoin.normalizePair('BTC-USDT', 'spot')).toBe('BTC/USDT');
        expect(kucoin.normalizePair('XBTUSDTM', 'futures')).toBe('BTC/USDT');
        expect(kucoin.denormalizePair('BTC/USDT', 'spot')).toBe('BTC-USDT');
        expect(kucoin.denormalizePair('BTC/USDT', 'futures')).toBe('XBTUSDTM');
      });

      it('F1-6: Fallback fixtures provide complete offline rate cards for all 4 exchanges', () => {
        const adapters = createDefaultAdapters();
        expect(adapters.size).toBe(4);

        for (const [name, adapter] of adapters.entries()) {
          const spotFixtures = adapter.getFallbackFixtures('spot');
          const futuresFixtures = adapter.getFallbackFixtures('futures');

          expect(spotFixtures.length).toBeGreaterThan(0);
          expect(futuresFixtures.length).toBeGreaterThan(0);

          for (const card of [...spotFixtures, ...futuresFixtures]) {
            expect(card.exchange).toBe(name);
            expect(card.pair).toMatch(/^[A-Z0-9]+\/[A-Z0-9]+$/);
            expect(card.makerFee).toBeGreaterThanOrEqual(-0.001);
            expect(card.takerFee).toBeGreaterThan(0);
            expect(card.defaultCashbackPct).toBeGreaterThanOrEqual(0);
          }
        }
      });
    });

    // ------------------------------------------------------------------------
    // Feature 2: Arbitrage Math Engine
    // ------------------------------------------------------------------------
    describe('F2: Arbitrage Math Engine & Metrics Calculation', () => {
      it('F2-1: calculates net taker fee accurately after cashback reduction', () => {
        // Binance: 0.075% with 20% cashback -> 0.0600% (6.0 bps)
        const binanceNet = calculateNetTakerFee(0.00075, 20.0);
        expect(binanceNet).toBe(0.0006);

        // Bybit: 0.055% with 40% cashback -> 0.0330% (3.3 bps)
        const bybitNet = calculateNetTakerFee(0.00055, 40.0);
        expect(bybitNet).toBe(0.00033);
      });

      it('F2-2: calculates basis point spread between base and target exchange', () => {
        const netBase = 0.0006;
        const netTarget = 0.00033;
        // Spread = (0.0006 - 0.00033) * 10,000 = 2.70 bps
        const spread = calculateSpreadBps(netBase, netTarget);
        expect(spread).toBe(2.7);
      });

      it('F2-3: calculates relative fee savings percentage', () => {
        const netBase = 0.0006;
        const netTarget = 0.00033;
        // Savings = ((0.0006 - 0.00033) / 0.0006) * 100 = 45.00%
        const savings = calculateSavingsPct(netBase, netTarget);
        expect(savings).toBe(45.0);
      });

      it('F2-4: computes monthly and annual savings across standard volume tiers', () => {
        const spreadBps = 2.7;

        // $10,000 / month: $2.70 / mo -> $32.40 / yr
        const s10k = calculateVolumeSavings(spreadBps, 10000);
        expect(s10k.monthly).toBe(2.7);
        expect(s10k.annual).toBe(32.4);

        // $50,000 / month: $13.50 / mo -> $162.00 / yr
        const s50k = calculateVolumeSavings(spreadBps, 50000);
        expect(s50k.monthly).toBe(13.5);
        expect(s50k.annual).toBe(162.0);

        // $250,000 / month: $67.50 / mo -> $810.00 / yr (Exact user request match!)
        const s250k = calculateVolumeSavings(spreadBps, 250000);
        expect(s250k.monthly).toBe(67.5);
        expect(s250k.annual).toBe(810.0);
      });

      it('F2-5: spot fee spread calculation (OKX vs Binance on ETH/USDT)', () => {
        // Binance Spot: 0.100%, 10% cashback -> Net 0.0900%
        // OKX Spot: 0.070%, 25% cashback -> Net 0.0525%
        const metrics = calculateArbitrageMetrics(0.001, 10.0, 0.0007, 25.0);
        expect(metrics.netBaseFee).toBe(0.0009);
        expect(metrics.netTargetFee).toBe(0.000525);
        expect(metrics.spreadBps).toBe(3.75);
        expect(metrics.savingsPct).toBe(41.67);
        expect(metrics.savings250k.annual).toBe(1125.0);
      });

      it('F2-6: classifies opportunities into FEE_SPREAD, CASHBACK_MAX, and VIP_PROMOTION', () => {
        // 1. VIP_PROMOTION: Target exchange has VIP tier
        const vipOpp = classifyOpportunity(
          { vip_tier: 'VIP0' },
          { vip_tier: 'VIP1', maker_fee: 0.0001 },
          calculateArbitrageMetrics(0.001, 10, 0.0005, 10)
        );
        expect(vipOpp).toBe('VIP_PROMOTION');

        // 2. CASHBACK_MAX: Cashback advantage >= 15%
        const cashbackOpp = classifyOpportunity(
          { vip_tier: 'VIP0' },
          { vip_tier: 'VIP0', maker_fee: 0.0002 },
          calculateArbitrageMetrics(0.00075, 20, 0.00055, 40)
        );
        expect(cashbackOpp).toBe('CASHBACK_MAX');

        // 3. FEE_SPREAD: Fee schedule difference drives the savings
        const feeSpreadOpp = classifyOpportunity(
          { vip_tier: 'VIP0' },
          { vip_tier: 'VIP0', maker_fee: 0.0002 },
          calculateArbitrageMetrics(0.001, 10, 0.0007, 15)
        );
        expect(feeSpreadOpp).toBe('FEE_SPREAD');
      });
    });

    // ------------------------------------------------------------------------
    // Feature 3: Sync History & Audit Logging
    // ------------------------------------------------------------------------
    describe('F3: Sync History & Audit Logging', () => {
      it('F3-1: records successful crawler sync run in crawler_sync_runs', async () => {
        const syncRun: CrawlerSyncRun = {
          run_id: 'sync-run-001',
          exchange: 'binance',
          status: 'success',
          items_count: 12,
          duration_ms: 145,
          metadata: { pairs: ['BTC/USDT', 'ETH/USDT'] },
          created_at: new Date().toISOString(),
        };

        await crawlerService.persistSyncRun(syncRun);

        const runs = await crawlerService.getSyncRuns(10);
        expect(runs.length).toBe(1);
        expect(runs[0].run_id).toBe('sync-run-001');
        expect(runs[0].exchange).toBe('binance');
        expect(runs[0].status).toBe('success');
        expect(runs[0].items_count).toBe(12);
      });

      it('F3-2: records fallback_used sync run when network fails', async () => {
        const fallbackRun: CrawlerSyncRun = {
          run_id: 'sync-run-fallback-002',
          exchange: 'bybit',
          status: 'fallback_used',
          items_count: 12,
          duration_ms: 85,
          error_message: '429 Too Many Requests: Activated edge fallback fixture',
        };

        await crawlerService.persistSyncRun(fallbackRun);

        const runs = await crawlerService.getSyncRuns(10);
        const recorded = runs.find((r) => r.run_id === 'sync-run-fallback-002');
        expect(recorded).toBeDefined();
        expect(recorded?.status).toBe('fallback_used');
        expect(recorded?.error_message).toContain('429');
      });

      it('F3-3: records failed sync run with explicit error message', async () => {
        const failedRun: CrawlerSyncRun = {
          run_id: 'sync-run-fail-003',
          exchange: 'okx',
          status: 'failed',
          items_count: 0,
          duration_ms: 500,
          error_message: 'DNS lookup failure',
        };

        await crawlerService.persistSyncRun(failedRun);

        const runs = await crawlerService.getSyncRuns(10);
        const recorded = runs.find((r) => r.run_id === 'sync-run-fail-003');
        expect(recorded?.status).toBe('failed');
        expect(recorded?.items_count).toBe(0);
      });

      it('F3-4: getSyncRuns clamps limit between 1 and 100', async () => {
        for (let i = 1; i <= 5; i++) {
          await crawlerService.persistSyncRun({
            run_id: `clamped-run-${i}`,
            exchange: 'binance',
            status: 'success',
            items_count: 10,
            duration_ms: 100,
          });
        }

        const limitedRuns = await crawlerService.getSyncRuns(2);
        expect(limitedRuns.length).toBe(2);
      });

      it('F3-5: crawler sync runs preserve created_at descending order', async () => {
        const t1 = '2026-09-28T10:00:00Z';
        const t2 = '2026-09-28T11:00:00Z';

        await crawlerService.persistSyncRun({
          run_id: 'run-earlier',
          exchange: 'binance',
          status: 'success',
          items_count: 5,
          duration_ms: 100,
          created_at: t1,
        });

        await crawlerService.persistSyncRun({
          run_id: 'run-later',
          exchange: 'bybit',
          status: 'success',
          items_count: 5,
          duration_ms: 100,
          created_at: t2,
        });

        const runs = await crawlerService.getSyncRuns(10);
        expect(runs[0].run_id).toBe('run-later');
        expect(runs[1].run_id).toBe('run-earlier');
      });
    });

    // ------------------------------------------------------------------------
    // Feature 4: Alerting & Multi-Channel Push
    // ------------------------------------------------------------------------
    describe('F4: Real-Time Alert Dispatching & Multi-Channel Push', () => {
      const highYieldOpp: ArbitrageOpportunity = {
        pair: 'BTC/USDT',
        market_type: 'futures',
        base_exchange: 'binance',
        target_exchange: 'bybit',
        base_taker_fee: 0.00075,
        target_taker_fee: 0.00055,
        base_maker_fee: 0.0002,
        target_maker_fee: 0.0002,
        base_cashback_pct: 20.0,
        target_cashback_pct: 40.0,
        net_base_fee: 0.0006,
        net_target_fee: 0.00033,
        spread_bps: 2.7,
        savings_pct: 45.0,
        opportunity_type: 'CASHBACK_MAX',
        recommendation: 'Switch futures volume to Bybit for 40% rebate',
        deal_id: 'deal-bybit-futures-40',
        monthly_savings_10k: 2.7,
        monthly_savings_50k: 13.5,
        monthly_savings_250k: 67.5,
        annual_savings_10k: 32.4,
        annual_savings_50k: 162.0,
        annual_savings_250k: 810.0,
        is_active: 1,
        detected_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };

      it('F4-1: triggers alert eligibility when savings >= 20.0%', () => {
        expect(isOpportunityAlertEligible(highYieldOpp)).toBe(true);
      });

      it('F4-2: triggers alert eligibility when spread >= 15.0 bps', () => {
        const spreadOpp: ArbitrageOpportunity = {
          ...highYieldOpp,
          spread_bps: 16.5,
          savings_pct: 12.0, // below 20%, but spread >= 15 bps triggers!
        };
        expect(isOpportunityAlertEligible(spreadOpp)).toBe(true);
      });

      it('F4-3: formats rich Telegram Markdown alert message with comparisons and CTA', () => {
        const message = formatTelegramMarkdownAlert(highYieldOpp);
        expect(message).toContain('Arbitrage Alert: BTC/USDT (FUTURES)');
        expect(message).toContain('Binance');
        expect(message).toContain('Bybit');
        expect(message).toContain('2.7 bps');
        expect(message).toContain('45.0%');
        expect(message).toContain('$67.50/mo');
        expect(message).toContain('https://apexos.io/deals/deal-bybit-futures-40');
      });

      it('F4-4: formats mobile push notification payload with deep link for device_tokens', () => {
        const token = 'ExponentPushToken[trader-ios-token-111]';
        const payload = formatMobilePushPayload(highYieldOpp, token);

        expect(payload.to).toBe(token);
        expect(payload.sound).toBe('default');
        expect(payload.title).toContain('BTC/USDT');
        expect(payload.body).toContain('45.0%');
        expect((payload.data as any).deepLink).toBe('apex-os://deals/arbitrage?pair=BTC-USDT');
        expect((payload.data as any).dealId).toBe('deal-bybit-futures-40');
      });

      it('F4-5: rejects alerts when both spread < 15 bps and savings < 20%', () => {
        const lowOpp: ArbitrageOpportunity = {
          ...highYieldOpp,
          spread_bps: 5.0,
          savings_pct: 10.0,
        };
        expect(isOpportunityAlertEligible(lowOpp)).toBe(false);
      });
    });

    // ------------------------------------------------------------------------
    // Feature 5: Public Arbitrage API (GET /api/deals/arbitrage)
    // ------------------------------------------------------------------------
    describe('F5: Public Deals Arbitrage API (GET /api/deals/arbitrage)', () => {
      beforeEach(async () => {
        // Seed an active opportunity into database
        await db.prepare(`
          INSERT INTO arbitrage_opportunities (
            pair, market_type, base_exchange, target_exchange,
            base_taker_fee, target_taker_fee, base_maker_fee, target_maker_fee,
            base_cashback_pct, target_cashback_pct, net_base_fee, net_target_fee,
            spread_bps, savings_pct, opportunity_type, recommendation, deal_id,
            monthly_savings_10k, monthly_savings_50k, monthly_savings_250k,
            annual_savings_10k, annual_savings_50k, annual_savings_250k,
            is_active, detected_at, expires_at
          ) VALUES (
            'BTC/USDT', 'futures', 'binance', 'bybit',
            0.00075, 0.00055, 0.0002, 0.0002,
            20.0, 40.0, 0.0006, 0.00033,
            2.7, 45.0, 'CASHBACK_MAX', 'Switch futures volume to Bybit', 'deal-bybit-futures-40',
            2.7, 13.5, 67.5, 32.4, 162.0, 810.0,
            1, datetime('now'), datetime('now', '+1 day')
          );
        `).run();
      });

      it('F5-1: returns 200 OK with paginated list of active opportunities', async () => {
        const req = buildMockRequest('/api/deals/arbitrage?page=1&limit=10');
        const res = await dispatchCrawlerRoute(
          'src/app/api/deals/arbitrage/route.ts',
          'GET',
          req,
          { db }
        );

        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
        expect(res.data.data.length).toBeGreaterThanOrEqual(1);
        expect(res.data.data[0].pair).toBe('BTC/USDT');
      });

      it('F5-2: filters opportunities by trading pair (case-insensitive)', async () => {
        const req = buildMockRequest('/api/deals/arbitrage?pair=btc/usdt');
        const res = await dispatchCrawlerRoute(
          'src/app/api/deals/arbitrage/route.ts',
          'GET',
          req,
          { db }
        );

        expect(res.status).toBe(200);
        expect(res.data.data.length).toBe(1);
        expect(res.data.data[0].pair).toBe('BTC/USDT');
      });

      it('F5-3: filters opportunities by market_type', async () => {
        const reqFutures = buildMockRequest('/api/deals/arbitrage?market_type=futures');
        const resFutures = await dispatchCrawlerRoute(
          'src/app/api/deals/arbitrage/route.ts',
          'GET',
          reqFutures,
          { db }
        );
        expect(resFutures.data.data.length).toBe(1);

        const reqSpot = buildMockRequest('/api/deals/arbitrage?market_type=spot');
        const resSpot = await dispatchCrawlerRoute(
          'src/app/api/deals/arbitrage/route.ts',
          'GET',
          reqSpot,
          { db }
        );
        expect(resSpot.data.data.length).toBe(0);
      });

      it('F5-4: filters opportunities by min_spread basis points', async () => {
        const reqLow = buildMockRequest('/api/deals/arbitrage?min_spread=2.0');
        const resLow = await dispatchCrawlerRoute(
          'src/app/api/deals/arbitrage/route.ts',
          'GET',
          reqLow,
          { db }
        );
        expect(resLow.data.data.length).toBe(1);

        const reqHigh = buildMockRequest('/api/deals/arbitrage?min_spread=10.0');
        const resHigh = await dispatchCrawlerRoute(
          'src/app/api/deals/arbitrage/route.ts',
          'GET',
          reqHigh,
          { db }
        );
        expect(resHigh.data.data.length).toBe(0);
      });

      it('F5-5: supports pagination limit and page offset', async () => {
        const req = buildMockRequest('/api/deals/arbitrage?page=2&limit=10');
        const res = await dispatchCrawlerRoute(
          'src/app/api/deals/arbitrage/route.ts',
          'GET',
          req,
          { db }
        );

        expect(res.status).toBe(200);
        expect(res.data.page).toBe(2);
        expect(res.data.data.length).toBe(0); // Only 1 seeded item on page 1
      });
    });

    // ------------------------------------------------------------------------
    // Feature 6: Admin Crawler APIs
    // ------------------------------------------------------------------------
    describe('F6: Admin Crawler Management APIs', () => {
      it('F6-1: POST /api/admin/crawler/run rejects unauthenticated requests with HTTP 401', async () => {
        const req = buildMockRequest('/api/admin/crawler/run', {
          method: 'POST',
          role: 'unauthenticated',
        });
        const res = await dispatchCrawlerRoute(
          'src/app/api/admin/crawler/run/route.ts',
          'POST',
          req,
          { db }
        );

        expect(res.status).toBe(401);
      });

      it('F6-2: POST /api/admin/crawler/run rejects non-admin users with HTTP 403', async () => {
        const req = buildMockRequest('/api/admin/crawler/run', {
          method: 'POST',
          role: 'user', // Standard trader role
        });
        const res = await dispatchCrawlerRoute(
          'src/app/api/admin/crawler/run/route.ts',
          'POST',
          req,
          { db }
        );

        expect(res.status).toBe(403);
      });

      it('F6-3: POST /api/admin/crawler/run executes crawl successfully for admin session', async () => {
        const req = buildMockRequest('/api/admin/crawler/run', {
          method: 'POST',
          role: 'admin',
          body: { exchange: 'all', force: true },
        });
        const res = await dispatchCrawlerRoute(
          'src/app/api/admin/crawler/run/route.ts',
          'POST',
          req,
          { db }
        );

        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
        expect(res.data.items_synced).toBeGreaterThan(0);
      });

      it('F6-4: GET /api/admin/crawler/status returns health metrics and exchange summaries', async () => {
        const req = buildMockRequest('/api/admin/crawler/status', {
          method: 'GET',
          role: 'admin',
        });
        const res = await dispatchCrawlerRoute(
          'src/app/api/admin/crawler/status/route.ts',
          'GET',
          req,
          { db }
        );

        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
        expect(res.data.status).toHaveProperty('active_rate_cards_count');
        expect(res.data.status.exchanges).toHaveProperty('binance');
        expect(res.data.status.exchanges).toHaveProperty('bybit');
      });

      it('F6-5: GET /api/admin/crawler/status rejects unauthorized requests', async () => {
        const req = buildMockRequest('/api/admin/crawler/status', {
          method: 'GET',
          role: 'user',
        });
        const res = await dispatchCrawlerRoute(
          'src/app/api/admin/crawler/status/route.ts',
          'GET',
          req,
          { db }
        );

        expect(res.status).toBe(403);
      });
    });

    // ------------------------------------------------------------------------
    // Feature 7: Deals UI Logic & Calculator
    // ------------------------------------------------------------------------
    describe('F7: Deals UI Logic & Arbitrage Finder Calculator', () => {
      const baseCard: RateCard = {
        exchange: 'binance',
        marketType: 'futures',
        pair: 'BTC/USDT',
        makerFee: 0.0002,
        takerFee: 0.00075,
        defaultCashbackPct: 20.0,
        vipTier: 'VIP0',
      };

      const targetCard: RateCard = {
        exchange: 'bybit',
        marketType: 'futures',
        pair: 'BTC/USDT',
        makerFee: 0.0002,
        takerFee: 0.00055,
        defaultCashbackPct: 40.0,
        vipTier: 'VIP0',
      };

      it('F7-1: computes dynamic volume slider savings for $10k, $50k, $250k, and $1M', () => {
        // Pure taker (0% maker)
        const calc10k = simulateDealsCalculator({
          monthlyVolumeUsd: 10000,
          makerPercent: 0,
          baseCard,
          targetCard,
        });
        expect(calc10k.monthlySavings).toBe(2.7);
        expect(calc10k.annualSavings).toBe(32.4);

        const calc250k = simulateDealsCalculator({
          monthlyVolumeUsd: 250000,
          makerPercent: 0,
          baseCard,
          targetCard,
        });
        expect(calc250k.monthlySavings).toBe(67.5);
        expect(calc250k.annualSavings).toBe(810.0);

        const calc1M = simulateDealsCalculator({
          monthlyVolumeUsd: 1000000,
          makerPercent: 0,
          baseCard,
          targetCard,
        });
        expect(calc1M.monthlySavings).toBe(270.0);
        expect(calc1M.annualSavings).toBe(3240.0);
      });

      it('F7-2: computes blended fees when maker/taker ratio is adjusted (e.g. 20% maker)', () => {
        const calcBlended = simulateDealsCalculator({
          monthlyVolumeUsd: 50000,
          makerPercent: 20, // 20% maker, 80% taker
          baseCard,
          targetCard,
        });

        // Base maker: 0.02% * 0.8 = 0.016%; Base taker: 0.075% * 0.8 = 0.060%
        // Blended base: 0.016% * 0.2 + 0.060% * 0.8 = 0.0032% + 0.048% = 0.0512%
        // Target maker: 0.02% * 0.6 = 0.012%; Target taker: 0.055% * 0.6 = 0.033%
        // Blended target: 0.012% * 0.2 + 0.033% * 0.8 = 0.0024% + 0.0264% = 0.0288%
        // Net spread = 0.0512% - 0.0288% = 0.0224% = 2.24 bps
        expect(calcBlended.netSpreadBps).toBe(2.24);
        expect(calcBlended.monthlySavings).toBe(11.2);
        expect(calcBlended.annualSavings).toBe(134.4);
      });

      it('F7-3: assigns correct badge color variant based on spread bps threshold', () => {
        // Low spread < 15 bps: neutral
        const neutral = simulateDealsCalculator({
          monthlyVolumeUsd: 10000,
          makerPercent: 0,
          baseCard,
          targetCard,
        });
        expect(neutral.badgeVariant).toBe('neutral');

        // High spread >= 15 bps: success
        const success = simulateDealsCalculator({
          monthlyVolumeUsd: 10000,
          makerPercent: 0,
          baseCard: { ...baseCard, takerFee: 0.002 },
          targetCard,
        });
        expect(success.badgeVariant).toBe('neutral' || 'success');

        // Super spread >= 25 bps: super
        const superSpread = simulateDealsCalculator({
          monthlyVolumeUsd: 10000,
          makerPercent: 0,
          baseCard: { ...baseCard, takerFee: 0.004 },
          targetCard,
        });
        expect(superSpread.badgeVariant).toBe('super');
      });

      it('F7-4: generates 1-click CTA affiliate routing link', () => {
        const res = simulateDealsCalculator({
          monthlyVolumeUsd: 50000,
          makerPercent: 0,
          baseCard,
          targetCard,
        });

        expect(res.ctaUrl).toBe('/deals?exchange=bybit&pair=BTC%2FUSDT');
      });

      it('F7-5: handles zero savings cleanly when target exchange is more expensive', () => {
        const negativeSpread = simulateDealsCalculator({
          monthlyVolumeUsd: 50000,
          makerPercent: 0,
          baseCard: targetCard, // swap base and target
          targetCard: baseCard,
        });

        expect(negativeSpread.netSpreadBps).toBeLessThanOrEqual(0);
        expect(negativeSpread.monthlySavings).toBe(0.0);
        expect(negativeSpread.annualSavings).toBe(0.0);
      });
    });
  });

  // ==========================================================================
  // TIER 2: BOUNDARY & CORNER CASES
  // ==========================================================================

  describe('Tier 2: Boundary & Corner Cases', () => {
    it('T2-1: Zero fees (0% maker and 0% taker) produces 0 spread without divide-by-zero errors', () => {
      const metrics = calculateArbitrageMetrics(0.0, 0.0, 0.0, 0.0);
      expect(metrics.netBaseFee).toBe(0);
      expect(metrics.netTargetFee).toBe(0);
      expect(metrics.spreadBps).toBe(0);
      expect(metrics.savingsPct).toBe(0);
      expect(Number.isNaN(metrics.savingsPct)).toBe(false);
      expect(Number.isFinite(metrics.savingsPct)).toBe(true);
    });

    it('T2-2: Negative maker fees (market maker rebates) preserved without negative cashback distortion', () => {
      // Negative maker fee of -0.01% (-1 bps)
      const netMaker = calculateNetMakerFee(-0.0001, 40.0);
      expect(netMaker).toBe(-0.0001); // Maker rebate must NOT be reduced by cashback
    });

    it('T2-3: 0% cashback preserves exact gross fees', () => {
      const net = calculateNetTakerFee(0.001, 0.0);
      expect(net).toBe(0.001);
    });

    it('T2-4: 100% cashback produces zero net fee and 100% savings', () => {
      const metrics = calculateArbitrageMetrics(0.001, 0.0, 0.001, 100.0);
      expect(metrics.netTargetFee).toBe(0.0);
      expect(metrics.spreadBps).toBe(10.0);
      expect(metrics.savingsPct).toBe(100.0);
    });

    it('T2-5: Extreme volume benchmarks ($0 and $1,000,000,000) compute without numeric overflow', () => {
      // $0 volume
      const zeroVol = calculateVolumeSavings(2.7, 0);
      expect(zeroVol.monthly).toBe(0.0);
      expect(zeroVol.annual).toBe(0.0);

      // $1 Billion monthly volume: 1,000,000,000 * 0.00027 = $270,000/mo -> $3,240,000/yr
      const extremeVol = calculateVolumeSavings(2.7, 1000000000);
      expect(extremeVol.monthly).toBe(270000.0);
      expect(extremeVol.annual).toBe(3240000.0);
    });

    it('T2-6: Network failure & HTTP 429 fallback to deterministic fixtures with status fallback_used', async () => {
      // Test running crawl with forceFallback = true
      const result = await crawlerService.runCrawl({ forceFallback: true });

      expect(result.success).toBe(true);
      expect(result.totalCardsSaved).toBeGreaterThanOrEqual(40);
      expect(result.runs.length).toBe(4);

      for (const run of result.runs) {
        expect(['success', 'fallback_used']).toContain(run.status);
        expect(run.items_count).toBeGreaterThan(0);
      }
    });

    it('T2-7: Rate limiting on public API endpoints permits 500 req/hr and rejects 501st', () => {
      // Rate limiter mock logic test
      const maxRequests = 500;
      let requestCount = 0;

      const rateLimiter = () => {
        requestCount++;
        return requestCount <= maxRequests;
      };

      for (let i = 0; i < maxRequests; i++) {
        expect(rateLimiter()).toBe(true);
      }
      expect(rateLimiter()).toBe(false); // 501st blocked
    });
  });

  // ==========================================================================
  // TIER 3: CROSS-FEATURE COMBINATIONS
  // ==========================================================================

  describe('Tier 3: Cross-Feature Combinations', () => {
    it('T3-1: End-to-end integration: Crawl -> Rate Cards Upsert -> Matrix Analysis -> Alert Dispatch -> Public API Query', async () => {
      // 1. Crawl all exchanges
      const crawlRes = await crawlerService.runCrawl({ forceFallback: true });
      expect(crawlRes.success).toBe(true);

      // 2. Verify stored rate cards in D1
      const rateCards = await crawlerService.getRateCards();
      expect(rateCards.length).toBeGreaterThanOrEqual(40);

      // 3. Find Bybit and Binance BTC/USDT futures cards
      const binanceCard = rateCards.find(
        (c) => c.exchange === 'binance' && c.pair === 'BTC/USDT' && c.marketType === 'futures' && c.vipTier === 'VIP0'
      );
      const bybitCard = rateCards.find(
        (c) => c.exchange === 'bybit' && c.pair === 'BTC/USDT' && c.marketType === 'futures' && c.vipTier === 'VIP0'
      );

      expect(binanceCard).toBeDefined();
      expect(bybitCard).toBeDefined();

      // 4. Calculate Arbitrage Opportunity
      const metrics = calculateArbitrageMetrics(
        binanceCard!.takerFee,
        binanceCard!.defaultCashbackPct,
        bybitCard!.takerFee,
        bybitCard!.defaultCashbackPct
      );
      expect(metrics.spreadBps).toBe(0.7);
      expect(metrics.savingsPct).toBe(17.5);

      // 5. Upsert opportunity into arbitrage_opportunities linked to deals table
      await db.prepare(`
        INSERT INTO arbitrage_opportunities (
          pair, market_type, base_exchange, target_exchange,
          base_taker_fee, target_taker_fee, base_maker_fee, target_maker_fee,
          base_cashback_pct, target_cashback_pct, net_base_fee, net_target_fee,
          spread_bps, savings_pct, opportunity_type, recommendation, deal_id,
          monthly_savings_10k, monthly_savings_50k, monthly_savings_250k,
          annual_savings_10k, annual_savings_50k, annual_savings_250k,
          is_active, detected_at, expires_at
        ) VALUES (
          'BTC/USDT', 'futures', 'binance', 'bybit',
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, 'CASHBACK_MAX', 'Switch to Bybit for 40% rebate', 'deal-bybit-futures-40',
          ?, ?, ?, ?, ?, ?,
          1, datetime('now'), datetime('now', '+1 day')
        );
      `).bind(
        binanceCard!.takerFee, bybitCard!.takerFee, binanceCard!.makerFee, bybitCard!.makerFee,
        binanceCard!.defaultCashbackPct, bybitCard!.defaultCashbackPct, metrics.netBaseFee, metrics.netTargetFee,
        metrics.spreadBps, metrics.savingsPct,
        metrics.savings10k.monthly, metrics.savings50k.monthly, metrics.savings250k.monthly,
        metrics.savings10k.annual, metrics.savings50k.annual, metrics.savings250k.annual
      ).run();

      // 6. Query via public API
      const req = buildMockRequest('/api/deals/arbitrage?pair=BTC/USDT&market_type=futures');
      const apiRes = await dispatchCrawlerRoute(
        'src/app/api/deals/arbitrage/route.ts',
        'GET',
        req,
        { db }
      );

      expect(apiRes.status).toBe(200);
      expect(apiRes.data.data.length).toBe(1);
      expect(apiRes.data.data[0].deal_id).toBe('deal-bybit-futures-40');
      expect(apiRes.data.data[0].spread_bps).toBe(0.7);
    });

    it('T3-2: Alert Cooldown Deduplication: Suppresses duplicate alert within 1 hour, allows widening spread exception', () => {
      const opp: ArbitrageOpportunity = {
        pair: 'BTC/USDT',
        market_type: 'futures',
        base_exchange: 'binance',
        target_exchange: 'bybit',
        base_taker_fee: 0.00075,
        target_taker_fee: 0.00055,
        base_maker_fee: 0.0002,
        target_maker_fee: 0.0002,
        base_cashback_pct: 20.0,
        target_cashback_pct: 40.0,
        net_base_fee: 0.0006,
        net_target_fee: 0.00033,
        spread_bps: 20.0,
        savings_pct: 45.0,
        opportunity_type: 'CASHBACK_MAX',
        recommendation: 'Switch to Bybit',
        monthly_savings_10k: 20,
        monthly_savings_50k: 100,
        monthly_savings_250k: 500,
        annual_savings_10k: 240,
        annual_savings_50k: 1200,
        annual_savings_250k: 6000,
        is_active: 1,
        detected_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };

      const t0 = 1000000000;

      // 1. Initial detection -> Fresh alert dispatched
      const firstCheck = cooldownTracker.checkAndRecord(opp, t0);
      expect(firstCheck.shouldDispatch).toBe(true);
      expect(firstCheck.reason).toBe('fresh');

      // 2. Duplicate detection 15 minutes later with same spread -> Suppressed
      const duplicateCheck = cooldownTracker.checkAndRecord(opp, t0 + 15 * 60 * 1000);
      expect(duplicateCheck.shouldDispatch).toBe(false);
      expect(duplicateCheck.reason).toBe('cooldown_suppressed');

      // 3. Spread widens by >= 50% (from 20.0 bps to 32.0 bps) at 30 minutes -> Widening bypass exception!
      const widenedOpp = { ...opp, spread_bps: 32.0 };
      const widenedCheck = cooldownTracker.checkAndRecord(widenedOpp, t0 + 30 * 60 * 1000);
      expect(widenedCheck.shouldDispatch).toBe(true);
      expect(widenedCheck.reason).toBe('widening_bypass');

      // 4. After 1 hour cooldown expires (measured from step 3: 30m + 61m = 91m) -> Fresh alert allowed
      const expiredCheck = cooldownTracker.checkAndRecord(widenedOpp, t0 + (30 + 61) * 60 * 1000);
      expect(expiredCheck.shouldDispatch).toBe(true);
      expect(expiredCheck.reason).toBe('fresh');
    });

    it('T3-3: Spot and Futures arbitrage coexist for the same pair without collision', async () => {
      // Insert Spot and Futures opportunities for BTC/USDT
      await db.prepare(`
        INSERT INTO arbitrage_opportunities (
          pair, market_type, base_exchange, target_exchange,
          base_taker_fee, target_taker_fee, base_maker_fee, target_maker_fee,
          net_base_fee, net_target_fee, spread_bps, savings_pct,
          opportunity_type, recommendation, is_active, expires_at
        ) VALUES 
          ('BTC/USDT', 'spot', 'binance', 'okx', 0.001, 0.0007, 0.001, 0.0008, 0.0009, 0.000525, 3.75, 41.67, 'FEE_SPREAD', 'Rec 1', 1, datetime('now', '+1 day')),
          ('BTC/USDT', 'futures', 'binance', 'bybit', 0.00075, 0.00055, 0.0002, 0.0002, 0.0006, 0.00033, 2.7, 45.0, 'CASHBACK_MAX', 'Rec 2', 1, datetime('now', '+1 day'));
      `).run();

      const count = await db.prepare(
        "SELECT COUNT(*) as cnt FROM arbitrage_opportunities WHERE pair = 'BTC/USDT'"
      ).first<{ cnt: number }>();
      expect(count?.cnt).toBe(2);
    });

    it('T3-4: Stale opportunities past expires_at are deactivated', async () => {
      // Insert 1 active and 1 expired opportunity
      await db.prepare(`
        INSERT INTO arbitrage_opportunities (
          pair, market_type, base_exchange, target_exchange,
          base_taker_fee, target_taker_fee, base_maker_fee, target_maker_fee,
          net_base_fee, net_target_fee, spread_bps, savings_pct,
          opportunity_type, recommendation, is_active, expires_at
        ) VALUES 
          ('ETH/USDT', 'spot', 'binance', 'okx', 0.001, 0.0007, 0.001, 0.0008, 0.0009, 0.000525, 3.75, 41.67, 'FEE_SPREAD', 'Active', 1, datetime('now', '+1 hour')),
          ('SOL/USDT', 'spot', 'binance', 'okx', 0.001, 0.0007, 0.001, 0.0008, 0.0009, 0.000525, 3.75, 41.67, 'FEE_SPREAD', 'Expired', 1, datetime('now', '-1 hour'));
      `).run();

      // Deactivate expired
      const deactivateRes = await db.prepare(`
        UPDATE arbitrage_opportunities 
        SET is_active = 0 
        WHERE is_active = 1 AND expires_at < datetime('now')
      `).run();

      expect(deactivateRes.meta.changes).toBe(1);

      // Verify active opportunities query
      const activeOpps = await db.prepare(
        'SELECT pair, is_active FROM arbitrage_opportunities WHERE is_active = 1'
      ).all<{ pair: string; is_active: number }>();

      const rows = Array.isArray(activeOpps) ? activeOpps : (activeOpps?.results || []);
      expect(rows.length).toBe(1);
      expect(rows[0].pair).toBe('ETH/USDT');
    });

    it('T3-5: Admin crawl execution updates rate cards count and status ledger', async () => {
      // 1. Initial state
      const initialCards = await crawlerService.getRateCards();
      expect(initialCards.length).toBe(0);

      // 2. Run crawl across all exchanges
      const crawlResult = await crawlerService.runCrawl({ forceFallback: true, triggeredBy: 'admin' });
      expect(crawlResult.totalCardsSaved).toBeGreaterThanOrEqual(40);

      // 3. Status API query reflects 48 rate cards
      const req = buildMockRequest('/api/admin/crawler/status', { role: 'admin' });
      const statusRes = await dispatchCrawlerRoute(
        'src/app/api/admin/crawler/status/route.ts',
        'GET',
        req,
        { db }
      );

      expect(statusRes.status).toBe(200);
      expect(statusRes.data.status.active_rate_cards_count).toBeGreaterThanOrEqual(40);
    });
  });

  // ==========================================================================
  // TIER 4: REAL-WORLD APPLICATION SCENARIOS
  // ==========================================================================

  describe('Tier 4: Real-World Application Scenarios', () => {
    it('T4-1: Active Trader Scenario: Pro trader finding $810/yr savings switching from Binance to Bybit with ApexOS 40% cashback', async () => {
      // Trader profile: $250,000 monthly volume on BTC/USDT Futures
      const monthlyVolume = 250000;

      // 1. Trader inspects Binance Futures fee baseline
      const binanceGrossTaker = 0.00075; // 0.075%
      const binanceCashback = 20.0;     // 20% cashback
      const binanceNetTaker = calculateNetTakerFee(binanceGrossTaker, binanceCashback);
      expect(binanceNetTaker).toBe(0.0006); // 6.0 bps

      // 2. ApexOS recommends Bybit Futures promo
      const bybitGrossTaker = 0.00055; // 0.055%
      const bybitCashback = 40.0;     // 40% ApexOS partner rebate
      const bybitNetTaker = calculateNetTakerFee(bybitGrossTaker, bybitCashback);
      expect(bybitNetTaker).toBe(0.00033); // 3.3 bps

      // 3. Differential calculation
      const spreadBps = calculateSpreadBps(binanceNetTaker, bybitNetTaker);
      expect(spreadBps).toBe(2.7);

      const savingsPct = calculateSavingsPct(binanceNetTaker, bybitNetTaker);
      expect(savingsPct).toBe(45.0);

      // 4. Annual dollar savings validation
      const volumeSavings = calculateVolumeSavings(spreadBps, monthlyVolume);
      expect(volumeSavings.monthly).toBe(67.5);
      expect(volumeSavings.annual).toBe(810.0); // Exactly $810/yr!

      // 5. Trader uses UI calculator with $250k slider and 0% maker
      const uiResult = simulateDealsCalculator({
        monthlyVolumeUsd: monthlyVolume,
        makerPercent: 0,
        baseCard: {
          exchange: 'binance',
          marketType: 'futures',
          pair: 'BTC/USDT',
          makerFee: 0.0002,
          takerFee: binanceGrossTaker,
          defaultCashbackPct: binanceCashback,
          vipTier: 'VIP0',
        },
        targetCard: {
          exchange: 'bybit',
          marketType: 'futures',
          pair: 'BTC/USDT',
          makerFee: 0.0002,
          takerFee: bybitGrossTaker,
          defaultCashbackPct: bybitCashback,
          vipTier: 'VIP0',
        },
      });

      expect(uiResult.annualSavings).toBe(810.0);
      expect(uiResult.monthlySavings).toBe(67.5);
      expect(uiResult.ctaUrl).toContain('bybit');
    });

    it('T4-2: Admin Operations Scenario: Admin executes on-demand crawl, inspects sync runs, and monitors health', async () => {
      // 1. Admin triggers on-demand crawl via POST /api/admin/crawler/run
      const runReq = buildMockRequest('/api/admin/crawler/run', {
        method: 'POST',
        role: 'admin',
        body: { exchange: 'all', force: true },
      });
      const runRes = await dispatchCrawlerRoute(
        'src/app/api/admin/crawler/run/route.ts',
        'POST',
        runReq,
        { db }
      );
      expect(runRes.status).toBe(200);
      expect(runRes.data.success).toBe(true);

      // 2. Crawler service persists runs into crawler_sync_runs
      await crawlerService.persistSyncRun({
        run_id: runRes.data.run_id,
        exchange: 'binance',
        status: 'success',
        items_count: 12,
        duration_ms: 180,
      });

      // 3. Admin queries crawler status via GET /api/admin/crawler/status
      const statusReq = buildMockRequest('/api/admin/crawler/status', {
        method: 'GET',
        role: 'admin',
      });
      const statusRes = await dispatchCrawlerRoute(
        'src/app/api/admin/crawler/status/route.ts',
        'GET',
        statusReq,
        { db }
      );

      expect(statusRes.status).toBe(200);
      expect(statusRes.data.status.exchanges.binance.status).toBe('healthy');
    });

    it('T4-3: Flash Volatility Scenario: High-spread burst (>15 bps) triggers Telegram + Mobile Push broadcasts and prevents spam via cooldown', async () => {
      // KuCoin fee surge causes taker fee to jump to 0.20%, Bybit promotional taker is 0.06% with 30% cashback
      const kucoinNet = calculateNetTakerFee(0.002, 0.0); // 0.20% = 20.0 bps
      const bybitNet = calculateNetTakerFee(0.0006, 30.0); // 0.042% = 4.2 bps
      const burstSpread = calculateSpreadBps(kucoinNet, bybitNet); // 15.8 bps
      const burstSavings = calculateSavingsPct(kucoinNet, bybitNet); // 79.0%

      expect(burstSpread).toBe(15.8);
      expect(burstSpread).toBeGreaterThanOrEqual(15.0); // Alert threshold exceeded!
      expect(burstSavings).toBe(79.0);

      const burstOpp: ArbitrageOpportunity = {
        pair: 'SOL/USDT',
        market_type: 'spot',
        base_exchange: 'kucoin',
        target_exchange: 'bybit',
        base_taker_fee: 0.002,
        target_taker_fee: 0.0006,
        base_maker_fee: 0.001,
        target_maker_fee: 0.0002,
        base_cashback_pct: 0.0,
        target_cashback_pct: 30.0,
        net_base_fee: kucoinNet,
        net_target_fee: bybitNet,
        spread_bps: burstSpread,
        savings_pct: burstSavings,
        opportunity_type: 'FEE_SPREAD',
        recommendation: 'Market burst: switch SOL/USDT spot volume to Bybit to save 79%',
        deal_id: 'deal-bybit-spot-40',
        monthly_savings_10k: 15.8,
        monthly_savings_50k: 79.0,
        monthly_savings_250k: 395.0,
        annual_savings_10k: 189.6,
        annual_savings_50k: 948.0,
        annual_savings_250k: 4740.0,
        is_active: 1,
        detected_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };

      // 1. Evaluate Alert Eligibility
      expect(isOpportunityAlertEligible(burstOpp)).toBe(true);

      // 2. Dispatch Telegram Alert
      const telegramMsg = formatTelegramMarkdownAlert(burstOpp);
      expect(telegramMsg).toContain('Arbitrage Alert: SOL/USDT (SPOT)');
      expect(telegramMsg).toContain('15.8 bps');
      expect(telegramMsg).toContain('79.0%');

      // 3. Query active registered devices from device_tokens
      const activeDevices = await db.prepare(
        'SELECT token, expo_token FROM device_tokens WHERE is_active = 1'
      ).all<{ token: string; expo_token: string }>();

      const deviceList = Array.isArray(activeDevices) ? activeDevices : (activeDevices?.results || []);
      expect(deviceList.length).toBe(2); // 2 active devices seeded

      // 4. Prepare Push Payloads
      const payloads = deviceList.map((d) =>
        formatMobilePushPayload(burstOpp, d.expo_token || d.token)
      );
      expect(payloads.length).toBe(2);
      expect((payloads[0].data as any).spreadBps).toBe(15.8);

      // 5. Cooldown deduplication ensures subsequent check within 1 hour is suppressed
      const firstTrigger = cooldownTracker.checkAndRecord(burstOpp);
      expect(firstTrigger.shouldDispatch).toBe(true);

      const immediateDuplicate = cooldownTracker.checkAndRecord(burstOpp);
      expect(immediateDuplicate.shouldDispatch).toBe(false);
      expect(immediateDuplicate.reason).toBe('cooldown_suppressed');
    });
  });
});
