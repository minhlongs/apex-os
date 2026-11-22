# 01 — G23.1 Turnkey HSM: Safe Timeout & Unknown Outcome Hardening

**Date:** 2026-11-22  
**Branch:** `fix/apex-pre-live-cutover-hardening`  
**Workstream:** G23.1 (Deferred High H6)  
**Real Turnkey API Calls:** `0` (all tests use deterministic offline fake transports)

---

## 1. Root Cause Addressed
`TurnkeyServerHsmTransport` (`src/lib/payouts/turnkey-signer.ts`) previously invoked `apiClient.signRawPayload(...)` with no bounded timeout and no distinction between:
- definite pre-dispatch rejection,
- explicit HSM policy denial,
- configuration error,
- malformed signature, and
- transport/timeout ambiguity where the remote HSM may have already accepted or completed the signing request.

Additionally, `BroadcastRecoveryMachine` (`src/lib/payouts/broadcast-recovery-machine.ts`) caught pre-broadcast errors and could mark a payout `FAILED_ABORTED` and reclaim its nonce/sequence even when the error was an uncertain HSM signing outcome.

---

## 2. Implemented Safeguards

### 2.1 Explicit 6-State Outcome Classification (`src/lib/payouts/turnkey-signer.ts`)
- Added `TurnkeySigningOutcomeState`:
  - `DEFINITE_REJECTED` — pre-dispatch abort or deterministic 4xx payload validation failure before remote execution (`retryAllowed: false`, `requiresHumanReview: false`).
  - `SIGNED_CONFIRMED` — remote HSM returned a complete, structurally valid signature (`r`/`s` 32-byte hex or 64-byte Ed25519 hex).
  - `UNCERTAIN_OUTCOME` — post-dispatch timeout, network reset, 5xx gateway error, pending/consensus activity, or malformed signature payload (`retryAllowed: false`, `requiresHumanReview: true`).
  - `CONFIGURATION_ERROR` — invalid credentials or out-of-bounds timeout configuration (`retryAllowed: false`).
  - `POLICY_DENIED` — explicit HSM policy / authorization / consensus denial (`retryAllowed: false`).
  - `TRANSIENT_READ_ERROR` — read-only activity status lookup failed transiently (`retryAllowed: true` for read-only polling only; never authorizes re-signing).
- Added typed `TurnkeyHsmOutcomeError`, `isTurnkeyHsmOutcomeError()`, and `isTurnkeyUncertainOutcomeError()`.

### 2.2 Bounded Signing Timeout & Deduplication
- `DEFAULT_TURNKEY_SIGN_TIMEOUT_MS = 12_000` (12 seconds, within the 10–15s policy band), `MAX_TURNKEY_SIGN_TIMEOUT_MS = 15_000`, `MIN_TURNKEY_SIGN_TIMEOUT_MS = 10` (for deterministic offline tests).
- `executeBoundedRawSign` wires `AbortController` + `Promise.race` with strict timer cleanup; any post-dispatch abort or timeout classifies as `UNCERTAIN_OUTCOME`.
- `completedByRequestId` and `inFlightByRequestId` coalesce duplicate/concurrent signing requests for the same durable `requestId` so at most one HSM signing call is issued.

### 2.3 Durable Operation Identity & Read-Only Recovery
- Added `TurnkeySigningOperationIdentity` binding `payoutId`, `payoutBatchId`, `chain`, `recipientAddress`, `assetCode`, `amountUnits1e8`, `assignedNonce`, `stellarSequence`, `signingRequestId`, `originalState`, and `providerIdempotencyId`.
- Added read-only `TurnkeyServerHsmTransport.lookupSigningActivity(...)` and `TurnkeySigner.recoverUncertainSigningActivity(...)` so timed-out requests that were remotely accepted can be reconciled without issuing a new signing request.
- Updated `BroadcastRecoveryMachine` EVM & Stellar pre-broadcast `catch` blocks to re-throw `isTurnkeyUncertainOutcomeError(...)` immediately, preserving the withdrawal lock, `SIGNING` / `BROADCAST_PENDING` row, and nonce/sequence without rollback or blind retry.

---

## 3. Mandatory Negative Test Evidence (`__tests__/payouts/turnkey-hsm-unknown-outcome.test.ts`)

Command:
```bash
npx jest __tests__/payouts/turnkey-hsm-unknown-outcome.test.ts --no-coverage
```
Result: **14 passed, 0 failed** (all offline deterministic fakes).

| # | Mandatory Scenario | Verified Outcome |
|---|---|---|
| 0 | Config bounds & invalid credentials | Default 12s enforced; `>15s` and missing credentials throw `CONFIGURATION_ERROR` |
| 1 | Timeout / abort before request transmitted | `DEFINITE_REJECTED` with `0` HSM calls |
| 2 | Timeout after request transmission | `UNCERTAIN_OUTCOME` (`retryAllowed: false`, `requiresHumanReview: true`), withdrawal lock stays `INFLIGHT`, nonce not reclaimed |
| 3 | Timeout after remote acceptance before response | `UNCERTAIN_OUTCOME` then read-only `lookupSigningActivity` recovers exact signature (`SIGNED_CONFIRMED`) with `0` new signing calls |
| 4 | Duplicate request identifier | Coalesced to `1` HSM call |
| 5 | Response received twice (concurrent identical request) | Single in-flight HSM call, identical signature returned |
| 6 | Concurrent workers retrying same withdrawal | At most `1` HSM signature, `0` double settlement |
| 7 | HSM returns explicit denial | `POLICY_DENIED`, `retryAllowed: false` |
| 8 | HSM returns malformed signature | `UNCERTAIN_OUTCOME`, transaction assembly refused |
| 9 | Emergency pause activates while request is pending | Fail-closed block on further signing/broadcast |
| 10 | Ledger freeze activates during recovery | Active re-signing blocked; locked liability preserved |
| 11 | Network disconnect after signing before broadcast | `signed_raw_tx` persisted in D1; fail-closed while unresolved; reconciled on-chain with `0` re-signing |
| 12 | Restart and recovery from persisted uncertain state | Fresh machine reconciles exact tx to `CONFIRMED`, ledger finalizes cleanly (`verifyLedgerInvariants.valid === true`) |
| 13 | Read-only lookup network failure | `TRANSIENT_READ_ERROR` (`retryAllowed: true` for read-only polling only) |

---

## 4. Acceptance Verification
- Zero blind signing retries: **PASS**
- Zero new transaction creation from unknown outcomes: **PASS**
- Zero unauthorized signatures: **PASS**
- Durable preservation of locked liabilities: **PASS**
- Full recovery without double settlement: **PASS**
