# Brainstorm: ApexOS → Global Crypto Affiliate Hub

**Date:** 2026-06-21
**Status:** Approved — Ready for planning

---

## Problem Statement

ApexOS currently is a copy-trading platform. Need to pivot to **global crypto cashback + affiliate hub** focusing on major crypto exchanges (Binance, Bybit, OKX, KuCoin) as primary merchants.

---

## Decision Matrix

| Aspect | Chosen Option |
|--------|---------------|
| Approach | A — Refactor existing (reuse auth, i18n, UI) |
| Target Users | Shoppers (crypto users looking for deals) |
| Revenue Model | Cashback + Affiliate Commissions |
| Exchanges | Binance, Bybit, OKX, KuCoin (all major) |
| Blockchain Payout | Stellar Network (USDC) |
| Database | Fresh schema (drop old trading tables) |
| Timeline | 4 weeks full-time |

---

## Architecture Overview

### Database Schema (Fresh)

```sql
profiles: id, email, full_name, wallet_address, preferred_chain, role
affiliate_codes: code, user_id, is_active, created_at
referral_tree: id, referrer_id, referee_id, level (1-3)
deals: id, exchange, title, description, affiliate_url, cashback_pct, category, expires_at, is_active
deal_clicks: id, deal_id, user_id (nullable), referral_code, ip_hash, user_agent_hash, clicked_at
conversions: id, deal_id, user_id, referral_code, trade_volume_usd, commission_usd, exchange_trade_id, verified_at
earnings: id, user_id, source_type (direct/affiliate/tier2/tier3), conversion_id, amount_usd, status (pending/paid), created_at, paid_at
payouts: id, user_id, amount_usd, stellar_tx_hash, status (pending/sent/failed), created_at
```

### Feature Phases

**Phase 1 (Week 1-2): Deal Management + Click Tracking**
- Admin CRUD for deals
- Public deals listing with filters
- Click tracking endpoint with referral attribution
- 30-day cookie attribution window

**Phase 2 (Week 3): Conversion + Earnings**
- Webhook endpoint (Binance/Bybit testnet)
- Matching algorithm (click → user → trade)
- Earnings calculation + ledger
- Dashboard: shopper earnings, affiliate referrals/downline

**Phase 3 (Week 4): Payouts + Polish**
- Stellar USDC weekly batch payout
- Wallet connect UI (MetaMask/Phantom)
- Email notifications
- Basic fraud detection (IP clustering, rate limiting)

---

## Tech Stack

- **Frontend:** Next.js 16 + TypeScript + Tailwind + next-intl (vi/en)
- **Backend:** Next.js API routes + Server Actions
- **Database:** Cloudflare D1 (SQLite)
- **Auth:** Better Auth v0.8.7-beta.5 (reuse existing)
- **Payouts:** Stellar USDC (horizon API + keypair)
- **Hosting:** Cloudflare Pages + Workers
- **State:** Zustand (already in package.json)
- **Cron:** Wrangler Scheduler

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Exchange API access denied | Medium | High | Start with manual CSV import; build API later |
| Fraud (click spam) | High | Medium | Rate limiting, IP clustering, review dashboard |
| Stellar payout failures | Low | Medium | Balance alerts, retry logic, manual override |
| Attribution accuracy | Medium | High | 30-day cookie + referral code fallback |
| Compliance (KYC) | Medium | High | Verify at $500+ threshold via Sumsub/Veriff |

---

## Success Metrics (MVP)

- 100+ active deals from 4 exchanges
- 1,000 registered shoppers, 100 active affiliates
- $500 commission volume/month
- 90% automated payout success rate
- >95% click→conversion match rate

---

## Scope & Constraints

**Out of Scope (Phase 1-3):**
- Multi-language beyond vi/en
- Mobile app (React Native)
- Advanced fraud ML
- OAuth social login (add later)
- Advanced analytics (Funnel, cohort)

**Non-Negotiables:**
- Use Cloudflare D1 (no Postgres migration)
- Reuse existing auth + i18n infrastructure
- 4-week timeline
- Stellar for payouts

---

## Touchpoints with Existing Code

**Files to keep/modify:**
- `src/contexts/auth-context.tsx` → extend profile fields
- `src/i18n/messages/` → add affiliate/cashback translations
- `src/components/dashboard/` → repurpose for new dashboard
- `src/lib/auth/` → extend user creation hook

**Files to delete:**
- `src/components/dashboard/dashboard-*` (trading-specific, rebuild)
- Database migrations 001/002 (new migrations)

**New directories:**
- `src/lib/deals/` — deal CRUD, exchange sync
- `src/lib/tracking/` — click attribution
- `src/lib/payouts/` — Stellar payout service
- `src/lib/referrals/` — referral tree logic
- `src/features/deals/` — pages for deals listing/detail
- `src/features/dashboard/` — new dashboard pages

---

## Next Steps

1. `/ck:plan` to create detailed phase-by-phase implementation plan
2. Start with database migration design
3. Build admin CMS for deals first (foundational)

---

**Brainstorm completed. Approved for planning.**
