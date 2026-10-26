# Phase 06 — Final Go-Live Gate & Verification

## Overview
- **Priority**: P1
- **Status**: pending
- **Effort**: 8h
- **Blocks**: production cutover (Phase 07)
- **Depends on**: Phase 02, 04, 05 all complete

This phase is the AND of everything before it. Its only job is to refuse go-live if any prior gate is unmet. It adds no features and fixes no bugs.

## Key Insights
**A. "Zero bug" is not achievable as a proof; it is achievable as a gate.** The plan cannot guarantee zero defects. What it *can* guarantee: every known failure class has a named detection mechanism and every item has an owner and a command. The gate converts "we think it's ready" into "these 40 checks passed on SHA X."

**A2. The seven P0 defects are HARD gate items (G4a–G4e money, G4h–G4i cron).** Each is a verified, reproducible defect with a proof-of-negative assertion. Go-live is refused if any is unfixed or if its proof-of-negative still matches. See "G4 — Money & Compliance Integrity" below. User decisions D1/D2 must also be **answered and recorded** — the gate refuses on an unanswered decision, because "current state is worst of both" is not a shippable default. P0-6 (cron schedule string never matches the dispatcher, so weekly payouts silently never fire) and P0-7 (`/api/cron` fails open when `CRON_SECRET` is unset) sit in the deploy/config surface rather than the money module, but are equally hard-blocking.

**A3. A green test suite is not evidence until it could have caught the bug.** The exchange-webhook defect shipped green behind 3186 passing tests because its tests exercise self-written signature helpers and **never import the route handler**, and because `jest.setup.ts`'s `Request` mock makes body reads repeatable. Both maskers must be closed or any "fix" is unverified by construction. Note the repo already contains handler-level route tests elsewhere, so this is a coverage gap, not a testability limit.

**B. Historical precedent exists.** `plans/260627-1547-go-live-readiness` and the Week-1 closure reports (`plans/reports/260801-1901-week1-closure-gate-report.md`) show the same gaps recurring: deferred deploy verification, missing `/api/version`, absent deploy script. **All three are now closed in Phase 05.** The gate must assert they *stay* closed.

**C. Known, deliberate non-goals.** These must be listed as accepted risks, not hidden:
- Solana/EVM payout resolution (D1) — if **gated fail-closed** is chosen, users on those chains cannot be paid until real signing ships. Mitigation: persisted skip-reason + notification; follow-up tracked. If **real signing** is chosen, that adds new key-management surface needing its own review.
- Second payout service `payouts-service.ts` (D2) — if not consolidated, divergent money semantics remain a standing reconciliation hazard. Mitigation: documented ownership boundary.
- Sentry is wired-or-deleted in Phase 04; if not, **server-side errors in cron/webhook/payout are invisible**. Mitigation: Cloudflare worker logs + alerts (Phase 05/07) as the interim signal.
- KYC $500 enforcement is added in Phase 04, but **a real sanctions/AML screening vendor is not integrated** (Phase 07+).
- D1 migration ledger is not built (Phase 07+).
- Mobile app (`apex-os-mobile/`) is out of scope for this go-live.
- Performance testing is limited to the existing ≤200ms target from CLAUDE.md; no load test is run.
Each is a *documented* residual risk with a mitigation, which is the only honest way to call this zero-bug for the *deployed surface*.

**D. Environments differ.** Node 26.7.0 is the only verified green runtime (Phase 01 proves it). Any gate command run on the default Node 22 produces 443 false failures. The gate script must therefore **assert Node version first** and refuse to continue otherwise, otherwise a green run can be fabricated by accident.

## Requirements
### Functional
- F1. A single gate script producing one deterministic PASS/FAIL verdict with per-item evidence.
- F2. Gate refuses to run off Node 26; refuses to run on a dirty tree.
- F3. Gate must fail on **any** single unmet item (no "partial pass").
- F4. Gate output is archivable (timestamp + SHA + per-item result) for audit.
- F5. Founder sign-off is recorded against a specific SHA.
- F6. **G4a–G4i block go-live unconditionally.** No waiver mechanism exists for the seven P0 defects or the two user decisions — an unanswered decision is a FAIL, not a deferred item.

### Non-Functional
- NF1. The gate is read-only: it verifies, it does not mutate or deploy.
- NF2. Runtime target < 15 minutes so it is actually run.
- NF3. Every check names its evidence command, so a FAIL is diagnosable without re-deriving the gate.

## Architecture
**One script, one verdict.** `scripts/go-live-gate.sh` runs six check groups and exits non-zero if any fails:

```
Gate
 ├─ G0 Invariants: node version, clean tree at pinned SHA, no secrets staged
 ├─ G1 Code gates:  tsc 0 │ eslint 0 │ jest 0 failed │ build succeeds
 ├─ G2 Protection:  no type-bypass absent-guards (build script, next.config)
 ├─ G3 Deploy proof: .open-next/worker.js built │ /api/version matches SHA │ smoke green
 ├─ G4 Money & compliance: G4a-G4e money defects closed │ G4h cron dispatch │ G4i cron auth closed │ decisions answered │ no float money ops
 └─ G5 Ops readiness: rollback runbook exists │ alerts active │ staging rehearsal recorded
```

### G4 — Money & Compliance Integrity (the blocking group)

| Item | Assertion | Evidence |
|------|-----------|----------|
| **G4a** Webhook verification | No `await request.json()` precedes `await request.text()` in any `src/app/api/webhooks/**` | `grep -n` + a real-handler regression test that **fails on the old order** |
| **G4b** Solana integrity | `grep -rn MOCK_SIGNED_TX_PAYLOAD src` = 0 **and** no adapter returns `success: true` with a fabricated id | `chain-adapter-integrity.test.ts` |
| **G4c** Ethereum integrity | No `transactionHash` derived from payout metadata | same test |
| **G4d** Settlement verification | `is_paid=1` unreachable without `router.verifyTransaction` → `confirmed` | `settlement-verification.test.ts` |
| **G4e** Money representation | No float money multipliers; `const fee = 0.0` absent; ingestion on minor units; tier split conserves | `money.test.ts` + greps |
| **G4h** Cron reaches payouts | Every schedule string configured in `wrangler.jsonc` matches a dispatch branch in `worker-wrapper.js`; the payout cron string is defined once and imported by both | `cron-schedule.test.ts` dispatching on each configured value; grep proves no duplicated literal |
| **G4i** Cron auth fails closed | With `CRON_SECRET` unset, `/api/cron` and `/api/monitoring/retention` return 401 — never 200 | route test asserting no-secret → 401 (not 200) |
| **G4f** Decisions recorded | D1 (Solana/EVM live/gated) and D2 (`payouts-service.ts`) answered in writing | `go-live-signoff.md` |
| **G4g** Maskers closed | `jest.setup.ts` `Request` mock enforces single-read; a test imports the **exchange** webhook route (all three) | file + test presence |

**Why groups, not a flat list:** a group failure maps directly to a phase. `G1` failing means Phase 02 regressed; `G3` means Phase 05. This makes triage instant instead of reading 40 individual failures.

**Proof-of-negative checks (the most important kind):** the gate must assert *absence*, not just presence:
- `grep` that `NEXT_DISABLE_TYPE_CHECK` is **not** in `package.json`.
- `grep` that `ignoreBuildErrors` is **not** in `next.config.js`.
- `grep` that no `* 0.30` / `* 0.01` float money multipliers remain.
- `grep` that `wrangler.toml` does **not** exist.
- `grep` that `MOCK_SIGNED_TX_PAYLOAD` is **not** in `src/`.
- `grep` that `const fee = 0.0` is **not** in `batch-settlement-service.ts`.
- Structural: **no** `await request.json()` precedes `await request.text()` in any `src/app/api/webhooks/**`.

These are the defects this plan opened and closed; asserting their continued absence prevents silent reintroduction.

**Version-pinning discipline:** the gate takes `$GATE_SHA` and verifies the checkout is exactly that SHA (`git rev-parse HEAD`). This prevents "the gate passed on my machine but we shipped something else."

**Toolchain-pinning discipline (added):** the deploy surface must be reproducible, not PATH-dependent. G2 asserts:
- `wrangler` is declared in `devDependencies` and **non-empty** — no deploy/rollback may depend on a global install.
- `node_modules/.bin/wrangler` exists and its `--version` equals the declared version.
- `which wrangler` resolves **inside the repo**, never `/opt/homebrew/bin`. This is what prevents a rollback that works on the founder's laptop and nowhere else.
- `@opennextjs/cloudflare` is pinned (not `"latest"`).
- `.open-next/` bundles are **fresh relative to the git commit date** — a stale bundle is evidence of nothing. Assert reg: a symbol present only in current source appears in the bundle.

## Related Code Files
### Create
- `scripts/go-live-gate.sh` — the gate.
- `docs/go-live-checklist.md` — human-readable checklist with per-item owner + evidence, generated from/kept in sync with the script.
- `plans/261020-zero-bug-go-live/go-live-signoff.md` — founder sign-off record (SHA, timestamp, decisions, accepted risks).

### Modify
- `package.json` — add `"gate": "bash scripts/go-live-gate.sh"`.
- `CLAUDE.md` — record the gate command and the "no go-live without green gate" rule.

### Delete
- *(none)*

## Implementation Steps
1. **Create `scripts/go-live-gate.sh`.** Structure:
   - Header: `set -u` (deliberately **not** `set -e` — the gate must collect all failures, then exit non-zero).
   - `require_node_26()`: compare `node --version` to the expected; `fail("G0: Node is X, required 26.7.0")` on mismatch and exit immediately.
   - `require_clean_tree()`: `git status --porcelain` must be empty (excluding nothing — the Phase 03 decision must be resolved so the tree is genuinely clean); `git rev-parse HEAD` must equal `$GATE_SHA`.
   - `pass()`/`fail()` helpers incrementing counters and printing `[PASS]`/`[FAIL] <group>: <item> — evidence: <cmd>`.
   - Final: print the summary block and `exit 1` if any `fail()` fired.
2. **Encode G0–G5** exactly as in the Architecture section. Every item names its evidence command inline.
2a. **G4a implementation detail** — the ordering check must be structural, not a naive `grep -c`:
   ```bash
   bad=0
   for f in $(find src/app/api/webhooks -name route.ts); do
     jl=$(grep -n "await request.json()" "$f" | head -1 | cut -d: -f1)
     tl=$(grep -n "await request.text()"  "$f" | head -1 | cut -d: -f1)
     if [ -n "$jl" ] && [ -n "$tl" ] && [ "$jl" -lt "$tl" ]; then bad=1; fi
   done
   [ "$bad" -eq 0 ] && pass "G4a" || fail "G4a" "json() read before text() — signature over empty body"
   ```
2b. **G4f** reads `go-live-signoff.md` and requires both `D1=` and `D2=` to be non-empty. Absent/empty → FAIL. This is what prevents shipping the "worst of both" current state.
2c. **G4g** verifies (i) tests import all three exchange route handlers, and (ii) `jest.setup.ts`'s `Request` mock enforces single-read. Assert on `from '@/app/api/webhooks/exchange…'` specifically, **not** the substring `webhooks/exchange` — three existing tests contain that path as a *string literal* (`kucoin:56,:107`) while importing no handler at all. Without (i) and (ii), G4a can pass on code whose regression is undetectable.
3. **G2 check implementation detail.** The type-bypass absence must be checked against the *effective* config, so the gate reads both files:
   ```bash
   grep -q "NEXT_DISABLE_TYPE_CHECK" package.json && fail "G2" "build bypass present" \
     || pass "G2: build runs next typecheck"
   grep -q "ignoreBuildErrors" next.config.js && fail "G2" "ignoreBuildErrors present" \
     || pass "G2: next.config does not ignore build errors"
   ```
4. **G3 check requires a deployed target.** Gate takes `$GATE_URL` and `$GATE_SHA`; curls `/api/version` and asserts `sha === $GATE_SHA`. Without a live target the gate cannot verify deployment — so **the gate is run against the production URL** (post-deploy), not just locally. Document that the gate has a local mode (G0/G1/G2/G4) and a deploy mode (all groups).
5. **Create `docs/go-live-checklist.md`** mirroring the script, with a human owner column and a link to the phase that closes each item. This is the founder-facing artifact.
6. **Run the gate in local mode and close every FAIL.** Iterate until `PASS` count == item count and exit code is 0. **Do not adjust the gate to match the code; adjust the code to match the gate** — the gate encodes intent. (Exception: if an item is genuinely wrong, raise it explicitly and amend the gate knowingly, recorded here.)
7. **Capture accepted residual risks** in `docs/go-live-checklist.md` (see Key Insight C). Each needs a mitigation and a follow-up owner.
8. **Deploy, then run the gate in deploy mode against prod.** Record the verdict + SHA + timestamp in `plans/261020-zero-bug-go-live/go-live-signoff.md`.
9. **Founder sign-off** against that exact SHA.

## Todo List
- [ ] `scripts/go-live-gate.sh` created with G0–G5 groups (G4a–G4g)
- [ ] Gate refuses off-Node-26 and refuses a dirty tree
- [ ] Gate verifies checkout == `$GATE_SHA`
- [ ] G2 asserts **absence** of both type bypasses and of `wrangler.toml`
- [ ] G2 asserts `wrangler` pinned + in-repo binary + adapter not `"latest"` + bundle freshness
- [ ] **G4a** structural json-before-text check across all webhook routes
- [ ] **G4b** `MOCK_SIGNED_TX_PAYLOAD` absent
- [ ] **G4c** no fabricated `transactionHash` (`chain-adapter-integrity.test.ts`)
- [ ] **G4d** `is_paid` unreachable without verified-confirmation (`settlement-verification.test.ts`)
- [ ] **G4e** float money multipliers + `const fee = 0.0` absent
- [ ] **G4f** D1 and D2 recorded non-empty in `go-live-signoff.md` (unanswered → FAIL)
- [ ] **G4g** real-route tests present for all three exchange webhooks; `jest.setup.ts` single-read mock
- [ ] G3 deploy mode curls `/api/version` and matches SHA
- [ ] Local-mode gate: exit 0, 100% PASS
- [ ] `docs/go-live-checklist.md` mirrors the script with owners
- [ ] Accepted residual risks listed with mitigations + follow-up owners
- [ ] `go-live-signoff.md` records SHA, timestamp, verdict, D1/D2 answers
- [ ] Founder sign-off obtained

## Success Criteria
**Definition of done**: `scripts/go-live-gate.sh` exits 0 in deploy mode against the production URL, with every item PASS and evidence recorded, both user decisions answered, and the founder has signed off against that SHA.

**Validation commands**:
```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
node --version                                                     # v26.7.0
git rev-parse HEAD                                                 # equals GATE_SHA
git status --porcelain                                             # empty
# local mode (pre-deploy)
GATE_SHA=$(git rev-parse HEAD) npm run gate
# deploy mode (post-deploy, against prod)
GATE_SHA=$GITHUB_SHA GATE_URL=https://apex-os.<subdomain>.workers.dev npm run gate
# spot-check the proof-of-negatives are real (each must match its comment)
grep -c "NEXT_DISABLE_TYPE_CHECK" package.json                      # 0
grep -c "ignoreBuildErrors" next.config.js                          # 0
test ! -f wrangler.toml && echo NO_DUAL_CONFIG_OK
node -e "process.exit(require('./package.json').devDependencies?.wrangler?0:1)" && echo WRANGLER_PINNED
which wrangler | grep -q "^$(pwd)/node_modules" && echo WRANGLER_IN_REPO
node -e "const v=require('./package.json');process.exit(v.dependencies['@opennextjs/cloudflare']==='latest'?1:0)" && echo ADAPTER_PINNED
grep -rn "\* 0\.\(30\|10\|05\|01\)" src/lib --include="*.ts" | wc -l   # 0
grep -rc "MOCK_SIGNED_TX_PAYLOAD" src --include="*.ts"               # 0
grep -c "const fee = 0.0" src/lib/payouts/batch-settlement-service.ts # 0
# G4a proof-of-negative must FAIL if the defect is reintroduced
git stash && npm run gate; echo "exit=$? (expect 1)"; git stash pop  # temporarily reverts fixes → G4 must catch
```
Expected: gate prints all `[PASS]`, `exit 0`, and each spot-check matches its comment. The final stashed run is a deliberate negative test — the gate MUST exit 1 when the fixes are reverted.

## Risk Assessment
| Risk | Likelihood × Impact | Mitigation |
|------|--------------------|------------|
| **Gate is weakened to pass rather than code fixed to pass** | **High × Critical** | Step 6 inverts it explicitly: the gate encodes intent. Any gate amendment must be a recorded decision, not a quiet edit. |
| **A P0 fix is "closed" but its regression is still undetectable (maskers unclosed)** | **High × Critical** | G4g asserts both maskers closed; the stashed negative test in Validation proves the gate actually fails when fixes are reverted. |
| Gate run on the wrong Node fabricates a green result | Medium × High | G0 asserts Node 26 first and exits; no partial runs. |
| Gate passes locally but prod is a different SHA | Medium × Critical | G0 asserts `HEAD == $GATE_SHA`; G3 asserts the live `/api/version` SHA. |
| Users already marked `is_paid=1` with fabricated tx ids are never detected | Medium × Critical | Phase 07 pre-flight reconciliation (promoted to a Phase 07 step); flagged as an accepted risk here if not run. |
| D1 left unanswered under launch pressure → ships "worst of both" | **Medium × Critical** | G4f treats an unanswered decision as a hard FAIL. No waiver exists. |
| Residual risks silently omitted → "zero-bug" claim is dishonest | Medium × High | Step 7 makes the list mandatory and founder-visible in the sign-off. || Gate too slow → bypassed under launch pressure | Medium × Medium | <15 min target; deploy-mode gate reuses already-built artifacts where possible. |
| Founders sign off on a SHA that is later amended | Low × High | Sign-off records SHA + timestamp; any subsequent commit requires a new gate run and new sign-off. |

## Security Considerations
- The gate itself contains no secrets and makes no authenticated calls except the public smoke checks.
- A green gate is evidence that cron is not publicly callable and that webhook signature verification rejects bad input — both are gate items, so a security regression blocks go-live.
- G4a closes a genuine **security** defect, not just availability: verifying HMAC over an empty body weakens signature enforcement on the exchange ingestion path.
- G4b/G4c close **financial-integrity** defects: fabricated transaction ids in `payouts.transaction_id` make the ledger unauditable and would defeat any post-incident investigation.
- If D1(b) is chosen, new Solana/EVM key material requires its own secrets review before go-live.
- Accepted-risk list must explicitly state that full AML/sanctions screening is not integrated, so the founder cannot claim a compliance posture that does not exist.

## Next Steps
- **Unblocks Phase 07**: production cutover is authorized only from a green gate + recorded sign-off.
- **Promoted to Phase 07 pre-flight**: reconcile existing `payouts.transaction_id` values against chain state — rows produced by the fabricated-id paths are fake payouts.
- **Post-go-live**: gate should run on every subsequent production deploy (not just the first) — record this in `docs/go-live-checklist.md` so it becomes doctrine, not a one-off.
- Cross-ref `reports/researcher-quality-tests-report.md` (pending) — any coverage gap it names that is not covered by an item here must be added as an explicit accepted risk or a new gate item.
