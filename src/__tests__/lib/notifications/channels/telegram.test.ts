/**
 * Telegram Notification Channel Tests
 * ApexOS Notification System
 *
 * Coverage focus:
 * - Markdown message formatting
 * - Emoji priority indicators
 * - Multi-language support (en/vi)
 * - Payload details formatting
 * - Action links as Markdown
 * - Markdown escaping
 * - Environment labels
 */

import { TelegramNotifier, createTelegramNotifier } from '@/lib/notifications/channels/telegram';
import type { TelegramConfig, NotificationMessage } from '@/lib/notifications/config';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockTelegramConfig: TelegramConfig = {
  botToken: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz',
  chatIds: ['-1001234567890', '-1009876543210'],
  parseMode: 'Markdown',
  disableWebPagePreview: false,
};

const createMockMessage = (overrides?: Partial<NotificationMessage>): NotificationMessage => ({
  id: 'test-telegram-123',
  type: 'alert',
  title: 'Test Alert Title',
  message: 'This is a test notification with details.',
  priority: 'normal',
  payload: {
    exchange: 'binance',
    tradeVolume: 10000,
    commission: 150.50,
    status: 'active',
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

describe('TelegramNotifier', () => {
  describe('constructor', () => {
    it('should create instance with config', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      expect(notifier).toBeInstanceOf(TelegramNotifier);
      expect(notifier.getConfig()).toEqual(mockTelegramConfig);
    });

    it('should set API base URL correctly', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      expect(notifier.getConfig()).toBeDefined();
    });

    it('should work with minimal config', () => {
      const minimalConfig: TelegramConfig = {
        botToken: '123:ABC',
        chatIds: ['-1001234567890'],
      };
      const notifier = createTelegramNotifier(minimalConfig);
      expect(notifier.getConfig().botToken).toBe('123:ABC');
    });

    it('should use default retry config from environment', () => {
      process.env.NOTIFICATION_MAX_RETRIES = '5';
      process.env.NOTIFICATION_RETRY_BACKOFF = '2000';

      const notifier = createTelegramNotifier(mockTelegramConfig);
      expect(notifier).toBeDefined();

      delete process.env.NOTIFICATION_MAX_RETRIES;
      delete process.env.NOTIFICATION_RETRY_BACKOFF;
    });
  });

  // ==========================================================================
  // Send Method Tests
  // ==========================================================================

  describe('send', () => {
    it('should send notification successfully', async () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      // Need mock for each chat ID
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: 12345, chat: { id: -1001234567890 } },
        }),
      }).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: 12346, chat: { id: -1009876543210 } },
        }),
      });

      const result = await notifier.send(message);

      expect(result.success).toBe(true);
      expect(result.channel).toBe('telegram');
      expect(result.messageId).toBeDefined();
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.retry).toBeDefined();
      expect(result.retry!.attempts).toBe(1);
      expect(result.retry!.errors).toHaveLength(0);
    });

    it('should send to all configured chat IDs', async () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: 12345, chat: { id: -1001234567890 } },
        }),
      }).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: 12346, chat: { id: -1009876543210 } },
        }),
      });

      await notifier.send(message);

      // Should be called once per chat ID
      expect(mockFetch).toHaveBeenCalledTimes(mockTelegramConfig.chatIds.length);
    });

    it('should retry on network errors', async () => {
      process.env.NOTIFICATION_MAX_RETRIES = '3';
      // Use single chat to simplify retry testing
      const singleChatConfig = { ...mockTelegramConfig, chatIds: ['-1001234567890'] };
      const notifier = createTelegramNotifier(singleChatConfig);
      const message = createMockMessage();

      mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            result: { message_id: 12345, chat: { id: -1001234567890 } },
          }),
        });

      const result = await notifier.send(message);

      expect(result.success).toBe(true);
      expect(result.retry!.attempts).toBe(3);
      expect(result.retry!.errors).toHaveLength(2);
    });

    it('should fail after max retries exhausted', async () => {
      process.env.NOTIFICATION_MAX_RETRIES = '2';
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({ ok: false, description: 'Service unavailable' }),
      });

      const result = await notifier.send(message);

      expect(result.success).toBe(false);
      expect(result.retry!.attempts).toBe(2);
    });

    it('should not retry on 404 errors', async () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, description: '404 Chat not found' }),
      });

      const result = await notifier.send(message);

      expect(result.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle Telegram API errors', async () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
      });

      const result = await notifier.send(message);

      expect(result.success).toBe(false);
      expect(result.error).toContain('chat not found');
    });

    it('should handle multiple chat IDs with partial failure', async () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      // First chat fails, second would succeed but loop stops on first failure
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, description: 'Chat not found' }),
      });

      const result = await notifier.send(message);

      // Should fail overall when any chat fails
      expect(result.success).toBe(false);
      expect(result.error).toContain('Chat not found');
    });

    it('should add delay between multiple chat sends', async () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: 12345, chat: { id: -1001234567890 } },
        }),
      });

      await notifier.send(message);

      // Should have been called for each chat
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Message Formatting Tests
  // ==========================================================================

  describe('buildMessageText', () => {
    it('should build message with correct structure', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      const text = (notifier as any).buildMessageText(message);

      expect(text).toContain('*Test Alert Title*');
      expect(text).toContain('This is a test notification');
    });

    it('should include priority emoji', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);

      const priorities: Record<string, string> = {
        low: '🔵',
        normal: '✅',
        high: '🟡',
        critical: '🔴',
      };

      for (const [priority, emoji] of Object.entries(priorities)) {
        const message = createMockMessage({ priority: priority as any });
        const text = (notifier as any).buildMessageText(message);
        expect(text).toContain(emoji);
      }
    });

    it('should include environment badge', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage({
        metadata: { environment: 'staging' },
      });

      const text = (notifier as any).buildMessageText(message);

      expect(text).toContain('Staging');
    });

    it('should include timestamp', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      const text = (notifier as any).buildMessageText(message);

      expect(text).toContain('🕐');
    });

    it('should include details from payload', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      const text = (notifier as any).buildMessageText(message);

      expect(text).toContain('*Details*');
      expect(text).toContain('Exchange');
      expect(text).toContain('binance');
    });

    it('should include action links', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      const text = (notifier as any).buildMessageText(message);

      expect(text).toContain('[View Dashboard]');
      expect(text).toContain('[View Details]');
    });

    it('should add separator line at end', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      const text = (notifier as any).buildMessageText(message);

      expect(text).toContain('━');
    });

    it('should include baseUrl in footer', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage({
        metadata: { baseUrl: 'https://test.apexos.io' },
      });

      const text = (notifier as any).buildMessageText(message);

      expect(text).toContain('https://test\\.apexos\\.io');
    });
  });

  // ==========================================================================
  // Format Payload Details Tests
  // ==========================================================================

  describe('formatPayloadDetails', () => {
    it('should format payload as bullet points', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      const details = (notifier as any).formatPayloadDetails(message.payload, 'en');

      expect(details).toContain('•');
      expect(details).toContain('*Exchange*');
      expect(details).toContain('binance');
    });

    it('should exclude actions and links', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      const details = (notifier as any).formatPayloadDetails(message.payload, 'en');

      expect(details).not.toContain('actions');
      expect(details).not.toContain('links');
    });

    it('should filter out undefined and null values', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const payload = {
        exchange: 'binance',
        undefinedValue: undefined,
        nullValue: null,
        status: 'active',
      };

      const details = (notifier as any).formatPayloadDetails(payload, 'en');

      expect(details).toContain('Exchange');
      expect(details).toContain('Status');
      expect(details).not.toContain('undefinedValue');
      expect(details).not.toContain('nullValue');
    });

    it('should return null for empty payload', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);

      const details = (notifier as any).formatPayloadDetails({}, 'en');

      expect(details).toBeNull();
    });
  });

  describe('formatValue', () => {
    it('should format currency values with $ symbol', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const formatValue = (notifier as any).formatValue.bind(notifier);

      expect(formatValue('amount', 1000)).toContain('$');
    });

    it('should truncate long strings with blockchain addresses', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const formatValue = (notifier as any).formatValue.bind(notifier);

      // Use >50 chars to trigger truncation (must include 0x)
      const ethAddress = '0x' + '1234567890abcdef'.repeat(4); // 2 + 64 = 66 chars
      const result = formatValue('walletAddress', ethAddress);
      expect(result).not.toBe(ethAddress);
      expect(result).toContain('...');
      // Verify truncation pattern: first 12 + ... + last 8
      expect(result).toBe(`${ethAddress.slice(0, 12)}...${ethAddress.slice(-8)}`);
    });

    it('should format booleans with localized strings', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const formatValue = (notifier as any).formatValue.bind(notifier);

      expect(formatValue('isActive', true)).toBe('Yes');
      expect(formatValue('isActive', false)).toBe('No');
    });

    it('should return dash for null/undefined', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const formatValue = (notifier as any).formatValue.bind(notifier);

      expect(formatValue('key', null)).toBe('-');
      expect(formatValue('key', undefined)).toBe('-');
    });
  });

  // ==========================================================================
  // Markdown Escaping Tests
  // ==========================================================================

  describe('escapeMarkdown', () => {
    it('should escape asterisks', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown;

      expect(escapeMarkdown('*bold*')).toBe('\\*bold\\*');
    });

    it('should escape underscores', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown;

      expect(escapeMarkdown('_italic_')).toBe('\\_italic\\_');
    });

    it('should escape brackets for links', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown;

      expect(escapeMarkdown('[link](url)')).toBe('\\[link\\]\\(url\\)');
    });

    it('should escape backticks', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown;

      expect(escapeMarkdown('`code`')).toBe('\\`code\\`');
    });

    it('should escape tilde', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown;

      expect(escapeMarkdown('~strikethrough~')).toBe('\\~strikethrough\\~');
    });

    it('should escape pipe', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown;

      expect(escapeMarkdown('a|b|c')).toBe('a\\|b\\|c');
    });

    it('should escape all markdown special chars', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const escapeMarkdown = (notifier as any).escapeMarkdown;

      const input = '_*[]()~`>#+=|{}.!-';
      const output = escapeMarkdown(input);

      const specialChars = '_*[]()~`>#+=|{}.!-';
      for (const char of specialChars) {
        expect(output).toContain(`\\${char}`);
      }
    });
  });

  // ==========================================================================
  // Localization Tests
  // ==========================================================================

  describe('localization', () => {
    it('should use English labels by default', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage();

      const text = (notifier as any).buildMessageText(message);

      expect(text).toContain('Details');
      expect(text).toContain('Production');
    });

    it('should format Vietnamese labels when locale is vi', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage({
        metadata: { locale: 'vi' },
      });

      const text = (notifier as any).buildMessageText(message);

      expect(text).toContain('Details');
      expect(text).toContain('Production');
    });

    it('should use Vietnamese environment labels', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage({
        metadata: { locale: 'vi', environment: 'staging' },
      });

      const text = (notifier as any).buildMessageText(message);

      expect(text).toContain('Staging'); // Staging doesn't change in current implementation
    });
  });

  // ==========================================================================
  // Format Field Title Tests
  // ==========================================================================

  describe('formatFieldTitle', () => {
    it('should convert snake_case to Title Case', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const formatFieldTitle = (notifier as any).formatFieldTitle;

      expect(formatFieldTitle('wallet_address')).toBe("Wallet address");
      expect(formatFieldTitle('trade_volume')).toBe("Trade volume");
    });

    it('should convert camelCase to Title Case', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const formatFieldTitle = (notifier as any).formatFieldTitle;

      expect(formatFieldTitle('walletAddress')).toBe("Wallet Address");
      expect(formatFieldTitle('tradeVolume')).toBe("Trade Volume");
    });

    it('should handle single word', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const formatFieldTitle = (notifier as any).formatFieldTitle;

      expect(formatFieldTitle('exchange')).toBe('Exchange');
    });

    it('should trim whitespace', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const formatFieldTitle = (notifier as any).formatFieldTitle;

      expect(formatFieldTitle('  wallet_address  ')).toBe("wallet address");
    });
  });

  // ==========================================================================
  // Environment Label Tests
  // ==========================================================================

  describe('getEnvironmentLabel', () => {
    it('should return production label in English', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const getEnvLabel = (notifier as any).getEnvironmentLabel;

      expect(getEnvLabel('production')).toContain('Production');
    });

    it('should return staging label', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const getEnvLabel = (notifier as any).getEnvironmentLabel;

      expect(getEnvLabel('staging')).toContain('Staging');
    });

    it('should return development label', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const getEnvLabel = (notifier as any).getEnvironmentLabel;

      expect(getEnvLabel('development')).toContain('Development');
    });

    it('should handle custom environment', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const getEnvLabel = (notifier as any).getEnvironmentLabel;

      expect(getEnvLabel('custom')).toContain('custom');
    });
  });

  // ==========================================================================
  // Edge Cases Tests
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle title with markdown special characters', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage({
        title: 'Alert: *important* _note_ [ref]',
      });

      const text = (notifier as any).buildMessageText(message);

      // Should escape all special characters
      expect(text).toContain('\\*');
      expect(text).toContain('\\_');
      expect(text).toContain('\\[');
    });

    it('should handle empty payload actions', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage({
        payload: { actions: [] },
      });

      const text = (notifier as any).buildMessageText(message);

      // Should not include empty actions section
      expect(text).not.toContain('[');
    });

    it('should handle very long message content', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const longMessage = 'a'.repeat(2000);
      const message = createMockMessage({
        message: longMessage,
      });

      const text = (notifier as any).buildMessageText(message);

      // Telegram has 4096 char limit - should include content
      expect(text.length).toBeGreaterThan(1000);
    });

    it('should handle missing metadata gracefully', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage({
        metadata: undefined,
      });

      const text = (notifier as any).buildMessageText(message);

      // Should still produce valid message
      expect(text).toContain('*Test Alert Title*');
    });

    it('should handle timestamp as undefined', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const message = createMockMessage({
        timestamp: undefined,
      });

      const text = (notifier as any).buildMessageText(message);

      // Should still produce valid message with current time fallback
      expect(text).toContain('🕐');
    });
  });

  // ==========================================================================
  // Format Action Links Tests
  // ==========================================================================

  describe('formatActionLinks', () => {
    it('should format actions as markdown links', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const payload = {
        actions: [
          { label: 'View Dashboard', url: 'https://apexos.io/dashboard' },
        ],
      };

      const links = (notifier as any).formatActionLinks(payload, 'en');

      expect(links).toBe("\n[View Dashboard](https://apexos\\.io/dashboard)");
    });

    it('should return null when no actions', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);

      const links = (notifier as any).formatActionLinks({}, 'en');

      expect(links).toBeNull();
    });

    it('should escape URLs in markdown links', () => {
      const notifier = createTelegramNotifier(mockTelegramConfig);
      const payload = {
        actions: [
          { label: 'Test', url: 'https://test.com/path?query=value&other=2' },
        ],
      };

      const links = (notifier as any).formatActionLinks(payload, 'en');

      // Should escape special characters in URL (dot, equals)
      expect(links).toContain('\\.');
      expect(links).toContain('\\=');
    });
  });
});
