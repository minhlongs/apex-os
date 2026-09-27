---
title: "ApexOS Q3 2026 Roadmap"
description: "Q3 priorities: OKX/KuCoin integrations, advanced analytics, email automation, mobile app"
status: completed
priority: P0
effort: 320h (8 weeks)
branch: main
tags: [apex-os, q3-2026, roadmap, okx, kucoin, analytics, mobile]
created: 2026-06-22
---

# Q3 2026 Roadmap: Scale & Engagement

**Goal:** Expand exchange coverage, deepen analytics, improve user engagement, and launch mobile presence

**Timeline:** 8 weeks (July 1 - August 31, 2026)
**Capacity:** 2 full-time engineers @ 40h/week = 320 hours

---

## Priority Matrix

| Epic | Priority | Effort | ROI | Dependencies |
|------|----------|--------|-----|--------------|
| OKX/KuCoin Integrations | P0 | 60h | High | Webhook infrastructure |
| Advanced Analytics | P0 | 80h | High | Conversion data pipeline |
| Email Automation | P1 | 40h | Medium | Resend setup complete |
| Mobile App | P1 | 100h | High | API stability |
| Fraud Detection | P2 | 40h | Medium | Webhook + analytics |

**Total:** 320 hours

---

## Epic 1: Multi-Exchange Expansion (P0)

### Objective
Add OKX and KuCoin webhook integrations to double conversion surface

### Week 1-2: OKX Integration (30h)

**Tasks:**

1. **Research OKX Webhook API** (4h)
   - Document required headers, signature algorithm (HMAC-SHA256)
   - Identify trade event types: `order/trade_update`
   - Note differences from Binance/Bybit payloads
   - Write integration guide in `docs/exchanges/okx.md`

2. **Webhook Handler Extension** (12h)
   - `src/app/api/webhooks/exchange/okx/route.ts`
   - Verify OKX signature (different timestamp handling)
   - Parse payload: `trade_volume_usd`, `user_email`/`trader_id`, `inst_id`
   - Map OKX symbols to internal deal categories (Spot/Futures)
   - Idempotency check: `exchange_trade_id` unique constraint

3. **Exchange Configuration** (6h)
   - Add `EXCHANGE=okx` enum to deals table
   - OKX logo asset (SVG) in `public/logos/okx.svg`
   - Deal filters: show "OKX" as exchange option
   - Admin UI: exchange dropdown includes OKX

4. **Testing** (8h)
   - Create OKX mock webhook script: `scripts/send-mock-webhook-okx.ts`
   - Test signature verification with sample payloads
   - E2E: click → OKX webhook → earnings credited
   - Unit tests for OKX parser

**Acceptance Criteria:**
- [ ] OKX webhook endpoint receives and verifies real payload
- [ ] Conversion matches to affiliate correctly
- [ ] Mock webhook test passes end-to-end
- [ ] OKX deals appear in public listing
- [ ] Admin can create OKX-specific deals

### Week 3-4: KuCoin Integration (30h)

**Tasks:**

1. **Research KuCoin Webhook API** (4h)
   - KuCoin uses different auth: `KC-API-KEY`, `KC-API-SIGN`, `KC-API-TIMESTAMP`
   - Payload structure: `orderId`, `symbol`, `size`, `price`, `fee`
   - Document in `docs/exchanges/kucoin.md`

2. **Webhook Handler** (12h)
   - `src/app/api/webhooks/exchange/kucoin/route.ts`
   - Verify KuCoin signature (includes passphrase)
   - Parse trade volume: `size × price`
   - Handle both spot and futures trades
   - Map KuCoin symbols to categories

3. **Configuration & UI** (10h)
   - Add `EXCHANGE=kucoin` enum
   - KuCoin logo asset
   - Admin deal form: KuCoin option
   - Public listing: KuCoin filter

4. **Testing** (4h)
   - Mock webhook script for KuCoin
   - E2E verification

**Acceptance Criteria:**
- [ ] KuCoin webhook processes real payloads
- [ ] Signature verification works
- [ ] Multi-exchange attribution (Binance/Bybit/OKX/KuCoin) all functional

### Cross-Cutting: Exchange Management (Shared)

- **Unified Exchange Enum:** Define `ExchangeType` type (BINANCE, BYBIT, OKX, KUCOIN)
- **Deal Validation:** Ensure `exchange` field matches enum in admin form
- **Analytics:** Separate metrics per exchange (for Epic 2)
- **Documentation:** Update `CLAUDE.md` with new webhook setup steps

**Risk:** OKX/KuCoin may have different webhook retry policies → implement robust error handling + dead letter queue

---

## Epic 2: Advanced Analytics Dashboard (P0)

### Objective
Deep insights into affiliate performance, conversion funnels, and revenue attribution

### Week 5: Core Analytics Engine (40h)

**Tasks:**

1. **Analytics Database Views** (12h)
   - Create D1 views (materialized daily):
     - `daily_deal_performance`: clicks, conversions, revenue per deal
     - `daily_affiliate_performance`: tier1/2/3 earnings, click-through rate
     - `daily_exchange_performance`: volume per exchange, top deals
     - `referral_funnel`: activation rates (signup → click → conversion)
   - Add scheduled job to refresh views (daily cron)

2. **Analytics API Layer** (16h)
   - `src/app/api/analytics/[metric]/route.ts`
   - Endpoints:
     - `GET /api/analytics/deals?date_from=...&date_to=...&exchange=...`
     - `GET /api/analytics/affiliates?top=10&metric=earnings`
     - `GET /api/analytics/funnel?date_range=7d`
     - `GET /api/analytics/conversions?status=paid|pending`
   - Query builder with date range filters, grouping
   - Cache responses in KV (5min TTL) for performance

3. **Admin Analytics Dashboard** (12h)
   - `src/app/[locale]/admin/analytics/page.tsx`
   - Charts library: Recharts or Chart.js
   - Key widgets:
     - Total volume (7d, 30d, all-time)
     - Top 10 affiliates by earnings
     - Top 20 deals by conversions
     - Exchange breakdown (pie chart)
     - Funnel visualization (clicks → conversions)
   - Date range picker (7d, 30d, 90d, custom)
   - Export CSV button for each table

**Acceptance Criteria:**
- [ ] All 4 analytics views query correctly with filters
- [ ] Admin dashboard renders charts with <2s load time
- [ ] CSV export works for all tables
- [ ] Data matches raw `earnings`, `conversions`, `deal_clicks` tables

### Week 6: Shopper & Affiliate Analytics (40h)

**Tasks:**

1. **Shopper Analytics** (20h)
   - `src/app/[locale]/dashboard/analytics/page.tsx`
   - Personal metrics:
     - Total earned (chart by month)
     - Click-through rate on shared links
     - Conversion rate (clicks → trades)
     - Top-performing deals
     - Projected earnings (based on recent average)
   - Compare to average (percentile ranking)
   - Download personal report (PDF via `@react-pdf/renderer`)

2. **Affiliate Analytics** (20h)
   - Enhance existing affiliate dashboard:
     - Downline performance: each level's conversions/earnings
     - Referral conversion rate (how many clicks become trades)
     - Active vs inactive referrals (30d activity)
     - Team growth chart (new signups per week)
     - Commission breakdown by tier (pie: 30%/10%/5%)
   - Add `affiliates/team/page.tsx` for downline detail view

3. **Real-time Updates** (Optional, stretch)
   - Use Server-Sent Events or polling for live metrics
   - Dashboard auto-refresh every 60s

**Acceptance Criteria:**
- [ ] Shopper sees personal earnings trend chart
- [ ] Affiliate sees downline tree with stats per node
- [ ] All charts responsive (mobile-friendly)
- [ ] PDF export generates correctly

---

## Epic 3: Email Automation (P1)

### Objective
Automated lifecycle emails to improve engagement and reduce churn

### Week 7: Email Infrastructure & Templates (40h)

**Tasks:**

1. **Resend Setup** (4h)
   - Verify `RESEND_API_KEY` in production
   - Create sender domain: `noreply@apex-os.com` (verify with Resend)
   - Test email deliverability

2. **Email Templates** (20h)
   - Create `src/emails/templates/` with React Email components
   - Base layout: header (logo), footer (unsubscribe, support)
   - Templates:
     - `welcome.tsx`: signup confirmation, affiliate code reveal
     - `conversion-earned.tsx`: "You earned $X from Y trade"
     - `payout-sent.tsx`: USDC sent, tx_hash link
     - `weekly-summary.tsx`: top-line metrics for active users
     - `referral-activated.tsx`: "Your referral Z made their first trade"
     - `deal-expiring.tsx`: deal expiring in 3 days (to affiliate)
   - All templates: dark mode compatible, mobile-responsive

3. **Email Queue Service** (12h)
   - `src/lib/emails/queue.ts`: Resend API wrapper with retry
   - Queue design: `email_queue` table (status: pending/sent/failed, retry_count)
   - Cron job: `0 * * * *` (hourly) processes pending emails
   - Exponential backoff: 1h, 4h, 24h, then dead letter
   - Dead letter alert: Slack webhook on >5 failures

4. **Event Triggers** (4h)
   - Wire events to email queue:
     - `user.signup` → welcome email
     - `conversion.created` → conversion-earned
     - `payout.sent` → payout-sent
     - `cron.weekly-summary` → weekly digest
   - Test each trigger locally

**Acceptance Criteria:**
- [ ] All 6 templates render correctly (desktop + mobile)
- [ ] Email queue processes without errors
- [ ] Test emails deliver to inbox (not spam)
- [ ] Cron job runs hourly successfully
- [ ] Unsubscribe link works (compliance)

### Week 8: Advanced Email Features (Stretch) (40h)

**Tasks:**

1. **Email Preferences** (12h)
   - `src/app/[locale]/settings/notifications/page.tsx`
   - User toggles: conversion alerts, payout notifications, weekly digest, promotional
   - Store preferences in `profiles.email_preferences` (JSON)
   - Queue respects preferences before sending

2. **A/B Testing Framework** (16h)
   - Subject line A/B tests (randomized 50/50)
   - Track open rates, click rates in `email_events` table
   - Admin UI: email campaign manager
   - Stats: best performing subject lines

3. **Segmentation** (12h)
   - Segment users by:
     - Engagement level (active/inactive)
     - Earnings tier (>$100, >$1000)
     - Exchange preference (Binance vs Bybit vs OKX)
   - Send targeted campaigns (e.g., "OKX traders earn 15% more")
   - Campaign performance metrics

**Acceptance Criteria:**
- [ ] Users can manage email preferences
- [ ] A/B test splits traffic and tracks results
- [ ] Segmentation campaigns send correctly
- [ ] Email analytics dashboard shows open/click rates

---

## Epic 4: Mobile App (P1)

### Objective
Native mobile experience for iOS and Android

### Technology Choice: React Native

**Rationale:**
- Code reuse: Next.js web components → RN with Expo
- Shared TypeScript types
- Single team skillset (React/TypeScript)
- Faster time-to-market vs native Swift/Kotlin

### Week 8-10: Foundation & Core Screens (100h)

**Tasks:**

1. **Expo Project Setup** (8h)
   - `npx create-expo-app apex-os-mobile --template expo-template-blank-typescript`
   - Configure:
     - Navigation: React Navigation v6 (stack + tab)
     - State: Zustand (shared with web)
     - i18n: react-i18next (sync with web translations)
     - API client: `src/lib/api/client.ts` (shared)
   - CI setup: EAS Build

2. **Authentication** (16h)
   - Login screen (email/password)
   - Signup screen (referral code capture)
   - Deep linking: `apex-os://` scheme for wallet connect
   - Biometric auth: Face ID / Touch ID for stored sessions
   - Token persistence: SecureStore (encrypted)
   - Logout + session clear

3. **Core Screens** (40h)
   - **Deals List** (`screens/DealsScreen.tsx`)
     - Same filters as web (exchange, category, cashback %)
     - Pull-to-refresh
     - Infinite scroll pagination
   - **Deal Detail** (`screens/DealDetailScreen.tsx`)
     - Affiliate CTA button (opens exchange app via deep link)
     - Share sheet: copy referral link, share to social
   - **Dashboard** (`screens/DashboardScreen.tsx`)
     - Shopper: total earned, recent conversions
     - Affiliate: personal code, team stats, downline
   - **Profile** (`screens/ProfileScreen.tsx`)
     - Edit profile, wallet address
     - Email preferences
     - Referral code display

4. **Wallet Connect** (12h)
   - `components/WalletConnect.tsx` (mobile-adapted)
   - Deep link to wallet apps:
     - MetaMask: `metamask://`
     - Phantom: `phantom://`
     - xPortal: `xportal://`
   - Fallback: QR code display for manual scan
   - Validate chain matches user `preferred_chain`

5. **Push Notifications** (12h)
   - Expo Notifications setup
   - Events: conversion earned, payout sent
   - Configure APNs (iOS) and FCM (Android)
   - Request permissions on first launch
   - Notification payload: deep link to relevant screen

6. **API Integration & Testing** (12h)
   - Reuse web API endpoints (verify CORS)
   - Mock service worker for offline testing
   - E2E test: login → browse deals → click → track
   - Test on iOS simulator + Android emulator

**Acceptance Criteria:**
- [ ] App builds successfully for iOS and Android
- [ ] Authentication flow complete
- [ ] Deals listing loads with filters
- [ ] Dashboard shows user data
- [ ] Push notifications received on device
- [ ] All core screens functional offline (cached data)

### Week 11-12: Polish & Store Prep (Stretch) (80h)

**Tasks:**

1. **UI Polish** (20h)
   - Native components: Switch, ActivityIndicator, SafeAreaView
   - Platform-specific adjustments (iOS vs Android)
   - Dark mode support
   - Loading states + skeleton screens
   - Error boundaries + retry logic

2. **Performance** (16h)
   - Bundle size analysis (`expo export`)
   - Image optimization: `expo-image`
   - Lazy load screens
   - Memoize expensive calculations
   - Target: <50MB app size, <2s cold start

3. **App Store Assets** (12h)
   - App icons (1024×1024) for iOS/Android
   - Splash screen (logo + background)
   - App Store screenshots (all device sizes)
   - Store listing: description, keywords, privacy policy

4. **CI/CD Pipeline** (16h)
   - EAS Build configuration (`eas.json`)
   - Automatic builds on git tag (`v1.0.0-mobile`)
   - Internal TestFlight (iOS) + Internal Testing (Android)
   - OTA updates via EAS Update
   - Code signing setup

5. **Submission Prep** (16h)
   - Privacy policy URL (hosted on web)
   - App Store metadata: category, age rating, keywords
   - Submit to TestFlight (Apple review ~2-3 days)
   - Submit to Google Play Internal Test
   - Address review feedback

**Acceptance Criteria:**
- [ ] App passes TestFlight review
- [ ] Google Play Internal Test live
- [ ] Build size <50MB
- [ ] All screens pass accessibility audit
- [ ] OTA updates configured

---

## Epic 5: Fraud Detection (P2) - Stretch

### Objective
Reduce fraud from click spam, fake conversions, affiliate collusion

### Week 12: Basic Fraud Rules (40h)

**Tasks:**

1. **Anomaly Detection** (20h)
   - Rate limiting on click endpoint:
     - Max 100 clicks/hour per IP
     - Max 1000 clicks/day per IP
     - Auto-block repeated offenders
   - Velocity checks:
     - Unusual click-to-conversion ratio (>10:1 flagged)
     - Same wallet multiple clicks in short window
   - Store flags in `deal_clicks.is_suspicious`

2. **Admin Review Dashboard** (20h)
   - `src/app/[locale]/admin/fraud/page.tsx`
   - Table: suspicious clicks with reason
   - Actions: approve / reject / block IP
   - Bulk actions: mark all from IP as clean
   - Audit log: `fraud_reviews` table

**Acceptance Criteria:**
- [ ] Click rate limiting active
- [ ] Suspicious flags visible to admin
- [ ] Admin can review and override
- [ ] Blocked IPs cannot click

---

## Cross-Cutting Concerns

### API Performance (Ongoing)

- Add response caching (KV) for expensive queries
- Database query optimization: add missing indexes
- CDN cache headers for static assets
- Target: 95th percentile API latency <200ms

### Documentation Updates

- Update `README.md` with new exchange setup steps
- `docs/exchanges/` folder: integration guides for each exchange
- `docs/analytics/`: API reference for analytics endpoints
- `docs/mobile/`: React Native setup guide
- `docs/email/`: Resend configuration + template reference

### Testing

- Unit tests: new modules (target 80% coverage)
- Integration: multi-exchange webhook flow
- E2E: complete user journey (web + mobile web)
- Load test: 1000 concurrent clicks

### Security

- Rate limiting on all webhook endpoints
- IP allowlist option for exchange webhooks (optional)
- Email unsubscribe compliance (CAN-SPAM)
- Mobile: certificate pinning for API calls

---

## Milestone Timeline

```
Week 1-2  [OKX Integration]       ████████████████████
Week 3-4  [KuCoin Integration]    ████████████████████
Week 5    [Analytics Engine]      ████████████████████
Week 6    [User Analytics]        ████████████████████
Week 7    [Email Infrastructure]  ████████████████████
Week 8    [Mobile Foundation]     ████████████████████
Week 9-10 [Mobile Core Screens]   ████████████████████
Week 11-12[Mobile Polish/Submit]  ████████████████████
Week 12   [Fraud Detection]       ████████████████████
```

---

## Dependencies & Blockers

| Dependency | Owner | Deadline |
|------------|-------|----------|
| OKX webhook credentials (test + prod) | DevEx | Week 1 |
| KuCoin webhook credentials | DevEx | Week 3 |
| Resend domain verification | Infra | Week 7 |
| Apple Developer Account ($99/yr) | Finance | Week 8 |
| Google Play Console ($25 one-time) | Finance | Week 8 |

---

## Success Metrics (Q3)

**Exchange Coverage:**
- 4 exchanges supported (Binance, Bybit, OKX, KuCoin)
- 2x increase in deal volume

**Analytics:**
- Admin analytics dashboard adopted by 100% of admin users
- 90%+ data accuracy (validated against raw tables)

**Email:**
- 40%+ open rates on transactional emails
- 20% click-through on weekly summaries

**Mobile:**
- 500+ TestFlight installs
- 4.5+ star rating (internal testing)

---

## Rollback Triggers

- OKX/KuCoin integration causing >5% webhook failure rate → disable, revert to web-only
- Analytics queries >5s average → add cache layer, limit date ranges
- Mobile app crashes >2% of sessions → pause new features, fix stability
- Email spam complaints >0.1% → pause campaigns, review content

---

## Go/No-Go Criteria (End of Q3)

- [x] OKX and KuCoin webhooks processing live traffic
- [x] Admin analytics dashboard shipped
- [x] Email automation live with 5+ template types
- [x] Mobile app in TestFlight (iOS) and Internal Testing (Android)
- [x] No P0 bugs open
- [x] All acceptance criteria met for P0/P1 epics

---

**Next:** Break into weekly sprint plans under `plans/` with task tracking.
