# Rate Limiting Implementation Guide

**Status:** Implementation Complete (Design + Code)  
**Last Updated:** 2026-06-22  
**Related:** `docs/rate-limiting-design.md`, `src/lib/rate-limiter-token-bucket.ts`

---

## Quick Start

### 1. Choose Implementation Approach

Two implementations available:

| File | Algorithm | Storage | Burst | Status |
|------|-----------|---------|-------|--------|
| `src/lib/rate-limiter.ts` | Sliding Window (timestamps array) | JSON array (high) | No | Existing, deprecated |
| `src/lib/rate-limiter-token-bucket.ts` | **Token Bucket** | **8-byte binary (low)** | **Yes (20%)** | **Recommended** |

**Recommendation:** Use `rate-limiter-token-bucket.ts` for all new development.

### 2. KV Namespace Binding

Ensure `wrangler.toml` has KV binding:

```toml
[[kv_namespaces]]
binding = "KV"
id = "5628adf57f1548b5af615de4e9021893"
```

### 3. Configure Rate Limits

Edit `RATE_LIMIT_CONFIGS` in `rate-limiter-token-bucket.ts`:

```typescript
export const RATE_LIMIT_CONFIGS: Record<string, RateLimitConfig> = {
  '/api/public/deals': {
    capacity: 120,        // 100 base + 20% burst
    refillRate: 2,        // 120 tokens / 60 sec
    window: 60,
    keyType: 'ip'
  },
  // Add more endpoints...
};
```

### 4. Integration Methods

#### Option A: Next.js Middleware (Global)

Add to `src/middleware.ts`:

```typescript
import { rateLimitMiddleware } from '@/lib/rate-limiter-token-bucket';

export async function middleware(request: NextRequest) {
  // ... existing locale handling ...

  // Rate limiting (insert after locale skip check)
  const kv = getContextKV(); // You'll need to pass KV through Next.js context
  const response = await rateLimitMiddleware(request, { KV: kv }, async () => {
    return NextResponse.next();
  });

  return response;
}
```

**Note:** Next.js middleware runs at the edge but has limited access to Cloudflare bindings. You may need to use Option B instead.

#### Option B: Route Handler (Per-Endpoint) - Recommended

In each API route:

```typescript
// src/app/api/public/deals/route.ts
import { checkTokenBucket, getClientIP, applyRateLimitHeaders, RATE_LIMIT_CONFIGS } from '@/lib/rate-limiter-token-bucket';

export async function GET(request: Request, env: { KV: KVNamespace }) {
  const clientIp = getClientIP(request);
  const endpoint = '/api/public/deals';

  const result = await checkTokenBucket(env.KV, clientIp, endpoint, endpoint);

  if (!result.allowed) {
    return new Response(JSON.stringify({
      error: 'rate_limit_exceeded',
      retry_after: result.retryAfter
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(result.retryAfter || 60))
      }
    });
  }

  // Fetch deals from database
  const deals = await DB.prepare('SELECT * FROM deals WHERE status = ?').bind('active').all();

  const response = NextResponse.json(deals);
  return applyRateLimitHeaders(response, result, RATE_LIMIT_CONFIGS[endpoint].capacity);
}
```

#### Option C: Authentication Required

```typescript
// src/app/api/affiliate/stats/route.ts
import { checkTokenBucket, getUserId, getClientIP, applyRateLimitHeaders } from '@/lib/rate-limiter-token-bucket';

export async function GET(request: Request, env: { KV: KVNamespace }) {
  // Get user ID from session
  const userId = await getUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check rate limit by user ID
  const result = await checkTokenBucket(env.KV, userId, '/api/affiliate/stats', '/api/tracking/click:auth');

  if (!result.allowed) {
    return build429Response(result.retryAfter!, '/api/affiliate/stats', 'user');
  }

  // Fetch user's affiliate stats
  const stats = await getAffiliateStats(userId);

  const response = NextResponse.json(stats);
  return applyRateLimitHeaders(response, result, 12); // Capacity: 12
}
```

### 5. Endpoint Configuration Reference

| Endpoint | Config Key | Capacity | Refill Rate | Key Type | Notes |
|----------|------------|----------|-------------|----------|-------|
| `GET /api/public/deals` | `/api/public/deals` | 120 | 2/s | IP | 100/min base + 20% burst |
| `POST /api/tracking/click` | `/api/tracking/click` | 36 | 0.6/s | IP | 30/min base + 20% burst |
| `POST /api/tracking/click` (auth) | `/api/tracking/click:auth` | 12 | 0.2/s | User | 10/min base + 20% burst |
| `POST /api/auth/signin` | `/api/auth/signin` | 6 | 0.1/s | IP | 5/min + burst, costs 5 tokens |
| `POST /api/webhooks/exchange` | `/api/webhooks/exchange` | 240 | 4/s | IP | 200/min base + burst |

---

## Testing

### Unit Tests

```typescript
// __tests__/rate-limiter-token-bucket.test.ts
import { checkTokenBucket, deserializeBucket, serializeBucket } from '@/lib/rate-limiter-token-bucket';

describe('Token Bucket Rate Limiter', () => {
  const mockKV = {
    get: vi.fn(),
    put: vi.fn().mockResolvedValue(true)
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize bucket with full capacity', async () => {
    mockKV.get.mockResolvedValue(null);

    const result = await checkTokenBucket(mockKV, 'test-ip', '/api/test', '/api/public/deals');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(119); // 120 - 1 cost
  });

  it('should deny when tokens exhausted', async () => {
    // Simulate empty bucket
    const emptyBucket = { tokens: 0, lastRefill: Date.now() };
    mockKV.get.mockResolvedValue(serializeBucket(emptyBucket));

    const result = await checkTokenBucket(mockKV, 'test-ip', '/api/test', '/api/public/deals');

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(60); // 60 seconds to refill 1 token
  });

  it('should handle CAS contention', async () => {
    // First attempt: CAS fails
    // Second attempt: succeeds with fresh data
    const bucket = { tokens: 100, lastRefill: Date.now() };
    mockKV.get
      .mockResolvedValueOnce(serializeBucket(bucket)) // First read
      .mockResolvedValueOnce(serializeBucket(bucket)) // Retry read
      .mockResolvedValueOnce(null); // Put returns false (CAS fail)

    mockKV.put
      .mockResolvedValueOnce(false) // First put fails
      .mockResolvedValueOnce(true); // Second put succeeds

    const result = await checkTokenBucket(mockKV, 'test-ip', '/api/test', '/api/public/deals');

    expect(result.allowed).toBe(true);
    expect(mockKV.put).toHaveBeenCalledTimes(2);
  });
});
```

### Load Testing

```bash
# Install k6
brew install k6

# Run load test
k6 run --vus 50 --duration 2m scripts/load-test-rate-limit.js
```

`scripts/load-test-rate-limit.js`:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = 'http://localhost:8788';

export let options = {
  thresholds: {
    'http_req_duration{status:429}': ['p(95)<100'],
    'http_req_duration': ['p(99)<200'],
    'http_req_failed': ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/public/deals`);

  check(res, {
    'status is 200 or 429': (r) => [200, 429].includes(r.status),
    'has rate limit headers': (r) => {
      return res.headers['x-ratelimit-limit'] !== undefined;
    }
  });

  // Random delay to simulate real traffic
  sleep(Math.random() * 2);
}
```

---

## Monitoring

### Metrics to Track

```typescript
// Add to your monitoring system (Logflare, Datadog, etc.)
interface RateLimitMetrics {
  // Counters
  rate_limit_checks_total: number;
  rate_limit_allowed_total: number;
  rate_limit_denied_total: number;

  // By endpoint
  rate_limit_by_endpoint_allowed: Record<string, number>;
  rate_limit_by_endpoint_denied: Record<string, number>;

  // Latency
  rate_limit_kv_read_ms: number;
  rate_limit_kv_write_ms: number;
  rate_limit_retries_total: number;

  // Utilization
  rate_limit_utilization_pct: number; // 0-100
}
```

### Dashboard Queries

```sql
-- Denial rate by endpoint (5 min)
SELECT
  endpoint,
  COUNT(*) FILTER (WHERE status = 429) * 100.0 / COUNT(*) as denial_rate_percent
FROM request_logs
WHERE timestamp > now() - interval '5 minutes'
GROUP BY endpoint
HAVING denial_rate_percent > 5
ORDER BY denial_rate_percent DESC;

-- Top IPs by denials (potential abuse)
SELECT
  client_ip,
  COUNT(*) as denial_count
FROM request_logs
WHERE status = 429
  AND timestamp > now() - interval '1 hour'
GROUP BY client_ip
HAVING denial_count > 100
ORDER BY denial_count DESC;
```

### Alerts

| Metric | Threshold | Severity |
|--------|-----------|----------|
| Denial rate > 10% sustained 5min | Warning |
| Single IP > 1000 denials/hour | Critical |
| KV write latency p99 > 100ms | Critical |
| Rate limiter error rate > 1% | Critical |

---

## Troubleshooting

### Issue: "Rate limit: retry exhaustion"

**Cause:** High contention on KV keys (multiple workers updating same bucket simultaneously)

**Solution:**
- Increase retry count (currently 3)
- Implement exponential backoff
- Consider using D1 for strict consistency (trade latency for consistency)

### Issue: "Rate limits not matching expected values"

**Cause:** Clock skew between edge nodes or TTL issues

**Solution:**
- Ensure TTL > window + 30s
- Use server time only (`Date.now()`)
- Check KV TTL in dashboard

### Issue: "High KV operation costs"

**Cause:** Storing full timestamp arrays (old implementation)

**Solution:**
- Switch to token bucket (8-byte storage)
- Verify migration: old keys won't be cleaned automatically but will expire

### Issue: "Legitimate users getting blocked"

**Cause:** Too strict limits or shared IP (corporate NAT, mobile carrier)

**Solution:**
- Consider increasing public limits to 200/min
- Implement IP reputation system (graduated limits)
- Allow authenticated users to bypass IP limits

---

## Migration: Sliding Window → Token Bucket

### Phase 1: Deploy Token Bucket (Parallel)

1. Deploy new `rate-limiter-token-bucket.ts` alongside existing
2. Use different KV namespace or key prefix to avoid conflicts
3. Monitor both systems for 1 week

### Phase 2: Gradual Cutover

```typescript
// Feature flag approach
const USE_TOKEN_BUCKET = env.FEATURE_TOKEN_BUCKET === 'true';

async function checkRateLimitV2(...args) {
  if (USE_TOKEN_BUCKET) {
    return checkTokenBucket(...args);
  }
  return checkRateLimit(...args); // Old implementation
}
```

Roll out to 10% of traffic, monitor, then 50%, then 100%.

### Phase 3: Cleanup

1. Delete old KV keys (they'll auto-expire within 90 days)
2. Remove old `rate-limiter.ts` file
3. Update documentation

---

## Advanced: Per-User Custom Limits

For premium users or whitelisted IPs, override base configs:

```typescript
const CUSTOM_LIMITS: Record<string, RateLimitConfig> = {
  'user_premium_123': {
    capacity: 1200, // 10x normal
    refillRate: 20,
    window: 60,
    keyType: 'user'
  },
  'ip_whitelisted_1.2.3.4': {
    capacity: 1000,
    refillRate: 16.67,
    window: 60,
    keyType: 'ip'
  }
};

export async function checkRateLimitWithOverrides(
  kv: KVNamespace,
  identifier: string,
  endpoint: string,
  configKey: string,
  userId?: string
): Promise<RateLimitResult> {
  // Check custom overrides first
  if (userId && CUSTOM_LIMITS[`user_${userId}`]) {
    return checkTokenBucket(kv, identifier, endpoint, `user_${userId}`);
  }

  if (configKey === '/api/public/deals' && isWhitelistedIP(identifier)) {
    return checkTokenBucket(kv, identifier, endpoint, `ip_${identifier}`);
  }

  return checkTokenBucket(kv, identifier, endpoint, configKey);
}
```

---

## References

- **Design Doc:** `docs/rate-limiting-design.md`
- **Cloudflare KV:** https://developers.cloudflare.com/workers/runtime-apis/kv/
- **Token Bucket:** https://en.wikipedia.org/wiki/Token_bucket
- **RFC 6585 (429):** https://tools.ietf.org/html/rfc6585#section-4

---

**Questions?** See `docs/rate-limiting-design.md` for algorithm details, security considerations, and performance analysis.
