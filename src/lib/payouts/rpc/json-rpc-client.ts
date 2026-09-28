/**
 * src/lib/payouts/rpc/json-rpc-client.ts
 *
 * Edge-compatible pure TypeScript JSON-RPC 2.0 client
 * Built with standard fetch and AbortSignal.timeout() for Cloudflare Workers/Pages
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params: unknown[];
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcCallOptions {
  timeoutMs?: number;
  retryCount?: number;
  headers?: Record<string, string>;
}

export interface JsonRpcClientConfig {
  timeoutMs?: number;
  retryCount?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  headers?: Record<string, string>;
}

/**
 * Standard JSON-RPC 2.0 protocol error returned by the remote node
 */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly rpcMethod?: string;

  constructor(message: string, code: number, data?: unknown, rpcMethod?: string) {
    super(`JSON-RPC Error [${code}]${rpcMethod ? ` on ${rpcMethod}` : ''}: ${message}`);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
    this.rpcMethod = rpcMethod;
  }
}

/**
 * HTTP-level transport error (e.g. 401 Unauthorized, 403 Forbidden, 404 Not Found)
 */
export class JsonRpcHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body?: string;

  constructor(status: number, statusText: string, body?: string) {
    super(`JSON-RPC HTTP Error ${status} ${statusText}${body ? `: ${body}` : ''}`);
    this.name = 'JsonRpcHttpError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

/**
 * Network or RPC execution timeout error
 */
export class JsonRpcTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly rpcMethod?: string;

  constructor(timeoutMs: number, rpcMethod?: string) {
    super(`JSON-RPC request${rpcMethod ? ` for '${rpcMethod}'` : ''} timed out after ${timeoutMs}ms`);
    this.name = 'JsonRpcTimeoutError';
    this.timeoutMs = timeoutMs;
    this.rpcMethod = rpcMethod;
  }
}

/**
 * Edge-compatible JSON-RPC 2.0 Client
 */
export class JsonRpcClient {
  readonly endpoint: string;
  private defaultTimeoutMs: number;
  private defaultRetryCount: number;
  private initialDelayMs: number;
  private maxDelayMs: number;
  private defaultHeaders: Record<string, string>;
  private requestId = 1;

  constructor(endpoint: string, options?: JsonRpcClientConfig) {
    this.endpoint = endpoint;
    this.defaultTimeoutMs = options?.timeoutMs ?? 15_000;
    this.defaultRetryCount = options?.retryCount ?? 3;
    this.initialDelayMs = options?.initialDelayMs ?? 500;
    this.maxDelayMs = options?.maxDelayMs ?? 10_000;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...options?.headers,
    };
  }

  /**
   * Execute a single JSON-RPC method call with exponential backoff and jitter
   */
  async call<T>(
    method: string,
    params: unknown[] = [],
    options?: { timeoutMs?: number; retryCount?: number; headers?: Record<string, string> }
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const maxRetries = options?.retryCount ?? this.defaultRetryCount;
    const customHeaders = options?.headers ?? {};

    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.requestId++,
      method,
      params,
    };

    let attempt = 0;

    while (true) {
      attempt++;
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            ...this.defaultHeaders,
            ...customHeaders,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });

        // Handle rate limiting (429) or server errors (5xx)
        if (!response.ok) {
          const isRetryable = response.status === 429 || response.status >= 500;
          if (isRetryable && attempt <= maxRetries) {
            let backoffMs = this.computeBackoffWithJitter(attempt);
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter) {
              const seconds = parseInt(retryAfter, 10);
              if (!Number.isNaN(seconds) && seconds > 0) {
                backoffMs = seconds * 1000;
              }
            }
            await this.sleep(backoffMs);
            continue;
          }

          const errorBody = await response.text().catch(() => '');
          throw new JsonRpcHttpError(response.status, response.statusText, errorBody);
        }

        const data = (await response.json()) as JsonRpcResponse<T>;

        if (data.error) {
          throw new JsonRpcError(
            data.error.message,
            data.error.code,
            data.error.data,
            method
          );
        }

        if (data.result === undefined) {
          throw new JsonRpcError(
            `Response for method '${method}' missing result field`,
            -32603,
            undefined,
            method
          );
        }

        return data.result;
      } catch (err: unknown) {
        if (err instanceof JsonRpcError || err instanceof JsonRpcHttpError) {
          throw err;
        }

        const isTimeout =
          err instanceof Error &&
          (err.name === 'TimeoutError' || err.name === 'AbortError' || err.message.toLowerCase().includes('timeout'));

        if (attempt <= maxRetries) {
          const backoffMs = this.computeBackoffWithJitter(attempt);
          await this.sleep(backoffMs);
          continue;
        }

        if (isTimeout) {
          throw new JsonRpcTimeoutError(timeoutMs, method);
        }

        throw err;
      }
    }
  }

  /**
   * Batch call multiple JSON-RPC requests in a single HTTP payload
   */
  async batch<T>(
    requests: Array<{ method: string; params: unknown[] }>,
    options?: { timeoutMs?: number; retryCount?: number }
  ): Promise<T[]> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const maxRetries = options?.retryCount ?? this.defaultRetryCount;

    const payloads: JsonRpcRequest[] = requests.map((req) => ({
      jsonrpc: '2.0',
      id: this.requestId++,
      method: req.method,
      params: req.params,
    }));

    let attempt = 0;

    while (true) {
      attempt++;
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: this.defaultHeaders,
          body: JSON.stringify(payloads),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const isRetryable = response.status === 429 || response.status >= 500;
          if (isRetryable && attempt <= maxRetries) {
            await this.sleep(this.computeBackoffWithJitter(attempt));
            continue;
          }
          const text = await response.text().catch(() => '');
          throw new JsonRpcHttpError(response.status, response.statusText, text);
        }

        const responses = (await response.json()) as JsonRpcResponse<T>[];
        if (!Array.isArray(responses)) {
          throw new JsonRpcError('Expected array response for batch JSON-RPC request', -32600);
        }

        // Map responses matching order or IDs
        return responses.map((res, idx) => {
          if (res.error) {
            throw new JsonRpcError(res.error.message, res.error.code, res.error.data, requests[idx]?.method);
          }
          if (res.result === undefined) {
            throw new JsonRpcError(`Missing result in batch response index ${idx}`, -32603);
          }
          return res.result;
        });
      } catch (err: unknown) {
        if (err instanceof JsonRpcError || err instanceof JsonRpcHttpError) {
          throw err;
        }
        if (attempt <= maxRetries) {
          await this.sleep(this.computeBackoffWithJitter(attempt));
          continue;
        }
        throw err;
      }
    }
  }

  private computeBackoffWithJitter(attempt: number): number {
    const exponential = this.initialDelayMs * Math.pow(2, attempt - 1);
    const capped = Math.min(exponential, this.maxDelayMs);
    const jitter = Math.floor(Math.random() * (this.initialDelayMs / 2));
    return capped + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
