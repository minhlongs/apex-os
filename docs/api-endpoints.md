# ApexOS API Endpoints Directory (v1.1.0)

**Base URL:** `https://apexos.app/api` (Production) / `http://localhost:3000/api` (Local)  
**Auth:** Better Auth session cookies (`apex_session`) or Bearer tokens  
**Format:** JSON Request / JSON Response  
**Last Updated:** 2026-09-27 (Sprint 10 Final Release)

---

## 1. Public & Core Endpoints

### GET `/api/health`
System health check and uptime monitor. No authentication required.
- **Response:**
  ```json
  {
    "status": "healthy",
    "timestamp": "2026-09-27T06:00:00.000Z",
    "uptime": 86400,
    "version": "1.1.0"
  }
  ```

### GET `/api/public/deals`
Returns active crypto cashback and affiliate deals with optional filtering and pagination.
- **Query Parameters:**
  - `exchange` (optional): `binance` | `bybit` | `okx` | `kucoin`
  - `category` (optional): `spot` | `futures` | `margin` | `options`
  - `cashback_min` (optional): Minimum cashback percent (e.g. `20`)
  - `page` (optional): Default `1`
  - `limit` (optional): Default `20` (max `50`)
- **Response:**
  ```json
  {
    "success": true,
    "data": [
      {
        "id": "deal_okx_futures_01",
        "name": "OKX Futures Trading Cashback",
        "exchange": "okx",
        "category": "futures",
        "cashback_percent": 30,
        "url": "https://okx.com/...",
        "is_active": true
      }
    ],
    "pagination": { "total": 48, "page": 1, "totalPages": 3, "hasNext": true }
  }
  ```

### GET `/api/deals` & GET `/api/deals/[id]`
Public read-only listing and deal detail resolution; admin POST/PATCH/DELETE endpoints for deal CRUD operations.

---

## 2. Deal Tracking & Fraud Gating

### GET `/api/tracking/click` & GET `/api/deals/[id]/click`
Directs traffic from affiliate links to exchange signup pages while attributing referrals.

- **Query Parameters:**
  - `deal_id` (required on `/tracking/click`)
  - `ref` (optional): Affiliate referral code (e.g. `VIP888`)
  - `redirect` (optional): Custom destination URL override
- **Multi-Tier Fraud & Velocity Gates:**
  1. **IP Blocklist Check:** If IP is in `blocked_ips` (`is_active = 1`), returns **HTTP 403 Forbidden**.
  2. **Dual-Window Rate Limiting:**
     - Exceeding **100 clicks/hour** or **1,000 clicks/day** returns **HTTP 429 Too Many Requests** with `Retry-After`.
     - Exceeding **150 clicks/hour** auto-blocks the IP into `blocked_ips`.
  3. **Velocity Anomaly Detection:**
     - Rapid bursts (<2,000ms from same IP/session) flag `BURST_CLICK` (anomaly score 0.85–0.90).
     - Skewed click-to-conversion ratio (>10:1 for >= 10 clicks) flags `HIGH_CLICK_CONVERSION_RATIO` (anomaly score 0.70).
     - Flags set `is_suspicious = 1` for administrative review without dropping legitimate traffic.
- **Success Behavior:** Sets 30-day tracking cookie `apex_tracking_id` and responds with HTTP 302 Redirect to destination.

---

## 3. Multi-Exchange Webhooks

All webhooks utilize HMAC cryptographic signature verification, 5-minute timestamp validation windows (`DEFAULT_TIMESTAMP_WINDOW_MS = 300,000`), KV replay protection (24h TTL), and database idempotency constraints.

### POST `/api/webhooks/exchange`
Unified webhook router auto-detecting exchange source (Binance, Bybit, OKX, KuCoin) via request headers and payload structure.

### POST `/api/webhooks/exchange/okx`
Dedicated OKX exchange trade webhook handler.
- **Headers Required:**
  - `OK-ACCESS-KEY`: API key
  - `OK-ACCESS-SIGN`: Hexadecimal HMAC-SHA256 signature
  - `OK-ACCESS-TIMESTAMP`: ISO 8601 UTC timestamp
  - `OK-ACCESS-PASSPHRASE`: API passphrase
- **Signature Algorithm:** `HMAC-SHA256(OKX_WEBHOOK_SECRET, timestamp + method + path + body)`

### POST `/api/webhooks/exchange/kucoin`
Dedicated KuCoin exchange trade webhook handler.
- **Headers Required:**
  - `KC-API-KEY`: API key
  - `KC-API-SIGN`: Base64-encoded HMAC-SHA256 signature
  - `KC-API-TIMESTAMP`: Millisecond epoch timestamp
- **Signature Algorithm:** `Base64(HMAC-SHA256(KUCOIN_WEBHOOK_SECRET, timestamp + method + path + body))`

### POST `/api/webhooks/resend`
Ingests email lifecycle events (`email.delivered`, `email.bounced`, `email.complained`, `email.opened`) from Resend and records them in `email_events`.

---

## 4. Billing, Crypto Checkout & IPN

### POST `/api/payments`
Creates a NOWPayments hosted checkout invoice for membership tier upgrades. Requires user authentication.
- **Request Body:**
  ```json
  {
    "plan": "PREMIUM"
  }
  ```
  *Allowed plans:* `BASIC` ($9), `PREMIUM` ($29), `ENTERPRISE` ($99), `MASTER` ($299).
- **Response:**
  ```json
  {
    "success": true,
    "data": {
      "paymentId": "5001234567",
      "orderId": "apex-usr83921-premium-1774659200000",
      "invoiceUrl": "https://nowpayments.io/payment/?iid=5001234567",
      "amount": 29,
      "currency": "USD",
      "plan": "PREMIUM"
    }
  }
  ```

### GET `/api/payments/history`
Returns paginated payment transaction history for the authenticated user.
- **Query Parameters:** `page` (default 1), `limit` (default 10).
- **Response:**
  ```json
  {
    "success": true,
    "data": [
      {
        "id": "pay_98234",
        "order_id": "apex-usr83921-premium-1774659200000",
        "payment_status": "confirmed",
        "plan": "PREMIUM",
        "price_amount": 29,
        "price_currency": "USD",
        "created_at": "2026-09-27T05:20:00Z"
      }
    ],
    "pagination": { "total": 1, "page": 1, "totalPages": 1 }
  }
  ```

### GET `/api/payments/status`
Polls payment status by payment ID.
- **Query Parameter:** `payment_id` (required).

### POST `/api/webhooks/ipn`
Instant Payment Notification (IPN) callback from NOWPayments.
- **Security:** Verifies `x-nowpayments-sig` using `HMAC-SHA512` over recursively sorted JSON payload keys. Rejects invalid signatures with HTTP 401.
- **Idempotency:** Ignores duplicate callbacks if payment is already `confirmed` or `finished`.
- **Lifecycle Action:** Upgrades user tier in `profiles`, records activation in `tier_activations`, and enqueues receipt in `email_queue`.

---

## 5. Profile, Mobile & Wallet Connect

### POST `/api/profile/wallet`
Binds a non-custodial cryptocurrency wallet to the user's profile for payouts.
- **Request Body:**
  ```json
  {
    "walletAddress": "0x71C...39724",
    "preferredChain": "ethereum"
  }
  ```
  *Chains supported:* `ethereum` (EIP-55 checksum hex), `solana` (Base58 32-44 chars), `stellar` (StrKey 56 chars).

### POST `/api/notifications/register`
Registers native mobile push tokens (APNs, FCM, Expo) tied to the authenticated user.
- **Request Body:**
  ```json
  {
    "token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
    "platform": "ios",
    "deviceType": "expo"
  }
  ```

### POST `/api/profile/deep-link-analytics`
Ingests batched mobile deep-link routing events from the mobile client (`apex-os://`).
- **Request Body:**
  ```json
  {
    "events": [
      {
        "kind": "billing-result",
        "route": "apex-os://billing/result?status=confirmed&txnId=500123",
        "timestamp": "2026-09-27T06:30:00Z",
        "source": "direct"
      }
    ]
  }
  ```

---

## 6. Advanced Analytics Engine

Admin-only endpoints providing aggregated metrics backed by Cloudflare D1 materialized views and Cloudflare KV caching (5-minute TTL, `X-Cache: HIT|MISS`).

### GET `/api/analytics/deals`
Returns aggregated deal performance (clicks, conversions, gross trading volume, commission earned, conversion rate).
- **Query Parameters:** `date_from`, `date_to`, `exchange`, `deal_id`, `category`, `page`, `limit`.

### GET `/api/analytics/affiliates`
Aggregated affiliate metrics across direct referrals and downlines.
- **Query Parameters:** `date_from`, `date_to`, `tier` (`1` | `2` | `3`), `affiliate_id`.

### GET `/api/analytics/exchanges`
Breakdown of volume, conversion rates, and revenue across Binance, Bybit, OKX, and KuCoin.

### GET `/api/analytics/funnel`
Full lifecycle conversion funnel metrics: `visits` -> `clicks` -> `signups` -> `activations` -> `conversions`.

### POST `/api/analytics/web-vitals`
Ingests client-side Core Web Vitals (LCP, FID, CLS, TTFB, INP).

---

## 7. Administrative Fraud Review

Admin-only endpoints (`role === 'admin'`) for monitoring and acting on suspicious traffic.

### GET `/api/admin/fraud/clicks`
Returns paginated list of clicks flagged with `is_suspicious = 1`.
- **Query Parameters:** `date_from`, `date_to`, `reason` (`BURST_CLICK`, `HIGH_CLICK_CONVERSION_RATIO`), `affiliate_id`, `min_score`, `page`, `limit`.

### GET `/api/admin/fraud/stats`
Returns summary statistics: total clicks, flagged clicks, active blocked IPs, anomaly score distributions.

### GET `/api/admin/fraud/blocked-ips`
Returns list of currently blocked IP addresses, reason codes, blocking admin, and expiration timestamps.

### POST `/api/admin/fraud/actions`
Submits single or bulk administrative decisions. Writes immutable audit entries to `fraud_reviews`.
- **Request Body:**
  ```json
  {
    "action": "approve" | "reject" | "block_ip" | "unblock_ip" | "bulk_resolve",
    "clickId": "click_12345",
    "reason": "Verified legitimate organic trader through Discord ticket #402",
    "notes": "Reviewed transaction history on OKX explorer"
  }
  ```

---

## 8. Affiliate Dashboard & Team Endpoints

Authenticated partner endpoints.

### GET `/api/affiliate/dashboard`
Returns personal affiliate statistics: lifetime clicks, confirmed conversions, total earnings, pending payouts, and referral code.

### GET `/api/affiliate/conversions`
Paginated ledger of conversions credited to the user with exchange attribution.

### GET `/api/affiliate/team`
Returns the 3-level referral tree downline with node counts and aggregated team commission volume.

### GET `/api/affiliate/payouts`
Lists historical Stellar USDC payouts with transaction hashes.

---

## 9. Cron Workers & Background Automation

Protected by `Authorization: Bearer ${CRON_SECRET}`.

### POST `/api/cron/process-email-queue`
Dequeues pending transactional emails in batches of 50, dispatches via Resend, tracks delivery states, and executes automatic retries (<3 attempts).

### POST `/api/cron/refresh-analytics`
Refreshes analytical aggregation statistics and triggers `ANALYZE sqlite_stat1` on Cloudflare D1.

### POST `/api/cron`
Weekly routine: compiles pending affiliate commissions into Stellar USDC payout batches and enqueues weekly digest emails.

---

## 10. Monitoring & Alert Engine

### GET `/api/monitoring/alert-engine`
Returns real-time status of alerting thresholds, circuit breaker state, and active incidents.

### GET `/api/monitoring/d1`
Database latency health monitor, query latency percentiles (p50, p95, p99), and connection pool metrics.

### GET `/api/monitoring/evaluation`
Detailed evaluation metrics for alert rules and automated triggers.

---

## 11. Error Response Standards

All API responses follow consistent JSON error envelopes:

```json
{
  "success": false,
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Click rate limit exceeded (100 clicks/hour). Please retry later.",
  "retryAfter": 1800
}
```

### Common Error Status Codes

| Status Code | Code String | Description |
|---|---|---|
| **400 Bad Request** | `VALIDATION_ERROR` | Malformed request body or invalid parameters |
| **401 Unauthorized** | `UNAUTHORIZED` | Missing or invalid authentication session or HMAC signature |
| **403 Forbidden** | `IP_BLOCKED` / `FORBIDDEN` | Blocked IP address or insufficient role permissions |
| **404 Not Found** | `NOT_FOUND` | Resource or deal not found |
| **429 Too Many Requests** | `RATE_LIMIT_EXCEEDED` | Exceeded hourly (100) or daily (1,000) click threshold |
| **500 Internal Error** | `INTERNAL_ERROR` | Server execution exception |
