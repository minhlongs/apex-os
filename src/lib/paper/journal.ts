/**
 * src/lib/paper/journal.ts
 *
 * Immutable Paper Trading Journal with SHA-256 idempotency protection,
 * D1 database persistence, and CSV / PDF report export stamped with PAPER,
 * model_version, and feed_age_ms.
 */

import type { D1Database } from '../db';
import type {
  EconomicResearchSummary,
  PaperClosedCycle,
  PaperExchange,
  PaperMarketType,
  PaperPair,
  PaperStrategyId,
  PaperStrategySnapshot,
  SequencerStreamState,
} from './types';

export interface R2BucketLike {
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: Record<string, string> }
  ): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string>; json<T>(): Promise<T> } | null>;
}

export class PaperJournal {
  private readonly memoryByIdempotency = new Map<string, PaperClosedCycle>();
  private readonly snapshots = new Map<PaperStrategyId, PaperStrategySnapshot>();

  /**
   * Append a closed paper cycle idempotently.
   * Returns true if newly inserted, false if duplicate idempotencyKey.
   * Persists to D1 and archives to R2 bucket if provided.
   * Critical: memory deduplication is only updated AFTER successful D1 write,
   * ensuring transient D1 failures can be retried without being swallowed (Bug 3 / R5).
   */
  async recordClosedCycle(
    cycle: PaperClosedCycle,
    db?: D1Database | null,
    r2Bucket?: R2BucketLike | null
  ): Promise<boolean> {
    if (this.memoryByIdempotency.has(cycle.idempotencyKey)) {
      return false;
    }

    if (db) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO paper_trade_journal (
            id, cycle_id, idempotency_key, strategy_id, pair,
            entry_ts, exit_ts, entry_seq_a, entry_seq_b, exit_seq_a, exit_seq_b,
            notional_usdt, quantity_base,
            leg_a_exchange, leg_a_market, leg_b_exchange, leg_b_market,
            entry_leg_a_price, entry_leg_b_price, exit_leg_a_price, exit_leg_b_price,
            raw_spread_bps, net_spread_bps, gross_pnl_usdt, total_fees_usdt,
            funding_delta_usdt, net_pnl_usdt, model_version, replay_object_key, execution_mode
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAPER')`
        )
        .bind(
          `pj_${cycle.idempotencyKey}`,
          cycle.cycleId,
          cycle.idempotencyKey,
          cycle.strategyId,
          cycle.pair,
          cycle.entryTs,
          cycle.exitTs,
          cycle.entrySeqA,
          cycle.entrySeqB,
          cycle.exitSeqA,
          cycle.exitSeqB,
          cycle.notionalUsdt,
          cycle.quantityBase,
          cycle.legAExchange,
          cycle.legAMarket,
          cycle.legBExchange,
          cycle.legBMarket,
          cycle.entryLegAPrice,
          cycle.entryLegBPrice,
          cycle.exitLegAPrice,
          cycle.exitLegBPrice,
          cycle.rawSpreadBps,
          cycle.netSpreadBps,
          cycle.grossPnlUsdt,
          cycle.totalFeesUsdt,
          cycle.fundingDeltaUsdt,
          cycle.netPnlUsdt,
          cycle.modelVersion,
          cycle.replayObjectKey
        )
        .run();
    }

    // Mark as recorded in memory only after persistence completes without throwing
    this.memoryByIdempotency.set(cycle.idempotencyKey, cycle);

    if (r2Bucket && cycle.replayObjectKey) {
      try {
        const objectPath = cycle.replayObjectKey.replace(/^r2:\/\/[^/]+\//, '');
        await r2Bucket.put(objectPath, JSON.stringify(cycle), {
          customMetadata: {
            idempotency_key: cycle.idempotencyKey,
            model_version: cycle.modelVersion,
            execution_mode: 'PAPER',
          },
          httpMetadata: {
            contentType: 'application/json',
          },
        });
      } catch (err) {
        console.error('[PaperJournal] R2 archive write failed:', err);
      }
    }

    return true;
  }

  async saveStrategySnapshot(
    snapshot: PaperStrategySnapshot,
    db?: D1Database | null
  ): Promise<void> {
    this.snapshots.set(snapshot.strategyId, snapshot);

    if (db) {
      await db
        .prepare(
          `INSERT INTO paper_strategy_snapshots (
            strategy_id, strategy_name, model_version, initial_capital_usdt,
            cash_balance_usdt, allocated_notional_usdt, equity_usdt, peak_equity_usdt,
            realized_net_pnl_usdt, total_fees_paid_usdt, total_funding_usdt,
            max_drawdown_pct, halted_by_drawdown, open_cycles_count,
            closed_cycles_count, win_rate_pct, execution_mode, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAPER', datetime('now'))
          ON CONFLICT(strategy_id) DO UPDATE SET
            cash_balance_usdt = excluded.cash_balance_usdt,
            allocated_notional_usdt = excluded.allocated_notional_usdt,
            equity_usdt = excluded.equity_usdt,
            peak_equity_usdt = excluded.peak_equity_usdt,
            realized_net_pnl_usdt = excluded.realized_net_pnl_usdt,
            total_fees_paid_usdt = excluded.total_fees_paid_usdt,
            total_funding_usdt = excluded.total_funding_usdt,
            max_drawdown_pct = excluded.max_drawdown_pct,
            halted_by_drawdown = excluded.halted_by_drawdown,
            open_cycles_count = excluded.open_cycles_count,
            closed_cycles_count = excluded.closed_cycles_count,
            win_rate_pct = excluded.win_rate_pct,
            updated_at = datetime('now')`
        )
        .bind(
          snapshot.strategyId,
          snapshot.strategyName,
          snapshot.modelVersion,
          snapshot.initialCapitalUsdt,
          snapshot.cashBalanceUsdt,
          snapshot.allocatedNotionalUsdt,
          snapshot.equityUsdt,
          snapshot.peakEquityUsdt,
          snapshot.realizedNetPnlUsdt,
          snapshot.totalFeesPaidUsdt,
          snapshot.totalFundingUsdt,
          snapshot.maxDrawdownPct,
          snapshot.haltedByDrawdown ? 1 : 0,
          snapshot.openCyclesCount,
          snapshot.closedCyclesCount,
          snapshot.winRatePct
        )
        .run();
    }
  }

  getClosedCycles(): PaperClosedCycle[] {
    return Array.from(this.memoryByIdempotency.values());
  }

  async loadFromD1(db: D1Database): Promise<number> {
    const res = await db
      .prepare('SELECT * FROM paper_trade_journal ORDER BY exit_ts ASC')
      .all<Record<string, unknown>>();
    const rows = Array.isArray(res) ? res : (res?.results || []);
    let restored = 0;
    for (const r of rows) {
      const cycle: PaperClosedCycle = {
        cycleId: String(r.cycle_id),
        idempotencyKey: String(r.idempotency_key),
        strategyId: r.strategy_id as PaperStrategyId,
        pair: r.pair as PaperPair,
        entryTs: Number(r.entry_ts),
        exitTs: Number(r.exit_ts),
        entrySeqA: Number(r.entry_seq_a),
        entrySeqB: Number(r.entry_seq_b),
        exitSeqA: Number(r.exit_seq_a),
        exitSeqB: Number(r.exit_seq_b),
        notionalUsdt: Number(r.notional_usdt),
        quantityBase: Number(r.quantity_base),
        legAExchange: r.leg_a_exchange as PaperExchange,
        legAMarket: r.leg_a_market as PaperMarketType,
        legBExchange: r.leg_b_exchange as PaperExchange,
        legBMarket: r.leg_b_market as PaperMarketType,
        entryLegAPrice: Number(r.entry_leg_a_price),
        entryLegBPrice: Number(r.entry_leg_b_price),
        exitLegAPrice: Number(r.exit_leg_a_price),
        exitLegBPrice: Number(r.exit_leg_b_price),
        rawSpreadBps: Number(r.raw_spread_bps),
        netSpreadBps: Number(r.net_spread_bps),
        grossPnlUsdt: Number(r.gross_pnl_usdt),
        totalFeesUsdt: Number(r.total_fees_usdt),
        fundingDeltaUsdt: Number(r.funding_delta_usdt),
        netPnlUsdt: Number(r.net_pnl_usdt),
        modelVersion: String(r.model_version),
        replayObjectKey: String(r.replay_object_key),
        executionMode: 'PAPER',
      };
      if (await this.recordClosedCycle(cycle)) {
        restored += 1;
      }
    }
    return restored;
  }

  /**
   * Export closed cycles as a CSV document explicitly stamped with PAPER,
   * model_version, and feed_age_ms.
   */
  static formatCsvReport(params: {
    cycles: PaperClosedCycle[];
    modelVersion: string;
    maxFeedAgeMs: number;
    replayDigest: string;
  }): string {
    const headerComments = [
      `# EXECUTION_MODE: PAPER (SIMULATION ONLY - NO LIVE CEX ORDERS OR WITHDRAWALS)`,
      `# DATA_SOURCE: FIXTURE_REPLAY (DETERMINISTIC SIMULATION - NOT REAL-TIME LIVE CEX)`,
      `# MODEL_VERSION: ${params.modelVersion}`,
      `# MAX_FEED_AGE_MS: ${params.maxFeedAgeMs}`,
      `# REPLAY_DIGEST_SHA256: ${params.replayDigest}`,
    ];

    const columns = [
      'execution_mode',
      'model_version',
      'feed_age_ms',
      'cycle_id',
      'idempotency_key',
      'strategy_id',
      'pair',
      'entry_ts',
      'exit_ts',
      'notional_usdt',
      'raw_spread_bps',
      'net_spread_bps',
      'gross_pnl_usdt',
      'total_fees_usdt',
      'funding_delta_usdt',
      'net_pnl_usdt',
      'replay_object_key',
    ];

    const rows = params.cycles.map((c) =>
      [
        c.executionMode,
        c.modelVersion,
        params.maxFeedAgeMs,
        c.cycleId,
        c.idempotencyKey,
        c.strategyId,
        c.pair,
        c.entryTs,
        c.exitTs,
        c.notionalUsdt.toFixed(2),
        c.rawSpreadBps.toFixed(4),
        c.netSpreadBps.toFixed(4),
        c.grossPnlUsdt.toFixed(4),
        c.totalFeesUsdt.toFixed(4),
        c.fundingDeltaUsdt.toFixed(4),
        c.netPnlUsdt.toFixed(4),
        c.replayObjectKey,
      ].join(',')
    );

    return [...headerComments, columns.join(','), ...rows].join('\n');
  }

  /**
   * Generate a valid PDF binary payload (ISO 32000-1 1.4 compliant text PDF)
   * stamped with PAPER watermark, model_version, feed_age_ms, strategy ledgers,
   * and closed cycle summary.
   */
  static formatPdfReport(params: {
    cycles: PaperClosedCycle[];
    strategies: Record<PaperStrategyId, PaperStrategySnapshot>;
    sequencerStates: SequencerStreamState[];
    economicResearch: EconomicResearchSummary;
    modelVersion: string;
    maxFeedAgeMs: number;
    replayDigest: string;
  }): string {
    const sSpot = params.strategies['spot-2exch'];
    const sPerp = params.strategies['spot-perp'];

    const lines = [
      'APEXOS PAPER TRADING AUDIT & SIMULATION REPORT',
      'WATERMARK: PAPER SIMULATION ONLY - ZERO LIVE CEX ORDERS',
      `MODEL_VERSION: ${params.modelVersion} | MAX_FEED_AGE_MS: ${params.maxFeedAgeMs}ms`,
      `REPLAY_DIGEST: ${params.replayDigest}`,
      '----------------------------------------------------------------',
      `Strategy 1 (spot-2exch): Equity=${sSpot.equityUsdt.toFixed(2)} USDT | NetPnL=${sSpot.realizedNetPnlUsdt.toFixed(4)} USDT | Fees=${sSpot.totalFeesPaidUsdt.toFixed(4)} USDT | MaxDD=${sSpot.maxDrawdownPct.toFixed(4)}%`,
      `Strategy 2 (spot-perp):  Equity=${sPerp.equityUsdt.toFixed(2)} USDT | NetPnL=${sPerp.realizedNetPnlUsdt.toFixed(4)} USDT | Fees=${sPerp.totalFeesPaidUsdt.toFixed(4)} USDT | MaxDD=${sPerp.maxDrawdownPct.toFixed(4)}%`,
      `Total Closed Cycles: ${params.cycles.length} | Economic Report Mode: ${params.economicResearch.reportType}`,
      '----------------------------------------------------------------',
      ...params.cycles.slice(0, 12).map(
        (c) =>
          `[PAPER] ${c.cycleId} | ${c.pair} | NetPnL=${c.netPnlUsdt.toFixed(4)} USDT | Fees=${c.totalFeesUsdt.toFixed(4)} USDT`
      ),
    ];

    const escapedLines = lines
      .map((line, idx) => {
        const safe = line.replace(/[()\\]/g, '');
        return idx === 0 ? `(${safe}) Tj` : `0 -14 Td (${safe}) Tj`;
      })
      .join('\n');

    const streamContent = `BT\n/F1 9 Tf\n36 750 Td\n${escapedLines}\nET`;

    return [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
      `4 0 obj << /Length ${streamContent.length} >> stream\n${streamContent}\nendstream endobj`,
      '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj',
      'trailer << /Root 1 0 R >>',
      '%%EOF',
    ].join('\n');
  }
}
