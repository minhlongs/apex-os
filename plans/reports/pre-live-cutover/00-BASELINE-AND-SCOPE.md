# 00 — G23.0 Baseline & Scope Reconstruction (PR A: Pre-Live-Cutover Hardening)

**Date:** 2026-11-22  
**Repository:** `minhlongs/apex-os`  
**Verified Base (`origin/master`):** `0ffa2c027d0f0afdffac1c08b285e88a96464945`  
**Merged PR #56:** `MERGED` at `2026-11-22T09:51:36Z` (parents: `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d` + `d5f793d9256eb804f15dcbd21201d8bafa61c02a`)  
**Post-Merge CI:** Run #145 (`45009576507`) — `SUCCESS` (`2026-11-22T09:51:39Z`)  
**Isolated Worktree:** `/Users/macbook/apex-os-worktrees/pr-a-pre-live-cutover-hardening`  
**Feature Branch:** `fix/apex-pre-live-cutover-hardening`  
**Runtime:** Node `v26.7.0`, `gh` authenticated (`minhlongs`)

---

## 1. Baseline Verification
- `git rev-parse origin/master` = `0ffa2c027d0f0afdffac1c08b285e88a96464945` (exact match).
- All 7 PR #56 audit commits (`262b070a`..`d5f793d9`) are present on `master`.
- Latest D1 migration on `master`: `src/database/migrations/036_durable_hot_exposure.sql` (**`037` does not exist**).
- Financial boundaries remain disabled: `AUTO_SETTLE_PAYOUTS="false"`, `V1_STELLAR_ONLY_PAYOUTS="true"`, `PARTNER_KUCOIN_LIVE='false'`, `PARTNER_GATEIO_LIVE='false'`, `0/4` `TURNKEY_*` secrets.

---

## 2. Deferred High Mapping to PR A Scope & Acceptance Criteria

| Deferred High | Exact Code Location | PR A Workstream | Acceptance Criteria |
|---|---|---|---|
| **H6** | `TurnkeyServerHsmTransport` (`src/lib/payouts/turnkey-signer.ts:379-471`) | **G23.1 (Commit 1)** | Bounded 10–15s timeout via `AbortController`/race; explicit 6-state outcome classification (`DEFINITE_REJECTED`, `SIGNED_CONFIRMED`, `UNCERTAIN_OUTCOME`, `CONFIGURATION_ERROR`, `POLICY_DENIED`, `TRANSIENT_READ_ERROR`); zero blind retries on `UNCERTAIN_OUTCOME`; durable withdrawal lock preservation; 12 mandatory negative tests. |
| **H1** | `StellarService.processBatchPayouts` (`src/lib/payouts/stellar-service.ts:925`) | **G23.2 (Commit 2)** | Hard-disabled fail-closed (`LegacyPayoutPathDisabledError`); full call-graph audit; `LEGACY_PAYOUT_EXECUTION = 0`; regression test asserting zero signing, zero broadcast, zero ledger mutation. |
| **H2 + H3** | `src/lib/payouts/turnkey-signer.ts:822,1066`; `src/lib/ledger/units.ts`; `src/lib/ledger/double-entry-ledger.ts:2013`; `src/lib/payouts/stellar-service.ts:380`; `src/lib/payouts/adapters/arbitrum-base-usdc-adapter.ts:255` | **G23.3 (Commit 3)** | Replace raw `Number(bigint)` with `toSafeSqlInteger`; dust-safe conversion & explicit chain-alignment guards; preserve canonical dust remainder as customer liability; full regression matrix proving `ORIGINAL_LIABILITY = VERIFIED_SETTLEMENT + REMAINING_LIABILITY + VALID_REVERSALS`. |
| **G17 Trigger & Finality** | `src/database/migrations/035_payout_effect_grants.sql`, `036_durable_hot_exposure.sql`, `src/lib/payouts/broadcast-recovery-machine.ts:1400`, `worker-wrapper.js:247` | **G23.4 (Commit 4)** | Additive `037_hardening_trigger_and_exposure.sql`: bind `NEW.payout_id` in `WITHDRAWAL_REVERTED` trigger guards; ensure `UNVERIFIED_HOT → HOT` records verified finality timestamp unconditionally without stale/malformed timestamp leaks; local migration drill (fresh + 001–036 + historical/edge cases + rollback). |
| **Token Scope** | `.github/workflows/deploy.yml`, `wrangler.jsonc`, `wrangler.staging.jsonc` | **G23.5 (Commit 5)** | Document least-privilege `staging` vs `production` Cloudflare token segmentation plan (`TOKEN_SEGMENTATION_PLAN_READY`); zero secret values read or mutated. |
| **H4 + H5** | Remote D1 rollout (`031`–`037`) | **Out of Scope (Runbook Only)** | Documented in local drill & remote rollout runbook; **zero** remote D1 migrations executed in PR A. |
| **H7** | PWA PNG icons (`public/manifest.json`) | **Out of Scope (PR B)** | Deferred to independent Public PWA / GA Hygiene PR B. |
