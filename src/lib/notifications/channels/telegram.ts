/**
 * Telegram Notification Channel
 * Sends notifications to Telegram chats via Bot API with retry logic
 */

import { TelegramConfig, NotificationMessage, SendResult } from '../config';
import { withRetry, DEFAULT_RETRY_CONFIG } from '../retry';

/**
 * Telegram message entity for formatting
 */
interface TelegramMessageEntity {
  type: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'pre' | 'text_link' | 'user_mention';
  offset: number;
  length: number;
  url?: string;
  user?: { id: number; first_name: string };
}

/**
 * Telegram send message response
 */
interface TelegramResponse {
  ok: boolean;
  result: {
    message_id: number;
    chat: { id: number; type: string; title?: string; username?: string };
    date: number;
    text: string;
  };
  description?: string;
}

/**
 * Priority to Telegram emoji mapping
 */
const PRIORITY_EMOJI: Record<string, string> = {
  low: '🔵',
  normal: '✅',
  high: '🟡',
  critical: '🔴',
};

/**
 * Telegram channel sender
 */
export class TelegramNotifier {
  private config: TelegramConfig;
  private apiBaseUrl: string;
  private retryConfig: Required<import('../retry').RetryConfig>;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.apiBaseUrl = `https://api.telegram.org/bot${config.botToken}`;
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
   * Send notification to Telegram chat(s) with retry
   */
  async send(message: NotificationMessage): Promise<SendResult> {
    const startTime = Date.now();

    try {
      const result = await withRetry(
        async () => {
          const text = this.buildMessageText(message);
          const parseMode = this.config.parseMode;
          const messageIds: string[] = [];

          // Send to all configured chat IDs (no retry per chat, but whole operation is retryable)
          for (const chatId of this.config.chatIds) {
            const result = await this.sendToChat(chatId, text, parseMode);
            messageIds.push(result);

            // Small delay between messages to avoid rate limiting
            if (this.config.chatIds.length > 1) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }

          // Return first message ID as identifier
          return messageIds[0] || `telegram-${Date.now()}`;
        },
        this.retryConfig,
        (attempt, error, delayMs) => {
        }
      );

      if (result.success) {
        return {
          success: true,
          channel: 'telegram',
          messageId: result.value,
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
          channel: 'telegram',
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
      console.error('[TelegramNotifier] Unexpected error:', errorMessage);

      return {
        success: false,
        channel: 'telegram',
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
   * Send message to a specific chat - returns message ID string
   */
  private async sendToChat(
    chatId: string,
    text: string,
    parseMode?: string
  ): Promise<string> {
    const params = new URLSearchParams({
      chat_id: chatId,
      text: text,
      disable_web_page_preview: String(this.config.disableWebPagePreview),
    });

    if (parseMode) {
      params.append('parse_mode', parseMode);
    }

    const response = await fetch(`${this.apiBaseUrl}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });

    const data: TelegramResponse = await response.json();

    if (!data.ok) {
      throw new Error(data.description || 'Telegram API error');
    }

    return String(data.result.message_id);
  }

  /**
   * Build formatted Telegram message text
   */
  private buildMessageText(message: NotificationMessage): string {
    const { title, message: msg, payload, priority, metadata, timestamp } = message;
    const locale = (metadata?.locale as 'vi' | 'en') || 'en';

    const emoji = PRIORITY_EMOJI[priority] || PRIORITY_EMOJI.normal;
    const envLabel = this.getEnvironmentLabel(metadata?.environment as string);
    const timeStr = timestamp?.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US') || new Date().toLocaleString();

    let text = `${emoji} *${this.escapeMarkdown(title)}*\n\n`;
    text += `${msg}\n\n`;

    // Add priority/environment line
    text += `📊 ${this.escapeMarkdown(envLabel)}\n`;
    text += `🕐 ${this.escapeMarkdown(timeStr)}\n\n`;

    // Add details from payload
    const details = this.formatPayloadDetails(payload, locale);
    if (details) {
      text += `*${locale === 'vi' ? 'Chi tiết' : 'Details'}*\n${details}\n\n`;
    }

    // Add action links
    const actions = this.formatActionLinks(payload, locale);
    if (actions) {
      text += actions;
    }

    // Add footer
    text += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🌐 ${this.escapeMarkdown(metadata?.baseUrl as string || 'ApexOS')}`;

    return text;
  }

  /**
   * Format payload as detail lines
   */
  private formatPayloadDetails(
    payload: Record<string, unknown>,
    locale: 'vi' | 'en'
  ): string | null {
    const excludeKeys = ['actions', 'links'];
    const entries = Object.entries(payload)
      .filter(([key]) => !excludeKeys.includes(key))
      .filter(([, value]) => value !== undefined && value !== null);

    if (entries.length === 0) {
      return null;
    }

    const labels: Record<string, Record<string, string>> = {
      en: {
        deal: 'Deal',
        exchange: 'Exchange',
        tradeVolume: 'Trade Volume',
        commission: 'Commission',
        tier: 'Tier',
        status: 'Status',
        walletAddress: 'Wallet',
        transactionHash: 'Transaction',
        amount: 'Amount',
        conversions: 'Conversions',
        referrals: 'Active Referrals',
        earnings: 'Earnings',
        threshold: 'Threshold',
        currentValue: 'Current Value',
        metric: 'Metric',
        error: 'Error',
        endpoint: 'Endpoint',
      },
      vi: {
        deal: 'Giao dịch',
        exchange: 'Sàn giao dịch',
        tradeVolume: 'Khối lượng giao dịch',
        commission: 'Hoa hồng',
        tier: 'Cấp',
        status: 'Trạng thái',
        walletAddress: 'Ví',
        transactionHash: 'Mã giao dịch',
        amount: 'Số tiền',
        conversions: 'Giao dịch',
        referrals: 'Giới thiệu đang hoạt động',
        earnings: 'Thu nhập',
        threshold: 'Ngưỡng',
        currentValue: 'Giá trị hiện tại',
        metric: 'Số liệu',
        error: 'Lỗi',
        endpoint: 'Endpoint',
      },
    };

    return entries
      .map(([key, value]) => {
        const label = labels[locale]?.[key] || this.formatFieldTitle(key);
        const formattedValue = this.formatValue(key, value);
        return `• *${label}*: ${formattedValue}`;
      })
      .join('\n');
  }

  /**
   * Format action links
   */
  private formatActionLinks(
    payload: Record<string, unknown>,
    locale: 'vi' | 'en'
  ): string | null {
    const actions = payload.actions as Array<{ label: string; url: string }> | undefined;

    if (!actions || actions.length === 0) {
      return null;
    }

    const actionLabels: Record<string, string> = locale === 'vi'
      ? { viewDashboard: 'Xem bảng điều khiển', viewDetails: 'Xem chi tiết', manage: 'Quản lý', docs: 'Tài liệu' }
      : { viewDashboard: 'View Dashboard', viewDetails: 'View Details', manage: 'Manage', docs: 'Documentation' };

    return '\n' + actions
      .map(action => `[${this.escapeMarkdown(action.label)}](${this.escapeMarkdown(action.url)})`)
      .join(' | ');
  }

  /**
   * Format value for display
   */
  private formatValue(key: string, value: unknown): string {
    if (value === null || value === undefined) return '-';

    if (typeof value === 'number') {
      // Format currency-like fields with dollar sign
      const currencyKeys = ['amount', 'tradeVolume', 'volume', 'earnings', 'totalEarnings', 'commission', 'threshold', 'currentValue'];
      if (currencyKeys.some(k => key.toLowerCase().includes(k.toLowerCase()))) {
        return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
      return value.toLocaleString();
    }

    if (value instanceof Date) {
      return value.toLocaleString();
    }

    if (typeof value === 'boolean') {
      return value ? (this.getLocaleString('yes', 'Yes')) : (this.getLocaleString('no', 'No'));
    }

    const str = String(value);
    // Shorten long strings (hashes, addresses)
    if (str.length > 50 && (str.includes('0x') || str.includes('GA') || str.includes('ABCDEF'))) {
      return `${str.slice(0, 12)}...${str.slice(-8)}`;
    }
    if (str.length > 100) {
      return str.slice(0, 97) + '...';
    }
    return str;
  }

  /**
   * Get localized string
   */
  private getLocaleString(key: string, fallback: string): string {
    // Simple locale detection from chat context - default to English
    return fallback;
  }

  /**
   * Format field title
   */
  private formatFieldTitle(key: string): string {
    return key
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  }

  /**
   * Escape Markdown special characters
   */
  private escapeMarkdown(text: string): string {
    // Escape characters that have special meaning in Markdown
    const escapeChars = /[_*\[\]()~`>#+=|{}.!-]/g;
    return text.replace(escapeChars, '\\$&');
  }

  /**
   * Get environment label
   */
  private getEnvironmentLabel(environment?: string): string {
    const env = environment || 'production';

    const labels: Record<string, { vi: string; en: string }> = {
      production: { vi: '🏢 Sản xuất', en: '🏢 Production' },
      staging: { vi: '🧪 Staging', en: '🧪 Staging' },
      development: { vi: '💻 Phát triển', en: '💻 Development' },
    };

    // Default to English (could detect from chat context)
    return labels[env]?.en || `🌍 ${env}`;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get configuration
   */
  getConfig(): TelegramConfig {
    return this.config;
  }
}

/**
 * Create Telegram notifier instance
 */
export function createTelegramNotifier(config: TelegramConfig): TelegramNotifier {
  return new TelegramNotifier(config);
}
