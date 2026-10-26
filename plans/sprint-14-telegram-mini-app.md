---
title: "Sprint 14: Telegram Mini App (TMA) & Viral Social Referral Bot"
description: "Embedded Telegram Mini App client, cryptographic initData authentication, @ApexOSBot webhook, viral social referral engine, and direct chat alerts"
status: completed
priority: P0
effort: 40h
branch: feature/sprint-14-telegram-mini-app
tags: [apex-os, sprint-14, telegram, tma, bot, social-referral, viral]
created: 2026-09-29
---

# Sprint 14: Telegram Mini App (TMA) & Viral Social Referral Bot

## Goal
Expand ApexOS's distribution reach into the Telegram ecosystem (900M+ users) by building an edge-rendered, touch-optimized Telegram Mini App (TMA) web client, cryptographic `initData` authentication, an interactive Telegram Bot API webhook (`@ApexOSBot`) supporting `/start ref_<code` viral onboarding, inline deal sharing, group leaderboards, and direct personal chat notification alerts.

---

## Deliverables & Acceptance Criteria

### 1. Telegram Mini App (TMA) Embedded Web Client
- [x] Responsive touch-optimized TMA client at `/[locale]/telegram/app`.
- [x] Integration with Telegram WebApp SDK (CSS theme variables `--tg-theme-*`, viewport resizing, MainButton, HapticFeedback).
- [x] Deals feed with top cashback rates, arbitrage spreads, and 1-click referral link generation.
- [x] Authenticated user dashboard with pending/paid cashback summaries.

### 2. Cryptographic `initData` Authentication & Security
- [x] Edge-compatible HMAC-SHA256 verification of `initData` with Web Crypto API (`SubtleCrypto`).
- [x] Replay attack mitigation (rejecting signatures >24 hours old).
- [x] `POST /api/auth/telegram`: Links Telegram ID/username to ApexOS user profile and wallet.

### 3. Telegram Bot Webhook & Viral Referral Engine
- [x] `POST /api/webhooks/telegram` with `X-Telegram-Bot-Api-Secret-Token` validation.
- [x] Deep-link referral onboarding: `/start ref_<affiliate_code>` automatically binds referee in `telegram_referrals` and `referral_tree`.
- [x] Inline query handler (`@ApexOSBot <query>`) returning structured share cards with deal parameters and affiliate links.
- [x] Bot commands: `/deals`, `/earnings`, `/leaderboard`, `/link`, `/help`.

### 4. Cloudflare D1 Migration (`026_telegram_mini_app.sql`)
- [x] `telegram_users`: Telegram identity, profile association, auth date.
- [x] `telegram_referrals`: Source chat, referral code, conversion tracking.
- [x] `telegram_bot_events`: Immutable audit trail for bot commands and delivery logs.
- [x] High-performance composite indexes and SQLite immutability triggers.

### 5. Chat Notifications & Leaderboard Engine
- [x] Real-time notification forwarding for cashback confirmations and payout dispatches to user's Telegram chat.
- [x] `GET /api/telegram/leaderboard`: Top referrers API with rankings and viral metrics.
- [x] `TelegramLeaderboard.tsx` Olympic podium component.

### 6. Quality & Verification Gate
- [x] 100% automated test pass rate across new TMA, bot, and referral test suites (141 tests in `__tests__/telegram/`).
- [x] 0 regressions across existing test suites (127 passed / 127 suites, 3,168 tests).
- [x] TypeScript typecheck (`tsc --noEmit`) passes with 0 errors.
- [x] ESLint passes with 0 warnings (`npm run lint`).
- [x] Next.js production build (`npm run build`) completes cleanly (70 routes compiled).
- [x] Verified and confirmed by Sentinel Victory Audit (`victory_auditor_8`).
