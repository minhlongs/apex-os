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

## 10B. Audited Proof-of-Rebate, Timelock, Passkey & Settlement Routes (v1.5.0 / Viability Audit)

### GET `/r/[code]`
Clean-room short-link redirector (`/r/[code]` — Phong bì Chuyển hướng Ngắn Sạch) backed by KV (5m TTL) + D1 `short_links`, IP blocklist & dual-window rate limiting, partner domain HTTPS allowlist, and SHA-256 IP/UA anonymization.

### GET `/api/b2b/proof-of-rebate`
Authenticated (`Better Auth` session or `x-b2b-api-key`) PII-redacted cryptographic rebate proof lookup (`?batchId=...` or `?affiliateId=...&limit=25`) returning masked trader UID (`***1234`), `10^-8` USD Safe-Spread Waterfall split, R2 `payload_sha256`, `CASH_COLLECTED` reconciliation status, and `settled_tx_hash`.

### GET / POST / PATCH / DELETE `/api/profile/wallet/timelock`
Owner-scoped 48-hour payout wallet-change timelock (`stellar` | `arbitrum` | `base`), blocking shared payout wallets (`409`) and sanctioned addresses (`403`), with instant owner emergency cancellation.

### GET / POST `/api/admin/passkey`
FIDO2 / WebAuthn Passkey registration and single-use 5-minute challenge verification issuing short-lived `x-passkey-stepup-token` assertions for privileged admin mutations.

### POST `/api/admin/reconciliation/ingest` & POST `/api/admin/settlement/dispatch`
Admin + WebAuthn Passkey step-up protected pipelines for official partner ingestion (`Bybit v5`, `OKX v5`, `Bitget v2`; `Binance Standard Referral Pro` returns `403 BINANCE_REFERRAL_PRO_UID_UNAVAILABLE`), `CASH_COLLECTED` R2 reconciliation, and Turnkey HSM (`<=$250/tx`, `<=$1,500/24h`) + `BROADCAST_PENDING` recovery settlement.

**Xác nhận chi trả Safe / Safe payout confirmation**

- **VI:** Gửi `action: "resolve_cold_safe"`, `payoutId`, `coldResolution: "CONFIRMED"` và `txHash`. Nếu có nhiều khoản chuyển khớp trong cùng giao dịch, phải thêm `operationId`: chuỗi số thập phân của chỉ số log EVM hoặc ID operation Stellar, không phải số JSON.
  **EN:** Send `action: "resolve_cold_safe"`, `payoutId`, `coldResolution: "CONFIRMED"`, and `txHash`. Multiple matching transfers in one transaction require `operationId`: the EVM log index or Stellar operation ID as a decimal string, not a JSON number.
- **VI:** Chỉ xác nhận sau khi đối chiếu chứng cứ đã chốt trên đúng mạng, tài sản USDC, ví nguồn Safe, người nhận và số đơn vị token; giữ chứng cứ cho riêng khoản chi trả trước khi ghi sổ. Cần migration `033_cold_settlement_claims.sql`. Một operation không được dùng cho hai khoản chi trả.
  **EN:** Confirmation requires finalized evidence matching the network, USDC asset, Safe source, recipient, and exact token units. Evidence is reserved for the payout before ledger posting. Migration `033_cold_settlement_claims.sql` is required; one operation cannot settle two payouts.
- **VI:** Nếu ghi sổ bị khóa hoặc lỗi, chứng cứ đã giữ không được giải phóng. Gửi lại cùng thông tin; tác vụ đối soát cũng có thể tiếp tục chứng cứ đã lưu mà không ký hay gửi giao dịch mới. Chỉ trả thành công sau khi kiểm tra ghi sổ. `coldResolution: "CANCELLED"` bị từ chối và tiền vẫn khóa vì chưa có chứng cứ đề xuất Safe không thực thi.
  **EN:** A ledger freeze or write failure does not release reserved evidence. Retry the same payment details; reconciliation can also resume the stored claim without signing or broadcasting. Success is returned only after ledger verification. `coldResolution: "CANCELLED"` is rejected and funds remain locked because Safe proposal nonexecution has not been proven.
- **VI:** Stellar mainnet chỉ chấp nhận issuer USDC Circle chuẩn. Testnet cần `STELLAR_USDC_ISSUER` được cấu hình từ nguồn tin cậy với địa chỉ hợp lệ; không dùng issuer mainnet làm mặc định. Checksum hợp lệ không chứng minh token do Circle phát hành.
  **EN:** Stellar mainnet accepts only the canonical Circle USDC issuer. Testnet requires a trusted, explicitly configured valid `STELLAR_USDC_ISSUER`, with no mainnet issuer fallback. A valid checksum does not establish Circle issuance.

### POST `/api/kyc/initiate` (Disabled — `410 Gone`)
Returns `410 KYC_DOCUMENT_COLLECTION_DISABLED` under Vietnam Personal Data Protection Law `91/2025/QH15` data-minimization rules; compliance relies on edge Geo-Fencing (`451`), OFAC sanctions, and Circle `isBlacklisted` checks.

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
