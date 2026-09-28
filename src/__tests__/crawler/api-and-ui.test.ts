/**
 * src/__tests__/crawler/api-and-ui.test.ts
 *
 * Dedicated M4 Test Suite:
 * - F5: Public Arbitrage API
 * - F6: Admin Crawler Management
 * - F7: Deals UI Logic
 */

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import type { D1Database } from '@/lib/db';
import type { ArbitrageOpportunity, RateCard } from '@/types/arbitrage';
import {
  initializeTestDatabase,
  dispatchCrawlerRoute,
  buildMockRequest,
  simulateDealsCalculator,
} from './crawler-test-harness';
import { calculateBlendedSavings } from '@/components/deals/ArbitrageFinder';

describe('Cross-Exchange Arbitrage & High-Yield Deal Crawler — API & UI Tests', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    const initialized = initializeTestDatabase();
    sqlite = initialized.sqlite;
    db = initialized.db;

    // Seed test opportunities into DB
    db.prepare(`
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
        27.0, 45.0, 'CASHBACK_MAX', 'Switch futures taker orders to Bybit for 45.0% lower net fees and 40% Apex cashback.', 'deal-bybit-futures-40',
        2.7, 13.5, 67.5, 32.4, 162.0, 810.0,
        1, datetime('now'), datetime('now', '+1 day')
      )
    `).run();

    db.prepare(`
      INSERT INTO arbitrage_opportunities (
        pair, market_type, base_exchange, target_exchange,
        base_taker_fee, target_taker_fee, base_maker_fee, target_maker_fee,
        base_cashback_pct, target_cashback_pct, net_base_fee, net_target_fee,
        spread_bps, savings_pct, opportunity_type, recommendation, deal_id,
        monthly_savings_10k, monthly_savings_50k, monthly_savings_250k,
        annual_savings_10k, annual_savings_50k, annual_savings_250k,
        is_active, detected_at, expires_at
      ) VALUES (
        'ETH/USDT', 'spot', 'binance', 'okx',
        0.001, 0.0008, 0.001, 0.0008,
        10.0, 30.0, 0.0009, 0.00056,
        34.0, 37.8, 'FEE_SPREAD', 'Trade ETH/USDT on OKX for 34 bps tighter effective fee spread.', 'deal-okx-spot-30',
        2.0, 10.0, 50.0, 24.0, 120.0, 600.0,
        1, datetime('now'), datetime('now', '+1 day')
      )
    `).run();
  });

  // ==========================================================================
  // F5: Public Arbitrage API
  // ==========================================================================
  describe('F5: Public Arbitrage API', () => {
    it('returns 200 with paginated active arbitrage opportunities', async () => {
      const req = buildMockRequest('/api/deals/arbitrage?page=1&limit=10');
      const res = await dispatchCrawlerRoute(
        'src/app/api/deals/arbitrage/route.ts',
        'GET',
        req,
        { db }
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);
      expect(res.data.data.length).toBeGreaterThanOrEqual(2);
      expect(res.data.pagination).toBeDefined();
      expect(res.data.pagination.page).toBe(1);
      expect(res.data.pagination.limit).toBe(10);
      expect(res.data.pagination.total).toBeGreaterThanOrEqual(2);
    });

    it('filters opportunities by trading pair (BTC/USDT)', async () => {
      const req = buildMockRequest('/api/deals/arbitrage?pair=BTC/USDT');
      const res = await dispatchCrawlerRoute(
        'src/app/api/deals/arbitrage/route.ts',
        'GET',
        req,
        { db }
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.every((o: any) => o.pair === 'BTC/USDT')).toBe(true);
    });

    it('filters opportunities by market_type (spot vs futures)', async () => {
      const reqFutures = buildMockRequest('/api/deals/arbitrage?market_type=futures');
      const resFutures = await dispatchCrawlerRoute(
        'src/app/api/deals/arbitrage/route.ts',
        'GET',
        reqFutures,
        { db }
      );

      expect(resFutures.status).toBe(200);
      expect(resFutures.data.data.every((o: any) => o.market_type === 'futures')).toBe(true);

      const reqSpot = buildMockRequest('/api/deals/arbitrage?market_type=spot');
      const resSpot = await dispatchCrawlerRoute(
        'src/app/api/deals/arbitrage/route.ts',
        'GET',
        reqSpot,
        { db }
      );

      expect(resSpot.status).toBe(200);
      expect(resSpot.data.data.every((o: any) => o.market_type === 'spot')).toBe(true);
    });

    it('filters opportunities by min_spread threshold', async () => {
      const reqLow = buildMockRequest('/api/deals/arbitrage?min_spread=30');
      const resLow = await dispatchCrawlerRoute(
        'src/app/api/deals/arbitrage/route.ts',
        'GET',
        reqLow,
        { db }
      );

      expect(resLow.status).toBe(200);
      expect(resLow.data.data.every((o: any) => o.spread_bps >= 30)).toBe(true);

      const reqHigh = buildMockRequest('/api/deals/arbitrage?min_spread=100');
      const resHigh = await dispatchCrawlerRoute(
        'src/app/api/deals/arbitrage/route.ts',
        'GET',
        reqHigh,
        { db }
      );

      expect(resHigh.status).toBe(200);
      expect(resHigh.data.data.length).toBe(0);
    });

    it('filters opportunities by exchange', async () => {
      const reqBybit = buildMockRequest('/api/deals/arbitrage?exchange=bybit');
      const resBybit = await dispatchCrawlerRoute(
        'src/app/api/deals/arbitrage/route.ts',
        'GET',
        reqBybit,
        { db }
      );

      expect(resBybit.status).toBe(200);
      expect(
        resBybit.data.data.every(
          (o: any) => o.base_exchange === 'bybit' || o.target_exchange === 'bybit'
        )
      ).toBe(true);
    });

    it('handles pagination with limit and offset', async () => {
      const reqPage2 = buildMockRequest('/api/deals/arbitrage?page=2&limit=1');
      const resPage2 = await dispatchCrawlerRoute(
        'src/app/api/deals/arbitrage/route.ts',
        'GET',
        reqPage2,
        { db }
      );

      expect(resPage2.status).toBe(200);
      expect(resPage2.data.pagination.page).toBe(2);
      expect(resPage2.data.pagination.limit).toBe(1);
      expect(resPage2.data.data.length).toBeLessThanOrEqual(1);
    });
  });

  // ==========================================================================
  // F6: Admin Crawler Management
  // ==========================================================================
  describe('F6: Admin Crawler Management', () => {
    describe('POST /api/admin/crawler/run', () => {
      it('rejects unauthenticated requests with HTTP 401', async () => {
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

      it('rejects non-admin users with HTTP 403', async () => {
        const req = buildMockRequest('/api/admin/crawler/run', {
          method: 'POST',
          role: 'user',
        });
        const res = await dispatchCrawlerRoute(
          'src/app/api/admin/crawler/run/route.ts',
          'POST',
          req,
          { db }
        );

        expect(res.status).toBe(403);
      });

      it('triggers full crawl successfully for admin users', async () => {
        const req = buildMockRequest('/api/admin/crawler/run', {
          method: 'POST',
          role: 'admin',
          body: { force_refresh: true },
        });
        const res = await dispatchCrawlerRoute(
          'src/app/api/admin/crawler/run/route.ts',
          'POST',
          req,
          { db }
        );

        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
        const itemsSynced = res.data.items_synced ?? res.data.data?.rate_cards_synced;
        expect(itemsSynced).toBeGreaterThan(0);
        const runId = res.data.run_id ?? res.data.data?.run_id;
        expect(runId).toBeDefined();
      });

      it('triggers crawl for a single exchange (binance)', async () => {
        const req = buildMockRequest('/api/admin/crawler/run', {
          method: 'POST',
          role: 'admin',
          body: { exchanges: ['binance'], force_refresh: true },
        });
        const res = await dispatchCrawlerRoute(
          'src/app/api/admin/crawler/run/route.ts',
          'POST',
          req,
          { db }
        );

        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
        const exchanges = res.data.exchanges ?? res.data.data?.crawled_exchanges;
        expect(exchanges).toBeDefined();
        expect(Array.isArray(exchanges)).toBe(true);
      });
    });

    describe('GET /api/admin/crawler/status', () => {
      it('rejects unauthenticated requests with HTTP 401', async () => {
        const req = buildMockRequest('/api/admin/crawler/status', {
          method: 'GET',
          role: 'unauthenticated',
        });
        const res = await dispatchCrawlerRoute(
          'src/app/api/admin/crawler/status/route.ts',
          'GET',
          req,
          { db }
        );

        expect(res.status).toBe(401);
      });

      it('rejects non-admin users with HTTP 403', async () => {
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

      it('returns operational status and exchange metrics for admin users', async () => {
        // First record a sync run
        db.prepare(`
          INSERT INTO crawler_sync_runs (run_id, exchange, status, items_count, duration_ms, created_at)
          VALUES ('run-test-1', 'binance', 'success', 8, 120, ?)
        `).bind(new Date().toISOString()).run();

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
        const statusObj = res.data.status ?? res.data.data?.status;
        expect(statusObj).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // F7: Deals UI Logic
  // ==========================================================================
  describe('F7: Deals UI Logic', () => {
    const testOpportunity: ArbitrageOpportunity = {
      id: 'test-bybit-binance',
      pair: 'BTC/USDT',
      market_type: 'futures',
      base_exchange: 'binance',
      target_exchange: 'bybit',
      base_maker_fee: 0.0002,
      base_taker_fee: 0.00075,
      base_cashback_pct: 20.0,
      target_maker_fee: 0.0002,
      target_taker_fee: 0.00055,
      target_cashback_pct: 40.0,
      net_base_taker_fee: 0.0006,
      net_target_taker_fee: 0.00033,
      spread_bps: 2.7,
      savings_pct: 45.0,
      annual_savings_estimate: 810.0,
      opportunity_type: 'CASHBACK_MAX',
      recommendation: 'Switch futures taker orders to Bybit.',
      deal_id: 'deal-bybit-futures-40',
      is_active: true,
      detected_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    };

    it('calculates monthly and annual savings for volume milestones ($10k, $50k, $250k, $1M)', () => {
      // 100% taker (makerPercent = 0)
      const res10k = calculateBlendedSavings(testOpportunity, 10000, 0);
      expect(res10k.monthlySavings).toBe(2.7);
      expect(res10k.annualSavings).toBe(32.4);

      const res50k = calculateBlendedSavings(testOpportunity, 50000, 0);
      expect(res50k.monthlySavings).toBe(13.5);
      expect(res50k.annualSavings).toBe(162.0);

      const res250k = calculateBlendedSavings(testOpportunity, 250000, 0);
      expect(res250k.monthlySavings).toBe(67.5);
      expect(res250k.annualSavings).toBe(810.0);

      const res1M = calculateBlendedSavings(testOpportunity, 1000000, 0);
      expect(res1M.monthlySavings).toBe(270.0);
      expect(res1M.annualSavings).toBe(3240.0);
    });

    it('verifies standard active trader $810/yr benchmark savings scenario (Bybit vs Binance)', () => {
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

      const result = simulateDealsCalculator({
        monthlyVolumeUsd: 250000,
        makerPercent: 0,
        baseCard,
        targetCard,
      });

      expect(result.monthlySavings).toBe(67.5);
      expect(result.annualSavings).toBe(810.0);
      expect(result.netSpreadBps).toBe(2.7);
    });

    it('computes blended savings when maker/taker ratio is adjusted (20% maker)', () => {
      const resBlended = calculateBlendedSavings(testOpportunity, 50000, 20);
      expect(resBlended.blendedBaseFee).toBeLessThan(resBlended.blendedTargetFee + 1);
      expect(resBlended.netSpreadBps).toBeGreaterThan(0);
      expect(resBlended.monthlySavings).toBeGreaterThan(0);
      expect(resBlended.annualSavings).toBeCloseTo(resBlended.monthlySavings * 12, 1);
    });

    it('assigns correct badge variants based on spread and savings', () => {
      // testOpportunity with netSpread >= 25 bps -> 'super'
      const highYieldOpp: ArbitrageOpportunity = {
        ...testOpportunity,
        base_taker_fee: 0.0035,
        target_taker_fee: 0.0005,
        base_cashback_pct: 0,
        target_cashback_pct: 0,
      };
      const resSuper = calculateBlendedSavings(highYieldOpp, 50000, 0);
      expect(resSuper.badgeVariant).toBe('super');

      // Opportunity with spread between 15 and 25 bps -> 'success'
      const moderateOpp: ArbitrageOpportunity = {
        ...testOpportunity,
        base_taker_fee: 0.0020,
        target_taker_fee: 0.0004,
        base_cashback_pct: 0,
        target_cashback_pct: 0,
      };
      const resSuccess = calculateBlendedSavings(moderateOpp, 50000, 0);
      expect(resSuccess.badgeVariant).toBe('success');

      // Opportunity with spread < 15 bps -> 'neutral'
      const resNeutral = calculateBlendedSavings(testOpportunity, 50000, 0);
      expect(resNeutral.badgeVariant).toBe('neutral');
    });

    it('handles negative or zero spread cleanly with zero savings', () => {
      const invertedOpp: ArbitrageOpportunity = {
        ...testOpportunity,
        base_taker_fee: 0.0003,
        target_taker_fee: 0.0008,
      };
      const resInverted = calculateBlendedSavings(invertedOpp, 50000, 0);
      expect(resInverted.monthlySavings).toBe(0);
      expect(resInverted.annualSavings).toBe(0);
      expect(resInverted.badgeVariant).toBe('neutral');
    });

    it('clamps maker percentage to [0, 100]', () => {
      const resNegative = calculateBlendedSavings(testOpportunity, 10000, -50);
      const resZero = calculateBlendedSavings(testOpportunity, 10000, 0);
      expect(resNegative.monthlySavings).toBe(resZero.monthlySavings);

      const resExcess = calculateBlendedSavings(testOpportunity, 10000, 150);
      const resHundred = calculateBlendedSavings(testOpportunity, 10000, 100);
      expect(resExcess.monthlySavings).toBe(resHundred.monthlySavings);
    });
  });
});
