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
 *   - single active run per strategy (no duplicate active rows)
 *   - model_version === expectedModelVersion ('paper-v1.1.0')
 *   - config_hash === expectedConfigHash (canonical frozen SHA-256) and identical across strategies
 *   - recent last_heartbeat_at within maxHeartbeatAgeMs (default 15 minutes)
 *   - both strategies share the same active run window timestamp
 *
 * Usage:
 *   node scripts/verify-paper-economic-gate.cjs [--runs-json <path_or_json>]
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

const REQUIRED_STRATEGIES = ['spot-2exch', 'spot-perp'];
const TARGET_DAYS = 30;
const TARGET_CYCLES = 100;
const MAX_DRAWDOWN_PCT = 2.0;
const EXPECTED_MODEL_VERSION = 'paper-v1.1.0';
const MAX_HEARTBEAT_AGE_MS = 15 * 60 * 1000;

const CANONICAL_PAPER_CONFIG = Object.freeze({
  modelVersion: EXPECTED_MODEL_VERSION,
  initialCapitalUsdt: 10000,
  maxCycleNotionalUsdt: 500,
  maxOpenCycles: 4,
  singleLegTakerFeeRate: 0.0005,
  minEntryNetSpreadBps: 2.0,
  exitConvergenceSpreadBps: 3.0,
  maxDrawdownLimitPct: 2.0,
});

const EXPECTED_CONFIG_HASH = crypto
  .createHash('sha256')
  .update(JSON.stringify(CANONICAL_PAPER_CONFIG))
  .digest('hex');

function extractRunWindowId(runId, strategyId) {
  if (typeof runId !== 'string') return '';
  const prefix = `run_${strategyId}_`;
  return runId.startsWith(prefix) ? runId.slice(prefix.length) : runId;
}

function evaluateRuns(runs, options = {}) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return {
      passed: false,
      verdict: 'NO_GO',
      reason:
        'No active paper_trading_runs records found. 30-day real-market paper window has not completed.',
      details: [],
    };
  }

  const expectedModelVersion =
    options.expectedModelVersion ||
    process.env.EXPECTED_PAPER_MODEL_VERSION ||
    EXPECTED_MODEL_VERSION;
  const expectedConfigHash =
    options.expectedConfigHash ||
    process.env.EXPECTED_PAPER_CONFIG_HASH ||
    EXPECTED_CONFIG_HASH;
  const nowMs =
    typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  const maxHeartbeatAgeMs =
    typeof options.maxHeartbeatAgeMs === 'number' && Number.isFinite(options.maxHeartbeatAgeMs)
      ? options.maxHeartbeatAgeMs
      : MAX_HEARTBEAT_AGE_MS;

  const details = [];
  let allPassed = true;
  const activeRunsByStrategy = new Map();

  for (const strategyId of REQUIRED_STRATEGIES) {
    const activeMatching = runs.filter(
      (r) => r && r.strategy_id === strategyId && Number(r.is_active) === 1
    );

    if (activeMatching.length === 0) {
      allPassed = false;
      details.push({
        strategyId,
        passed: false,
        reason: `Missing active paper_trading_runs record for strategy '${strategyId}'`,
      });
      continue;
    }

    if (activeMatching.length > 1) {
      allPassed = false;
      details.push({
        strategyId,
        passed: false,
        reason: `Multiple active paper_trading_runs records (${activeMatching.length}) found for strategy '${strategyId}'`,
      });
      continue;
    }

    const run = activeMatching[0];
    activeRunsByStrategy.set(strategyId, run);

    const days = Number(run.verified_real_market_days ?? 0);
    const cycles = Number(run.closed_cycles_count ?? 0);
    const netPnl = Number(run.realized_net_pnl_usdt ?? 0);
    const maxDd = Number(run.max_drawdown_pct ?? 999);
    const verdict = String(run.verdict ?? 'NO_GO');
    const configHash = String(run.config_hash ?? '');
    const modelVersion = String(run.model_version ?? '');
    const heartbeatRaw = run.last_heartbeat_at ? String(run.last_heartbeat_at) : '';
    const normalizedHb =
      heartbeatRaw && !heartbeatRaw.endsWith('Z') && !heartbeatRaw.includes('+')
        ? `${heartbeatRaw.replace(' ', 'T')}Z`
        : heartbeatRaw;
    const heartbeatTs = normalizedHb ? Date.parse(normalizedHb) : NaN;
    const heartbeatAgeMs = Number.isFinite(heartbeatTs) ? nowMs - heartbeatTs : Infinity;

    // Physical Duration & Impossibility Verification (Finding C5):
    // A run cannot claim 30 days of real-market coverage if the run started today.
    // Validate that the physical elapsed time since run start (and window start timestamp)
    // is >= claimed days (and >= TARGET_DAYS of 30 days = 30 * 86,400,000 ms).
    const windowStartStr = extractRunWindowId(run.run_id, strategyId);
    const windowStartMs = Number(windowStartStr);
    const hasValidWindowTs = Number.isFinite(windowStartMs) && windowStartMs > 0 && windowStartMs <= nowMs;
    const elapsedWindowDays = hasValidWindowTs ? (nowMs - windowStartMs) / (24 * 3600 * 1000) : 0;

    let elapsedStartedAtDays = Infinity;
    if (run.started_at) {
      const startedAtRaw = String(run.started_at);
      const normalizedStartedAt =
        startedAtRaw && !startedAtRaw.endsWith('Z') && !startedAtRaw.includes('+')
          ? `${startedAtRaw.replace(' ', 'T')}Z`
          : startedAtRaw;
      const startedAtTs = Date.parse(normalizedStartedAt);
      if (Number.isFinite(startedAtTs)) {
        elapsedStartedAtDays = (nowMs - startedAtTs) / (24 * 3600 * 1000);
      }
    }

    const durationIsPhysicallyPossible =
      hasValidWindowTs &&
      elapsedWindowDays >= TARGET_DAYS &&
      days <= elapsedWindowDays + 1e-4 &&
      elapsedStartedAtDays >= TARGET_DAYS &&
      days <= elapsedStartedAtDays + 1e-4;

    const daysOk = Number.isFinite(days) && days >= TARGET_DAYS && durationIsPhysicallyPossible;
    const cyclesOk = Number.isFinite(cycles) && cycles >= TARGET_CYCLES;
    const pnlOk = Number.isFinite(netPnl) && netPnl > 0;
    const ddOk = Number.isFinite(maxDd) && maxDd >= 0 && maxDd <= MAX_DRAWDOWN_PCT;
    const hashOk = configHash === expectedConfigHash;
    const modelOk = modelVersion === expectedModelVersion;
    const heartbeatOk =
      Number.isFinite(heartbeatTs) &&
      heartbeatAgeMs >= -60000 &&
      heartbeatAgeMs <= maxHeartbeatAgeMs;
    const verdictOk = verdict === 'GO';

    const strategyPassed =
      daysOk &&
      cyclesOk &&
      pnlOk &&
      ddOk &&
      hashOk &&
      modelOk &&
      heartbeatOk &&
      verdictOk;

    if (!strategyPassed) {
      allPassed = false;
    }

    details.push({
      strategyId,
      passed: strategyPassed,
      runId: run.run_id,
      modelVersion,
      expectedModelVersion,
      verifiedRealMarketDays: days,
      elapsedWindowDays: Number(elapsedWindowDays.toFixed(6)),
      durationIsPhysicallyPossible,
      closedCyclesCount: cycles,
      realizedNetPnlUsdt: netPnl,
      maxDrawdownPct: maxDd,
      configHash,
      expectedConfigHash,
      lastHeartbeatAt: heartbeatRaw || null,
      heartbeatAgeMs: Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : null,
      verdict,
      checks: {
        daysOk,
        durationIsPhysicallyPossible,
        cyclesOk,
        pnlOk,
        ddOk,
        hashOk,
        modelOk,
        heartbeatOk,
        verdictOk,
      },
    });
  }

  // Cross-strategy provenance check: both strategies must share the same config_hash
  // and both run_id windows must be valid timestamps that each satisfy >= 30 days of
  // physical elapsed wall-clock time, proving neither strategy shortcut the acceptance timer.
  if (activeRunsByStrategy.size === REQUIRED_STRATEGIES.length) {
    const runA = activeRunsByStrategy.get('spot-2exch');
    const runB = activeRunsByStrategy.get('spot-perp');
    const sameConfigHash = String(runA.config_hash ?? '') === String(runB.config_hash ?? '');
    const windowA = Number(extractRunWindowId(runA.run_id, 'spot-2exch'));
    const windowB = Number(extractRunWindowId(runB.run_id, 'spot-perp'));
    const windowAValid =
      Number.isFinite(windowA) && windowA > 0 && windowA <= nowMs && nowMs - windowA >= TARGET_DAYS * 86_400_000;
    const windowBValid =
      Number.isFinite(windowB) && windowB > 0 && windowB <= nowMs && nowMs - windowB >= TARGET_DAYS * 86_400_000;
    const sameWindow = windowA === windowB;

    if (!sameConfigHash || !windowAValid || !windowBValid || !sameWindow) {
      allPassed = false;
      for (const d of details) {
        d.passed = false;
        d.checks = {
          ...d.checks,
          sameConfigHash,
          windowAValid,
          windowBValid,
          sameWindow,
        };
      }
    }
  }

  return {
    passed: allPassed,
    verdict: allPassed ? 'GO' : 'NO_GO',
    expectedModelVersion,
    expectedConfigHash,
    reason: allPassed
      ? 'Both strategies passed all 30-day real-market economic gate and provenance criteria.'
      : 'One or more strategies failed the mandatory 30-day / 100-cycle / >0 PnL / <=2% DD / configHash / modelVersion / heartbeat freshness / window provenance gate.',
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
    console.error(
      `[BLOCKED] Production Go-Live Economic Verdict: ${result.verdict} — ${result.reason}`
    );
    process.exit(1);
  }

  console.log(`[APPROVED] Production Go-Live Economic Verdict: ${result.verdict}`);
  process.exit(0);
}

module.exports = {
  evaluateRuns,
  CANONICAL_PAPER_CONFIG,
  EXPECTED_CONFIG_HASH,
  EXPECTED_MODEL_VERSION,
};
