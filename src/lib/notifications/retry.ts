/**
 * Retry Utility for Notification Channels
 * Provides exponential backoff retry with jitter for transient failures
 */

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts: number;
  /** Base backoff time in milliseconds (default: 1000) */
  backoffMs: number;
  /** Maximum backoff time in milliseconds (default: 30000) */
  maxBackoffMs?: number;
  /** Retryable error patterns - if error message matches any pattern, retry */
  retryablePatterns?: RegExp[];
  /** Non-retryable error patterns - if error message matches, don't retry */
  nonRetryablePatterns?: RegExp[];
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
  success: boolean;
  errors: Error[];
  totalDurationMs: number;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxAttempts: 3,
  backoffMs: 1000,
  maxBackoffMs: 30000,
  retryablePatterns: [
    /timeout/i,
    /econnreset/i,
    /network/i,
    /fetch/i,
    /failed to fetch/i,
    /request failed/i,
    /too many requests/i,
    /rate limit/i,
    /429/i,
    /5\d{2}/i, // 5xx server errors
    /service unavailable/i,
    /bad gateway/i,
    /gateway timeout/i,
  ],
  nonRetryablePatterns: [
    /unauthorized/i,
    /forbidden/i,
    /not found/i,
    /404/i,
    /invalid/i,
    /authentication/i,
    /apikey/i,
    /token/i,
  ],
};

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: Error, config: RetryConfig): boolean {
  const message = error.message.toLowerCase();

  // Check non-retryable patterns first
  if (config.nonRetryablePatterns?.some(pattern => pattern.test(message))) {
    return false;
  }

  // Check if matches any retryable pattern
  if (config.retryablePatterns?.some(pattern => pattern.test(message))) {
    return true;
  }

  // Default: retry on network errors and unknown errors
  // but not on 4xx errors (except 429)
  const statusMatch = message.match(/(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if (status >= 400 && status < 500 && status !== 429) {
      return false;
    }
    if (status >= 500) {
      return true;
    }
  }

  // Conservative: retry on any Error by default for transient issues
  return true;
}

/**
 * Calculate backoff delay with exponential growth and jitter
 */
export function calculateBackoff(attempt: number, config: RetryConfig): number {
  const { backoffMs, maxBackoffMs } = config;

  // Exponential backoff: base * 2^attempt
  const exponential = backoffMs * Math.pow(2, attempt - 1);

  // Add jitter (±20%)
  const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
  let delayed = exponential + jitter;

  // Apply max cap if maxBackoffMs is truthy (>0)
  if (maxBackoffMs && maxBackoffMs > 0) {
    delayed = Math.min(delayed, maxBackoffMs);
  }

  // Ensure non-negative and round
  return Math.max(0, Math.round(delayed));
}

/**
 * Execute a function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
): Promise<RetryResult<T>> {
  const errors: Error[] = [];
  const startTime = Date.now();

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const result = await fn();
      return {
        value: result,
        attempts: attempt,
        success: true,
        errors,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error) {
      errors.push(error as Error);

      // If this was the last attempt, throw
      if (attempt >= config.maxAttempts) {
        break;
      }

      // Check if error is retryable
      const err = error as Error;
      if (!isRetryableError(err, config)) {
        // Not retryable, fail immediately
        throw error;
      }

      // Calculate delay before next attempt
      const delayMs = calculateBackoff(attempt, config);

      // Notify callback
      if (onRetry) {
        onRetry(attempt, err, delayMs);
      }

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // All attempts failed
  return {
    value: undefined as unknown as T,
    attempts: config.maxAttempts,
    success: false,
    errors,
    totalDurationMs: Date.now() - startTime,
  };
}

/**
 * Create a retryable function wrapper
 */
export function makeRetryable<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
): (...args: Parameters<T>) => Promise<RetryResult<ReturnType<T>>> {
  return async (...args: Parameters<T>): Promise<RetryResult<ReturnType<T>>> => {
    return withRetry(() => fn(...args), config, onRetry);
  };
}
