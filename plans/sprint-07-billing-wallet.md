---
title: "Sprint 7: Billing & Wallet Connect"
description: "Payment flows, tier activation, NOWPayments integration, and wallet setup for mobile"
status: complete
priority: P1
effort: 80h
branch: main
tags: [apex-os, q3-2026, mobile, billing, wallet, payments, nowpayments]
created: 2026-08-03
depends:
  - "sprint-06-mobile-complete"
completed: 2026-09-25
---

# Sprint 7: Billing & Wallet Connect

**Goal:** Enable in-app purchasing and crypto cashout via NOWPayments; connect MetaMask/Phantom/xPortal from mobile; auto-activate tiers on payment confirmation.

**Timeline:** Week 13-15 of Q3 (September 15 - October 5, 2026)
**Capacity:** 80 hours

---

## Phase Overview

| Phase | Task | Priority | Effort | Status |
|-------|------|----------|--------|--------|
| 1 | NOWPayments Checkout Flow | P1 | 20h | complete |
| 2 | Tier Activation Webhook | P1 | 15h | complete |
| 3 | Wallet Connect Module | P1 | 25h | complete |
| 4 | Profile Wallet Integration | P2 | 10h | complete |
| 5 | Billing History Screen | P2 | 10h | complete |

---

## Phase 1: NOWPayments Checkout Flow (20h)

### Tasks

1. **Checkout Screen** (8h) — `src/screens/billing/CheckoutScreen.tsx`
   - Show selected plan (BASIC / PREMIUM / ENTERPRISE / MASTER)
   - Price in USD + crypto equivalent
   - "Pay with Crypto" button → open NOWPayments hosted checkout in WebView or in-app browser
   - After payment redirect: `apex-os://billing/result?status=completed&txn_id=...`
   - Show pending → success/failure states

2. **Payment Status Polling** (6h)
   - Mobile stores `pending_payment_id` in async storage
   - Background: poll `/api/payments/status?id=...` every 10s (max 5 min)
   - On confirmed: navigate to success receipt
   - On timeout/fail: show error + retry

3. **Receipt/Invoice Screen** (4h) — `src/screens/billing/ReceiptScreen.tsx`
   - Price, plan, date, transaction hash, status
   - Share button → native share sheet

4. **Deep Link Handler** (2h)
   - Add `apex-os://billing/*` scheme to `app.json` + `navigation/linking.ts`
   - Parse `status` + `txn_id` query params
   - Route to CheckoutScreen with result

**Acceptance Criteria:**
- [ ] User taps "Pay with Crypto" → WebView opens NOWPayments hosted page
- [ ] After payment: deep link returns to app with status
- [ ] Status transitions: pending → confirmed (or failed)
- [ ] Receipt screen shows correct transaction details
- [ ] Share sheet works with referral link
- [ ] No hardcoded API keys; all from `app.config.ts` extra

**Contracts:**
- Backend: `POST /api/payments/create` → `{ checkoutUrl, paymentId, orderId }`
- Backend: `GET /api/payments/status?id=<id>` → `{ status, txnId, amount, currency }`
- Existing: `TIER_CONFIGS` enum (BASIC/PREMIUM/ENTERPRISE/MASTER) from `@/seed/config/tiers`
- Do NOT modify: Setup Wizard flow, Telegram Bot webhook, Payment IPN handler

---

## Phase 2: Tier Activation Webhook (15h)

### Tasks

1. **Webhook Receiver Backend** (10h)
   - Extend `web-api` with `POST /api/notifications/ipn` endpoint (already exists for NOWPayments)
   - Verify NOWPayments signature using webhook secret
   - On `payment_completed`: lookup user by email or userId, update `profiles.tier`
   - Send confirmation push notification (reuse `@/lib/notifications`)
   - Queue email receipt

2. **Tier Sync Client** (5h)
   - `src/services/tier-sync.ts` — fetch `/api/users/me` after payment to confirm tier
   - On logout or token refresh: re-check tier from server (prevents stale cached tier)
   - Update Zustand store

**Acceptance Criteria:**
- [ ] Webhook verifies NOWPayments signature
- [ ] Tier column updates on payment_completed
- [ ] Push notification fires after tier change
- [ ] Mobile reflects new tier within 5 minutes of payment

---

## Phase 3: Wallet Connect Module (25h)

### Tasks

1. **WalletConnect Component** (10h) — `src/components/WalletConnect.tsx`
   - Display: truncated address + chain badge + "Disconnect" button
   - "Connect Wallet" button opens modal:
     - MetaMask → `ethereum://` deep link
     - Phantom → `phantom://` deep link
     - xPortal → `xportal://` deep link
     - "Paste Address" manual entry
   - After wallet approval: address returns via deep link
   - Validate chain matches `preferred_chain`
   - Save to profile: `POST /api/profile/wallet` with `{ address, chain }`

2. **Deep Link Handlers** (8h)
   - Configure schemes in `app.json`: `apex-os://wallet-connected?address=...&chain=...`
   - Parse and pass to WalletConnect
   - Handle timeout if user cancels
   - Detect if wallet app is installed; show fallback "Copy address" if not

3. **Connector Registration / Unregistration** (7h)
   - On connect: store in `AsyncStorage` key `last_wallet_connect` for session recovery
   - On logout / disconnect: clear; show confirmation before clearing
   - Show loading spinner during wallet-app transit

**Acceptance Criteria:**
- [ ] Connect MetaMask from mobile → address saves to profile
- [ ] Deep link returns to app with wallet response
- [ ] Disconnect clears saved wallet and updates UI
- [ ] Fallback "Paste Address" works without wallet app
- [ ] Chain validation rejects mismatched chain

---

## Phase 4: Profile Wallet Integration (10h)

### Tasks

1. **Profile Screen Wallet Section** (6h) — `src/screens/profile/ProfileScreen.tsx`
   - If wallet connected: show truncated address, chain badge, "Change Wallet" / "Disconnect"
   - If not connected: show "Connect Wallet" button that opens WalletConnect modal
   - Validate on profile load: if chain mismatches `preferred_chain`, show warning

2. **Chain Badge Component** (2h)
   - Map chain → color/icon: Ethereum (#627EEA), Solana (#9945FF), Stellar (#14B6E7)

3. **Connect Flow Integration** (2h)
   - Tab navigation links: Profile → Wallet section
   - Settings → Wallet (if Profile deferred)

**Acceptance Criteria:**
- [ ] Profile shows connected wallet on load
- [ ] Disconnect removes wallet and updates UI
- [ ] Chain badge displays correct color/icon
- [ ] Mismatched chain shows warning banner

---

## Phase 5: Billing History Screen (10h)

### Tasks

1. **BillingHistoryScreen** (6h) — `src/screens/billing/BillingHistoryScreen.tsx`
   - Pull from `/api/payments/history` endpoint
   - Section list grouped by month
   - Items: date, plan, amount, status, transaction hash
   - Empty state: "No payments yet"
   - Pull-to-refresh

2. **Integration with Tab Navigation** (2h)
   - Add "Billing" tab to Profile tab flow (or Settings)
   - Badge if pending payment

3. **Error/Retry Handling** (2h)
   - Show retry button on network error
   - Cache last successful fetch

**Acceptance Criteria:**
- [ ] History screen shows all past payments
- [ ] Loads from server; falls back to cache
- [ ] Empty state renders when no payments exist

---

## Environment Variables

```ts
// app.config.ts extra
extra: {
  apiUrl: process.env.API_URL || 'https://apex-os.com',
  nowPaymentsPublicKey: process.env.NOWPAYMENTS_PUBLIC_KEY,
  easProjectId: process.env.EAS_PROJECT_ID,
}
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/screens/billing/CheckoutScreen.tsx` | NOWPayments hosted checkout flow |
| `src/screens/billing/ReceiptScreen.tsx` | Payment receipt with share |
| `src/screens/billing/BillingHistoryScreen.tsx` | Payment history list |
| `src/components/WalletConnect.tsx` | Wallet connect modal + display |
| `src/components/common/ChainBadge.tsx` | Chain color/icon component |
| `src/services/tier-sync.ts` | Tier sync helper |
| `__tests__/screens/billing/checkout.test.tsx` | Checkout screen tests |
| `__tests__/components/WalletConnect.test.tsx` | Wallet connect tests |

---

## Do NOT Touch (Protected Contracts)

- Setup Wizard BYOK flow (`api/keys/*`)
- Telegram Bot webhook (`api/telegram/webhook`)
- NOWPayments IPN webhook (`api/notifications/ipn` / existing payment handlers)
- Existing notification routes
- Sophia AI Factory web-app layer (`apps/sophia-ai-factory/`)

---

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| NOWPayments hosted checkout requires full browser | Medium | Medium | Use `expo-web-browser` or InAppBrowser |
| Wallet app not installed | Medium | Low | Copy-address fallback |
| Chain mismatch on reconnect | Low | Medium | Warn + re-prompt chain selection |
| Webhook signature verification bugs | Low | High | Unit tests on IPN handler |
