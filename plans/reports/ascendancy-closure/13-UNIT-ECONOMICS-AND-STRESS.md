# 13 — Unit Economics & Macro Sensitivity Audit (R10)

**Status:** `VERIFIED_BY_EXECUTION` (micro-unit accounting & dust) / `PDF_SOURCE_NOT_LOCALLY_AVAILABLE` (R10 Bear/Base/Bull macro stress model).

---

## 1. Verified Micro-Economic Accounting

- Integer micro-unit accounting (`10^-6` USDC for ledger balances, `10^-7` stroops on Stellar wire, `10^-6` ERC-20 base units on Arbitrum/Base) eliminates rounding leakage.
- Dust threshold enforcement prevents negative-margin on-chain payouts where gas/base fees exceed payout value.
- Multi-tier affiliate commission splits (30% / 10% / 5%) preserve positive house spread inside the Safe-Spread Waterfall.

## 2. Uninspected / Follow-Up Gap

- Reviewer E Medium #2: Full Bear/Base/Bull trading-volume sensitivity and break-even CAC/LTV model from R10 of `ApexOS Crypto Affiliate Viability Audit.pdf` is `PDF_SOURCE_NOT_LOCALLY_AVAILABLE` and requires Founder commercial review prior to live capital deployment.
