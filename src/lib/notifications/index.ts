/**
 * Multi-Channel Notification Service
 * Unified interface for sending notifications via Slack, Email (Resend), and Telegram
 */

import { warn as logWarn } from '@/lib/logger';
import {
  NotificationConfig,
  NotificationChannel,
  NotificationMessage,
  SendResult,
  NotificationContext,
  ChannelNotifier,
  loadConfig,
  defaultContext,
  NotificationPriority,
} from './config';

import { createSlackNotifier } from './channels/slack';
import { createEmailNotifierChannel } from './channels/email';
import { createTelegramNotifier } from './channels/telegram';
import { createWebhookNotifier } from './channels/webhook';
import { createConsoleNotifier } from './channels/console';

import { getTemplate } from './templates';
import type {
  NotificationTemplate,
  SystemAlertData,
  PayoutData,
  CommissionEarnedData,
  HealthData,
  WeeklySummaryData,
} from './templates/types';

/**
 * Rate limiter state
 */
interface RateLimitState {
  lastReset: number;
  remaining: number;
}

/**
 * Main notification service
 */
export class NotificationService {
  private config: NotificationConfig;
  private context: NotificationContext;
  private channels: Map<NotificationChannel, ChannelNotifier>;
  private rateLimits: Map<NotificationChannel, RateLimitState>;
  private templates: Map<string, NotificationTemplate>;

  constructor(config?: Partial<NotificationConfig>, context?: Partial<NotificationContext>) {
    this.config = { ...loadConfig(), ...config };
    this.context = { ...defaultContext(), ...context };

    this.channels = new Map();
    this.rateLimits = new Map();
    this.templates = new Map();

    this.initializeChannels();
    this.initializeTemplates();
  }

  /**
   * Initialize channel notifiers from config
   */
  private initializeChannels(): void {
    // Debug in test mode
    const debug = process.env.NODE_ENV === 'test';

    // Initialize Slack
    if (this.config.channels.slack?.enabled) {
      const slackConfig = this.config.channels.slack;
      if (slackConfig.webhookUrl) {
        this.channels.set('slack', createSlackNotifier(slackConfig));
        this.rateLimits.set('slack', { lastReset: Date.now(), remaining: this.config.rateLimitPerMinute });
      }
    }

    // Initialize Email
    if (this.config.channels.email?.enabled) {
      const emailConfig = this.config.channels.email;
      if (emailConfig.apiKey) {
        this.channels.set('email', createEmailNotifierChannel(emailConfig, this.context));
        this.rateLimits.set('email', { lastReset: Date.now(), remaining: this.config.rateLimitPerMinute });
      }
    }

    // Initialize Telegram
    if (this.config.channels.telegram?.enabled) {
      const telegramConfig = this.config.channels.telegram;
      if (telegramConfig.botToken && telegramConfig.chatIds.length > 0) {
        this.channels.set('telegram', createTelegramNotifier(telegramConfig));
        this.rateLimits.set('telegram', { lastReset: Date.now(), remaining: this.config.rateLimitPerMinute });
      }
    }

    // Initialize Webhook
    if (this.config.channels.webhook?.enabled) {
      const webhookConfig = this.config.channels.webhook;
      if (webhookConfig.webhookUrl) {
        this.channels.set('webhook', createWebhookNotifier(webhookConfig));
        this.rateLimits.set('webhook', { lastReset: Date.now(), remaining: this.config.rateLimitPerMinute });
      }
    }

    // Initialize Console
    if (this.config.channels.console?.enabled) {
      const consoleConfig = this.config.channels.console;
      this.channels.set('console', createConsoleNotifier(consoleConfig));
      this.rateLimits.set('console', { lastReset: Date.now(), remaining: this.config.rateLimitPerMinute });
    }
  }

  /**
   * Initialize templates
   */
  private initializeTemplates(): void {
    const allTemplates = [
      getTemplate('system-alert'),
      getTemplate('payout'),
      getTemplate('commission-earned'),
      getTemplate('health-degraded'),
      getTemplate('weekly-summary'),
    ].filter((t): t is NotificationTemplate => t !== undefined);

    for (const template of allTemplates) {
      this.templates.set(template.type, template);
    }
  }

  /**
   * Check if a channel is enabled
   */
  isChannelEnabled(channel: NotificationChannel): boolean {
    return this.channels.has(channel);
  }

  /**
   * Get list of enabled channels
   */
  getEnabledChannels(): NotificationChannel[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Check rate limit for a channel
   */
  private checkRateLimit(channel: NotificationChannel): boolean {
    const state = this.rateLimits.get(channel);
    if (!state) return true;

    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute

    // Reset if window has passed
    if (now - state.lastReset > windowMs) {
      this.rateLimits.set(channel, { lastReset: now, remaining: this.config.rateLimitPerMinute });
      return true;
    }

    if (state.remaining <= 0) {
      return false;
    }

    this.rateLimits.set(channel, {
      ...state,
      remaining: state.remaining - 1,
    });
    return true;
  }

  /**
   * Send notification to specific channels
   */
  async send(
    message: NotificationMessage | Omit<NotificationMessage, 'timestamp'>,
    channels?: NotificationChannel[]
  ): Promise<SendResult[]> {
    if (!this.config.enabled) {
      return [];
    }

    // Ensure timestamp
    const fullMessage: NotificationMessage = {
      ...(message as NotificationMessage),
      timestamp: ('timestamp' in message && message.timestamp) ? message.timestamp : new Date(),
    };

    // Determine which channels to use
    const targetChannels = channels || this.getEnabledChannels();

    const results: SendResult[] = [];
    const debug = process.env.NODE_ENV === 'test';

for (const channel of targetChannels) {
  if (!this.isChannelEnabled(channel)) {
    logWarn(`Notification channel '${channel}' is not configured`);
    continue;
  }

  // Check rate limit
  if (!this.checkRateLimit(channel)) {
    results.push({
      success: false,
      channel,
      error: 'Rate limit exceeded',
      timestamp: new Date(),
    });
    continue;
  }

  const notifier = this.channels.get(channel);
  if (!notifier) {
    continue;
  }

  const result = await notifier.send(fullMessage);
  results.push(result);
}
  return results;
}

  /**
   * Send a templated notification
   */
  async sendTemplate<T>(
    type: string,
    data: T,
    options?: {
      priority?: NotificationPriority;
      channels?: NotificationChannel[];
      context?: Partial<NotificationContext>;
    }
  ): Promise<SendResult[]> {
    const template = this.templates.get(type);

    if (!template) {
      throw new Error(`Unknown template type: ${type}`);
    }

    const mergedContext = { ...this.context, ...options?.context };
    const { title, message, payload } = template.render(mergedContext, data as Record<string, unknown>);

    return this.send(
      {
        type,
        title,
        message,
        priority: options?.priority || this.config.defaultPriority,
        payload,
        metadata: {
          ...mergedContext,
          template: type,
        },
      },
      options?.channels
    );
  }

  /**
   * Convenience method for system alerts
   */
  async sendSystemAlert(data: SystemAlertData & { message?: string }, customMessage?: string): Promise<SendResult[]> {
    return this.sendTemplate('system-alert', {
      ...data,
      message: customMessage || buildDefaultAlertMessage(data),
    });
  }

  /**
   * Convenience method for payout notifications
   */
  async sendPayoutNotification(data: PayoutData): Promise<SendResult[]> {
    return this.sendTemplate('payout', data, { priority: 'normal' });
  }

  /**
   * Convenience method for commission earned
   */
  async sendCommissionEarned(data: CommissionEarnedData): Promise<SendResult[]> {
    return this.sendTemplate('commission-earned', data, { priority: 'low' });
  }

  /**
   * Convenience method for health alerts
   */
  async sendHealthAlert(data: HealthData): Promise<SendResult[]> {
    const priority: NotificationPriority = data.severity === 'critical' || data.severity === 'high' ? 'high' : 'normal';
    return this.sendTemplate('health-degraded', data, { priority });
  }

  /**
   * Convenience method for weekly summary
   */
  async sendWeeklySummary(data: WeeklySummaryData): Promise<SendResult[]> {
    return this.sendTemplate('weekly-summary', data, { priority: 'normal' });
  }

  /**
   * Send custom notification (non-templated)
   */
  async sendCustom(
    title: string,
    message: string,
    payload: Record<string, unknown> = {},
    options?: {
      priority?: NotificationPriority;
      channels?: NotificationChannel[];
    }
  ): Promise<SendResult[]> {
    return this.send({
      type: 'custom',
      title,
      message,
      priority: options?.priority || this.config.defaultPriority,
      payload,
    }, options?.channels);
  }

  /**
   * Get notification context
   */
  getContext(): NotificationContext {
    return this.context;
  }

  /**
   * Update context
   */
  updateContext(context: Partial<NotificationContext>): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Get configuration
   */
  getConfig(): NotificationConfig {
    return this.config;
  }

  /**
   * Check if a channel is enabled
   */
  hasChannel(channel: NotificationChannel): boolean {
    return this.isChannelEnabled(channel);
  }

  /**
   * Reload configuration from environment
   */
  reload(): void {
    this.config = loadConfig();
    this.channels.clear();
    this.initializeChannels();
  }
}

/**
 * Build default alert message from system alert data
 */
function buildDefaultAlertMessage(data: SystemAlertData): string {
  const severity = data.severity || 'warning';
  const emoji = getSeverityEmoji(severity);

  let msg = `${emoji} ${data.alertName || data.metricName || 'System Alert'}\n\n`;

  if (data.details) {
    msg += `${data.details}\n\n`;
  }

  if (data.currentValue !== undefined && data.thresholdValue !== undefined) {
    msg += `Current: ${data.currentValue}\n`;
    msg += `Threshold: ${data.thresholdValue}\n`;
  }

  if (data.error) {
    msg += `\nError: ${data.error}`;
  }

  return msg;
}

/**
 * Get emoji based on severity
 */
function getSeverityEmoji(severity: string): string {
  switch (severity?.toLowerCase()) {
    case 'critical':
      return '🚨';
    case 'high':
      return '⚠️';
    case 'warning':
      return '🔶';
    case 'info':
      return 'ℹ️';
    default:
      return '📢';
  }
}

/**
 * Create notification service instance with default config
 */
export function createNotificationService(
  config?: Partial<NotificationConfig>,
  context?: Partial<NotificationContext>
): NotificationService {
  return new NotificationService(config, context);
}

/**
 * Singleton instance for convenience
 */
let singletonInstance: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!singletonInstance) {
    singletonInstance = new NotificationService();
  }
  return singletonInstance;
}

/**
 * Reset singleton (for testing only)
 */
export function __resetNotificationServiceSingleton(): void {
  singletonInstance = null;
}

// Export types
export type { SystemAlertData, PayoutData, CommissionEarnedData, HealthData, WeeklySummaryData };
