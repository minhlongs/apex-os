/**
 * Telegram Notification Channel
 * Sends notifications to Telegram chats via Bot API with retry logic.
 * Supports both broadcast channels and personal direct user messaging.
 */

import { TelegramConfig, NotificationMessage, SendResult } from '../config';
import { error as logError, warn as logWarn, info as logInfo } from '@/lib/logger';
import { withRetry, DEFAULT_RETRY_CONFIG } from '../retry';
import type { D1Database } from '@/lib/db';

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
  result?: {
    message_id: number;
    chat: { id: number; type: string; title?: string; username?: string };
    date: number;
    text: string;
  };
  description?: string;
  error_code?: number;
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
 * Options for direct chat messages
 */
export interface DirectMessageOptions {
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  replyMarkup?: any;
  disableWebPagePreview?: boolean;
}

/**
 * Result returned from direct chat message dispatch
 */
export interface DirectMessageResult {
  ok: boolean;
  messageId?: number;
  description?: string;
  error?: string;
}

/**
 * Parameters for celebratory cashback confirmation notification
 */
export interface CashbackConfirmationParams {
  telegramId: number | string;
  amount: number;
  currency: string;
  merchant: string;
  txId?: string;
  cashbackPct?: number;
}

/**
 * Parameters for social referral activation notification
 */
export interface ReferralActivationParams {
  referrerTelegramId: number | string;
  refereeName: string;
  rewardAmount: number;
  currency?: string;
  totalReferrals?: number;
}

/**
 * Parameters for payout dispatch notification
 */
export interface PayoutDispatchParams {
  telegramId: number | string;
  amount: number;
  currency: string;
  destinationWallet?: string;
  txHash?: string;
  chain?: string;
}

/**
 * Resolves telegram_id from telegram_users by user_id
 */
export async function resolveUserTelegramId(
  db: D1Database,
  userId: string
): Promise<number | null> {
  if (!db || !userId) {
    return null;
  }
  try {
    const stmt = db.prepare('SELECT telegram_id FROM telegram_users WHERE user_id = ? LIMIT 1');
    const result = await stmt.bind(userId).first<{ telegram_id: number | string }>();
    if (!result || result.telegram_id === null || result.telegram_id === undefined) {
      return null;
    }
    const tid = Number(result.telegram_id);
    return isNaN(tid) ? null : tid;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[TelegramNotifier] Error resolving telegram_id for user ${userId}: ${msg}`);
    return null;
  }
}

/**
 * Telegram channel sender supporting broadcast notifications and direct chat messaging
 */
export class TelegramNotifier {
  private config: TelegramConfig;
  private apiBaseUrl: string;
  private retryConfig: Required<import('../retry').RetryConfig>;

  constructor(config?: Partial<TelegramConfig>) {
    const resolvedConfig: TelegramConfig = {
      botToken: config?.botToken || process.env.TELEGRAM_BOT_TOKEN || '',
      chatIds: config?.chatIds || [],
      parseMode: config?.parseMode,
      disableWebPagePreview: config?.disableWebPagePreview,
    };

    this.config = resolvedConfig;
    this.apiBaseUrl = `https://api.telegram.org/bot${resolvedConfig.botToken}`;
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
   * Send notification to Telegram channel/group chat(s) with retry
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
      logError('[TelegramNotifier] Unexpected error:', errorMessage);

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
   * Send direct message to a user via Telegram Bot API POST /sendMessage.
   * Handles HTTP 403 (blocked/not started) and HTTP 429 (rate limits) gracefully without throwing.
   */
  async sendDirectMessage(
    telegramId: number | string,
    text: string,
    options?: DirectMessageOptions
  ): Promise<DirectMessageResult> {
    if (!telegramId) {
      return { ok: false, error: 'Missing telegramId' };
    }

    const token = this.config?.botToken || process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token.trim().length === 0) {
      logWarn('[TelegramNotifier] Missing Telegram bot token for direct message');
      return { ok: false, error: 'Missing bot token', description: 'Missing bot token' };
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload: Record<string, unknown> = {
      chat_id: telegramId,
      text: text,
      parse_mode: options?.parseMode || 'Markdown',
      disable_web_page_preview: options?.disableWebPagePreview ?? false,
    };

    if (options?.replyMarkup) {
      payload.reply_markup = options.replyMarkup;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data: TelegramResponse | null = await response.json().catch(() => null);

      if (response.status === 403) {
        const desc = data?.description || 'Forbidden: user blocked bot or chat not started';
        logWarn(`[TelegramNotifier] User ${telegramId} blocked bot or chat not started (HTTP 403): ${desc}`);
        return {
          ok: false,
          error: desc,
          description: desc,
        };
      }

      if (response.status === 429) {
        const desc = data?.description || 'Too Many Requests: rate limited';
        logWarn(`[TelegramNotifier] Rate limited by Telegram API (HTTP 429) sending to ${telegramId}: ${desc}`);
        return {
          ok: false,
          error: desc,
          description: desc,
        };
      }

      if (!response.ok || (data && !data.ok)) {
        const errorDesc = data?.description || `HTTP ${response.status} error`;
        logWarn(`[TelegramNotifier] Telegram API error sending to ${telegramId}: ${errorDesc}`);
        return {
          ok: false,
          error: errorDesc,
          description: data?.description,
        };
      }

      return {
        ok: true,
        messageId: data?.result?.message_id,
        description: data?.description,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError(`[TelegramNotifier] Network exception sending direct message to ${telegramId}: ${errMsg}`);
      return {
        ok: false,
        error: errMsg,
        description: errMsg,
      };
    }
  }

  /**
   * Send celebratory cashback confirmation message with emojis, amount, merchant, and TMA button
   */
  async sendCashbackConfirmation(
    params: CashbackConfirmationParams
  ): Promise<DirectMessageResult> {
    const { telegramId, amount, currency, merchant, txId, cashbackPct } = params;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://apexos.io';

    const formattedAmount = typeof amount === 'number' ? amount.toFixed(2) : String(amount);
    const formattedCurrency = currency ? currency.toUpperCase() : 'USD';

    let message = `🎉 *Cashback Confirmed!* 💎\n\n`;
    message += `You have successfully earned cashback on your recent transaction!\n\n`;
    message += `💰 *Amount Earned:* $${formattedAmount} ${formattedCurrency}\n`;
    message += `🏪 *Merchant / Exchange:* ${this.escapeMarkdown(merchant)}\n`;
    if (cashbackPct !== undefined && cashbackPct !== null) {
      message += `📈 *Cashback Rate:* ${cashbackPct}%\n`;
    }
    if (txId) {
      const shortTx = txId.length > 16 ? `${txId.slice(0, 8)}...${txId.slice(-6)}` : txId;
      message += `🔗 *Transaction ID:* \`${shortTx}\`\n`;
    }
    message += `\nYour funds are available in your ApexOS balance. Tap below to launch the Mini App!`;

    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: '🚀 Open ApexOS Mini App',
            web_app: { url: `${baseUrl}/en/telegram/app?tab=earnings` },
          },
        ],
      ],
    };

    return this.sendDirectMessage(telegramId, message, {
      parseMode: 'Markdown',
      replyMarkup,
      disableWebPagePreview: true,
    });
  }

  /**
   * Send notification to referrer announcing new referee signup and earned bonus
   */
  async sendReferralActivation(
    params: ReferralActivationParams
  ): Promise<DirectMessageResult> {
    const { referrerTelegramId, refereeName, rewardAmount, currency = 'USD', totalReferrals } = params;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://apexos.io';

    const formattedAmount = typeof rewardAmount === 'number' ? rewardAmount.toFixed(2) : String(rewardAmount);
    const formattedCurrency = currency.toUpperCase();

    let message = `🎉 *New Referral Activated!* 🤝\n\n`;
    message += `Great news! *${this.escapeMarkdown(refereeName)}* just joined ApexOS using your referral link.\n\n`;
    message += `💰 *Bonus Earned:* $${formattedAmount} ${formattedCurrency}\n`;
    if (totalReferrals !== undefined && totalReferrals !== null) {
      message += `👥 *Total Active Referrals:* ${totalReferrals}\n`;
    }
    message += `\n🏆 You're moving up the referral leaderboard! Tap below to track your rank and rewards.`;

    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: '🏆 View Leaderboard',
            web_app: { url: `${baseUrl}/en/telegram/app?tab=leaderboard` },
          },
        ],
      ],
    };

    return this.sendDirectMessage(referrerTelegramId, message, {
      parseMode: 'Markdown',
      replyMarkup,
      disableWebPagePreview: true,
    });
  }

  /**
   * Send payout dispatch notification with wallet, amount, and explorer link
   */
  async sendPayoutDispatch(
    params: PayoutDispatchParams
  ): Promise<DirectMessageResult> {
    const { telegramId, amount, currency, destinationWallet, txHash, chain } = params;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://apexos.io';

    const formattedAmount = typeof amount === 'number' ? amount.toFixed(2) : String(amount);
    const formattedCurrency = currency ? currency.toUpperCase() : 'USD';

    let message = `💸 *Payout Dispatched!* ⚡\n\n`;
    message += `Your earnings payout has been successfully processed and sent to your wallet.\n\n`;
    message += `💰 *Amount Paid:* $${formattedAmount} ${formattedCurrency}\n`;

    if (destinationWallet) {
      const truncatedWallet = destinationWallet.length > 12
        ? `${destinationWallet.slice(0, 6)}...${destinationWallet.slice(-4)}`
        : destinationWallet;
      message += `👛 *Destination Wallet:* \`${truncatedWallet}\`\n`;
    }

    if (txHash) {
      let explorerUrl = `https://etherscan.io/tx/${txHash}`;
      const normalizedChain = chain?.toLowerCase();
      if (normalizedChain === 'solana') {
        explorerUrl = `https://solscan.io/tx/${txHash}`;
      } else if (normalizedChain === 'stellar') {
        explorerUrl = `https://stellar.expert/explorer/public/tx/${txHash}`;
      }
      const shortHash = txHash.length > 14 ? `${txHash.slice(0, 8)}...${txHash.slice(-6)}` : txHash;
      message += `🔗 *Transaction Hash:* [${shortHash}](${explorerUrl})\n`;
    }

    message += `\nThank you for using ApexOS! Tap below to view your full wallet and payout history.`;

    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: '📊 View Wallet & History',
            web_app: { url: `${baseUrl}/en/telegram/app?tab=earnings` },
          },
        ],
      ],
    };

    return this.sendDirectMessage(telegramId, message, {
      parseMode: 'Markdown',
      replyMarkup,
      disableWebPagePreview: true,
    });
  }

  /**
   * Resolves telegram_id from telegram_users by user_id
   */
  async resolveUserTelegramId(db: D1Database, userId: string): Promise<number | null> {
    return resolveUserTelegramId(db, userId);
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

    return String(data.result?.message_id);
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
 * Standalone direct message function
 */
export async function sendDirectMessage(
  telegramId: number | string,
  text: string,
  options?: DirectMessageOptions,
  botToken?: string
): Promise<DirectMessageResult> {
  const token = botToken || process.env.TELEGRAM_BOT_TOKEN || '';
  const notifier = new TelegramNotifier({ botToken: token, chatIds: [] });
  return notifier.sendDirectMessage(telegramId, text, options);
}

/**
 * Standalone cashback confirmation function
 */
export async function sendCashbackConfirmation(
  params: CashbackConfirmationParams,
  botToken?: string
): Promise<DirectMessageResult> {
  const token = botToken || process.env.TELEGRAM_BOT_TOKEN || '';
  const notifier = new TelegramNotifier({ botToken: token, chatIds: [] });
  return notifier.sendCashbackConfirmation(params);
}

/**
 * Standalone referral activation notification function
 */
export async function sendReferralActivation(
  params: ReferralActivationParams,
  botToken?: string
): Promise<DirectMessageResult> {
  const token = botToken || process.env.TELEGRAM_BOT_TOKEN || '';
  const notifier = new TelegramNotifier({ botToken: token, chatIds: [] });
  return notifier.sendReferralActivation(params);
}

/**
 * Standalone payout dispatch notification function
 */
export async function sendPayoutDispatch(
  params: PayoutDispatchParams,
  botToken?: string
): Promise<DirectMessageResult> {
  const token = botToken || process.env.TELEGRAM_BOT_TOKEN || '';
  const notifier = new TelegramNotifier({ botToken: token, chatIds: [] });
  return notifier.sendPayoutDispatch(params);
}

/**
 * Create Telegram notifier instance
 */
export function createTelegramNotifier(config?: Partial<TelegramConfig>): TelegramNotifier {
  return new TelegramNotifier(config);
}
