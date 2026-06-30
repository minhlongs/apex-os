/**
 * Notification System Unit Tests
 */

import { loadConfig, defaultContext, NotificationConfig } from '@/lib/notifications/config';
import { createSlackNotifier, SlackNotifier } from '@/lib/notifications/channels/slack';
import { createEmailNotifierChannel, EmailNotifierChannel } from '@/lib/notifications/channels/email';
import { createTelegramNotifier, TelegramNotifier } from '@/lib/notifications/channels/telegram';
import { getTemplate, systemAlertTemplate, payoutTemplate } from '@/lib/notifications/templates';
import { NotificationService, createNotificationService } from '@/lib/notifications';

// Mock fetch globally
global.fetch = jest.fn();

describe('Notification Configuration', () => {
  beforeEach(() => {
    // Reset environment
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.RESEND_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.NOTIFICATIONS_ENABLED;
  });

  it('should load default config when no env vars set', () => {
    const config = loadConfig();

    expect(config.environment).toBe('development');
    expect(config.enabled).toBe(true);
    expect(config.channels.slack).toBeUndefined();
    expect(config.channels.email).toBeUndefined();
    expect(config.channels.telegram).toBeUndefined();
  });

  it('should load slack config when webhook URL is set', () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.SLACK_ENABLED = 'true';
    process.env.SLACK_CHANNEL = '#alerts';
    process.env.SLACK_USERNAME = 'Test Bot';

    const config = loadConfig();

    expect(config.channels.slack).toBeDefined();
    expect(config.channels.slack?.enabled).toBe(true);
    expect(config.channels.slack?.webhookUrl).toBe('https://hooks.slack.com/test');
    expect(config.channels.slack?.channel).toBe('#alerts');
    expect(config.channels.slack?.username).toBe('Test Bot');
  });

  it('should load email config when Resend API key is set', () => {
    process.env.RESEND_API_KEY = 're_test123';
    process.env.RESEND_FROM_EMAIL = 'test@example.com';
    process.env.RESEND_FROM_NAME = 'Test App';
    process.env.NOTIFICATION_EMAIL_RECIPIENTS = 'admin@example.com,alerts@example.com';

    const config = loadConfig();

    expect(config.channels.email).toBeDefined();
    expect(config.channels.email?.enabled).toBe(true);
    expect(config.channels.email?.apiKey).toBe('re_test123');
    expect(config.channels.email?.fromEmail).toBe('test@example.com');
    expect(config.channels.email?.defaultRecipients).toEqual([
      'admin@example.com',
      'alerts@example.com',
    ]);
  });

  it('should load telegram config when bot token is set', () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:ABC';
    process.env.TELEGRAM_CHAT_IDS = '-1001234567890';
    process.env.TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_PARSE_MODE = 'Markdown';

    const config = loadConfig();

    expect(config.channels.telegram).toBeDefined();
    expect(config.channels.telegram?.enabled).toBe(true);
    expect(config.channels.telegram?.botToken).toBe('123:ABC');
    expect(config.channels.telegram?.chatIds).toEqual(['-1001234567890']);
    expect(config.channels.telegram?.parseMode).toBe('Markdown');
  });

  it('should disable channel when enabled flag is false', () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.SLACK_ENABLED = 'false';

    const config = loadConfig();

    expect(config.channels.slack?.enabled).toBe(false);
  });

  it('should parse environment correctly', () => {
    process.env.NODE_ENV = 'production';
    expect(loadConfig().environment).toBe('production');

    process.env.NODE_ENV = 'staging';
    expect(loadConfig().environment).toBe('staging');

    process.env.NODE_ENV = 'development';
    expect(loadConfig().environment).toBe('development');
  });
});

describe('Default Context', () => {
  it('should return default context values', () => {
    const ctx = defaultContext();

    expect(ctx.baseUrl).toBe('http://localhost:3000');
    expect(ctx.locale).toBe('en');
    expect(ctx.appName).toBe('ApexOS');
    expect(ctx.environment).toBe('development');
    expect(ctx.supportEmail).toBe('support@apexos.io'); // now has default
  });

  it('should override with provided values', () => {
    const ctx = defaultContext({
      baseUrl: 'https://example.com',
      locale: 'vi',
      environment: 'production',
    });

    expect(ctx.baseUrl).toBe('https://example.com');
    expect(ctx.locale).toBe('vi');
    expect(ctx.environment).toBe('production');
  });

  it('should use environment variables when set', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://test.com';
    process.env.DEFAULT_LOCALE = 'vi';
    process.env.SUPPORT_EMAIL = 'support@test.com';
    process.env.DOCS_URL = 'https://docs.test.com';

    const ctx = defaultContext();

    expect(ctx.baseUrl).toBe('https://test.com');
    expect(ctx.locale).toBe('vi');
    expect(ctx.supportEmail).toBe('support@test.com');
    expect(ctx.docsUrl).toBe('https://docs.test.com');
  });
});

describe('Slack Notifier', () => {
  const slackConfig = {
    webhookUrl: 'https://hooks.slack.com/test',
    username: 'Test Bot',
    iconEmoji: ':rocket:',
  };

  it('should build payload with correct structure', () => {
    const notifier = createSlackNotifier(slackConfig);

    const message = {
      id: 'test-123',
      type: 'test',
      title: 'Test Notification',
      message: 'This is a test',
      priority: 'high' as const,
      payload: {
        amount: 100,
        actions: [
          { label: 'View', url: '/dashboard' },
          { label: 'Docs', url: '/docs' },
        ],
      },
      timestamp: new Date(),
      metadata: { environment: 'production' },
    };

    const payload = (notifier as any).buildPayload(message);

    expect(payload.username).toBe('Test Bot');
    expect(payload.icon_emoji).toBe(':rocket:');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].color).toBe('#f59e0b'); // high priority = orange
    expect(payload.attachments[0].title).toBe('Test Notification');
    expect(payload.attachments[0].actions).toHaveLength(2);
  });

  it('should format field values correctly', () => {
    const notifier = createSlackNotifier(slackConfig);

    const formatValue = (notifier as any).formatValue(1234.56);
    expect(formatValue).toContain('1,234'); // locale formatted

    const boolValue = (notifier as any).formatValue(true);
    expect(boolValue).toBe('Yes');

    const nullValue = (notifier as any).formatValue(null);
    expect(nullValue).toBe('-');
  });
});

describe('Email Notifier Channel', () => {
  const emailConfig = {
    apiKey: 're_test123',
    fromEmail: 'alerts@example.com',
    fromName: 'Test App',
    defaultRecipients: ['admin@example.com'],
  };

  it('should build email with subject and HTML', () => {
    const notifier = createEmailNotifierChannel(emailConfig, {
      baseUrl: 'https://test.com',
      locale: 'en',
      appName: 'Test App',
      environment: 'production',
    });

    const message = {
      type: 'custom',
      title: 'Test Email',
      message: 'This is a test email',
      priority: 'normal',
      payload: {
        amount: 100,
        actions: [{ label: 'View Dashboard', url: '/dashboard' }],
      },
    };

    const email = (notifier as any).buildEmail(message, 'user@example.com');

    expect(email.subject).toContain('[Test App]');
    expect(email.subject).toContain('Test Email');
    expect(email.html).toContain('<html');
    expect(email.html).toContain('Test Email');
    expect(email.text).toContain('Test Email');
  });

  it('should add priority prefix to critical alerts', () => {
    const notifier = createEmailNotifierChannel(emailConfig, {
      baseUrl: 'https://test.com',
      locale: 'en',
      appName: 'Test App',
    });

    const message = {
      type: 'custom',
      title: 'Critical Alert',
      message: 'System is down',
      priority: 'critical',
      payload: {},
    };

    const email = (notifier as any).buildEmail(message, 'user@example.com');

    expect(email.subject).toContain('[CRITICAL]');
  });
});

describe('Telegram Notifier', () => {
  const telegramConfig = {
    botToken: '123:ABC',
    chatIds: ['-1001234567890'],
    parseMode: 'HTML' as const,
    disableWebPagePreview: false,
  };

  it('should format message with markdown/HTML', () => {
    const notifier = createTelegramNotifier(telegramConfig);

    const message = {
      type: 'test',
      title: 'Test Notification',
      message: 'This is a test',
      priority: 'high',
      payload: {
        amount: 100,
        status: 'active',
      },
      timestamp: new Date(),
      metadata: { environment: 'production' },
    };

    const text = (notifier as any).buildMessageText(message);

    expect(text).toContain('*Test Notification*'); // bold
    expect(text).toContain('🟡'); // high priority emoji (yellow circle)
    expect(text).toContain('🏢'); // production badge
  });

  it('should escape markdown special characters', () => {
    const notifier = createTelegramNotifier(telegramConfig);

    const escapeMarkdown = (notifier as any).escapeMarkdown;
    expect(escapeMarkdown('Hello *world*')).toBe('Hello \\*world\\*');
    expect(escapeMarkdown('Text_with_underscores')).toBe('Text\\_with\\_underscores');
  });
});

describe('Templates', () => {
  it('should return system alert template', () => {
    const template = getTemplate('system-alert');
    expect(template).toBeDefined();
    expect(template.type).toBe('system-alert');
  });

  it('should return payout template', () => {
    const template = getTemplate('payout');
    expect(template).toBeDefined();
    expect(template.type).toBe('payout');
  });

  it('should return undefined for unknown template', () => {
    const template = getTemplate('unknown');
    expect(template).toBeUndefined();
  });

  it('should render system alert template with data', () => {
    const template = getTemplate('system-alert');
    expect(template).toBeDefined();

    const ctx = defaultContext({ baseUrl: 'https://test.com' });
    const result = template!.render(ctx, {
      alertName: 'High CPU Usage',
      severity: 'high',
      metricName: 'CPU Utilization',
      currentValue: 95,
      thresholdValue: 80,
      alertId: 'alert_123',
    });

    expect(result.title).toContain('High CPU Usage');
    expect(result.payload.actions).toBeDefined();
    expect(result.payload.actions.length).toBeGreaterThan(0);
  });

  it('should render payout template with non-batch data', () => {
    const template = getTemplate('payout');
    expect(template).toBeDefined();

    const ctx = defaultContext({ baseUrl: 'https://test.com' });
    const result = template!.render(ctx, {
      amount: 5000,
      walletAddress: 'GABCDEF1234567890',
      transactionHash: 'ABCDEF1234567890GHIJKLMNOPQRSTUVWXYZ',
      network: 'stellar',
      status: 'completed',
      isBatch: false,
    });

    expect(result.title).toContain('$5000.00'); // amount formatted with 2 decimals
    expect(result.payload.amount).toBe(5000);
    // Non-batch payouts have 2 actions: View Transaction, Payout History
    expect(result.payload.actions).toHaveLength(2);
  });
});

describe('Notification Service', () => {
  beforeEach(() => {
    // Clear all notification-related env vars
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.RESEND_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.NOTIFICATIONS_ENABLED;
    delete process.env.SLACK_ENABLED;
    delete process.env.EMAIL_ENABLED;
    delete process.env.TELEGRAM_ENABLED;
    process.env.NODE_ENV = 'test';
 process.env.CONSOLE_ENABLED = 'false';
  });

  it('should start with no channels when none configured', () => {
    const service = createNotificationService();

    expect(service.getEnabledChannels()).toEqual([]);
    expect(service.isChannelEnabled('slack')).toBe(false);
    expect(service.isChannelEnabled('email')).toBe(false);
    expect(service.isChannelEnabled('telegram')).toBe(false);
  });

  it('should initialize slack channel when configured', () => {
    // Ensure clean state
    delete process.env.SLACK_WEBHOOK_URL;
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.SLACK_ENABLED = 'true';

    const service = createNotificationService();

    expect(service.hasChannel('slack')).toBe(true);
  });

  it('should return context correctly', () => {
    // Clear any base url from other tests
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.DEFAULT_LOCALE;
    delete process.env.SUPPORT_EMAIL;
    delete process.env.DOCS_URL;

    process.env.NEXT_PUBLIC_BASE_URL = 'https://myapp.com';
    process.env.DEFAULT_LOCALE = 'vi';

    const service = createNotificationService();

    const ctx = service.getContext();
    expect(ctx.baseUrl).toBe('https://myapp.com');
    expect(ctx.locale).toBe('vi');
  });

  it('should reject send to disabled channel', async () => {
    const service = createNotificationService();

    const result = await service.sendCustom('Test', 'Message', {}, { channels: ['slack'] });

    expect(result).toHaveLength(0);
  });

  it('should throw for unknown template type', async () => {
    const service = createNotificationService();

    await expect(
      service.sendTemplate('unknown-template' as any, {})
    ).rejects.toThrow('Unknown template type');
  });
});

describe('Rate Limiting', () => {
  beforeEach(() => {
    // Clear all notification-related env vars
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.RESEND_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.NOTIFICATIONS_ENABLED;
    delete process.env.SLACK_ENABLED;
    delete process.env.EMAIL_ENABLED;
    delete process.env.TELEGRAM_ENABLED;
    process.env.NODE_ENV = 'test';
  });

  it('should respect rate limit', () => {
    // Set up only Slack with rate limit 2
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.SLACK_ENABLED = 'true';
    process.env.NOTIFICATION_RATE_LIMIT = '2';

    const service = createNotificationService();

    // Verify channel is initialized
    expect(service.hasChannel('slack')).toBe(true);

    // Check rate limit state - should allow 2 requests, then block the 3rd
    const check1 = (service as any).checkRateLimit('slack');
    expect(check1).toBe(true);

    const check2 = (service as any).checkRateLimit('slack');
    expect(check2).toBe(true);

    const check3 = (service as any).checkRateLimit('slack');
    expect(check3).toBe(false); // Rate limited
  });
});
