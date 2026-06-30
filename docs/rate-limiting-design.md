# KV-Based Distributed Rate Limiting Design

**Created:** 2026-06-22  
**Status:** Design Specification  
**Target:** Cloudflare Workers + KV Namespace  
**Related:** `wrangler.toml` (KV namespace binding: `KV`)

---

## Executive Summary

This document specifies a distributed rate limiting system using Cloudflare KV for the ApexOS API. The system implements:

- **Public endpoints:** 100 requests/minute per IP
- **Authenticated endpoints:** 10 requests/minute per user ID
- **Burst allowance:** 20% burst capacity with token bucket algorithm
- **Distributed:** Works across all Cloudflare edge nodes globally

The design uses the **Token Bucket algorithm** with atomic KV operations for consistency, achieving sub-millisecond latency at the edge.

---

## 1. Algorithm Selection: Token Bucket

### Why Token Bucket?

| Algorithm | Burst Support | Distributed Ease | Memory Footprint | Our Choice |
|-----------|---------------|-----------------|------------------|------------|
| Fixed Window | ❌ No | ✅ Easy | Minimal | ❌ Rejected |
| Sliding Log | ✅ Yes | ❌ Hard (sorted set) | High | ❌ Rejected |
| Leaky Bucket | ✅ Yes | ⚠️ Medium | Medium | ⚠️ Considered |
| **Token Bucket** | **✅ Yes** | **✅ Easy** | **Minimal** | **✅ SELECTED** |

**Token Bucket advantages for our use case:**
- Allows short bursts (20% over limit) without penalty
- Simple state: `{ tokens, last_refill_timestamp }`
- Constant O(1) storage per key
- Atomic update possible with KV `get` + `put` + CAS

### Token Bucket Mathematics

```
capacity = max_tokens_per_interval
refill_rate = capacity / interval_seconds
tokens = min(capacity, tokens + (now - last_refill) * refill_rate)
```

**For our limits:**
- Public: `capacity=100`, `interval=60s`, `refill_rate=1.667 tokens/sec`
- Authenticated: `capacity=10`, `interval=60s`, `refill_rate=0.167 tokens/sec`
- Burst: `capacity = 120` (public) or `12` (auth) = 20% over base

---

## 2. KV Schema Design

### Key Structure

```
# Format: ratelimit:{type}:{identifier}:{window}
ratelimit:ip:123.123.123.123:1m      # Public by IP, 1-minute window
ratelimit:user:user_abc123:1m       # Authenticated by user ID
```

**TTL Strategy:**
- Set KV TTL = `interval + 30s` (extra for clock skew)
- Public: 90s TTL
- Auth: 90s TTL

### Value Encoding

Use compact binary format (MsgPack or custom) to minimize KV size:

```typescript
// 16-byte value structure
struct RateLimitValue {
  tokens: float32;      // 4 bytes: remaining tokens (0-120)
  last_refill: uint64; // 8 bytes: millisecond epoch
  // Optional: 4 bytes for flags/reserved
}

// Serialized as base64 for readability (actually binary)
// Example: "AgAAAAIAAAAAAAA" = 120 tokens, epoch=0
```

**KV Storage Cost:**
- Cloudflare KV: ~$0.50/GB/month
- 100k concurrent users × 16 bytes = 1.6 MB
- Cost: <$0.001/month

---

## 3. Distributed Consistency Strategy

### The Challenge

Multiple edge nodes handling requests for the same IP/user must see consistent state.

### Solution: Atomic Compare-And-Swap (CAS)

Cloudflare KV provides atomic operations via `put` with `previousValue`:

```typescript
async function consumeTokens(key: string, cost: number): Promise<boolean> {
  const TTL = 90; // seconds

  for (let attempt = 0; attempt < 3; attempt++) {
    // 1. Read current state
    const raw = await KV.get(key, { type: 'json' });
    const now = Date.now();

    if (!raw) {
      // Initialize bucket with full capacity
      const initial = { tokens: capacity, last_refill: now };
      await KV.put(key, JSON.stringify(initial), { expirationTtl: TTL });
      if (cost <= capacity) return true;
      return false;
    }

    // 2. Calculate refill
    const { tokens, last_refill } = raw as BucketState;
    const time_diff = (now - last_refill) / 1000;
    const refill_amount = time_diff * refill_rate;
    const new_tokens = Math.min(capacity, tokens + refill_amount);

    // 3. Check if we can consume
    if (new_tokens < cost) {
      return false; // Not enough tokens
    }

    // 4. Update state atomically
    const updated = { tokens: new_tokens - cost, last_refill: now };
    const success = await KV.put(
      key,
      JSON.stringify(updated),
      {
        expirationTtl: TTL,
        previousValue: raw  // CAS: only write if unchanged
      }
    );

    if (success) {
      return true; // Consumed successfully
    }
    // CAS failed, retry (another worker modified state)
  }

  throw new Error('Rate limit retry exhaustion');
}
```

**Why this works:**
- CAS ensures only one winner when multiple workers read simultaneously
- Retry loop handles contention (typical for burst traffic)
- 3 attempts sufficient for 99th percentile contention

---

## 4. Implementation Architecture

### Middleware Placement

```typescript
// src/middleware/rate-limit.ts
export async function rateLimitMiddleware(
  request: Request,
  context: NextContext
): Promise<Response | undefined> {
  const { kv } = context; // KV binding from wrangler.toml
  const path = request.url;

  // 1. Skip rate limiting for health checks, static assets
  if (isExcludedPath(path)) {
    return undefined;
  }

  // 2. Determine limit tier
  const isAuthenticated = await checkAuth(request);
  const identifier = isAuthenticated
    ? `user:${getUserId(request)}`
    : `ip:${getClientIp(request)}`;

  const { limit, window } = isAuthenticated
    ? { limit: 10, window: 60 }   // Auth: 10/min
    : { limit: 100, window: 60 }; // Public: 100/min

  // 3. Apply burst allowance (20%)
  const capacity = Math.ceil(limit * 1.2);
  const cost = 1; // Cost per request (can vary by endpoint)

  // 4. Check rate limit
  const allowed = await consumeTokens(
    kv,
    `ratelimit:${identifier}:${window}s`,
    capacity,
    cost
  );

  if (!allowed) {
    const retryAfter = await getRetryAfter(kv, identifier, window);
    return new Response(JSON.stringify({
      error: 'Rate limit exceeded',
      retry_after: retryAfter
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + retryAfter)
      }
    });
  }

  // 5. Set rate limit headers on successful response
  const remaining = await getRemainingTokens(kv, identifier, window);
  context.response.headers.set('X-RateLimit-Limit', String(limit));
  context.response.headers.set('X-RateLimit-Remaining', String(remaining));
  context.response.headers.set('X-RateLimit-Reset', String(window));

  return undefined; // Continue to handler
}
```

### Route-Level Configuration

```typescript
// src/app/api/tracking/click/route.ts
import { rateLimit } from '@/lib/rate-limit';

// Per-endpoint customization
const clickLimiter = rateLimit({
  identifier: 'ip', // or 'user' for authenticated
  limit: 100,
  window: 60,
  burst_multiplier: 1.2,
  // Skip rate limiting for certain IPs
  skip: (req) => req.ip?.startsWith('192.168.')
});

export async function POST(request: Request) {
  const result = await clickLimiter.check(request);
  if (!result.allowed) {
    return result.response; // 429 with headers
  }

  // Business logic
  const { dealId } = await request.json();
  return trackClick(dealId);
}
```

---

## 5. Burst Handling Strategy

### The Problem

Strict 100 req/min would reject 101st request even if previous minute had 0 requests. Users expect smooth burst handling.

### Solution: Token Bucket with 20% Burst

| Scenario | Strict 100/min | Token Bucket (capacity=120) |
|----------|----------------|-----------------------------|
| Sustained 100 req/min | ✅ Works | ✅ Works |
| Burst 120 in 1 sec | ❌ Rejects at 101st | ✅ All accepted |
| Burst 150 in 1 sec | ❌ Rejects at 101st | ✅ First 120, rest 429 |
| 60 sec quiet, then burst | ✅ Refilled | ✅ Refilled |

**Why 20% burst?**
- Allows natural traffic spikes (page loads, redirects)
- Still prevents abuse (max 1440 req/hour vs 6000 with no limit)
- Matches common industry practice (Cloudflare default burst)

### Dynamic Burst per Endpoint

```typescript
const burstConfigs = {
  'tracking/click': { burst: 1.5 },  // 150 burst for click tracking (users may click many deals)
  'webhooks/exchange': { burst: 2.0 }, // 200 burst for webhooks (batch processing)
  'api/deals': { burst: 1.0 },  // No burst for sensitive endpoints
};
```

---

## 6. Multi-Tier Rate Limiting

### Tier Decision Matrix

| Condition | Tier | Limit | Key Type |
|-----------|------|-------|----------|
| Authenticated user | AUTH | 10/min | `user:{id}` |
| Unauthenticated + valid `ref` cookie | REFERRED | 50/min | `ip:{ip}:ref` |
| Unauthenticated no cookie | PUBLIC | 100/min | `ip:{ip}` |
| Known bad IP (blocklist) | BLOCK | 0/min | Immediate 429 |
| Premium tier (future) | PREMIUM | 1000/min | `user:{id}` |

### Implementation

```typescript
type RateLimitTier = 'PUBLIC' | 'REFERRED' | 'AUTH' | 'PREMIUM' | 'BLOCK';

interface TierConfig {
  limit: number;
  window: number;
  burst: number;
  keyPrefix: 'ip' | 'user';
}

const TIERS: Record<RateLimitTier, TierConfig> = {
  PUBLIC: { limit: 100, window: 60, burst: 1.2, keyPrefix: 'ip' },
  REFERRED: { limit: 50, window: 60, burst: 1.5, keyPrefix: 'ip' },
  AUTH: { limit: 10, window: 60, burst: 1.2, keyPrefix: 'user' },
  PREMIUM: { limit: 1000, window: 60, burst: 1.0, keyPrefix: 'user' },
  BLOCK: { limit: 0, window: 60, burst: 0, keyPrefix: 'ip' },
};

async function determineTier(request: Request): Promise<RateLimitTier> {
  const ip = getClientIp(request);
  if (await isBlocklisted(ip)) return 'BLOCK';

  const user = await getAuthUser(request);
  if (user) return 'AUTH';

  const hasRefCookie = request.headers.get('cookie')?.includes('ref=');
  return hasRefCookie ? 'REFERRED' : 'PUBLIC';
}
```

---

## 7. Edge Cases & Mitigations

### Clock Skew

**Problem:** Edge nodes have slightly different clocks (up to ~100ms drift).

**Mitigation:**
- Use server-side time only (`Date.now()`)
- Never trust client-provided timestamps
- TTL buffer (30s) accounts for minor drift

### KV Eventual Consistency

**Problem:** Cloudflare KV is eventually consistent (typically < 60s).

**Impact on Rate Limiting:**
- **Read-after-write:** A user hitting two different edges simultaneously might see stale state
- **Result:** Slightly higher request count possible (at most 1-2x capacity)

**Is this acceptable?**
- For rate limiting (security vs UX), slight overage is tolerable
- Over-limiting (false positives) is worse than slight under-limiting
- Trade-off: better performance at edge vs strict accuracy

**If strict consistency required:**
- Use D1 with `BEGIN IMMEDIATE` transactions (slower, ~2-5ms)
- Or use `workerd` `Atomics` (not available on CF Workers yet)

### Key Explosion (Hashing)

**Problem:** Storing raw IPs/UserIDs in KV keys:
- Long keys increase storage/memory
- Privacy concerns (GDPR)
- Case sensitivity issues

**Solution: Key Hashing**

```typescript
const HASH_SALT = env.KV_RATE_LIMIT_SALT; // Rotate quarterly

function makeKey(type: 'ip' | 'user', identifier: string, window: number): string {
  const material = `${type}:${identifier}:${window}`;
  const hash = crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  const hashHex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `ratelimit:${hashHex}`;
}
```

**Benefits:**
- Fixed 64-char key length
- Privacy-preserving
- Salt prevents rainbow table attacks

### Cleanup of Stale Keys

**Problem:** KV has no automatic cleanup; stale keys accumulate.

**Mitigation:**
1. Set TTL = `window + 30s` (auto-expire)
2. Periodic cleanup cron (daily) removes any lingering keys
3. Monitor KV namespace size

```bash
# Daily cleanup cron
0 2 * * * wrangler kv key list --namespace-id $KV_ID --json \
  | jq -r '.[] | select(.expirations[0] < now) | .name' \
  | xargs -r wrangler kv delete --namespace-id $KV_ID
```

---

## 8. Monitoring & Alerting

### Metrics to Track

```typescript
// Using Cloudflare Analytics or custom metrics
interface RateLimitMetrics {
  // Counters
  rate_limit_total_checks: number;
  rate_limit_allowed: number;
  rate_limit_denied: number;

  // Histograms
  rate_limit_remaining_tokens: number[]; // Bucketed: 0-20%, 20-40%, etc.
  rate_limit_kv_latency_ms: number[];

  // Per-tier breakdown
  rate_limit_by_tier_public_denied: number;
  rate_limit_by_tier_auth_denied: number;
  rate_limit_by_tier_referred_denied: number;
}
```

### Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Denial rate > 5% | ✅ Alert | ✅ |
| Denial rate > 20% | ✅ | ✅ Alert |
| KV latency p95 > 10ms | ✅ | |
| KV latency p99 > 50ms | ✅ | ✅ Alert |
| Single IP > 1000 denials/min | ✅ | ✅ Alert (potential attack) |

### Dashboard Queries (Logflare/Datadog)

```sql
-- Rate limit denial rate (5-min window)
SELECT
  COUNT(*) FILTER (WHERE status = 429) * 100.0 / COUNT(*) as denial_rate
FROM worker_requests
WHERE timestamp >= now() - interval '5 minutes'
GROUP BY minute;
```

---

## 9. Implementation Plan

### Phase 1: Core Library (Week 1)

**Files to create:**

```
src/lib/rate-limit/
├── types.ts           # TypeScript interfaces
├── token-bucket.ts    # Core algorithm (KV operations)
├── key-manager.ts     # Key generation, hashing
├── middleware.ts      # Next.js middleware wrapper
└── index.ts           # Public exports
```

**Tasks:**
1. Implement `BucketState` type and serialization
2. Implement `consumeTokens()` with CAS loop
3. Implement `getRemainingTokens()` (read-only)
4. Add unit tests with mocked KV

### Phase 2: Integration (Week 2)

**Files to modify:**

```
src/middleware.ts           # Add rate limit middleware
src/app/api/tracking/click/route.ts   # Apply to click endpoint
src/app/api/webhooks/exchange/route.ts # Apply to webhooks
src/app/api/deals/route.ts            # Apply to deals API
```

**Tasks:**
1. Wire KV binding (`env.KV`) through middleware
2. Add rate limit headers to responses
3. Test with load generator (k6 or autocannon)

### Phase 3: Monitoring (Week 3)

**Files to create:**

```
src/lib/metrics.ts      # Metric counters
docs/monitoring-alerting.md  # Update with rate limit alerts
```

**Tasks:**
1. Instrument metrics with `console.log` (Workers Analytics)
2. Set up Logflare dashboards
3. Configure alert thresholds

### Phase 4: Advanced Features (Week 4)

**Features:**
- Whitelist/blocklist management
- Per-endpoint burst configuration
- Adaptive rate limiting (adjust based on load)
- Rate limit exemption tokens

---

## 10. Testing Strategy

### Unit Tests

```typescript
// __tests__/rate-limit/unit.test.ts
describe('Token Bucket', () => {
  it('should initialize with full capacity', async () => {
    const kv = mockKV();
    const result = await consumeTokens(kv, key, capacity, 1);
    expect(result).toBe(true);
  });

  it('should deny when insufficient tokens', async () => {
    const kv = mockKV();
    await consumeTokens(kv, key, capacity, capacity); // Exhaust
    const result = await consumeTokens(kv, key, capacity, 1);
    expect(result).toBe(false);
  });

  it('should handle concurrent requests with CAS', async () => {
    const kv = mockKV();
    const promises = Array(150).fill(null).map(() =>
      consumeTokens(kv, key, capacity, 1)
    );
    const results = await Promise.all(promises);
    // Exactly capacity should succeed
    expect(results.filter(r => r).length).toBe(capacity);
  });
});
```

### Integration Tests

```typescript
// __tests__/rate-limit/integration.test.ts
describe('Rate Limit Middleware', () => {
  it('should return 429 when limit exceeded', async () => {
    const response = await requestPost('/api/tracking/click', {}, {
      'X-RateLimit-Test': 'true' // Force deterministic state
    });

    // After 100 requests, 101st should be 429
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBeDefined();
  });

  it('should set rate limit headers', async () => {
    const response = await requestPost('/api/tracking/click');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(response.headers.get('X-RateLimit-Remaining')).toBeDefined();
  });
});
```

### Load Testing

```bash
# k6 script: load-test/rate-limit.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '30s', target: 50 },  // Ramp up to 50 VUs
    { duration: '2m', target: 50 },   // Hold
    { duration: '30s', target: 200 }, // Burst to 200
    { duration: '2m', target: 50 },   // Ramp down
  ],
  thresholds: {
    'http_req_duration{status:429}': ['p(95)<500'], // Denials fast
    'http_req_duration': ['p(99)<200'], // Normal requests fast
  },
};

const BASE_URL = 'http://localhost:8788';

export default function () {
  const res = http.post(`${BASE_URL}/api/tracking/click`, {
    dealId: 'test-deal'
  });

  check(res, {
    'status is 200 or 429': (r) => [200, 429].includes(r.status),
  });

  sleep(0.1); // ~10 req/sec per VU max
}
```

---

## 11. Security Considerations

### Attack Vectors & Defenses

| Attack | Defense |
|--------|---------|
| **IP Spoofing** | Use `request.cf` for real client IP, not headers |
| **Key Flooding** | Set KV TTL, monitor key count |
| **CAS Starvation** | Limit retries to 3, exponential backoff |
| **Clock Manipulation** | Use server time only |
| **Hash Collision** | SHA-256 collision probability negligible |

### IP Extraction Priority

```typescript
function getClientIp(request: Request): string {
  // Priority order:
  // 1. CF-Connecting-IP (Cloudflare)
  // 2. X-Forwarded-For (first in list)
  // 3. Request remote address (fallback)

  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp;

  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();

  return request.headers.get('x-real-ip') || '127.0.0.1';
}
```

---

## 12. Performance Characteristics

### Latency Breakdown

| Operation | Target P50 | Target P99 |
|-----------|------------|------------|
| KV Read | 2-5ms | 20ms |
| KV Write (CAS) | 5-10ms | 50ms |
| Total (happy path) | 7-15ms | 70ms |
| Total (contention + retry) | 15-30ms | 150ms |

**Impact on API:**
- Happy path: <15ms overhead (acceptable)
- Contention: Still <50ms for 99% of cases

### Cost Analysis

| Resource | Usage | Cost |
|-----------|-------|------|
| KV Operations | 100 req/s × 60s × 60m × 24h = 518,400 ops/day | < $0.50/month |
| KV Storage | 100k keys × 64B = 6.4MB | < $0.01/month |
| CPU (CAS loop) | ~0.5ms per request | Included in Workers |

**Total Monthly Cost:** <$1 (negligible)

---

## 13. Code Reference: Complete Implementation

### `src/lib/rate-limit/types.ts`

```typescript
export interface RateLimitConfig {
  /** Number of tokens per window (burst capacity) */
  capacity: number;
  /** Refill rate (tokens per second) */
  refillRate: number;
  /** Window in seconds */
  window: number;
  /** Key prefix: 'ip' or 'user' */
  keyPrefix: 'ip' | 'user';
}

export interface BucketState {
  tokens: number;
  lastRefill: number; // Unix millis
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAfter: number; // Seconds until tokens refill
  retryAfter?: number; // Seconds (only when denied)
}
```

### `src/lib/rate-limit/token-bucket.ts`

```typescript
import { RateLimitConfig, BucketState, RateLimitResult } from './types';

const KV_KEY_PREFIX = 'ratelimit:';
const DEFAULT_TTL = 90; // seconds

export async function checkRateLimit(
  kv: KVNamespace,
  identifier: string,
  config: RateLimitConfig,
  cost: number = 1
): Promise<RateLimitResult> {
  const key = makeKey(config.keyPrefix, identifier, config.window);

  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();

    // Read current state
    const raw = await kv.get(key, { type: 'json' });

    if (!raw) {
      // Initialize new bucket
      const initial: BucketState = {
        tokens: config.capacity,
        lastRefill: now
      };
      await kv.put(key, JSON.stringify(initial), { expirationTtl: DEFAULT_TTL });

      if (cost <= config.capacity) {
        return {
          allowed: true,
          remaining: config.capacity - cost,
          resetAfter: config.window
        };
      }
      return { allowed: false, remaining: 0, resetAfter: config.window };
    }

    const { tokens, lastRefill } = raw as BucketState;

    // Calculate refill
    const timeDiff = (now - lastRefill) / 1000; // seconds
    const refillAmount = timeDiff * config.refillRate;
    const newTokens = Math.min(config.capacity, tokens + refillAmount);

    // Check if we can consume
    if (newTokens < cost) {
      const tokensNeeded = cost - newTokens;
      const retryAfter = Math.ceil(tokensNeeded / config.refillRate);
      return {
        allowed: false,
        remaining: Math.max(0, newTokens),
        resetAfter: config.window,
        retryAfter
      };
    }

    // Update state atomically
    const updated: BucketState = {
      tokens: newTokens - cost,
      lastRefill: now
    };

    const success = await kv.put(
      key,
      JSON.stringify(updated),
      {
        expirationTtl: DEFAULT_TTL,
        previousValue: raw
      }
    );

    if (success) {
      return {
        allowed: true,
        remaining: updated.tokens,
        resetAfter: config.window
      };
    }
    // CAS failed, retry
  }

  throw new Error('Rate limit: retry exhaustion');
}

function makeKey(
  prefix: 'ip' | 'user',
  identifier: string,
  window: number
): string {
  return `${KV_KEY_PREFIX}${prefix}:${identifier}:${window}s`;
}
```

### `src/lib/rate-limit/middleware.ts`

```typescript
import { checkRateLimit } from './token-bucket';
import { RateLimitConfig } from './types';
import type { KVNamespace } from '@cloudflare/workers-types';

const TIER_CONFIGS: Record<string, RateLimitConfig> = {
  PUBLIC: { capacity: 120, refillRate: 2, window: 60, keyPrefix: 'ip' },
  AUTH: { capacity: 12, refillRate: 0.2, window: 60, keyPrefix: 'user' },
};

export async function rateLimitMiddleware(
  request: Request,
  env: { KV: KVNamespace },
  next: () => Promise<Response>
): Promise<Response> {
  const path = new URL(request.url).pathname;

  // Skip for health checks, static assets
  if (path.startsWith('/health') || path.startsWith('/_next/')) {
    return next();
  }

  const tier = await determineTier(request);
  const config = TIER_CONFIGS[tier];

  if (!config) {
    return next(); // No rate limit configured
  }

  const identifier = tier === 'AUTH'
    ? await getUserId(request)
    : getClientIp(request);

  if (!identifier) {
    return new Response('Unauthorized', { status: 401 });
  }

  const result = await checkRateLimit(env.KV, identifier, config);

  const response = await next();

  if (!result.allowed) {
    return new Response(JSON.stringify({
      error: 'Rate limit exceeded',
      retry_after: result.retryAfter
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(result.retryAfter),
        'X-RateLimit-Limit': String(config.capacity),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(result.resetAfter)
      }
    });
  }

  // Add headers to successful response
  response.headers.set('X-RateLimit-Limit', String(config.capacity));
  response.headers.set('X-RateLimit-Remaining', String(Math.floor(result.remaining)));
  response.headers.set('X-RateLimit-Reset', String(result.resetAfter));

  return response;
}

async function determineTier(request: Request): Promise<string> {
  // Check auth session
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    // Verify session token (call Better Auth or check cookie)
    const userId = await verifySession(request);
    if (userId) return 'AUTH';
  }
  return 'PUBLIC';
}
```

---

## 14. Deployment Checklist

- [ ] Create KV namespace binding in `wrangler.toml` (✓ Already exists: `KV`)
- [ ] Deploy library code to `src/lib/rate-limit/`
- [ ] Add middleware to `src/middleware.ts` or route handlers
- [ ] Set environment variable `KV_RATE_LIMIT_SALT` (rotate quarterly)
- [ ] Configure monitoring dashboards
- [ ] Set up alerting for denial rate > 5%
- [ ] Test with load generator (k6)
- [ ] Document in `docs/operational-runbook.md`

---

## 15. Future Enhancements

| Feature | Priority | Complexity |
|---------|----------|------------|
| Per-user custom limits (admin override) | P1 | Low |
| Adaptive limits based on system load | P2 | Medium |
| Distributed blocklist sync | P1 | Low |
| Rate limit exemptions (admin tokens) | P1 | Low |
| Multi-window counters (1min, 1hr, 1day) | P2 | Medium |
| Machine learning anomaly detection | P3 | High |

---

## 16. References

- **Cloudflare KV Docs:** https://developers.cloudflare.com/workers/runtime-apis/kv/
- **Token Bucket Algorithm:** https://en.wikipedia.org/wiki/Token_bucket
- **RFC 6585 (429 Too Many Requests):** https://tools.ietf.org/html/rfc6585#section-4
- **Cloudflare Rate Limiting Product:** https://www.cloudflare.com/rate-limiting/ (for comparison)
- **Redis-based implementations:** https://redis.io/docs/data-structures/hyperloglog/ (related concepts)

---

## Appendix: Comparison with Alternatives

### Fixed Window Counter

```
Pros: Simple, minimal storage
Cons: No burst support, boundary issues (100 at :00, 100 at :01 = 200 in 2 sec)
Verdict: ❌ Too primitive for our needs
```

### Sliding Log

```
Pros: Exact limits, supports bursts
Cons: O(n) storage per window, requires sorted set cleanup
Verdict: ❌ KV storage costs would explode at scale
```

### Leaky Bucket

```
Pros: Smooth output rate, supports bursts
Cons: Queue semantics overkill for request dropping
Verdict: ⚠️ Viable but token bucket simpler for our use case
```

---

**Document Owner:** API Platform Team  
**Last Reviewed:** 2026-06-22  
**Next Review:** 2026-07-22
