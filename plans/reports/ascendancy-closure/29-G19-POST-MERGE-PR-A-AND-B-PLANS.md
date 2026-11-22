# Post-Merge Workstream Plan & Issue Specifications (PR A & PR B)

**Date:** 2026-11-22  
**Prerequisite Base Branch:** Post-merge `master` (ONLY branch and publish AFTER Founder explicitly merges PR #56 into `master`; do NOT stack on unmerged `feat/ascendancy-phase2-verified`).  
**Deployment Guard:** Neither PR creates production deployment workflows or enables `AUTO_SETTLE_PAYOUTS`.

---

## PR A — Pre-Live-Cutover Hardening (Mandatory BEFORE Any Real HSM / USDC Activity)

### Proposed GitHub Issue Spec
- **Title:** `feat(treasury): pre-live-cutover HSM timeout fencing, dust boundary guards, and withdrawal trigger hardening`
- **Labels:** `security`, `treasury`, `pre-live-blocker`
- **Base Branch:** `master` (post-merge PR #56)
- **Dependency:** Blocked on PR #56 merge into `master`.

### Exact Scope & Disjoint File Ownership
1. **Turnkey HSM Transport Bounded Timeout & Error Classification**
   - Files: `src/lib/payouts/turnkey-signer.ts`
   - Work: Enforce `AbortController` bounded timeout (`10–15s`), disable automatic retries/redirects on signing POST requests, classify failures into `DEFINITE_REJECTED` (pre-signing rejection / 4xx) vs `UNCERTAIN_OUTCOME` (timeout / network drop / 5xx after dispatch), never blindly retry `UNCERTAIN_OUTCOME`, propagate request IDs for manual/reconciler recovery.
2. **Legacy Money-Moving Bypass Removal**
   - Files: `src/lib/payouts/stellar-service.ts`, any legacy callers in `src/app/api/payouts/` or `src/app/api/admin/payouts/`
   - Work: Hard-disable `StellarService.processBatchPayouts` (throw fail-closed error directing to Turnkey HSM + double-entry ledger pipeline) so no code path can bypass `payout_effect_grants` or `HOT_EXPOSURE_SQL`.
3. **Lossless BigInt & Monetary Boundary Hardening**
   - Files: `src/lib/payouts/turnkey-signer.ts`, `src/lib/ledger/double-entry-ledger.ts`, `src/lib/payouts/stellar-service.ts`, `src/lib/payouts/adapters/arbitrum-base-usdc-adapter.ts`, `src/lib/payouts/settlement-dispatcher.ts`
   - Work: Replace `Number(bigint)` with `toSafeSqlInteger` (`turnkey-signer.ts:822,1066`); assert `residualDust1e8 === 0n` at `lockSettledForWithdrawal`, `ledgerUnits1e8ToStellarStroops`, `ledgerUnits1e8ToEvmUsdcUnits`; enforce `lock.gross_commission_units === disbursableUnits1e8` in hot-lane settlement; preserve canonical dust remainder accounting.
4. **Withdrawal Trigger Identity & Hot Finality Timestamps**
   - Files: `src/database/migrations/037_hardening_trigger_and_exposure.sql` (new additive migration — never edit applied `035`/`036`), `src/lib/payouts/settlement-reconciler.ts`, `worker-wrapper.js`
   - Work: Bind `NEW.payout_id` in `WITHDRAWAL_REVERTED` trigger guard; set `confirmation_observed_at = unixepoch('now')` unconditionally on `UNVERIFIED_HOT → HOT` finality promotion; align `worker-wrapper.js:247` flag check to `!== 'true'`.
5. **Adversarial Tests & Independent Review**
   - Files: `src/lib/payouts/__tests__/turnkey-hsm-timeout-classification.test.ts`, `src/lib/payouts/__tests__/legacy-payout-disabled.test.ts`, `src/lib/payouts/__tests__/freeze-and-old-reservation-race.test.ts`
   - Work: Test timeout classification, unknown-outcome no-retry invariant, legacy bypass rejection, old pending reservations + freeze race, and complete independent review of HSM signing call graph.

### Definition of Done (PR A)
- [ ] Zero unauthorized signing paths; `StellarService.processBatchPayouts` hard-disabled.
- [ ] Zero duplicate transfers; `UNCERTAIN_OUTCOME` never auto-retried.
- [ ] Zero unsupported/lossy financial amount conversions (`Number(bigint)` eliminated, dust boundary assertions enforced).
- [ ] Exact `10^-8` ledger conservation verified across all tests.
- [ ] Independent financial security review returns `PASS` with 0 Critical/High findings.

---

## PR B — Public PWA / GA Hygiene (Mandatory BEFORE Public Customer Launch)

### Proposed GitHub Issue Spec
- **Title:** `chore(ga): durable D1 Proof-of-Rebate rate limiting, valid PWA icons, CI SHA pinning, and legal copy alignment`
- **Labels:** `ga-hygiene`, `security`, `pwa`, `ci`
- **Base Branch:** `master` (post-merge PR #56)
- **Dependency:** Blocked on PR #56 merge into `master` (independent of PR A; disjoint file ownership).

### Exact Scope & Disjoint File Ownership
1. **Durable D1 Rate Limiting for Proof-of-Rebate**
   - Files: `src/app/api/b2b/proof-of-rebate/route.ts`, `src/__tests__/api/b2b-proof-of-rebate-rate-limit.test.ts`
   - Work: Replace in-memory `checkSlidingWindowRateLimit` at `route.ts:218` with shared D1 `enforcePersistentD1RateLimit` (migration `032`); add cross-isolate, concurrent, tenant-isolation, expired-window, malformed-identity, and fail-closed tests.
2. **Real 192px / 512px PNG PWA Icons & Manifest Integrity**
   - Files: `public/assets/icons/icon-192.png`, `public/assets/icons/icon-512.png`, `public/manifest.json`, `src/__tests__/sandbox/g11-security-compliance.test.ts`
   - Work: Generate valid 192×192 and 512×512 PNG assets matching `manifest.json` dimensions/MIME type; add disk-existence + PNG header + dimension assertion in test suite.
3. **GitHub Actions Upgrade, SHA Pinning & Least-Privilege Permissions**
   - Files: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
   - Work: Upgrade `actions/checkout` and `actions/setup-node` to Node 24-compatible major versions, pin every third-party action to full 40-char commit SHA, and declare explicit `permissions: { contents: read }` at workflow/job level.
4. **Repair Skipped Resend Mock Test**
   - Files: `src/__tests__/lib/notifications/notification-channels.test.ts`
   - Work: Fix Jest module hoisting + Resend constructor mock at line `368` so `0` tests are skipped across the entire suite.
5. **Audit-Friendly Legal/UI Copy Alignment (G19.3 Code Follow-up) & Public API Privacy Verification**
   - Files: `src/app/[locale]/legal/terms/page.tsx`, `src/app/[locale]/legal/geo-restriction/page.tsx`, `src/i18n/messages/en.json`, `src/i18n/messages/vi.json`, `src/components/b2b/proof-of-rebate-verifier.tsx`, `src/components/admin/treasury/b2b-agency-contracts-panel.tsx`, `src/lib/ledger/waterfall.ts`, `src/lib/ledger/b2b-agency-contracts.ts` (error-string + test updates)
   - Work: Replace remaining self-asserted `Decree 40/2018/ND-CP compliance` strings in runtime UI/i18n/legal pages with product-policy hard-lock wording separating software restriction from external counsel classification; verify public APIs expose zero customer financial PII; confirm responsive web/PWA accessibility without expanding into native mobile redesign.

### Definition of Done (PR B)
- [ ] GitHub CI 100% green with `0` skipped tests and SHA-pinned Node 24 actions.
- [ ] Cross-isolate D1 rate-limit controls verified on `/api/b2b/proof-of-rebate`.
- [ ] Real `192×192` and `512×512` PNG icons verified on disk and matching `manifest.json`.
- [ ] Zero public-service Critical/High security or PII-exposure issues.
- [ ] Public legal/UI copy cleanly separates product restriction from external legal classification.
