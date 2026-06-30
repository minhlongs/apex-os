# Cloudflare KV Rate Limiting

## Tổng quan

ApexOS triển khai rate limiting cho API endpoints sử dụng Cloudflare KV để tránh D1 write exhaustion. Click tracking endpoint (`/api/tracking/click`) hiện sử dụng KV storage với limit **100 requests/IP/hour**.

## Cấu trúc

### Files

- `src/lib/ratelimit/rate-limiter.ts` - D1-based rate limiter (legacy, cho các endpoint khác)
- `src/lib/ratelimit/kv-rate-limiter.ts` - KV-based rate limiter (high-performance)
- `src/lib/ratelimit/middleware.ts` - Middleware wrapper hỗ trợ cả D1 và KV

### KV Storage

- **Namespace binding**: `KV` (định nghĩa trong `wrangler.toml`)
- **Key format**: `rate_limit:{endpoint_type}:{identifier}`
- **TTL**: Window seconds + 60 seconds buffer
- **Algorithm**: Sliding window với timestamps array

### D1 Storage (Fallback/Config)

- **Tables**: `rate_limits`, `rate_limit_configs`
- **Migration**: `006_rate_limiting_schema.sql`
- **Usage**: Chỉ để lưu config và các endpoint khác có thể dùng D1

## Implementation

### Sử dụng KV Rate Limit trong Route

```typescript
import { withRateLimit, extractIpAddress } from '@/lib/ratelimit/middleware';

export const GET = withRateLimit(async (request: NextRequest): Promise<Response> => {
  // Handler logic
}, {
  storage: 'kv',  // ← Sử dụng KV thay vì D1
  endpointType: 'click_tracking',
  getIdentifier: (request, userId) => ({
    ip: extractIpAddress(request.headers),
    userId
  })
});
```

### Rate Limit Configs

#### Built-in Defaults

| Endpoint Type | Max Requests | Window | Applies To | Description |
|---------------|--------------|--------|-------------|-------------|
| `click_tracking` | 100 | 1 hour | IP | Click tracking - 100 req/hour/IP |
| `click_tracking` | 1000 | 1 hour | user | Click tracking - 1000 req/hour/user (auth) |
| `auth` | 10-20 | 15 min | IP/user | Auth endpoints - brute force protection |
| `webhook` | 100-10000 | 1 min - 1 hr | api_key | Incoming webhooks |
| `admin` | 100-500 | 1 hour | user | Admin API endpoints |
| `api_general` | 500-2000 | 1 hour | IP/user | General API |

#### Role Multipliers

- `admin`: 2.0x
- `master_trader`: 1.5x
- `affiliate`: 1.2x
- `shopper`: 1.0x

#### Tier Multipliers

- `premium`: 2.5x
- `growth`: 1.5x
- `starter`: 1.2x
- `free`: 1.0x

## Headers

Rate limit headers được tự động thêm vào responses:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 97
X-RateLimit-Reset: 1710000000
X-RateLimit-Reset-After: 120s
Retry-After: 120  (chỉ khi limit exceeded)
```

## Monitoring

### Views (D1-based endpoints)

```sql
-- Active rate limits
SELECT * FROM v_active_rate_limits;

-- Stats per endpoint
SELECT * FROM v_rate_limit_stats;
```

### Cleanup

Expired KV entries tự động expire nhờ TTL. D1 entries (nếu có) cần cleanup định kỳ:

```sql
DELETE FROM rate_limits WHERE reset_at < datetime('now');
```

## Deployment Checklist

- [x] KV namespace binding đã có trong `wrangler.toml` (`binding = "KV"`)
- [x] Migration `006_rate_limiting_schema.sql` đã áp dụng
- [x] Click tracking route đã cập nhật `storage: 'kv'`
- [ ] Test rate limits với load testing tool
- [ ] Monitor KV namespace usage trong Cloudflare dashboard

## Performance Benefits

| Metric | D1-based | KV-based |
|--------|----------|----------|
| Write latency | ~10-50ms | ~1-5ms |
| Cost per 1M ops | ~$0.20 | ~$0.50 (free tier 100K/day) |
| Scalability | Limited by DB | Highly scalable |
| Rate limit impact | Adds DB load | Negligible |

**KV giúp loại bỏ hoàn toàn D1 writes cho rate limiting, bảo vệ database khỏi exhaustion từ click tracking traffic.**

## Troubleshooting

### Lỗi "KV binding not found"

Đảm bảo `wrangler.toml` có:

```toml
[[kv_namespaces]]
binding = "KV"
id = "your-namespace-id"
```

### Rate limits không hoạt động

1. Kiểm tra KV binding trong production: `wrangler pages functions:env list`
2. Verify key format trong KV namespace: `wrangler kv:key list --namespace-id <id> --prefix "rate_limit:"`
3. Check middleware logs

### Config không load từ D1

KVRateLimiter fallback về defaults nếu D1 không accessible. Config từ D1 có cache 30 giây.
