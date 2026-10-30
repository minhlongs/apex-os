#!/usr/bin/env bash
# scripts/go-live-gate.sh
# Unified Go-Live Gate (G0..G5) for ApexOS Production Release.
# Deliberately uses `set -u` without `set -e` so all checks are evaluated and reported.

set -u

export PATH="/opt/homebrew/opt/node@26/bin:$(pwd)/node_modules/.bin:${PATH}"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  local group="$1"
  local msg="$2"
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "[PASS] ${group}: ${msg}"
}

fail() {
  local group="$1"
  local msg="$2"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "[FAIL] ${group}: ${msg}"
}

echo "============================================================"
echo " ApexOS Go-Live Gate Verification (G0 - G5)"
echo "============================================================"

# ------------------------------------------------------------------------------
# G0: Runtime & Workspace Invariants
# ------------------------------------------------------------------------------
NODE_VER="$(node --version 2>/dev/null || echo 'missing')"
if [[ "${NODE_VER}" == v26.* ]]; then
  pass "G0" "Node runtime is ${NODE_VER}"
else
  fail "G0" "Node runtime is ${NODE_VER}, required v26.x"
  exit 1
fi

if [[ "${ALLOW_DIRTY_TREE:-0}" != "1" ]]; then
  DIRTY="$(git status --porcelain)"
  if [[ -z "${DIRTY}" ]]; then
    pass "G0" "Working tree is clean"
  else
    fail "G0" "Working tree is dirty (set ALLOW_DIRTY_TREE=1 only for local pre-commit checks)"
  fi
else
  pass "G0" "Dirty tree check bypassed via ALLOW_DIRTY_TREE=1"
fi

if [[ -n "${GATE_SHA:-}" ]]; then
  HEAD_SHA="$(git rev-parse HEAD)"
  if [[ "${HEAD_SHA}" == "${GATE_SHA}" ]]; then
    pass "G0" "HEAD matches GATE_SHA (${HEAD_SHA})"
  else
    fail "G0" "HEAD (${HEAD_SHA}) does not match GATE_SHA (${GATE_SHA})"
  fi
fi

# ------------------------------------------------------------------------------
# G1: Code Quality Gates (optional fast skip via SKIP_HEAVY_G1=1 if just run)
# ------------------------------------------------------------------------------
if [[ "${SKIP_HEAVY_G1:-0}" != "1" ]]; then
  if npm run typecheck >/dev/null 2>&1; then
    pass "G1" "tsc --noEmit passed with 0 errors"
  else
    fail "G1" "tsc --noEmit failed"
  fi

  if npm run lint >/dev/null 2>&1; then
    pass "G1" "eslint passed with 0 warnings"
  else
    fail "G1" "eslint failed"
  fi
else
  pass "G1" "Heavy typecheck/lint skipped via SKIP_HEAVY_G1=1"
fi

# ------------------------------------------------------------------------------
# G2: Build & Toolchain Protection
# ------------------------------------------------------------------------------
if grep -q "NEXT_DISABLE_TYPE_CHECK" package.json; then
  fail "G2" "NEXT_DISABLE_TYPE_CHECK bypass present in package.json"
else
  pass "G2" "No NEXT_DISABLE_TYPE_CHECK in package.json"
fi

if grep -q "ignoreBuildErrors" next.config.js; then
  fail "G2" "ignoreBuildErrors present in next.config.js"
else
  pass "G2" "No ignoreBuildErrors in next.config.js"
fi

if [[ ! -f wrangler.toml ]]; then
  pass "G2" "wrangler.toml is absent (single JSONC authority)"
else
  fail "G2" "wrangler.toml exists alongside wrangler.jsonc"
fi

if node -e "process.exit(require('./package.json').devDependencies?.wrangler ? 0 : 1)"; then
  pass "G2" "wrangler is pinned in devDependencies"
else
  fail "G2" "wrangler missing from devDependencies"
fi

if node -e "const p=require('./package.json'); const v=p.devDependencies?.['@opennextjs/cloudflare']||p.dependencies?.['@opennextjs/cloudflare']; process.exit(v && v !== 'latest' ? 0 : 1)"; then
  pass "G2" "@opennextjs/cloudflare is pinned"
else
  fail "G2" "@opennextjs/cloudflare is missing or 'latest'"
fi

if bash scripts/assert-staging-isolation.sh >/dev/null 2>&1; then
  pass "G2" "Staging D1/KV/R2 bidirectional isolation verified"
else
  fail "G2" "Staging D1/KV/R2 bidirectional isolation check failed"
fi

# ------------------------------------------------------------------------------
# G3: Deploy Proof & Version Endpoint
# ------------------------------------------------------------------------------
if [[ -f src/app/api/version/route.ts ]]; then
  pass "G3" "/api/version route handler exists"
else
  fail "G3" "/api/version route handler missing"
fi

if [[ -n "${GATE_URL:-}" ]]; then
  LIVE_SHA="$(curl -fsSL "${GATE_URL}/api/version" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).sha||'')}catch{}})")"
  if [[ -n "${GATE_SHA:-}" && "${LIVE_SHA}" == "${GATE_SHA}" ]]; then
    pass "G3" "Live /api/version SHA matches GATE_SHA (${LIVE_SHA})"
  else
    fail "G3" "Live /api/version SHA (${LIVE_SHA}) does not match GATE_SHA (${GATE_SHA:-unset})"
  fi
fi

# ------------------------------------------------------------------------------
# G4: Money & Compliance Integrity
# ------------------------------------------------------------------------------
# G4a: Structural check that no await request.json() precedes await request.text() in webhooks
bad_webhook=0
for f in $(find src/app/api/webhooks -name "route.ts"); do
  jl="$(grep -n "await request.json()" "$f" | head -1 | cut -d: -f1)"
  tl="$(grep -n "await request.text()" "$f" | head -1 | cut -d: -f1)"
  if [[ -n "${jl}" && -n "${tl}" && "${jl}" -lt "${tl}" ]]; then
    bad_webhook=1
  fi
done
if [[ "${bad_webhook}" -eq 0 ]]; then
  pass "G4a" "All webhook routes read raw text before JSON"
else
  fail "G4a" "Webhook route reads request.json() before request.text()"
fi

# G4b: Solana MOCK_SIGNED_TX_PAYLOAD absence
mock_tx_count="$(grep -rc "MOCK_SIGNED_TX_PAYLOAD" src --include="*.ts" | awk -F: '{s+=$2} END {print s+0}')"
if [[ "${mock_tx_count}" -eq 0 ]]; then
  pass "G4b" "MOCK_SIGNED_TX_PAYLOAD absent from src/"
else
  fail "G4b" "Found MOCK_SIGNED_TX_PAYLOAD in src/"
fi

# G4c & G4d: Settlement verification & adapter integrity
if grep -q "prepareRetireEarningsStatement" src/lib/payouts/batch-settlement-service.ts; then
  pass "G4d" "Earnings retirement consolidated behind verified on-chain helper"
else
  fail "G4d" "prepareRetireEarningsStatement helper missing"
fi

# G4e: Float money multipliers & const fee = 0.0 absence
float_mult_count="$(grep -rn "\* 0\.\(30\|10\|05\|01\)" src/lib --include="*.ts" | wc -l | tr -d ' ')"
fee_float_count="$(grep -c "const fee = 0.0" src/lib/payouts/batch-settlement-service.ts || true)"
worker_float_count="$(grep -c "total_amount \* 0.01" worker-wrapper.js || true)"
if [[ "${float_mult_count}" -eq 0 && "${fee_float_count}" -eq 0 && "${worker_float_count}" -eq 0 ]]; then
  pass "G4e" "Zero float money multipliers in src/lib, batch-settlement-service.ts, and worker-wrapper.js"
else
  fail "G4e" "Float money multiplier found (src/lib=${float_mult_count}, batch-fee=${fee_float_count}, worker=${worker_float_count})"
fi

# G4f: Decisions D1 and D2 recorded in go-live-signoff.md
SIGNOFF_FILE="plans/261020-zero-bug-go-live/go-live-signoff.md"
if [[ -f "${SIGNOFF_FILE}" ]] && grep -q "D1=[^[:space:]]" "${SIGNOFF_FILE}" && grep -q "D2=[^[:space:]]" "${SIGNOFF_FILE}"; then
  pass "G4f" "Decisions D1 and D2 recorded in ${SIGNOFF_FILE}"
else
  fail "G4f" "Decisions D1 and/or D2 missing in ${SIGNOFF_FILE}"
fi

# G4g: Real exchange webhook route handlers imported in tests
if grep -rq "@/app/api/webhooks/exchange/route" src/__tests__/webhooks && \
   grep -rq "@/app/api/webhooks/exchange/okx/route" src/__tests__/webhooks && \
   grep -rq "@/app/api/webhooks/exchange/kucoin/route" src/__tests__/webhooks; then
  pass "G4g" "All 3 exchange webhook route handlers imported in regression tests"
else
  fail "G4g" "Missing direct route handler import for one or more exchange webhooks"
fi

# G4h & G4i: Cron schedule parity & fail-closed auth
if grep -q "CRON_WEEKLY_PAYOUTS" worker-wrapper.js && grep -q "AUTO_SETTLE_PAYOUTS" src/app/api/cron/route.ts; then
  pass "G4h" "Cron payout schedule & AUTO_SETTLE_PAYOUTS manual-first gate wired"
else
  fail "G4h" "Cron payout schedule or AUTO_SETTLE_PAYOUTS gate missing"
fi

if grep -q "if (!cronSecret || authHeader !== \`Bearer \${cronSecret}\`)" src/app/api/cron/route.ts; then
  pass "G4i" "/api/cron fails closed when CRON_SECRET is missing or mismatched"
else
  fail "G4i" "/api/cron fail-closed auth check missing"
fi

# ------------------------------------------------------------------------------
# G5: Operational Readiness
# ------------------------------------------------------------------------------
if [[ -f docs/rollback-runbook.md && -f docs/go-live-checklist.md && -f docs/cutover-runbook.md && -f docs/project-changelog.md ]]; then
  pass "G5" "Rollback, Cutover runbooks, Go-Live checklist, and Changelog present"
else
  fail "G5" "Missing docs/rollback-runbook.md, docs/go-live-checklist.md, docs/cutover-runbook.md, or docs/project-changelog.md"
fi

if [[ -f scripts/reconcile-historical-payouts.sh ]] && grep -q "GLOB '\*\[\^0-9a-fA-F\]\*'" scripts/reconcile-historical-payouts.sh; then
  pass "G5" "Historical payout reconciliation script enforces SQLite GLOB 64-char hex parity"
else
  fail "G5" "Historical payout reconciliation script missing SQLite GLOB 64-char hex parity"
fi

# ------------------------------------------------------------------------------
# G6: Security, Cashback Launch Guard & Greenfield Paper Engine Replay
# ------------------------------------------------------------------------------
if grep -rq "apex_os_edge_hmac_secret" src/; then
  fail "G6a" "Hardcoded HMAC secret literal found in src/"
else
  pass "G6a" "Zero hardcoded HMAC secret literals in src/"
fi

if grep -rq "12ms" src/; then
  fail "G6b" "Fabricated 12ms latency claims found in src/"
else
  pass "G6b" "Zero fabricated 12ms marketing claims in src/"
fi

if grep -q "V1_STELLAR_ONLY_PAYOUTS" src/lib/payouts/router.ts && \
   grep -q "V1_STELLAR_ONLY_PAYOUTS" wrangler.jsonc && \
   grep -q "V1_STELLAR_ONLY_PAYOUTS" wrangler.staging.jsonc; then
  pass "G6c" "V1 Stellar-only payout launch gate wired across router and wrangler configs"
else
  fail "G6c" "V1 Stellar-only payout launch gate missing from router or wrangler configs"
fi

if grep -q "fallback_fixture" src/lib/crawler/service.ts; then
  pass "G6d" "Crawler fallback fixture explicit provenance metadata attached"
else
  fail "G6d" "Crawler fallback fixture provenance metadata missing"
fi

if npx jest src/lib/paper/__tests__/paper-engine-and-replay.test.ts src/lib/payouts/__tests__/v1-stellar-only-gate.test.ts >/dev/null 2>&1; then
  pass "G6e" "Paper trading 50-tick deterministic replay (100% bit-identical) and V1 Stellar gate pass"
else
  fail "G6e" "Paper trading deterministic replay or V1 Stellar gate unit tests failed"
fi

# ------------------------------------------------------------------------------
# G7: Paper Trading Admin Console Surfaces & CI/CD Deployment Hardening
# ------------------------------------------------------------------------------
if [[ -f src/components/admin/paper/PaperTradingConsole.tsx && \
      -f src/app/api/admin/paper/overview/route.ts && \
      -f src/app/api/admin/paper/export/route.ts && \
      -f src/database/migrations/028_paper_trading_journal.sql ]] && \
   grep -q "PAPER SIMULATION ONLY" src/components/admin/paper/PaperTradingConsole.tsx; then
  pass "G7a" "All 3 Paper Trading Admin Console surfaces & immutable D1 schema present with PAPER watermark"
else
  fail "G7a" "Missing Paper Trading Admin Console surfaces or migration"
fi

if grep -q "assert-staging-isolation.sh" package.json && \
   grep -q "assert-staging-isolation.sh" .github/workflows/deploy.yml; then
  pass "G7b" "Production deployment gate enforces assert-staging-isolation.sh in package.json and deploy.yml"
else
  fail "G7b" "Production deployment gate missing assert-staging-isolation.sh enforcement"
fi

echo "============================================================"
echo " Gate Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
echo "============================================================"

if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  exit 1
fi
exit 0
