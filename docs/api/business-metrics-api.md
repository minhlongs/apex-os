# Business Metrics API Documentation

## Overview

The Business Metrics API (`GET /api/metrics/business`) provides aggregated business intelligence for the ApexOS affiliate cashback platform. It delivers comprehensive analytics on revenue, conversions, affiliate performance, and deal effectiveness.

## Authentication & Authorization

- **Authentication**: Session-based via Better Auth
- **Authorization**: Admin role required (`profiles.role = 'admin'`)
- **Rate Limit**: 100 requests per hour per admin user

## Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start_date` | YYYY-MM-DD | 30 days ago | Start date for the metrics period |
| `end_date` | YYYY-MM-DD | Today | End date for the metrics period |
| `group_by` | `daily` \| `weekly` \| `monthly` \| `all` | `daily` | Time aggregation granularity |
| `deal_type` | `product` \| `service` \| `subscription` \| `course` | All | Filter by deal type |
| `exchange` | `binance` \| `bybit` \| `okx` \| `kucoin` | All | Filter by exchange |
| `status` | `approved` \| `pending` \| `all` | `approved` | Conversion status filter |

## Response Format

```json
{
  "generated_at": "2026-06-22T10:30:00Z",
  "query": {
    "start_date": "2026-06-01",
    "end_date": "2026-06-30",
    "group_by": "daily",
    "deal_type": null,
    "exchange": null,
    "status": "approved"
  },
  "cached": false,
  "cache_ttl_remaining": 285,
  "daily_revenue": [
    {
      "date": "2026-06-30",
      "revenue": 12500.50,
      "conversions": 125,
      "unique_customers": 98,
      "average_order_value": 100.00,
      "commission_paid": 3750.15,
      "commission_rate_percent": 30.0
    }
  ],
  "conversion_rates": [
    {
      "period": "2026-06-30",
      "unique_visitors": 5000,
      "total_clicks": 8000,
      "total_conversions": 125,
      "conversion_rate": 1.56,
      "avg_time_to_conversion": 86400
    }
  ],
  "active_affiliates": {
    "total_affiliates": 45,
    "affiliates_with_conversions": 28,
    "new_affiliates": 5,
    "avg_lifetime_earnings": 2340.50,
    "top_performers": [
      {
        "id": "aff_123",
        "email": "top@example.com",
        "full_name": "Top Affiliate",
        "level": 1,
        "lifetime_earnings": 15000.00,
        "pending_earnings": 450.00,
        "total_conversions": 150,
        "total_revenue": 50000.00,
        "conversion_rate": 3.2,
        "total_clicks": 4687,
        "is_active": true,
        "last_activity_date": "2026-06-30",
        "direct_referrals": 12,
        "indirect_referrals": 34,
        "commission_rate": 0.30,
        "last_payout_date": "2026-06-15"
      }
    ],
    "distribution_by_level": {
      "level_1": 25,
      "level_2": 15,
      "level_3": 5
    }
  },
  "top_deals": {
    "period": {
      "start_date": "2026-06-01",
      "end_date": "2026-06-30"
    },
    "limit": 10,
    "deals": [
      {
        "id": "deal_abc",
        "name": "Binance BTC Spot Trading",
        "exchange": "binance",
        "category": "spot",
        "total_clicks": 15000,
        "unique_clicks": 12000,
        "total_conversions": 450,
        "conversion_rate": 3.0,
        "total_revenue": 45000.00,
        "total_commission": 13500.00,
        "avg_commission_rate": 0.30,
        "is_active": true
      }
    ],
    "summary": {
      "total_clicks": 50000,
      "total_conversions": 1200,
      "total_revenue": 120000.00,
      "avg_conversion_rate": 2.4
    }
  },
  "summary": {
    "period_start": "2026-06-01",
    "period_end": "2026-06-30",
    "total_revenue": 120000.00,
    "total_conversions": 1200,
    "overall_conversion_rate": 2.4,
    "active_affiliates_count": 45,
    "total_commission_liability": 36000.00,
    "top_deal_name": "Binance BTC Spot Trading",
    "top_affiliate_name": "Top Affiliate"
  }
}
```

## Response Headers

| Header | Value | Description |
|--------|-------|-------------|
| `X-Cache` | `HIT` \| `MISS` | Indicates if response was served from cache |
| `X-Cache-TTL` | seconds | Remaining TTL for cached response |
| `X-Response-Time` | milliseconds | Server processing time |
| `X-RateLimit-Limit` | count | Rate limit for this endpoint |
| `X-RateLimit-Remaining` | count | Remaining requests in window |
| `X-RateLimit-Reset` | timestamp | When rate limit resets |

## Caching Strategy

### Cache Configuration

- **TTL**: 5 minutes (300 seconds)
- **Cache Type**: Distributed (Cloudflare KV) with in-memory fallback
- **Cache Key**: MD5 hash of query parameters
- **Stale-While-Revalidate**: 10 minutes

### Cache Invalidation

Cache entries automatically expire based on TTL. Manual invalidation can be done via:

```bash
# Clear all metrics cache
wrangler kv:key delete --namespace-id=<KV_NAMESPACE> --key="metrics:business:*"

# Or via API
curl -X POST https://api.apex-os.com/api/admin/cache/invalidate \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"pattern": "metrics:business"}'
```

## Database Schema Requirements

The API relies on the following materialized views:

### `v_daily_revenue`

Aggregates daily revenue, conversions, and commission data:

```sql
SELECT
  DATE(converted_at) as date,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT c.customer_id) as unique_customers,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(e.amount), 0) as total_commission,
  AVG(c.revenue) as avg_order_value,
  COUNT(DISTINCT dc.id) as total_clicks,
  COUNT(DISTINCT dc.session_id) as unique_visitors,
  (CASE WHEN COUNT(DISTINCT dc.id) > 0
    THEN (COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id))
    ELSE 0 END) as conversion_rate_percent
FROM conversions c
LEFT JOIN earnings e ON e.conversion_id = c.id
LEFT JOIN deal_clicks dc ON dc.deal_id = c.deal_id
  AND dc.created_at >= DATE(c.converted_at, '-30 days')
WHERE c.status = 'approved'
GROUP BY DATE(converted_at);
```

### `v_conversion_rates`

Daily conversion funnel metrics:

```sql
SELECT
  DATE(dc.created_at) as date,
  COUNT(DISTINCT dc.session_id) as unique_visitors,
  COUNT(DISTINCT dc.id) as total_clicks,
  COUNT(DISTINCT c.id) as total_conversions,
  ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2) as conversion_rate_percent,
  AVG((julianday(c.converted_at) - julianday(dc.created_at)) * 86400) as avg_seconds_to_conversion
FROM deal_clicks dc
LEFT JOIN conversions c ON c.deal_id = dc.deal_id
  AND c.customer_id IS NOT NULL
  AND c.status = 'approved'
  AND c.converted_at <= datetime(dc.created_at, '+30 days')
  AND c.converted_at >= dc.created_at
GROUP BY DATE(dc.created_at);
```

### `v_active_affiliates`

Affiliate performance and activity:

```sql
SELECT
  p.id, p.email, p.full_name,
  COALESCE(rt.level, 1) as level,
  COALESCE(rt.total_earnings, 0) as lifetime_earnings,
  COALESCE(SUM(CASE WHEN e.is_paid = 0 THEN e.amount ELSE 0 END), 0) as pending_earnings,
  COUNT(DISTINCT c.id) as total_conversions,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(ap.conversion_rate, 0) as conversion_rate,
  COUNT(DISTINCT dc.id) as total_clicks,
  CASE WHEN MAX(dc.created_at) >= datetime('now', '-30 days') THEN 1 ELSE 0 END as is_active,
  MAX(dc.created_at) as last_click_date,
  MAX(c.converted_at) as last_conversion_date,
  rt.total_direct_referrals,
  rt.total_indirect_referrals,
  COALESCE(ac.commission_rate, 0.10) as commission_rate,
  p.created_at as joined_date
FROM profiles p
LEFT JOIN referral_tree rt ON rt.affiliate_id = p.id
LEFT JOIN affiliate_codes ac ON ac.affiliate_id = p.id AND ac.is_active = 1
LEFT JOIN earnings e ON e.affiliate_id = p.id
LEFT JOIN conversions c ON c.affiliate_id = p.id AND c.status = 'approved'
LEFT JOIN deal_clicks dc ON dc.affiliate_id = p.id
LEFT JOIN v_affiliate_performance ap ON ap.affiliate_id = p.id
WHERE p.role IN ('affiliate', 'admin', 'master_trader')
GROUP BY p.id, p.email, p.full_name, rt.level, rt.total_earnings,
         rt.total_direct_referrals, rt.total_indirect_referrals,
         ap.conversion_rate, ac.commission_rate, p.created_at;
```

### `v_deal_performance`

Deal-level performance metrics:

```sql
SELECT
  d.id, d.name, d.deal_type, d.exchange, d.category,
  d.cashback_percent, d.is_active,
  COUNT(DISTINCT dc.id) as total_clicks,
  COUNT(DISTINCT dc.session_id) as unique_clicks,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT c.customer_id) as unique_customers,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(e.amount), 0) as total_commission,
  COALESCE(AVG(c.revenue), 0) as avg_order_value,
  ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2) as conversion_rate_percent,
  COALESCE(AVG(ac.commission_rate), d.default_commission_rate) as avg_commission_rate
FROM deals d
LEFT JOIN deal_clicks dc ON dc.deal_id = d.id
LEFT JOIN conversions c ON c.deal_id = d.id AND c.status = 'approved'
LEFT JOIN earnings e ON e.conversion_id = c.id
LEFT JOIN affiliate_codes ac ON ac.code = c.affiliate_code
GROUP BY d.id, d.name, d.deal_type, d.exchange, d.category,
         d.cashback_percent, d.is_active, d.default_commission_rate;
```

## Performance Optimization

### Indexes Required

```sql
-- Date-based aggregations
CREATE INDEX IF NOT EXISTS idx_conversions_status_converted ON conversions(status, converted_at);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_created ON deal_clicks(created_at);
CREATE INDEX IF NOT EXISTS idx_earnings_created ON earnings(created_at);

-- Covering indexes for aggregations
CREATE INDEX IF NOT EXISTS idx_conv_rev_agg ON conversions(status, converted_at, revenue, affiliate_id, deal_id, customer_id)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_clicks_agg ON deal_clicks(deal_id, affiliate_id, created_at, session_id);

CREATE INDEX IF NOT EXISTS idx_earnings_affiliate_agg ON earnings(affiliate_id, is_paid, amount, conversion_id);
```

### Query Performance

With proper indexes:
- **Cold queries**: 200-500ms (cache miss)
- **Warm queries**: 5-50ms (cache hit)
- **Complex filtered queries**: 300-800ms

## Error Handling

| Status Code | Scenario | Response Body |
|-------------|----------|---------------|
| 200 | Success | `{ success: true, data: {...} }` |
| 400 | Invalid query parameters | `{ error: "Invalid query parameters", details: "..." }` |
| 401 | Not authenticated | `{ error: "Unauthorized" }` |
| 403 | Non-admin user | `{ error: "Forbidden: Admin access required" }` |
| 429 | Rate limit exceeded | `{ error: "Too Many Requests", retryAfter: 3600 }` |
| 503 | Database unavailable | `{ error: "Database not available" }` |
| 500 | Server error | `{ error: "Internal server error", details: "..." }` |

## Usage Examples

### Basic Request (Last 30 Days)

```bash
curl -H "Cookie: __session=<SESSION_TOKEN>" \
  https://api.apex-os.com/api/metrics/business
```

### Filtered by Date Range and Exchange

```bash
curl -H "Cookie: __session=<SESSION_TOKEN>" \
  "https://api.apex-os.com/api/metrics/business?start_date=2026-06-01&end_date=2026-06-15&exchange=binance"
```

### Weekly Aggregation with Deal Type Filter

```bash
curl -H "Cookie: __session=<SESSION_TOKEN>" \
  "https://api.apex-os.com/api/metrics/business?group_by=weekly&deal_type=product"
```

### Frontend Integration (React)

```tsx
import { useQuery } from '@tanstack/react-query';

async function fetchBusinessMetrics(params: {
  start_date?: string;
  end_date?: string;
  deal_type?: string;
  exchange?: string;
}) {
  const query = new URLSearchParams({
    start_date: params.start_date || '30-days-ago',
    end_date: params.end_date || 'today',
    deal_type: params.deal_type || '',
    exchange: params.exchange || '',
  }).toString();

  const response = await fetch(`/api/metrics/business?${query}`, {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch metrics: ${response.status}`);
  }

  return response.json();
}

// Usage
const { data: metrics, isLoading, error } = useQuery({
  queryKey: ['business-metrics', params],
  queryFn: () => fetchBusinessMetrics(params),
  staleTime: 5 * 60 * 1000, // 5 minutes
});
```

## Monitoring & Alerting

Key metrics to monitor for this endpoint:

1. **Response Time**: P95 < 200ms (cache hit), P95 < 500ms (cache miss)
2. **Cache Hit Rate**: Target > 80%
3. **Error Rate**: Target < 0.1%
4. **Database Query Time**: P95 < 100ms for individual queries

## Rate Limit Configuration

Add to `rate_limit_configs` table:

```sql
INSERT INTO rate_limit_configs (endpoint_type, max_requests, window_seconds, applies_to, description, is_active)
VALUES ('admin_metrics', 100, 3600, 'user', 'Business metrics API - 100 req/hour per admin', 1);
```

## Migration Instructions

1. Run database migration for views:
   ```bash
   wrangler d1 execute apex-os-db --file src/database/migrations/010_business_metrics_views.sql
   ```

2. Add rate limit configuration:
   ```bash
   wrangler d1 execute apex-os-db --file src/database/migrations/011_metrics_rate_limit.sql
   ```

3. Deploy the API route:
   ```bash
   pnpm build
   wrangler pages deploy .next
   ```

4. Verify deployment:
   ```bash
   curl -H "Cookie: __session=<ADMIN_SESSION>" https://your-app.pages.dev/api/metrics/business
   ```
