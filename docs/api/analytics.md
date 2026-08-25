# Analytics API Reference

Sprint 3 business analytics endpoints. All routes require `admin` role and return JSON with a 5-minute KV cache.

## Base URL

```
/api/analytics/*
```

## Response Envelope

```json
{
  "data": [],
  "total": 100,
  "page": 1,
  "page_size": 50,
  "query_time_ms": 23,
  "meta": {
    "generated_at": "2026-08-02T04:00:00.000Z",
    "cached": false
  }
}
```

Headers:
- `X-Cache: HIT | MISS`
- `X-Cache-Query-Time: <ms>`
- `Cache-Control: public, s-maxage=300, stale-while-revalidate=60`

## Endpoints

### GET /api/analytics/deals

Daily deal performance from `analytics_daily_deals` materialized view.

#### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `date_from` | `YYYY-MM-DD` | 30 days ago | Start date filter |
| `date_to` | `YYYY-MM-DD` | today | End date filter |
| `exchange` | `string` | — | Filter by exchange |
| `deal_id` | `number` | — | Filter by deal ID |
| `page` | `number` | `1` | Page number |
| `limit` | `number` | `50` | Items per page (max 100) |
| `refresh` | `boolean` | `false` | Bypass KV cache |

#### Example

```bash
curl -s "http://localhost:3000/api/analytics/deals?date_from=2026-07-26&date_to=2026-08-02&limit=100" \
  -H "Cookie: <session>"
```

#### Response

```json
{
  "data": [
    {
      "date": "2026-08-02",
      "deal_id": 42,
      "deal_name": "BTC/USDT 0.1%",
      "exchange": "binance",
      "deal_type": "spot",
      "category": "crypto",
      "total_clicks": 1523,
      "unique_clicks": 1205,
      "total_conversions": 47,
      "unique_customers": 47,
      "total_revenue": 156780.00,
      "total_commission": 4703.40,
      "conversion_rate_percent": 3.08,
      "avg_order_value": 3335.74,
      "converting_affiliates_count": 8
    }
  ],
  "total": 32,
  "page": 1,
  "page_size": 100,
  "query_time_ms": 18
}
```

---

### GET /api/analytics/affiliates

Top affiliates by day from `analytics_daily_affiliates` materialized view.

#### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `date_from` | `YYYY-MM-DD` | 30 days ago | Start date |
| `date_to` | `YYYY-MM-DD` | today | End date |
| `affiliate_id` | `number` | — | Filter by affiliate |
| `metric` | `string` | `conversions` | Sort by: `earnings`, `conversions`, `clicks` |
| `top` | `number` | `50` | Max rows (max 200) |
| `refresh` | `boolean` | `false` | Bypass KV cache |

#### Example

```bash
curl -s "http://localhost:3000/api/analytics/affiliates?top=20&metric=earnings" \
  -H "Cookie: <session>"
```

---

### GET /api/analytics/exchanges

Exchange breakdown + top trading pairs.

#### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `date_from` | `YYYY-MM-DD` | — | Start date filter |
| `date_to` | `YYYY-MM-DD` | — | End date filter |
| `include_top_pairs` | `boolean` | `false` | Include top 50 pairs |
| `refresh` | `boolean` | `false` | Bypass KV cache |

#### Response

```json
{
  "breakdown": {
    "data": [
      {
        "exchange": "binance",
        "total_deals": 245,
        "total_clicks": 15234,
        "total_conversions": 567,
        "total_volume": 45678900,
        "total_commission": 137036.70,
        "conversion_rate_percent": 3.72,
        "avg_order_value": 80557.17
      }
    ],
    "total": 4,
    "page": 1,
    "page_size": 4,
    "query_time_ms": 12
  },
  "top_pairs": {
    "data": [
      {
        "exchange": "binance",
        "pair_type": "BTC/USDT",
        "pair_category": "spot",
        "deal_count": 12,
        "total_clicks": 3456,
        "total_conversions": 189,
        "total_volume": 23456700,
        "conversion_rate_percent": 5.47
      }
    ],
    "total": 50,
    "page": 1,
    "page_size": 50,
    "query_time_ms": 8
  }
}
```

---

### GET /api/analytics/funnel

Daily conversion funnel stages from `analytics_funnel_daily` materialized view.

#### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `date_from` | `YYYY-MM-DD` | 30 days ago | Start date |
| `date_to` | `YYYY-MM-DD` | today | End date |
| `refresh` | `boolean` | `false` | Bypass KV cache |

#### Response

```json
{
  "data": [
    {
      "date": "2026-08-02",
      "visits": 5432,
      "clicks": 1245,
      "signups": 234,
      "activations": 189,
      "conversions": 156,
      "click_to_conversion_rate": 12.53,
      "activation_rate": 3.43
    }
  ],
  "total": 30,
  "page": 1,
  "page_size": 30,
  "query_time_ms": 9
}
```

---

## Cron Refresh

### POST /api/cron/refresh-analytics

Refreshes all 5 materialized analytics views.

**Auth:** Secret token header `X-Refresh-Secret` or `?secret=` query param.

```bash
curl -X POST "http://localhost:3000/api/cron/refresh-analytics" \
  -H "X-Refresh-Secret: $ANALYTICS_REFRESH_SECRET"
```

#### Response

```json
{
  "success": true,
  "started_at": "2026-08-02T04:00:00.000Z",
  "completed_at": "2026-08-02T04:00:12.000Z",
  "duration_ms": 12000,
  "views_refreshed": 5
}
```

---

## Caching

All endpoints use Cloudflare KV with:
- **Prefix:** `analytics:<endpoint>` (e.g., `analytics:deals`, `analytics:funnel`)
- **TTL:** 5 minutes (300s)
- **Bypass:** Add `?refresh=true` to skip cache (admin only)
- **Stale-while-revalidate:** 60s

Cache keys hash sorted query params for consistent lookups.

---

## Error Responses

| Status | Body |
|--------|------|
| 401 | `{ "error": "Unauthorized" }` |
| 403 | `{ "error": "Forbidden" }` |
| 500 | `{ "error": "Internal server error", "details": "..." }` |

---

## Types

Defined in `src/types/analytics.ts`:

- `AnalyticsResult<T>` — standard paged response
- `DailyDealRow`, `DailyAffiliateRow`, `ExchangeBreakdownRow`, `TopPairRow`, `FunnelDailyRow`
- `DealsAnalyticsFilters`, `AffiliatesAnalyticsFilters`, `ExchangesFilters`, `FunnelFilters`
