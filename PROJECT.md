# Project: ApexOS Mobile App Store & TestFlight Production Release

## Architecture
- **Framework**: React Native 0.86 with Expo SDK 52 in `apex-os-mobile`.
- **Target Platforms**: iOS (Apple App Store & TestFlight) and Android (Google Play Store).
- **Build & Distribution Infrastructure**:
  - EAS Build configuration (`eas.json`) with `development`, `preview` (TestFlight internal/ad-hoc), and `production` release profiles.
  - Native application configuration via `app.json` with bundle ID `com.apexos.app`, package `com.apexos.app`, semantic version `1.0.0`, buildNumber `1`, versionCode `1`, and URL scheme `apex-os://`.
- **Resilience & Safe Areas**:
  - Global `ErrorBoundary` (`src/components/common/ErrorBoundary.tsx`) wrapping the root component tree with user-facing recovery actions and diagnostic details disclosure.
  - Safe Area handling via `react-native-safe-area-context`: root `SafeAreaProvider`, dynamic bottom tab insets on `MainTabNavigator`, and top safe area insets on headerless screens (`DashboardScreen`, `ProfileScreen`, `BillingHistoryScreen`, `NotificationsSettingsScreen`).
- **Design & Theming System**:
  - Centralized design tokens (`src/theme/tokens.ts`) with semantic colors (background, card, border, text, primary, status).
  - Navigation container dark theme binding preventing white-screen flashes during transitions.
  - Consistent styling across cards, inputs, and tab navigation.
- **Cold Start & Deep Linking**:
  - Mount-time cold start URL resolution (`Linking.getInitialURL()`) in `App.tsx`.
  - Registered `BillingStackNavigator` in `AppNavigator.tsx` to handle billing receipt deep links (`apex-os://receipt/...`).
- **Bundle Optimization**:
  - Metro bundler configuration (`metro.config.js`).
  - Selective icon tree-shaking (`@expo/vector-icons/Ionicons`) reducing bundle asset payload.
  - JavaScript Hermes bytecode bundle strictly under 50MB (currently ~2.9MB).
- **Verification Pipeline**:
  - Automated unit test suite with 100% pass rate via Vitest.
  - Zero TypeScript compiler errors (`tsc --noEmit`).
  - Clean production export via `npx expo export` with exit code 0.

## Feature Inventory
Every feature from the Survey phase appears here with its assigned milestone.
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | EAS Build Configuration | `eas.json` with development, preview, and production profiles | M1 | Survey 1, ORIGINAL_REQUEST R1 |
| F2 | App Configuration & Identifier Setup | `app.json` with `com.apexos.app`, version 1.0.0, buildNumber 1, versionCode 1, scheme apex-os://, platforms ["ios", "android"] | M1 | Survey 1, Survey 3, ORIGINAL_REQUEST R1 |
| F3 | App Store Assets & Splash Alignment | Fix `assets/splash.png` path, configure adaptive icons and splash screen parameters | M1 | Survey 1, Survey 3, ORIGINAL_REQUEST R4 |
| F4 | App Store Listing Metadata | Complete App Store metadata package (descriptions, keywords, release notes, categories, privacy policy URL) in `metadata/store-metadata.json` | M1 | Survey 1, ORIGINAL_REQUEST R4 |
| F5 | Global Error Boundary Architecture | Create `src/components/common/ErrorBoundary.tsx` with user-facing retry, error reset, and diagnostics drawer | M2 | Survey 2, ORIGINAL_REQUEST R2 |
| F6 | Safe Area Context Integration | Wrap root in `SafeAreaProvider`, adapt non-header screens with top insets, and dynamic bottom insets on `MainTabNavigator` | M2 | Survey 2, ORIGINAL_REQUEST R2 |
| F7 | Theme Unification & UI Polish | Centralized `src/theme/tokens.ts`, apply `navigationTheme` on `<NavigationContainer>`, fix `ReceiptScreen` and `EarningsScreen` backgrounds, set input placeholder colors | M2 | Survey 2, ORIGINAL_REQUEST R2 |
| F8 | Navigation & Cold-Start Deep Linking | Register `BillingStackNavigator` in `AppNavigator.tsx`, add `Linking.getInitialURL()` cold-start listener, and pass `linking` config to `NavigationContainer` | M2 | Survey 2, Survey 3, ORIGINAL_REQUEST R2 |
| F9 | Metro & Bundle Optimization | Create `metro.config.js`, deep import `Ionicons` to eliminate unused vector fonts, optimize cold start | M3 | Survey 3, ORIGINAL_REQUEST R3 |
| F10 | Package & Dependency Hygiene | Add missing `@vitest/coverage-v8` / test dependencies, remove obsolete/unrecognised config, clean `node_modules` | M3 | Survey 1, Survey 3, ORIGINAL_REQUEST R3, R5 |
| F11 | Safe Area & Error Boundary Test Harness | Add `react-native-safe-area-context` mock to `__tests__/setup.ts` and add unit tests for `ErrorBoundary` and theme tokens | M4 | Survey 2, ORIGINAL_REQUEST R5 |
| F12 | Full Verification & Export Pipeline | 100% test pass rate in `apex-os-mobile`, `tsc --noEmit` 0 errors, `npx expo export` produces <50MB bundle with 0 errors | M4 | Survey 1, Survey 2, Survey 3, ORIGINAL_REQUEST R5 |
| F13 | Adversarial & Integrity Audit | Challenger stress tests and Forensic Auditor integrity verification (no mocks/facades) | M5 | Teamwork Project Pattern |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | EAS Build, Code Signing & App Store Metadata | `eas.json`, `app.json`, splash/icon assets, store metadata | none | DONE |
| M2 | UI Polish, Error Boundaries, Safe Areas & Theme | `ErrorBoundary`, `SafeAreaProvider`, screen insets, `MainTabNavigator`, `tokens.ts`, `App.tsx` | M1 | DONE |
| M3 | Bundle Optimization, Metro Config & Cold Start | `metro.config.js`, vector icon tree-shaking, cold start deep links | M1, M2 | DONE |
| M4 | Test Pipeline & Verification Hardening | Mock setup, ErrorBoundary tests, 100% test pass, tsc 0 errors, expo export <50MB | M1, M2, M3 | DONE |
| M5 | Adversarial Verification & Forensic Audit | Challenger tests and Forensic Integrity Audit gate | M4 | DONE |

## Interface Contracts

### ErrorBoundary ↔ App.tsx
- Component: `<ErrorBoundary fallbackComponent={CustomFallback} onError={(error, info) => logError(error, info)}>{children}</ErrorBoundary>`
- Props: `children: React.ReactNode`, `fallback?: (props: FallbackProps) => React.ReactNode`
- FallbackProps: `{ error: Error; resetError: () => void }`

### Safe Area Insets ↔ MainTabNavigator
- Screen wrapper hook: `const insets = useSafeAreaInsets();`
- Tab bar height: `height: 60 + insets.bottom`
- Tab bar paddingBottom: `paddingBottom: Math.max(insets.bottom, 8)`

### Theme Tokens ↔ Components
- Colors contract:
  - `theme.colors.background`: `#0A0A0A`
  - `theme.colors.card`: `#18181B`
  - `theme.colors.border`: `#27272A`
  - `theme.colors.text`: `#F4F4F5`
  - `theme.colors.textMuted`: `#A1A1AA`
  - `theme.colors.placeholder`: `#71717A`
  - `theme.colors.primary`: `#3B82F6`

### Navigation Deep Linking Contract
- Scheme: `apex-os://`
- Prefixes: `['apex-os://', 'https://apexos.app']`
- Config:
  - `Root`: Tab navigator routes
  - `BillingStack`: `receipt/:paymentId` -> `ReceiptScreen`
  - `Auth`: `login`, `signup`

## Code Layout
- `apex-os-mobile/eas.json` (EAS Build profiles)
- `apex-os-mobile/app.json` (Expo & Native App Configuration)
- `apex-os-mobile/metro.config.js` (Metro Bundler Configuration)
- `apex-os-mobile/assets/` (Icons, Splash, Adaptive Icons)
- `apex-os-mobile/metadata/store-metadata.json` (App Store & Play Store Listing Metadata)
- `apex-os-mobile/App.tsx` (Root Provider, Navigation, Error Boundary)
- `apex-os-mobile/src/components/common/ErrorBoundary.tsx` (Global Error Boundary Component)
- `apex-os-mobile/src/theme/tokens.ts` (Unified Design Tokens)
- `apex-os-mobile/src/navigation/` (AppNavigator, MainTabNavigator, Route Params)
- `apex-os-mobile/src/screens/` (Dashboard, Profile, Billing, Settings, Deals)
- `apex-os-mobile/__tests__/` (Unit, Component, and Navigation Tests)
