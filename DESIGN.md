# DESIGN.md — ApexOS ("Obsidian Quant & Cyber-Cashback Terminal")

**Project ID:** `11542622336933833737` (`projects/11542622336933833737`)  
**Design System Asset:** `assets/16812736714591355271` (`ApexOS Obsidian Quant & Cyber-Cashback`)  
**Primary Device:** `DESKTOP` (with dedicated `MOBILE` companion for Telegram Mini App)

---

## 1. Visual Philosophy & Brand Identity

**ApexOS** is a **Global Crypto Cashback, Cross-Exchange Arbitrage & Multi-Chain Settlement Hub** running on Cloudflare Workers, D1, R2, and KV. Its visual language — **Obsidian Quant & Cyber-Cashback Terminal** — fuses institutional quantitative trading density (basis-point `bps` spread matrices, maker/taker order blend sliders, double-entry D1 ledger reservation) with high-trust Web3 fintech clarity (Stellar XLM/USDC, Ethereum ERC-20 USDC/USDT, Solana SPL USDC, 30-day rolling KYC compliance gates, and native Telegram Mini App viral loops). Every screen supports bilingual switching (`[EN | VI]`) and tabular monospace precision.

---

## 2. Color Palette & Atmospheric Tokens

| Role | CSS Token | Hex | Usage |
|------|-----------|-----|-------|
| App Canvas (Night Sky Obsidian) | `--color-neutral-950` | `#020617` | Primary dark-first application canvas |
| Elevated Card / Panel Surface | `--color-neutral-900` | `#0F172A` | Bento KPI cards, exchange rate matrices, sidebar & inspector docks |
| Interactive Well / Hover Surface | `--color-neutral-800` | `#1E293B` | Table row hover, slider tracks, filter pills, input containers |
| Structural Hairline Border | `--color-neutral-700` | `#334155` | `1px solid` card borders and tabular dividers (`rgba(99, 102, 241, 0.25)` active glow) |
| Primary Brand Indigo | `--color-primary` | `#6366F1` | Primary CTAs, active navigation, Tier 1 (30%) commission badges |
| Secondary Neural Violet | `--color-secondary` | `#8B5CF6` | Supporting actions, Tier 2 (10%) commission badges, VIP exchange promos |
| Cyber Cashback & Arbitrage Cyan | `--color-accent` | `#06B6D4` | Basis-point (`bps`) spread highlights, cashback rebates, interactive links |
| Positive Earnings & Healthy Reserve | `--color-earnings-positive` | `#10B981` | Settled USDC earnings, `HEALTHY` treasury reserves, verified HMAC webhooks |
| Pending & Low-Reserve Warning | `--color-earnings-pending` | `#F59E0B` | Pending conversions, `LOW_RESERVE` gas warnings, KYC Tier 1 ceiling alerts |
| Compliance / Fraud Block Crimson | `--color-earnings-negative` | `#EF4444` | OFAC SDN `compliance_blocked`, velocity burst IP blocks, `CRITICAL` circuit breaker |
| Stellar Network Accent | `--color-stellar-theme` | `#14B8A6` | Stellar Horizon XLM/USDC settlement badges |
| USDC Stablecoin Accent | `--color-usdc` | `#2775CA` | Circle USDC balance tags across ERC-20 / SPL / Stellar |
| Solana SPL Accent | `--color-solana` | `#14F195` | Solana SPL USDC high-speed settlement indicators |
| Text Primary | `--color-neutral-50` | `#F8FAFC` | Headlines, primary numerals, active table cells |
| Text Secondary / Muted | `--color-neutral-400` | `#94A3B8` | Bilingual subtitles, timestamps, axis labels |

---

## 3. Typography Scale

- **Headings (`Space Grotesk`, 600–700, `-0.02em` tracking):**
  - `H1 (Page Title)`: `30px / 36px` (`--text-3xl`)
  - `H2 (Section Header)`: `24px / 32px` (`--text-2xl`)
  - `H3 (Card Title)`: `18px / 24px` (`--text-lg`)
- **Bilingual UI & Body (`Inter`, 400–600):**
  - `Body`: `14px / 20px` (`--text-sm`)
  - `Compact Badge / Uppercase Label`: `12px / 16px` (`--text-xs`, `0.025em` tracking)
- **Financial, Spread & On-Chain Monospace (`JetBrains Mono`, 500–600, `tabular-nums`):**
  - Used for all USDC/USDT/XLM balances, basis-point (`bps`) spreads, maker/taker percentages, EIP-55 / Base58 / Stellar addresses, and SHA-256 idempotency hashes.

---

## 4. Layout, Geometry & Shell Architecture

- **Card Geometry:** `12px` (`rounded-xl`) border-radius with `1px solid #1E293B` hairline border, subtle top specular highlight (`rgba(255,255,255,0.06)`), and ambient dark shadow (`0 10px 30px rgba(2,6,23,0.65)`).
- **Control Geometry:** `8px` (`rounded-lg`) for buttons, inputs, and selector tabs; `9999px` pill badges for chain/health/KYC status.
- **Touch & Accessibility Baseline:** Minimum `44px` interactive target height on controls, visible `:focus-visible` Indigo/Cyan ring, and WCAG 2.1 AA contrast ($\ge 7.1:1$ on `#020617`).
- **Unified Desktop Shell:**
  - `248px` fixed left sidebar with ApexOS logo (`Global Crypto Cashback & Arbitrage Hub`), navigation links (`1. Cashback & Affiliate Cockpit`, `2. Arbitrage & Deal Crawler`, `3. Multi-Chain Payout Rails`, `4. KYC & Fraud Command`, `5. Telegram Mini App`, `6. Style Guide`), and live Treasury Reserve mini-meter.
  - `64px` sticky top command header with `[EN | VI]` bilingual toggle, active tier badge (`MASTER TIER — 30%/10%/5%`), Multi-Chain Treasury Health pill (`3/3 Chains HEALTHY`), and connected wallet pill (`0x71C...9A4F` / `HN7c...4P9q`).

---

## 5. Signature Component Contracts

1. **Cross-Exchange Arbitrage & Yield Matrix (`ArbitrageFinder`):** Interactive volume slider (`$10k–$1M`), maker/taker blend slider, live fee spread calculation ($\text{spreadBps} = (\text{netBase} - \text{netTarget}) \times 10,000$), canonical `$810/yr` benchmark badge, and 1-click exchange routing across Binance, Bybit, OKX, and KuCoin.
2. **Multi-Chain Treasury & Batch Settlement Console (`TreasuryHealthService` + `BatchSettlementService`):** Displays Stellar (`XLM/USDC`), Ethereum (`ERC-20 USDC/USDT` + EIP-1559 gas floor), and Solana (`SPL USDC` + compute budget) hot-wallet reserves, Auto-Pause Circuit Breaker gate, and D1 atomic two-phase batch reservation (`$50` threshold, SHA-256 idempotency key).
3. **KYC Rolling Tier & Sanctions / Fraud Shield (`SanctionsScreeningService`):** 30-day rolling payout ceiling meters (`$500` Unverified / `$2,500` Basic / `$50,000+` Enhanced), OFAC SDN address pre-flight validator, and dual-window click velocity burst (`<2s` delta, `150 clicks/hr` auto-block) audit table.
4. **Telegram Mini App (TMA) Viral Pod (`telegram-app-client`):** Mobile touch deck with HMAC-SHA256 `initData` badge, 1-tap `/start ref_<code>` viral referral link generator (`+$5.00` bonus), and Olympic Podium Leaderboard.

---

## 6. Stitch Prompt Design System Block (Copy Verbatim into Every Prompt)

```markdown
**DESIGN SYSTEM (REQUIRED):**
- **Theme:** Obsidian Quant & Cyber-Cashback Terminal ("ApexOS — Global Crypto Cashback, Arbitrage & Multi-Chain Settlement Hub")
- **Canvas Background:** `#020617` (Night Sky Obsidian `--color-neutral-950`)
- **Card / Panel Surface:** `#0F172A` (`--color-neutral-900`) with `1px solid #1E293B` border, `12px` border-radius, and subtle top specular edge
- **Interactive Well / Hover Surface:** `#1E293B` (`--color-neutral-800`) with `#334155` structural dividers
- **Primary Text:** `#F8FAFC` | **Muted Text:** `#94A3B8`
- **Primary Brand Accent:** `#6366F1` (Apex Indigo) | **Secondary Accent:** `#8B5CF6` (Neural Violet) | **Cashback & Arbitrage Highlight:** `#06B6D4` (Cyber Cyan)
- **Semantic & Chain Accents:** `#10B981` (USDC Emerald / Healthy), `#F59E0B` (Amber Pending / Low Reserve), `#EF4444` (Crimson Compliance/Fraud Block), `#14B8A6` (Stellar XLM), `#2775CA` (USDC), `#14F195` (Solana SPL)
- **Typography:** `Space Grotesk` (bold, `-0.02em` tracking) for headings, `Inter` for bilingual English + Vietnamese (`EN | VI`) UI labels, `JetBrains Mono` (`tabular-nums`) for basis-point spreads (`bps`), USDC/USDT/XLM amounts, EIP-55 / Base58 / Stellar wallet addresses, and SHA-256 idempotency hashes
- **Shell Consistency:** Keep a consistent `248px` left navigation sidebar (1. Cashback Cockpit, 2. Arbitrage & Deal Crawler, 3. Multi-Chain Payouts, 4. KYC & Fraud Command, 5. Telegram Mini App, 6. Style Guide) and a `64px` top command bar with `[EN | VI]` locale toggle, `MASTER TIER` badge, and `3/3 Chains HEALTHY` circuit-breaker status pill.
```
