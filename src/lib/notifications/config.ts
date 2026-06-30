/**
 * Notification System Configuration
 * Multi-channel notification support: Slack, Email (Resend), Telegram
 */

/**
 * Notification channel types
 */
export type NotificationChannel = 'slack' | 'email' | 'telegram' | 'webhook' | 'console';

/**
 * Notification priority levels
 */
export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Base notification message structure
 */
export interface NotificationMessage {
  /** Unique identifier for the notification */
  id?: string;
  /** Notification type/category */
  type: string;
  /** Human-readable title */
  title: string;
  /** Main message content (plain text) */
  message: string;
  /** Priority level */
  priority: NotificationPriority;
  /** Channel-specific payload */
  payload: Record<string, unknown>;
  /** Timestamp of the event */
  timestamp?: Date;
  /** Metadata for context */
  metadata?: Record<string, unknown>;
}

/**
 * Channel-specific configuration
 */
export interface ChannelConfig {
  /** Channel type */
  channel: NotificationChannel;
  /** Whether this channel is enabled */
  enabled: boolean;
  /** Channel-specific configuration */
  config: Record<string, unknown>;
}

/**
 * Notifier interface for channels
 */
export interface ChannelNotifier {
  send(message: NotificationMessage): Promise<SendResult>;
}

/**
 * Slack-specific configuration
 */
export interface SlackConfig {
  /** Whether Slack channel is enabled */
  enabled?: boolean;
  /** Slack webhook URL */
  webhookUrl: string;
  /** Default channel/username */
  channel?: string;
  /** Bot username */
  username?: string;
  /** Icon emoji or URL */
  iconEmoji?: string;
  /** Icon URL */
  iconUrl?: string;
}

/**
 * Email-specific configuration (Resend)
 */
export interface EmailConfig {
  /** Whether email channel is enabled */
  enabled?: boolean;
  /** Resend API key */
  apiKey: string;
  /** From email address */
  fromEmail: string;
  /** From name */
  fromName: string;
  /** Default recipient(s) for system notifications */
  defaultRecipients: string[];
  /** Reply-to address */
  replyTo?: string;
}

/**
 * Telegram-specific configuration
 */
export interface TelegramConfig {
  /** Whether Telegram channel is enabled */
  enabled?: boolean;
  /** Telegram bot token */
  botToken: string;
  /** Default chat ID(s) for notifications */
  chatIds: string[];
  /** Parse mode: 'HTML' or 'Markdown' */
  parseMode?: 'HTML' | 'Markdown';
  /** Disable web page preview */
  disableWebPagePreview?: boolean;
}

/**
 * Webhook-specific configuration
 */
export interface WebhookConfig {
  /** Whether webhook channel is enabled */
  enabled?: boolean;
  /** Webhook URL */
  webhookUrl: string;
  /** Custom headers to include */
  headers?: Record<string, string>;
  /** Payload format: 'full' (default) or 'flat' */
  payloadFormat?: 'full' | 'flat';
}

/**
 * Console-specific configuration
 */
export interface ConsoleConfig {
  /** Whether console channel is enabled */
  enabled?: boolean;
  /** Console log level */
  logLevel?: 'log' | 'info' | 'warn';
}

/**
 * Global notification configuration
 */
export interface NotificationConfig {
  /** Environment (development, staging, production) */
  environment: 'development' | 'staging' | 'production';
  /** Whether notifications are globally enabled */
  enabled: boolean;
  /** Channel configurations */
  channels: {
    slack?: SlackConfig;
    email?: EmailConfig;
    telegram?: TelegramConfig;
    webhook?: WebhookConfig;
    console?: ConsoleConfig;
  };
  /** Default priority for system notifications */
  defaultPriority: NotificationPriority;
  /** Rate limiting: max notifications per minute per channel */
  rateLimitPerMinute: number;
  /** Retry configuration */
  retries: {
    maxAttempts: number;
    backoffMs: number;
  };
  /** Template configuration */
  templates: {
    baseUrl: string;
    locale: 'vi' | 'en';
  };
}

/**
 * Channel send result
 */
export interface SendResult {
  success: boolean;
  channel: NotificationChannel;
  messageId?: string;
  error?: string;
  timestamp: Date;
  /** Retry information */
  retry?: {
    attempts: number;
    totalDurationMs: number;
    errors: string[];
  };
}

/**
 * Notification context for template rendering
 */
export interface NotificationContext {
  /** Base URL for actionable links */
  baseUrl: string;
  /** Locale for message formatting */
  locale: 'vi' | 'en';
  /** Application name */
  appName: string;
  /** Environment name */
  environment: string;
  /** Support contact */
  supportEmail?: string;
  /** Documentation URL */
  docsUrl?: string;
}

/**
 * Template definition
 */
export interface NotificationTemplate {
  /** Template type identifier */
  type: string;
  /** Render function for the template */
  render: (context: NotificationContext, data: Record<string, unknown>) => {
    title: string;
    message: string;
    payload: Record<string, unknown>;
  };
}

/**
 * Default notification context
 */
export function defaultContext(overrides?: Partial<NotificationContext>): NotificationContext {
  return {
    baseUrl: process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000',
    locale: (process.env.DEFAULT_LOCALE as 'vi' | 'en') || 'en',
    appName: 'ApexOS',
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    supportEmail: process.env.SUPPORT_EMAIL || 'support@apexos.io',
    docsUrl: process.env.DOCS_URL || 'https://docs.apexos.io',
    ...overrides,
  };
}

/**
 * Load notification configuration from environment variables
 */
export function loadConfig(): NotificationConfig {
  const debug = process.env.NODE_ENV === 'test';

  const nodeEnv = process.env.NODE_ENV as string;
  const environment: 'development' | 'staging' | 'production' =
    nodeEnv === 'production' ? 'production' :
    nodeEnv === 'staging' ? 'staging' :
    'development';

  const enabled = process.env.NOTIFICATIONS_ENABLED !== 'false';

  return {
    environment,
    enabled,
    channels: {
      slack: process.env.SLACK_WEBHOOK_URL
        ? {
            enabled: process.env.SLACK_ENABLED !== 'false',
            webhookUrl: process.env.SLACK_WEBHOOK_URL,
            channel: process.env.SLACK_CHANNEL,
            username: process.env.SLACK_USERNAME || 'ApexOS Bot',
            iconEmoji: process.env.SLACK_ICON_EMOJI || ':rocket:',
            iconUrl: process.env.SLACK_ICON_URL,
          }
        : undefined,

      email: process.env.RESEND_API_KEY
        ? {
            enabled: process.env.EMAIL_ENABLED !== 'false',
            apiKey: process.env.RESEND_API_KEY,
            fromEmail: process.env.RESEND_FROM_EMAIL || 'noreply@apexos.io',
            fromName: process.env.RESEND_FROM_NAME || 'ApexOS',
            defaultRecipients: process.env.NOTIFICATION_EMAIL_RECIPIENTS
              ? process.env.NOTIFICATION_EMAIL_RECIPIENTS.split(',').map(s => s.trim())
              : [],
            replyTo: process.env.RESEND_REPLY_TO,
          }
        : undefined,

      telegram: process.env.TELEGRAM_BOT_TOKEN
        ? {
            enabled: process.env.TELEGRAM_ENABLED !== 'false',
            botToken: process.env.TELEGRAM_BOT_TOKEN,
            chatIds: process.env.TELEGRAM_CHAT_IDS
              ? process.env.TELEGRAM_CHAT_IDS.split(',').map(s => s.trim())
              : [],
            parseMode: (process.env.TELEGRAM_PARSE_MODE as 'HTML' | 'Markdown') || 'HTML',
            disableWebPagePreview: process.env.TELEGRAM_DISABLE_WEB_PAGE_PREVIEW !== 'true',
          }
        : undefined,

      webhook: process.env.ALERT_WEBHOOK_URL
        ? {
            enabled: process.env.WEBHOOK_ENABLED !== 'false',
            webhookUrl: process.env.ALERT_WEBHOOK_URL,
            headers: process.env.WEBHOOK_HEADERS
              ? JSON.parse(process.env.WEBHOOK_HEADERS)
              : undefined,
            payloadFormat: (process.env.WEBHOOK_PAYLOAD_FORMAT as 'full' | 'flat') || 'full',
          }
        : undefined,

      console: {
        enabled: process.env.CONSOLE_ENABLED !== 'false',
        logLevel: (process.env.CONSOLE_LOG_LEVEL as 'log' | 'info' | 'warn') || 'log',
      },
    },
    defaultPriority: process.env.NOTIFICATION_DEFAULT_PRIORITY as NotificationPriority || 'normal',
    rateLimitPerMinute: parseInt(process.env.NOTIFICATION_RATE_LIMIT || '60', 10),
    retries: {
      maxAttempts: parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10),
      backoffMs: parseInt(process.env.NOTIFICATION_RETRY_BACKOFF || '1000', 10),
    },
    templates: {
      baseUrl: process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000',
      locale: (process.env.DEFAULT_LOCALE as 'vi' | 'en') || 'en',
    },
  };
}
