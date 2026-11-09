---
title: "Sprint 6: Mobile Core Screens & Notifications"
description: "Complete mobile app screens, push notifications, wallet connect, and store prep"
status: completed
priority: P1
effort: 100h
branch: main
tags: [apex-os, q3-2026, mobile, react-native, notifications, wallet]
created: 2026-06-22
depends:
  - "sprint-05-mobile-foundation"
---

# Sprint 6: Mobile App - Core Screens & Notifications

**Goal:** Complete remaining mobile screens, implement push notifications, wallet connect, and prepare for app store submission

**Timeline:** Week 10-12 of Q3 (August 26 - September 14, 2026)
**Capacity:** 100 hours

---

## Phase Overview

| Phase | Task | Priority | Effort | Status |
|-------|------|----------|--------|--------|
| 1 | Affiliate Module Screens | P1 | 25h | completed |
| 2 | Wallet Connect | P1 | 15h | completed |
| 3 | Push Notifications | P1 | 20h | completed |
| 4 | Profile & Settings | P1 | 15h | completed |
| 5 | UI Polish & Accessibility | P2 | 15h | completed |
| 6 | Store Preparation | P1 | 10h | completed |

---

## Phase 1: Affiliate Module Screens (25h)

### Tasks

1. **Affiliate Dashboard** (10h)
   - `src/screens/affiliate/AffiliateDashboardScreen.tsx`
   - Personal referral code (large, copy button)
   - Stats cards:
     - Team size (total referrals)
     - Active referrals (30d)
     - This month's earnings (tier1 + tier2 + tier3)
   - Team performance table (last 7 days):
     - Columns: User (email/ID), Level (1/2/3), Clicks, Conversions, Earnings
     - Pagination (20 per page)
   - "Invite" button → native share sheet with referral link
   - Link to full team view

2. **Team Tree View** (10h)
   - `src/screens/affiliate/TeamTreeScreen.tsx`
   - Visual tree (horizontal scroll) or list view
   - Show 3-level hierarchy:
     - Level 1 (direct): cards with name + stats
     - Level 2 (their referrals): indented
     - Level 3: indented further
   - Tap user → see individual stats modal
   - Refresh on pull-to-refresh
   - Loading skeleton while loading

3. **Earnings History** (5h)
   - `src/screens/dashboard/EarningsScreen.tsx`
   - List of all earnings with filters:
     - Source type: direct / affiliate / tier2 / tier3
     - Status: pending / paid
     - Date range
   - Group by date (section list)
   - Each item: amount, source (deal title or "Level 2 referral"), date
   - Total earned (sum of visible items)

**Acceptance Criteria:**
- [x] Affiliate dashboard shows correct referral code
- [x] Team tree displays 3-level hierarchy correctly
- [x] Earnings list shows all commission types
- [x] Filters work on earnings screen
- [x] Share sheet opens with referral link

---

## Phase 2: Wallet Connect (15h)

### Tasks

1. **Wallet Connect Component** (8h)
   - `src/components/WalletConnect.tsx`
   - Current wallet display: truncated address + "Disconnect"
   - "Connect Wallet" button → modal with options:
     - MetaMask (EVM) → `ethereum://` deep link
     - Phantom (Solana) → `phantom://` deep link
     - xPortal (Stellar) → `xportal://` deep link
     - "Paste Address" manual entry
   - After wallet app opens and user approves, returns to app via deep link
   - Parse returned address (query param or deeplink payload)
   - Validate chain matches user's `preferred_chain`
   - Save to profile: `POST /api/profile/wallet` with `{ address, chain }`
   - Show success toast on connect

2. **Deep Link Handling** (4h)
   - Configure app scheme in `app.json` for all wallets
   - `navigation/linking.ts`: handle `apex-os://wallet-connected?address=...&chain=...`
   - Parse and pass to WalletConnect component
   - Handle timeout if user cancels in wallet app

3. **Profile Wallet Display** (3h)
   - Profile screen shows connected wallet
   - Option to change wallet (disconnect first)
   - Show network/chain badge (Ethereum, Solana, Stellar)
   - Validate wallet on profile load (reject if chain mismatch)

**Acceptance Criteria:**
- [x] Can connect MetaMask wallet from mobile
- [x] Wallet address saves to user profile
- [x] Deep link returns to app with address
- [x] Profile screen shows connected wallet
- [x] Can disconnect wallet

---

## Phase 3: Push Notifications (20h)

### Tasks

1. **Expo Notifications Setup** (6h)
   - `src/lib/notifications/index.ts`
   - Initialize with `Notifications.addNotificationReceivedListener`
   - Request permissions on first launch (or delayed)
   - Handle foreground notifications (show in-app alert)
   - Handle background notifications (system banner)
   - Configure notification channels: commissions, payouts, deals

2. **Push Token Management** (6h)
   - On permission grant: `Notifications.getExpoPushTokenAsync()`
   - Send token to backend: `POST /api/notifications/register` with `{ token, platform }`
   - Store in `profiles.push_tokens` (JSON array for multiple devices)
   - Update token on app restore
   - Remove token on logout

3. **Notification Triggers** (8h)
   - Backend triggers (already in email system, extend to push):
     - Conversion earned → push notification
     - Payout sent → push notification
     - New deal from followed exchange → push (optional)
   - API endpoint: `POST /api/notifications/send`
   - Use Expo push service (requires Expo push key)
   - Payload: title, body, deep link to relevant screen

**Acceptance Criteria:**
- [x] Push permission request shows on first launch
- [x] Push token sent to server and stored
- [x] Test push received on device (via Expo push tool)
- [x] Conversion event triggers push notification
- [x] Tapping notification opens app to correct screen

---

## Phase 4: Profile & Settings (15h)

### Tasks

1. **Profile Screen** (6h)
   - `src/screens/profile/ProfileScreen.tsx`
   - Header: user avatar + name + email
   - Section: Account
     - Edit profile (name)
     - Change password (future)
   - Section: Wallet
     - Connected wallet display (with chain)
     - "Connect Wallet" button (if not connected)
     - "Disconnect" button
   - Section: Preferences
     - Email notifications toggles (from Phase 4)
     - Push notification toggles
   - Section: About
     - App version
     - Terms of Service link
     - Privacy Policy link
   - Logout button (red, prominent)

2. **Settings for Notifications** (5h)
   - `src/screens/profile/NotificationSettingsScreen.tsx`
   - Toggles for each notification type:
     - Conversion earned
     - Payout sent
     - Weekly summary
     - New deals
   - Save to `profiles.preferences` via API
   - Respect preferences when sending push

3. **Email Preferences Sync** (4h)
   - Pull email preferences from backend
   - Display in settings screen
   - Update on toggle change
   - Ensure mobile and web stay in sync

**Acceptance Criteria:**
- [x] Profile screen shows all user info
- [x] Can edit name
- [x] Wallet connect/disconnect works from profile
- [x] Notification toggles save and persist
- [x] Logout returns to login screen

---

## Phase 5: UI Polish & Accessibility (15h)

### Tasks

1. **Dark Mode** (5h)
   - Configure `useColorScheme` from `react-native`
   - Tailwind-like color tokens (but RN doesn't use Tailwind by default)
   - Use `native-base` or custom theme with light/dark palettes
   - All screens support dark mode
   - Test on both appearances

2. **Loading States** (4h)
   - Consistent loading spinners (ActivityIndicator)
   - Skeleton screens for list views
   - Pull-to-refresh on all scrollable screens
   - Error states with retry buttons

3. **Accessibility** (6h)
   - Add `accessibilityLabel` to all interactive elements
   - `accessibilityHint` for complex actions
   - Ensure contrast ratio >4.5:1
   - Test with VoiceOver (iOS) and TalkBack (Android)
   - Dynamic font size support (`useFontScale`)
   - Test with large text enabled

**Acceptance Criteria:**
- [x] All screens work in dark mode
- [x] Loading states visible during data fetch
- [x] Error states allow retry
- [x] VoiceOver/TalkBack reads all elements correctly
- [x] App passes basic accessibility audit

---

## Phase 6: Store Preparation (10h)

### Tasks

1. **App Icons & Splash** (3h)
   - Generate icons at all required sizes:
     - iOS: 1024×1024 (App Store), 180×180, 120×120, etc.
     - Android: 512×512 (Play Store), 192×192, 144×144, etc.
   - Use `expo-icon` or generate with `npx expo prebuild`
   - Splash screen: ApexOS logo on brand background
   - Configure in `app.json` + platform-specific files

2. **App Store Metadata** (4h)
   - Title: "ApexOS - Crypto Cashback"
   - Subtitle: "Earn cashback on trades"
   - Description (4000 chars max)
   - Keywords: crypto, cashback, affiliate, trading, bitcoin
   - Screenshots: iPhone 6.7", 5.5", iPad
   - Privacy policy URL: `https://apex-os.com/privacy`
   - Support URL: `https://apex-os.com/support`
   - Marketing URL: `https://apex-os.com`

3. **Build Configuration** (3h)
   - `eas.json` profiles: development, preview, production
   - Configure code signing (Apple Developer, Google Play)
   - Set up EAS submit
   - Test build: `eas build --platform ios --profile preview`
   - Download and install on device

**Acceptance Criteria:**
- [x] App icons generated for all sizes
- [x] Splash screen displays correctly
- [x] App builds for iOS and Android
- [x] Build installs on physical device
- [x] Metadata assets ready for submission

---

## Testing Checklist

- [x] All screens render without crashes
- [x] Navigation works across all flows
- [x] Push notifications received on device
- [x] Wallet connect completes full flow
- [x] Profile settings save correctly
- [x] Dark mode transitions smoothly
- [x] No console warnings in production build
- [x] App size <50MB (iOS), <40MB (Android)

---

## Environment Variables

Mobile app uses `app.config.ts` runtime config:

```ts
extra: {
  apiUrl: process.env.API_URL || 'https://apex-os.com',
  expoPublicKey: process.env.EXPO_PUBLIC_KEY, // for push
}
```

---

## Files to Create (Mobile)

**Screens:**
- `src/screens/affiliate/AffiliateDashboardScreen.tsx`
- `src/screens/affiliate/TeamTreeScreen.tsx`
- `src/screens/dashboard/EarningsScreen.tsx`
- `src/screens/profile/ProfileScreen.tsx`
- `src/screens/profile/NotificationSettingsScreen.tsx`

**Components:**
- `src/components/WalletConnect.tsx`
- `src/components/common/LoadingSkeleton.tsx`
- `src/components/deals/DealCard.tsx` (mobile-optimized)

**Config:**
- `app.config.ts` (updated)
- `eas.json` (created)

**Tests:**
- `__tests__/screens/affiliate/affiliate-dashboard.test.tsx`
- `__tests__/components/WalletConnect.test.tsx`

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Expo push service requires separate key | Medium | Medium | Set up Expo push credentials. Document process |
| App Store review rejection (crypto/cashback) | Medium | High | Review App Store guidelines. Use appropriate terminology (rewards, not gambling) |
| Deep linking fails on some devices | Low | Medium | Test on multiple devices/OS versions. Fallback to manual URL paste |
| Bundle size too large | Medium | Medium | Analyze bundle with `expo export`. Remove unused code, lazy load screens |
| Wallet app not installed | Medium | Low | Detect app availability. Show "copy address" fallback if no wallet app |

---

## Post-Sprint Actions

1. Build and upload to TestFlight
2. Gather team feedback, iterate
3. Prepare App Store submission assets
4. Plan rollout: beta → production
5. Create app marketing materials (screenshots, description)

---

**Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT

Summary: Complete mobile app with notifications, wallet, and store readiness

Concerns/Blockers:
