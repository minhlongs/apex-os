# Gate G1 — Waterfall & Split Policy Reconciliation

## Executive Outcome

Phase 1 (`src/lib/ledger/waterfall.ts` and `src/database/migrations/028_ascendancy_audit_core.sql`) established a mathematically sound, zero-sum **Safe-Spread Waterfall (`10^8` fixed-point `bigint` units)** as the canonical financial engine, while legacy documentation, i18n copy (`en.json`, `vi.json`), UI components, and legacy affiliate endpoints still advertise conflicting `30% / 10% / 5%` (or `20% / 10% / 5%`) 3-tier MLM splits, blocked `Binance` webhooks, and unsupported `Ethereum / Solana` payout rails.

All Phase 2 surfaces, APIs, i18n strings, and top-level docs (`README.md`, `CLAUDE.md`) reconcile strictly to the **single canonical Safe-Spread Waterfall** in `src/lib/ledger/waterfall.ts` without modifying Phase 1's core math invariants:
- **Gross Verified Partner Commission (`C`, `100.00%`)** — minted strictly after `CASH_COLLECTED` reconciliation (`|allocated - clawback - wallet_cash| <= $0.01`).
- **Clawback Reserve (`R`, `5.00%` of `C`, `ceil`)** — credited to `reserve:clawback_pool` first.
- **Distributable Pool (`D = C - R`, `95.00%` of `C`)** — split into:
  - **Trader Self-Rebate (`T`, `50.00%` of `D` = `47.50%` of `C`, `floor`)** — credited to `trader:<id>`.
  - **Platform Gross Spread (`S = D - T`, `47.50%` of `C`)** — allocated as:
    - **L1 Direct Affiliate (`A1`, `30.00%` of `S` = `14.25%` of `C`, `floor`)** when referred (`0` when unreferred).
    - **L2 B2B Agency Override (`A2`, default `0%`; strictly `<= 10.00%` of `S` = `<= 4.75%` of `C`, `floor`)** **only** when an active, approved B2B Agency Contract (`b2b_agency_contracts`) governs the referral; never consumer MLM.
    - **L3+ Multi-Tier (`A3`, hard-locked `0%`)** — any non-zero `tier3ShareOfSpread` throws `InvalidWaterfallConfigError` (`HTTP 422`).
    - **Platform Net Treasury (`P = S - A1 - A2`, `33.25%` of `C` default; `28.50%` of `C` at max `10%` B2B override; `47.50%` of `C` when unreferred)** — absorbs integer rounding dust so `R + T + A1 + A2 + P === C` holds with zero drift on every transaction.

---

## 1. Canonical Safe-Spread Waterfall Specification (Invariant I4)

Source of truth: `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/ledger/waterfall.ts` (`lines 68–82, 117–309`).

| Leg | Ledger Account Pattern | Share of Pool | Effective % of Gross Commission (`C`) | Rounding Rule | Policy Guard |
|---|---|---|---|---|---|
| Gross Verified Commission (`C`) | `system:partner_receivable` (`DEBIT`) | `100%` of verified cash | `100.00%` | Exact `10^8` integer | Requires `MATCHED` `partner_cash_reconciliations` row |
| Clawback Reserve (`R`) | `reserve:clawback_pool` (`CREDIT`) | `5.00%` of `C` | `5.00%` | `ceilDiv` (conservative reserve) | `0 < rate <= 50%` |
| Trader Self-Rebate (`T`) | `trader:<profile_id>` (`CREDIT`) | `50.00%` of `D` (`0.95 C`) | `47.50%` | `floor` | `0 <= rate <= 90%` |
| L1 Direct Affiliate (`A1`) | `affiliate:<profile_id>` (`CREDIT`) | `30.00%` of `S` (`0.475 C`) | `14.25%` (`0%` if unreferred) | `floor` | `A1 + A2 <= 45%` of `S` |
| L2 B2B Agency Override (`A2`) | `agency:<agency_profile_id>` (`CREDIT`) | `0.00%` default (`<= 10.00%` of `S`) | `0.00%` default (`<= 4.75%` max) | `floor` | Requires active `b2b_agency_contracts` policy; `<= 10%` of `S` |
| L3+ Sub-Affiliate (`A3`) | Forbidden | `0.00%` | `0.00%` | Hard-rejected | `InvalidWaterfallConfigError` (`HTTP 422`) |
| Platform Net Revenue (`P`) | `treasury:platform_revenue` (`CREDIT`) | Remainder `S - A1 - A2` | `33.25%` (referred) / `28.50%` (max B2B) / `47.50%` (direct) | Exact residual | Must be `> 0` whenever `C >= $0.01`; guarantees exact zero-sum |

### Numerical Verification Example (`C = $100.00` = `10_000_000_000` units)
1. **Standard Direct Referral (`hasDirectAffiliate = true`, `hasB2bAgencyPartner = false`):**
   - Reserve `R` = `$5.00` (`500_000_000`), Trader `T` = `$47.50` (`4_750_000_000`), L1 Affiliate `A1` = `$14.25` (`1_425_000_000`), L2 Agency `A2` = `$0.00` (`0`), Platform Net `P` = `$33.25` (`3_325_000_000`). Sum = `$100.00` (`10_000_000_000`).
2. **Approved B2B Agency Partner at Max `10%` Spread Override (`tier2ShareOfSpread = '0.10'`):**
   - Reserve `R` = `$5.00`, Trader `T` = `$47.50`, L1 Affiliate `A1` = `$14.25`, L2 Agency `A2` = `$4.75` (`475_000_000`), Platform Net `P` = `$28.50` (`2_850_000_000`). Sum = `$100.00`.
3. **Unreferred Self-Rebate Trader (`hasDirectAffiliate = false`):**
   - Reserve `R` = `$5.00`, Trader `T` = `$47.50`, L1 `A1` = `$0.00`, L2 `A2` = `$0.00`, Platform Net `P` = `$47.50` (`4_750_000_000`). Sum = `$100.00`.

---

## 2. Contradiction Matrix & Phase 2 Reconciliation Plan

| Contradicting Surface | Files Identified | Legacy / Conflicting Claim | Phase 2 Canonical Resolution |
|---|---|---|---|
| `README.md` & `CLAUDE.md` | `README.md:9, 47-49`; `CLAUDE.md:7, 97, 110, 199` | Mixes Safe-Spread on line 9 with `30% / 10% / 5%` 3-tier MLM and `Ethereum / Solana / Stellar` on lines 47–49; `CLAUDE.md` cites `Binance` webhooks and 3-tier `30/10/5%`. | Update `README.md` and `CLAUDE.md` to state single-tier `14.25%` L1 (`30%` of `47.5%` spread), `47.50%` trader self-rebate, `5%` clawback reserve, `0%` consumer L2/L3 (optional `<= 10%` spread B2B agency contract), `Bybit / OKX / Bitget / KuCoin / Gate.io` (Binance Referral Pro blocked `403`), and `USDC` on `Arbitrum / Base / Stellar` (`$10.00` min withdrawal, `T+7` hold, `48h` wallet timelock). |
| Bilingual i18n Messages | `src/i18n/messages/en.json` & `vi.json` (`lines 20, 43-44, 419, 449-464, 674-676, 1239-1240`) | Advertises `3-tier referral network (30% / 10% / 5%)`, `Binance`, and `Ethereum / Solana / Stellar`. | Reconcile `en.json` and `vi.json` in lockstep with Phase 2 Trader Portal, Admin Console, Legal disclosures, and Safe-Spread terminology (`47.5%` trader rebate, `14.25%` direct referral, `USDC` on `Stellar / Arbitrum / Base`). |
| Web UI & Stitch Surfaces | `src/app/[locale]/layout.tsx`, `landing/page.tsx`, `dashboard/affiliates/affiliates-client.tsx`, `telegram-app-client.tsx`, `src/components/stitch/StitchCashbackCockpit.tsx` | Hardcoded `30%/10%/5%` or `20%/10%/5%` 3-tier UI badges and Ethereum/Solana wallet copy. | Update user-facing metadata/referral copy and deliver the new clean-room Trader Rebate Portal (`/[locale]/portal/**`) & Admin Ops Console (`/[locale]/admin/ops/**`) backed directly by `10^8` Phase 1 ledger views. |
| Wallet & Profile Chain Types | `src/types/profile.ts`, `src/lib/wallet/wallet-utils.ts` | Lists `ethereum`, `solana`, `bsc`, `polygon` while omitting `stellar` or mixing legacy chains. | Align Phase 2 portal wallet binding strictly with `timelock-wallet-service.ts` (`SupportedSettlementChain = 'stellar' | 'arbitrum' | 'base'`, `48h` timelock, OFAC & shared-wallet anti-Sybil check). |
| Partner Exchange Registry vs SQL | `028_ascendancy_audit_core.sql` (`bybit, okx, bitget, kucoin, gateio`) vs `src/lib/partners/registry.ts` (`bybit, okx, bitget` only) | `kucoin` and `gateio` exist in SQL `CHECK` constraints and `short_links`, but throw unsupported adapter errors in `registry.ts` and `reconciliation/ingest`. | Implement `kucoin-affiliate-adapter.ts` and `gateio-affiliate-adapter.ts` in `src/lib/partners/`, register all 5 exchanges in `registry.ts` (keeping `binance_referral_pro` hard-blocked `403`), and wire all 5 into the HTTP Partner Poller. |
| Ad-hoc B2B Override & Role Mapping | `src/app/api/admin/reconciliation/ingest/route.ts` & `settlement/dispatch/route.ts` | `b2bAgencyId` is passed ad-hoc without a persisted D1 contract table; `profiles.role` lacks `'agency'`/`'trader'` while `master_trader` is unmapped in `dispatch`. | Add `b2b_agency_contracts` table in `031_ascendancy_phase2_ui_and_poller.sql` (`max 10%` spread override enforced at SQL + service levels) and normalize `expectedOwnerTypeForRole` so `shopper`/`trader`/`master_trader` map cleanly without breaking legacy `profiles` rows. |

---

## Unresolved Questions

None for Gate G1. The Phase 1 Safe-Spread Waterfall (`src/lib/ledger/waterfall.ts`) is authoritative and mathematically verified across all split scenarios.
