/**
 * Slack Notification Channel
 * Sends notifications to Slack via webhook with retry logic
 */

import { SlackConfig, NotificationMessage, SendResult } from '../config';
import { error as logError } from '@/lib/logger';
import { withRetry, DEFAULT_RETRY_CONFIG } from '../retry';

/**
 * Slack message attachment for rich formatting
 */
export interface SlackAttachment {
  color?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: Array<{ title: string; value: string; short?: boolean }>;
  actions?: Array<{ type: string; text: string; url?: string }>;
  footer?: string;
  footer_icon?: string;
  ts?: number;
}

/**
 * Slack webhook payload
 */
interface SlackPayload {
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
  channel?: string;
  text?: string;
  attachments?: SlackAttachment[];
}

/**
 * Priority to Slack color mapping
 */
const PRIORITY_COLORS: Record<string, string> = {
  low: '#6b7280', // gray
  normal: '#3b82f6', // blue
  high: '#f59e0b', // orange
  critical: '#ef4444', // red
};

/**
 * Slack channel sender
 */
export class SlackNotifier {
  private config: SlackConfig;
  private retryConfig: Required<import('../retry').RetryConfig>;

  constructor(config: SlackConfig) {
    this.config = config;
    // Get retry config from environment or use defaults
    const retryMaxAttempts = parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10);
    const retryBackoffMs = parseInt(process.env.NOTIFICATION_RETRY_BACKOFF || '1000', 10);
    this.retryConfig = {
      maxAttempts: retryMaxAttempts,
      backoffMs: retryBackoffMs,
      maxBackoffMs: 30000,
      retryablePatterns: DEFAULT_RETRY_CONFIG.retryablePatterns,
      nonRetryablePatterns: DEFAULT_RETRY_CONFIG.nonRetryablePatterns,
    };
  }

  /**
   * Send notification to Slack with retry
   */
  async send(message: NotificationMessage): Promise<SendResult> {
    const startTime = Date.now();

    try {
      const result = await withRetry(
        async () => {
          const response = await this.sendInternal(message);
          return response;
        },
        this.retryConfig,
        (attempt, error, delayMs) => {
        }
      );

      if (result.success) {
        return {
          success: true,
          channel: 'slack',
          messageId: result.value || `slack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date(),
          retry: {
            attempts: result.attempts,
            totalDurationMs: result.totalDurationMs,
            errors: result.errors.map(e => e.message),
          },
        };
      } else {
        return {
          success: false,
          channel: 'slack',
          error: result.errors[result.errors.length - 1]?.message || 'Failed after retries',
          timestamp: new Date(),
          retry: {
            attempts: result.attempts,
            totalDurationMs: result.totalDurationMs,
            errors: result.errors.map(e => e.message),
          },
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logError('[SlackNotifier] Unexpected error:', errorMessage);

      return {
        success: false,
        channel: 'slack',
        error: errorMessage,
        timestamp: new Date(),
        retry: {
          attempts: 1,
          totalDurationMs: Date.now() - startTime,
          errors: [errorMessage],
        },
      };
    }
  }

  /**
   * Internal send without retry logic
   */
  private async sendInternal(message: NotificationMessage): Promise<string> {
    const payload = this.buildPayload(message);

    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Slack webhook failed: ${response.status} - ${errorText}`);
    }

    return `slack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Build Slack payload from notification message
   */
  private buildPayload(message: NotificationMessage): SlackPayload {
    const { title, message: msg, payload: customPayload, priority, metadata } = message;

    // Build attachments with actionable links
    const attachments: SlackAttachment[] = [];

    // Main attachment with details
    const mainAttachment: SlackAttachment = {
      color: PRIORITY_COLORS[priority] || PRIORITY_COLORS.normal,
      title,
      text: msg,
      footer: `ApexOS ${metadata?.environment || 'production'}`,
      ts: Math.floor((message.timestamp?.getTime() || Date.now()) / 1000),
    };

    // Add fields from payload if available
    if (customPayload && typeof customPayload === 'object') {
      const fields: SlackAttachment['fields'] = [];

      // Add key-value pairs from payload
      for (const [key, value] of Object.entries(customPayload)) {
        if (key === 'actions' || key === 'links') continue;

        const formattedValue = this.formatValue(value);
        if (formattedValue) {
          fields.push({
            title: this.formatFieldTitle(key),
            value: formattedValue,
            short: true,
          });
        }
      }

      if (fields.length > 0) {
        mainAttachment.fields = fields;
      }

      // Add action buttons from links
      if (customPayload.actions && Array.isArray(customPayload.actions)) {
        const actions = customPayload.actions.map(action => ({
          type: 'button' as const,
          text: action.label,
          url: action.url,
        }));

        if (actions.length > 0) {
          mainAttachment.actions = actions;
        }
      }

      // Add direct links
      if (customPayload.links && typeof customPayload.links === 'object') {
        const linkActions = Object.entries(customPayload.links as Record<string, string>).map(
          ([label, url]) => ({
            type: 'button' as const,
            text: label,
            url,
          })
        );

        if (mainAttachment.actions) {
          mainAttachment.actions.push(...linkActions);
        } else {
          mainAttachment.actions = linkActions;
        }
      }
    }

    attachments.push(mainAttachment);

    return {
      username: this.config.username,
      icon_emoji: this.config.iconEmoji,
      icon_url: this.config.iconUrl,
      channel: this.config.channel,
      attachments,
    };
  }

  /**
   * Format field value for Slack
   */
  private formatValue(value: unknown): string {
    if (value === null || value === undefined) return '-';

    if (typeof value === 'number') {
      return value.toLocaleString();
    }

    if (value instanceof Date) {
      return value.toLocaleString();
    }

    if (typeof value === 'boolean') {
      return value ? 'Yes' : 'No';
    }

    const str = String(value);
    return str.length > 200 ? str.slice(0, 197) + '...' : str;
  }

  /**
   * Format field title (camelCase/snake_case to Title Case)
   * Only capitalizes the first letter, preserves case for rest
   * e.g., "wallet_address" -> "Wallet address"
   * e.g., "walletAddress" -> "Wallet Address"
   */
  private formatFieldTitle(key: string): string {
    return key
      .trim()
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  }

  /**
   * Escape Slack markdown special characters
   * Slack mrkdwn requires escaping: _ * [ ] ( ) ~ ` > # + = | { } . ! -
   */
  private escapeMarkdown(text: string): string {
    // Escape backslash first to avoid double-escaping
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/_/g, '\\_')
      .replace(/\*/g, '\\*')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/~/g, '\\~')
      .replace(/`/g, '\\`')
      .replace(/>/g, '\\>')
      .replace(/#/g, '\\#')
      .replace(/\+/g, '\\+')
      .replace(/=/g, '\\=')
      .replace(/\|/g, '\\|')
      .replace(/{/g, '\\{')
      .replace(/}/g, '\\}')
      .replace(/\./g, '\\.')
      .replace(/!/g, '\\!')
      .replace(/-/g, '\\-');
    return escaped;
  }

  /**
   * Get configuration
   */
  getConfig(): SlackConfig {
    return this.config;
  }
}

/**
 * Create Slack notifier instance
 */
export function createSlackNotifier(config: SlackConfig): SlackNotifier {
  return new SlackNotifier(config);
}
