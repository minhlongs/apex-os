/**
 * Comprehensive Unit & Integration Tests for ArbitrageAlertService
 * Module: src/lib/arbitrage/alert-service.ts
 *
 * Test coverage:
 * 1. Threshold Triggering Tests (>=15 bps, >=20% savings, inactive rejection, custom configs)
 * 2. Telegram Message Formatting Tests (Markdown, emojis 🚨 📊 💰 🔗, exchange comparison, bps, savings, $810/yr benchmark, deal links)
 * 3. Mobile Push Payload Construction & Device Token Query Tests (device_tokens, filtering is_active = 1, deep links)
 * 4. Cooldown & Deduplication Tests (1-hour rolling window, canonical key format)
 * 5. Cooldown Bypass Rule Tests (>=50% spread widening exception, successive widenings)
 * 6. Batch Execution & Orchestration Tests (evaluateAndDispatchAlerts with mock D1 database & Telegram notifier)
 */

import Database from 'better-sqlite3';
import type { D1Database } from '@/lib/db';
import type { ArbitrageOpportunity } from '@/types/arbitrage';
import {
  ArbitrageAlertService,
  isOpportunityAlertEligible,
  getAlertCooldownKey,
  formatTelegramMarkdownAlert,
  formatMobilePushPayload,
  queryActiveDeviceTokens,
  DEFAULT_MIN_SPREAD_BPS,
  DEFAULT_MIN_SAVINGS_PCT,
  DEFAULT_COOLDOWN_SECONDS,
  SPREAD_WIDENING_BYPASS_RATIO,
} from '../alert-service';
import { initializeTestDatabase } from '../../../__tests__/crawler/crawler-test-harness';

describe('ArbitrageAlertService — Unit & Integration Test Suite', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  let alertService: ArbitrageAlertService;

  // Base test opportunity fixture
  const sampleOpportunity: ArbitrageOpportunity = {
    id: 'opp-btc-futures-001',
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

  beforeEach(() => {
    const env = initializeTestDatabase();
    sqlite = env.sqlite;
    db = env.db;
    alertService = new ArbitrageAlertService({ db });
  });

  afterEach(() => {
    sqlite.close();
  });

  // ==========================================================================
  // 1. Threshold Triggering Tests
  // ==========================================================================
  describe('1. Threshold Triggering & Eligibility', () => {
    it('uses default constants: minSpreadBps = 15.0, minSavingsPct = 20.0, cooldown = 3600s', () => {
      expect(DEFAULT_MIN_SPREAD_BPS).toBe(15.0);
      expect(DEFAULT_MIN_SAVINGS_PCT).toBe(20.0);
      expect(DEFAULT_COOLDOWN_SECONDS).toBe(3600);
      expect(SPREAD_WIDENING_BYPASS_RATIO).toBe(1.5);
    });

    it('triggers alert when relative fee savings >= 20.0% even if spread < 15.0 bps', () => {
      const opp: ArbitrageOpportunity = {
        ...sampleOpportunity,
        spread_bps: 2.7,   // below 15.0 bps
        savings_pct: 45.0,  // exceeds 20.0%
      };
      expect(alertService.shouldAlert(opp)).toBe(true);
      expect(isOpportunityAlertEligible(opp)).toBe(true);
    });

    it('triggers alert when spread >= 15.0 bps even if relative fee savings < 20.0%', () => {
      const opp: ArbitrageOpportunity = {
        ...sampleOpportunity,
        spread_bps: 16.5,  // exceeds 15.0 bps
        savings_pct: 12.0,  // below 20.0%
      };
      expect(alertService.shouldAlert(opp)).toBe(true);
      expect(isOpportunityAlertEligible(opp)).toBe(true);
    });

    it('triggers alert when both spread >= 15.0 bps AND savings >= 20.0%', () => {
      const opp: ArbitrageOpportunity = {
        ...sampleOpportunity,
        spread_bps: 25.0,
        savings_pct: 50.0,
      };
      expect(alertService.shouldAlert(opp)).toBe(true);
    });

    it('rejects alert when both spread < 15.0 bps AND savings < 20.0%', () => {
      const lowOpp: ArbitrageOpportunity = {
        ...sampleOpportunity,
        spread_bps: 14.9,
        savings_pct: 19.9,
      };
      expect(alertService.shouldAlert(lowOpp)).toBe(false);
      expect(isOpportunityAlertEligible(lowOpp)).toBe(false);
    });

    it('rejects alert when opportunity is inactive (is_active = 0) regardless of spread/savings', () => {
      const inactiveOpp: ArbitrageOpportunity = {
        ...sampleOpportunity,
        spread_bps: 50.0,
        savings_pct: 80.0,
        is_active: 0,
      };
      expect(alertService.shouldAlert(inactiveOpp)).toBe(false);
      expect(isOpportunityAlertEligible(inactiveOpp)).toBe(false);
    });

    it('respects exact boundary values (15.0 bps triggers, 20.0% savings triggers)', () => {
      const exactSpread: ArbitrageOpportunity = {
        ...sampleOpportunity,
        spread_bps: 15.0,
        savings_pct: 5.0,
      };
      expect(alertService.shouldAlert(exactSpread)).toBe(true);

      const exactSavings: ArbitrageOpportunity = {
        ...sampleOpportunity,
        spread_bps: 5.0,
        savings_pct: 20.0,
      };
      expect(alertService.shouldAlert(exactSavings)).toBe(true);
    });

    it('supports custom threshold configuration passed to service or method', () => {
      const strictService = new ArbitrageAlertService({
        config: { minSpreadBps: 30.0, minSavingsPct: 50.0 },
      });

      // Sample opportunity has spread 2.7, savings 45.0 -> fails strict thresholds
      expect(strictService.shouldAlert(sampleOpportunity)).toBe(false);

      // Overriding per method call
      expect(
        alertService.shouldAlert(sampleOpportunity, { minSpreadBps: 1.0, minSavingsPct: 10.0 })
      ).toBe(true);
    });
  });

  // ==========================================================================
  // 2. Telegram Notification Formatting Tests
  // ==========================================================================
  describe('2. Telegram Message Formatting', () => {
    it('formats rich Markdown message with all required emojis (🚨, 📊, 💰, 🔗, 💡, 🌐)', () => {
      const message = formatTelegramMarkdownAlert(sampleOpportunity);

      expect(message).toContain('🚨');
      expect(message).toContain('📊');
      expect(message).toContain('💰');
      expect(message).toContain('🔗');
      expect(message).toContain('💡');
      expect(message).toContain('🌐');
    });

    it('formats exchange comparison with base and target details and taker percentages', () => {
      const message = formatTelegramMarkdownAlert(sampleOpportunity);

      expect(message).toContain('Arbitrage Alert: BTC/USDT (FUTURES)');
      expect(message).toContain('Binance');
      expect(message).toContain('Bybit');
      expect(message).toContain('Taker: 0.075%');
      expect(message).toContain('Cashback: 20%');
      expect(message).toContain('Net: 0.0600%');
      expect(message).toContain('Taker: 0.055%');
      expect(message).toContain('Cashback: 40%');
      expect(message).toContain('Net: 0.0330%');
    });

    it('formats spread in bps and fee savings percentage', () => {
      const message = formatTelegramMarkdownAlert(sampleOpportunity);

      expect(message).toContain('2.7 bps');
      expect(message).toContain('45.0%');
    });

    it('formats benchmark savings across volume tiers ($10k, $50k, $250k) including annual $810/yr at $250k', () => {
      const message = formatTelegramMarkdownAlert(sampleOpportunity);

      expect(message).toContain('*Est. Savings ($10k vol):* $2.70/mo');
      expect(message).toContain('*Est. Savings ($50k vol):* $13.50/mo');
      expect(message).toContain('*Est. Savings ($250k vol):* $67.50/mo');
      expect(message).toContain('$810/yr at $250k');
    });

    it('displays classification badge in message header', () => {
      const message = formatTelegramMarkdownAlert(sampleOpportunity);
      expect(message).toContain('[CASHBACK_MAX]');

      const vipOpp: ArbitrageOpportunity = {
        ...sampleOpportunity,
        opportunity_type: 'VIP_PROMOTION',
      };
      expect(formatTelegramMarkdownAlert(vipOpp)).toContain('[VIP_PROMOTION]');
    });

    it('formats direct affiliate deal link when deal_id exists', () => {
      const message = formatTelegramMarkdownAlert(sampleOpportunity);
      expect(message).toContain('https://apexos.io/deals/deal-bybit-futures-40');
      expect(message).toContain('Claim Bybit Cashback Deal');
    });

    it('falls back to general arbitrage matrix link when deal_id is null', () => {
      const noDealOpp: ArbitrageOpportunity = {
        ...sampleOpportunity,
        deal_id: null,
      };
      const message = formatTelegramMarkdownAlert(noDealOpp);
      expect(message).toContain('https://apexos.io/deals?tab=arbitrage');
      expect(message).toContain('Open Arbitrage Matrix');
    });

    it('service instance method formatTelegramAlert produces identical output', () => {
      expect(alertService.formatTelegramAlert(sampleOpportunity)).toBe(
        formatTelegramMarkdownAlert(sampleOpportunity)
      );
    });
  });

  // ==========================================================================
  // 3. Mobile Push Payload Construction & Device Token Query Tests
  // ==========================================================================
  describe('3. Mobile Push Payload Construction & Device Token Query', () => {
    it('constructs mobile push payload matching required schema with deep link', () => {
      const token = 'ExponentPushToken[trader-ios-token-111]';
      const payload = formatMobilePushPayload(sampleOpportunity, token);

      expect(payload.to).toBe(token);
      expect(payload.sound).toBe('default');
      expect(payload.title).toContain('BTC/USDT');
      expect(payload.title).toContain('Bybit vs Binance');
      expect(payload.body).toContain('45.0%');
      expect(payload.body).toContain('2.7 bps spread');
      expect(payload.body).toContain('$14/mo savings on $50k volume');

      // Verify structured data fields
      expect(payload.data.type).toBe('arbitrage_alert');
      expect(payload.data.pair).toBe('BTC/USDT');
      expect(payload.data.marketType).toBe('futures');
      expect(payload.data.baseExchange).toBe('binance');
      expect(payload.data.targetExchange).toBe('bybit');
      expect(payload.data.spreadBps).toBe(2.7);
      expect(payload.data.savingsPct).toBe(45.0);
      expect(payload.data.dealId).toBe('deal-bybit-futures-40');
      expect(payload.data.deepLink).toBe('apex-os://deals/arbitrage?pair=BTC-USDT');
      expect(payload.data.dealUrl).toBe('/deals?pair=BTC%2FUSDT');
    });

    it('queries active push tokens from D1 device_tokens table and ignores inactive tokens', async () => {
      // In initializeTestDatabase(), 3 tokens were seeded:
      // - 'tok-ios-1': is_active = 1
      // - 'tok-android-2': is_active = 1
      // - 'tok-inactive-3': is_active = 0
      const activeTokens = await queryActiveDeviceTokens(db);

      expect(activeTokens.length).toBe(2);
      expect(activeTokens.every((t) => t.is_active === 1 || t.is_active === undefined)).toBe(true);

      const expoTokens = activeTokens.map((t) => t.expo_token);
      expect(expoTokens).toContain('ExponentPushToken[trader-ios-token-111]');
      expect(expoTokens).toContain('ExponentPushToken[trader-android-token-222]');
      expect(expoTokens).not.toContain('ExponentPushToken[inactive-token-333]');
    });

    it('queryActiveDeviceTokens handles empty database or table gracefully', async () => {
      await db.prepare('DELETE FROM device_tokens').run();

      const activeTokens = await queryActiveDeviceTokens(db);
      expect(activeTokens).toEqual([]);
    });

    it('service instance formatPushPayload produces identical payload', () => {
      const token = 'ExponentPushToken[abc-123]';
      expect(alertService.formatPushPayload(sampleOpportunity, token)).toEqual(
        formatMobilePushPayload(sampleOpportunity, token)
      );
    });
  });

  // ==========================================================================
  // 4. Cooldown Deduplication Tests
  // ==========================================================================
  describe('4. Cooldown & Deduplication Logic', () => {
    it('generates canonical cooldown key formatted as pair:market_type:base:target', () => {
      const key = getAlertCooldownKey(sampleOpportunity);
      expect(key).toBe('BTC/USDT:futures:binance:bybit');
      expect(alertService.getAlertKey(sampleOpportunity)).toBe('BTC/USDT:futures:binance:bybit');
    });

    it('allows initial alert dispatch (isSuppressed = false)', () => {
      expect(alertService.isSuppressed(sampleOpportunity)).toBe(false);
    });

    it('suppresses duplicate alert within 1-hour cooldown window when spread is unchanged', () => {
      const t0 = 1700000000000;

      // Initial record
      alertService.recordAlert(sampleOpportunity, t0);

      // 15 minutes later (900 seconds < 3600 seconds)
      const t15m = t0 + 15 * 60 * 1000;
      expect(alertService.isSuppressed(sampleOpportunity, t15m)).toBe(true);

      // checkAndRecord returns suppressed
      const checkResult = alertService.checkAndRecord(sampleOpportunity, t15m);
      expect(checkResult.shouldDispatch).toBe(false);
      expect(checkResult.reason).toBe('cooldown_suppressed');
    });

    it('allows fresh alert after cooldown window (3600 seconds) expires', () => {
      const t0 = 1700000000000;
      alertService.recordAlert(sampleOpportunity, t0);

      // 61 minutes later (3660 seconds > 3600 seconds)
      const t61m = t0 + 61 * 60 * 1000;
      expect(alertService.isSuppressed(sampleOpportunity, t61m)).toBe(false);

      const checkResult = alertService.checkAndRecord(sampleOpportunity, t61m);
      expect(checkResult.shouldDispatch).toBe(true);
      expect(checkResult.reason).toBe('fresh');
    });

    it('maintains independent cooldowns for different pairs, markets, or exchange directions', () => {
      const t0 = 1700000000000;
      alertService.recordAlert(sampleOpportunity, t0);

      // Different pair: ETH/USDT
      const ethOpp: ArbitrageOpportunity = { ...sampleOpportunity, pair: 'ETH/USDT' };
      expect(alertService.isSuppressed(ethOpp, t0 + 60000)).toBe(false);

      // Different market: Spot vs Futures
      const spotOpp: ArbitrageOpportunity = { ...sampleOpportunity, market_type: 'spot' };
      expect(alertService.isSuppressed(spotOpp, t0 + 60000)).toBe(false);

      // Different direction: Bybit -> Binance
      const reverseOpp: ArbitrageOpportunity = {
        ...sampleOpportunity,
        base_exchange: 'bybit',
        target_exchange: 'binance',
      };
      expect(alertService.isSuppressed(reverseOpp, t0 + 60000)).toBe(false);
    });

    it('clearCooldowns resets history and allows re-alerting immediately', () => {
      const t0 = 1700000000000;
      alertService.recordAlert(sampleOpportunity, t0);
      expect(alertService.isSuppressed(sampleOpportunity, t0 + 1000)).toBe(true);

      alertService.clearCooldowns();
      expect(alertService.isSuppressed(sampleOpportunity, t0 + 1000)).toBe(false);
    });
  });

  // ==========================================================================
  // 5. Cooldown Bypass Rule Tests (Spread Widening >= 50%)
  // ==========================================================================
  describe('5. Cooldown Bypass Rule (Spread Widening >= 50%)', () => {
    it('bypasses cooldown when spread widens by exactly 50% (1.5x) within cooldown window', () => {
      const t0 = 1700000000000;
      const initialOpp: ArbitrageOpportunity = { ...sampleOpportunity, spread_bps: 20.0 };
      alertService.recordAlert(initialOpp, t0);

      // 10 minutes later: spread widens from 20.0 bps to 30.0 bps (exactly 1.5x = +50%)
      const widenedOpp: ArbitrageOpportunity = { ...sampleOpportunity, spread_bps: 30.0 };
      const t10m = t0 + 10 * 60 * 1000;

      expect(alertService.isSuppressed(widenedOpp, t10m)).toBe(false);

      const checkResult = alertService.checkAndRecord(widenedOpp, t10m);
      expect(checkResult.shouldDispatch).toBe(true);
      expect(checkResult.reason).toBe('widening_bypass');
    });

    it('bypasses cooldown when spread widens by > 50% (e.g. 60% widening)', () => {
      const t0 = 1700000000000;
      const initialOpp: ArbitrageOpportunity = { ...sampleOpportunity, spread_bps: 20.0 };
      alertService.recordAlert(initialOpp, t0);

      const burstOpp: ArbitrageOpportunity = { ...sampleOpportunity, spread_bps: 32.0 }; // +60%
      const t20m = t0 + 20 * 60 * 1000;

      expect(alertService.isSuppressed(burstOpp, t20m)).toBe(false);

      const check = alertService.checkAndRecord(burstOpp, t20m);
      expect(check.shouldDispatch).toBe(true);
      expect(check.reason).toBe('widening_bypass');
    });

    it('does NOT bypass cooldown when spread widens by < 50% (e.g. +40%)', () => {
      const t0 = 1700000000000;
      const initialOpp: ArbitrageOpportunity = { ...sampleOpportunity, spread_bps: 20.0 };
      alertService.recordAlert(initialOpp, t0);

      // Spread increases from 20.0 bps to 28.0 bps (+40% < 50%)
      const moderateIncreaseOpp: ArbitrageOpportunity = { ...sampleOpportunity, spread_bps: 28.0 };
      const t10m = t0 + 10 * 60 * 1000;

      expect(alertService.isSuppressed(moderateIncreaseOpp, t10m)).toBe(true);

      const check = alertService.checkAndRecord(moderateIncreaseOpp, t10m);
      expect(check.shouldDispatch).toBe(false);
      expect(check.reason).toBe('cooldown_suppressed');
    });

    it('handles successive widenings correctly', () => {
      const t0 = 1700000000000;
      const opp1: ArbitrageOpportunity = { ...sampleOpportunity, spread_bps: 10.0 };
      alertService.recordAlert(opp1, t0);

      // Widens to 15.0 bps (1.5x) -> bypasses
      const opp2: ArbitrageOpportunity = { ...sampleOpportunity, spread_bps: 15.0 };
      const t10m = t0 + 10 * 60 * 1000;
      const check2 = alertService.checkAndRecord(opp2, t10m);
      expect(check2.shouldDispatch).toBe(true);
      expect(check2.reason).toBe('widening_bypass');

      // Increases slightly to 18.0 bps (18 < 15 * 1.5 = 22.5) -> suppressed
      const opp3: ArbitrageOpportunity = { ...sampleOpportunity, spread_bps: 18.0 };
      const t20m = t0 + 20 * 60 * 1000;
      const check3 = alertService.checkAndRecord(opp3, t20m);
      expect(check3.shouldDispatch).toBe(false);
      expect(check3.reason).toBe('cooldown_suppressed');

      // Further widens to 23.0 bps (>= 15 * 1.5 = 22.5) -> bypasses again!
      const opp4: ArbitrageOpportunity = { ...sampleOpportunity, spread_bps: 23.0 };
      const t30m = t0 + 30 * 60 * 1000;
      const check4 = alertService.checkAndRecord(opp4, t30m);
      expect(check4.shouldDispatch).toBe(true);
      expect(check4.reason).toBe('widening_bypass');
    });
  });

  // ==========================================================================
  // 6. Batch Execution & Orchestration Tests (evaluateAndDispatchAlerts)
  // ==========================================================================
  describe('6. Batch Execution & Orchestration (evaluateAndDispatchAlerts)', () => {
    it('processes a mixed batch of eligible, suppressed, below-threshold, and inactive opportunities', async () => {
      const mockTelegramSend = jest.fn().mockResolvedValue({ success: true, messageId: 'msg-123' });
      const mockTelegramNotifier = { send: mockTelegramSend };

      const batchService = new ArbitrageAlertService({
        telegramNotifier: mockTelegramNotifier,
        db,
      });

      const t0 = 1700000000000;

      const oppEligible: ArbitrageOpportunity = {
        ...sampleOpportunity,
        id: 'opp-1',
        pair: 'SOL/USDT',
        spread_bps: 25.0,
        savings_pct: 60.0,
      };

      const oppBelowThreshold: ArbitrageOpportunity = {
        ...sampleOpportunity,
        id: 'opp-2',
        pair: 'ETH/USDT',
        spread_bps: 8.0,
        savings_pct: 12.0,
      };

      const oppInactive: ArbitrageOpportunity = {
        ...sampleOpportunity,
        id: 'opp-3',
        pair: 'ADA/USDT',
        spread_bps: 35.0,
        savings_pct: 70.0,
        is_active: 0,
      };

      const result = await batchService.evaluateAndDispatchAlerts(
        [oppEligible, oppBelowThreshold, oppInactive],
        { now: t0 }
      );

      expect(result.totalEvaluated).toBe(3);
      expect(result.eligibleCount).toBe(1);
      expect(result.dispatchedCount).toBe(1);
      expect(result.suppressedCount).toBe(2);

      // Verify dispatched item
      expect(result.dispatchedAlerts[0].pair).toBe('SOL/USDT');
      expect(result.dispatchedAlerts[0].reason).toBe('fresh');
      expect(result.dispatchedAlerts[0].telegramSent).toBe(true);
      expect(result.dispatchedAlerts[0].pushCount).toBe(2); // 2 active devices seeded

      // Verify suppressed items
      const suppressedReasons = result.suppressedAlerts.map((s) => s.reason);
      expect(suppressedReasons).toContain('below_threshold');
      expect(suppressedReasons).toContain('inactive');

      // Verify Telegram notifier called once
      expect(mockTelegramSend).toHaveBeenCalledTimes(1);
      expect(mockTelegramSend.mock.calls[0][0].title).toContain('SOL/USDT');
      expect(mockTelegramSend.mock.calls[0][0].priority).toBe('high'); // >= 30 bps or >= 40%

      // Verify push results
      expect(result.pushResults.queued).toBe(2);
      expect(result.pushResults.devicesCount).toBe(2);
    });

    it('suppresses duplicate in subsequent evaluation run within cooldown window', async () => {
      const mockTelegramSend = jest.fn().mockResolvedValue({ success: true });
      const batchService = new ArbitrageAlertService({
        telegramNotifier: { send: mockTelegramSend },
        db,
      });

      const t0 = 1700000000000;
      const opp: ArbitrageOpportunity = {
        ...sampleOpportunity,
        spread_bps: 20.0,
        savings_pct: 30.0,
      };

      // Run 1: initial dispatch
      const run1 = await batchService.evaluateAndDispatchAlerts([opp], { now: t0 });
      expect(run1.dispatchedCount).toBe(1);
      expect(mockTelegramSend).toHaveBeenCalledTimes(1);

      // Run 2: 10 minutes later with same spread -> suppressed by cooldown
      const run2 = await batchService.evaluateAndDispatchAlerts([opp], {
        now: t0 + 10 * 60 * 1000,
      });
      expect(run2.dispatchedCount).toBe(0);
      expect(run2.suppressedCount).toBe(1);
      expect(run2.suppressedAlerts[0].reason).toBe('cooldown_suppressed');
      expect(mockTelegramSend).toHaveBeenCalledTimes(1); // not called again
    });

    it('handles telegram send failure gracefully without failing batch execution', async () => {
      const failingTelegram = {
        send: jest.fn().mockRejectedValue(new Error('Telegram API rate limit')),
      };

      const batchService = new ArbitrageAlertService({
        telegramNotifier: failingTelegram,
        db,
      });

      const result = await batchService.evaluateAndDispatchAlerts([sampleOpportunity]);

      expect(result.dispatchedCount).toBe(1);
      expect(result.dispatchedAlerts[0].telegramSent).toBe(false);
      expect(result.telegramResults.sent).toBe(0);
      expect(result.telegramResults.failed).toBe(1);
      expect(result.pushResults.queued).toBe(2); // push still queued
    });

    it('supports custom pushDispatcher callback', async () => {
      const customPushDispatcher = jest.fn().mockResolvedValue({ success: true });
      const batchService = new ArbitrageAlertService({ db });

      const result = await batchService.evaluateAndDispatchAlerts([sampleOpportunity], {
        pushDispatcher: customPushDispatcher,
        skipTelegram: true,
      });

      expect(result.dispatchedCount).toBe(1);
      expect(customPushDispatcher).toHaveBeenCalledTimes(1);
      const dispatchedPayloads = customPushDispatcher.mock.calls[0][0];
      expect(dispatchedPayloads.length).toBe(2);
      expect(dispatchedPayloads[0].data.spreadBps).toBe(2.7);
    });

    it('supports direct db argument signature: evaluateAndDispatchAlerts(opps, db)', async () => {
      const directService = new ArbitrageAlertService();
      const result = await directService.evaluateAndDispatchAlerts([sampleOpportunity], db);

      expect(result.dispatchedCount).toBe(1);
      expect(result.pushResults.queued).toBe(2);
    });

    it('handles empty opportunities array cleanly', async () => {
      const result = await alertService.evaluateAndDispatchAlerts([]);

      expect(result.totalEvaluated).toBe(0);
      expect(result.dispatchedCount).toBe(0);
      expect(result.suppressedCount).toBe(0);
      expect(result.dispatchedAlerts).toEqual([]);
      expect(result.suppressedAlerts).toEqual([]);
    });
  });
});
