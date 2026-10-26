---
title: "Multi-Chain Treasury UI, Priority Fees & Mobile Wallet UI + Offline Cache"
description: "Stream 1 (apex-os-mobile): Wire WalletService into WalletConnect & add Affiliate/Team offline cache. Stream 2 (apex-os): Solana ComputeBudget + TransferChecked support & Admin Multi-Chain Treasury Dashboard."
status: completed
priority: P1
effort: 4h
branch: feat/multichain-treasury-ui-and-priority-fees
tags: [payouts, solana, treasury, admin-ui, mobile, wallet, offline-cache]
created: 2026-10-26
---

# Plan: Multi-Chain Treasury UI, Priority Fees & Mobile Wallet UI + Offline Cache

## 1. Objective & Scope

Execute Option 3 (Both streams in parallel with `--ship`) from the 3-Pillar Strategic Roadmap:

### Track A — `apex-os-mobile` (Mobile Wallet UI Deep-Link & Offline Cache)
1. **Wire `WalletService` into `WalletConnect.tsx`**:
   - Replace hardcoded `ethereum://` scheme with `metamask://` via `WALLET_CONFIGS` and `launchWallet(wallet)` from `src/services/wallet-service.ts`.
   - Preserve existing manual fallback modal when wallet cannot be opened.
2. **Offline Cache Service (`src/services/affiliate-cache.ts`)**:
   - Provide resilient read/write caching for `AffiliateDashboard` and `TeamMember[]` using `expo-secure-store` with in-memory fallback and timestamp metadata.
   - Integrate into `AffiliateDashboardScreen.tsx` and `TeamTreeScreen.tsx` so cached stats and referral tree render immediately on offline/network failure with a clear offline cache indicator.
3. **Unit Tests**:
   - Add `__tests__/wallet-connect-and-cache.test.tsx` verifying `WalletConnect` deep-link invocation (`metamask`, `phantom`, `xportal`), fallback modal behavior, and `affiliate-cache` read/write/fallback behavior.

### Track B — `apex-os` (Solana ComputeBudget / TransferChecked & Admin Treasury Dashboard)
1. **Solana ComputeBudget Priority Fee & `TransferChecked` Support (`src/lib/payouts/adapters/solana-adapter.ts`)**:
   - Add optional `includePriorityFee?: boolean` and `useTransferChecked?: boolean` config options to `SolanaAdapterConfig`.
   - When `includePriorityFee` is enabled, include `ComputeBudget` `SetComputeUnitLimit` and `SetComputeUnitPrice` instructions in the serialized transaction message.
   - When `useTransferChecked` is enabled, build `TransferChecked` (instruction 12) with mint account (`usdcMintAddress`) and `USDC_DECIMALS` (6).
   - Keep default behavior backward-compatible with existing wire serialization tests while adding dedicated unit tests for priority fee and `TransferChecked` instruction compilation.
2. **Admin Multi-Chain Treasury & Payout Preview Dashboard (`src/app/[locale]/admin/treasury/`)**:
   - Server page `src/app/[locale]/admin/treasury/page.tsx` with `requireAdmin()` guard and i18n provider.
   - Client component `src/app/[locale]/admin/treasury/treasury-dashboard-client.tsx` wired to `GET /api/admin/payouts/treasury` and `POST /api/admin/payouts/batch` (preview & dry-run execution).
   - Add Treasury navigation item in `src/components/admin/admin-nav.tsx` and i18n keys in `src/i18n/messages/en.json` and `src/i18n/messages/vi.json`.
3. **Unit Tests**:
   - Add `src/lib/payouts/__tests__/solana-priority-and-treasury.test.ts` testing ComputeBudget instructions, `TransferChecked` encoding/message accounts, and treasury dashboard helper logic.

## 2. Acceptance Criteria

- [x] Zero `:any` types and zero `console.log` in production code across both repositories.
- [x] `apex-os-mobile`: `npm run type-check` passes with 0 errors and `npm test` passes 100%.
- [x] `apex-os`: `npx tsc --noEmit`, `npm run lint`, `npm test`, and `bash scripts/go-live-gate.sh` pass 100%.
- [x] GitHub Issue created, labeled, PR shipped, reviewed, merged, and CI verified green on `master`.
