# ApexOS Billing, NOWPayments Crypto Checkout & Wallet Connect

ApexOS features a non-custodial cryptocurrency billing engine integrated with NOWPayments, enabling users to upgrade membership tiers (BASIC, PREMIUM, ENTERPRISE, MASTER), bind multi-chain crypto wallets, and receive native push notifications.

---

## 1. System Architecture

```
User (Web / Mobile)
        │
        ▼
[ POST /api/payments ] ────────────────► NOWPayments API (/v1/invoice)
        │ (Creates pending payment)                │
        │                                         ▼
        │                              Crypto Payment Gateway
        │                              (BTC, ETH, USDT, SOL, etc.)
        │                                         │
        ▼                                         ▼
[ POST /api/webhooks/ipn ] ◄──────────── Instant Payment Notification (IPN)
        │
        ├── 1. HMAC-SHA512 Signature Check (x-nowpayments-sig)
        ├── 2. Idempotency Check (payments table)
        ├── 3. Tier Upgrade (profiles.tier = new_tier)
        ├── 4. Audit Log (tier_activations ledger)
        └── 5. Enqueue Receipt (email_queue)
```

---

## 2. Membership Tiers & Pricing

| Tier Name | Price (USD) | Code | Platform Privileges |
|---|---|---|---|
| **BASIC** | $9.00 | `BASIC` | Standard cashback rates, 3-tier downline referral tracking |
| **PREMIUM** | $29.00 | `PREMIUM` | +15% cashback boost, priority email queue, advanced analytics access |
| **ENTERPRISE** | $99.00 | `ENTERPRISE` | +30% cashback boost, custom deal integrations, dedicated API keys |
| **MASTER** | $299.00 | `MASTER` | Maximum cashback ceiling (50%), downline override bonuses, VIP support |

---

## 3. Payment Creation (`POST /api/payments`)

Authenticated endpoint requiring a valid Better Auth session cookie or bearer token.

### Request Payload
```json
{
  "plan": "PREMIUM"
}
```

### Execution Flow
1. Validates that `plan` is one of `['BASIC', 'PREMIUM', 'ENTERPRISE', 'MASTER']`.
2. Generates deterministic `order_id`: `apex-${userId.slice(0, 8)}-${plan.toLowerCase()}-${Date.now()}`.
3. Constructs callback URL dynamically: `https://<domain>/api/webhooks/ipn`.
4. Creates an invoice via NOWPayments API (`https://api.nowpayments.io/v1/invoice`).
5. Persists pending transaction in Cloudflare D1 `payments` table.
6. Returns hosted checkout URL to client.

### Success Response (HTTP 200)
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

---

## 4. NOWPayments IPN Webhook (`POST /api/webhooks/ipn`)

NOWPayments dispatches Instant Payment Notifications whenever transaction status changes (`waiting`, `confirming`, `confirmed`, `finished`, `failed`, `expired`).

### A. Cryptographic HMAC-SHA512 Signature Verification
Security is enforced in `src/app/api/webhooks/ipn/route.ts`:
1. **Header Inspection:** Reads `x-nowpayments-sig` from incoming request.
2. **Canonical Key Sorting:** NOWPayments requires that JSON payload keys are sorted alphabetically recursively before calculating HMAC:
   ```typescript
   export function sortObjectKeys(obj: unknown): unknown {
     if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
     const record = obj as Record<string, unknown>;
     return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
       acc[key] = sortObjectKeys(record[key]);
       return acc;
     }, {});
   }
   ```
3. **HMAC Calculation:** Computes `HMAC-SHA512(NOWPAYMENTS_IPN_SECRET, JSON.stringify(sortedPayload))`.
4. **Timing-Safe Comparison:** Uses `crypto.timingSafeEqual` to avoid timing side-channel attacks. Rejects mismatches with **HTTP 401 Unauthorized**.

### B. Idempotent Processing & Tier Activation
- If the payment was already marked `confirmed` or `finished` in `payments`, the handler returns HTTP 200 immediately without duplicate processing.
- When `payment_status === 'confirmed'` or `payment_status === 'finished'`:
  1. Updates `payments` row (`payment_status = 'confirmed'`).
  2. Updates `profiles` table: sets `tier = newTier`.
  3. Records audit log in `tier_activations`:
     ```sql
     INSERT INTO tier_activations (id, user_id, payment_id, previous_tier, new_tier, activated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, DATETIME('now'), DATETIME('now', '+30 days'));
     ```
  4. Enqueues confirmation email receipt into `email_queue`.

---

## 5. Wallet Profile Association (`POST /api/profile/wallet`)

Allows authenticated users to bind their non-custodial Web3 payout address with strict validation.

### Request Payload
```json
{
  "walletAddress": "0x71C...39724",
  "preferredChain": "ethereum"
}
```

### Supported Blockchains & Validation Rules

| Chain | Identifier | Validation Standard |
|---|---|---|
| **Ethereum / EVM** | `ethereum` | Hexadecimal format `^0x[0-9a-fA-F]{40}$` with EIP-55 checksum validation |
| **Solana** | `solana` | Base58 encoded public key, length 32 to 44 characters |
| **Stellar** | `stellar` | StrKey public key: Starts with `'G'`, length exactly 56 alphanumeric characters |

---

## 6. Mobile Device Token Registration & Deep-Link Analytics

### Device Token Registration (`POST /api/notifications/register`)
Enables mobile push alerts across iOS and Android clients:
```json
{
  "token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "platform": "ios",
  "deviceType": "expo"
}
```
- Supports `expo`, `apns` (Apple Push Notification service), and `fcm` (Firebase Cloud Messaging).
- Persists tokens in `device_tokens` linked to `user_id`.

### Deep-Link Analytics Ingestion (`POST /api/profile/deep-link-analytics`)
Ingests batched events triggered by mobile URL schemes (`apex-os://`):
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
- Stored in `deep_link_analytics` for attribution modeling.

---

## 7. Database Schema Reference

Defined in `012_billing_payments.sql`:

```sql
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  order_id TEXT UNIQUE NOT NULL,
  payment_id TEXT UNIQUE,
  pay_address TEXT,
  price_amount REAL NOT NULL,
  price_currency TEXT NOT NULL DEFAULT 'USD',
  pay_amount REAL,
  pay_currency TEXT,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  plan TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  updated_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);

CREATE TABLE IF NOT EXISTS tier_activations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  previous_tier TEXT NOT NULL DEFAULT 'BASIC',
  new_tier TEXT NOT NULL,
  activated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);
```

---

## 8. Automated Test Verification

Billing and payment integrations are validated by 19 automated test suites in `src/__tests__/billing/`:

```bash
npm test src/__tests__/billing/
# Validates:
# - Payment checkout URL generation & plan tier limits
# - HMAC-SHA512 signature validation & canonical key sorting
# - Idempotent callback deduplication
# - Database tier activations and profile upgrades
# - EVM, Solana, and Stellar wallet address validation
# - Mobile device push registration & deep-link analytics ingestion
```
