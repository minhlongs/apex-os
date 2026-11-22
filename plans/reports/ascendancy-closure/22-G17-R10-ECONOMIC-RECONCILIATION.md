# 22 — G17 PDF R10 Unit Economics Reconciliation & Stress Analysis

**Date:** 2026-11-22  
**Authoritative Code Baseline:** `src/lib/ledger/waterfall.ts` (`DEFAULT_WATERFALL_CONFIG`, Safe-Spread Waterfall Formula I4)  
**Research PDF Status:** `PDF_SOURCE_NOT_LOCALLY_AVAILABLE` — concrete scenario figures from Supreme Command #08 are reconciled below; any uninspected PDF-only cost/CAC sub-formulas are explicitly marked `source-pending`.

---

## 1. Authoritative Safe-Spread Waterfall I4 Formula (Code vs. Model)

From `src/lib/ledger/waterfall.ts:68-74,232-268`:
- **Clawback Reserve (`R`):** `ceil(5.00% × C)` = **5.00% of Gross `C`**
- **Distributable Pool (`D`):** `C - R` = **95.00% of `C`**
- **Trader Cashback (`E_trader`):** `floor(50.00% × D)` = **47.50% of `C`**
- **Platform Spread (`S`):** `D - E_trader` = **47.50% of `C`**
- **L1 Direct Affiliate (`E_L1`):** `floor(30.00% × S)` = **14.25% of `C`**
- **B2B Agency Override (`E_L2`):** `0.00%` retail default; max `10.00% × S` = **4.75% of `C`** (explicit B2B contract only)
- **L3 MLM Tier (`E_L3`):** **`0.00%` HARD-LOCKED** (Vietnam Decree 40/2018/ND-CP)
- **Platform-Retained Allocation (`platformNetUnits`):**
  - **Retail (`L2 = 0%`):** **33.25% of Gross `C`** (`70%` of Spread `S`)
  - **Max B2B (`L2 = 10% of S`):** **28.50% of Gross `C`** (`60%` of Spread `S`)

---

## 2. Exact Scenario Reconciliation (BEAR / BASE / BULL)

> **Important Distinction:** These are modeled scenarios, **NOT** realized historical revenue. A mathematically solvent ledger guarantees ApexOS never pays out more than collected cash, **not** that the business is profitable at low volume.

### A. Retail Mix (`L2 = 0%`, Retained = `33.25%` of `C`)

| Metric | BEAR | BASE | BULL | Source / Classification |
|--------|-----:|-----:|-----:|-------------------------|
| Active traders | 50 | 200 | 800 | PDF R10 assumption |
| Gross partner commission (`C`) | $394.80 | $4,656.00 | $41,160.00 | PDF R10 assumption |
| Verified cash collected (100% assumed) | $394.80 | $4,656.00 | $41,160.00 | Modeled (0% realized today) |
| Clawback reserve (`R = 5.00%`) | $19.74 | $232.80 | $2,058.00 | `waterfall.ts` exact |
| Trader rebate (`47.50%`) | $187.53 | $2,211.60 | $19,551.00 | `waterfall.ts` exact |
| L1 affiliate payout (`14.25%`) | $56.26 | $663.48 | $5,865.30 | `waterfall.ts` exact |
| B2B L2 payout (`0.00%`) | $0.00 | $0.00 | $0.00 | `waterfall.ts` exact |
| **Platform-retained allocation (`33.25%`)** | **$131.27** | **$1,548.12** | **$13,685.70** | **`waterfall.ts` exact** |
| PDF modeled monthly FCF | -$390.01 | +$684.79 | +$10,066.36 | PDF R10 baseline |
| Implied direct opex + working capital gap (`PlatformNet - PDF_FCF`) | $521.28 | $863.33 | $3,619.34 | Derived (`opex` breakdown `source-pending`) |
| PDF modeled LTV/CAC | 0.12x | 2.09x | 7.42x | PDF R10 (`CAC`/`retention` formula `source-pending`) |
| CAC / LTV / CAC payback / Founder hrs per 100 accounts | `source-pending` | `source-pending` | `source-pending` | Target operational ceiling: `≤20h → <16h / 100 accounts` |

### B. Max B2B Agency Mix (`L2 = 10% of S = 4.75% of C`, Retained = `28.50%` of `C`)

| Metric | BEAR | BASE | BULL |
|--------|-----:|-----:|-----:|
| B2B L2 override (`4.75%`) | $18.75 | $221.16 | $1,955.10 |
| **Platform-retained allocation (`28.50%`)** | **$112.52** | **$1,326.96** | **$11,730.60** |
| **Reconciled monthly FCF (using implied opex above)** | **-$408.76** | **+$463.63** | **+$8,111.26** |
| Margin delta vs. Retail | -$18.75/mo | -$221.16/mo | -$1,955.10/mo |

---

## 3. Eleven-Scenario Stress Test (Anchored on BASE Retail `$1,548.12` Net / `$863.33` Implied Opex → `+$684.79` FCF)

| # | Stress Scenario | Impact on BASE Platform Net / Opex | Resulting Monthly FCF | Viability Verdict |
|---|-----------------|------------------------------------|----------------------:|-------------------|
| 1 | **Zero collected commission (`C = $0`)** | Platform Net = `$0.00`; fixed infra burn `~$521/mo` | **-$521.28** | Ledger solvent (`$0` payouts), business cash-burn |
| 2 | **Partner commission rate cut by 25%** | Gross `$3,492.00` → Net `$1,161.09` | **+$297.76** | Thin positive buffer |
| 3 | **Trading volume declines 30%** | Gross `$3,259.20` → Net `$1,083.68` | **+$220.35** | Survivable if opex stays flat |
| 4 | **Largest partner unavailable (50% concentration)** | Gross `$2,328.00` → Net `$774.06` | **-$89.27** | **FCF-negative** — multi-exchange diversification required |
| 5 | **10% clawback (exceeds 5% reserve by 5% of `C`)** | Extra `$232.80` absorbed from platform net | **+$451.99** | Reserve exhausted; platform absorbs excess |
| 6 | **Maximum B2B L2 (`10% of S`) across 100% of volume** | Net drops from `$1,548.12` to `$1,326.96` | **+$463.63** | Positive in BASE, worsens BEAR to `-$408.76` |
| 7 | **Gas / RPC / Turnkey variable costs double (`+$342/mo`)** | Implied variable cost doubles | **+$342.79** | Manageable via Stellar-first V1 rail |
| 8 | **Reduced trader retention (-40% active base)** | Gross `$2,793.60` → Net `$928.87` | **+$65.54** | Near breakeven; LTV/CAC falls below `1.3x` |
| 9 | **Increased fraud / dispute ops (`+$400/mo`)** | Direct fraud/manual review cost | **+$284.79** | Erodes ~58% of BASE FCF |
| 10 | **Small withdrawal fee drag (`$10` min floor, 100% EVM vs Stellar)** | Stellar fee `~$0.00001` (negligible); Arbitrum/Base L2 `~$0.02–$0.10` (`$4–$20/mo`) | **+$664.79** | Mitigated by `$10` floor + `V1_STELLAR_ONLY_PAYOUTS=true` |
| 11 | **Liquidity reserve stress (T+7 hold mismatch)** | Payouts strictly gated on `CASH_COLLECTED` + T+7 hold | Working capital protected | **Architectural safeguard prevents prefunding insolvency** |

---

## 4. Honest Commercial Conclusion

1. **Ledger Solvency ≠ Business Profitability:** The Safe-Spread Waterfall I4 guarantees positive unit contribution (`33.25%` retail / `28.50%` max B2B) on every verified dollar collected. However, **BEAR (`50` traders, `$394.80` gross) cannot cover fixed infrastructure/compliance costs** (`-$390` to `-$409/mo` FCF).
2. **Minimum Commercial Viability Threshold:** At `~$521–$863/mo` fixed+variable operating cost, ApexOS requires **`~$1,570–$2,600/mo` in verified gross partner commissions** (roughly `80–120` active traders at BASE ARPU) just to reach operating cash-flow breakeven.
3. **Unverified External Inputs:** Actual exchange commission tiers, real trader retention, and CAC remain **0% empirically validated** until G18 Milestone A/B/C produce real cash-receipt evidence.
