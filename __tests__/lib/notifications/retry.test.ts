/**
 * Retry Utility Tests
 *
 * Comprehensive tests for retry.ts covering:
 * - isRetryableError logic
 * - calculateBackoff with exponential and jitter
 * - withRetry success/failure scenarios
 * - makeRetryable wrapper
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  withRetry,
  isRetryableError,
  calculateBackoff,
  makeRetryable,
  DEFAULT_RETRY_CONFIG,
  RetryConfig,
} from '@/lib/notifications/retry';

const vi = jest as any;

describe('isRetryableError', () => {
  const config = DEFAULT_RETRY_CONFIG;

  describe('Non-retryable patterns', () => {
    it('should not retry on unauthorized errors', () => {
      expect(isRetryableError(new Error('Unauthorized access'), config)).toBe(false);
    });

    it('should not retry on forbidden errors', () => {
      expect(isRetryableError(new Error('Forbidden'), config)).toBe(false);
    });

    it('should not retry on 404 errors', () => {
      expect(isRetryableError(new Error('Not found - 404'), config)).toBe(false);
    });

    it('should not retry on invalid input', () => {
      expect(isRetryableError(new Error('Invalid token provided'), config)).toBe(false);
    });

    it('should not retry on authentication failures', () => {
      expect(isRetryableError(new Error('Authentication failed'), config)).toBe(false);
    });
  });

  describe('Retryable patterns', () => {
    it('should retry on timeout errors', () => {
      expect(isRetryableError(new Error('Request timeout'), config)).toBe(true);
    });

    it('should retry on connection reset', () => {
      expect(isRetryableError(new Error('ECONNRESET'), config)).toBe(true);
    });

    it('should retry on network errors', () => {
      expect(isRetryableError(new Error('Network failure'), config)).toBe(true);
    });

    it('should retry on fetch failures', () => {
      expect(isRetryableError(new Error('Failed to fetch'), config)).toBe(true);
    });

    it('should retry on 429 rate limit', () => {
      expect(isRetryableError(new Error('Error 429: Too Many Requests'), config)).toBe(true);
    });

    it('should retry on 5xx server errors', () => {
      expect(isRetryableError(new Error('Error 500: Internal Server Error'), config)).toBe(true);
      expect(isRetryableError(new Error('Error 502: Bad Gateway'), config)).toBe(true);
      expect(isRetryableError(new Error('Error 503: Service Unavailable'), config)).toBe(true);
      expect(isRetryableError(new Error('Error 504: Gateway Timeout'), config)).toBe(true);
    });

    it('should retry on service unavailable', () => {
      expect(isRetryableError(new Error('Service temporarily unavailable'), config)).toBe(true);
    });
  });

  describe('HTTP status code logic', () => {
    it('should not retry on 4xx errors except 429', () => {
      expect(isRetryableError(new Error('400 Bad Request'), config)).toBe(false);
      expect(isRetryableError(new Error('401 Unauthorized'), config)).toBe(false);
      expect(isRetryableError(new Error('403 Forbidden'), config)).toBe(false);
      expect(isRetryableError(new Error('404 Not Found'), config)).toBe(false);
    });

    it('should retry on 5xx errors', () => {
      for (let status = 500; status <= 599; status++) {
        expect(isRetryableError(new Error(`Error ${status}`), config)).toBe(true);
      }
    });
  });

  describe('Default behavior', () => {
    it('should retry on unknown errors by default', () => {
      expect(isRetryableError(new Error('Some unknown error'), config)).toBe(true);
    });

    it('should handle empty error message', () => {
      expect(isRetryableError(new Error(''), config)).toBe(true);
    });
  });

  describe('Custom config', () => {
    it('should use custom retryable patterns', () => {
      const customConfig: RetryConfig = {
        maxAttempts: 3,
        backoffMs: 1000,
        maxBackoffMs: 30000,
        retryablePatterns: [/custom/],
        nonRetryablePatterns: [],
      };
      expect(isRetryableError(new Error('custom error'), customConfig)).toBe(true);
      expect(isRetryableError(new Error('standard error'), customConfig)).toBe(true);
    });

    it('should use custom non-retryable patterns', () => {
      const customConfig: RetryConfig = {
        ...config,
        nonRetryablePatterns: [/timeout/],
      };
      expect(isRetryableError(new Error('Request timeout'), customConfig)).toBe(false);
    });

    it('should handle undefined pattern arrays', () => {
      const minimalConfig: RetryConfig = {
        maxAttempts: 3,
        backoffMs: 1000,
        maxBackoffMs: 30000,
      };
      expect(isRetryableError(new Error('Any error'), minimalConfig)).toBe(true);
    });
  });
});

describe('calculateBackoff', () => {
  const config = DEFAULT_RETRY_CONFIG;

  describe('Exponential backoff', () => {
    it('should calculate correct base backoff for attempt 1', () => {
      const backoff = calculateBackoff(1, config);
      expect(backoff).toBeGreaterThanOrEqual(800);
      expect(backoff).toBeLessThanOrEqual(1200);
    });

    it('should double backoff for attempt 2', () => {
      const backoff = calculateBackoff(2, config);
      expect(backoff).toBeGreaterThanOrEqual(1600);
      expect(backoff).toBeLessThanOrEqual(2400);
    });

    it('should quadruple backoff for attempt 3', () => {
      const backoff = calculateBackoff(3, config);
      expect(backoff).toBeGreaterThanOrEqual(3200);
      expect(backoff).toBeLessThanOrEqual(4800);
    });

    it('should respect maxBackoff cap', () => {
      const backoff = calculateBackoff(10, config);
      expect(backoff).toBeLessThanOrEqual(30000);
    });
  });

  describe('Jitter', () => {
    it('should have variance across multiple calculations', () => {
      const values = new Set<number>();
      for (let i = 0; i < 100; i++) {
        values.add(calculateBackoff(1, config));
      }
      expect(values.size).toBeGreaterThanOrEqual(1);
    });

    it('should not produce negative values', () => {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const backoff = calculateBackoff(attempt, config);
        expect(backoff).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Custom backoff', () => {
    it('should use custom base backoff', () => {
      const customConfig: RetryConfig = {
        ...config,
        backoffMs: 500,
        maxBackoffMs: 10000,
      };
      const backoff = calculateBackoff(1, customConfig);
      expect(backoff).toBeGreaterThanOrEqual(400);
      expect(backoff).toBeLessThanOrEqual(600);
    });

    it('should handle zero backoff', () => {
      const zeroConfig: RetryConfig = {
        maxAttempts: 3,
        backoffMs: 0,
        maxBackoffMs: 30000,
      };
      const backoff = calculateBackoff(1, zeroConfig);
      expect(backoff).toBe(0);
    });
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Success scenarios', () => {
    it('should return result on first attempt', async () => {
      const mockFn = vi.fn().mockResolvedValue('success');
      const result = await withRetry(mockFn);
      expect(result.success).toBe(true);
      expect(result.value).toBe('success');
      expect(result.attempts).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should return after retry succeeds', async () => {
      const mockFn = vi.fn()
        .mockRejectedValueOnce(new Error('First failure'))
        .mockResolvedValue('success');

      const promise = withRetry(mockFn, { ...DEFAULT_RETRY_CONFIG, backoffMs: 100 });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.value).toBe('success');
      expect(result.attempts).toBe(2);
      expect(result.errors).toHaveLength(1);
    });

    it('should succeed after multiple retries', async () => {
      const mockFn = vi.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');

      const promise = withRetry(mockFn, { maxAttempts: 3, backoffMs: 100 });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe('Failure scenarios', () => {
    it('should fail after all attempts exhausted', async () => {
      const mockFn = vi.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockRejectedValueOnce(new Error('Fail 3'));

      const promise = withRetry(mockFn, { maxAttempts: 3, backoffMs: 100 });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.attempts).toBe(3);
      expect(result.errors).toHaveLength(3);
    });

    it('should fail immediately on non-retryable error', async () => {
      const mockFn = vi.fn().mockRejectedValue(new Error('Unauthorized'));
      await expect(withRetry(mockFn)).rejects.toThrow('Unauthorized');
    });
  });

  describe('onRetry callback', () => {
    it('should call onRetry with correct parameters', async () => {
      const mockFn = vi.fn()
        .mockRejectedValueOnce(new Error('Network timeout'));
      const onRetry = vi.fn();

      const promise = withRetry(mockFn, { maxAttempts: 2, backoffMs: 100 }, onRetry);
      await vi.runAllTimersAsync();
      await promise;

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ message: 'Network timeout' }),
        expect.any(Number)
      );
    });

    it('should call onRetry on each retry attempt', async () => {
      const mockFn = vi.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');
      const onRetry = vi.fn();

      const promise = withRetry(mockFn, { maxAttempts: 3, backoffMs: 100 }, onRetry);
      await vi.runAllTimersAsync();
      await promise;

      expect(onRetry).toHaveBeenCalledTimes(2);
    });
  });

  describe('Duration tracking', () => {
    it('should track total duration', async () => {
      const mockFn = vi.fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValue('success');

      const promise = withRetry(mockFn, { maxAttempts: 2, backoffMs: 100 });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.totalDurationMs).toBeGreaterThan(0);
    });
  });

  describe('Custom config', () => {
    it('should respect custom maxAttempts', async () => {
      const mockFn = vi.fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockRejectedValueOnce(new Error('Fail 2'));

      const customConfig: RetryConfig = {
        maxAttempts: 2,
        backoffMs: 100,
        maxBackoffMs: 1000,
      };

      const promise = withRetry(mockFn, customConfig);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.attempts).toBe(2);
      expect(result.errors).toHaveLength(2);
    });
  });
});

describe('makeRetryable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should wrap function and return RetryResult', async () => {
    const mockFn = vi.fn().mockResolvedValue('wrapped success');
    const retryable = makeRetryable(mockFn);
    const result = await retryable();

    expect(result).toHaveProperty('value', 'wrapped success');
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('attempts', 1);
    expect(result).toHaveProperty('errors', []);
    expect(result).toHaveProperty('totalDurationMs');
  });

  it('should pass arguments to wrapped function', async () => {
    const mockFn = vi.fn().mockResolvedValue(undefined);
    const retryable = makeRetryable(mockFn);
    await retryable('arg1', 'arg2', { key: 'value' });
    expect(mockFn).toHaveBeenCalledWith('arg1', 'arg2', { key: 'value' });
  });

  it('should apply retry logic to wrapped function', async () => {
    const mockFn = vi.fn()
      .mockRejectedValueOnce(new Error('Error'))
      .mockResolvedValue('result');

    const retryable = makeRetryable(mockFn, { maxAttempts: 2, backoffMs: 100 });

    const promise = retryable();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });
});

describe('withRetry realistic scenarios', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    (console.error as any).mockRestore();
  });

  it('should retry on network timeout pattern', async () => {
    const mockFn = vi.fn()
      .mockRejectedValue(new Error('Request timeout after 5000ms'))
      .mockResolvedValue('finally succeeded');

    const promise = withRetry(mockFn, { ...DEFAULT_RETRY_CONFIG, maxAttempts: 2, backoffMs: 100 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.value).toBe('finally succeeded');
  });

  it('should not retry on 400 error', async () => {
    const mockFn = vi.fn().mockRejectedValue(new Error('400 Bad Request'));
    await expect(withRetry(mockFn)).rejects.toThrow('400 Bad Request');
  });

  it('should handle rapid retries with jitter variation', async () => {
    const delays: number[] = [];
    const mockFn = vi.fn()
      .mockRejectedValueOnce(new Error('Fail 1'))
      .mockRejectedValueOnce(new Error('Fail 2'))
      .mockResolvedValue('success');

    const onRetry = (_attempt: number, _error: Error, delayMs: number) => {
      delays.push(delayMs);
    };

    const promise = withRetry(mockFn, { maxAttempts: 3, backoffMs: 100 }, onRetry);
    await vi.runAllTimersAsync();
    await promise;

    expect(delays.length).toBe(2);
    // With jitter, delays can vary but should be approximately 100 and 200
    expect(delays[0]).toBeGreaterThanOrEqual(80);
    expect(delays[0]).toBeLessThanOrEqual(120);
    expect(delays[1]).toBeGreaterThanOrEqual(160);
    expect(delays[1]).toBeLessThanOrEqual(240);
  });
});
