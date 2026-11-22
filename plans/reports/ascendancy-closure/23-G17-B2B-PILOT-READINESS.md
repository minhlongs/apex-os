# 23 — G17/G18 B2B Commercial Evidence & Pilot Readiness Roadmap (PDF R11)

**Date:** 2026-11-22  
**Status:** `READY_FOR_FOUNDER_COMMERCIAL_EXECUTION` (All external partner, legal, and pilot tracks remain **`BLOCKED_EXTERNAL`** — zero fabricated agreements, zero live credentials, zero real trades executed).

---

## 1. Milestone A — Authorized Partner Readiness Register

| Requirement | Bybit | OKX | Bitget | Evidence Status |
|-------------|-------|-----|--------|-----------------|
| Legal partner / affiliate agreement | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | Pending Founder execution |
| Authorized read-only API scope | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | Zero live keys stored |
| Commission reporting endpoint / adapter | Adapter built (`src/lib/partners/`) | Adapter built (`src/lib/partners/`) | Adapter built (`src/lib/partners/`) | `VERIFIED_IN_CODE` (offline) |
| Trader UID linkage (`trader_exchange_uids`) | Schema `031` ready | Schema `031` ready | Schema `031` ready | `VERIFIED_BY_EXECUTION` (local) |
| Settlement currency | USDC / USDT (exchange-side) | USDC / USDT (exchange-side) | USDC / USDT (exchange-side) | Confirm in signed contract |
| Actual cash receipt evidence | **None ($0 collected)** | **None ($0 collected)** | **None ($0 collected)** | `BLOCKED_EXTERNAL` |
| Fee schedule & tier verification | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | Confirm in partner portal |
| Clawback / wash-trading terms | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | Default 5% T+7 reserve in code |
| Geographic / jurisdictional restrictions | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | Requires legal review |
| Shadow partners (KuCoin / Gate.io) | N/A | N/A | N/A | Hard-locked behind 30-day zero-discrepancy gate (`shadow-promotion-gate.ts`) |

---

## 2. Milestone B — Controlled 48-Hour Commission Experiment Protocol (NOT EXECUTED)

> **Hard Stop:** Do **NOT** execute automatically. Requires separate written Founder authorization, jurisdictional legal clearance, and exchange partner-program permission confirming self/test referral rules are not violated.

### Read-Only Evidence Collector Contract
1. **Scope:** 3 small, legitimate, pre-authorized trades (1 per approved partner exchange) using compliant test accounts.
2. **Captured Artifacts (stored in R2 with SHA-256 provenance, zero credentials in logs):**
   - Official UID linkage confirmation screenshot/API response (`uid_hash`, masked `***1234`).
   - Trade execution receipt (`trade_id`, `timestamp_utc`, `notional_usd`, `fee_paid_usd`).
   - Official partner portal/API commission statement (`gross_commission_units_1e8`).
   - Exchange wallet cash-settlement deposit receipt (`deposit_tx_id`, `wallet_cash_collected_units`).
3. **Pass Criteria:**
   - `|uid_allocated_units - wallet_cash_collected_units| <= 1_000_000n` (`$0.01` tolerance).
   - Waterfall I4 ledger simulation matches `R + E_trader + E_L1 + E_L2 + platformNet === C` to the exact `10^-8` unit.
   - Zero manual balance edits required.

---

## 3. Milestone C — 30-Day B2B Pilot Scorecard (G18 Target)

| KPI | Target Gate | Measurement Method | Current Status |
|-----|-------------|--------------------|----------------|
| Signed B2B agency pilot agreements | `>= 1` pilot partner | Executed contract (`b2b_agency_contracts`) | `BLOCKED_EXTERNAL` (0) |
| Active verified traders | `>= 30` traders | Distinct mapped UIDs with verified volume | `BLOCKED_EXTERNAL` (0) |
| EOD reconciliation accuracy | `>= 99.9%` | Automated `partner_cash_reconciliations` discrepancy ratio | Code ready; 0 live days |
| Proof-of-Rebate API verification | `100%` R2 SHA-256 match | `GET /api/b2b/proof-of-rebate?verifyR2=true` | Code ready; D1 rate-limit PR queued |
| Founder operational load | `<= 20h` → `< 16h` / 100 accounts | Weekly ops time log | Unmeasured until pilot |
| Payout safety invariant | `0` unverified payouts, `0` cap breaches | `HOT_EXPOSURE_SQL` + `cold_settlement_claims` + `payout_effect_grants` | Verified offline |

---

## 4. Non-Negotiable External Blockers Before Any Real Funds

1. **Legal & Compliance:** Corporate entity, Decree 40/2018/ND-CP & jurisdictional legal memo, Terms of Service, KYC/sanctions policy.
2. **Partner Contracts:** Signed Bybit/OKX/Bitget affiliate agreements + production read-only API credentials.
3. **Custody & Signing:** Turnkey production organization + HSM policy + Safe (Gnosis) multisig cold vaults (Arbitrum/Base) + Stellar multisig cold vault + **pre-cutover `TurnkeyServerHsmTransport` bounded timeout/error classification PR**.
4. **Release Gates:** Founder merge of PR #56 → remote D1 backup → sequential `031`–`036` migration → staging soak with `AUTO_SETTLE_PAYOUTS = false`.
