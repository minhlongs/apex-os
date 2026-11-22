# G24 — Post-Push Security Closure & Founder Review Packet (PR #57)

**Date:** 2026-11-22  
**Repository:** `minhlongs/apex-os`  
**Pull Request:** https://github.com/minhlongs/apex-os/pull/57 (`fix/apex-pre-live-cutover-hardening` → `master`)  
**Prior Baseline SHA:** `acdb1667b79d4dd56d9e5e1f811e0b560ead2299` (parent `e2211ec4`)  
**Hardening Code Commit SHA:** `1a105a95441bf3ba78ade0e98a3ee2c8448610de`  
**Base (`origin/master`):** `0ffa2c027d0f0afdffac1c08b285e88a96464945`  
**Source-Merge Verdict:** `PR57_READY_FOR_FOUNDER_MERGE_REVIEW`  
**Live Settlement Verdict:** `LIVE_SETTLEMENT=HOLD`

> **CRITICAL DISTINCTION:** Source-only merge readiness for PR #57 is **NOT** live USDC settlement readiness. All real-money execution, remote D1 migrations, HSM activation, and staging/production deployments remain **BLOCKED / HOLD**.

---

## Release Gate Classification (G24.5)

| Gate | Status | Evidence / Rationale |
|---|---|---|
| `PR57_SOURCE_REVIEW` | **PASS** | 4 independent read-only reviewers (A/B/C/D) returned `PASS_WITH_NOTES` (0 Critical, 0 High); Medium items resolved or tracked cleanly; full Jest (200/200 suites), `typecheck`, `lint`, `build`, `build:worker`, and staging isolation all green. |
| `EVMSIG_STRICT_V` | **PASS** | `signEvmDigest` and `lookupSigningActivity` strictly accept only `v ∈ {0, 1, 27, 28}`, enforce EIP-2 low-S canonical signatures, and cryptographically verify `recoverAddress(...) === params.signerAddress`. Every invalid case fails closed to `UNCERTAIN_OUTCOME` (`requiresHumanReview=true`, `retryAllowed=false`). |
| `INSERT_FINALITY_SCHEMA_GUARD` | **PASS** | `trg_settlement_enforce_insert_finality` and `trg_settlement_enforce_finality` verified across fresh DB (001–037) and upgrade DB (001–036 → 037) with all 12 adversarial negative cases. Migration 037 was not modified; `COLD` branch parity noted for additive migration 038. |
| `CHAIN_PROOF_AUTHORIZATION` | **PASS** | Static + adversarial audit confirms SQL triggers are schema guards only (syntactically forged `tx_hash` + plausible timestamp passes SQL), AND zero API/cron/admin/import routes insert or update `settlement_broadcasts` to `CONFIRMED` without verified on-chain receipts via `BroadcastRecoveryMachine` / `executeSafeSettlement` / `confirmOnChain`. |
| `STELLAR_RAW_SECRET_REACHABILITY` | **VERIFIED_DISABLED** | Strategy A executed: `StellarService.submitTransaction`, `sendPayout`, and `processBatchPayouts` unconditionally throw `LegacyPayoutPathDisabledError`. `STELLAR_SECRET_KEY` is absent from `wrangler.jsonc` and `wrangler.staging.jsonc`. |
| `TURNKEY_ONLY_SETTLEMENT` | **PASS** | Sole production Horizon broadcast path is `HorizonStellarBroadcastTransport.submitSignedTransaction` behind `withPayoutEffect` (`STELLAR_SUBMIT`) + `BroadcastRecoveryMachine` + `TurnkeySigner`. Legacy `StellarSettlementAdapter` fails closed on write. |
| `LIVE_SETTLEMENT` | **HOLD** | Explicitly held pending real Turnkey HSM provisioning, production treasury configuration, remote D1 migration 037 authorization, legal/compliance sign-off, and external financial controls. |
| `REMOTE_MIGRATION_037` | **NOT_AUTHORIZED** | Migration `037_hardening_trigger_and_exposure.sql` was verified locally only; zero remote D1 mutations were executed. |

---

## 1. Exact Source SHA & Baseline Verification (G24.0)

- **Draft PR #57 Status:** Confirmed `isDraft: true`, `state: OPEN`, base `master` (`0ffa2c027d0f0afdffac1c08b285e88a96464945`), head prior to G24 `acdb1667b79d4dd56d9e5e1f811e0b560ead2299`.
- **Prior CI Runs on `acdb1667`:**
  - Run `45015565000` (`CI` on `push`) — `success` on `acdb1667`.
  - Run `45015570035` (`CI` on `pull_request`) — `success` on `acdb1667`.
  - Zero deployment workflows (`deploy-staging`, `deploy-production`, `wrangler deploy`) ran on `acdb1667`.
- **Delta of `acdb1667` vs parent `e2211ec4`:**
  - Modified `src/lib/payouts/turnkey-signer.ts` (strict `v ∈ {0, 1, 27, 28}` parse in `signEvmDigest` and `lookupSigningActivity`).
  - Modified `src/database/migrations/037_hardening_trigger_and_exposure.sql` (added `trg_settlement_enforce_insert_finality`).
  - **Gap identified:** `acdb1667` added zero new regression tests, did not verify recovered signer identity or EIP-2 low-S, and left `StellarService.sendPayout` / `submitTransaction` raw-key write path active.
- **G24 Hardening Commit:** `1a105a95441bf3ba78ade0e98a3ee2c8448610de` closes all three gaps with production code fixes and 27+ targeted financial-state regression tests.

---

## 2. Draft PR Status

- PR #57 remains **Draft** (`isDraft: true`).
- No merge, no Ready-for-Review flip, no branch-protection bypass, and no deployment trigger occurred.

---

## 3. Results for Each Post-Push Security Finding

### Finding 1 — Strict EVM Signature Recovery Parameter Validation (G24.1)

- **Code inspected & hardened:** `src/lib/payouts/turnkey-signer.ts` (`signEvmDigest` and `lookupSigningActivity`).
- **Fixes verified:**
  1. Strict acceptance of only `v ∈ {0, 1, 27, 28}` (normalized to parity `0 | 1`).
  2. Explicit rejection of `v = 2, 26, 29, 30, 35, 37, 255`, malformed hex (`"zz"`, `"0x1b"`), empty `""`, negative `"-1"`, non-integer `"1.5"`, and oversized `"10000"`.
  3. **Cryptographic signer verification (added in G24):** `viem.recoverAddress({ hash, signature })` compared case-insensitively against `params.signerAddress` in both `signEvmDigest` and `lookupSigningActivity`.
  4. **EIP-2 low-S canonical check (added per Reviewer A):** Rejects malleable high-S signatures (`BigInt('0x' + sHex) > SECP256K1_HALF_N`) before `recoverAddress` in both `signEvmDigest` and `lookupSigningActivity`.
- **Financial state asserted on every invalid case:**
  - `outcomeState === 'UNCERTAIN_OUTCOME'`
  - `requiresHumanReview === true`
  - `retryAllowed === false`
  - Original withdrawal lock preserved (`ledger_journal_batches` remains `INFLIGHT`, `inflight_balance_units === lockedAmount`, `settled_balance_units === remaining`)
  - `signRawPayload` called once; zero second signing activities created
  - Zero `eth_sendRawTransaction` broadcast calls attempted
  - Accounting invariant `ORIGINAL_LIABILITY = VERIFIED_SETTLEMENT + REMAINING_LIABILITY + VALID_REVERSALS` preserved.

### Finding 2 — D1 `INSERT` Finality Trigger & Trust-Boundary Audit (G24.2)

- **Code inspected:** `src/database/migrations/037_hardening_trigger_and_exposure.sql` (unmodified; additive strategy preserved).
- **All 12 required negative cases verified against real SQLite (`better-sqlite3`):**
  1. HOT INSERT without `tx_hash` → REJECTED (`ABORT`).
  2. HOT INSERT with empty `tx_hash` → REJECTED.
  3. HOT INSERT with missing `confirmed_at` → REJECTED.
  4. HOT INSERT with stale `confirmed_at` (`> 24h` old) → REJECTED.
  5. HOT INSERT with future `confirmed_at` (`> +10m`) → REJECTED.
  6. HOT INSERT with invalid `state` (e.g., `FORGED_STATE`) → REJECTED by `CHECK` constraint.
  7. HOT INSERT with unexpected `safe_tx_hash` → REJECTED.
  8. COLD INSERT without `safe_tx_hash` → REJECTED.
  9. COLD INSERT with empty `safe_tx_hash` → REJECTED.
  10. Concurrent forged HOT/COLD insertion attempts → REJECTED (trigger + `UNIQUE(payout_id)`).
  11. UPDATE-based bypass attempts (`BROADCAST_PENDING` → `CONFIRMED` without `tx_hash`/timestamp or with stale/future timestamp) → REJECTED by `trg_settlement_enforce_finality`.
  12. INSERT → UPDATE attempts to circumvent lineage (`COLD` without `safe_tx_hash`, `HOT` with `safe_tx_hash`) → REJECTED.
- **Migration upgrade rehearsal:** Verified on both fresh DB (001–037) and upgraded DB (001–036 populated with historical `BROADCAST_PENDING` and `CONFIRMED` rows → 037). Legitimate pending recovery, HOT confirmation, and COLD Safe settlement all succeed cleanly.

### Finding 3 — Stellar Raw Secret Signer Isolation (G24.3, Strategy A)

- **Strategy chosen:** **Strategy A — Hard-disable the legacy raw-key write path.**
- **Implementation (`src/lib/payouts/stellar-service.ts`):**
  - `StellarService.submitTransaction`: unconditionally throws `LegacyPayoutPathDisabledError`.
  - `StellarService.sendPayout`: unconditionally throws `LegacyPayoutPathDisabledError`.
  - `StellarService.processBatchPayouts`: unconditionally throws `LegacyPayoutPathDisabledError` (already disabled in PR #57).
  - Read-only helpers (`getAccountBalance`, `verifyAccountAndTrustline`, `isValidStellarAddress`, `confirmOnChain`, `getTransactionStatus`) remain intact and functional.
  - `StellarSettlementAdapter.submitPayout` calls `stellarService.sendPayout(...)`, so it now fails closed before any keypair signing or Horizon network I/O.

---

## 4. New Regression Tests & Evidence

- **Primary suite:** `__tests__/payouts/g24-security-closure.test.ts` (27/27 passing)
  - G24.1: Valid EVM `v ∈ {0, 1, 27, 28}` fixtures + 12 invalid `v` cases + wrong parity + wrong signer + EIP-2 high-S malleable signature + full `BroadcastRecoveryMachine` financial state preservation.
  - G24.2: Fresh DB & upgrade DB (001–036 → 037) + all 12 adversarial INSERT/UPDATE trigger cases + critical trust-boundary forged metadata test + legitimate HOT/COLD/reconciliation path checks.
  - G24.3: Direct tests proving `StellarService.submitTransaction`, `StellarService.sendPayout`, `StellarService.processBatchPayouts`, and `StellarSettlementAdapter.submitPayout` all throw `LegacyPayoutPathDisabledError` with zero `fetch` / Horizon calls, while read-only helpers still work.
  - G24.4: All 8 no-blind-retry scenarios (submit accepted / response lost, 504 after broadcast, ECONNRESET, Horizon unknown status, repeated worker invocation, 4-isolate concurrent retry, emergency pause during submission, previous tx finalizes after pause) asserting `signCalls === 1`, `submitAttempts === 1`, `uniqueTxHashes === 1`, `exposure_released_at IS NULL` while pending, `verifyLedgerInvariants(db).valid === true`, and exact conservation `ORIGINAL_LIABILITY = VERIFIED_SETTLEMENT + REMAINING_LIABILITY + VALID_REVERSALS`.
- **Updated existing suites:**
  - `__tests__/payouts/turnkey-hsm-unknown-outcome.test.ts` (18/18 passing — updated valid test fixture to match cryptographic `recoverAddress` verification).
  - `__tests__/payouts/stellar-service.test.ts` (37/37 passing — updated legacy write tests to assert fail-closed `LegacyPayoutPathDisabledError` and zero network calls).

---

## 5. D1 Trigger Limitations & Complementary Controls

- **Honest trust-boundary finding:** The adversarial trust-boundary test **proved** that a raw SQL `INSERT INTO settlement_broadcasts` carrying a syntactically valid but fabricated `tx_hash`, a plausible current `confirmed_at`, `state='CONFIRMED'`, and `signing_lane='HOT'` **is accepted by `trg_settlement_enforce_insert_finality`**. A SQL trigger cannot contact an RPC node or Horizon to verify blockchain finality.
- **Complementary application-layer controls verified:**
  - Every production write to `settlement_broadcasts` was traced across `src/app/api/`, `src/lib/payouts/`, and `src/workers/`:
    - `BroadcastRecoveryMachine` (`src/lib/payouts/broadcast-recovery-machine.ts`) transitions to `CONFIRMED` **only** after `verifyReceipt` / `verifyStellarTransaction` confirms on-chain finality.
    - `executeSafeSettlement` (`src/lib/payouts/safe-settlement.ts`) writes `COLD` rows only with verified Safe multisig transaction hashes.
    - Zero admin, cron, webhook, or import routes accept user-supplied `tx_hash` or insert `CONFIRMED` directly.
- **Additive migration follow-up (`038`, out of PR #57 scope):**
  - Reviewer B identified that `trg_settlement_enforce_insert_finality` and `trg_settlement_enforce_finality` enforce `tx_hash` + `confirmed_at` window checks on `HOT` but only `safe_tx_hash` on `COLD`. An additive migration `038` should bring `COLD` branch checks to parity (`tx_hash` + `confirmed_at` window) and enforce `state = 'CONFIRMED'` only via controlled transitions, without mutating migration `037`.

---

## 6. Stellar Adapter Call Graph (G24.3)

```text
ENTRY POINT                          → ADAPTER                        → SERVICE / MACHINE                         → SIGNER                    → BROADCAST
========================================================================================================================================================================
[1] Approved Production Settlement Path (ACTIVE — Turnkey-Only)
POST /api/payouts/run (admin)
  └─> PayoutDispatcher               → (direct)                       → BroadcastRecoveryMachine.executeSettlement → TurnkeySigner.signStellar → HorizonStellarBroadcastTransport
Cron / Recovery Worker                                                  (guarded by withPayoutEffect              (HSM Ed25519; zero raw      .submitSignedTransaction
  └─> recoverUncertainBroadcast                                          STELLAR_SUBMIT, EMERGENCY_PAUSE,          secret in Worker)           (sole Horizon POST)
                                                                         withdrawal-lock identity, $250/$1,500
                                                                         exposure caps, unknown-outcome retention)

[2] Legacy Stellar Adapter Path (HARD-DISABLED — Strategy A)
(No production route wires this;
 only unit tests / legacy factory)   → StellarSettlementAdapter       → StellarService.sendPayout                 → [BLOCKED BEFORE SIGNING]  → [BLOCKED BEFORE BROADCAST]
                                       .submitPayout()                  → throws LegacyPayoutPathDisabledError
                                                                          (no Keypair.fromSecret, no sign(),
                                                                           no Horizon fetch)

[3] Direct Legacy Service Methods (HARD-DISABLED — Strategy A)
Direct call (unreachable in prod)    → (none)                         → StellarService.submitTransaction()        → [BLOCKED] throws LegacyPayoutPathDisabledError
Direct call (unreachable in prod)    → (none)                         → StellarService.processBatchPayouts()      → [BLOCKED] throws LegacyPayoutPathDisabledError

[4] Read-Only Stellar Operations (ACTIVE — Safe, No Signing)
Health / Balance / Trustline checks  → (none)                         → StellarService.getAccountBalance()        → (none)                    → GET Horizon (read-only)
                                                                        StellarService.verifyAccountAndTrustline()→ (none)                    → GET Horizon (read-only)
                                                                        StellarService.confirmOnChain()           → (none)                    → GET Horizon (read-only)
```

| Path | Reachable in Prod? | Can Sign? | Can Broadcast? | Raw Secret? | Effect Fence? | Emergency Pause? | Withdrawal Lock? | $250/$1,500 Limits? | Unknown Outcome? | Bypass Dispatcher? |
|---|---|---|---|---|---|---|---|---|---|---|
| `[1]` `BroadcastRecoveryMachine` + `TurnkeySigner` | Yes (gated by flags) | Yes (Turnkey HSM) | Yes (Horizon POST) | **No** | Yes | Yes | Yes | Yes | Yes | No |
| `[2]` `StellarSettlementAdapter.submitPayout` | **No** (test-only) | **No (throws)** | **No (throws)** | **No (disabled)** | N/A | N/A | N/A | N/A | N/A | **No (fails closed)** |
| `[3]` `StellarService.submitTransaction` / `sendPayout` / `processBatchPayouts` | **No** | **No (throws)** | **No (throws)** | **No (disabled)** | N/A | N/A | N/A | N/A | N/A | **No (fails closed)** |
| `[4]` `StellarService` read-only methods | Yes | No | No | No | N/A | N/A | N/A | N/A | N/A | Read-only only |

---

## 7. Raw-Secret Signing Reachability Verdict

- **`STELLAR_RAW_SECRET_REACHABILITY=VERIFIED_DISABLED`**
- Zero production routes, cron handlers, adapters, or Worker bindings can sign or broadcast a Stellar transaction with a raw secret key.
- `STELLAR_SECRET_KEY` is absent from `wrangler.jsonc` and `wrangler.staging.jsonc`.
- Follow-up cleanup (non-blocking for PR #57): remove dead `senderKeypair` field / constructor secret parsing in a dedicated Treasury cleanup PR once `StellarSettlementAdapter` is retired or migrated to Turnkey-only.

---

## 8. Unknown-Outcome Handling (G24.4)

All 8 required fault-injection scenarios passed with **zero duplicate payouts** and **exact accounting conservation**:

1. **Submit accepted, response lost** → retained in `BROADCAST_PENDING` with exact `tx_hash`, `exposure_released_at IS NULL`, withdrawal lock intact; re-invocation does not re-sign or re-submit.
2. **HTTP 504 after broadcast** → retained in `BROADCAST_PENDING`, `signCalls === 1`, `submitAttempts === 1`, `uniqueTxHashes === 1`.
3. **TCP connection reset (`ECONNRESET`)** → retained in `BROADCAST_PENDING`, no blind retry.
4. **Horizon returns unknown status** → retained in `BROADCAST_PENDING`, requires receipt lookup or human review.
5. **Repeated worker invocation** → idempotent; returns existing `BROADCAST_PENDING` state without new signing or submission.
6. **Concurrent retry (4 independent `BroadcastRecoveryMachine` worker isolates sharing D1)** → cross-isolate D1 fence ensures `signCalls === 1`, `submitAttempts === 1`, `uniqueTxHashes === 1`.
7. **Emergency pause activated during submission** → in-flight tx identity preserved; new settlement attempts blocked by `EMERGENCY_PAUSE` (`system_safety_epoch` increment).
8. **Previous transaction finalizes after pause** → `recoverUncertainBroadcast` resolves the already-broadcast tx to `CONFIRMED` on receipt verification without triggering any new signing or broadcast, settling the withdrawal lock and maintaining `ORIGINAL_LIABILITY = VERIFIED_SETTLEMENT + REMAINING_LIABILITY + VALID_REVERSALS`.

---

## 9. Independent Review Findings (G24.6)

Four independent read-only reviewers inspected the actual diff and tests:

- **Reviewer A (EVM Signature Validation):** `PASS_WITH_NOTES` (0 Critical, 0 High, 1 Medium).
  - *Medium finding:* Add EIP-2 low-S canonical check (`s <= SECP256K1_HALF_N`) on EVM paths. **Resolved in commit `1a105a95`** + covered by `high-s-eip2-malleable` regression test in `g24-security-closure.test.ts`.
- **Reviewer B (D1 INSERT/UPDATE Finality Controls):** `PASS_WITH_NOTES` (0 Critical, 0 High, 1 Medium).
  - *Medium finding:* `COLD` branch in `trg_settlement_enforce_insert_finality` and `trg_settlement_enforce_finality` enforces `safe_tx_hash` but not `tx_hash` + `confirmed_at` window parity with `HOT`. **Deferred cleanly to additive migration `038`** to avoid mutating migration `037` (`REMOTE_MIGRATION_037=NOT_AUTHORIZED`).
- **Reviewer C (Stellar Raw Signer & Adapter Reachability):** `PASS_WITH_NOTES` (0 Critical, 0 High, 0 Medium, Low cleanup notes).
  - *Low note:* Constructor still accepts optional `secretKey` parameter in type signature for backwards compatibility with test fixtures, though every signing/broadcast method unconditionally throws `LegacyPayoutPathDisabledError`. Tracked for post-merge Treasury cleanup.
- **Reviewer D (Payout Idempotency, Emergency Fence & Financial Invariants):** `PASS_WITH_NOTES` (0 Critical, 0 High, 3 test-rigor improvements).
  - *Test-rigor improvements:* Explicit `validReversals === 0n` assertion, `exposure_released_at IS NULL` + `submitAttempts === 1` checks on Scenarios 1–4, and 4 separate `BroadcastRecoveryMachine` instances in Scenario 6 to test cross-isolate D1 fencing. **All 3 applied and verified in commit `1a105a95`.**

---

## 10. Local Verification & GitHub CI

- **Local verification on Node `v26.7.0`:**
  - Targeted G24 + Turnkey + Stellar suites: **3/3 suites, 82/82 tests PASS**.
  - Full Jest suite: **200/200 suites, 3,993 passed, 1 skipped, 0 failed**.
  - TypeScript (`npm run typecheck`): **0 errors**.
  - ESLint (`npm run lint -- --max-warnings 0`): **0 errors, 0 warnings**.
  - Next.js production build (`npm run build`): **PASS** (112/112 static pages).
  - Cloudflare Worker build (`npm run build:worker`): **PASS** (`.open-next/worker.js` built cleanly).
  - Staging isolation (`bash scripts/assert-staging-isolation.sh`): **PASS (`STAGING_ISOLATED`)**.
  - Local D1 migration rehearsal (fresh 001–037 & upgrade 001–036 → 037): **PASS**.
- **GitHub CI on PR #57:** Verified green on push of this closure packet (see final run summary in Founder delivery report; zero deployment workflows triggered).

---

## 11. Remaining Treasury Blockers (Why `LIVE_SETTLEMENT=HOLD` Remains Active)

1. Provision real Turnkey organization, HSM keys, and policy quorum (zero HSM credentials in repo/staging).
2. Founder authorization & scheduled maintenance window for remote D1 migration `037` (and additive migration `038` for `COLD` trigger parity).
3. Cloudflare token segmentation and production Worker environment binding audit (`05-CLOUDFLARE-TOKEN-SEGMENTATION-PLAN.md`).
4. Treasury hot/cold Safe multisig signers, funding, and operational runbook dry-run.
5. Legal, compliance, and KYC threshold enforcement ($500+ payout compliance gate) before partner/customer activation.

---

## 12. Remote Non-Mutation Attestation

- **PR #57 merged:** NO (remains Draft).
- **Staging or production deploy triggered:** NO.
- **Remote D1 migrations executed:** NO (`REMOTE_MIGRATION_037=NOT_AUTHORIZED`).
- **Real HSM credentials or raw production private keys touched:** NO.
- **Testnet or mainnet transfer / live USDC settlement executed:** NO.
- **Runtime safety flags or partner activation changed:** NO.

---

## 13. Single Next Founder Decision

**Decision requested:** Approve source-only merge of **PR #57** (`fix/apex-pre-live-cutover-hardening` → `master`) once GitHub CI is green on the final HEAD SHA, while keeping **`LIVE_SETTLEMENT=HOLD`** and **`REMOTE_MIGRATION_037=NOT_AUTHORIZED`** until the Treasury Cutover checklist (§11) is separately signed off.

---

## Final Verdicts

- **Source-Merge Verdict:** `PR57_READY_FOR_FOUNDER_MERGE_REVIEW`
- **Live Settlement Verdict:** `LIVE_SETTLEMENT=HOLD`
