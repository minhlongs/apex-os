# Phase 04 — Money-Movement & Compliance Correctness

## Overview
- **Priority**: **P0**
- **Status**: pending
- **Effort**: 16h
- **Blocks**: Phase 06 (hard), Phase 05 (partially — see step order)
- **Depends on**: Phase 02 (types visible), Phase 03 (clean tree)

ApexOS moves real USDC. Five **P0 verified defects** mean money is currently either not earned, not verified, or fabricated. These are the top of the worklist — the float-precision work is real but strictly lower severity than "users are marked paid for transactions that never happened."

**Effort raised 8h → 16h:** the five P0s are behavioral fixes touching webhook ingestion, three chain adapters, and the settlement engine, each requiring new tests. Float precision work remains.

### P0 Priority Order (do these first, in this order)

| Rank | Defect | Why this rank |
|------|--------|--------------|
| P0-1 | Webhook double body-read | 100% of exchange webhooks rejected → **zero** conversions/earnings/payouts. Existential. |
| P0-2 | Solana broadcasts a constant string | Users paid, nothing sent. Money leaves the ledger, never hits the chain. |
| P0-3 | Ethereum fabricates a tx hash | Same loss mode as P0-2. |
| P0-4 | `success` treated as `confirmed` | Marks `is_paid=1` on unverified "submitted" — the root cause that lets P0-2/P0-3 lose money. |
| P0-5 | Float money at ingestion | Ingestion writes raw IEEE-754. Lower severity than above (small drift) but the cheapest to fix and prevents compounding. |

## Key Insights
### P0-1 — Webhook reads the body twice; signature verification runs over an empty stream
All three exchange webhooks parse the body, then read the raw text for HMAC:
- `src/app/api/webhooks/exchange/route.ts:319` `const body = (await request.json()) as Record<string, unknown>;` then `:322` `const rawBody = await request.text();`
- `src/app/api/webhooks/exchange/okx/route.ts:320` / `:323` — worse: `verifyOkxSignatureInternal(rawBody, headers, rawBody)` passes the same value twice.
- `src/app/api/webhooks/exchange/kucoin/route.ts:325` / `:328` — `verifyKuCoinSignatureInternal(rawBody, headers, rawBody)`.

A `Request` body is a single-use stream. Reading `.json()` first consumes it, so `.text()` returns `''`. **HMAC over `''` never matches a legitimately-signed body → 100% rejection.**

The correct pattern already exists in-repo: `src/app/api/webhooks/ipn/route.ts:123` `const rawBody = await request.text();` then `:151` `JSON.parse(rawBody)`. Copy it.

**Why 3186 green tests didn't catch this — two compounding maskers (both verified):**
1. `src/__tests__/smoke/webhook-signature.test.ts:9,:34,:45` defines its **own** `verifyHmacSha256`/`verifyBinanceSignature`/`verifyBybitSignature` and **never imports the real route handler**. Same for `src/__tests__/webhooks/{kucoin,okx}-verification.test.ts`, which build their **own** `computeKuCoinSignature`/`computeOkxSignature` (`kucoin:80`, `okx` path-only at `:38`) and reference the route only as a **path string** (`kucoin:56`, `:107`). The exchange webhooks are the only protected routes with no handler-level test.
2. `jest.setup.ts:153-165` — the `Request` mock's `json()` and `text()` both re-derive from `this._body` independently, so reads are **repeatable**. Real Next.js `Request` is a single-read stream.

**The fix pattern already exists in-repo.** Other routes *do* have handler-level tests, so the pattern is established and reusable rather than novel:
- `src/__tests__/billing/challenger-m5-core-payments-webhooks.test.ts:37` — `import … from '@/app/api/webhooks/ipn/route'`
- `src/__tests__/billing/payments-status-and-migration.test.ts:12` — `import { GET } from '@/app/api/payments/status/route'`
Model the new exchange test on these. This keeps the effort estimate honest — no new test-architecture invention is needed.

### P0-2 — Solana adapter broadcasts a literal constant string
`src/lib/payouts/adapters/solana-adapter.ts:213-214` sends `'MOCK_SIGNED_TX_PAYLOAD'` to `rpc sendTransaction`. No transaction builder, no signer, no keypair. `buildSPLTransferData(amountUnits: bigint): Uint8Array` (`:72`) is exported and **never called**. On RPC throw, `:223-235` fabricates a base58 signature from payout metadata (`payoutId`, `chain`, `address`) — **deterministic, not on-chain**. Function still returns `success: true`.

Reachability confirmed: `src/lib/payouts/router.ts:46-48` registers `StellarAdapter`, `EthereumAdapter`, `SolanaAdapter` by default; `batch-settlement-service.ts:1676` resolves `LOWER(COALESCE(p.preferred_chain, wc.preferred_chain, 'stellar'))`. So **any user with `preferred_chain='solana'` hits this path.**

### P0-3 — Ethereum adapter fabricates a `transactionHash`
`src/lib/payouts/adapters/ethereum-adapter.ts:259-277` — the `catch` block computes `keccak256(...)` over payout metadata, assigns it as `transactionHash`, returns `success: true`. `privateKey` is read once at `:99` (`this.privateKey = config?.privateKey ?? process.env.ETHEREUM_PRIVATE_KEY`) and **never referenced again** — no signing code exists, so this catch is the *expected* production path, not an exception.

### P0-4 — `success` means "submitted"; the engine treats it as "confirmed"
`src/lib/payouts/batch-settlement-service.ts:1156-1178` — gated **purely** on `execRes.success`, with **no `router.verifyTransaction` call**: sets `status='completed'`, `is_paid=1`, `paid_at`, plus audit rows, in one `db.batch`.

Contrast: `retryPayout` at `:1403-1407` **does** pre-flight verify — `router.verifyTransaction(chain, payout.transaction_id)` and only reconciles when `verifyRes.status === 'confirmed'`. The omission is specific to `executeBatch`.

This is the defect that makes P0-2 and P0-3 money-losing rather than merely cosmetic: an unverified "success" flips `earnings.is_paid`.

### P0-5 — Float money at ingestion
- `src/app/api/webhooks/exchange/route.ts:387` and `:201` — `trade.totalValue * (cashbackPercent / 100)` raw float.
- `:257-263` — `const level1Rate = 0.30; const level1Amount = commissionAmount * level1Rate;` — a **third, hardcoded** tier split, inconsistent with `earnings/calculator.ts:340` and `DEFAULT_TIER_RATES`. DRY violation *and* a float path.
- `src/lib/webhooks/parsers.ts:31-33,78-80,121-123` — `parseFloat` on exchange quantities/prices/fees.
- `src/lib/payouts/batch-settlement-service.ts:429-431` — `const fee = 0.0;` then `fromCents(agg.totalCents - toCents(fee))`. Note: `toCents`/`fromCents` **already exist** in this file — the Phase 04 money module should reuse/extend them rather than introduce a parallel abstraction (DRY).

### Secondary (verified, lower severity)
- **Sentry is dead code.** `initializeSentry()` exists (`src/lib/error-tracking/sentry-config.ts:12,23`) and self-calls at `:150`, but nothing outside `src/lib/error-tracking/` imports it. There is no `instrumentation.ts`/`instrumentation-client.ts` and no `sentry.*.config.ts`. The only `captureException` call site is `src/components/error-boundary.tsx:49`, which imports `@sentry/nextjs` **directly** — bypassing the dead wrapper entirely. Consequence: server-side exceptions in cron/webhooks/payout are invisible in production.
- **No test imports the real webhook route handler** (verified: zero matches for the real route paths under `--include=*.test.ts`).
- **`src/lib/payouts/payouts-service.ts` is a second payout service, ~5.6KB, live-but-thin.** Verified reachable: `src/lib/payouts/index.ts:9` `export * from './payouts-service'`. Also dynamically imported by `worker-wrapper.js:71` for the earnings cron. Whether it should survive consolidation with `batch-settlement-service.ts` is a **user decision (D2)**.

### Classic float-precision findings (as previously scoped)
- D1 `REAL` columns: `003_affiliate_schema.sql:196` `commission_amount REAL NOT NULL`, `:224,:254` `amount REAL NOT NULL`, `:257` `net_amount REAL NOT NULL`, `:90` `fixed_commission_amount REAL DEFAULT 0.00`.
- `payouts-service.ts:14,:17,:29,:32` — `amount: number`, `net_amount: number`.
- `earnings/calculator.ts:620-622` — float `reduce` accumulation.
- `stellar-adapter.ts:88,123,204,205` — `Number((…).toFixed(6))` silently rounds fees.

### Compliance
- CLAUDE.md: "KYC required at $500+ payout threshold (not implemented yet)". Migration `024_kyc_compliance_schema.sql` exists.
- `worker-wrapper.js` gates only on `HAVING total_amount >= 10.00`. No KYC gate, no AML/sanctions check.

## Confirmed decisions (recorded 2026-10-22, from advisory `advise-261022-0953`)

- **D1 = (b) Implement real signing before go-live** for Solana and Ethereum. Stellar already signs and fails closed. This supersedes the plan's default of (a) and adds new key management plus two signing dependencies to the critical path. Recorded as a trade-off, not reversed.
- **D2 = Both payout services are live and must be unified behind one verification gate.** `payouts-service.ts` is the service the weekly cron actually uses, not a dead duplicate: `worker-wrapper.js:92` imports it, `:100` constructs it, `:159` calls `createPayout`, and `:174` flips `is_paid=1` with a plain `UPDATE` and **no chain interaction at all**. `batchSettlementService` is reachable only from two admin routes (`admin/payouts/retry/route.ts:20`, `admin/payouts/batch/route.ts:19`). Therefore a P0-4 fix scoped to `batch-settlement-service.ts:1156-1178` alone would leave the weekly cron still paying users on a database write. **The gate must cover both paths.**
- **Failure behaviour on payout failure:** earnings stay `is_paid = 0` (fail closed), successful transfers within a batch still clear, transient RPC failures retry idempotently inside the run, and permanent failures raise a critical alert.
- **Test maskers are in scope (G4g).** No test imports the real exchange route handler, and the `jest.setup.ts` `Request` mock re-derives `json()` and `text()` independently so a body can be read twice (`jest.setup.ts:154`, `:161`). Without closing both, F0/P0-1 cannot be regression-tested.

## Requirements
### Functional
- F0. **Exchange webhooks must verify HMAC over the exact raw bytes of the request body.** No `await request.json()` before `await request.text()` anywhere in `src/app/api/webhooks/`.
- F1. **Internal money representation is integer minor units** (USDC 6dp) — `BigInt` or integer-restricted `number`, never IEEE-754.
- F2. One shared conversion/rounding utility; reuse existing `toCents`/`fromCents` where present.
- F3. **Tier-split conservation**: `tier1+tier2+tier3 === commissionAmount` exactly, remainder assigned deterministically. **One** tier-rate source of truth — eliminate the third hardcoded `0.30`.
- F4. **On-chain payout requires `verifyTransaction` confirmation.** "submitted" ≠ "confirmed"; `is_paid` is set only after independent verification.
- F5. **No chain adapter may fabricate a transaction identity.** A fabricated signature/hash must be impossible to return as `success: true`.
- F6. **Payout idempotency**: repeated runs never double-pay. Verified by test.
- F7. **KYC gate** at the $500 threshold reading persisted state only.
- F8. Existing float behavior preserved numerically where deployed, or delta quantified and signed off.

### Non-Functional
- NF1. Every money utility is pure, dependency-free, boundary-tested.
- NF2. **Every protected webhook route has a test importing the real handler.**
- NF3. The `jest.setup.ts` `Request` mock must enforce single-read body semantics, matching production.
- NF3a. Every protected route in `src/app/api/webhooks/**` must have a test importing its real handler. Today only `ipn` does (`src/__tests__/billing/challenger-m5-core-payments-webhooks.test.ts:37`). `ipn` is also the route that gets body-reading **right** (`ipn/route.ts:123`) — not a coincidence.
- NF4. No `:any` in new code; branded `MinorUnits` type.

## Decisions Requiring The User (do NOT assume; block go-live until answered)

- **D1 — Is Solana/EVM payout meant to be LIVE at go-live, or should it fail closed / be feature-gated?**
 Current state is the worst of both worlds: Solana broadcasts a mock string and Ethereum's catch path fabricates a hash, and **both still return `success: true`**. Options:
 - **(a) Feature-gate now, fail closed.** Default to Stellar (which does have real signing). Reject `preferred_chain` ∈ {solana, ethereum} at payout eligibility with a persisted reason + user notification. Ship zero-bug with one verified rail.
 - **(b) Implement real signing before go-live** for Solana (`buildSPLTransferData` + a real keypair/signer) and Ethereum (`ethers`/viem + `ETHEREUM_PRIVATE_KEY`). Substantial extra effort and new key management.
 - **(c) Keep them live as-is** — *not recommended*: guarantees users are marked paid with no transfer.
 Recommending **(a)** for a zero-bug go-live, with (b) as a fast-follow. **This is a product decision, not an engineering default.**

- **D2 — Is `src/lib/payouts/payouts-service.ts` a second payout service, and live or dead?**
 It is reachable (`payouts/index.ts:9`) and used by the `worker-wrapper.js` earnings cron (`:71`), yet `batch-settlement-service.ts` appears to be the real engine. Two payout services with divergent money semantics is a standing reconciliation hazard. Options: consolidate; keep with a documented ownership boundary; or delete if genuinely superseded. **Needs a founder/owner call.**

## Architecture
A dedicated, DRY money module. Reuses existing `toCents`/`fromCents` from `batch-settlement-service.ts` rather than forking a parallel implementation.

```
src/lib/money/                    (NEW — see Phase 4 body for full spec)
  types.ts        → branded MinorUnits + MoneyError
  constants.ts    → USDC_DECIMALS = 6, USDC_SCALE = 1_000_000n
  parse.ts        → decimal/number/bigint → MinorUnits (throws on precision loss)
  format.ts       → MinorUnits → display string (ONLY place float is allowed)
  split.ts        → deterministic tier split, exact conservation
  index.ts        → barrel
```

### Webhook verification must move BEFORE parsing
Single canonical order, applied to all three exchange routes (mirroring `ipn/route.ts:123-151`):
```
rawBody = await request.text()        // consume stream ONCE, keep exact bytes
verify HMAC over rawBody              // reject 401 BEFORE any parse on failure
body = JSON.parse(rawBody)            // parse only after verification passes
```
Placing verification first also removes a class of parse-then-verify bypasses where malformed JSON would skip signature checks.

### Settlement must distinguish submitted vs confirmed
```
chain result → status ∈ {submitted | failed}
  submitted → payout.status='processing', earnings.is_paid LEFT AT 0
  then      → router.verifyTransaction(chain, txId)
                  confirmed → payout.status='completed', is_paid=1, ledger rows
                  pending   → stay 'processing', retry on next run
                  failed    → payout.status='failed', is_paid untouched, alert
```
`is_paid = 1` is reachable **only** via a `confirmed` verification. The `db.batch` that currently flips it at `:1156-1178` must be split so the payout-status write and the earnings-flip are gated on different conditions.

### Solana/EVM (pending D1)
If **D1(a)** is chosen, the eligibility resolver gains a supported-chain allowlist read from config with a documented default of `['stellar']`, plus a persisted skip-reason and user notification. If **D1(b)**, real signing replaces the constant-string broadcast and the fabricated-hash catch.

## Related Code Files
### Modify — P0-1 (webhook body read)
- `src/app/api/webhooks/exchange/route.ts` — reorder `:319`/`:322`
- `src/app/api/webhooks/exchange/okx/route.ts` — reorder `:320`/`:323`, fix double `rawBody` args
- `src/app/api/webhooks/exchange/kucoin/route.ts` — reorder `:325`/`:328`, fix double `rawBody` args
- `jest.setup.ts:153-165,182-193` — make `Request` mock single-read

### Modify — P0-2 / P0-3 (chain adapters)
- `src/lib/payouts/adapters/solana-adapter.ts` — remove `'MOCK_SIGNED_TX_PAYLOAD'` (`:213-214`), remove fabricated-signature catch (`:223-235`), use `buildSPLTransferData` (`:72`) or fail closed
- `src/lib/payouts/adapters/ethereum-adapter.ts` — remove keccak-fabricated `transactionHash` (`:259-277`), either sign with `privateKey` (`:99`) or fail closed
- `src/lib/payouts/router.ts` — supported-chain gating (D1(a)) / real adapters (D1(b))

### Modify — P0-4 (settlement)
- `src/lib/payouts/batch-settlement-service.ts` — `:1156-1178` add `verifyTransaction`; split the batch; `:429-431` real fee

### Modify — P0-5 / float
- `src/app/api/webhooks/exchange/route.ts` — `:201`, `:257-263`, `:387` minor units + single tier-rate source
- `src/lib/webhooks/parsers.ts:31-33,78-80,121-123` — money fields to minor units
- `src/lib/earnings/calculator.ts:340-344,620-622`

### Create
- `src/lib/money/{types,constants,parse,format,split,index}.ts`
- `src/lib/money/__tests__/{money,split}.test.ts`
- `src/__tests__/webhooks/exchange-signature.regression.test.ts` — **imports the real route handlers**
- `src/lib/payouts/__tests__/settlement-verification.test.ts`
- `src/lib/payouts/__tests__/chain-adapter-integrity.test.ts`

### Delete
- *(none)* — D2 may add `payouts-service.ts`; hold pending the decision

## Implementation Steps
1. **P0-1 webhook fix + regression test (highest severity, do first).**
 1a. Reorder each of the three exchange routes to `text()` → verify → `parse`. Use `ipn/route.ts:123-151` as reference.
 1b. Fix the `verifyOkxSignatureInternal(rawBody, headers, rawBody)` / `verifyKuCoinSignatureInternal(rawBody, headers, rawBody)` double-argument bugs.
 1c. Write `exchange-signature.regression.test.ts` that imports the **real** `POST` handlers, constructs a `Request` whose `.json()` throws on second read (real semantics), and asserts: valid signature accepted; tampered body rejected 401; missing signature 401; **invalid JSON rejected 401 (verification precedes parsing)**.
 1d. Fix `jest.setup.ts` so `Request.json()`/`text()` share a consumed flag — **after** the new test exists and passes against the real mock semantics.
2. **P0-4 settlement verification — both payout paths, not just `executeBatch`.** Refactor `batch-settlement-service.ts:1156-1178` to insert `router.verifyTransaction` and gate `is_paid` on `confirmed` only. **In the same step, route the weekly cron through the same gate**: `worker-wrapper.js:174` currently flips `is_paid=1` with a plain `UPDATE` and no chain interaction, so an `executeBatch`-only fix would leave the real payout route still paying on a database write. Write `settlement-verification.test.ts` asserting `success=true` + `verifyTransaction` returning `pending` leaves `is_paid=0`, covering the cron path and the admin batch path alike.
3. **P0-2 / P0-3 adapters — resolve D1 first.** Implement whichever option D1 selects. Either way, write `chain-adapter-integrity.test.ts` asserting **no adapter can return `success: true` with an unverifiable/constant/fabricated transaction id**.
4. **Build the money module** (`src/lib/money/*`), reusing existing `toCents`/`fromCents` where semantics match rather than duplicating (DRY). Boundary tests per NF1.
5. **P0-5 ingestion.** Convert `exchange/route.ts:201,:257-263,:387` and `parsers.ts:31-33,78-80,121-123` to minor units. Replace the hardcoded `0.30` at `:257` with the shared tier-rate source, eliminating the third split.
6. **Migrate the remaining float paths** (`calculator.ts`, `payouts-service.ts`, `stellar-adapter.ts` fee `toFixed`).
7. **Real payout fee** at `batch-settlement-service.ts:429-431` — replace `fee = 0.0` with a fee-policy value; do not silently keep zero.
8. **KYC gate** at the $500 threshold, persisted state only.
9. **Payout idempotency** — one transactional unit for payout creation + earnings flip; explicit double-run test.
10. **Sentry** — decide: wire `instrumentation.ts` calling `initializeSentry()`, or delete the dead wrapper and standardize on `@sentry/nextjs` as `error-boundary.tsx:49` already does. Note as a small open decision.
11. **Quantify the float delta** (existing `/tmp` scratch script, not committed). Any material delta → escalate.
12. Validate (Success Criteria).

## Todo List
- [x] **P0-1** all three exchange routes `text()`-first; double-arg verify bugs fixed
- [x] **P0-1** real-handler regression test exists and fails on the old order
- [x] `jest.setup.ts` `Request` mock enforces single-read body semantics
- [x] **P0-4** `executeBatch` and the weekly cron both verify before setting `is_paid=1`, via the shared settlement gate
- [ ] **P0-2** Solana no longer broadcasts `'MOCK_SIGNED_TX_PAYLOAD'`
- [ ] **P0-3** Ethereum no longer fabricates `transactionHash`
- [ ] `chain-adapter-integrity.test.ts` asserts no fabricated-id `success: true`
- [x] **D1 decided by user** — (b) implement real signing before go-live, per advisory `advise-261022-0953` (2026-10-22)
- [x] **D2 decided by user** — both services are live; unify behind one verification gate, per advisory `advise-261022-0953` (2026-10-22)
- [ ] **P0-5** ingestion on minor units; hardcoded `0.30` eliminated
- [ ] `src/lib/money/*` created; reuses existing cents helpers (DRY)
- [ ] Tier split conserves exactly; single source of tier rates
- [ ] Real fee replaces `fee = 0.0`
- [ ] KYC gate at $500, persisted state only
- [ ] Idempotency double-run test green
- [ ] Sentry resolved (wire or delete dead wrapper)
- [ ] Float delta quantified; material delta escalated before merge
- [ ] Zero new `:any`; zero `@ts-ignore` added

## Success Criteria
**Definition of done**: exchange webhooks verify over true raw bytes and reject tampered/missing/signed-but-malformed requests 401; no payout is marked `is_paid=1` without an on-chain `confirmed` verification; no adapter can fabricate a transaction identity; money is integer minor units throughout; tier splits conserve exactly; payouts are idempotent and KYC-gated; both user decisions are answered and recorded.

**Validation commands**:
```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
npx tsc --noEmit && echo TS_OK
npx eslint . --ext .ts,.tsx --max-warnings 0 && echo LINT_OK
# P0 regression suite
CI=true npx jest src/__tests__/webhooks src/lib/payouts/__tests__/settlement-verification src/lib/payouts/__tests__/chain-adapter-integrity src/lib/money 2>&1 | tail -10
CI=true npx jest src/__tests__/earnings.test.ts 2>&1 | tail -6
CI=true npx jest 2>&1 | tail -8                                    # full suite 0 failed
# Proof-of-negatives
grep -rn "MOCK_SIGNED_TX_PAYLOAD" src --include="*.ts" | wc -l                              # expect 0
grep -rn "request.json()" src/app/api/webhooks --include="*.ts" | grep -B2 -A2 "" ; echo "verify none precede text()"
awk '/await request.json/{j=NR} /await request.text/{print FILENAME":"NR}' src/app/api/webhooks/exchange/*/route.ts
grep -rn "\* 0\.\(30\|10\|05\|01\)" src --include="*.ts" | wc -l                             # expect 0
grep -c "const fee = 0.0" src/lib/payouts/batch-settlement-service.ts                        # expect 0
grep -rn "buildSPLTransferData" src --include="*.ts" | grep -v __tests__ | wc -l            # expect ≥1 call site (post-D1(b)); 0 if D1(a)
```
Also required: `Phase 06` gate items **G4a–G4e** all PASS (see `phase-06`).

## Risk Assessment
| Risk | Likelihood × Impact | Mitigation |
|------|--------------------|------------|
| Webhook fix deployed but regression test still can't detect it (mock reused) | **High × Critical** | Steps 1c/1d sequence this deliberately: real-handler test first, then tighten the mock. Both maskers are closed. |
| Users already marked `is_paid=1` by the old code with no real transfer | **Medium × Critical** | Pre-go-live reconciliation query: cross-check `payouts.transaction_id` values against chain state. Any fabricated id = fabricated payout. **Run this before cutover (Phase 07 pre-flight).** |
| Settlement change stalls legitimate payouts (stuck `processing`) | Medium × High | `pending` stays `processing` and retries next run; alert on payouts stuck `processing` > N cycles. Never silently drop. |
| D1(gate-and-fail-closed) blocks users who expect Solana/EVM | Medium × Medium | Persisted skip-reason + user notification, not a silent reject. D1 is the user's call; recommendation documented. |
| Removing the `0.30` hardcode changes historical tier shares | Medium × Medium | Confirm `DEFAULT_TIER_RATES.tier1_rate === 0.30` first; if it diverges, the difference is a *bug fix* — quantify via step 11 and surface it. |
| Float delta material → changing payout meaning | Medium × Critical | No DB column migration in this phase; delta escalated, never merged silently. |
| `strict` + branded `bigint` breaks unrelated callers | Medium × Medium | Brand only money boundaries; plain `number` for counts. |

## Security Considerations
- P0-1 is a **security defect, not only availability**: verifying HMAC over an empty body means an attacker could in principle send a body that produces an empty/known stream and a matching signature. Verification-before-parse is mandatory.
- P0-2/P0-3 are **financial-integrity defects**: fabricated transaction ids in `payouts.transaction_id` make the ledger unauditable.
- KYC threshold reads persisted authenticated state — a request-supplied `kyc: true` is a compliance bypass.
- Solana/EVM key material (`ETHEREUM_PRIVATE_KEY`, any Solana keypair) must come from env/Secrets only; if D1(b) is chosen, that is new key-management surface requiring its own review.
- `$500` is a policy constant — config/env with a documented default, never inline.
- No secrets in the money module or new tests.

## Next Steps
- **Feeds Phase 05**: staging rehearsal must exercise real webhook verification and a verified settlement; requires this phase complete (or at minimum P0-1 + P0-4).
- **Feeds Phase 06**: gate items G4a–G4e are added there and block go-live.
- **Feeds Phase 07**: pre-flight reconciliation of already-paid payouts with fabricated tx ids.
- Cross-ref `reports/researcher-quality-tests-report.md`.


## Architecture
**A dedicated money module** — one concept, one place:

```
src/lib/money/                    (NEW)
  types.ts        → branded MinorUnits + MoneyError
  constants.ts    → USDC_DECIMALS = 6, USDC_SCALE = 1_000_000n
  parse.ts        → decimal-string/number → MinorUnits (strict, throws on precision loss)
  format.ts       → MinorUnits → display string (ONLY place float is allowed, render-only)
  split.ts        → deterministic tier split with explicit remainder rule
  index.ts        → barrel
```

**Why branded `BigInt`:** prevents the entire class of "someone assigned a percentage to an amount" bugs at compile time — with `strict: true` from Phase 02, `MinorUnits` is a nominal type a plain number cannot satisfy. This is the DRY answer to 15 scattered `* 0.01` expressions.

**Why not a `Decimal` library:** YAGNI. A decimal library adds a dependency and boxed-object overhead. USDC has a fixed 6dp scale; `BigInt` minor units + integer math is exact and sufficient. Only *rendering* uses float, and even that must go through `format.ts`.

**Rounding mode (decide once, document, test):**
- Conversion from a decimal string/number to minor units: **round-half-up** at the 6dp boundary; **throw** `MoneyError.PRECISION_LOSS` if the input has >6 significant decimals and would silently truncate.
- Tier split: multiply in BigInt, divide with floor, then assign the leftover minor units to **tier1** (the direct referrer), because tier1 is the largest and most-audited share. Document this rule in `split.ts`.

**Migration stance (critical, do not overreach):** existing `REAL` columns store doubles that are already lossy. **Do not run a data migration that rewrites amounts** in this phase — rewriting historical money rows is a one-way door with no rollback. Instead:
- New computation writes correct minor-unit values through a compatible representation.
- Add a **read-time normalization** at the repository boundary: convert `REAL` → minor units once, at the query edge, via `parse.ts`.
- Record the decision and the eventual column-type migration as a **Phase 07+ follow-up** with its own rehearsal. This phase fixes computation, not storage. KISS — one door at a time.

## Related Code Files
### Create
- `src/lib/money/types.ts`
- `src/lib/money/constants.ts`
- `src/lib/money/parse.ts`
- `src/lib/money/format.ts`
- `src/lib/money/split.ts`
- `src/lib/money/index.ts`
- `src/lib/money/__tests__/money.test.ts`
- `src/lib/money/__tests__/split.test.ts`

### Modify
- `src/lib/earnings/calculator.ts` — replace `:340-344` float tier math with `split.ts`; replace `:620-622` reduce-with-float with integer summation.
- `src/lib/payouts/payouts-service.ts` — types `:14,:17,:29,:32` to minor units at the boundary; `:190-192` sums normalized on read.
- `src/lib/payouts/adapters/stellar-adapter.ts:88,123,204,205` — remove `toFixed` rounding; convert fees through `parse.ts` and document that fee estimates are estimates (bounds, not exact).
- `worker-wrapper.js` — the payout cron (`:71` onward). Replace inline `* 0.01` fee and float accumulation; work in minor units; add the KYC gate.

### Delete
- *(none)*

## Implementation Steps
1. **Build the money module first (steps 1-4, one commit), before touching callers.** `src/lib/money/`:
   - `types.ts`: `export type MinorUnits = bigint & { readonly __brand: unique symbol };` plus `MoneyError` class with a `kind: 'PRECISION_LOSS' | 'NEGATIVE' | 'OVERFLOW'` discriminated union. No `:any`.
   - `constants.ts`: `export const USDC_DECIMALS = 6 as const; export const USDC_SCALE = 1_000_000n;`
   - `parse.ts`: `toMinorUnits(input: string | number | bigint): MinorUnits`. For `string`: parse integer and fractional parts explicitly, reject >6 fraction digits with `PRECISION_LOSS`. For `number`: reject if `!Number.isFinite`, reject if the value cannot round-trip at 6dp, then convert via `BigInt(Math.round(x * 1e6))` — and **assert** the round-trip `Number(v) / 1e6` equals the input within 1e-9, else throw. Reject negatives where the caller requires non-negative. Also `fromMinorUnits(v: MinorUnits): bigint` passthrough and `assertNonNegative`.
   - `format.ts`: `formatUsdc(v: MinorUnits, opts?: { decimals?: number }): string` — the **only** place float rendering occurs. Never used in arithmetic.
   - `split.ts`: `splitCommission(total: MinorUnits, rates: { tier1_rate: number; tier2_rate: number; tier3_rate: number }): { tier1: MinorUnits; tier2: MinorUnits; tier3: MinorUnits }`. Rates converted to parts-per-1_000_000 integers. Compute floors, give remainder to tier1. **Invariant asserted at runtime**: `tier1+tier2+tier3 === total` or throw.
2. **Tests for the money module** (`money.test.ts`, `split.test.ts`) — must cover, at minimum:
   - `0`, `1n`, `1_000_000n` (exactly 1.00 USDC), `9007199254740992n` (2^53, JS safe-int limit), and a value beyond 2^53.
   - `"0.000001"` (1 minor unit) parses; `"0.0000001"` (7dp) throws `PRECISION_LOSS`.
   - `0.1 * 3`-style: assert `splitCommission` of an odd total conserves the sum exactly for totals 1..1000 minor units.
   - `formatUsdc(1_000_000n) === "1.000000"` (or the documented default).
   - negative input rejection.
3. **Migrate `earnings/calculator.ts`** to `split.ts` and integer sums. Preserve the *tier ordering and assignment* semantics; only change representation and rounding determinism. Run existing `src/__tests__/earnings.test.ts` — if a test asserted a specific float-rounded value that now differs, the new value is the correct one; update the test **with a comment stating the old was float-drift**.
4. **Migrate payout paths** — boundary conversion at the repository read edge (D1 `REAL` → minor units), not deep in business logic. Add KYC gate in the payout cron:
   ```ts
   // Eligibility: total >= 10000000n minor units (10.00 USDC) AND kycVerified(total >= 500 USDC threshold)
   ```
   Read KYC state from the `024_kyc_compliance_schema.sql` tables by `user_id`; **never** from request input. If KYC status is `pending`/`rejected` and the payout would reach the $500 threshold, skip with a structured audit row (not a console log).
5. **Idempotency.** Ensure the payout cron marks earnings `is_paid = 1` in the **same transactional unit** as payout creation, so a crash between the two cannot double-pay on re-run. Add a test that runs the payout path twice and asserts a single payout record and single ledger movement. D1 transactions: use `db.batch([...])` for the coupled statements.
6. **Audit-log every eligibility skip and every payout** with amount in minor units. A payout that is blocked by KYC must be reconstructible after the fact.
7. **Quantify the delta.** Write a script (throwaway, in `/tmp`, not committed) that recomputes the last N existing earnings rows with the new path and reports the largest absolute difference vs stored value. This number determines whether the change is cosmetic (<0.000001 per row) or material. If material, **STOP and escalate** — this becomes a founder decision, not an engineer's.
8. Validate (Success Criteria).

## Todo List
- [ ] `src/lib/money/*` created; `MinORUnits` branded type prevents plain-number misuse
- [ ] `split.ts` conserves the sum exactly; remainder rule documented (→ tier1)
- [ ] Money tests cover 0, 1, 1e6, 2^53, beyond-2^53, 7dp rejection, negative rejection
- [ ] `earnings/calculator.ts` tier math and sums use minor units
- [ ] Payout types + SQL sums normalized at read boundary
- [ ] `stellar-adapter.ts` `toFixed` money rounding removed; fees documented as estimates
- [ ] KYC gate enforced at $500 using persisted state only
- [ ] Payout creation + earnings marking are one transactional unit; double-run test passes
- [ ] Delta report written; material delta (if any) escalated before merge
- [ ] Zero new `:any`; `grep "toFixed" src/lib/money` returns only `format.ts`

## Success Criteria
**Definition of done**: no money arithmetic in the codebase uses float; tier splits conserve exactly; payouts are idempotent and KYC-gated; the numerical delta vs. current production behavior is quantified and signed off.

**Validation commands**:
```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
npx tsc --noEmit && echo TS_OK
npx eslint . --ext .ts,.tsx --max-warnings 0 && echo LINT_OK
CI=true npx jest src/lib/money src/__tests__/earnings.test.ts src/lib/payouts 2>&1 | tail -8
CI=true npx jest 2>&1 | tail -8                       # full suite, 0 failed
# Invariant: no float money math outside format.ts
grep -rn "toFixed" src/lib --include="*.ts" | grep -v __tests__ | grep -v "format.ts" | wc -l   # expect 0
grep -rn "\* 0\.\(30\|10\|05\|01\)" src/lib worker-wrapper.js --include="*.ts" --include="*.js" | wc -l  # expect 0
```

## Risk Assessment
| Risk | Likelihood × Impact | Mitigation |
|------|--------------------|------------|
| **Changing payouts changes money already in-flight** | **Medium × Critical** | Step 7 delta report is a mandatory gate. No DB column migration in this phase. Any material delta is escalated, not merged. |
| Tier-split remainder rule changes each affiliate's share by 1 minor unit | **High × Low** | Deterministic remainder-to-tier1, documented, tested. Max error 1e-6 USDC — acceptable and auditable. |
| `strict` + `Branded bigint` breaks unrelated callers (money type leaks into counters/IDs) | Medium × Medium | Apply branded type only at money boundaries; plain `number` stays for counts. Scope the brand narrowly — KISS. |
| Double-pay regression if transaction boundaries are wrong | **Low × Critical** | Step 5 explicit double-run test; `db.batch` for coupled statements. This is the one test that must not be skipped. |
| KYC gate blocks legitimate payouts and users get no explanation | Medium × Medium | Structured audit row + notification on skip; never a silent skip. |
| `Number(1e6)` scale breaks beyond 2^53 minor units (~9e9 USDC) | Low × Low | Money module tests the >2^53 boundary and uses `BigInt` paths; `parse.ts` rejects rather than truncates. |

## Security Considerations
- KYC threshold must read persisted, authenticated state — a request-supplied `kyc: true` is an injection vector for bypassing a compliance control.
- Payout eligibility changes must be auditable (who skipped, why, amount in minor units).
- `$500` threshold is a **policy constant**; keep it in config/env with a documented default, never hardcoded inline in the eligibility expression.
- No secrets in the money module; fee estimates read prices from the existing price source.
- Consider a **sanctions/sanctions-list pre-check hook** position now (even if the list is wired later) so the eligibility function has a single place where compliance rules compose. YAGNI: define the seam, do not implement an unimplemented list.

## Next Steps
- **Feeds Phase 05**: the staging rehearsal must exercise payout correctness against real (staging) data, which requires this phase's correctness properties.
- **Gates Phase 06**: money correctness is a non-negotiable gate item.
- **Phase 07+ follow-up**: D1 `REAL` → integer/TEXT money column migration, with its own rehearsal and rollback plan. Explicitly deferred here.
- Cross-ref `reports/researcher-quality-tests-report.md` (pending) for money-path coverage specifics.
