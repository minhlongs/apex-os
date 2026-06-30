---
title: "Sprint 2: KuCoin Exchange Integration"
description: "Integrate KuCoin webhook processing with unique signature verification"
status: pending
priority: P0
effort: 30h
branch: main
tags: [apex-os, q3-2026, kucoin, exchange, webhook]
created: 2026-06-22
depends:
  - "sprint-01-okx-integration"
---

# Sprint 2: KuCoin Exchange Integration

**Goal:** Add KuCoin as a supported exchange with full webhook processing

**Timeline:** Week 3-4 of Q3 (July 15-28, 2026)
**Capacity:** 30 hours

---

## Phase Overview

| Phase | Task | Priority | Effort | Status |
|-------|------|----------|--------|--------|
| 1 | KuCoin API Research & Documentation | P0 | 4h | pending |
| 2 | Webhook Handler Implementation | P0 | 12h | pending |
| 3 | Database & UI Updates | P0 | 8h | pending |
| 4 | Testing & Verification | P0 | 6h | pending |

---

## Phase 1: KuCoin API Research (4h)

### Tasks

1. **Webhook Signature Format** (2h)
   - KuCoin uses different HMAC scheme: `KC-API-KEY`, `KC-API-SIGN`, `KC-API-TIMESTAMP`, `KC-API-PASSPHRASE`
   - Sign string: `timestamp + method + requestPath + body` (where body is the webhook JSON)
   - Signature = base64(HMAC-SHA256(secret, sign_string))
   - Timestamp in milliseconds (unix epoch)
   - Passphrase is user-defined API passphrase, also signed
   - Document algorithm in `docs/exchanges/kucoin.md`

2. **Trade Webhook Payload** (2h)
   - KuCoin requires webhook subscription via REST API call
   - Webhook endpoint: user-configurable (we provide URL)
   - Payload structure:
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
   - Trade volume = `size × price` (or `funds` - `fee`)
   - `symbol` format may be `BTC-USDT` (spot) or `XBTUSDM` (futures) → need mapping

3. **API Rate Limits** (Research)
   - KuCoin: 10 requests/second per API key
   - Webhook retries: 3 attempts with exponential backoff
   - Plan: webhook endpoint must respond <5s

**Acceptance Criteria:**
- [ ] Signature verification algorithm documented (different from OKX/Binance)
- [ ] Payload structure understood
- [ ] Symbol mapping strategy defined (spot vs futures)
- [ ] KuCoin API credentials obtained for testing

---

## Phase 2: Webhook Handler Implementation (12h)

### Tasks

1. **Create KuCoin Webhook Route** (4h)
   - `src/app/api/webhooks/exchange/kucoin/route.ts`
   - POST handler
   - Extract headers: `KC-API-KEY`, `KC-API-SIGN`, `KC-API-TIMESTAMP`, `KC-API-PASSPHRASE`
   - Verify signature using `KUCOIN_WEBHOOK_SECRET` (admin-provided)
   - Timestamp validation: must be within 5 minutes
   - Reject with 401 if verification fails

2. **Parse Trade Payload** (4h)
   - Extract from `event.data`:
     - `symbol` → map to exchange type (BTC-USDT → crypto)
     - `size` and `price` → calculate `trade_volume_usd`
     - `orderId` → `exchange_trade_id`
   - **User matching challenge:** KuCoin also does NOT include user email
   - Solution: Same as OKX → require users to link KuCoin API key
     - Store `kucoin_api_key_id` in `profiles.external_ids` JSON
     - Match webhook's `KC-API-KEY` header to stored API key → user profile
   - Edge: partial fills → use `size` * `price` for actual volume

3. **Integrate with Matching Engine** (4h)
   - Call `matchConversion()` from `src/lib/tracking/matcher.ts`
   - Input: `{ userId, tradeVolume, exchange: 'kucoin', tradeId: orderId, symbol }`
   - Handle already-processed trades (idempotency check on `exchange_trade_id`)
   - Log to `webhook_logs` for audit trail

**Acceptance Criteria:**
- [ ] KuCoin webhook endpoint accepts POST requests
- [ ] Signature verification passes with test payload
- [ ] Trade volume calculated correctly (handling both spot/futures)
- [ ] Conversion record created with `exchange = 'kucoin'`
- [ ] Idempotency: duplicate webhook does not create duplicate earnings

---

## Phase 3: Database & UI Updates (8h)

### Tasks

1. **Exchange Enum Extension** (2h)
   - Confirm `Exchange` type in `src/types/deal.ts` includes 'kucoin'
   - Migration `005_add_okx_exchange.sql` already includes kucoin → reuse
   - Update `conversions.exchange` enum to include kucoin

2. **Admin UI: KuCoin in Deal Form** (2h)
   - Add "KuCoin" select option in deal creation form
   - KuCoin-specific fields if needed: `futures_only` (boolean)
   - Validation: if `margin_type=futures`, show warning about higher risk but higher cashback?

3. **Public Deals Listing** (2h)
   - Add KuCoin filter option
   - Add KuCoin logo asset (`public/logos/kucoin.svg`)
   - Deal cards show KuCoin badge
   - i18n: add `"kucoin": "KuCoin"` to translations

4. **API Routes** (2h)
   - All exchange-aware endpoints accept `exchange=kucoin`
   - Test: `GET /api/deals?exchange=kucoin` returns correct results

**Acceptance Criteria:**
- [ ] Admin can create KuCoin deals
- [ ] KuCoin deals appear in public listing with correct logo
- [ ] Filter by KuCoin works
- [ ] API returns KuCoin-specific deals correctly

---

## Phase 4: Testing & Verification (6h)

### Tasks

1. **KuCoin Mock Webhook Script** (3h)
   - `scripts/send-mock-webhook-kucoin.ts`
   - Generate valid KuCoin signature
   - Sample payload: BTC-USDT spot trade, 0.01 BTC at $50,000
   - CLI args: `--symbol BTC-USDT --size 0.01 --price 50000`
   - Include `KC-API-KEY` header matching test user's stored API key

2. **Unit Tests** (2h)
   - `src/__tests__/webhooks/kucoin-verification.test.ts`
   - `src/__tests__/matcher/kucoin-matching.test.ts`
   - Test signature verification (accept valid, reject invalid)
   - Test timestamp validation (reject >5min old)
   - Test symbol mapping (spot vs futures)

3. **E2E Flow Test** (1h)
   - Same flow as OKX but with KuCoin-specific data
   - Create user with `kucoin_api_key_id` in profile
   - Create KuCoin deal (10% cashback)
   - Click → cookie set → webhook sent
   - Verify: conversion created, affiliate earnings calculated

**Acceptance Criteria:**
- [ ] Mock webhook script executes successfully
- [ ] Unit tests pass (coverage >80%)
- [ ] E2E test passes
- [ ] Signature verification rejects tampered/expired payloads

---

## Environment Variables

```bash
KUCOIN_WEBHOOK_SECRET=your-kucoin-webhook-secret
```

Note: Individual user API keys stored in `profiles.external_ids` JSON column:
```json
{
  "kucoin": {"api_key_id": "kucoin_key_123", "verified": true},
  "okx": {"api_key_id": "okx_key_456", "verified": false}
}
```

---

## Files to Modify/Create

**New Files:**
- `src/app/api/webhooks/exchange/kucoin/route.ts`
- `scripts/send-mock-webhook-kucoin.ts`
- `docs/exchanges/kucoin.md`
- `src/__tests__/webhooks/kucoin-verification.test.ts`
- `src/__tests__/matcher/kucoin-matching.test.ts`

**Modified Files:**
- `src/types/deal.ts` (confirm 'kucoin' in Exchange type)
- `src/components/deals/DealForm.tsx` (add KuCoin option)
- `src/app/[locale]/deals/page.tsx` (KuCoin filter)
- `src/i18n/messages/vi.json` (add "kucoin")
- `src/i18n/messages/en.json` (add "kucoin")
- `CLAUDE.md` (update exchange setup)

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| KuCoin API key linking UX friction | High | Medium | Clear tutorial modal. Link API key during signup flow. OAuth-style consent screen |
| Webhook endpoint blocked by KuCoin (whitelist required) | Medium | High | Contact KuCoin partner support for webhook whitelist. Provide IP ranges (Cloudflare Pages) |
| Signature algorithm variations | Low | Medium | Test with multiple payload samples. Implement debug logging |
| Futures vs Spot volume calculation differs | Medium | Low | Normalize both to USD. Document edge cases in matcher |

---

## Integration Notes (After OKX)

This sprint is nearly identical to OKX implementation. Duplicate code patterns should be abstracted:

**Shared Utilities (create after both complete):**
- `src/lib/webhooks/verifier.ts`: unified signature verification
  - `verifyWebhook(exchange, payload, headers, secret)` → boolean
- `src/lib/webhooks/parsers/`: exchange-specific parsers
  - `parseOkxPayload(payload): TradeData`
  - `parseKuCoinPayload(payload): TradeData`
  - Common interface: `{ exchange, tradeId, volume, userId, symbol }`

---

## Post-Sprint Actions

1. Update staging with `KUCOIN_WEBHOOK_SECRET`
2. Test with real KuCoin webhooks (sandbox environment)
3. Document API key linking flow in user guide
4. Review and refactor shared webhook code
5. Plan Q3 Epic 2 (Advanced Analytics) sprint

---

**Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT

Summary: Complete KuCoin integration parallel to OKX

Concerns/Blockers:
