# 27 — G19 Corrected R10 Unit Economics & Sensitivity Reconciliation

**Date:** 2026-11-22  
**Authoritative Code Baseline:** `src/lib/ledger/waterfall.ts` (`DEFAULT_WATERFALL_CONFIG`, Safe-Spread Waterfall Formula I4)  
**Deterministic Test Proof:** `src/lib/ledger/__tests__/r10-unit-economics-reconciliation.test.ts` (`4/4 PASS`, pure `10^-8` `bigint` arithmetic — zero floating-point drift)  
**Supersedes:** Section 2 & Section 3 implied-opex derivation in `plans/reports/ascendancy-closure/22-G17-R10-ECONOMIC-RECONCILIATION.md`

---

## 1. Defect Corrected from Report 22

Report `22` previously computed `Implied Opex = Platform Retained Allocation (I4) - Original PDF FCF`. That construction **forced the recalculated model to preserve the historical PDF FCF by identity**, masking the true economic shift between the PDF's original margin assumptions and the implemented Safe-Spread Waterfall I4 (`33.25%` retail / `28.50%` max B2B).

This report replaces that flawed method with the direct, source-derived formula holding **PDF R10 Page 69–70** cost assumptions constant:

```text
Modeled FCF = Platform Retained Allocation (I4) - Variable Costs - Fixed Infrastructure - Replacement CAC
```

> **Mandatory Disclosure:** All figures below are **PDF research scenario assumptions**, NOT actual company financial results (actual realized partner commission today is **$0**). Furthermore, these sensitivity numbers hold PDF Page 69–70 costs constant and do **not** yet incorporate a full cost recalibration for changed customer, partner, or payout behavior.

---

## 2. Source PDF R10 (Page 69–70) Cost Assumptions vs. Safe-Spread I4

All calculations executed in `10^-8 USD` integer units via `computeSafeSpreadWaterfall` (`waterfall.ts`) and rounded half-away-from-zero to USD cents only for presentation.

| Line Item (USD / month) | BEAR (50 traders) | BASE (200 traders) | BULL (800 traders) | Classification |
|---|---:|---:|---:|---|
| **Collected Gross Commission (`C`)** | **$394.80** | **$4,656.00** | **$41,160.00** | Modeled assumption (`$0` realized) |
| Restricted 5% Clawback Reserve (`R = ceil(5% × C)`) | $19.74 | $232.80 | $2,058.00 | Restricted liability (T+7 hold, NOT revenue) |
| Trader Cashback Obligation (`47.50% × C`) | $187.53 | $2,211.60 | $19,551.00 | Customer obligation (payable) |
| L1 Direct Affiliate Obligation (`14.25% × C`) | $56.26 | $663.48 | $5,865.30 | Partner obligation (payable) |
| B2B L2 Agency Override — Retail (`0.00%`) / Max B2B (`4.75%`) | $0.00 / $18.75 | $0.00 / $221.16 | $0.00 / $1,955.10 | Contractual B2B obligation only |
| L3 Tier (`E_L3`) | **$0.00** | **$0.00** | **$0.00** | Hard-locked `0%` in code (product policy) |
| **Platform Retained Allocation — Retail I4 (`33.25%`)** | **$131.27** | **$1,548.12** | **$13,685.70** | Gross platform allocation (before opex) |
| **Platform Retained Allocation — Max B2B I4 (`28.50%`)** | **$112.52** | **$1,326.96** | **$11,730.60** | Gross platform allocation (before opex) |
| Variable Costs (PDF Page 69–70) | $76.35 | $181.25 | $602.64 | PDF research assumption |
| Fixed Infrastructure (PDF Page 69–70) | $35.00 | $45.00 | $95.00 | PDF research assumption |
| Replacement Acquisition Cost / CAC (PDF Page 69–70) | $405.00 | $672.00 | $1,584.00 | PDF research assumption |
| **Total Modeled Monthly Costs (Held Constant)** | **$516.35** | **$898.25** | **$2,281.64** | Sum of 3 PDF cost lines |

### Headline FCF Sensitivity Comparison (USD / month)

| Scenario | BEAR | BASE | BULL | Delta vs. Original PDF (BEAR / BASE / BULL) |
|---|---:|---:|---:|---|
| **Original PDF FCF** | **-$390.01** | **+$684.79** | **+$10,066.36** | Baseline |
| **Retail I4 FCF (`33.25%` retained)** | **-$385.08** | **+$649.87** | **+$11,404.06** | `+$4.93` / `-$34.92` / `+$1,337.70` |
| **Max B2B L2 FCF (`28.50%` retained)** | **-$403.83** | **+$428.71** | **+$9,448.96** | `-$13.82` / `-$256.08` / `-$617.40` |

> **Exact sub-cent note (BEAR):** Retail I4 exact `platformNetUnits` is `$131.271` (`13_127_100_000n`), minus `$516.35` = `-$385.079` (`-$385.08`). Max B2B exact `platformNetUnits` is `$112.518` (`11_251_800_000n`), minus `$516.35` = `-$403.832` (`-$403.83`). BASE and BULL are exact to the cent (`0` sub-cent remainder).

---

## 3. Separate Financial & Accounting Reconciliations

1. **Platform Gross Allocation vs. Recognized Revenue:**
   - Gross partner commission `C` is **not** platform revenue. Under Safe-Spread I4, `61.75%` (Retail) to `66.50%` (Max B2B) of `C` is immediately encumbered as customer/partner obligations (`47.50%` trader + `14.25%` L1 + up to `4.75%` B2B L2), and `5.00%` is segregated as a restricted clawback reserve.
   - Only `platformNetUnits` (`33.25%` Retail / `28.50%` Max B2B) represents net platform-retained allocation eligible for operating expense coverage, subject to accounting treatment review by external CPA/counsel.
2. **Restricted 5% Clawback Reserve (`R`):**
   - `R = ceil(5% × C)` (`$19.74` BEAR / `$232.80` BASE / `$2,058.00` BULL) is excluded from FCF above. It is held in T+7 escrow to absorb exchange clawbacks/wash-trading reversals and cannot be spent as free cash flow until matured and unencumbered.
3. **Customer & Partner Obligations:**
   - Total payable liabilities (`E_trader + E_L1 + E_L2`): BEAR `$243.79` (Retail) / `$262.54` (Max B2B); BASE `$2,875.08` / `$3,096.24`; BULL `$25,416.30` / `$27,371.40`. All strictly bounded below `C - R`, proving ledger solvency by construction.
4. **Actual Cash Received vs. Assumed Cash Collection:**
   - Modeled scenarios assume `100%` cash collection. Actual realized cash collected to date is **`$0.00`**. Ledger posting is hard-gated on `CASH_COLLECTED` reconciliation (`reconciliation-service.ts`), preventing prefunding insolvency when exchange payouts lag.
5. **Replacement CAC vs. New-Customer Growth CAC:**
   - The PDF Page 69–70 lines (`$405` BEAR / `$672` BASE / `$1,584` BULL) represent **Replacement CAC** required solely to hold active trader count flat against churn. Scaling from 50 → 200 → 800 traders requires **additional upfront Growth CAC** not deducted from steady-state FCF.
6. **Fixed Operating Costs vs. Variable Costs:**
   - Fixed infra (`$35` / `$45` / `$95`) is low because of Cloudflare Workers/D1 serverless architecture, but **does not include** corporate legal/audit retainers, Turnkey enterprise minimums, or Founder salary. Variable costs (`$76.35` / `$181.25` / `$602.64`) scale with active accounts and payout frequency.
7. **Cash Working-Capital Effects:**
   - Because payouts are gated on `CASH_COLLECTED` + T+7 reserve hold + `$10` withdrawal floor, working capital is structurally **cash-positive** (ApexOS holds float between exchange settlement receipt and user withdrawal), eliminating prefunding drain—provided treasury hot/cold vaults are never over-drawn.
8. **Owner Earnings / FCF vs. Ledger Solvency:**
   - **BEAR is FCF-negative under every mix (`-$385.08` Retail / `-$403.83` Max B2B)** even at 100% cash collection. At BASE cost structure (`$898.25/mo`), breakeven gross partner commission is **`$2,701.50/mo`** (Retail `33.25%`) or **`$3,151.75/mo`** (Max B2B `28.50%`).
9. **Retention, LTV/CAC, and CAC Payback:**
   - Original PDF reported LTV/CAC of `0.12x` (BEAR), `2.09x` (BASE), `7.42x` (BULL). Because Safe-Spread I4 lowers BASE Retail retained margin by `-$34.92/mo` (`-2.2%`) and Max B2B by `-$256.08/mo` (`-16.2%`), **BASE LTV/CAC and CAC payback degrade proportionally** (exact churn/tenure sub-formulas remain `source-pending` until full PDF pages or real G18 pilot cohort data are available).

---

## 4. Corrected 11-Scenario Stress Test (Anchored on BASE Retail I4 `+$649.87` FCF / `$898.25` PDF Costs)

| # | Stress Scenario | BASE Platform Net (`33.25%`) | Total Monthly Costs | Resulting Monthly FCF | Verdict |
|---|---|---:|---:|---:|---|
| 0 | **Baseline (BASE Retail I4)** | $1,548.12 | $898.25 | **+$649.87** | Positive buffer |
| 1 | Zero collected commission (`C = $0`) | $0.00 | $35.00–$516.35 | **-$35.00 to -$516.35** | Ledger solvent (`$0` payout), cash burn |
| 2 | Partner rate reduced 25% | $1,161.09 | $898.25 | **+$262.84** | Thin buffer |
| 3 | Trading volume declines 30% | $1,083.68 | $898.25 | **+$185.43** | Survivable if CAC/variable flat |
| 4 | Largest partner unavailable (-50% rev) | $774.06 | $898.25 | **-$124.19** | **FCF-negative** — multi-exchange mandatory |
| 5 | 10% clawback (exceeds 5% reserve by `$232.80`) | $1,315.32 | $898.25 | **+$417.07** | Reserve exhausted; platform absorbs excess |
| 6 | 100% Max B2B L2 (`28.50%` retained) | $1,326.96 | $898.25 | **+$428.71** | Positive in BASE; BEAR worsens to `-$403.83` |
| 7 | Variable + gas/RPC costs double (`+$181.25`) | $1,548.12 | $1,079.50 | **+$468.62** | Contained by Stellar-first V1 rail |
| 8 | Retention drop (-40% active base) | $928.87 | $898.25 | **+$30.62** | Razor-thin breakeven |
| 9 | Fraud / dispute ops spike (`+$400/mo`) | $1,548.12 | $1,298.25 | **+$249.87** | Erodes ~62% of BASE FCF |
| 10 | Small withdrawal fee drag (100% EVM L2 vs Stellar) | $1,548.12 | $918.25 | **+$629.87** | Mitigated by `$10` floor + `V1_STELLAR_ONLY_PAYOUTS=true` |
| 11 | Liquidity reserve stress (exchange payout delay) | Gated on `CASH_COLLECTED` | Protected | Working capital intact | Architectural gate prevents prefunding insolvency |
