# GTM Playbook: ApexOS Institutional Quant-First

> **Version:** 1.0.0  
> **Status:** Active / Production GTM  
> **Target Audience:** Algorithmic Trading Desks, Family Offices, Prop Shops, Hedge Funds, Quantitative Asset Managers  
> **Jurisdictions:** Global (excluding OFAC sanctioned entities)  
> **Languages:** English / Tiếng Việt

---

## 1. Executive Summary & Value Proposition

### 1.1 The Core Problem: Invisible Quant Execution Drag
Systematic and algorithmic trading operations generate high-velocity transaction flow ($10M – $200M+ monthly notional volume across perpetuals, spot, and options). In crypto market microstructure:
- Traditional VIP fee schedules leave between **2.7 and 12.0 basis points (bps)** on the table in unrecovered liquidity provider and taker fees.
- Spread erosion and exchange fee drift silently degrade backtested Sharpe ratios by **0.25 to 0.70**.
- Standard retail affiliate desks demand invasive, insecure practices: custody sharing, API secret key sharing, or manual OTC reconciliation.

### 1.2 The ApexOS Solution
ApexOS establishes an institutional basis-point fee recovery infrastructure across tier-1 execution venues (**Binance, Bybit, OKX, KuCoin**):
1. **Zero-Secret API Key ID Verification**: Clients link accounts using only public exchange Key IDs or subaccount UIDs. **Zero API secrets, zero withdrawal permissions, zero execution takeover risk**.
2. **Deterministic Settlement Rail**: Algorithmic rebates are tracked via exchange partner subaccount webhooks and settled weekly with cryptographic proofs in **Stellar USDC (5-second finality, <$0.001 fees)** or local fiat via **VietQR / SePay**.
3. **Multi-Tier Liquidity Desk Attribution**: Institutional syndicates earn a structured 3-tier cascade (`30% Tier 1 / 10% Tier 2 / 5% Tier 3`) on all programmatic flow routed through verified subaccounts.

---

## 2. Ideal Customer Profile (ICP) & Segmentation

| Tier | Category | Monthly Volume (Notional) | Target Venues | Primary Pain Point | ApexOS Pitch |
|---|---|---|---|---|---|
| **Tier A: Systematic Prop Desks** | HFT, StatArb, Market Makers | > $50M / month | Binance, Bybit, OKX | Exchange fee tiers compress alpha margins below infrastructure costs. | Dedicated basis-point fee recovery up to 12.0 bps with automated subaccount routing. |
| **Tier B: Quantitative Funds** | Momentum, Trend Following, Cross-Exchange Arb | $10M – $50M / month | Binance, OKX, KuCoin | Regulatory and operational compliance forbids sharing API secrets or custodial links. | Zero-Secret Public Key ID audit verification with signed settlement statements. |
| **Tier C: Algorithmic Retail / Syndicates** | Grid traders, DCA bots, Telegram trading groups | $1M – $10M / month | Bybit, KuCoin, OKX | Fragmented rebate portals with slow monthly payouts and non-transparent tracking. | Automated weekly USDC or VietQR settlement with real-time analytics terminal. |

---

## 3. Core Positioning & Messaging Pillars

### Pillar 1: Quantitative Alpha Protection (Basis Points Matter)
- *Positioning*: Every basis point of fee leakage is pure loss off the fund's bottom line.
- *Message*: "Stop donating 2.7 to 12.0 bps to exchanges. ApexOS recaptures execution drag into balance-sheet cashflow."

### Pillar 2: Cryptographic & Operational Security (Zero Secrets)
- *Positioning*: Institutional desks must never surrender operational security for financial rebates.
- *Message*: "We never ask for your API secrets or private keys. Public Key ID verification proves volume attribution without granting order or withdrawal permissions."

### Pillar 3: Verifiable, High-Cadence Settlement
- *Positioning*: Monthly manual OTC spreadsheets are obsolete.
- *Message*: "Weekly programmatic settlement. Receive audited USDC on Stellar or instant VietQR transfers, accompanied by cryptographic settlement proofs."

---

## 4. Multi-Channel GTM Execution Strategy

```
Phase 1: Inbound Technical Authority (Weeks 1–4)
├── Launch /[locale]/insights (Microstructure, Security, Liquidity attribution articles)
├── Deploy SEO Schema.org TechArticle & SoftwareApplication metadata
└── Syndicate quant research on Substack, Mirror, and institutional LinkedIn

Phase 2: Targeted Desk Outreach & Outbound (Weeks 3–8)
├── High-touch outreach to 100 systematic trading teams in APAC and EU
├── Offer complimentary "Execution Drag Audit" (analyzing 30-day fills for recoverable bps)
└── Partner with algorithmic trading software & bot platforms (Hummingbot, Freqtrade, CCXT)

Phase 3: Liquidity Desk Referral Cascade (Weeks 6–12)
├── Activate Tier 1 desk partners into the 30% / 10% / 5% liquidity attribution program
├── Enable custom subaccount referral links (`/api/tracking/click?deal_id=...&ref=...`)
└── Launch Weekly On-Chain Settlement Transparency Reports
```

---

## 5. Sales Funnel & Desk Conversion Flow

1. **Discovery / Audit Request**: Desk visits `/[locale]/insights` or `/[locale]/deals`, reviews the live rebate matrix, and requests a Basis-Point Leakage Audit.
2. **Subaccount Binding**: Desk generates a fresh subaccount or binds an existing UID with ApexOS desk broker codes on Binance, Bybit, OKX, or KuCoin.
3. **Public Key Verification**: Desk inputs public Key ID into the ApexOS Terminal (`/[locale]/terminal`). ApexOS verifies partner tag status via read-only partner API.
4. **Execution & Telemetry**: Desk trades normally through their low-latency colocated infrastructure.
5. **Weekly Settlement**: Every Monday 00:00 UTC, ApexOS reconciles attributed volume and disburses USDC on Stellar or VietQR fiat payouts.

---

## 6. Success Metrics & KPIs

- **Trading Volume Attributed**: $250M+ annualized run-rate within 90 days.
- **Client Acquisition Cost (CAC)**: < $150 per verified quantitative desk.
- **Gross Fee Recovery Delivered**: > $500,000 in annualized rebates returned to trading desks.
- **Platform Churn Rate**: < 2% monthly retention churn due to sticky automated settlement.
