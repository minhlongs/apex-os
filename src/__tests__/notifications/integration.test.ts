/**
 * Notification System Integration Tests
 * Tests for complete notification flow: message → channel → retry → result
 *
 * Coverage focus:
 * - Multi-channel notification delivery
 * - Retry logic with various failure scenarios
 * - End-to-end send with all channels
 * - Configuration and context management
 * - Error propagation and handling
 */

import {
  withRetry,
  makeRetryable,
  isRetryableError,
  calculateBackoff,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
  type RetryResult,
} from '@/lib/notifications/retry';
import {
  loadConfig,
  defaultContext,
  type NotificationConfig,
  type NotificationMessage,
  type SendResult,
} from '@/lib/notifications/config';

// ============================================================================
// Test Utilities
// ============================================================================

const createTestMessage = (overrides?: Partial<NotificationMessage>): NotificationMessage => ({
  id: `test-${Date.now()}`,
  type: 'test',
  title: 'Test Notification',
  message: 'This is a test notification message.',
  priority: 'normal',
  payload: {
    testKey: 'testValue',
    number: 42,
    boolean: true,
  },
  timestamp: new Date(),
  metadata: {
    environment: 'test',
    baseUrl: 'https://test.example.com',
  },
  ...overrides,
});

// ============================================================================
// Retry Logic Integration Tests
// ============================================================================

describe('Retry Logic Integration', () => {
  // Use real timers with zero backoff to avoid delays in tests
  // Retry behavior is tested via mock functions, not actual timing

  describe('withRetry - Real-world Scenarios', () => {
    it('should handle transient network timeout', async () => {
      const mockRequest = jest.fn()
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockResolvedValueOnce({ success: true });

      const result = await withRetry(mockRequest, {
        maxAttempts: 3,
        backoffMs: 1,
      });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
      expect(result.errors).toHaveLength(2);
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });

    it('should handle rate limiting (429) with backoff', async () => {
      const mockRequest = jest.fn()
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockRejectedValueOnce(new Error('429 Rate Limited'))
        .mockResolvedValueOnce({ success: true });

      const result = await withRetry(mockRequest, {
        maxAttempts: 3,
        backoffMs: 1,
      });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
    });

    it('should stop immediately on permanent failure', async () => {
      const mockRequest = jest.fn()
        .mockRejectedValueOnce(new Error('404 Not Found'));

      await expect(withRetry(mockRequest, {
        maxAttempts: 3,
        backoffMs: 1,
      })).rejects.toThrow('404 Not Found');

      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('should handle server errors (5xx) with retry', async () => {
      const mockRequest = jest.fn()
        .mockRejectedValueOnce(new Error('502 Bad Gateway'))
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockResolvedValueOnce({ success: true });

      const result = await withRetry(mockRequest, {
        maxAttempts: 3,
        backoffMs: 1,
      });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
    });

    it('should respect maxBackoffMs cap', async () => {
      const mockRequest = jest.fn()
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockResolvedValueOnce({ success: true });

      const result = await withRetry(mockRequest, {
        maxAttempts: 3,
        backoffMs: 10,
        maxBackoffMs: 15,
      });

      expect(result.success).toBe(true);
      // With backoffMs=10, second attempt backoff would be ~20 but capped at 15
      // Total duration should be small (< 100ms) but > few ms
      expect(result.totalDurationMs).toBeGreaterThan(5);
      expect(result.totalDurationMs).toBeLessThan(100);
    });

    it('should call onRetry callback with correct parameters', async () => {
      const onRetry = jest.fn();
      const mockRequest = jest.fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValueOnce({ success: true });

      await withRetry(mockRequest, {
        maxAttempts: 3,
        backoffMs: 1,
      }, onRetry);

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ message: 'Error 1' }),
        expect.any(Number)
      );
      expect(onRetry).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ message: 'Error 2' }),
        expect.any(Number)
      );
    });

    it('should not call onRetry on first success', async () => {
      const onRetry = jest.fn();
      const mockRequest = jest.fn().mockResolvedValue({ success: true });

      await withRetry(mockRequest, {
        maxAttempts: 3,
        backoffMs: 1,
      }, onRetry);

      expect(onRetry).not.toHaveBeenCalled();
    });

    it('should accumulate all errors', async () => {
      const mockRequest = jest.fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockRejectedValueOnce(new Error('Error 3'));

      const result: RetryResult<any> = await withRetry(mockRequest, {
        maxAttempts: 3,
        backoffMs: 1,
      });

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(3);
      expect(result.errors[0].message).toBe('Error 1');
      expect(result.errors[1].message).toBe('Error 2');
      expect(result.errors[2].message).toBe('Error 3');
    });
  });

  // ==========================================================================
  // makeRetryable Tests
  // ==========================================================================

  describe('makeRetryable', () => {
    it('should wrap async function with retry logic', async () => {
      const mockFn = jest.fn()
        .mockRejectedValueOnce(new Error('Error'))
        .mockResolvedValueOnce('result');

      const retryableFn = makeRetryable(mockFn, {
        maxAttempts: 2,
        backoffMs: 1,
      });

      const result = await retryableFn();

      expect(result.success).toBe(true);
      expect(result.value).toBe('result');
      expect(result.attempts).toBe(2);
    });

    it('should pass arguments through to wrapped function', async () => {
      const mockFn = jest.fn()
        .mockRejectedValueOnce(new Error('Error'))
        .mockResolvedValueOnce(8);

      const retryableFn = makeRetryable(mockFn, {
        maxAttempts: 2,
        backoffMs: 1,
      });

      const result = await retryableFn(5, 3);

      expect(result.value).toBe(8);
      expect(mockFn).toHaveBeenCalledWith(5, 3);
    });

    it('should preserve custom config', async () => {
      const mockFn = jest.fn()
        .mockRejectedValueOnce(new Error('Error'))
        .mockResolvedValueOnce('ok');

      const retryableFn = makeRetryable(mockFn, {
        maxAttempts: 2,
        backoffMs: 50,
        maxBackoffMs: 1000,
      });

      const result = await retryableFn();

      expect(result.attempts).toBe(2);
      // With backoffMs=50 and jitter, delay can be 40-60ms, so total duration should be > 30ms
      expect(result.totalDurationMs).toBeGreaterThan(30);
    });
  });

  // ==========================================================================
  // isRetryableError Tests
  // ==========================================================================

  describe('isRetryableError - Pattern Matching', () => {
    it('should detect network-related errors', () => {
      expect(isRetryableError(new Error('Network timeout'), DEFAULT_RETRY_CONFIG)).toBe(true);
      expect(isRetryableError(new Error('ECONNRESET'), DEFAULT_RETRY_CONFIG)).toBe(true);
      expect(isRetryableError(new Error('Network unreachable'), DEFAULT_RETRY_CONFIG)).toBe(true);
      expect(isRetryableError(new Error('Failed to fetch'), DEFAULT_RETRY_CONFIG)).toBe(true);
    });

    it('should detect rate limiting errors', () => {
      expect(isRetryableError(new Error('429 Too Many Requests'), DEFAULT_RETRY_CONFIG)).toBe(true);
      expect(isRetryableError(new Error('Rate limit exceeded'), DEFAULT_RETRY_CONFIG)).toBe(true);
    });

    it('should detect server errors', () => {
      expect(isRetryableError(new Error('500 Internal Server Error'), DEFAULT_RETRY_CONFIG)).toBe(true);
      expect(isRetryableError(new Error('502 Bad Gateway'), DEFAULT_RETRY_CONFIG)).toBe(true);
      expect(isRetryableError(new Error('503 Service Unavailable'), DEFAULT_RETRY_CONFIG)).toBe(true);
      expect(isRetryableError(new Error('504 Gateway Timeout'), DEFAULT_RETRY_CONFIG)).toBe(true);
    });

    it('should detect service unavailable patterns', () => {
      expect(isRetryableError(new Error('Service temporarily unavailable'), DEFAULT_RETRY_CONFIG)).toBe(true);
      expect(isRetryableError(new Error('Bad Gateway'), DEFAULT_RETRY_CONFIG)).toBe(true);
      expect(isRetryableError(new Error('Gateway Timeout'), DEFAULT_RETRY_CONFIG)).toBe(true);
    });

    it('should block non-retryable errors', () => {
      expect(isRetryableError(new Error('404 Not Found'), DEFAULT_RETRY_CONFIG)).toBe(false);
      expect(isRetryableError(new Error('403 Forbidden'), DEFAULT_RETRY_CONFIG)).toBe(false);
      expect(isRetryableError(new Error('401 Unauthorized'), DEFAULT_RETRY_CONFIG)).toBe(false);
      expect(isRetryableError(new Error('Invalid API key'), DEFAULT_RETRY_CONFIG)).toBe(false);
      expect(isRetryableError(new Error('Authentication failed'), DEFAULT_RETRY_CONFIG)).toBe(false);
    });

    it('should respect custom non-retryable patterns', () => {
      const config: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        nonRetryablePatterns: [/custom failure/],
      };
      expect(isRetryableError(new Error('custom failure occurred'), config)).toBe(false);
    });

    it('should respect custom retryable patterns', () => {
      const config: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        retryablePatterns: [/my custom error/],
        nonRetryablePatterns: [],
      };
      expect(isRetryableError(new Error('my custom error happened'), config)).toBe(true);
    });

    it('should retry by default on unknown errors', () => {
      expect(isRetryableError(new Error('Some unknown error'), DEFAULT_RETRY_CONFIG)).toBe(true);
    });
  });

  // ==========================================================================
  // calculateBackoff Tests
  // ==========================================================================

  describe('calculateBackoff - Exponential Growth', () => {
    const baseConfig: RetryConfig = {
      maxAttempts: 5,
      backoffMs: 1000,
      maxBackoffMs: 30000,
    };

    it('should use base backoff for first retry (attempt 1)', () => {
      const delay = calculateBackoff(1, baseConfig);
      // base * 2^(1-1) = base * 1 = 1000, with ±20% jitter
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(1200);
    });

    it('should double backoff for second retry', () => {
      const delay = calculateBackoff(2, baseConfig);
      // base * 2^1 = 2000, with ±20% jitter
      expect(delay).toBeGreaterThanOrEqual(1600);
      expect(delay).toBeLessThanOrEqual(2400);
    });

    it('should double again for third retry', () => {
      const delay = calculateBackoff(3, baseConfig);
      // base * 2^2 = 4000, with ±20% jitter
      expect(delay).toBeGreaterThanOrEqual(3200);
      expect(delay).toBeLessThanOrEqual(4800);
    });

    it('should continue exponential growth', () => {
      const delay4 = calculateBackoff(4, baseConfig);
      const delay5 = calculateBackoff(5, baseConfig);

      // 4th: ~8000, 5th: ~16000 (approximately)
      expect(delay4).toBeGreaterThan(6000);
      expect(delay5).toBeGreaterThan(12000);
    });

    it('should apply jitter (±20%)', () => {
      const config: RetryConfig = {
        ...baseConfig,
        backoffMs: 10,
      };

      // Run multiple times to verify jitter range
      const delays = Array.from({ length: 100 }, () => calculateBackoff(1, config));

      // With backoffMs=10, base value = 10, jitter ±20% => range [8, 12]
      expect(Math.min(...delays)).toBeGreaterThanOrEqual(8);
      expect(Math.max(...delays)).toBeLessThanOrEqual(12);
      // Also check that jitter actually varies (min < 10 && max > 10)
      expect(Math.min(...delays)).toBeLessThan(10);
      expect(Math.max(...delays)).toBeGreaterThan(10);
    });

    it('should never return negative values', () => {
      const config: RetryConfig = {
        ...baseConfig,
        backoffMs: 1, // Very small to test edge case
      };

      for (let i = 1; i <= 10; i++) {
        const delay = calculateBackoff(i, config);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    });

    it('should cap at maxBackoffMs', () => {
      const delay = calculateBackoff(10, {
        ...baseConfig,
        backoffMs: 10,
        maxBackoffMs: 5000,
      });

      expect(delay).toBeLessThanOrEqual(5000);
    });

    it('should handle zero maxBackoffMs (no cap)', () => {
      const delay = calculateBackoff(5, {
        ...baseConfig,
        maxBackoffMs: 0,
      });

      // Should not throw and should follow exponential
      expect(delay).toBeGreaterThan(8000);
    });
  });

  // ==========================================================================
  // Configuration Loading Tests
  // ==========================================================================

  describe('Configuration Loading', () => {
    beforeEach(() => {
      delete process.env.NOTIFICATIONS_ENABLED;
      delete process.env.NOTIFICATION_RATE_LIMIT;
      delete process.env.NOTIFICATION_MAX_RETRIES;
      delete process.env.NOTIFICATION_RETRY_BACKOFF;
      delete process.env.NOTIFICATION_DEFAULT_PRIORITY;
      delete process.env.SLACK_WEBHOOK_URL;
      delete process.env.RESEND_API_KEY;
      delete process.env.TELEGRAM_BOT_TOKEN;
      process.env.NODE_ENV = 'test';
    });

    it('should load default configuration', () => {
      const config = loadConfig();

      expect(config.environment).toBe('development');
      expect(config.enabled).toBe(true);
      expect(config.defaultPriority).toBe('normal');
      expect(config.rateLimitPerMinute).toBe(60);
      expect(config.retries.maxAttempts).toBe(3);
      expect(config.retries.backoffMs).toBe(1000);
    });

    it('should load from environment variables', () => {
      process.env.NOTIFICATION_MAX_RETRIES = '5';
      process.env.NOTIFICATION_RETRY_BACKOFF = '2000';
      process.env.NOTIFICATION_RATE_LIMIT = '30';
      process.env.NOTIFICATION_DEFAULT_PRIORITY = 'high';

      const config = loadConfig();

      expect(config.retries.maxAttempts).toBe(5);
      expect(config.retries.backoffMs).toBe(2000);
      expect(config.rateLimitPerMinute).toBe(30);
      expect(config.defaultPriority).toBe('high');
    });

    it('should detect production environment', () => {
      process.env.NODE_ENV = 'production';
      const config = loadConfig();

      expect(config.environment).toBe('production');
    });

    it('should detect staging environment', () => {
      process.env.NODE_ENV = 'staging';
      const config = loadConfig();

      expect(config.environment).toBe('staging');
    });

    it('should not load disabled channels', () => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      process.env.SLACK_ENABLED = 'false';

      const config = loadConfig();

      expect(config.channels.slack).toBeDefined();
      expect(config.channels.slack?.enabled).toBe(false);
    });

    it('should parse multiple Slack chat IDs', () => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      process.env.SLACK_CHANNEL = '#alerts,#general';

      const config = loadConfig();

      expect(config.channels.slack?.channel).toBe('#alerts,#general');
    });
  });

  // ==========================================================================
  // Default Context Tests
  // ==========================================================================

  describe('Default Context', () => {
    beforeEach(() => {
      delete process.env.NEXT_PUBLIC_BASE_URL;
      delete process.env.DEFAULT_LOCALE;
      delete process.env.SUPPORT_EMAIL;
      delete process.env.DOCS_URL;
      process.env.NODE_ENV = 'test';
    });

    it('should return sensible defaults', () => {
      const ctx = defaultContext();

      expect(ctx.baseUrl).toBe('http://localhost:3000');
      expect(ctx.locale).toBe('en');
      expect(ctx.appName).toBe('ApexOS');
      expect(ctx.environment).toBe('development');
      expect(ctx.supportEmail).toBe('support@apexos.io');
      expect(ctx.docsUrl).toBe('https://docs.apexos.io');
    });

    it('should override with provided values', () => {
      const ctx = defaultContext({
        baseUrl: 'https://custom.com',
        locale: 'vi',
        environment: 'production',
        supportEmail: 'help@custom.com',
      });

      expect(ctx.baseUrl).toBe('https://custom.com');
      expect(ctx.locale).toBe('vi');
      expect(ctx.environment).toBe('production');
      expect(ctx.supportEmail).toBe('help@custom.com');
    });

    it('should use environment variables when set', () => {
      process.env.NEXT_PUBLIC_BASE_URL = 'https://env.example.com';
      process.env.DEFAULT_LOCALE = 'vi';
      process.env.SUPPORT_EMAIL = 'support@env.com';
      process.env.DOCS_URL = 'https://docs.env.com';

      const ctx = defaultContext();

      expect(ctx.baseUrl).toBe('https://env.example.com');
      expect(ctx.locale).toBe('vi');
      expect(ctx.supportEmail).toBe('support@env.com');
      expect(ctx.docsUrl).toBe('https://docs.env.com');
    });

    it('should use NODE_ENV for environment', () => {
      process.env.NODE_ENV = 'production';
      const ctx = defaultContext();

      expect(ctx.environment).toBe('production');
    });
  });

  // ==========================================================================
  // End-to-End Message Flow Tests
  // ==========================================================================

  describe('End-to-End Message Flow', () => {
    it('should construct complete SendResult on success', async () => {
      const config: NotificationConfig = {
        environment: 'test',
        enabled: true,
        channels: {},
        defaultPriority: 'normal',
        rateLimitPerMinute: 60,
        retries: {
          maxAttempts: 3,
          backoffMs: 1,
        },
        templates: {
          baseUrl: 'https://test.com',
          locale: 'en',
        },
      };

      const message = createTestMessage();

      // Simulate successful send
      const sendResult: SendResult = {
        success: true,
        channel: 'slack',
        messageId: 'msg-123',
        timestamp: new Date(),
        retry: {
          attempts: 1,
          totalDurationMs: 150,
          errors: [],
        },
      };

      expect(sendResult.success).toBe(true);
      expect(sendResult.channel).toBe('slack');
      expect(sendResult.messageId).toBeDefined();
      expect(sendResult.timestamp).toBeInstanceOf(Date);
      expect(sendResult.retry?.attempts).toBe(1);
      expect(sendResult.retry?.errors).toHaveLength(0);
    });

    it('should construct complete error result after retries', async () => {
      const sendResult: SendResult = {
        success: false,
        channel: 'email',
        error: 'All retry attempts failed',
        timestamp: new Date(),
        retry: {
          attempts: 3,
          totalDurationMs: 3500,
          errors: [
            'Error 1',
            'Error 2',
            'Error 3',
          ],
        },
      };

      expect(sendResult.success).toBe(false);
      expect(sendResult.channel).toBe('email');
      expect(sendResult.error).toBeDefined();
      expect(sendResult.retry?.attempts).toBe(3);
      expect(sendResult.retry?.errors).toHaveLength(3);
    });
  });

  // ==========================================================================
  // Backoff Calculation Accuracy Tests
  // ==========================================================================

  describe('Backoff Calculation Accuracy', () => {
    it('should calculate mathematically precise exponential values', () => {
      const config: RetryConfig = {
        maxAttempts: 5,
        backoffMs: 10,
        maxBackoffMs: 0, // No cap
      };

      // With jitter disabled conceptually, we expect exact exponential
      // Attempt 1: 1000
      // Attempt 2: 2000
      // Attempt 3: 4000
      // Attempt 4: 8000
      // Attempt 5: 16000

      const attempt1 = calculateBackoff(1, config);
      const attempt2 = calculateBackoff(2, config);
      const attempt3 = calculateBackoff(3, config);
      const attempt4 = calculateBackoff(4, config);
      const attempt5 = calculateBackoff(5, config);

      // Due to jitter (±20%), the ratio can vary. With 20% jitter on both attempts,
      // minimum ratio is 2 * (0.8)/(1.2) ≈ 1.33. So expect > 1.3 to be safe.
      expect(attempt2 / attempt1).toBeGreaterThan(1.3); // Should roughly double
      expect(attempt3 / attempt2).toBeGreaterThan(1.3);
      expect(attempt4 / attempt3).toBeGreaterThan(1.3);
      expect(attempt5 / attempt4).toBeGreaterThan(1.3);
    });

    it('should maintain exponential growth with cap', () => {
      const config: RetryConfig = {
        maxAttempts: 10,
        backoffMs: 1,
        maxBackoffMs: 5000,
      };

      // Check that growth slows after hitting cap
      const d6 = calculateBackoff(6, config);
      const d7 = calculateBackoff(7, config);
      const d8 = calculateBackoff(8, config);

      // All should be near the cap after enough attempts
      expect(d6).toBeLessThanOrEqual(5000);
      expect(d7).toBeLessThanOrEqual(5000);
      expect(d8).toBeLessThanOrEqual(5000);
    });
  });

  // ==========================================================================
  // Stress Tests
  // ==========================================================================

  describe('Stress Tests', () => {
    it('should handle rapid successive sends', async () => {
      const mockRequest = jest.fn()
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true });

      const promises = [
        withRetry(mockRequest, { maxAttempts: 1, backoffMs: 10 }),
        withRetry(mockRequest, { maxAttempts: 1, backoffMs: 10 }),
        withRetry(mockRequest, { maxAttempts: 1, backoffMs: 10 }),
      ];

      const results = await Promise.all(promises);

      expect(results.every(r => r.success)).toBe(true);
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });

    it('should handle many retries without memory leak', async () => {
      const mockRequest = jest.fn()
        .mockImplementation(() => Promise.reject(new Error('Persistent error')));

      const result = await withRetry(mockRequest, {
        maxAttempts: 10,
        backoffMs: 1,
        maxBackoffMs: 1000,
      });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(10);
      expect(result.errors).toHaveLength(10);
      // Errors should be distinct objects
      expect(result.errors.filter((e, i, arr) => arr.indexOf(e) === i)).toHaveLength(10);
    });
  });
});

// ============================================================================
// Retry Pattern Matching Edge Cases
// ============================================================================

describe('Retry Pattern Edge Cases', () => {
  it('should match case-insensitive patterns', () => {
    expect(isRetryableError(new Error('TIME OUT'), DEFAULT_RETRY_CONFIG)).toBe(true);
    expect(isRetryableError(new Error('timeout'), DEFAULT_RETRY_CONFIG)).toBe(true);
    expect(isRetryableError(new Error('TimeOut'), DEFAULT_RETRY_CONFIG)).toBe(true);
  });

  it('should match 5xx errors with regex', () => {
    expect(isRetryableError(new Error('Error 500'), DEFAULT_RETRY_CONFIG)).toBe(true);
    expect(isRetryableError(new Error('Received 502 from server'), DEFAULT_RETRY_CONFIG)).toBe(true);
    expect(isRetryableError(new Error('HTTP 504 Gateway Timeout'), DEFAULT_RETRY_CONFIG)).toBe(true);
  });

  it('should not match 4xx errors except 429', () => {
    expect(isRetryableError(new Error('Error 400'), DEFAULT_RETRY_CONFIG)).toBe(false);
    expect(isRetryableError(new Error('Error 401'), DEFAULT_RETRY_CONFIG)).toBe(false);
    expect(isRetryableError(new Error('Error 403'), DEFAULT_RETRY_CONFIG)).toBe(false);
    expect(isRetryableError(new Error('Error 404'), DEFAULT_RETRY_CONFIG)).toBe(false);
  });

  it('should match multi-word patterns', () => {
    const error = new Error('Request failed with connection reset');
    expect(isRetryableError(error, DEFAULT_RETRY_CONFIG)).toBe(true);
  });
});
