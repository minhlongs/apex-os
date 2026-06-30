/**
 * Email Notification Channel Tests
 * ApexOS Notification System
 *
 * Coverage focus:
 * - HTML email rendering with inline styles
 * - Template structure and sections
 * - Multi-language support (en/vi)
 * - Action buttons and links
 * - Details table formatting
 * - Priority indicators
 * - Text fallback rendering
 */

import { EmailNotifierChannel, createEmailNotifierChannel } from '@/lib/notifications/channels/email';
import type { EmailConfig, NotificationMessage } from '@/lib/notifications/config';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockEmailConfig: EmailConfig = {
  apiKey: 're_test123',
  fromEmail: 'alerts@apexos.io',
  fromName: 'ApexOS',
  defaultRecipients: ['admin@apexos.io'],
  replyTo: 'support@apexos.io',
};

const createMockMessage = (overrides?: Partial<NotificationMessage>): NotificationMessage => ({
  id: 'test-email-123',
  type: 'alert',
  title: 'Test Email Subject',
  message: 'This is the main email message content with details.',
  priority: 'normal',
  payload: {
    exchange: 'binance',
    tradeVolume: 25000.50,
    commission: 375.75,
    status: 'completed',
    walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
    actions: [
      { label: 'View Dashboard', url: '/dashboard' },
      { label: 'View Details', url: '/alerts/123' },
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

const createMockContext = (overrides?: Partial<NotificationContext>) => ({
  baseUrl: 'https://apexos.io',
  locale: 'en',
  appName: 'ApexOS',
  environment: 'production',
  supportEmail: 'support@apexos.io',
  docsUrl: 'https://docs.apexos.io',
  ...overrides,
});

// ============================================================================
// Constructor Tests
// ============================================================================

describe('EmailNotifierChannel', () => {
  describe('constructor', () => {
    it('should create instance with config', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      expect(notifier).toBeInstanceOf(EmailNotifierChannel);
      expect(notifier.getContext()).toBeDefined();
    });

    it('should use default context when not provided', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const ctx = notifier.getContext();

      expect(ctx.baseUrl).toBe('http://localhost:3000');
      expect(ctx.locale).toBe('en');
      expect(ctx.appName).toBe('ApexOS');
    });

    it('should override context with provided values', () => {
      const customContext = {
        baseUrl: 'https://test.com',
        locale: 'vi' as const,
        environment: 'staging',
      };
      const notifier = createEmailNotifierChannel(mockEmailConfig, customContext);
      const ctx = notifier.getContext();

      expect(ctx.baseUrl).toBe('https://test.com');
      expect(ctx.locale).toBe('vi');
      expect(ctx.environment).toBe('staging');
    });
  });

  // ==========================================================================
  // Build Email Tests
  // ==========================================================================

  describe('buildEmail', () => {
    it('should build email with subject, html, and text', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage();

      const email = (notifier as any).buildEmail(message, 'user@example.com');

      expect(email.subject).toBeDefined();
      expect(email.subject).toContain('[ApexOS]');
      expect(email.subject).toContain('Test Email Subject');

      expect(email.html).toBeDefined();
      expect(email.html).toContain('<!DOCTYPE html>');
      expect(email.html).toContain('Test Email Subject');

      expect(email.text).toBeDefined();
      expect(email.text).toContain('Test Email Subject');
    });

    it('should add priority prefix to subject for high priority', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage({ priority: 'high' });

      const email = (notifier as any).buildEmail(message, 'user@example.com');

      expect(email.subject).toContain('[HIGH]');
    });

    it('should add critical prefix to subject for critical priority', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage({ priority: 'critical' });

      const email = (notifier as any).buildEmail(message, 'user@example.com');

      expect(email.subject).toContain('[CRITICAL]');
    });

    it('should not add prefix for low/normal priority', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);

      ['low', 'normal'].forEach(priority => {
        const message = createMockMessage({ priority: priority as 'low' | 'normal' });
        const email = (notifier as any).buildEmail(message, 'user@example.com');

        // App name prefix is always included, but no priority bracket
        expect(email.subject).toBe(`[ApexOS] Test Email Subject`);
      });
    });

    it('should handle custom recipients array', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage();

      const email = (notifier as any).buildEmail(message, ['user1@example.com', 'user2@example.com']);

      // Email building should succeed regardless of recipients
      expect(email.subject).toBeDefined();
    });
  });

  // ==========================================================================
  // HTML Rendering Tests
  // ==========================================================================

  describe('renderHtmlEmail', () => {
    it('should render complete HTML structure with inline styles', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage();

      const html = (notifier as any).renderHtmlEmail(message);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html');
      expect(html).toContain('<head>');
      expect(html).toContain('<style>');
      expect(html).toContain('</head>');
      expect(html).toContain('<body>');
      expect(html).toContain('</body>');
      expect(html).toContain('</html>');
    });

    it('should include header with app name', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage();

      const html = (notifier as any).renderHtmlEmail(message);

      expect(html).toContain('class="header"');
      expect(html).toContain('ApexOS');
    });

    it('should include priority bar with correct color', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);

      const highMessage = createMockMessage({ priority: 'high' });
      const highHtml = (notifier as any).renderHtmlEmail(highMessage);
      expect(highHtml).toContain('background-color: #f59e0b'); // orange

      const criticalMessage = createMockMessage({ priority: 'critical' });
      const criticalHtml = (notifier as any).renderHtmlEmail(criticalMessage);
      expect(criticalHtml).toContain('background-color: #ef4444'); // red

      const lowMessage = createMockMessage({ priority: 'low' });
      const lowHtml = (notifier as any).renderHtmlEmail(lowMessage);
      expect(lowHtml).toContain('background-color: #6b7280'); // gray
    });

    it('should render action buttons', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage();

      const html = (notifier as any).renderHtmlEmail(message);

      expect(html).toContain('class="actions"');
      expect(html).toContain('View Dashboard');
      expect(html).toContain('href="');
      expect(html).toContain('class="button"');
    });

    it('should render details table from payload', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage();

      const html = (notifier as any).renderHtmlEmail(message);

      expect(html).toContain('class="details-table"');
      expect(html).toContain('<table');
      expect(html).toContain('<th>');
      expect(html).toContain('<td>');
    });

    it('should include timestamp', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage();

      const html = (notifier as any).renderHtmlEmail(message);

      expect(html).toContain('class="timestamp"');
    });

    it('should include footer with links', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage();

      const html = (notifier as any).renderHtmlEmail(message);

      expect(html).toContain('class="footer"');
      expect(html).toContain('View Dashboard');
      expect(html).toContain('Contact Support');
      expect(html).toContain('Manage Notifications');
      expect(html).toContain('Documentation');
    });

    it('should escape HTML in title', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage({
        title: '<script>alert("xss")</script>Test',
      });

      const html = (notifier as any).renderHtmlEmail(message);

      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('should handle empty payload gracefully', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage({ payload: {} });

      const html = (notifier as any).renderHtmlEmail(message);

      // Should still have complete structure without details
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('class="content"');
    });
  });

  // ==========================================================================
  // Text Email Tests
  // ==========================================================================

  describe('renderTextEmail', () => {
    it('should render plain text email', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage();

      const text = (notifier as any).renderTextEmail(message);

      expect(text).toContain('ApexOS Notification');
      expect(text).toContain('Test Email Subject');
      expect(text).toContain('This is the main email message content');
    });

    it('should include actions in text email', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage();

      const text = (notifier as any).renderTextEmail(message);

      expect(text).toContain('Actions:');
      expect(text).toContain('View Dashboard');
      expect(text).toContain('/dashboard');
    });

    it('should include sent timestamp', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage();

      const text = (notifier as any).renderTextEmail(message);

      expect(text).toContain('Sent at');
    });
  });

  // ==========================================================================
  // Formatting Tests
  // ==========================================================================

  describe('formatDetailValue', () => {
    it('should format numbers with locale', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const formatValue = (notifier as any).formatDetailValue.bind(notifier);

      const result = formatValue(1234.56);
      expect(result).toContain(',');
    });

    it('should format Date objects', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const formatValue = (notifier as any).formatDetailValue.bind(notifier);
      const date = new Date('2024-06-15T10:30:00Z');

      const result = formatValue(date);
      expect(result).toContain('2024');
    });

    it('should format booleans as Yes/No', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const formatValue = (notifier as any).formatDetailValue;

      expect(formatValue(true)).toBe('Yes');
      expect(formatValue(false)).toBe('No');
    });

    it('should format null/undefined as dash', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const formatValue = (notifier as any).formatDetailValue;

      expect(formatValue(null)).toBe('-');
      expect(formatValue(undefined)).toBe('-');
    });

    it('should stringify objects', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const formatValue = (notifier as any).formatDetailValue;

      const result = formatValue({ key: 'value' });
      expect(result).toContain('"key"');
      expect(result).toContain('"value"');
    });
  });

  describe('formatFieldTitle', () => {
    it('should convert snake_case to Title Case', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const formatFieldTitle = (notifier as any).formatFieldTitle;

      expect(formatFieldTitle('wallet_address')).toBe('Wallet address');
      expect(formatFieldTitle('trade_volume')).toBe('Trade volume');
    });

    it('should convert camelCase to Title Case', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const formatFieldTitle = (notifier as any).formatFieldTitle;

      expect(formatFieldTitle('walletAddress')).toBe('Wallet Address');
      expect(formatFieldTitle('tradeVolume')).toBe('Trade Volume');
    });
  });

  describe('escapeHtml', () => {
    it('should escape HTML special characters', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const escapeHtml = (notifier as any).escapeHtml;

      expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
      expect(escapeHtml('"test"')).toBe('&quot;test&quot;');
      expect(escapeHtml('a & b')).toBe('a &amp; b');
    });

    it('should handle empty string', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const escapeHtml = (notifier as any).escapeHtml;

      expect(escapeHtml('')).toBe('');
    });
  });

  // ==========================================================================
  // Localization Tests
  // ==========================================================================

  describe('localization', () => {
    it('should render English translations by default', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig, {
        locale: 'en',
      });

      const html = (notifier as any).renderHtmlEmail(createMockMessage());

      expect(html).toContain('View Dashboard');
      expect(html).toContain('Contact Support');
      expect(html).toContain('Manage Notifications');
    });

    it('should render Vietnamese translations when locale is vi', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig, {
        locale: 'vi',
      });

      const html = (notifier as any).renderHtmlEmail(createMockMessage());

      expect(html).toContain('Xem Bảng điều khiển');
      expect(html).toContain('Liên hệ Hỗ trợ');
      expect(html).toContain('Quản lý Thông báo');
    });

    it('should use locale-specific number formatting in text email', () => {
      const enNotifier = createEmailNotifierChannel(mockEmailConfig, { locale: 'en' });
      const viNotifier = createEmailNotifierChannel(mockEmailConfig, { locale: 'vi' });

      const message = createMockMessage({
        payload: { amount: 1234567.89 },
      });

      const enText = (enNotifier as any).renderTextEmail(message);
      const viText = (viNotifier as any).renderTextEmail(message);

      // Both should contain formatted amount but with different locale separators
      expect(enText).toMatch(/1,234,567\.89/);
      expect(viText).toMatch(/1\.234\.567,89/);
    });
  });

  // ==========================================================================
  // Environment Badge Tests
  // ==========================================================================

  describe('environment badge', () => {
    it('should show green for production', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig, {
        environment: 'production',
      });

      const html = (notifier as any).renderHtmlEmail(createMockMessage());

      expect(html).toContain('background-color: #10b981');
    });

    it('should show orange for staging', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig, {
        environment: 'staging',
      });

      const html = (notifier as any).renderHtmlEmail(createMockMessage());

      expect(html).toContain('background-color: #f59e0b');
    });

    it('should show gray for development', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig, {
        environment: 'development',
      });

      const html = (notifier as any).renderHtmlEmail(createMockMessage());

      expect(html).toContain('background-color: #6b7280');
    });
  });

  // ==========================================================================
  // Edge Cases Tests
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle very long wallet addresses', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const longAddress = '0x' + 'a'.repeat(100);
      const message = createMockMessage({
        payload: { walletAddress: longAddress },
      });

      const html = (notifier as any).renderHtmlEmail(message);

      // Should include the full address in HTML (email clients can truncate)
      expect(html).toContain(longAddress);
    });

    it('should handle special characters in message', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const message = createMockMessage({
        title: 'Test <>&"\'',
        message: 'Content with special chars: <>&"\'',
      });

      const html = (notifier as any).renderHtmlEmail(message);

      // Should be escaped in the HTML
      expect(html).toContain('&lt;&gt;&amp;&quot;');
    });

    it('should handle missing optional fields', () => {
      const notifier = createEmailNotifierChannel(mockEmailConfig);
      const minimalMessage: NotificationMessage = {
        type: 'test',
        title: 'Minimal',
        message: 'Minimal message',
        priority: 'normal',
        payload: {},
      };

      const email = (notifier as any).buildEmail(minimalMessage, 'user@example.com');

      expect(email.subject).toBeDefined();
      expect(email.html).toContain('Minimal');
      expect(email.text).toContain('Minimal');
    });
  });
});
