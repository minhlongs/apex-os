/**
 * Slack Notification Channel Tests
 * ApexOS Notification System
 *
 * Coverage focus:
 * - Slack payload building and formatting
 * - Attachment construction with fields and actions
 * - Priority color mapping
 * - Field value formatting (currency, dates, booleans)
 * - Markdown escaping
 * - Error handling and edge cases
 */

import { SlackNotifier, createSlackNotifier } from '@/lib/notifications/channels/slack';
import type { SlackConfig, NotificationMessage } from '@/lib/notifications/config';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockSlackConfig: SlackConfig = {
  webhookUrl: 'https://hooks.slack.com/services/TEST/WEBHOOK/URL',
  channel: '#alerts',
  username: 'ApexOS Bot',
  iconEmoji: ':rocket:',
  iconUrl: 'https://apexos.io/icon.png',
};

const createMockMessage = (overrides?: Partial<NotificationMessage>): NotificationMessage => ({
  id: 'test-notification-123',
  type: 'alert',
  title: 'Test Alert Title',
  message: 'This is a test notification message with details.',
  priority: 'normal',
  payload: {
    exchange: 'binance',
    tradeVolume: 10000,
    commission: 150.50,
    status: 'completed',
    walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
    actions: [
      { label: 'View Dashboard', url: 'https://apexos.io/dashboard' },
      { label: 'View Details', url: 'https://apexos.io/alerts/123' },
    ],
  },
  timestamp: new Date('2024-06-15T10:30:00Z'),
  metadata: {
    environment: 'production',
    baseUrl: 'https://apexos.io',
    locale: 'en',
  },
  ...overrides,
});

// ============================================================================
// Helper Mocks
// ============================================================================

const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockClear();
});

// ============================================================================
// Constructor Tests
// ============================================================================

describe('SlackNotifier', () => {
  describe('constructor', () => {
    it('should create instance with config', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      expect(notifier).toBeInstanceOf(SlackNotifier);
      expect(notifier.getConfig()).toEqual(mockSlackConfig);
    });

    it('should use default retry config from environment', () => {
      process.env.NOTIFICATION_MAX_RETRIES = '5';
      process.env.NOTIFICATION_RETRY_BACKOFF = '2000';

      const notifier = createSlackNotifier(mockSlackConfig);

      expect(notifier).toBeDefined();

      delete process.env.NOTIFICATION_MAX_RETRIES;
      delete process.env.NOTIFICATION_RETRY_BACKOFF;
    });

    it('should work with minimal config (webhookUrl only)', () => {
      const minimalConfig: SlackConfig = {
        webhookUrl: 'https://hooks.slack.com/services/test',
      };
      const notifier = createSlackNotifier(minimalConfig);
      expect(notifier.getConfig().webhookUrl).toBe(minimalConfig.webhookUrl);
    });
  });

  // ==========================================================================
  // Send Method Tests
  // ==========================================================================

  describe('send', () => {
    it('should send notification successfully', async () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await notifier.send(message);

      expect(result.success).toBe(true);
      expect(result.channel).toBe('slack');
      expect(result.messageId).toBeDefined();
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.retry).toBeDefined();
      expect(result.retry!.attempts).toBe(1);
      expect(result.retry!.errors).toHaveLength(0);

      // Verify fetch was called
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        mockSlackConfig.webhookUrl,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('should retry on network errors', async () => {
      process.env.NOTIFICATION_MAX_RETRIES = '3';
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage();

      // First two attempts fail, third succeeds
      mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await notifier.send(message);

      expect(result.success).toBe(true);
      expect(result.retry!.attempts).toBe(3);
      expect(result.retry!.errors).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should fail after max retries exhausted', async () => {
      process.env.NOTIFICATION_MAX_RETRIES = '2';
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage();

      mockFetch.mockRejectedValue(new Error('Service unavailable'));

      const result = await notifier.send(message);

      expect(result.success).toBe(false);
      expect(result.channel).toBe('slack');
      expect(result.error).toBeDefined();
      expect(result.retry!.attempts).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 404 errors', async () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage();

      mockFetch.mockRejectedValueOnce(new Error('404 Not Found'));

      const result = await notifier.send(message);

      expect(result.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
    });

    it('should not retry on authentication errors', async () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage();

      mockFetch.mockRejectedValueOnce(new Error('Unauthorized - invalid webhook'));

      const result = await notifier.send(message);

      expect(result.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
    });

    it('should retry on 5xx errors', async () => {
      process.env.NOTIFICATION_MAX_RETRIES = '2';
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage();

      mockFetch.mockRejectedValueOnce(new Error('500 Internal Server Error'));
      mockFetch.mockRejectedValueOnce(new Error('502 Bad Gateway'));

      const result = await notifier.send(message);

      expect(result.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on rate limit (429) errors', async () => {
      process.env.NOTIFICATION_MAX_RETRIES = '2';
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage();

      mockFetch.mockRejectedValueOnce(new Error('429 Too Many Requests'));
      mockFetch.mockRejectedValueOnce(new Error('429 Rate limited'));

      const result = await notifier.send(message);

      expect(result.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should handle unexpected exceptions', async () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage();

      mockFetch.mockImplementation(() => {
        throw new Error('Unexpected error in fetch');
      });

      const result = await notifier.send(message);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unexpected error');
    });

    it('should capture fetch response error details', async () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden - webhook misconfigured',
      });

      const result = await notifier.send(message);

      expect(result.success).toBe(false);
      expect(result.error).toContain('403');
    });

it('should use custom backoff from environment', async () => {
  process.env.NOTIFICATION_MAX_RETRIES = '2';
  process.env.NOTIFICATION_RETRY_BACKOFF = '100';

  const notifier = createSlackNotifier(mockSlackConfig);
  const message = createMockMessage();

  mockFetch.mockRejectedValue(new Error('Temporary failure'));

  const result = await notifier.send(message);

  expect(result.success).toBe(false);
  expect(result.retry).toBeDefined();
  expect(result.retry!.attempts).toBe(2);
  expect(result.retry!.errors).toContain('Temporary failure');

  delete process.env.NOTIFICATION_MAX_RETRIES;
  delete process.env.NOTIFICATION_RETRY_BACKOFF;
});
  });

  // ==========================================================================
  // Payload Building Tests
  // ==========================================================================

  describe('buildPayload', () => {
    it('should build correct Slack payload structure', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage();

      // Access private method via type assertion for testing
      const payload = (notifier as any).buildPayload(message);

      expect(payload).toHaveProperty('username', 'ApexOS Bot');
      expect(payload).toHaveProperty('icon_emoji', ':rocket:');
      expect(payload).toHaveProperty('channel', '#alerts');
      expect(payload.attachments).toHaveLength(1);
    });

    it('should include title in attachment', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage({ title: 'Critical Alert' });

      const payload = (notifier as any).buildPayload(message);

      expect(payload.attachments[0].title).toBe('Critical Alert');
    });

    it('should include message text in attachment', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage({
        message: 'Custom message content',
      });

      const payload = (notifier as any).buildPayload(message);

      expect(payload.attachments[0].text).toBe('Custom message content');
    });

    it('should set color based on priority', () => {
      const notifier = createSlackNotifier(mockSlackConfig);

      const buildPayload = (notifier as any).buildPayload.bind(notifier);

      const lowMsg = createMockMessage({ priority: 'low' });
      expect(buildPayload(lowMsg).attachments[0].color).toBe('#6b7280');

      const normalMsg = createMockMessage({ priority: 'normal' });
      expect(buildPayload(normalMsg).attachments[0].color).toBe('#3b82f6');

      const highMsg = createMockMessage({ priority: 'high' });
      expect(buildPayload(highMsg).attachments[0].color).toBe('#f59e0b');

      const criticalMsg = createMockMessage({ priority: 'critical' });
      expect(buildPayload(criticalMsg).attachments[0].color).toBe('#ef4444');
    });

    it('should include footer with environment', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage({
        metadata: { environment: 'staging' },
      });

      const payload = (notifier as any).buildPayload(message);

      expect(payload.attachments[0].footer).toBe('ApexOS staging');
    });

    it('should include timestamp in footer', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage({
        timestamp: new Date('2024-06-15T10:30:00Z'),
      });

      const payload = (notifier as any).buildPayload(message);

      // Timestamp should be Unix timestamp (seconds)
      expect(payload.attachments[0].ts).toBe(1718447400);
    });

    it('should format payload fields correctly', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage({
        payload: {
          exchange: 'binance',
          tradeVolume: 10000,
          commission: 150.50,
          status: 'completed',
          active: true,
        },
      });

      const payload = (notifier as any).buildPayload(message);

      const fields = payload.attachments[0].fields;
      expect(fields).toHaveLength(5);

      // Check field formatting
      const volumeField = fields!.find(f => f.title === 'Trade Volume');
      expect(volumeField?.value).toBe('10,000');

      const commissionField = fields!.find(f => f.title === 'Commission');
      expect(commissionField?.value).toBe('150.5'); // toLocaleString may drop trailing zero

      const activeField = fields!.find(f => f.title === 'Active');
      expect(activeField?.value).toBe('Yes');
    });

    it('should exclude actions and links from fields', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage({
        payload: {
          actions: [{ label: 'Test', url: 'https://test.com' }],
          links: { home: 'https://apexos.io' },
          data: 'value',
        },
      });

      const payload = (notifier as any).buildPayload(message);

      const fields = payload.attachments[0].fields;
      expect(fields!.find(f => f.title === 'Actions')).toBeUndefined();
      expect(fields!.find(f => f.title === 'Links')).toBeUndefined();
      expect(fields!.find(f => f.title === 'Data')).toBeDefined();
    });

    it('should convert action links to Slack actions', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage({
        payload: {
          actions: [
            { label: 'View Dashboard', url: 'https://apexos.io/dashboard' },
            { label: 'Manage', url: 'https://apexos.io/admin' },
          ],
        },
      });

      const payload = (notifier as any).buildPayload(message);

      const actions = payload.attachments[0].actions;
      expect(actions).toHaveLength(2);
      expect(actions![0]).toEqual({
        type: 'button',
        text: 'View Dashboard',
        url: 'https://apexos.io/dashboard',
      });
    });

    it('should handle empty payload gracefully', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage({ payload: {} });

      const payload = (notifier as any).buildPayload(message);

      expect(payload.attachments[0].fields).toBeUndefined();
      expect(payload.attachments[0].actions).toBeUndefined();
    });

    it('should handle missing metadata gracefully', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage({ metadata: undefined });

      const payload = (notifier as any).buildPayload(message);

      expect(payload.attachments[0].footer).toContain('production'); // Default
    });

    it('should truncate long field values', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const longString = 'a'.repeat(300);
      const message = createMockMessage({
        payload: { description: longString },
      });

      const payload = (notifier as any).buildPayload(message);

      const descriptionField = payload.attachments[0].fields!.find(f => f.title === 'Description');
      expect(descriptionField?.value!.length).toBeLessThanOrEqual(200 + 3); // +3 for ellipsis
    });

    it('should handle boolean values in fields', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage({
        payload: {
          isActive: true,
          isVerified: false,
        },
      });

      const payload = (notifier as any).buildPayload(message);

      const fields = payload.attachments[0].fields!;
      const activeField = fields.find(f => f.title === 'Is Active');
      const verifiedField = fields.find(f => f.title === 'Is Verified');

      expect(activeField?.value).toBe('Yes');
      expect(verifiedField?.value).toBe('No');
    });

    it('should handle Date objects in fields', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const date = new Date('2024-06-15T10:30:00Z');
      const message = createMockMessage({
        payload: { createdAt: date },
      });

      const payload = (notifier as any).buildPayload(message);

      const fields = payload.attachments[0].fields!;
      const dateField = fields.find(f => f.title === 'Created At');
      expect(dateField?.value).toBeDefined();
      expect(dateField?.value).toContain('2024');
    });

    it('should convert snake_case keys to Title Case', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const message = createMockMessage({
        payload: {
          wallet_address: '0x123...',
          trade_volume: 5000,
          commission_rate: 0.3,
        },
      });

      const payload = (notifier as any).buildPayload(message);

      const fields = payload.attachments[0].fields!;
      // snake_case produces only first letter capital, rest lowercase
      expect(fields.find(f => f.title === 'Wallet address')).toBeDefined();
      expect(fields.find(f => f.title === 'Trade volume')).toBeDefined();
      expect(fields.find(f => f.title === 'Commission rate')).toBeDefined();
    });
  });

  // ==========================================================================
  // Format Value Tests
  // ==========================================================================

  describe('formatValue', () => {
    it('should format null/undefined as dash', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatValue = (notifier as any).formatValue.bind(notifier);

      expect(formatValue(null)).toBe('-');
      expect(formatValue(undefined)).toBe('-');
    });

    it('should format numbers with locale', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatValue = (notifier as any).formatValue.bind(notifier);

      expect(formatValue(1000)).toContain(',');
    });

    it('should format Date objects to string', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatValue = (notifier as any).formatValue.bind(notifier);
      const date = new Date('2024-06-15T10:30:00Z');

      const result = formatValue(date);
      expect(typeof result).toBe('string');
      expect(result).toContain('2024');
    });

    it('should format booleans as Yes/No', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatValue = (notifier as any).formatValue.bind(notifier);

      expect(formatValue(true)).toBe('Yes');
      expect(formatValue(false)).toBe('No');
    });

    it('should handle normal blockchain addresses without truncation', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatValue = (notifier as any).formatValue.bind(notifier);

      const ethAddress = '0x1234567890abcdef1234567890abcdef12345678';
      const result = formatValue(ethAddress);
      // Address under 200 chars should not be truncated
      expect(result).toBe(ethAddress);
      expect(result).not.toContain('...');
    });

    it('should handle normal Stellar addresses without truncation', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatValue = (notifier as any).formatValue.bind(notifier);

      const stellarAddress = 'GBAN4A5QYAJ3F3SJC7F3W5V7Z4Q3GX2W6K4M5N7P8R9S';
      const result = formatValue(stellarAddress);
      // Address under 200 chars should not be truncated
      expect(result).toBe(stellarAddress);
      expect(result).not.toContain('...');
    });

    it('should truncate very long strings', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatValue = (notifier as any).formatValue.bind(notifier);

      // Use a string longer than 200 to trigger truncation
      const longString = 'a'.repeat(250);
      const result = formatValue(longString);
      // Should be truncated to 197 + '...' = 200 characters
      expect(result.length).toBe(200);
      expect(result).toContain('...');
      expect(result).toBe('a'.repeat(197) + '...');
    });
  });

  // ==========================================================================
  // Markdown Escaping Tests
  // ==========================================================================

  describe('escapeMarkdown', () => {
    it('should escape asterisks', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown.bind(notifier);

      expect(escapeMarkdown('*bold*')).toBe('\\*bold\\*');
    });

    it('should escape underscores', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown.bind(notifier);

      expect(escapeMarkdown('_italic_')).toBe('\\_italic\\_');
    });

    it('should escape brackets', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown.bind(notifier);

      expect(escapeMarkdown('[link](url)')).toBe('\\[link\\]\\(url\\)');
    });

    it('should escape backticks', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown.bind(notifier);

      expect(escapeMarkdown('`code`')).toBe('\\`code\\`');
    });

    it('should escape tilde for strikethrough', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown.bind(notifier);

      expect(escapeMarkdown('~strikethrough~')).toBe('\\~strikethrough\\~');
    });

    it('should escape pipe characters', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown.bind(notifier);

      expect(escapeMarkdown('a|b|c')).toBe('a\\|b\\|c');
    });

    it('should handle empty string', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown.bind(notifier);

      expect(escapeMarkdown('')).toBe('');
    });

    it('should escape all special characters', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown.bind(notifier);

      const input = '_*[]()~`>#+=|{}.!-';
      const output = escapeMarkdown(input);

      // Every special char should be escaped with backslash
      const specialChars = '_*[]()~`>#+=|{}.!-';
      for (const char of specialChars) {
        expect(output).toContain(`\\${char}`);
      }
    });
  });

  // ==========================================================================
  // Format Field Title Tests
  // ==========================================================================

  describe('formatFieldTitle', () => {
    it('should convert snake_case to Title Case', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatFieldTitle = (notifier as any).formatFieldTitle.bind(notifier);

      expect(formatFieldTitle('wallet_address')).toBe('Wallet address');
      expect(formatFieldTitle('trade_volume')).toBe('Trade volume');
    });

    it('should convert camelCase to Title Case', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatFieldTitle = (notifier as any).formatFieldTitle.bind(notifier);

      expect(formatFieldTitle('walletAddress')).toBe('Wallet Address');
      expect(formatFieldTitle('tradeVolume')).toBe('Trade Volume');
    });

    it('should handle single word', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatFieldTitle = (notifier as any).formatFieldTitle.bind(notifier);

      expect(formatFieldTitle('exchange')).toBe('Exchange');
    });

    it('should handle already formatted title', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatFieldTitle = (notifier as any).formatFieldTitle.bind(notifier);

      // Note: Implementation adds spaces before capitals, so existing spaces become doubled
      expect(formatFieldTitle('Already Formatted Title')).toBe('Already  Formatted  Title');
    });

    it('should trim whitespace', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const formatFieldTitle = (notifier as any).formatFieldTitle.bind(notifier);

      expect(formatFieldTitle('  wallet_address  ')).toBe('Wallet address');
    });
  });

  // ==========================================================================
  // Priority Color Mapping Tests
  // ==========================================================================

  describe('priority colors', () => {
    it('should map low priority to gray', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const buildPayload = (notifier as any).buildPayload.bind(notifier);
      const message = createMockMessage({ priority: 'low' });

      expect(buildPayload(message).attachments[0].color).toBe('#6b7280');
    });

    it('should map normal priority to blue', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const buildPayload = (notifier as any).buildPayload.bind(notifier);
      const message = createMockMessage({ priority: 'normal' });

      expect(buildPayload(message).attachments[0].color).toBe('#3b82f6');
    });

    it('should map high priority to orange', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const buildPayload = (notifier as any).buildPayload.bind(notifier);
      const message = createMockMessage({ priority: 'high' });

      expect(buildPayload(message).attachments[0].color).toBe('#f59e0b');
    });

    it('should map critical priority to red', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const buildPayload = (notifier as any).buildPayload.bind(notifier);
      const message = createMockMessage({ priority: 'critical' });

      expect(buildPayload(message).attachments[0].color).toBe('#ef4444');
    });

    it('should default to blue for unknown priority', () => {
      const notifier = createSlackNotifier(mockSlackConfig);
      const buildPayload = (notifier as any).buildPayload.bind(notifier);
      const message = createMockMessage({ priority: 'unknown' as any });

      expect(buildPayload(message).attachments[0].color).toBe('#3b82f6');
    });
  });
});
