# 09 — Exchange Partner Integrations & Shadow Governance

**Status:** `VERIFIED_BY_EXECUTION` (code & shadow gate) / `BLOCKED_EXTERNAL_DEPENDENCY` (live partner credentials & 30-day live shadow data).

---

## 1. Exchange Matrix

| Exchange | Tier / Mode | Code & Poller Status | Live Activation Status |
|----------|-------------|----------------------|------------------------|
| **Bybit** | Tier-1 Official Partner | `VERIFIED_BY_EXECUTION` (`phase2-ws-a-partner-poller.test.ts`) | `BLOCKED_EXTERNAL_DEPENDENCY` (production API keys & contract) |
| **OKX** | Tier-1 Official Partner | `VERIFIED_BY_EXECUTION` | `BLOCKED_EXTERNAL_DEPENDENCY` (production API keys & contract) |
| **Bitget** | Tier-1 Official Partner | `VERIFIED_BY_EXECUTION` | `BLOCKED_EXTERNAL_DEPENDENCY` (production API keys & contract) |
| **KuCoin** | Shadow-Gated (`PARTNER_KUCOIN_LIVE = false`) | `VERIFIED_BY_EXECUTION` (`shadow-promotion-gate.ts`) | `BLOCKED_EXTERNAL_DEPENDENCY` (30-day clean shadow window required) |
| **Gate.io** | Shadow-Gated (`PARTNER_GATEIO_LIVE = false`) | `VERIFIED_BY_EXECUTION` (`shadow-promotion-gate.ts`) | `BLOCKED_EXTERNAL_DEPENDENCY` (30-day clean shadow window required) |

## 2. Hardening Applied in This Cycle

- Trailing 30-day window volume check enforced (`windowReconciledRows > 0 && windowMappedUids > 0`).
- Production/staging guard enforced on poller test clock override (`src/app/api/admin/reconciliation/poller/route.ts`).
- Both `PARTNER_KUCOIN_LIVE` and `PARTNER_GATEIO_LIVE` remain strictly disabled (`false`).
