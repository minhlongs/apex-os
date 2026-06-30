/**
 * API Client for ApexOS
 *
 * Provides typed API calls with:
 * - Automatic rate limit handling (429 responses)
 * - Retry with exponential backoff
 * - Error parsing and user-friendly messages
 * - Request cancellation
 *
 * Usage:
 * ```typescript
 * import { apiClient } from '@/lib/api/client';
 *
 * // Simple GET
 * const data = await apiClient.get('/api/deals');
 *
 * // With auth and options
 * const result = await apiClient.post('/api/deals', body, {
 *   withAuth: true,
 *   maxRetries: 2,
 *   onRateLimit: (retryAfter) => {
 *     showToast(`Rate limited. Retrying in ${retryAfter}s`);
 *   }
 * });
 * ```
 */

const DEFAULT_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 30000; // 30 seconds
const MAX_RETRIES = 2; // Default max retries for rate limits

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

export interface ApiError {
  error: string;
  message?: string;
  details?: string;
  retryAfter?: number;
  rateLimit?: RateLimitInfo;
  status: number;
}

export interface ApiClientOptions {
  /** Include authentication headers */
  withAuth?: boolean;
  /** Maximum retries for rate limited requests */
  maxRetries?: number;
  /** Signal for request cancellation */
  signal?: AbortSignal;
  /** Custom base URL (defaults to current origin) */
  baseUrl?: string;
  /** Callback when rate limit is hit */
  onRateLimit?: (retryAfter: number, info: RateLimitInfo) => void;
  /** Callback for any error */
  onError?: (error: ApiError) => void;
}

export interface ApiResponse<T = unknown> {
  data: T;
  rateLimit?: RateLimitInfo;
}

class ApiClient {
  private baseUrl: string;
  private defaultOptions: ApiClientOptions;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl || '';
    this.defaultOptions = {
      maxRetries: MAX_RETRIES,
      withAuth: false,
      ...options
    };
  }

  /**
   * Make a GET request
   */
  async get<T>(endpoint: string, options: ApiClientOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('GET', endpoint, undefined, options);
  }

  /**
   * Make a POST request
   */
  async post<T>(endpoint: string, body?: unknown, options: ApiClientOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('POST', endpoint, body, options);
  }

  /**
   * Make a PATCH request
   */
  async patch<T>(endpoint: string, body?: unknown, options: ApiClientOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', endpoint, body, options);
  }

  /**
   * Make a DELETE request
   */
  async delete<T>(endpoint: string, options: ApiClientOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', endpoint, undefined, options);
  }

  /**
   * Core request method with retry logic for rate limits
   */
  public async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    options: ApiClientOptions = {}
  ): Promise<ApiResponse<T>> {
    const mergedOptions = { ...this.defaultOptions, ...options };
    const url = this.getFullUrl(endpoint);
    let lastError: ApiError | null = null;
    let attempt = 0;
    const maxRetries = mergedOptions.maxRetries ?? MAX_RETRIES;

    while (attempt <= maxRetries) {
      try {
        const response = await fetch(url, {
          method,
          headers: this.getHeaders(Boolean(mergedOptions.withAuth)),
          body: body ? JSON.stringify(body) : undefined,
          signal: mergedOptions.signal
        });

        const rateLimitInfo = this.parseRateLimitHeaders(response.headers);

        // Check for rate limit response
        if (response.status === 429) {
          const errorData: ApiError = {
            status: 429,
            error: 'Too Many Requests',
            ...(await this.parseErrorBody(response))
          };

          // Include rate limit info
          errorData.rateLimit = rateLimitInfo;
          if (rateLimitInfo.reset) {
            const retryAfter = Math.max(0, Math.ceil(rateLimitInfo.reset - Date.now() / 1000));
            errorData.retryAfter = retryAfter;
          }

          // If we have retries left and there's a retry-after value, wait and retry
          if (attempt < maxRetries && (errorData.retryAfter !== undefined || rateLimitInfo.remaining === 0)) {
            const waitTime = errorData.retryAfter || DEFAULT_RETRY_DELAY * Math.pow(2, attempt);
            const cappedWaitTime = Math.min(waitTime, MAX_RETRY_DELAY);

            if (mergedOptions.onRateLimit) {
              mergedOptions.onRateLimit(cappedWaitTime, rateLimitInfo);
            }

            // Wait before retrying
            await this.delay(cappedWaitTime);
            attempt++;
            continue;
          }

          // No more retries
          lastError = errorData;
          if (mergedOptions.onError) {
            mergedOptions.onError(errorData);
          }
          throw this.createError(errorData);
        }

        // Handle other error statuses
        if (!response.ok) {
          const errorData: ApiError = {
            status: response.status,
            error: response.statusText,
            ...(await this.parseErrorBody(response))
          };

          if (mergedOptions.onError) {
            mergedOptions.onError(errorData);
          }

          throw this.createError(errorData);
        }

        // Success - parse response
        const data = await response.json();

        return {
          data,
          rateLimit: rateLimitInfo
        };

      } catch (error) {
        // Check if it's our custom ApiError (by checking if it has the expected shape)
        if (this.isApiError(error)) {
          throw error as ApiError;
        }

        // For network errors or other issues, store and retry (up to maxRetries)
        const apiError: ApiError = {
          status: 0,
          error: 'Network Error',
          message: error instanceof Error ? error.message : 'Unknown error occurred'
        };
        lastError = apiError;

        if (attempt < maxRetries) {
          const waitTime = DEFAULT_RETRY_DELAY * Math.pow(2, attempt);
          await this.delay(waitTime);
          attempt++;
          continue;
        }

        if (mergedOptions.onError) {
          mergedOptions.onError(apiError);
        }

        throw this.createError(apiError);
      }
    }

    // Should not reach here, but just in case
    throw this.createError(lastError || {
      status: 0,
      error: 'Unknown Error',
      message: 'Request failed after retries'
    });
  }

  /**
   * Check if error is an ApiError by shape (not instanceof due to serialization)
   */
  private isApiError(error: unknown): error is ApiError {
    return (
      typeof error === 'object' &&
      error !== null &&
      'error' in error &&
      'status' in error &&
      typeof (error as any).error === 'string' &&
      typeof (error as any).status === 'number'
    );
  }

  /**
   * Get full URL with base
   */
  private getFullUrl(endpoint: string): string {
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      return endpoint;
    }
    // Remove leading slash if present, we'll add it
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    return `${this.baseUrl}/${cleanEndpoint}`;
  }

  /**
   * Get request headers
   */
  private getHeaders(withAuth: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    if (withAuth) {
      // Get auth token from cookie/localStorage
      // For server-side, this would come from cookies
      const token = this.getAuthToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    return headers;
  }

  /**
   * Get auth token (implement based on your auth setup)
   */
  private getAuthToken(): string | null {
    // Check for session cookie first (server-side)
    if (typeof window === 'undefined') {
      // Server-side: Better Auth uses __session cookie
      return null; // Will be handled by Next.js session middleware
    }

    // Client-side: check localStorage or cookies
    // This depends on how Better Auth stores tokens
    const token = document.cookie
      .split('; ')
      .find(row => row.startsWith('__session='))
      ?.split('=')[1];

    return token || null;
  }

  /**
   * Parse rate limit headers from response
   */
  private parseRateLimitHeaders(headers: Headers): RateLimitInfo {
    const parseIntOr = (value: string | null, fallback: number) => {
      if (!value) return fallback;
      const parsed = parseInt(value, 10);
      return isNaN(parsed) ? fallback : parsed;
    };

    return {
      limit: parseIntOr(headers.get('X-RateLimit-Limit'), 0),
      remaining: parseIntOr(headers.get('X-RateLimit-Remaining'), 0),
      reset: parseIntOr(headers.get('X-RateLimit-Reset'), 0)
    };
  }

  /**
   * Parse error response body
   */
  private async parseErrorBody(response: Response): Promise<Partial<ApiError>> {
    try {
      return await response.json();
    } catch {
      return {
        error: response.statusText,
        status: response.status
      };
    }
  }

  /**
   * Create ApiError from error data
   */
  private createError(data: Partial<ApiError> & { status?: number }): ApiError {
    return {
      error: data.error || 'Unknown Error',
      message: data.message || data.details,
      details: data.details,
      retryAfter: data.retryAfter,
      rateLimit: data.rateLimit,
      status: data.status || 0
    };
  }

  /**
   * Sleep/delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if response was rate limited (for manual checking)
   */
  isRateLimited(error: unknown): error is ApiError {
    return this.isApiError(error) && (error.status === 429 || error.error === 'Too Many Requests');
  }

  /**
   * Get retry-after from error
   */
  getRetryAfter(error: unknown): number | undefined {
    if (this.isRateLimited(error)) {
      return error.retryAfter;
    }
    return undefined;
  }
}

// Export singleton instance
export const apiClient = new ApiClient();

// Export hook for React components
export function useApiClient() {
  return apiClient;
}

