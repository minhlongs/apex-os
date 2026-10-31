#!/usr/bin/env node
/**
 * scripts/verify-paper-economic-gate.cjs
 *
 * Automated Production Release Gate Verifier for ApexOS Paper Trading.
 * Prohibits manual ALLOW_PRODUCTION_OVERRIDE bypasses and requires verified
 * 30-day real-market evidence for both 'spot-2exch' and 'spot-perp' strategies:
 *   - verified_real_market_days >= 30
 *   - closed_cycles_count >= 100
 *   - realized_net_pnl_usdt > 0
 *   - max_drawdown_pct <= 2.0
 *   - verdict === 'GO'
 *
 * Usage:
 *   node scripts/verify-paper-economic-gate.cjs [--runs-json <path_or_json>]
 */

const fs = require('node:fs');

const REQUIRED_STRATEGIES = ['spot-2exch', 'spot-perp'];
const TARGET_DAYS = 30;
const TARGET_CYCLES = 100;
const MAX_DRAWDOWN_PCT = 2.0;

function evaluateRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return {
      passed: false,
      verdict: 'NO_GO',
      reason: 'No active paper_trading_runs records found. 30-day real-market paper window has not completed.',
      details: [],
    };
  }

  const details = [];
  let allPassed = true;

  for (const strategyId of REQUIRED_STRATEGIES) {
    const run = runs.find((r) => r.strategy_id === strategyId && Number(r.is_active) === 1);
    if (!run) {
      allPassed = false;
      details.push({
        strategyId,
        passed: false,
        reason: `Missing active paper_trading_runs record for strategy '${strategyId}'`,
      });
      continue;
    }

    const days = Number(run.verified_real_market_days ?? 0);
    const cycles = Number(run.closed_cycles_count ?? 0);
    const netPnl = Number(run.realized_net_pnl_usdt ?? 0);
    const maxDd = Number(run.max_drawdown_pct ?? 999);
    const verdict = String(run.verdict ?? 'NO_GO');
    const configHash = String(run.config_hash ?? '');

    const daysOk = Number.isFinite(days) && days >= TARGET_DAYS;
    const cyclesOk = Number.isFinite(cycles) && cycles >= TARGET_CYCLES;
    const pnlOk = Number.isFinite(netPnl) && netPnl > 0;
    const ddOk = Number.isFinite(maxDd) && maxDd >= 0 && maxDd <= MAX_DRAWDOWN_PCT;
    const hashOk = configHash.length >= 32;
    const verdictOk = verdict === 'GO';

    const strategyPassed = daysOk && cyclesOk && pnlOk && ddOk && hashOk && verdictOk;
    if (!strategyPassed) {
      allPassed = false;
    }

    details.push({
      strategyId,
      passed: strategyPassed,
      verifiedRealMarketDays: days,
      closedCyclesCount: cycles,
      realizedNetPnlUsdt: netPnl,
      maxDrawdownPct: maxDd,
      configHash,
      verdict,
      checks: { daysOk, cyclesOk, pnlOk, ddOk, hashOk, verdictOk },
    });
  }

  return {
    passed: allPassed,
    verdict: allPassed ? 'GO' : 'NO_GO',
    reason: allPassed
      ? 'Both strategies passed all 30-day real-market economic gate criteria.'
      : 'One or more strategies have not met the mandatory 30-day / 100-cycle / >0 PnL / <=2% DD gate.',
    details,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let rawInput = process.env.PAPER_RUNS_JSON || '';

  const flagIdx = args.indexOf('--runs-json');
  if (flagIdx !== -1 && args[flagIdx + 1]) {
    const argVal = args[flagIdx + 1];
    if (fs.existsSync(argVal)) {
      rawInput = fs.readFileSync(argVal, 'utf8');
    } else {
      rawInput = argVal;
    }
  }

  let runs = [];
  if (rawInput.trim()) {
    try {
      const parsed = JSON.parse(rawInput);
      runs = Array.isArray(parsed) ? parsed : parsed.results || [];
    } catch (err) {
      console.error('[verify-paper-economic-gate] Failed to parse runs JSON:', err.message);
      process.exit(1);
    }
  }

  const result = evaluateRuns(runs);
  console.log(JSON.stringify(result, null, 2));

  if (!result.passed) {
    console.error(`[BLOCKED] Production Go-Live Economic Verdict: ${result.verdict} — ${result.reason}`);
    process.exit(1);
  }

  console.log(`[APPROVED] Production Go-Live Economic Verdict: ${result.verdict}`);
  process.exit(0);
}

module.exports = { evaluateRuns };
