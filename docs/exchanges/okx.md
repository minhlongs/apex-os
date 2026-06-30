# OKX Integration — Sprint 1

## Overview

OKX webhook integration for ApexOS affiliate cashback system.
Handles trade notifications from OKX exchange with HMAC signature verification.

**Endpoint:** `POST /api/webhooks/exchange/okx`

## Setup

### 1. OKX Partner Dashboard

1. Log in to [OKX Partner Portal](https://www.okx.com/partners)
2. Navigate to **Webhook Settings**
3. Create a new webhook endpoint:
   - URL: `https://your-domain.com/api/webhooks/exchange/okx`
   - Events: `order_update`, `trade_settlement`
4. Copy the **Webhook Secret** (HMAC-SHA256)

### 2. Environment Variables

Add to `.env.local`:

```bash
OKX_WEBHOOK_SECRET=<your-webhook-secret-from-okx-partner-portal>
```

### 3. Database

Run migration to add OKX-specific fields:

```bash
wrangler d1 execute apex-os-db --file src/database/migrations/003_affiliate_schema.sql
```

The `deals` table already supports `exchange = 'okx'`.

## Webhook Payload

OKX sends `order_update` events with this structure:

```json
{
  "id": "evt_123456",
  "event": "order_update",
  "timestamp": "2026-06-29T10:00:00.000Z",
  "data": {
    "orderId": "ord_abc123",
    "clientOrderId": "client_xyz",
    "symbol": "BTC-USDT",
    "side": "buy",
    "type": "market",
    "status": "filled",
    "filledQty": "0.001",
    "avgPrice": "60000.00",
    "quoteQty": "60.00",
    "fee": "0.04",
    "feeAsset": "USDT",
    "updateTime": 1688010000000,
    "userId": "user_okx_123"
  }
}
```

## Signature Verification

OKX signs webhooks using HMAC-SHA256:

```
Signature = HMAC-SHA256(timestamp + body, secret)
```

The endpoint verifies:
1. `X-OKX-TIMESTAMP` header is within 5 minutes
2. `X-OKX-SIGNATURE` matches computed HMAC

## Flow

```
OKX Trade → Webhook → Signature Verify → Match Click → Calculate Commission → Record Conversion
```

1. **Receive** — POST request from OKX
2. **Verify** — HMAC signature check
3. **Match** — Find `deal_clicks` by wallet/email within 30-day window
4. **Resolve** — Traverse referral tree (3 levels)
5. **Calculate** — Tier1: 30%, Tier2: 10%, Tier3: 5%
6. **Record** — Insert into `conversions` + `earnings` tables

## Commission Tiers

| Level | Rate | Description |
|-------|------|-------------|
| Tier 1 | 30% | Direct referrer |
| Tier 2 | 10% | Referrer's referrer |
| Tier 3 | 5% | Third level |

## Testing

### Local Testing

```bash
# Start dev server
pnpm dev

# Send test webhook (from another terminal)
curl -X POST http://localhost:3000/api/webhooks/exchange/okx \
  -H "Content-Type: application/json" \
  -H "X-OKX-TIMESTAMP: $(date +%s)000" \
  -H "X-OKX-SIGNATURE: <computed-hmac>" \
  -d '{"event":"order_update","data":{...}}'
```

### Mock Webhook Script

```bash
tsx scripts/send-mock-webhook.ts --exchange okx --volume 1000
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Signature mismatch | Verify `OKX_WEBHOOK_SECRET` matches OKX portal |
| No click matched | User must click deal link before trading (30-day window) |
| Duplicate conversion | OKX `orderId` is deduplicated in `conversions` table |

## Related

- [KuCoin Integration](./kucoin.md)
- [Webhook Handler](../api/webhooks/exchange/route.ts)
- [Tracking Matcher](../../src/lib/tracking/matcher.ts)
