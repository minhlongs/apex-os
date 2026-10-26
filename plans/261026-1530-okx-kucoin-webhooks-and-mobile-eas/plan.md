---
title: "OKX & KuCoin Exchange Webhooks + Profile Exchange Key Linking & Mobile EAS Distribution Polish"
description: "Stream 1 (apex-os): Profile external_ids exchange API key linking, OKX/KuCoin webhook secret & deal pass-through hardening, and end-to-end webhook tests. Stream 2 (apex-os-mobile): Type-safe expo.config.ts, app.json & eas.json alignment, and deep-link/EAS config verification tests."
status: completed
priority: P1
effort: 3h
branch: feat/okx-kucoin-exchange-linking-and-mobile-eas
tags: [webhooks, okx, kucoin, profile, mobile, eas, deep-links]
created: 2026-10-26
---

# Plan: OKX & KuCoin Exchange Webhooks + Profile Exchange Key Linking & Mobile EAS Distribution Polish

## 1. Objective & Scope

Execute Option 3 (Both streams in parallel with `--ship`) from the Strategic Roadmap:

### Track 1 — `apex-os` (OKX & KuCoin Exchange Webhooks + Profile Exchange Key Linking)
1. **Migration `027_profiles_external_ids.sql`**:
   - Add `external_ids TEXT DEFAULT '{}'` to `profiles` and index `json_extract` lookup performance (with full D1 backup requirement before any live DB change).
2. **Profile Exchange API Key Linking Endpoint (`src/app/api/profile/exchange-keys/route.ts`)**:
   - `GET /api/profile/exchange-keys`: Return linked exchange API key identifiers (`okx`, `kucoin`, `binance`, `bybit`) from `profiles.external_ids` for the authenticated user.
   - `POST /api/profile/exchange-keys`: Validate and bind an exchange `api_key_id` (and optional `label`) into `profiles.external_ids` JSON (`$.okx.api_key_id`, `$.kucoin.api_key_id`, etc.) and optionally store encrypted key in `user_api_keys` (`ByokProvider` extended with `'okx' | 'kucoin'`).
   - `DELETE /api/profile/exchange-keys`: Unbind a linked exchange `api_key_id` from `profiles.external_ids`.
   - Extend `GET /api/profile` & `PATCH /api/profile` in `src/app/api/profile/route.ts` to expose `externalIds` (`external_ids`) cleanly without `:any`.
3. **OKX & KuCoin Webhook Hardening (`src/app/api/webhooks/exchange/okx/route.ts` & `kucoin/route.ts`)**:
   - Resolve `process.env.OKX_WEBHOOK_SECRET` and `process.env.KUCOIN_WEBHOOK_SECRET` dynamically per-request inside `verify*SignatureInternal` and `GET()` rather than only at module initialization time.
   - Pass already-resolved `deal` (`cashback_percent`) into `createConversion` to avoid redundant `findDeal` DB queries.
   - Support fallback header extraction (`x-okx-api-key` / `ok-access-key` and `x-kc-api-key` / `kc-api-key`) for API key lookup.
4. **End-to-End Integration Tests (`src/__tests__/webhooks/okx-kucoin-e2e-flow.test.ts`)**:
   - Verify full flow: `POST /api/profile/exchange-keys` links `okx` and `kucoin` `api_key_id` -> `POST /api/webhooks/exchange/okx` and `POST /api/webhooks/exchange/kucoin` match user via `external_ids`, match active deal & deal click, record conversion & tiered earnings, and enforce idempotency/replay protection.

### Track 2 — `apex-os-mobile` (Mobile EAS Distribution, Config Type-Safety & Deep-Link Polish)
1. **Type-Safe `expo.config.ts` & `app.json` Synchronization**:
   - Remove `as any` from `expo.config.ts` and type with `ExpoConfig` (or strict typed interface).
   - Align `ios.bundleIdentifier` (`com.apexos.app`), `ios.infoPlist.LSApplicationQueriesSchemes` (`['metamask', 'phantom', 'xportal']`), `android.package` (`com.apexos.app`), `android.adaptiveIcon.backgroundColor` (`#0A0A0A`), `plugins` (`['expo-secure-store', 'expo-notifications']`), and environment-aware `extra.apiUrl` (`process.env.EXPO_PUBLIC_API_URL`) across `expo.config.ts` and `app.json`.
2. **Deep-Link Parser Polish (`src/utils/deep-links.ts`)**:
   - Support universal HTTPS deep links (`https://apex-os.pages.dev/...` and `https://apex-os.com/...`) in addition to custom scheme `apex-os://...`, plus referral code deep links (`apex-os://referral?code=APEXVIP`).
3. **Unit Tests (`__tests__/eas-config-and-deeplinks.test.ts`)**:
   - Verify `eas.json` profiles (`development`, `preview`, `production`), `app.json` & `expo.config.ts` parity (zero `:any`, matching bundle/package IDs, wallet query schemes, dark splash/adaptiveIcon `#0A0A0A`), and universal/referral deep-link parsing.

## 2. Acceptance Criteria

- [x] Zero `:any` types and zero `console.log` in production code across both repositories.
- [x] `apex-os-mobile`: `npm run type-check` passes with 0 errors and `npm test` passes 100%.
- [x] `apex-os`: `npx tsc --noEmit`, `npm run lint`, `npm test`, and `bash scripts/go-live-gate.sh` pass 100%.
- [x] GitHub Issue created, labeled, PR shipped, reviewed, merged, and CI verified green on `master`.
