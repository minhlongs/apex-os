/**
 * Retry Utility Tests
 * Tests for exponential backoff retry logic
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  withRetry,
  makeRetryable,
  isRetryableError,
  calculateBackoff,
  DEFAULT_RETRY_CONFIG,
  RetryConfig,
} from '@/lib/notifications/retry';

// Use vi for fake timer control (available via jest global)
const vi = jest as any;

describe('Retry Utility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isRetryableError', () => {
    it('should retry on network errors', () => {
      const error = new Error('Network timeout');
      expect(isRetryableError(error, DEFAULT_RETRY_CONFIG)).toBe(true);
    });

    it('should retry on 5xx errors', () => {
      const error = new Error('Internal Server Error 500');
      expect(isRetryableError(error, DEFAULT_RETRY_CONFIG)).toBe(true);
    });

    it('should retry on 429 Too Many Requests', () => {
      const error = new Error('Too Many Requests 429');
      expect(isRetryableError(error, DEFAULT_RETRY_CONFIG)).toBe(true);
    });

    it('should not retry on 404 Not Found', () => {
      const error = new Error('Not Found 404');
      expect(isRetryableError(error, DEFAULT_RETRY_CONFIG)).toBe(false);
    });

    it('should not retry on 403 Forbidden', () => {
      const error = new Error('Forbidden 403');
      expect(isRetryableError(error, DEFAULT_RETRY_CONFIG)).toBe(false);
    });

    it('should not retry on authentication errors', () => {
      const error = new Error('Invalid API key');
      expect(isRetryableError(error, DEFAULT_RETRY_CONFIG)).toBe(false);
    });

    it('should respect custom non-retryable patterns', () => {
      const config: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        nonRetryablePatterns: [/custom error/],
      };
      const error = new Error('This is a custom error');
      expect(isRetryableError(error, config)).toBe(false);
    });
  });

  describe('calculateBackoff', () => {
    it('should calculate exponential backoff', () => {
      const config: RetryConfig = {
        maxAttempts: 3,
        backoffMs: 1000,
        maxBackoffMs: 30000,
      };

      // First attempt (attempt 1) should use base backoff
      const delay1 = calculateBackoff(1, config);
      expect(delay1).toBeGreaterThanOrEqual(800); // with jitter, can be lower
      expect(delay1).toBeLessThanOrEqual(1200);

      // Second attempt (attempt 2) should be 2x base
      const delay2 = calculateBackoff(2, config);
      expect(delay2).toBeGreaterThanOrEqual(1600);
      expect(delay2).toBeLessThanOrEqual(2400);

      // Third attempt (attempt 3) should be 4x base
      const delay3 = calculateBackoff(3, config);
      expect(delay3).toBeGreaterThanOrEqual(3200);
      expect(delay3).toBeLessThanOrEqual(4800);
    });

    it('should respect maxBackoffMs cap', () => {
      const config: RetryConfig = {
        maxAttempts: 10,
        backoffMs: 1000,
        maxBackoffMs: 5000,
      };

      const delay = calculateBackoff(10, config);
      expect(delay).toBeLessThanOrEqual(5000);
    });
  });

  describe('withRetry', () => {
    it('should return immediately on first success', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');

      const result = await withRetry(mockFn);

      expect(result.success).toBe(true);
      expect(result.value).toBe('success');
      expect(result.attempts).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should retry on failure and eventually succeed', async () => {
      const mockFn = jest.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce('success');

      const promise = withRetry(mockFn, {
        ...DEFAULT_RETRY_CONFIG,
        maxAttempts: 3,
        backoffMs: 100,
      });

      // Run all pending timers to completion
      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.value).toBe('success');
      expect(result.attempts).toBe(3);
      expect(result.errors).toHaveLength(2);
    });

    it('should fail after max attempts', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('Persistent error'));

      const promise = withRetry(mockFn, {
        ...DEFAULT_RETRY_CONFIG,
        maxAttempts: 2,
        backoffMs: 100,
      });

      // Run all pending timers to completion
      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.attempts).toBe(2);
      expect(result.errors).toHaveLength(2);
    });

    it('should not retry on non-retryable error', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('404 Not Found'));

      await expect(withRetry(mockFn, {
        ...DEFAULT_RETRY_CONFIG,
        maxAttempts: 3,
        backoffMs: 100,
      })).rejects.toThrow('404 Not Found');
    });

    it('should call onRetry callback on each retry', async () => {
      const onRetry = jest.fn();
      const mockFn = jest.fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValueOnce('success');

      const promise = withRetry(mockFn, {
        ...DEFAULT_RETRY_CONFIG,
        maxAttempts: 3,
        backoffMs: 100,
      }, onRetry);

      // Run all pending timers to completion
      await vi.runAllTimersAsync();

      await promise;

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

    it('should include total duration in result', async () => {
      const mockFn = jest.fn()
        .mockRejectedValueOnce(new Error('Error'))
        .mockResolvedValueOnce('success');

      const promise = withRetry(mockFn, {
        ...DEFAULT_RETRY_CONFIG,
        maxAttempts: 2,
        backoffMs: 100,
      });

      // Run all pending timers
      await vi.runAllTimersAsync();

      const result = await promise;

      // Should include some positive duration
      expect(result.totalDurationMs).toBeGreaterThan(0);
    });
  });

  describe('makeRetryable', () => {
    it('should wrap a function with retry logic', async () => {
      const mockFn = jest.fn()
        .mockRejectedValueOnce(new Error('Error'))
        .mockResolvedValueOnce('result');

      const retryableFn = makeRetryable(mockFn, {
        maxAttempts: 2,
        backoffMs: 100,
      });

      const promise = retryableFn();

      // Run all pending timers
      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.value).toBe('result');
    });
  });

  describe('Integration with Notification Channels', () => {
    it('should include retry info in SendResult-like output', async () => {
      const mockFn = jest.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('message-id-123');

      const promise = withRetry(mockFn, {
        maxAttempts: 2,
        backoffMs: 100,
      });

      // Run all timers to completion
      await vi.runAllTimersAsync();

      const result = await promise;

      // The result itself contains retry metadata
      expect(result).toHaveProperty('value', 'message-id-123');
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.totalDurationMs).toBeGreaterThan(0);
    });
  });
});
