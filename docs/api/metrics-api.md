# Metrics API Documentation

**Last Updated:** 2026-06-22
**Version:** v1.0.0
**Base URL:** `/api/metrics`
**Authentication:** Admin role required
**Rate Limit:** 100 requests per hour per admin user

---

## Table of Contents

1. [Overview](#overview)
2. [Endpoints](#endpoints)
   - [Business Metrics](#business-metrics)
   - [Time Series Metrics](#time-series-metrics)
3. [Data Models](#data-models)
4. [Query Parameters](#query-parameters)
5. [Caching](#caching)
6. [Error Handling](#error-handling)
7. [Examples](#examples)

---

## Overview

The Metrics API provides aggregated business intelligence and performance metrics for the ApexOS admin dashboard. All data is sourced from materialized views for optimal query performance.

### Key Features

- **Real-time aggregation** with 5-minute distributed KV caching
- **Flexible filtering** by date range, deal type, exchange, and status
- **Materialized views** for consistent performance
- **Rate limiting** per admin user with role-based multipliers
- **Cache-aware responses** with TTL headers

### Materialized Views

The metrics API relies on the following database views:

- `v_daily_revenue` - Aggregated daily revenue and conversion metrics
- `v_conversion_rates` - Funnel metrics (visitors, clicks, conversions)
- `v_active_affiliates` - Affiliate activity and earnings summary
- `v_deal_performance` - Deal-level performance metrics
- `v_timeseries_metrics` - Time-series data for trend analysis

---

## Endpoints

### Business Metrics

#### `GET /api/metrics/business`

Provides comprehensive business metrics aggregation for a specified date range.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `start_date` | string | No | 30 days ago | Start date in `YYYY-MM-DD` format |
| `end_date` | string | No | Today | End date in `YYYY-MM-DD` format |
| `group_by` | string | No | `daily` | Aggregation period: `daily`, `weekly`, `monthly`, `all` |
| `deal_type` | string | No | All | Filter by deal type: `product`, `service`, `subscription`, `course` |
| `exchange` | string | No | All | Filter by exchange: `binance`, `bybit`, `okx`, `kucoin` |
| `status` | string | No | `approved` | Conversion status: `approved`, `pending`, `all` |

**Response:** `200 OK`

```json
{
  "cached": false,
  "cache_ttl_remaining": 285,
  "generated_at": "2026-06-22T12:00:00.000Z",
  "query": {
    "start_date": "2026-05-23",
    "end_date": "2026-06-22",
    "group_by": "daily",
    "deal_type": "",
    "exchange": "",
    "status": "approved"
  },
  "daily_revenue": [
    {
      "date": "2026-06-22",
      "revenue": 12500.50,
      "conversions": 45,
      "unique_customers": 38,
      "average_order_value": 277.79,
      "commission_paid": 3750.15,
      "commission_rate_percent": 30.00
    }
  ],
  "conversion_rates": [
    {
      "period": "2026-06-22",
      "unique_visitors": 1250,
      "total_clicks": 450,
      "total_conversions": 45,
      "conversion_rate": 10.00,
      "avg_time_to_conversion": 86400
    }
  ],
  "active_affiliates": {
    "total_affiliates": 156,
    "affiliates_with_conversions": 89,
    "new_affiliates": 12,
    "avg_lifetime_earnings": 245.50,
    "top_performers": [
      {
        "id": "aff_123",
        "email": "top.affiliate@example.com",
        "full_name": "Top Affiliate",
        "level": 1,
        "lifetime_earnings": 15000.00,
        "pending_earnings": 250.00,
        "total_conversions": 120,
        "conversion_rate": 15.5,
        "total_clicks": 775,
        "direct_referrals": 45,
        "indirect_referrals": 120,
        "commission_rate": 30,
        "last_payout_date": "2026-06-15",
        "joined_date": "2026-03-01"
      }
    ],
    "distribution_by_level": {
      "level_1": 45,
      "level_2": 67,
      "level_3": 44
    }
  },
  "top_deals": {
    "period": {
      "start_date": "2026-05-23",
      "end_date": "2026-06-22"
    },
    "limit": 10,
    "deals": [
      {
        "id": "deal_123",
        "name": "Binance Spot Trading Fee Rebate",
        "exchange": "binance",
        "category": "trading",
        "total_clicks": 1250,
        "unique_clicks": 980,
        "total_conversions": 125,
        "conversion_rate": 10.00,
        "total_revenue": 25000.00,
        "total_commission": 7500.00,
        "avg_commission_rate": 30.0,
        "is_active": true,
        "top_affiliate": {
          "email": "top.affiliate@example.com"
        }
      }
    ],
    "summary": {
      "total_clicks": 8500,
      "total_conversions": 420,
      "total_revenue": 87500.00,
      "avg_conversion_rate": 4.94
    }
  },
  "summary": {
    "total_revenue": 87500.00,
    "total_conversions": 420,
    "total_affiliates": 156,
    "active_affiliates_count": 89,
    "avg_conversion_rate": 4.94,
    "avg_order_value": 277.79
  }
}
```

**Cache Headers:**

```
X-Cache: HIT|MISS
X-Cache-TTL: 285  (remaining seconds)
X-Response-Time: 145  (ms)
```

**Error Responses:**

| Status | Code | Description |
|--------|------|-------------|
| `401` | `UNAUTHORIZED` | User not authenticated |
| `403` | `FORBIDDEN` | User is not an admin |
| `429` | `TOO_MANY_REQUESTS` | Rate limit exceeded |
| `500` | `INTERNAL_ERROR` | Server error |

---

### Time Series Metrics

#### `GET /api/metrics/timeseries`

Provides time-series data for charts and trend analysis.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `metric` | string | Yes | - | Metric type: `revenue`, `conversions`, `clicks`, `affiliates`, `payouts` |
| `start_date` | string | No | 30 days ago | Start date in `YYYY-MM-DD` format |
| `end_date` | string | No | Today | End date in `YYYY-MM-DD` format |
| `interval` | string | No | `daily` | Interval: `hourly`, `daily`, `weekly`, `monthly` |

**Response:** `200 OK`

```json
{
  "metric": "revenue",
  "interval": "daily",
  "period": {
    "start": "2026-05-23T00:00:00.000Z",
    "end": "2026-06-22T23:59:59.999Z"
  },
  "data": [
    {
      "timestamp": "2026-06-22T00:00:00.000Z",
      "value": 12500.50,
      "count": 45
    },
    {
      "timestamp": "2026-06-21T00:00:00.000Z",
      "value": 10800.00,
      "count": 38
    }
  ],
  "summary": {
    "total": 245750.00,
    "avg": 8975.00,
    "min": 4200.00,
    "max": 15600.00,
    "count": 30
  }
}
```

---

## Data Models

### BusinessMetricsResponse

```typescript
interface BusinessMetricsResponse {
  cached: boolean;
  cache_ttl_remaining?: number;
  generated_at: string;
  query: {
    start_date: string;
    end_date: string;
    group_by: string;
    deal_type?: string;
    exchange?: string;
    status?: string;
  };
  daily_revenue: DailyRevenue[];
  conversion_rates: ConversionRate[];
  active_affiliates: ActiveAffiliates;
  top_deals: TopDeals;
  summary: MetricsSummary;
}

interface DailyRevenue {
  date: string;
  revenue: number;
  conversions: number;
  unique_customers: number;
  average_order_value: number;
  commission_paid: number;
  commission_rate_percent: number;
}

interface ConversionRate {
  period: string;
  unique_visitors: number;
  total_clicks: number;
  total_conversions: number;
  conversion_rate: number;
  avg_time_to_conversion: number;
}

interface ActiveAffiliate {
  id: string;
  email: string;
  full_name: string | null;
  level: number;
  lifetime_earnings: number;
  pending_earnings: number;
  total_conversions: number;
  conversion_rate: number;
  total_clicks: number;
  direct_referrals: number;
  indirect_referrals: number;
  commission_rate: number;
  last_payout_date: string | null;
  joined_date: string;
}

interface ActiveAffiliates {
  total_affiliates: number;
  affiliates_with_conversions: number;
  new_affiliates: number;
  avg_lifetime_earnings: number;
  top_performers: ActiveAffiliate[];
  distribution_by_level: {
    level_1: number;
    level_2: number;
    level_3: number;
  };
}

interface TopDeal {
  id: string;
  name: string;
  exchange: string | null;
  category: string | null;
  total_clicks: number;
  unique_clicks: number;
  total_conversions: number;
  conversion_rate: number;
  total_revenue: number;
  total_commission: number;
  avg_commission_rate: number;
  is_active: boolean;
  top_affiliate?: { email: string };
}

interface TopDeals {
  period: { start_date: string; end_date: string };
  limit: number;
  deals: TopDeal[];
  summary: {
    total_clicks: number;
    total_conversions: number;
    total_revenue: number;
    avg_conversion_rate: number;
  };
}

interface MetricsSummary {
  total_revenue: number;
  total_conversions: number;
  total_affiliates: number;
  active_affiliates_count: number;
  avg_conversion_rate: number;
  avg_order_value: number;
}
```

---

## Query Parameters

### Date Formats

All date parameters accept `YYYY-MM-DD` format. The API will validate date ranges:

- `start_date` must be on or before `end_date`
- Maximum range: 365 days (1 year)
- Minimum range: 1 day

### Filtering Behavior

When `deal_type` or `exchange` filters are applied:

- **Revenue data**: Joins with `deals` and `conversions` tables to filter by deal attributes
- **Conversion rates**: Groups by date after filtering to avoid double-counting
- **Affiliates**: Uses DISTINCT to handle multiple conversion joins
- **Top deals**: Filters by date range and orders by revenue

### Group By Options

| Value | Description | Example Output |
|-------|-------------|----------------|
| `daily` | Each day as separate entry | 30 entries for 30 days |
| `weekly` | Weekly aggregation (Mon-Sun) | 4-5 entries per month |
| `monthly` | Monthly aggregation | 1 entry per month |
| `all` | Single aggregated total | 1 entry |

---

## Caching

### Cache Strategy

- **Cache TTL:** 5 minutes (300 seconds)
- **Cache Key:** Generated from all query parameters
- **Storage:** Distributed KV cache (Cloudflare KV)
- **Invalidation:** Automatic TTL expiry

### Cache Headers

| Header | Values | Meaning |
|--------|--------|---------|
| `X-Cache` | `HIT` \| `MISS` | Whether response was served from cache |
| `X-Cache-TTL` | number (seconds) | Remaining cache lifetime (only on HIT) |

### Cache Bypass

Currently, all responses are cached. To force fresh computation:

1. Wait for cache TTL to expire (5 minutes)
2. Or modify query parameters (different cache key)

Future enhancement: Add `?refresh=true` query parameter for admin override.

---

## Error Handling

### Standard Error Response

```json
{
  "error": "Error Type",
  "details": "Human-readable description",
  "code": "ERROR_CODE"
}
```

### Common Errors

| HTTP Status | Error Type | Details | Resolution |
|-------------|------------|---------|------------|
| 401 | `UNAUTHORIZED` | User not logged in | Authenticate via Better Auth |
| 403 | `FORBIDDEN` | Non-admin user | Assign admin role in database |
| 429 | `TOO_MANY_REQUESTS` | Rate limit exceeded | Wait for retry-after period |
| 400 | `INVALID_PARAMETERS` | Invalid query params | Check date format, valid enum values |
| 503 | `DATABASE_UNAVAILABLE` | D1 connection issue | Retry after brief delay |
| 500 | `INTERNAL_ERROR` | Server error | Check logs, contact engineering |

### Rate Limit Response

```json
{
  "error": "Too Many Requests",
  "retryAfter": 3600,
  "limit": 100,
  "remaining": 0,
  "reset": 1719064800
}
```

Headers:
```
Retry-After: 3600
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1719064800
```

---

## Examples

### cURL Examples

**Get metrics for last 30 days:**
```bash
curl -H "Cookie: __session=YOUR_SESSION" \
  https://apex-os.pages.dev/api/metrics/business
```

**Filter by exchange (Binance only):**
```bash
curl -H "Cookie: __session=YOUR_SESSION" \
  "https://apex-os.pages.dev/api/metrics/business?exchange=binance"
```

**Get weekly aggregation for Q2 2026:**
```bash
curl -H "Cookie: __session=YOUR_SESSION" \
  "https://apex-os.pages.dev/api/metrics/business?start_date=2026-04-01&end_date=2026-06-30&group_by=weekly"
```

**Get time series revenue data:**
```bash
curl -H "Cookie: __session=YOUR_SESSION" \
  "https://apex-os.pages.dev/api/metrics/timeseries?metric=revenue&interval=daily"
```

### JavaScript/TypeScript Examples

```typescript
async function fetchBusinessMetrics(params: {
  start_date?: string;
  end_date?: string;
  group_by?: string;
  deal_type?: string;
  exchange?: string;
  status?: string;
}) {
  const session = await getSession(); // Your auth helper
  const url = new URL('/api/metrics/business', window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.append(key, value);
  });

  const response = await fetch(url.toString(), {
    headers: {
      Cookie: `__session=${session.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed: ${response.statusText}`);
  }

  return response.json() as Promise<BusinessMetricsResponse>;
}

// Usage with cache check
const metrics = await fetchBusinessMetrics({
  start_date: '2026-05-22',
  end_date: '2026-06-22',
  group_by: 'daily',
});

if (metrics.cached) {
  console.log(`Cache hit! TTL: ${metrics.cache_ttl_remaining}s`);
}
```

---

## Monitoring & Alerts

The metrics API itself is monitored:

- **Response time:** P95 should be <500ms (cache hit) or <2000ms (cache miss)
- **Error rate:** Should be <1%
- **Cache hit rate:** Should be >80% for common queries

Alert thresholds:
- Response time >5s for >5 minutes
- Error rate >5% for >10 minutes
- Cache hit rate <50% for >30 minutes

---

## Performance Characteristics

| Scenario | P50 | P95 | P99 |
|----------|-----|-----|-----|
| Cache hit | ~50ms | ~120ms | ~200ms |
| Cache miss (uncached) | ~800ms | ~1500ms | ~2500ms |
| With heavy filters (multiple joins) | ~1200ms | ~2000ms | ~3500ms |

Performance tips:
- Use wider date ranges (caching more effective)
- Avoid filtering by both `deal_type` and `exchange` simultaneously when possible
- The `all` group_by is fastest (single aggregation)
- Top deals limited to 10 rows by default

---

## Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2026-06-22 | 1.0.0 | Initial metrics API documentation |

---

**Related Documentation:**
- [Admin Dashboards Guide](../admin-dashboards.md)
- [Operational Runbook](../operational-runbook.md)
- [Database Schema](../../src/database/migrations/003_affiliate_schema.sql)
