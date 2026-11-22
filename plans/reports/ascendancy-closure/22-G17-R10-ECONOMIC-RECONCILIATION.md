# 22 — G17 PDF R10 Unit Economics Reconciliation & Stress Analysis

**Date:** 2026-11-22 (Revised under G19.2 & G19.3)  
**Authoritative Code Baseline:** `src/lib/ledger/waterfall.ts` (`DEFAULT_WATERFALL_CONFIG`, Safe-Spread Waterfall Formula I4)  
**Authoritative Corrected Reconciliation:** See `plans/reports/ascendancy-closure/27-G19-R10-CORRECTED-UNIT-ECONOMICS.md` and `src/lib/ledger/__tests__/r10-unit-economics-reconciliation.test.ts` (`4/4 PASS`).  
**Correction Notice (G19.2):** The initial G17 draft of this file inferred expenses by subtracting historical PDF FCF from Safe-Spread I4 retained allocation, which preserved the old FCF baseline by construction. Section 2 and Section 3 below have been corrected to hold PDF R10 (Page 69–70) cost lines constant (`Variable + Fixed Infra + Replacement CAC`) without manufacturing implied expenses.

---

## 1. Authoritative Safe-Spread Waterfall I4 Formula (Code vs. Model)

From `src/lib/ledger/waterfall.ts:68-74,232-268`:
- **Clawback Reserve (`R`):** `ceil(5.00% × C)` = **5.00% of Gross `C`**
- **Distributable Pool (`D`):** `C - R` = **95.00% of `C`**
- **Trader Cashback (`E_trader`):** `floor(50.00% × D)` = **47.50% of `C`**
- **Platform Spread (`S`):** `D - E_trader` = **47.50% of `C`**
- **L1 Direct Affiliate (`E_L1`):** `floor(30.00% × S)` = **14.25% of `C`**
- **B2B Agency Override (`E_L2`):** `0.00%` retail default; max `10.00% × S` = **4.75% of `C`** (explicit B2B contract only)
- **L3 Tier (`E_L3`):** **`0.00%` HARD-LOCKED** (implemented product policy hard-lock; external legal classification and B2B L2 eligibility under current applicable Vietnamese MLM law remain subject to independent legal counsel review)
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
| Variable costs (PDF Page 69–70) | $76.35 | $181.25 | $602.64 | PDF R10 assumption (held constant) |
| Fixed infrastructure (PDF Page 69–70) | $35.00 | $45.00 | $95.00 | PDF R10 assumption (held constant) |
| Replacement CAC (PDF Page 69–70) | $405.00 | $672.00 | $1,584.00 | PDF R10 assumption (held constant) |
| **Total PDF modeled monthly costs** | **$516.35** | **$898.25** | **$2,281.64** | Sum of source PDF cost lines |
| Original PDF modeled monthly FCF | -$390.01 | +$684.79 | +$10,066.36 | PDF R10 historical baseline |
| **Recalculated Retail I4 monthly FCF** | **-$385.08** | **+$649.87** | **+$11,404.06** | **`PlatformNet - TotalPDFCosts` (`bigint`)** |
| PDF modeled LTV/CAC | 0.12x | 2.09x | 7.42x | PDF R10 (degrades proportionally in BASE under I4; exact churn formula `source-pending`) |
| Founder hrs per 100 accounts | `source-pending` | `source-pending` | `source-pending` | Target operational ceiling: `≤20h → <16h / 100 accounts` |

### B. Max B2B Agency Mix (`L2 = 10% of S = 4.75% of C`, Retained = `28.50%` of `C`)

| Metric | BEAR | BASE | BULL |
|--------|-----:|-----:|-----:|
| B2B L2 override (`4.75%`) | $18.75 | $221.16 | $1,955.10 |
| **Platform-retained allocation (`28.50%`)** | **$112.52** | **$1,326.96** | **$11,730.60** |
| **Recalculated Max B2B L2 monthly FCF (holding PDF costs constant)** | **-$403.83** | **+$428.71** | **+$9,448.96** |
| Margin delta vs. Retail I4 | -$18.75/mo | -$221.16/mo | -$1,955.10/mo |

---

## 3. Eleven-Scenario Stress Test

Superseded by the corrected BASE Retail I4 (`+$649.87` FCF / `$898.25` PDF costs) 11-scenario stress matrix in `plans/reports/ascendancy-closure/27-G19-R10-CORRECTED-UNIT-ECONOMICS.md` Section 4.

---

## 4. Honest Commercial Conclusion

1. **Ledger Solvency ≠ Business Profitability:** The Safe-Spread Waterfall I4 guarantees positive unit contribution (`33.25%` retail / `28.50%` max B2B) on every verified dollar collected. However, **BEAR (`50` traders, `$394.80` gross) remains FCF-negative (`-$385.08` Retail / `-$403.83` Max B2B)** even at 100% cash collection.
2. **Minimum Commercial Viability Threshold:** Holding BASE PDF monthly costs (`$898.25/mo`) constant, operating breakeven requires **`$2,701.50/mo`** in verified gross partner commissions under Retail I4 (`33.25%`) or **`$3,151.75/mo`** under Max B2B L2 (`28.50%`).
3. **Unverified External Inputs:** Actual exchange commission tiers, real trader retention, and CAC remain **0% empirically validated** until G18 Milestone A/B/C produce real cash-receipt evidence.
