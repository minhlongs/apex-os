# KuCoin Integration — Sprint 2

## Overview

KuCoin webhook integration for ApexOS affiliate cashback system.
Handles trade notifications from KuCoin exchange with HMAC signature verification.

**Endpoint:** `POST /api/webhooks/exchange/kucoin`

## Setup

### 1. KuCoin Partner / API Dashboard

1. Log in to [KuCoin Open Platform](https://www.kucoin.com/open-platform)
2. Create or open an API key with **Trade Read** permissions
3. Note the **API Key**, **API Secret**, and **API Passphrase**
4. Configure webhook notification:
   - Webhook URL: `https://your-domain.com/api/webhooks/exchange/kucoin`
   - Events: `order/trade`

### 2. Environment Variables

Add to `.env.local`:

```bash
KUCOIN_WEBHOOK_SECRET=<your-kucoin-api-secret>
```

## Webhook Payload

KuCoin sends `order/trade` events via the Open Platform notification API.

```json
{
  "topic": "order/trade",
  "ts": 1625098320000,
  "data": {
    "orderId": "123456",
    "symbol": "BTC-USDT",
    "side": "buy",
    "price": "50000",
    "size": "0.01",
    "funds": "500",
    "fee": "0.5",
    "status": "filled"
  }
}
```

## Signature Verification

KuCoin signs webhooks using HMAC-SHA256 with the **API Secret**:

```
sign_string = timestamp + "POST" + "/api/webhooks/exchange/kucoin" + request_body
signature   = base64(HMAC-SHA256(secret, sign_string))
```

Required headers:

| Header | Description |
|--------|-------------|
| `KC-API-KEY` | API key identifier |
| `KC-API-SIGN` | Base64 HMAC-SHA256 signature |
| `KC-API-TIMESTAMP` | Timestamp in milliseconds |

**Verification rules:**

1. `KC-API-TIMESTAMP` must be within 5 minutes of server time.
2. `KC-API-SIGN` must match the computed HMAC.

KuCoin's signature is **base64-encoded** (not hex). This is the key difference versus most other exchange integrations in this project.

## User Matching

KuCoin webhooks do **not** include a user email directly.
ApexOS matches the trade to a profile by the `KC-API-KEY` header:

1. Read `KC-API-KEY` from the webhook headers.
2. Look up `profiles.external_ids` for a stored `kucoin.api_key_id`.
3. Resolve the user profile to the matched `affiliate_id`.

This is why operators must instruct customers to **save their KuCoin API key in their profile** before any trades can be attributed.

## Flow

```
KuCoin Trade → Webhook → Signature Verify → Match API Key → Find Click → Calculate Commission → Record Conversion
```

1. **Receive** — POST request from KuCoin Open Platform
2. **Verify** — HMAC signature check (base64 result)
3. **Match** — Find profile by `KC-API-KEY` header → `external_ids.kucoin.api_key_id`
4. **Click** — Find `deal_clicks` by `affiliate_id` within 30-day window
5. **Resolve** — Traverse referral tree (3 levels)
6. **Calculate** — Tier 1: 30%, Tier 2: 10%, Tier 3: 5%
7. **Record** — Insert into `conversions` + `earnings` tables

## Commission Tiers

| Level | Rate | Description |
|-------|------|-------------|
| Tier 1 | 30% | Direct referrer |
| Tier 2 | 10% | Referrer's referrer |
| Tier 3 | 5% | Third level |

## Mock Webhook Script

```bash
tsx scripts/send-mock-webhook-kucoin.ts --volume 1000 --symbol BTC-USDT
```

Replay protection test:

```bash
tsx scripts/send-mock-webhook-kucoin.ts --volume 1000 --duplicate --delay 2000
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Signature mismatch | Verify `KUCOIN_WEBHOOK_SECRET` matches KuCoin Open Platform API Secret |
| User not found | Customer must link their KuCoin API key in profile settings |
| Duplicate conversion | KuCoin `orderId` is deduplicated in `conversions` table |

## Related

- [OKX Integration](./okx.md)
- [Webhook Handler](../api/webhooks/exchange/kucoin/route.ts)
- [Tracking Matcher](../../src/lib/tracking/matcher.ts)
- [Signature Verification](../../src/lib/webhooks/crypto.ts)
