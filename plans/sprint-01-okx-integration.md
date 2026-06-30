---
title: "Sprint 1: OKX Exchange Integration"
description: "Integrate OKX webhook processing for trade verification and commission calculation"
status: pending
priority: P0
effort: 30h
branch: main
tags: [apex-os, q3-2026, okx, exchange, webhook]
created: 2026-06-22
depends:
  - "Implementation complete (Phase 1-6 from main implementation)"
---

# Sprint 1: OKX Exchange Integration

**Goal:** Add OKX as a supported exchange with full webhook processing, matching, and commission calculation

**Timeline:** Week 1-2 of Q3 (July 1-14, 2026)
**Capacity:** 30 hours

---

## Phase Overview

| Phase | Task | Priority | Effort | Status |
|-------|------|----------|--------|--------|
| 1 | OKX API Research & Documentation | P0 | 4h | pending |
| 2 | Webhook Handler Implementation | P0 | 12h | pending |
| 3 | Database & UI Updates | P0 | 8h | pending |
| 4 | Testing & Verification | P0 | 6h | pending |

---

## Phase 1: OKX API Research (4h)

### Tasks

1. **Webhook Signature Format** (2h)
   - OKX uses HMAC-SHA256 with timestamp header
   - Required headers: `OK-ACCESS-KEY`, `OK-ACCESS-SIGN`, `OK-ACCESS-TIMESTAMP`, `OK-ACCESS-PASSPHRASE`
   - Timestamp must be within 5 minutes of server time
   - Signature = HMAC-SHA256(secret_key, timestamp + method + requestPath + body)
   - Document algorithm in `docs/exchanges/okx.md`

2. **Trade Webhook Payload** (2h)
   - Endpoint: `POST /api/webhooks/exchange/okx` (we host)
   - OKX sends order update events (not push webhooks by default)
   - Need to poll OKX API OR configure OKX to send webhooks (preferred)
   - Payload structure:
     ```json
     {
       "instId": "BTC-USDT",
       "ordId": "123456",
       "sz": "0.01",
       "px": "50000",
       "fee": "0.5",
       "side": "buy",
       "tradeId": "789"
     }
     ```
   - Trade volume = sz × px (in USDT)

3. **API Rate Limits** (Research)
   - OKX REST API: 20 requests/2 seconds per IP
   - Webhook endpoint must respond within 5 seconds
   - Plan retry logic for failed webhooks

**Acceptance Criteria:**
- [ ] Signature verification algorithm documented
- [ ] Payload structure understood
- [ ] Rate limit strategy defined
- [ ] OKX API credentials obtained for testing (testnet)

---

## Phase 2: Webhook Handler Implementation (12h)

### Tasks

1. **Create OKX Webhook Route** (4h)
   - `src/app/api/webhooks/exchange/okx/route.ts`
   - POST handler only
   - Extract headers: `OK-ACCESS-KEY`, `OK-ACCESS-SIGN`, `OK-ACCESS-TIMESTAMP`, `OK-ACCESS-PASSPHRASE`
   - Verify signature using `BETTER_AUTH_SECRET` or dedicated `OKX_WEBHOOK_SECRET`
   - Reject with 401 if signature invalid

2. **Parse Trade Payload** (4h)
   - Extract: `instId` (trading pair), `sz` (size), `px` (price), `tradeId`
   - Calculate `trade_volume_usd = parseFloat(sz) * parseFloat(px)`
   - Identify user: OKX may send `ccy` (currency) but not email directly
   - **Challenge:** OKX does NOT send user email in webhook → need alternative matching
   - Strategy: Require users to link OKX API key in profile (OAuth-style)
     - Store `okx_api_key_id` in `profiles.external_ids` JSON
     - Match webhook `ccy` to stored API key → user profile
   - **Fallback:** Manual attribution via admin UI if auto-match fails

3. **Integrate with Matching Engine** (4h)
   - Call `matchConversion()` from `src/lib/tracking/matcher.ts`
   - Input: `{ userId, tradeVolume, exchange: 'okx', tradeId }`
   - Returns: `Conversion` record + `Earning[]` allocations
   - Handle no-match case (no click within 30d, no referral code)
   - Log webhook processing to `webhook_logs` table (for debugging)

**Acceptance Criteria:**
- [ ] OKX webhook endpoint accepts POST requests
- [ ] Signature verification passes with test payload
- [ ] Trade volume calculated correctly
- [ ] Conversion record created in database
- [ ] Earnings allocated to correct users (via API key linking)

---

## Phase 3: Database & UI Updates (8h)

### Tasks

1. **Exchange Enum** (2h)
   - Update `src/types/deal.ts`: `export type Exchange = 'binance' | 'bybit' | 'okx' | 'kucoin'`
   - In database (`src/database/migrations/005_add_okx_exchange.sql`):
     ```sql
     -- Add constraint to deals.exchange
     CREATE TYPE exchange_type AS ENUM ('binance', 'bybit', 'okx', 'kucoin');
     ALTER TABLE deals ALTER COLUMN exchange TYPE exchange_type;
     ```
   - Add OKX to `conversions.exchange` enum

2. **Admin UI: OKX in Deal Form** (2h)
   - `src/components/deals/DealForm.tsx` (if exists) or admin page
   - Add `exchange` select option: "OKX"
   - OKX-specific fields: `margin_type` (spot/futures), `min_volume_usd`
   - Validation: OKX deals require `margin_type` selection

3. **Public Deals Listing** (2h)
   - `src/app/[locale]/deals/page.tsx` filter sidebar
   - Add OKX exchange logo (`/logos/okx.svg`) to filter options
   - Show OKX badge on deal cards
   - i18n: add `"okx": "OKX"` to `messages/vi.json` and `messages/en.json`

4. **API Routes Updates** (2h)
   - `GET /api/deals` filter: allow `exchange=okx`
   - `GET /api/public/deals` include OKX in default query
   - Ensure all exchange-aware queries use parameterized filters

**Acceptance Criteria:**
- [ ] Admin can create deals with exchange = "okx"
- [ ] OKX deals appear in public listing
- [ ] OKX filter works on deals page
- [ ] OKX logo displays correctly
- [ ] Vietnamese and English labels present

---

## Phase 4: Testing & Verification (6h)

### Tasks

1. **OKX Mock Webhook Script** (3h)
   - `scripts/send-mock-webhook-okx.ts`
   - Generate valid OKX signature using test secret
   - Sample payload: BTC-USDT trade, 0.01 BTC at $50,000
   - CLI args: `--volume 1000 --inst-id BTC-USDT --trade-id mock-123`
   - Test against local dev (`wrangler dev`) or staging

2. **Unit Tests** (2h)
   - `src/__tests__/webhooks/okx-verification.test.ts`
   - `src/__tests__/matcher/okx-matching.test.ts`
   - Test signature verification function
   - Test trade volume calculation
   - Test user matching via API key lookup

3. **E2E Flow Test** (1h)
   - 1. Create admin user, create OKX deal (10% cashback)
   - 2. Create affiliate user with referral code
   - 3. Create shopper user with linked OKX API key
   - 4. Shopper clicks deal → sets `ref` cookie
   - 5. Send mock OKX webhook for shopper's wallet
   - 6. Verify: conversion created, affiliate earns 30% × 10% = 3% of volume
   - 7. Verify: Tier2/Tier3 earnings if downline present

**Acceptance Criteria:**
- [ ] Mock webhook script runs successfully
- [ ] Unit tests pass (coverage >80% for OKX module)
- [ ] E2E test passes end-to-end
- [ ] Signature verification rejects tampered payloads

---

## Environment Variables

Add to `.env.local.example`:

```bash
# OKX Webhook
OKX_WEBHOOK_SECRET=your-okx-webhook-secret
# Note: OKX API key ID linking stored in profiles.external_ids JSON
```

---

## Files to Modify/Create

**New Files:**
- `src/app/api/webhooks/exchange/okx/route.ts`
- `scripts/send-mock-webhook-okx.ts`
- `docs/exchanges/okx.md`
- `src/__tests__/webhooks/okx-verification.test.ts`
- `src/__tests__/matcher/okx-matching.test.ts`

**Modified Files:**
- `src/types/deal.ts` (add 'okx' to Exchange type)
- `src/database/migrations/005_add_okx_exchange.sql` (new migration)
- `src/components/deals/DealForm.tsx` (add OKX option)
- `src/app/[locale]/deals/page.tsx` (OKX filter)
- `src/i18n/messages/vi.json` (add "okx" key)
- `src/i18n/messages/en.json` (add "okx" key)
- `CLAUDE.md` (update exchange setup section)

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| OKX does not support webhooks → must poll | Medium | High | Design handler to accept both webhook and poll. Use poll as fallback |
| User matching fails (no email) | High | Medium | Require OKX API key linking. Document clearly in UX |
| Signature algorithm differs from Binance | Low | Medium | Test with real OKX payloads in staging before production |
| Rate limits exceeded on polling | Medium | Medium | Implement exponential backoff, cache last trade ID |
| Users reluctant to link OKX API key | High | Medium | Clear explanation of benefits (auto-attribution). OAuth-style consent flow |

---

## Post-Sprint Actions

1. Deploy to staging and test with real OKX webhooks (if possible)
2. Update production environment with `OKX_WEBHOOK_SECRET`
3. Add OKX to admin onboarding documentation
4. Schedule KuCoin sprint (Sprint 2)

---

**Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT

Summary: Implement OKX webhook processing end-to-end

Concerns/Blockers:
