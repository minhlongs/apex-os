import {
  buildKey,
  checkRateLimitByIdentifier,
  getClientIP,
  isKVAvailable,
  parseRateLimitHeaders,
  resetRateLimit,
  RateLimitResult,
} from '@/lib/rate-limiter';

// Mock Cloudflare KV namespace
function createMockKV(): Record<string, string> {
  const store: Record<string, string> = {};
  return {
    get: async (key: string, type?: 'text' | 'json'): Promise<string | null> => {
      return store[key] ?? null;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }): Promise<void> => {
      store[key] = value;
    },
    add: async (key: string, value: string, options?: { expirationTtl?: number }): Promise<boolean> => {
      if (store[key] === undefined) {
        return false;
      }
      const current = parseInt(store[key], 10);
      store[key] = (current + parseInt(value, 10)).toString();
      return true;
    },
    delete: async (key: string): Promise<boolean> => {
      const existed = store[key] !== undefined;
      delete store[key];
      return existed;
    },
    _clear: () => {
      for (const key in store) delete store[key];
    },
  };
}

// Helper to create a mock request-like object
function createMockRequest(options: {
  ip?: string;
  headers?: Record<string, string>;
} = {}): { headers: Map<string, string>; nextUrl: { pathname: string } } {
  const headers = new Map<string, string>();
  if (options.ip) {
    headers.set('cf-connecting-ip', options.ip);
  }
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      headers.set(key, value);
    }
  }
  return {
    headers,
    nextUrl: { pathname: '/' },
  };
}

describe('buildKey', () => {
  it('should build correct key format', () => {
    const key = buildKey('rl', 'ip:1.2.3.4', 60_000);
    expect(key).toBe('rate-limit:rl:ip%3A1.2.3.4:60');
  });

  it('should encode special characters in identifier', () => {
    const key = buildKey('rl', 'user:test@example.com', 60_000);
    expect(key).toBe('rate-limit:rl:user%3Atest%40example.com:60');
  });

  it('should handle empty prefix', () => {
    const key = buildKey('', 'ip:1.2.3.4', 60_000);
    expect(key).toBe('rate-limit::ip%3A1.2.3.4:60');
  });
});

describe('getClientIP', () => {
  it('should extract IP from cf-connecting-ip header', () => {
    const request = createMockRequest({ ip: '1.2.3.4' });
    expect(getClientIP(request)).toBe('1.2.3.4');
  });

  it('should extract first IP from x-forwarded-for header', () => {
    const request = createMockRequest({
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    });
    expect(getClientIP(request)).toBe('1.2.3.4');
  });

  it('should extract IP from x-real-ip header', () => {
    const request = createMockRequest({
      headers: { 'x-real-ip': '1.2.3.4' },
    });
    expect(getClientIP(request)).toBe('1.2.3.4');
  });

  it('should return unknown when no IP headers present', () => {
    const request = createMockRequest({});
    expect(getClientIP(request)).toBe('unknown');
  });

  it('should trim whitespace from IP', () => {
    const request = createMockRequest({ ip: '  1.2.3.4  ' });
    expect(getClientIP(request)).toBe('1.2.3.4');
  });

  it('should prioritize cf-connecting-ip over other headers', () => {
    const request = createMockRequest({
      ip: '1.2.3.4',
      headers: { 'x-forwarded-for': '5.6.7.8' },
    });
    expect(getClientIP(request)).toBe('1.2.3.4');
  });
});

describe('checkRateLimitByIdentifier', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  const originalDateNow = Date.now;

  beforeEach(() => {
    mockKV = createMockKV();
    // @ts-ignore - Mock global KV for tests
    globalThis.KV = mockKV;
    // Mock Date.now to return consistent time
    const mockTime = 1_700_000_000_000; // Fixed timestamp (Jan 27, 2024)
    // @ts-ignore
    Date.now = () => mockTime;
  });

  afterEach(() => {
    // @ts-ignore
    delete globalThis.KV;
    Date.now = originalDateNow;
  });

  it('should allow first request', async () => {
    const result = await checkRateLimitByIdentifier('ip:1.2.3.4', {
      maxRequests: 10,
      windowMs: 60_000,
      prefix: 'rl',
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.limit).toBe(10);
    expect(result.reset).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('should allow up to maxRequests', async () => {
    const config = { maxRequests: 10, windowMs: 60_000, prefix: 'rl' as const };

    // Make maxRequests requests
    for (let i = 0; i < 10; i++) {
      const result = await checkRateLimitByIdentifier('ip:1.2.3.4', config);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9 - i);
    }

    // 11th request should be rejected
    const result = await checkRateLimitByIdentifier('ip:1.2.3.4', config);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('should use different identifiers separately', async () => {
    const config = { maxRequests: 5, windowMs: 60_000, prefix: 'rl' as const };

    // Exhaust limit for first identifier
    for (let i = 0; i < 5; i++) {
      await checkRateLimitByIdentifier('ip:1.2.3.4', config);
    }

    // Second identifier should be allowed with full limit
    const result = await checkRateLimitByIdentifier('ip:5.6.7.8', config);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('should store timestamps correctly', async () => {
    const config = { maxRequests: 3, windowMs: 60_000, prefix: 'rl' as const };
    const identifier = 'ip:test';

    await checkRateLimitByIdentifier(identifier, config);
    await checkRateLimitByIdentifier(identifier, config);
    await checkRateLimitByIdentifier(identifier, config);

    // Check KV storage
    const key = buildKey('rl', identifier, 60_000);
    const raw = await mockKV.get(key, 'text');
    const timestamps = JSON.parse(raw);

    expect(timestamps).toHaveLength(3);
    expect(timestamps.every(ts => typeof ts === 'number' && ts > 0)).toBe(true);
  });

  it('should trim timestamps array to maxRequests', async () => {
    const config = { maxRequests: 3, windowMs: 60_000, prefix: 'rl' as const };

    // Make more requests than max to test trimming
    for (let i = 0; i < 5; i++) {
      await checkRateLimitByIdentifier('ip:test', config);
    }

    const key = buildKey('rl', 'ip:test', 60_000);
    const raw = await mockKV.get(key, 'text');
    const timestamps = JSON.parse(raw);

    expect(timestamps).toHaveLength(3); // Only last 3 should be kept
  });
});

describe('isKVAvailable', () => {
  it('should return true when KV is available', () => {
    // @ts-ignore
    globalThis.KV = createMockKV();
    expect(isKVAvailable()).toBe(true);
  });

  it('should return false when KV is not available', () => {
    // @ts-ignore
    delete globalThis.KV;
    expect(isKVAvailable()).toBe(false);
  });
});

describe('parseRateLimitHeaders', () => {
  it('should parse rate limit headers', () => {
    const headers = new Map<string, string>([
      ['X-RateLimit-Limit', '100'],
      ['X-RateLimit-Remaining', '50'],
      ['X-RateLimit-Reset', '1700000600'],
    ]);

    const result = parseRateLimitHeaders(headers as unknown as Headers);
    expect(result).toEqual({
      limit: 100,
      remaining: 50,
      reset: 1700000600,
    });
  });

  it('should return null when headers are missing', () => {
    const headers = new Map<string, string>();
    expect(parseRateLimitHeaders(headers as unknown as Headers)).toBeNull();
  });

  it('should parse integer values correctly', () => {
    const headers = new Map<string, string>([
      ['X-RateLimit-Limit', '42'],
      ['X-RateLimit-Remaining', '0'],
      ['X-RateLimit-Reset', '9999999999'],
    ]);

    const result = parseRateLimitHeaders(headers as unknown as Headers);
    expect(result?.limit).toBe(42);
    expect(result?.remaining).toBe(0);
    expect(result?.reset).toBe(9999999999);
  });
});

describe('resetRateLimit', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    // @ts-ignore
    globalThis.KV = mockKV;
  });

  afterEach(() => {
    // @ts-ignore
    delete globalThis.KV;
  });

  it('should delete rate limit key', async () => {
    const identifier = 'ip:1.2.3.4';
    const key = buildKey('rl', identifier, 60_000);
    await mockKV.put(key, JSON.stringify([1_700_000_000_000]));

    const result = await resetRateLimit(identifier, 'rl', 60_000);
    expect(result).toBe(true);

    const deleted = await mockKV.delete(key);
    expect(deleted).toBe(false); // Key already deleted
  });

  it('should return false when KV is not available', async () => {
    // @ts-ignore
    delete globalThis.KV;
    const result = await resetRateLimit('ip:1.2.3.4');
    expect(result).toBe(false);
  });
});

describe('KV fail-open behavior', () => {
  let originalKV: typeof globalThis.KV;

  beforeEach(() => {
    originalKV = globalThis.KV;
  });

  afterEach(() => {
    globalThis.KV = originalKV;
  });

  it('should allow request when KV is unavailable', async () => {
    // @ts-ignore
    delete globalThis.KV;

    const result = await checkRateLimitByIdentifier('ip:1.2.3.4', {
      maxRequests: 10,
      windowMs: 60_000,
      prefix: 'rl',
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(10);
    expect(result.limit).toBe(10);
  });
});
