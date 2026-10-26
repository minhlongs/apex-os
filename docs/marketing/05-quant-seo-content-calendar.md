# Quant SEO & Content Calendar (90-Day Pipeline)

> **Primary Hub:** `/[locale]/insights` & `/[locale]/deals`  
> **Structured Data:** Schema.org `TechArticle`, `SoftwareApplication`, `Organization`  
> **Target Audience:** Algorithmic Traders, Quant Researchers, HFT Engineers, Crypto Fund Managers

---

## 1. Keyword Architecture & Search Intent Cluster

| Cluster | Primary Keywords (EN) | Primary Keywords (VI) | Search Intent | Target Landing Route |
|---|---|---|---|---|
| **Microstructure & Fee Drag** | crypto basis point fee recovery, binance vip taker fee optimization, hft fee drag crypto | tối ưu phí giao dịch binance, hoàn phí giao dịch thuật toán, phí taker maker crypto | Informational / Commercial | `/[locale]/insights/basis-point-fee-drag-quant-execution` |
| **Security & Zero-Secret Verification** | verify exchange volume without api secret, safe crypto rebate portal, read only exchange key id | hoàn phí crypto không cần secret key, bảo mật api giao dịch, liên kết uid nhận hoàn phí | Trust / Technical Evaluation | `/[locale]/insights/zero-secret-api-key-id-verification-architecture` |
| **Liquidity Attribution & Settlement** | institutional crypto affiliate program, stellar usdc rebate settlement, 3 tier crypto liquidity partner | đối tác thanh khoản sàn crypto, hoa hồng giới thiệu sàn 3 tầng, nhận hoàn phí usdc hàng tuần | Commercial / Transactional | `/[locale]/insights/multi-tier-liquidity-attribution-30-10-5-usdc-settlement` |
| **Exchange Rebate Matrix** | binance bybit okx kucoin fee rebate comparison, institutional crypto cashback deals | so sánh hoàn phí binance bybit okx kucoin, danh sách ưu đãi phí giao dịch | Transactional | `/[locale]/deals` |

---

## 2. 90-Day Editorial & Research Calendar

### Month 1: Foundation & Core Microstructure (Shipped in v1.0)
- **Week 1 (Live):** *Basis-Point Fee Drag in Quant Execution: Recapturing 2.7–12.0 bps Across Spot & Perpetuals* (`basis-point-fee-drag-quant-execution`)
- **Week 2 (Live):** *Zero-Secret API Key ID Verification: Eliminating Custodial & Execution Risk in Fee Recovery* (`zero-secret-api-key-id-verification-architecture`)
- **Week 3 (Live):** *Multi-Tier Liquidity Attribution (30/10/5%): Programmatic Settlement via Stellar USDC & VietQR* (`multi-tier-liquidity-attribution-30-10-5-usdc-settlement`)
- **Week 4:** *Binance vs. Bybit VIP Tier Structures: Where Systematic Market Makers Lose Alpha*

### Month 2: Venue-Specific Execution & Bot Ecosystem Guides
- **Week 5:** *OKX & KuCoin Subaccount Routing: Structuring Multi-Venue Arbitrage for Maximum Fee Recovery*
- **Week 6:** *Integrating Hummingbot & Freqtrade with Zero-Secret Subaccount Rebate Tracking*
- **Week 7:** *Quantifying Sharpe Ratio Decay from Unrecovered Perpetual Funding & Taker Fees*
- **Week 8:** *Why Stellar USDC Outperforms ERC-20 Rails for High-Frequency Treasury Rebate Settlement*

### Month 3: Institutional Treasury & Syndicate Scaling
- **Week 9:** *Double-Entry Ledger Accounting for Fund Fee Rebates: Auditing Reconciliations on D1*
- **Week 10:** *Building a Quantitative Trading Syndicate: Monetizing Developer Order Flow with 30/10/5% Cascades*
- **Week 11:** *Slippage vs. Explicit Exchange Fees: Decomposing Implementation Shortfall in Crypto Perpetuals*
- **Week 12:** *Q4 Institutional Crypto Execution Report: Benchmark Fee Recovery Across 4 Tier-1 Venues*

---

## 3. On-Page Technical SEO Checklist

Every new article added to `src/data/quant-insights.ts` automatically inherits:
1. **Static Generation (`generateStaticParams`):** Pre-rendered at build time for both `/vi/insights/[slug]` and `/en/insights/[slug]`.
2. **Hreflang & Canonical Alternates:** Automatic `vi-VN` and `en-US` language alternates plus canonical URLs.
3. **JSON-LD `TechArticle` Injection:** Automatic Schema.org structured data via `generateTechArticleJsonLd`.
4. **Dynamic Sitemap Inclusion:** `src/app/sitemap.ts` iterates over `QUANT_INSIGHT_ARTICLES` so search engines index new articles immediately upon deployment.
5. **Internal Link Graph:** Every article links directly to `/[locale]/terminal` and `/[locale]/deals` to convert technical readers into active accounts.
