/**
 * Unit Tests for Arbitrage & Yield Math Engine
 * Module: src/lib/arbitrage/math.ts
 */

import {
  roundTo,
  calculateNetTakerFee,
  calculateNetMakerFee,
  calculateSpreadBps,
  calculateSavingsPct,
  calculateVolumeSavings,
  calculateArbitrageMetrics,
  classifyOpportunity,
} from '../math';

describe('F2: Arbitrage & Yield Math Engine', () => {
  // --------------------------------------------------------------------------
  // Core Utility: roundTo
  // --------------------------------------------------------------------------
  describe('roundTo', () => {
    it('rounds to default 4 decimal places', () => {
      expect(roundTo(0.123456)).toBe(0.1235);
      expect(roundTo(0.123444)).toBe(0.1234);
    });

    it('rounds to specified decimal precision', () => {
      expect(roundTo(0.123456, 2)).toBe(0.12);
      expect(roundTo(0.123456, 6)).toBe(0.123456);
      expect(roundTo(0.000333333, 6)).toBe(0.000333);
    });

    it('handles zero and negative numbers', () => {
      expect(roundTo(0)).toBe(0);
      expect(roundTo(-0.000123, 4)).toBe(-0.0001);
    });
  });

  // --------------------------------------------------------------------------
  // Net Fee Calculations
  // --------------------------------------------------------------------------
  describe('calculateNetTakerFee', () => {
    it('reduces gross taker fee by cashback percentage', () => {
      // 0.075% fee with 20% cashback -> 0.0600% (6.0 bps)
      expect(calculateNetTakerFee(0.00075, 20.0)).toBe(0.0006);
      // 0.055% fee with 40% cashback -> 0.0330% (3.3 bps)
      expect(calculateNetTakerFee(0.00055, 40.0)).toBe(0.00033);
    });

    it('preserves exact gross fee when cashback is 0%', () => {
      expect(calculateNetTakerFee(0.001, 0.0)).toBe(0.001);
    });

    it('produces 0 net fee when cashback is 100%', () => {
      expect(calculateNetTakerFee(0.001, 100.0)).toBe(0);
    });

    it('clamps cashback between 0 and 100%', () => {
      expect(calculateNetTakerFee(0.001, -10.0)).toBe(0.001);
      expect(calculateNetTakerFee(0.001, 150.0)).toBe(0);
    });

    it('returns 0 for zero or negative gross fees', () => {
      expect(calculateNetTakerFee(0, 20.0)).toBe(0);
      expect(calculateNetTakerFee(-0.0005, 20.0)).toBe(0);
    });
  });

  describe('calculateNetMakerFee', () => {
    it('discounts positive maker fees with cashback', () => {
      // 0.02% maker fee with 20% cashback -> 0.016%
      expect(calculateNetMakerFee(0.0002, 20.0)).toBe(0.00016);
    });

    it('preserves negative maker fees (maker rebates) without cashback reduction', () => {
      // Market maker rebate of -0.01% (-1 bps)
      expect(calculateNetMakerFee(-0.0001, 40.0)).toBe(-0.0001);
      expect(calculateNetMakerFee(-0.00005, 50.0)).toBe(-0.00005);
    });

    it('handles zero maker fee cleanly', () => {
      expect(calculateNetMakerFee(0.0, 30.0)).toBe(0.0);
    });
  });

  // --------------------------------------------------------------------------
  // Spread & Savings Percentage
  // --------------------------------------------------------------------------
  describe('calculateSpreadBps', () => {
    it('calculates basis point spread between base and target net fees', () => {
      // (0.0006 - 0.00033) * 10,000 = 2.70 bps
      expect(calculateSpreadBps(0.0006, 0.00033)).toBe(2.7);
      // (0.0009 - 0.000525) * 10,000 = 3.75 bps
      expect(calculateSpreadBps(0.0009, 0.000525)).toBe(3.75);
    });

    it('returns 0 bps when base and target fees are identical', () => {
      expect(calculateSpreadBps(0.0005, 0.0005)).toBe(0);
    });

    it('returns negative bps when target fee is higher than base fee', () => {
      expect(calculateSpreadBps(0.00033, 0.0006)).toBe(-2.7);
    });
  });

  describe('calculateSavingsPct', () => {
    it('calculates relative savings percentage accurately', () => {
      // ((0.0006 - 0.00033) / 0.0006) * 100 = 45.0%
      expect(calculateSavingsPct(0.0006, 0.00033)).toBe(45.0);
      // ((0.0009 - 0.000525) / 0.0009) * 100 = 41.67%
      expect(calculateSavingsPct(0.0009, 0.000525)).toBe(41.67);
    });

    it('returns 100% savings when target fee is 0', () => {
      expect(calculateSavingsPct(0.0005, 0)).toBe(100.0);
    });

    it('safely handles zero or negative base fee without NaN or division by zero', () => {
      expect(calculateSavingsPct(0, 0.0005)).toBe(0.0);
      expect(calculateSavingsPct(-0.0001, 0.0005)).toBe(0.0);
      expect(Number.isFinite(calculateSavingsPct(0, 0))).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Benchmark Savings Calculations
  // --------------------------------------------------------------------------
  describe('calculateVolumeSavings', () => {
    it('computes monthly and annual savings for positive spread and volume', () => {
      // 2.7 bps spread at $250,000 volume:
      // Monthly: $250,000 * (2.7 / 10,000) = $67.50
      // Annual: $67.50 * 12 = $810.00
      const savings250k = calculateVolumeSavings(2.7, 250000);
      expect(savings250k.monthly).toBe(67.5);
      expect(savings250k.annual).toBe(810.0);
    });

    it('returns 0 for zero or negative volume', () => {
      expect(calculateVolumeSavings(2.7, 0)).toEqual({ monthly: 0.0, annual: 0.0 });
      expect(calculateVolumeSavings(2.7, -50000)).toEqual({ monthly: 0.0, annual: 0.0 });
    });

    it('returns 0 for zero or negative spread', () => {
      expect(calculateVolumeSavings(0, 50000)).toEqual({ monthly: 0.0, annual: 0.0 });
      expect(calculateVolumeSavings(-1.5, 50000)).toEqual({ monthly: 0.0, annual: 0.0 });
    });

    it('handles extreme volume tiers ($1 Billion) without numeric overflow', () => {
      const extreme = calculateVolumeSavings(2.7, 1000000000);
      expect(extreme.monthly).toBe(270000.0);
      expect(extreme.annual).toBe(3240000.0);
    });
  });

  // --------------------------------------------------------------------------
  // Composite Metrics: calculateArbitrageMetrics
  // --------------------------------------------------------------------------
  describe('calculateArbitrageMetrics', () => {
    it('computes complete metrics bundle across all benchmark volume tiers', () => {
      const metrics = calculateArbitrageMetrics(0.00075, 20.0, 0.00055, 40.0);

      expect(metrics.netBaseFee).toBe(0.0006);
      expect(metrics.netTargetFee).toBe(0.00033);
      expect(metrics.spreadBps).toBe(2.7);
      expect(metrics.savingsPct).toBe(45.0);
      expect(metrics.cashbackAdvantage).toBe(20.0);

      expect(metrics.savings10k).toEqual({ monthly: 2.7, annual: 32.4 });
      expect(metrics.savings50k).toEqual({ monthly: 13.5, annual: 162.0 });
      expect(metrics.savings250k).toEqual({ monthly: 67.5, annual: 810.0 });
    });
  });

  // --------------------------------------------------------------------------
  // Opportunity Classification
  // --------------------------------------------------------------------------
  describe('classifyOpportunity', () => {
    it('classifies as VIP_PROMOTION when target exchange has non-VIP0 tier', () => {
      const metrics = calculateArbitrageMetrics(0.001, 10, 0.0005, 10);
      const res = classifyOpportunity(
        { vip_tier: 'VIP0' },
        { vip_tier: 'VIP1', maker_fee: 0.0001 },
        metrics
      );
      expect(res).toBe('VIP_PROMOTION');
    });

    it('classifies as VIP_PROMOTION when target exchange has zero or negative maker fee', () => {
      const metrics = calculateArbitrageMetrics(0.001, 0, 0.0006, 0);
      const resZero = classifyOpportunity(
        { vip_tier: 'VIP0', maker_fee: 0.0002 },
        { vip_tier: 'VIP0', maker_fee: 0.0 },
        metrics
      );
      expect(resZero).toBe('VIP_PROMOTION');

      const resRebate = classifyOpportunity(
        { vip_tier: 'VIP0', maker_fee: 0.0002 },
        { vip_tier: 'VIP0', maker_fee: -0.00005 },
        metrics
      );
      expect(resRebate).toBe('VIP_PROMOTION');
    });

    it('classifies as VIP_PROMOTION when target exchange offers promotional fee discount', () => {
      const metrics = calculateArbitrageMetrics(0.001, 0, 0.00075, 0);
      const res = classifyOpportunity(
        { vip_tier: 'VIP0' },
        { vip_tier: 'VIP0', maker_fee: 0.0002, promotional_discount_pct: 25.0 },
        metrics
      );
      expect(res).toBe('VIP_PROMOTION');
    });

    it('classifies as CASHBACK_MAX when cashback advantage >= 15%', () => {
      const metrics = calculateArbitrageMetrics(0.00075, 20.0, 0.00055, 40.0);
      expect(metrics.cashbackAdvantage).toBe(20.0);

      const res = classifyOpportunity(
        { vip_tier: 'VIP0' },
        { vip_tier: 'VIP0', maker_fee: 0.0002 },
        metrics
      );
      expect(res).toBe('CASHBACK_MAX');
    });

    it('classifies as CASHBACK_MAX when cashback accounts for >= 50% of net spread', () => {
      // Same gross fees, but cashback difference drives entire spread
      const metrics = calculateArbitrageMetrics(0.001, 10.0, 0.001, 20.0);
      const res = classifyOpportunity(
        { vip_tier: 'VIP0', taker_fee: 0.001, default_cashback_pct: 10.0 },
        { vip_tier: 'VIP0', taker_fee: 0.001, default_cashback_pct: 20.0, maker_fee: 0.0002 },
        metrics
      );
      expect(res).toBe('CASHBACK_MAX');
    });

    it('classifies as FEE_SPREAD when raw exchange fee schedule drives savings with small cashback difference', () => {
      const metrics = calculateArbitrageMetrics(0.001, 10.0, 0.0007, 15.0);
      const res = classifyOpportunity(
        { vip_tier: 'VIP0', taker_fee: 0.001, default_cashback_pct: 10.0 },
        { vip_tier: 'VIP0', taker_fee: 0.0007, default_cashback_pct: 15.0, maker_fee: 0.0002 },
        metrics
      );
      expect(res).toBe('FEE_SPREAD');
    });
  });

  // --------------------------------------------------------------------------
  // The 4 Authoritative Canonical Test Vectors (From Explorer 2 & TEST_READY.md)
  // --------------------------------------------------------------------------
  describe('Canonical Test Vectors Verification', () => {
    it('Test Vector 1: Prompt Canonical Bybit vs Binance Futures (BTC/USDT)', () => {
      // Base Exchange: Binance Futures (Taker 0.075%, Cashback 20.0%)
      // Target Exchange: Bybit Futures (Taker 0.055%, Cashback 40.0%)
      const baseGrossTaker = 0.00075;
      const baseCashback = 20.0;
      const targetGrossTaker = 0.00055;
      const targetCashback = 40.0;

      const metrics = calculateArbitrageMetrics(
        baseGrossTaker,
        baseCashback,
        targetGrossTaker,
        targetCashback
      );

      // 1. Net Taker verification
      expect(metrics.netBaseFee).toBe(0.0006); // 6.0 bps
      expect(metrics.netTargetFee).toBe(0.00033); // 3.3 bps

      // 2. Net Spread: (0.0006 - 0.00033) * 10,000 = 2.70 bps
      expect(metrics.spreadBps).toBe(2.7);

      // 3. Savings %: ((0.0006 - 0.00033) / 0.0006) * 100 = 45.0%
      expect(metrics.savingsPct).toBe(45.0);

      // 4. Volume Benchmark Savings:
      // $10k volume: $2.70/mo, $32.40/yr
      expect(metrics.savings10k.monthly).toBe(2.7);
      expect(metrics.savings10k.annual).toBe(32.4);

      // $50k volume: $13.50/mo, $162.00/yr
      expect(metrics.savings50k.monthly).toBe(13.5);
      expect(metrics.savings50k.annual).toBe(162.0);

      // $250k volume: $67.50/mo, $810.00/yr (Exact prompt match!)
      expect(metrics.savings250k.monthly).toBe(67.5);
      expect(metrics.savings250k.annual).toBe(810.0);

      // 5. Classification: CASHBACK_MAX
      const oppType = classifyOpportunity(
        { vip_tier: 'VIP0', maker_fee: 0.0002 },
        { vip_tier: 'VIP0', maker_fee: 0.0002 },
        metrics
      );
      expect(oppType).toBe('CASHBACK_MAX');
    });

    it('Test Vector 2: Spot Fee Spread (OKX vs Binance on ETH/USDT)', () => {
      // Base Exchange: Binance Spot (Taker 0.100%, Cashback 10.0%)
      // Target Exchange: OKX Spot (Taker 0.070%, Cashback 25.0%)
      const baseGrossTaker = 0.001;
      const baseCashback = 10.0;
      const targetGrossTaker = 0.0007;
      const targetCashback = 25.0;

      const metrics = calculateArbitrageMetrics(
        baseGrossTaker,
        baseCashback,
        targetGrossTaker,
        targetCashback
      );

      // 1. Net Taker verification
      expect(metrics.netBaseFee).toBe(0.0009); // 9.0 bps
      expect(metrics.netTargetFee).toBe(0.000525); // 5.25 bps

      // 2. Net Spread: 3.75 bps
      expect(metrics.spreadBps).toBe(3.75);

      // 3. Savings %: 41.67%
      expect(metrics.savingsPct).toBe(41.67);

      // 4. Volume Benchmark Savings:
      // $10k: $3.75/mo, $45.00/yr
      expect(metrics.savings10k.monthly).toBe(3.75);
      expect(metrics.savings10k.annual).toBe(45.0);

      // $50k: $18.75/mo, $225.00/yr
      expect(metrics.savings50k.monthly).toBe(18.75);
      expect(metrics.savings50k.annual).toBe(225.0);

      // $250k: $93.75/mo, $1,125.00/yr
      expect(metrics.savings250k.monthly).toBe(93.75);
      expect(metrics.savings250k.annual).toBe(1125.0);
    });

    it('Test Vector 3: VIP Promotion Spread (Bybit VIP promo vs KuCoin on SOL/USDT)', () => {
      // Base Exchange: KuCoin Spot standard (Taker 0.100%, Cashback 0.0%)
      // Target Exchange: Bybit Spot VIP1 promo (Taker 0.040%, Maker 0.0%, Cashback 35.0%)
      const baseGrossTaker = 0.001;
      const baseCashback = 0.0;
      const targetGrossTaker = 0.0004;
      const targetCashback = 35.0;

      const metrics = calculateArbitrageMetrics(
        baseGrossTaker,
        baseCashback,
        targetGrossTaker,
        targetCashback
      );

      // 1. Net Taker verification
      expect(metrics.netBaseFee).toBe(0.001); // 10.0 bps
      expect(metrics.netTargetFee).toBe(0.00026); // 2.6 bps

      // 2. Net Spread: 7.40 bps
      expect(metrics.spreadBps).toBe(7.4);

      // 3. Savings %: 74.0%
      expect(metrics.savingsPct).toBe(74.0);

      // 4. Volume Benchmark Savings ($250k): $185.00/mo, $2,220.00/yr
      expect(metrics.savings250k.monthly).toBe(185.0);
      expect(metrics.savings250k.annual).toBe(2220.0);

      // 5. Classification: VIP_PROMOTION (VIP1 tier / maker 0.0)
      const oppType = classifyOpportunity(
        { vip_tier: 'VIP0' },
        { vip_tier: 'VIP1', maker_fee: 0.0 },
        metrics
      );
      expect(oppType).toBe('VIP_PROMOTION');
    });

    it('Test Vector 4: High-Spread Burst Alert Threshold (> 15 bps trigger)', () => {
      // Base Exchange: KuCoin Spot Retail surge (Taker 0.200%, Cashback 0.0%)
      // Target Exchange: Bybit Spot Discount (Taker 0.060%, Cashback 30.0%)
      const kucoinNet = calculateNetTakerFee(0.002, 0.0); // 0.00200 = 20.0 bps
      const bybitNet = calculateNetTakerFee(0.0006, 30.0); // 0.00042 = 4.2 bps

      const spreadBps = calculateSpreadBps(kucoinNet, bybitNet);
      const savingsPct = calculateSavingsPct(kucoinNet, bybitNet);

      // 1. Net Spread: 15.80 bps (exceeds 15.0 bps threshold!)
      expect(spreadBps).toBe(15.8);
      expect(spreadBps).toBeGreaterThanOrEqual(15.0);

      // 2. Savings %: 79.0% (exceeds 20.0% threshold!)
      expect(savingsPct).toBe(79.0);
      expect(savingsPct).toBeGreaterThanOrEqual(20.0);

      // 3. Benchmark Savings at $250k: $395.00/mo, $4,740.00/yr
      const volSavings = calculateVolumeSavings(spreadBps, 250000);
      expect(volSavings.monthly).toBe(395.0);
      expect(volSavings.annual).toBe(4740.0);
    });
  });
});
