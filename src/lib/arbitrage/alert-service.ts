/**
 * Arbitrage Alert Service & Multi-Channel Push Dispatcher
 * Module: ApexOS Arbitrage Engine
 *
 * Implements real-time alerting for high-yield cross-exchange fee arbitrage:
 * - Configurable threshold evaluation (minSpreadBps >= 15.0, minSavingsPct >= 20.0)
 * - Rolling cooldown deduplication (3,600s rolling window per pair and exchange pair)
 * - Cooldown bypass exception for rapid spread widening (>= 50% expansion)
 * - Rich Telegram alert formatting with emojis (🚨, 📊, 💰, 🔗) and affiliate deal links
 * - Mobile push notification payload construction and D1 device_tokens dispatching
 * - Full batch execution orchestrator (evaluateAndDispatchAlerts)
 */

import type { D1Database } from '@/lib/db';
import type {
  ArbitrageOpportunity,
  ExchangeId,
  MarketType,
  OpportunityType,
} from '@/types/arbitrage';
import { TelegramNotifier } from '@/lib/notifications/channels/telegram';
import type { TelegramConfig, NotificationMessage } from '@/lib/notifications/config';

// ============================================================================
// Constants & Defaults
// ============================================================================

export const DEFAULT_MIN_SPREAD_BPS = 15.0;
export const DEFAULT_MIN_SAVINGS_PCT = 20.0;
export const DEFAULT_COOLDOWN_SECONDS = 3600; // 1 hour
export const SPREAD_WIDENING_BYPASS_RATIO = 1.5; // 50% widening

// ============================================================================
// Interfaces & Types
// ============================================================================

export interface AlertThresholdConfig {
  minSpreadBps?: number;
  minSavingsPct?: number;
  cooldownSeconds?: number;
  telegramConfig?: TelegramConfig;
  telegramEnabled?: boolean;
  pushEnabled?: boolean;
}

export interface CooldownEntry {
  lastAlertedAt: number;
  spreadBps: number;
}

export interface CooldownCheckResult {
  shouldDispatch: boolean;
  reason: 'fresh' | 'cooldown_suppressed' | 'widening_bypass';
}

export interface DeviceTokenRecord {
  id?: string;
  user_id?: string;
  platform?: 'ios' | 'android' | 'web';
  token?: string | null;
  expo_token?: string | null;
  apns_token?: string | null;
  fcm_token?: string | null;
  is_active?: number;
}

export interface MobilePushPayload {
  to: string;
  sound: string;
  title: string;
  body: string;
  data: {
    type: string;
    pair: string;
    marketType: MarketType;
    baseExchange: ExchangeId;
    targetExchange: ExchangeId;
    spreadBps: number;
    savingsPct: number;
    dealId: string | null;
    dealUrl?: string;
    deepLink: string;
  };
}

export interface DispatchedAlertItem {
  opportunityId?: string;
  pair: string;
  marketType: MarketType;
  baseExchange: ExchangeId;
  targetExchange: ExchangeId;
  spreadBps: number;
  savingsPct: number;
  reason: 'fresh' | 'widening_bypass';
  telegramSent: boolean;
  pushCount: number;
  messageText?: string;
  pushPayloads?: MobilePushPayload[];
}

export interface SuppressedAlertItem {
  opportunityId?: string;
  pair: string;
  marketType: MarketType;
  baseExchange: ExchangeId;
  targetExchange: ExchangeId;
  spreadBps: number;
  reason: 'below_threshold' | 'inactive' | 'cooldown_suppressed';
}

export interface AlertDispatchResult {
  totalEvaluated: number;
  eligibleCount: number;
  dispatchedCount: number;
  suppressedCount: number;
  dispatchedAlerts: DispatchedAlertItem[];
  suppressedAlerts: SuppressedAlertItem[];
  telegramResults: { sent: number; failed: number };
  pushResults: { queued: number; devicesCount: number };
}

export interface AlertDispatchOptions {
  db?: D1Database;
  now?: number;
  minSpreadBps?: number;
  minSavingsPct?: number;
  cooldownSeconds?: number;
  skipTelegram?: boolean;
  skipPush?: boolean;
  telegramNotifier?: TelegramNotifier | { send: (msg: NotificationMessage) => Promise<any> };
  pushDispatcher?: (payloads: MobilePushPayload[]) => Promise<any>;
}

// ============================================================================
// Pure Helper Functions
// ============================================================================

/**
 * Evaluates whether an opportunity exceeds alerting thresholds.
 * Default rule: opportunity must be active and have spread_bps >= 15.0 OR savings_pct >= 20.0
 */
export function isOpportunityAlertEligible(
  opp: ArbitrageOpportunity,
  config?: AlertThresholdConfig
): boolean {
  if (opp.is_active === 0) {
    return false;
  }
  const minSpread = config?.minSpreadBps ?? DEFAULT_MIN_SPREAD_BPS;
  const minSavings = config?.minSavingsPct ?? DEFAULT_MIN_SAVINGS_PCT;

  return opp.spread_bps >= minSpread || opp.savings_pct >= minSavings;
}

/**
 * Builds the canonical cooldown cache key for an opportunity.
 * Key format: `${opportunity.pair}:${opportunity.market_type}:${opportunity.base_exchange}:${opportunity.target_exchange}`
 */
export function getAlertCooldownKey(opp: {
  pair: string;
  market_type: string;
  base_exchange: string;
  target_exchange: string;
}): string {
  return `${opp.pair}:${opp.market_type}:${opp.base_exchange}:${opp.target_exchange}`;
}

/**
 * Formats a rich Telegram Markdown alert message containing:
 * - Alert emojis (🚨, 📊, 💰, 🔗, 💡, 🌐)
 * - Exchange comparison (base vs target taker fees, cashback, and net rates)
 * - Net spread in bps and relative savings percentage
 * - Standard volume benchmark savings ($10k, $50k, $250k) and annual savings ($810/yr at $250k)
 * - Classification badge and recommendation text
 * - Direct affiliate deal link
 */
export function formatTelegramMarkdownAlert(opp: ArbitrageOpportunity): string {
  const pairName = opp.pair;
  const marketType = opp.market_type.toUpperCase();
  const baseName = opp.base_exchange.charAt(0).toUpperCase() + opp.base_exchange.slice(1);
  const targetName = opp.target_exchange.charAt(0).toUpperCase() + opp.target_exchange.slice(1);
  const badge = opp.opportunity_type || 'FEE_SPREAD';
  const dealUrl = opp.deal_id
    ? `https://apexos.io/deals/${opp.deal_id}`
    : 'https://apexos.io/deals?tab=arbitrage';
  const dealLink = opp.deal_id
    ? `👉 [Claim ${targetName} Cashback Deal](${dealUrl})`
    : `👉 [Open Arbitrage Matrix](${dealUrl})`;

  return [
    `🚨 *Arbitrage Alert: ${pairName} (${marketType})* [${badge}]`,
    '',
    'A high-yield fee differential has been detected across exchanges!',
    '',
    '📊 *Exchange Comparison:*',
    `• *Base Exchange:* ${baseName} (Taker: ${(opp.base_taker_fee * 100).toFixed(3)}%, Cashback: ${opp.base_cashback_pct}% → Net: ${(opp.net_base_fee * 100).toFixed(4)}%)`,
    `• *Target Exchange:* ${targetName} (Taker: ${(opp.target_taker_fee * 100).toFixed(3)}%, Cashback: ${opp.target_cashback_pct}% → Net: ${(opp.net_target_fee * 100).toFixed(4)}%)`,
    '',
    '💰 *Spread & Savings Advantage:*',
    `• *Net Spread:* ${opp.spread_bps.toFixed(1)} bps`,
    `• *Fee Savings:* ${opp.savings_pct.toFixed(1)}%`,
    `• *Est. Savings ($10k vol):* $${opp.monthly_savings_10k.toFixed(2)}/mo ($${opp.annual_savings_10k.toFixed(0)}/yr)`,
    `• *Est. Savings ($50k vol):* $${opp.monthly_savings_50k.toFixed(2)}/mo ($${opp.annual_savings_50k.toFixed(0)}/yr)`,
    `• *Est. Savings ($250k vol):* $${opp.monthly_savings_250k.toFixed(2)}/mo ($${opp.annual_savings_250k.toFixed(0)}/yr at $250k)`,
    '',
    `💡 *Recommendation:* ${opp.recommendation}`,
    '',
    `🔗 ${dealLink}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━',
    '🌐 ApexOS Market Intelligence',
  ].join('\n');
}

/**
 * Constructs an Expo / Mobile Push Notification payload for registered device_tokens.
 * Includes title, body, and structured data with deepLink and dealUrl.
 */
export function formatMobilePushPayload(
  opp: ArbitrageOpportunity,
  token: string
): MobilePushPayload {
  const baseName = opp.base_exchange.charAt(0).toUpperCase() + opp.base_exchange.slice(1);
  const targetName = opp.target_exchange.charAt(0).toUpperCase() + opp.target_exchange.slice(1);
  const deepLink = `apex-os://deals/arbitrage?pair=${opp.pair.replace('/', '-')}`;
  const dealUrl = `/deals?pair=${encodeURIComponent(opp.pair)}`;

  return {
    to: token,
    sound: 'default',
    title: `⚡ Arbitrage Alert: ${opp.pair} (${targetName} vs ${baseName})`,
    body: `Save ${opp.savings_pct.toFixed(1)}% (${opp.spread_bps.toFixed(1)} bps spread) on trading fees! Est. $${opp.monthly_savings_50k.toFixed(0)}/mo savings on $50k volume.`,
    data: {
      type: 'arbitrage_alert',
      pair: opp.pair,
      marketType: opp.market_type,
      baseExchange: opp.base_exchange,
      targetExchange: opp.target_exchange,
      spreadBps: opp.spread_bps,
      savingsPct: opp.savings_pct,
      dealId: opp.deal_id ?? null,
      dealUrl,
      deepLink,
    },
  };
}

/**
 * Queries active mobile push tokens from Cloudflare D1 device_tokens table.
 */
export async function queryActiveDeviceTokens(
  db: D1Database
): Promise<DeviceTokenRecord[]> {
  try {
    const res = await db
      .prepare('SELECT token, expo_token, apns_token, fcm_token FROM device_tokens WHERE is_active = 1')
      .all<DeviceTokenRecord>();

    const rows = Array.isArray(res) ? res : (res?.results || []);
    return rows;
  } catch (err) {
    // Return empty array on database query failure
    return [];
  }
}

// ============================================================================
// ArbitrageAlertService Class
// ============================================================================

export class ArbitrageAlertService {
  private config: Required<AlertThresholdConfig>;
  private history = new Map<string, CooldownEntry>();
  private telegramNotifier?: TelegramNotifier | { send: (msg: NotificationMessage) => Promise<any> };
  private db?: D1Database;

  constructor(options?: {
    config?: AlertThresholdConfig;
    telegramNotifier?: TelegramNotifier | { send: (msg: NotificationMessage) => Promise<any> };
    db?: D1Database;
  }) {
    this.config = {
      minSpreadBps: options?.config?.minSpreadBps ?? DEFAULT_MIN_SPREAD_BPS,
      minSavingsPct: options?.config?.minSavingsPct ?? DEFAULT_MIN_SAVINGS_PCT,
      cooldownSeconds: options?.config?.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS,
      telegramConfig: options?.config?.telegramConfig ?? {
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatIds: process.env.TELEGRAM_CHAT_IDS
          ? process.env.TELEGRAM_CHAT_IDS.split(',').map((s) => s.trim())
          : [],
        parseMode: (process.env.TELEGRAM_PARSE_MODE as 'HTML' | 'Markdown') || 'Markdown',
      },
      telegramEnabled: options?.config?.telegramEnabled ?? (process.env.TELEGRAM_ENABLED !== 'false'),
      pushEnabled: options?.config?.pushEnabled ?? true,
    };

    this.telegramNotifier = options?.telegramNotifier;
    this.db = options?.db;

    // Auto-create TelegramNotifier if token & chat IDs configured
    if (!this.telegramNotifier && this.config.telegramConfig.botToken && this.config.telegramConfig.chatIds.length > 0) {
      this.telegramNotifier = new TelegramNotifier(this.config.telegramConfig);
    }
  }

  /**
   * Evaluates if opportunity meets alert criteria (active and exceeds threshold).
   */
  shouldAlert(opp: ArbitrageOpportunity, customConfig?: AlertThresholdConfig): boolean {
    const minSpread = customConfig?.minSpreadBps ?? this.config.minSpreadBps;
    const minSavings = customConfig?.minSavingsPct ?? this.config.minSavingsPct;

    if (opp.is_active === 0) {
      return false;
    }

    return opp.spread_bps >= minSpread || opp.savings_pct >= minSavings;
  }

  /**
   * Returns canonical cooldown key for opportunity.
   */
  getAlertKey(opp: {
    pair: string;
    market_type: string;
    base_exchange: string;
    target_exchange: string;
  }): string {
    return getAlertCooldownKey(opp);
  }

  /**
   * Checks whether an opportunity is currently suppressed by cooldown.
   * Returns true if suppressed, false if allowed to dispatch.
   */
  isSuppressed(opp: ArbitrageOpportunity, now = Date.now()): boolean {
    const key = this.getAlertKey(opp);
    const existing = this.history.get(key);

    if (!existing) {
      return false; // No previous alert -> not suppressed
    }

    const cooldownMs = this.config.cooldownSeconds * 1000;
    const elapsed = now - existing.lastAlertedAt;

    // If cooldown has expired -> not suppressed
    if (elapsed >= cooldownMs) {
      return false;
    }

    // Cooldown bypass rule: if spread widens by >= 50% (1.5x) -> bypass cooldown!
    if (opp.spread_bps >= existing.spreadBps * SPREAD_WIDENING_BYPASS_RATIO) {
      return false;
    }

    // Otherwise suppressed
    return true;
  }

  /**
   * Records an alert dispatch in the rolling cooldown history.
   */
  recordAlert(opp: ArbitrageOpportunity, now = Date.now()): void {
    const key = this.getAlertKey(opp);
    this.history.set(key, {
      lastAlertedAt: now,
      spreadBps: opp.spread_bps,
    });
  }

  /**
   * Performs deduplication check and records alert if allowed.
   */
  checkAndRecord(opp: ArbitrageOpportunity, now = Date.now()): CooldownCheckResult {
    const key = this.getAlertKey(opp);
    const existing = this.history.get(key);

    if (!existing) {
      this.recordAlert(opp, now);
      return { shouldDispatch: true, reason: 'fresh' };
    }

    const cooldownMs = this.config.cooldownSeconds * 1000;
    const elapsed = now - existing.lastAlertedAt;

    if (elapsed >= cooldownMs) {
      this.recordAlert(opp, now);
      return { shouldDispatch: true, reason: 'fresh' };
    }

    if (opp.spread_bps >= existing.spreadBps * SPREAD_WIDENING_BYPASS_RATIO) {
      this.recordAlert(opp, now);
      return { shouldDispatch: true, reason: 'widening_bypass' };
    }

    return { shouldDispatch: false, reason: 'cooldown_suppressed' };
  }

  /**
   * Clears the in-memory cooldown history.
   */
  clearCooldowns(): void {
    this.history.clear();
  }

  /**
   * Formats Telegram Markdown alert message for this service.
   */
  formatTelegramAlert(opp: ArbitrageOpportunity): string {
    return formatTelegramMarkdownAlert(opp);
  }

  /**
   * Formats Mobile Push payload for a given token.
   */
  formatPushPayload(opp: ArbitrageOpportunity, token: string): MobilePushPayload {
    return formatMobilePushPayload(opp, token);
  }

  /**
   * Orchestrates threshold filtering, deduplication checks, Telegram sending,
   * mobile push enqueueing, and returns structured AlertDispatchResult.
   *
   * Supports flexible signatures:
   * - evaluateAndDispatchAlerts(opportunities, options, db)
   * - evaluateAndDispatchAlerts(opportunities, db)
   * - evaluateAndDispatchAlerts(opportunities, options)
   */
  async evaluateAndDispatchAlerts(
    opportunities: ArbitrageOpportunity[],
    optionsOrDb?: AlertDispatchOptions | D1Database,
    dbOverride?: D1Database
  ): Promise<AlertDispatchResult> {
    // Resolve options and database instance
    let options: AlertDispatchOptions = {};
    let db: D1Database | undefined = dbOverride ?? this.db;

    if (optionsOrDb) {
      if ('prepare' in (optionsOrDb as any) && typeof (optionsOrDb as any).prepare === 'function') {
        db = optionsOrDb as D1Database;
      } else {
        options = optionsOrDb as AlertDispatchOptions;
        if (options.db) {
          db = options.db;
        }
      }
    }

    const now = options.now ?? Date.now();
    const thresholdConfig: AlertThresholdConfig = {
      minSpreadBps: options.minSpreadBps ?? this.config.minSpreadBps,
      minSavingsPct: options.minSavingsPct ?? this.config.minSavingsPct,
    };

    const dispatchedAlerts: DispatchedAlertItem[] = [];
    const suppressedAlerts: SuppressedAlertItem[] = [];
    let eligibleCount = 0;
    let telegramSentCount = 0;
    let telegramFailedCount = 0;
    let pushQueuedCount = 0;

    // 1. Fetch active device tokens once for push broadcast if db is available and push enabled
    let activeDeviceTokens: DeviceTokenRecord[] = [];
    if (db && !options.skipPush && this.config.pushEnabled) {
      activeDeviceTokens = await queryActiveDeviceTokens(db);
    }

    // Extract non-empty push token strings
    const tokenStrings = activeDeviceTokens
      .map((d) => d.expo_token || d.token || d.apns_token || d.fcm_token)
      .filter((t): t is string => Boolean(t && t.trim().length > 0));

    // Resolve notifier
    const telegramSender = options.telegramNotifier ?? this.telegramNotifier;

    // 2. Process each opportunity
    for (const opp of opportunities) {
      // Step A: Check if active
      if (opp.is_active === 0) {
        suppressedAlerts.push({
          opportunityId: opp.id,
          pair: opp.pair,
          marketType: opp.market_type,
          baseExchange: opp.base_exchange,
          targetExchange: opp.target_exchange,
          spreadBps: opp.spread_bps,
          reason: 'inactive',
        });
        continue;
      }

      // Step B: Check threshold
      if (!this.shouldAlert(opp, thresholdConfig)) {
        suppressedAlerts.push({
          opportunityId: opp.id,
          pair: opp.pair,
          marketType: opp.market_type,
          baseExchange: opp.base_exchange,
          targetExchange: opp.target_exchange,
          spreadBps: opp.spread_bps,
          reason: 'below_threshold',
        });
        continue;
      }

      eligibleCount++;

      // Step C: Check cooldown & deduplication
      const cooldownCheck = this.checkAndRecord(opp, now);
      if (!cooldownCheck.shouldDispatch) {
        suppressedAlerts.push({
          opportunityId: opp.id,
          pair: opp.pair,
          marketType: opp.market_type,
          baseExchange: opp.base_exchange,
          targetExchange: opp.target_exchange,
          spreadBps: opp.spread_bps,
          reason: 'cooldown_suppressed',
        });
        continue;
      }

      // Step D: Dispatch Telegram Notification
      const messageText = this.formatTelegramAlert(opp);
      let telegramSent = false;

      if (!options.skipTelegram && this.config.telegramEnabled && telegramSender) {
        try {
          const priority = opp.spread_bps >= 30.0 || opp.savings_pct >= 40.0 ? 'high' : 'normal';
          const sendResult = await telegramSender.send({
            type: 'arbitrage_alert',
            title: `Arbitrage Alert: ${opp.pair} (${opp.market_type.toUpperCase()})`,
            message: messageText,
            priority,
            payload: {
              pair: opp.pair,
              market_type: opp.market_type,
              base_exchange: opp.base_exchange,
              target_exchange: opp.target_exchange,
              spread_bps: opp.spread_bps,
              savings_pct: opp.savings_pct,
              deal_id: opp.deal_id,
            },
            timestamp: new Date(now),
          });

          if (sendResult && sendResult.success !== false) {
            telegramSent = true;
            telegramSentCount++;
          } else {
            telegramFailedCount++;
          }
        } catch (err) {
          telegramFailedCount++;
        }
      }

      // Step E: Construct Mobile Push Payloads
      const pushPayloads: MobilePushPayload[] = [];
      if (!options.skipPush && this.config.pushEnabled && tokenStrings.length > 0) {
        for (const token of tokenStrings) {
          pushPayloads.push(this.formatPushPayload(opp, token));
        }

        // Custom push dispatcher or simulate push delivery
        if (options.pushDispatcher) {
          try {
            await options.pushDispatcher(pushPayloads);
          } catch (err) {
            // Log/swallow dispatcher errors
          }
        }
        pushQueuedCount += pushPayloads.length;
      }

      dispatchedAlerts.push({
        opportunityId: opp.id,
        pair: opp.pair,
        marketType: opp.market_type,
        baseExchange: opp.base_exchange,
        targetExchange: opp.target_exchange,
        spreadBps: opp.spread_bps,
        savingsPct: opp.savings_pct,
        reason: cooldownCheck.reason as 'fresh' | 'widening_bypass',
        telegramSent,
        pushCount: pushPayloads.length,
        messageText,
        pushPayloads,
      });
    }

    return {
      totalEvaluated: opportunities.length,
      eligibleCount,
      dispatchedCount: dispatchedAlerts.length,
      suppressedCount: suppressedAlerts.length,
      dispatchedAlerts,
      suppressedAlerts,
      telegramResults: {
        sent: telegramSentCount,
        failed: telegramFailedCount,
      },
      pushResults: {
        queued: pushQueuedCount,
        devicesCount: tokenStrings.length,
      },
    };
  }
}
