/**
 * Unit & Integration Tests for ArbitrageEngine
 * Module: src/lib/arbitrage/arbitrage-engine.ts
 */

import Database from 'better-sqlite3';
import type { D1Database } from '@/lib/db';
import type {
  ExchangeId,
  MarketType,
  ArbitrageOpportunity,
} from '@/types/arbitrage';
import { ArbitrageEngine } from '../arbitrage-engine';
import { initializeTestDatabase } from '../../../__tests__/crawler/crawler-test-harness';

describe('ArbitrageEngine — Unit & Integration Test Suite', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  let engine: ArbitrageEngine;

  beforeEach(() => {
    const env = initializeTestDatabase();
    sqlite = env.sqlite;
    db = env.db;
    engine = new ArbitrageEngine(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  // --------------------------------------------------------------------------
  // analyzeOpportunities
  // --------------------------------------------------------------------------
  describe('analyzeOpportunities', () => {
    it('returns empty array when exchange_rate_cards table has no active records', async () => {
      const opps = await engine.analyzeOpportunities();
      expect(opps).toEqual([]);
    });

    it('evaluates rate cards and generates profitable pairwise opportunities across exchanges', async () => {
      // Seed rate cards for BTC/USDT futures: Binance vs Bybit
      await db.prepare(`
        INSERT INTO exchange_rate_cards (
          exchange, market_type, pair, maker_fee, taker_fee, default_cashback_pct, vip_tier, is_active
        ) VALUES 
          ('binance', 'futures', 'BTC/USDT', 0.0002, 0.00075, 20.0, 'VIP0', 1),
          ('bybit', 'futures', 'BTC/USDT', 0.0002, 0.00055, 40.0, 'VIP0', 1);
      `).run();

      const opps = await engine.analyzeOpportunities();

      expect(opps.length).toBe(1);
      const opp = opps[0];
      expect(opp.pair).toBe('BTC/USDT');
      expect(opp.market_type).toBe('futures');
      expect(opp.base_exchange).toBe('binance');
      expect(opp.target_exchange).toBe('bybit');
      expect(opp.spread_bps).toBe(2.7);
      expect(opp.savings_pct).toBe(45.0);
      expect(opp.opportunity_type).toBe('CASHBACK_MAX');
      expect(opp.annual_savings_250k).toBe(810.0);
      expect(opp.deal_id).toBe('deal-bybit-futures-40');
      expect(opp.recommendation).toContain('Maximize Yield');
      expect(opp.is_active).toBe(1);
    });

    it('filters opportunities by pairs and marketTypes', async () => {
      // Seed rate cards for multiple pairs and markets
      await db.prepare(`
        INSERT INTO exchange_rate_cards (
          exchange, market_type, pair, maker_fee, taker_fee, default_cashback_pct, vip_tier, is_active
        ) VALUES 
          ('binance', 'futures', 'BTC/USDT', 0.0002, 0.00075, 20.0, 'VIP0', 1),
          ('bybit', 'futures', 'BTC/USDT', 0.0002, 0.00055, 40.0, 'VIP0', 1),
          ('binance', 'spot', 'ETH/USDT', 0.001, 0.0010, 10.0, 'VIP0', 1),
          ('okx', 'spot', 'ETH/USDT', 0.0008, 0.0007, 25.0, 'VIP0', 1);
      `).run();

      // Query only BTC/USDT
      const btcOnly = await engine.analyzeOpportunities({ pairs: ['BTC/USDT'] });
      expect(btcOnly.length).toBe(1);
      expect(btcOnly[0].pair).toBe('BTC/USDT');

      // Query only spot
      const spotOnly = await engine.analyzeOpportunities({ marketTypes: ['spot'] });
      expect(spotOnly.length).toBe(1);
      expect(spotOnly[0].pair).toBe('ETH/USDT');
      expect(spotOnly[0].market_type).toBe('spot');
    });

    it('discards non-profitable pairs (spread <= 0)', async () => {
      // Bybit taker is more expensive than Binance -> no reverse opportunity generated
      await db.prepare(`
        INSERT INTO exchange_rate_cards (
          exchange, market_type, pair, maker_fee, taker_fee, default_cashback_pct, vip_tier, is_active
        ) VALUES 
          ('binance', 'futures', 'BTC/USDT', 0.0002, 0.00075, 20.0, 'VIP0', 1),
          ('bybit', 'futures', 'BTC/USDT', 0.0002, 0.00055, 40.0, 'VIP0', 1);
      `).run();

      const opps = await engine.analyzeOpportunities();
      const reverse = opps.find(
        (o) => o.base_exchange === 'bybit' && o.target_exchange === 'binance'
      );
      expect(reverse).toBeUndefined();
    });

    it('sets expires_at respecting ttlHours option', async () => {
      await db.prepare(`
        INSERT INTO exchange_rate_cards (
          exchange, market_type, pair, maker_fee, taker_fee, default_cashback_pct, vip_tier, is_active
        ) VALUES 
          ('binance', 'futures', 'BTC/USDT', 0.0002, 0.00075, 20.0, 'VIP0', 1),
          ('bybit', 'futures', 'BTC/USDT', 0.0002, 0.00055, 40.0, 'VIP0', 1);
      `).run();

      const opps = await engine.analyzeOpportunities({ ttlHours: 12 });
      expect(opps.length).toBe(1);

      const detectedTime = new Date(opps[0].detected_at).getTime();
      const expiresTime = new Date(opps[0].expires_at).getTime();
      const diffHours = (expiresTime - detectedTime) / (3600 * 1000);
      expect(Math.round(diffHours)).toBe(12);
    });
  });

  // --------------------------------------------------------------------------
  // upsertOpportunities
  // --------------------------------------------------------------------------
  describe('upsertOpportunities', () => {
    it('returns 0 when opportunities array is empty', async () => {
      const count = await engine.upsertOpportunities([]);
      expect(count).toBe(0);
    });

    it('inserts opportunities and updates them idempotently on conflict', async () => {
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 86400000).toISOString();

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
        spread_bps: 2.7,
        savings_pct: 45.0,
        opportunity_type: 'CASHBACK_MAX',
        recommendation: 'Initial recommendation',
        deal_id: 'deal-bybit-futures-40',
        monthly_savings_10k: 2.7,
        monthly_savings_50k: 13.5,
        monthly_savings_250k: 67.5,
        annual_savings_10k: 32.4,
        annual_savings_50k: 162.0,
        annual_savings_250k: 810.0,
        is_active: 1,
        detected_at: now,
        expires_at: expires,
      };

      // 1. First insert
      const insertCount = await engine.upsertOpportunities([opp]);
      expect(insertCount).toBe(1);

      const saved = await db.prepare(
        "SELECT * FROM arbitrage_opportunities WHERE pair = 'BTC/USDT'"
      ).first<ArbitrageOpportunity>();
      expect(saved?.spread_bps).toBe(2.7);
      expect(saved?.recommendation).toBe('Initial recommendation');

      // 2. Second upsert with updated spread
      const updatedOpp: ArbitrageOpportunity = {
        ...opp,
        spread_bps: 3.5,
        savings_pct: 50.0,
        recommendation: 'Updated recommendation with wider spread',
      };

      const updateCount = await engine.upsertOpportunities([updatedOpp]);
      expect(updateCount).toBe(1);

      const count = await db.prepare(
        "SELECT COUNT(*) as cnt FROM arbitrage_opportunities WHERE pair = 'BTC/USDT'"
      ).first<{ cnt: number }>();
      expect(count?.cnt).toBe(1); // No duplicate rows created!

      const reSaved = await db.prepare(
        "SELECT * FROM arbitrage_opportunities WHERE pair = 'BTC/USDT'"
      ).first<ArbitrageOpportunity>();
      expect(reSaved?.spread_bps).toBe(3.5);
      expect(reSaved?.savings_pct).toBe(50.0);
      expect(reSaved?.recommendation).toBe('Updated recommendation with wider spread');
    });

    it('handles batch chunking when opportunities list exceeds 50 items', async () => {
      const opps: ArbitrageOpportunity[] = [];
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 86400000).toISOString();

      // Create 55 items across synthetic pairs
      for (let i = 1; i <= 55; i++) {
        opps.push({
          pair: `PAIR${i}/USDT`,
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
          recommendation: `Rec ${i}`,
          deal_id: null,
          monthly_savings_10k: 2.7,
          monthly_savings_50k: 13.5,
          monthly_savings_250k: 67.5,
          annual_savings_10k: 32.4,
          annual_savings_50k: 162.0,
          annual_savings_250k: 810.0,
          is_active: 1,
          detected_at: now,
          expires_at: expires,
        });
      }

      const count = await engine.upsertOpportunities(opps);
      expect(count).toBe(55);

      const dbCount = await db.prepare(
        'SELECT COUNT(*) as cnt FROM arbitrage_opportunities'
      ).first<{ cnt: number }>();
      expect(dbCount?.cnt).toBe(55);
    });
  });

  // --------------------------------------------------------------------------
  // deactivateExpired
  // --------------------------------------------------------------------------
  describe('deactivateExpired', () => {
    it('sets is_active = 0 for expired opportunities and leaves active records alone', async () => {
      await db.prepare(`
        INSERT INTO arbitrage_opportunities (
          pair, market_type, base_exchange, target_exchange,
          base_taker_fee, target_taker_fee, base_maker_fee, target_maker_fee,
          net_base_fee, net_target_fee, spread_bps, savings_pct,
          opportunity_type, recommendation, is_active, expires_at
        ) VALUES 
          ('ETH/USDT', 'spot', 'binance', 'okx', 0.001, 0.0007, 0.001, 0.0008, 0.0009, 0.000525, 3.75, 41.67, 'FEE_SPREAD', 'Active', 1, datetime('now', '+2 hours')),
          ('SOL/USDT', 'spot', 'binance', 'okx', 0.001, 0.0007, 0.001, 0.0008, 0.0009, 0.000525, 3.75, 41.67, 'FEE_SPREAD', 'Expired', 1, datetime('now', '-2 hours'));
      `).run();

      const deactivatedCount = await engine.deactivateExpired();
      expect(deactivatedCount).toBe(1);

      const active = await db.prepare(
        'SELECT pair FROM arbitrage_opportunities WHERE is_active = 1'
      ).all<{ pair: string }>();
      const rows = Array.isArray(active) ? active : (active?.results || []);
      expect(rows.length).toBe(1);
      expect(rows[0].pair).toBe('ETH/USDT');
    });
  });

  // --------------------------------------------------------------------------
  // queryOpportunities
  // --------------------------------------------------------------------------
  describe('queryOpportunities', () => {
    beforeEach(async () => {
      await db.prepare(`
        INSERT INTO arbitrage_opportunities (
          pair, market_type, base_exchange, target_exchange,
          base_taker_fee, target_taker_fee, base_maker_fee, target_maker_fee,
          base_cashback_pct, target_cashback_pct, net_base_fee, net_target_fee,
          spread_bps, savings_pct, opportunity_type, recommendation, deal_id,
          monthly_savings_10k, monthly_savings_50k, monthly_savings_250k,
          annual_savings_10k, annual_savings_50k, annual_savings_250k,
          is_active, detected_at, expires_at
        ) VALUES 
          ('BTC/USDT', 'futures', 'binance', 'bybit', 0.00075, 0.00055, 0.0002, 0.0002, 20.0, 40.0, 0.0006, 0.00033, 2.7, 45.0, 'CASHBACK_MAX', 'Bybit Futures', 'deal-bybit-futures-40', 2.7, 13.5, 67.5, 32.4, 162.0, 810.0, 1, datetime('now'), datetime('now', '+1 day')),
          ('ETH/USDT', 'spot', 'binance', 'okx', 0.001, 0.0007, 0.001, 0.0008, 10.0, 25.0, 0.0009, 0.000525, 3.75, 41.67, 'FEE_SPREAD', 'OKX Spot', 'deal-okx-spot-30', 3.75, 18.75, 93.75, 45.0, 225.0, 1125.0, 1, datetime('now'), datetime('now', '+1 day')),
          ('SOL/USDT', 'spot', 'kucoin', 'bybit', 0.001, 0.0004, 0.001, 0.0, 0.0, 35.0, 0.001, 0.00026, 7.4, 74.0, 'VIP_PROMOTION', 'Bybit VIP', 'deal-bybit-spot-40', 7.4, 37.0, 185.0, 88.8, 444.0, 2220.0, 1, datetime('now'), datetime('now', '+1 day'));
      `).run();
    });

    it('returns paginated active opportunities with total counts', async () => {
      const res = await engine.queryOpportunities({ page: 1, limit: 2 });
      expect(res.total).toBe(3);
      expect(res.data.length).toBe(2);
      expect(res.page).toBe(1);
      expect(res.limit).toBe(2);
      expect(res.totalPages).toBe(2);
      // Ordered by spread_bps descending: SOL (7.4) -> ETH (3.75)
      expect(res.data[0].pair).toBe('SOL/USDT');
      expect(res.data[1].pair).toBe('ETH/USDT');
    });

    it('filters opportunities by pair (case-insensitive)', async () => {
      const res = await engine.queryOpportunities({ pair: 'btc/usdt' });
      expect(res.total).toBe(1);
      expect(res.data[0].pair).toBe('BTC/USDT');
    });

    it('filters opportunities by market_type', async () => {
      const resFutures = await engine.queryOpportunities({ market_type: 'futures' });
      expect(resFutures.total).toBe(1);
      expect(resFutures.data[0].pair).toBe('BTC/USDT');

      const resSpot = await engine.queryOpportunities({ market_type: 'spot' });
      expect(resSpot.total).toBe(2);
    });

    it('filters opportunities by min_spread_bps', async () => {
      const res = await engine.queryOpportunities({ min_spread_bps: 5.0 });
      expect(res.total).toBe(1);
      expect(res.data[0].pair).toBe('SOL/USDT');
      expect(res.data[0].spread_bps).toBe(7.4);
    });

    it('filters opportunities by opportunity_type', async () => {
      const res = await engine.queryOpportunities({ opportunity_type: 'VIP_PROMOTION' });
      expect(res.total).toBe(1);
      expect(res.data[0].pair).toBe('SOL/USDT');
    });

    it('filters opportunities by target_exchange', async () => {
      const res = await engine.queryOpportunities({ target_exchange: 'okx' });
      expect(res.total).toBe(1);
      expect(res.data[0].pair).toBe('ETH/USDT');
    });
  });

  // --------------------------------------------------------------------------
  // getMatrix & getArbitrageMatrix
  // --------------------------------------------------------------------------
  describe('getMatrix', () => {
    it('generates a 2D cross-exchange comparison matrix with null diagonals and active cells', async () => {
      await db.prepare(`
        INSERT INTO arbitrage_opportunities (
          pair, market_type, base_exchange, target_exchange,
          base_taker_fee, target_taker_fee, base_maker_fee, target_maker_fee,
          base_cashback_pct, target_cashback_pct, net_base_fee, net_target_fee,
          spread_bps, savings_pct, opportunity_type, recommendation, deal_id,
          monthly_savings_10k, monthly_savings_50k, monthly_savings_250k,
          annual_savings_10k, annual_savings_50k, annual_savings_250k,
          is_active, detected_at, expires_at
        ) VALUES 
          ('BTC/USDT', 'futures', 'binance', 'bybit', 0.00075, 0.00055, 0.0002, 0.0002, 20.0, 40.0, 0.0006, 0.00033, 2.7, 45.0, 'CASHBACK_MAX', 'Switch to Bybit', 'deal-bybit-futures-40', 2.7, 13.5, 67.5, 32.4, 162.0, 810.0, 1, datetime('now'), datetime('now', '+1 day'));
      `).run();

      const matrixRes = await engine.getMatrix('BTC/USDT', 'futures');

      expect(matrixRes.pair).toBe('BTC/USDT');
      expect(matrixRes.marketType).toBe('futures');
      expect(matrixRes.exchanges).toEqual(['binance', 'bybit', 'okx', 'kucoin']);

      // Diagonals must be null
      expect(matrixRes.matrix.binance.binance).toBeNull();
      expect(matrixRes.matrix.bybit.bybit).toBeNull();
      expect(matrixRes.matrix.okx.okx).toBeNull();
      expect(matrixRes.matrix.kucoin.kucoin).toBeNull();

      // Binance -> Bybit cell populated
      const cell = matrixRes.matrix.binance.bybit;
      expect(cell).not.toBeNull();
      expect(cell?.baseExchange).toBe('binance');
      expect(cell?.targetExchange).toBe('bybit');
      expect(cell?.spreadBps).toBe(2.7);
      expect(cell?.savingsPct).toBe(45.0);
      expect(cell?.annualSavings250k).toBe(810.0);
      expect(cell?.opportunityType).toBe('CASHBACK_MAX');
      expect(cell?.dealId).toBe('deal-bybit-futures-40');

      // Unmatched cells remain null
      expect(matrixRes.matrix.bybit.binance).toBeNull();
      expect(matrixRes.matrix.okx.kucoin).toBeNull();
    });

    it('getArbitrageMatrix alias delegates to getMatrix', async () => {
      const spy = jest.spyOn(engine, 'getMatrix');
      await engine.getArbitrageMatrix('BTC/USDT', 'futures');
      expect(spy).toHaveBeenCalledWith('BTC/USDT', 'futures', undefined);
    });
  });

  // --------------------------------------------------------------------------
  // formatRecommendation
  // --------------------------------------------------------------------------
  describe('formatRecommendation', () => {
    it('formats recommendation message for VIP_PROMOTION', () => {
      const rec = engine.formatRecommendation({
        pair: 'SOL/USDT',
        marketType: 'spot',
        baseExchange: 'kucoin',
        targetExchange: 'bybit',
        metrics: {
          netBaseFee: 0.001,
          netTargetFee: 0.00026,
          spreadBps: 7.4,
          savingsPct: 74.0,
          cashbackAdvantage: 35.0,
          savings10k: { monthly: 7.4, annual: 88.8 },
          savings50k: { monthly: 37.0, annual: 444.0 },
          savings250k: { monthly: 185.0, annual: 2220.0 },
        },
        oppType: 'VIP_PROMOTION',
      });

      expect(rec).toContain('Exclusive VIP promo:');
      expect(rec).toContain('BYBIT');
      expect(rec).toContain('save 74%');
      expect(rec).toContain('$2220/yr on $250k vol');
    });

    it('formats recommendation message for CASHBACK_MAX', () => {
      const rec = engine.formatRecommendation({
        pair: 'BTC/USDT',
        marketType: 'futures',
        baseExchange: 'binance',
        targetExchange: 'bybit',
        metrics: {
          netBaseFee: 0.0006,
          netTargetFee: 0.00033,
          spreadBps: 2.7,
          savingsPct: 45.0,
          cashbackAdvantage: 20.0,
          savings10k: { monthly: 2.7, annual: 32.4 },
          savings50k: { monthly: 13.5, annual: 162.0 },
          savings250k: { monthly: 67.5, annual: 810.0 },
        },
        oppType: 'CASHBACK_MAX',
      });

      expect(rec).toContain('Maximize Yield: Switch from BINANCE to BYBIT');
      expect(rec).toContain('+20% ApexOS cashback boost');
      expect(rec).toContain('2.7 bps');
      expect(rec).toContain('45% net reduction');
    });

    it('formats recommendation message for FEE_SPREAD', () => {
      const rec = engine.formatRecommendation({
        pair: 'ETH/USDT',
        marketType: 'spot',
        baseExchange: 'binance',
        targetExchange: 'okx',
        metrics: {
          netBaseFee: 0.0009,
          netTargetFee: 0.000525,
          spreadBps: 3.75,
          savingsPct: 41.67,
          cashbackAdvantage: 15.0,
          savings10k: { monthly: 3.75, annual: 45.0 },
          savings50k: { monthly: 18.75, annual: 225.0 },
          savings250k: { monthly: 93.75, annual: 1125.0 },
        },
        oppType: 'FEE_SPREAD',
      });

      expect(rec).toContain('Fee Advantage: OKX offers 3.75 bps lower net fees than BINANCE');
      expect(rec).toContain('41.67% fee savings');
    });
  });
});
