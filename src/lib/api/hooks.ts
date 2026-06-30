/**
 * API Hooks for React
 *
 * Provides convenient hooks for making API calls with rate limit handling.
 *
 * Usage:
 * ```typescript
 * import { useApi, useRateLimitStatus } from '@/lib/api/hooks';
 *
 * function MyComponent() {
 *   const { data, error, loading, execute } = useApi('/api/deals');
 *
 *   // Or with options
 *   const { data: deals, error, loading } = useApi('/api/deals', {
 *     method: 'GET',
 *     withAuth: true,
 *     onRateLimit: (retryAfter) => {
 *       toast.warning(`Rate limited. Try again in ${retryAfter}s`);
 *     }
 *   });
 *
 *   // Rate limit status
 *   const { isRateLimited, retryAfter, limit, remaining } = useRateLimitStatus();
 *
 *   return <div>...</div>;
 * }
 * */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { apiClient, ApiError, ApiResponse, RateLimitInfo, ApiClientOptions } from './client';

export interface UseApiOptions<T = unknown> extends ApiClientOptions {
  /** HTTP method (GET, POST, etc.) */
  method?: string;
  /** Request body for POST/PUT/PATCH */
  body?: unknown;
  /** Auto-execute on mount */
  autoExecute?: boolean;
  /** Dependency array for auto-execute */
  deps?: React.DependencyList;
  /** Transform the response data */
  transform?: (data: unknown) => T;
  /** Callback when data changes */
  onSuccess?: (data: T, response: ApiResponse<T>) => void;
  /** Callback on error */
  onError?: (error: ApiError) => void;
}

export interface UseApiResult<T = unknown> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  executing: boolean;
  execute: (options?: Partial<UseApiOptions<T>>) => Promise<ApiResponse<T> | null>;
  reset: () => void;
  refresh: () => Promise<void>;
}

/**
 * Hook for making API calls with rate limit handling
 */
export function useApi<T = unknown>(
  endpoint: string | null,
  options: UseApiOptions<T> = {}
): UseApiResult<T> {
  const {
    autoExecute = true,
    deps = [],
    transform,
    onSuccess,
    onError: onErrorCallback,
    ...apiOptions
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(autoExecute && !!endpoint);
  const [executing, setExecuting] = useState(false);

  // Store the latest options for use in execute
  const optionsRef = useRef(apiOptions);
  optionsRef.current = apiOptions;

  const execute = useCallback(async (
    overrideOptions?: Partial<UseApiOptions<T>>
  ): Promise<ApiResponse<T> | null> => {
    if (!endpoint) {
      return null;
    }

    const opts = { ...optionsRef.current, ...overrideOptions };
    setExecuting(true);
    setError(null);

    try {
      const response = await apiClient.request<T>(
        opts.method || 'GET',
        endpoint,
        opts.body,
        {
          ...opts,
          onError: (err: ApiError) => {
            setError(err);
            opts.onError?.(err);
            onErrorCallback?.(err);
          }
        }
      );

      const transformedData = transform ? transform(response.data) : response.data;
      setData(transformedData);
      onSuccess?.(transformedData, response);

      return response;
    } finally {
      setExecuting(false);
    }
  }, [endpoint, transform, onSuccess, onErrorCallback]);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    await execute({ ...apiOptions, autoExecute: false });
  }, [execute, apiOptions]);

  // Auto-execute on mount if endpoint provided and autoExecute is true
  useEffect(() => {
    if (autoExecute && endpoint && loading) {
      execute({ ...apiOptions, autoExecute: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, autoExecute, ...deps]);

  return {
    data,
    error,
    loading,
    executing,
    execute,
    reset,
    refresh
  };
}

/**
 * Hook for rate limit status tracking
 * Tracks the rate limit headers from the most recent API call
 */
export function useRateLimitStatus(): {
  isRateLimited: boolean;
  retryAfter: number | null;
  limit: number;
  remaining: number;
  resetAt: number | null;
  updateFromHeaders: (headers: Headers) => void;
} {
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitInfo>({
    limit: 0,
    remaining: 0,
    reset: 0
  });
  const [isRateLimited, setIsRateLimited] = useState(false);

  const updateFromHeaders = useCallback((headers: Headers) => {
    const limit = parseInt(headers.get('X-RateLimit-Limit') || '0', 10);
    const remaining = parseInt(headers.get('X-RateLimit-Remaining') || '0', 10);
    const reset = parseInt(headers.get('X-RateLimit-Reset') || '0', 10);
    const retryAfter = headers.get('Retry-After');

    setRateLimitInfo({ limit, remaining, reset });

    if (remaining === 0 || retryAfter) {
      setIsRateLimited(true);
    } else {
      setIsRateLimited(false);
    }
  }, []);

  return {
    isRateLimited,
    retryAfter: rateLimitInfo.reset ? Math.max(0, Math.ceil(rateLimitInfo.reset - Date.now() / 1000)) : null,
    limit: rateLimitInfo.limit,
    remaining: rateLimitInfo.remaining,
    resetAt: rateLimitInfo.reset || null,
    updateFromHeaders
  };
}

/**
 * Hook for handling rate limited requests with countdown
 */
export function useRateLimitCountdown(retryAfter: number | null): {
  countdown: number;
  isExpired: boolean;
} {
  const [countdown, setCountdown] = useState(retryAfter || 0);

  useEffect(() => {
    if (retryAfter === null || retryAfter <= 0) {
      setCountdown(0);
      return;
    }

    setCountdown(retryAfter);

    const interval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [retryAfter]);

  return {
    countdown,
    isExpired: countdown <= 0
  };
}

/**
 * Hook for API calls with optimistic updates
 */
export function useOptimisticApi<T>(
  endpoint: string,
  options: UseApiOptions<T> = {}
): UseApiResult<T> & {
  optimisticUpdate: (updater: (current: T | null) => T | null) => void;
  rollbackOptimistic: () => void;
} {
  const { data, error, loading, execute, reset, refresh } = useApi<T>(endpoint, options);
  const optimisticRef = useRef<T | null>(null);

  const optimisticUpdate = useCallback((updater: (current: T | null) => T | null) => {
    optimisticRef.current = updater(data);
    // For optimistic updates, you'd typically update local state immediately
    // then sync with server - this is a simplified version
  }, [data]);

  const rollbackOptimistic = useCallback(() => {
    optimisticRef.current = null;
  }, []);

  return {
    data,
    error,
    loading,
    executing: loading,
    execute,
    reset,
    refresh,
    optimisticUpdate,
    rollbackOptimistic
  };
}
