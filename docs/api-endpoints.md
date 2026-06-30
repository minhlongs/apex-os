# ApexOS API Endpoints Documentation

**Base URL:** `/api/*`  
**Auth:** Better Auth with session cookies  
**Format:** JSON request/response

---

## Public Endpoints

### GET `/api/public/deals`

List public affiliate deals with filters.

**Query params:**
- `exchange` — filter by exchange (binance, bybit)
- `category` — filter by category (spot, futures, etc.)
- `cashback_min` — minimum cashback percentage
- `page` — page number (default: 1)
- `limit` — items per page (max: 50, default: 20)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "deal_123",
      "name": "Binance Spot Trading",
      "description": "Earn 30% cashback on fees",
      "exchange": "binance",
      "category": "spot",
      "cashback_percent": 30,
      "url": "https://binance.com/...",
      "is_active": true,
      "created_at": "2025-06-20T10:00:00Z"
    }
  ],
  "pagination": {
    "total": 150,
    "page": 1,
    "totalPages": 8,
    "hasNext": true
  }
}
```

---

### GET `/api/health`

Health check endpoint (no auth required).

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-06-20T10:00:00Z",
  "uptime": 86400,
  "version": "1.0.0"
}
```

---

## Tracking

### GET `/api/tracking/click`

Record deal click and redirect to deal page.

**Query params:**
- `deal_id` — required, the deal being clicked
- `ref` — optional, affiliate referral code
- `redirect` — optional, override redirect URL

**Rate limit:** 100 req/hour per IP

**Response:** 302 redirect to deal page with tracking cookie set

**Cookie:** `apex_tracking_id` (30-day expiry)

---

## Webhooks

### POST `/api/webhooks/exchange`

Receive trade notifications from exchanges (Binance, Bybit).

**Headers:**
- `X-Binance-Signature` or `X-Bybit-HMAC-Signature`
- `X-Bybit-Signature-Timestamp` (Bybit only)

**Security:**
- HMAC signature verification
- Timestamp validation (5-minute window)
- Replay protection (24h KV cache)

**Success response:**
```json
{
  "success": true,
  "conversionId": "conv_abc123",
  "earningsIds": ["earn_1", "earn_2", "earn_3"],
  "message": "Trade recorded and earnings calculated"
}
```

**Skipped responses:**
```json
{ "success": true, "skipped": true, "reason": "No matching deal" }
{ "success": true, "skipped": true, "reason": "User not found or account not linked" }
```

**Environment variables:**
- `BINANCE_WEBHOOK_SECRET`
- `BYBIT_WEBHOOK_SECRET`

---

## User Endpoints (Authenticated)

### GET/POST `/api/deals`

Admin-only: CRUD operations for deals.

**Auth:** Requires `role === 'admin'`

**POST body (create):**
```json
{
  "name": "Binance Spot Trading",
  "description": "Earn 30% cashback on fees",
  "exchange": "binance",
  "category": "spot",
  "cashback_percent": 30,
  "url": "https://binance.com/...",
  "expires_at": "2025-12-31T23:59:59Z",
  "is_active": true
}
```

---

### GET `/api/affiliate/dashboard`

Affiliate dashboard statistics.

**Response:**
```json
{
  "success": true,
  "data": {
    "affiliate_code": "KING001",
    "stats": {
      "total_clicks": 1234,
      "total_conversions": 56,
      "total_earnings": 1234.56,
      "pending_earnings": 234.56,
      "paid_earnings": 1000.00,
      "referral_count": 12
    },
    "referral_tree": [
      {
        "level": 1,
        "users": [{ "id": "user_1", "email": "...", "earnings": 500 }]
      },
      {
        "level": 2,
        "users": [...]
      }
    ]
  }
}
```

---

### GET `/api/affiliate/conversions`

List affiliate conversions with filters.

**Query params:**
- `page`, `limit`
- `status` — pending/paid
- `date_from`, `date_to`

---

### GET `/api/affiliate/payouts`

Payout history.

**Response includes:**
```json
{
  "success": true,
  "data": [
    {
      "id": "payout_123",
      "amount": 100.00,
      "status": "completed",
      "paid_at": "2025-06-15T10:00:00Z",
      "transaction_id": "stellar_tx_hash...",
      "note": "Weekly payout"
    }
  ],
  "summary": {
    "total_paid": 5000.00,
    "pending_amount": 234.56
  }
}
```

---

## Admin Endpoints (Authenticated + Admin Role)

### GET `/api/admin/affiliates`

List all affiliates with sorting/pagination.

**Query params:**
- `page`, `limit`
- `sortBy` — `lifetime_earnings`, `clicks`, `conversions`
- `sortOrder` — `asc`/`desc`
- `timeRange` — `all`, `7d`, `30d`, `90d`

---

### GET `/api/admin/alerts`

Alert management with filters.

**Query params:**
- `status` — `active`, `acknowledged`, `resolved`
- `severity` — `critical`, `warning`, `info`
- `type` — alert type filter
- `isRead` — `true`/`false`
- `isSilenced` — `true`/`false`
- `search` — text search
- `page`, `limit`

---

### GET `/api/admin/metrics`

Business metrics dashboard.

**Response:**
```json
{
  "success": true,
  "metrics": {
    "revenue": {
      "today": 1234.56,
      "week": 8642.00,
      "month": 35000.00
    },
    "conversions": {
      "today": 45,
      "week": 312,
      "month": 1200
    },
    "affiliates": {
      "active": 150,
      "new_week": 12
    }
  }
}
```

---

### POST `/api/admin/alerts`

Perform alert actions.

**Body:**
```json
{
  "action": "acknowledge" | "resolve" | "snooze" | "markRead" | "markUnread",
  "alertId": "alert_123",
  "alertIds": ["alert_1", "alert_2"],  // for bulk actions
  "snoozeUntil": "2025-06-21T10:00:00Z"  // for snooze
}
```

---

### GET `/api/admin/analytics/overview`

Traffic analytics (page views, referrers, devices, countries).

---

### GET `/api/monitoring/alert-engine`

Alert engine status and evaluation metrics.

**Query:**
- `stats=true` — include evaluation statistics
- `errors=true` — include error statistics
- `circuit-breakers=true` — show circuit breaker status

---

### GET `/api/monitoring/evaluation`

Dedicated evaluation metrics.

---

### POST `/api/monitoring/evaluation?action=cleanup`

Clean up old evaluation data (retention).

---

### GET `/api/payouts`

Trigger or check payout run (admin only).

**POST** with empty body triggers manual payout run.

---

## Error Response Format

```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "Human-readable error message",
  "details": {}  // optional additional context
}
```

**Common error codes:**
- `RATE_LIMITED` — Too many requests, check `Retry-After` header
- `UNAUTHORIZED` — Authentication required
- `FORBIDDEN` — Insufficient permissions
- `VALIDATION_ERROR` — Invalid request body
- `NOT_FOUND` — Resource not found
- `INTERNAL_ERROR` — Server error

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| `/api/tracking/click` | 100 req/hour per IP |
| `/api/auth/signup` | 3 req/min per email |
| `/api/auth/signin` | 5 req/min per IP |
| Webhook endpoints | Unlimited (verified sources) |

---

## Environment Variables

See `CLAUDE.md` for full list.

Key variables:
- `BETTER_AUTH_SECRET` — Auth session signing
- `BINANCE_WEBHOOK_SECRET` — Binance webhook HMAC
- `BYBIT_WEBHOOK_SECRET` — Bybit webhook HMAC
- `NEXT_PUBLIC_MIXPANEL_TOKEN` — Analytics (Mixpanel)
- `NEXT_PUBLIC_AMPLITUDE_API_KEY` — Analytics (Amplitude)
- `STELLAR_SECRET_KEY` — Payout signing key

---

## Testing

```bash
# Health check
curl https://apex-os.pages.dev/api/health

# List deals
curl https://apex-os.pages.dev/api/public/deals

# Webhook test (use scripts/send-mock-webhook.ts)
tsx scripts/send-mock-webhook.ts --exchange binance --volume 1000
```

---

**Last updated:** 2025-06-25  
**API version:** v1
