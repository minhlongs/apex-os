/**
 * src/lib/paper/strategy-engine.ts
 *
 * Independent 10,000 USDT Paper Trading Strategy Engine supporting:
 *   1. 'spot-2exch': Cross-exchange spot arbitrage (Binance Spot vs Bybit Spot)
 *   2. 'spot-perp':  Delta-neutral 1x Long Spot / Short Linear Perp basis & funding
 *
 * Enforces realistic taker fees, L2 book-depth VWAP fills, sequence sync checks,
 * and automatic halt at 2.0% drawdown.
 */

import { createHash } from 'crypto';
import { OrderbookSequencer } from './orderbook-sequencer';
import type {
  PaperClosedCycle,
  PaperDecisionLog,
  PaperOpenCycle,
  PaperPair,
  PaperStrategyId,
  PaperStrategySnapshot,
} from './types';

export interface StrategyEngineConfig {
  strategyId: PaperStrategyId;
  modelVersion?: string;
  initialCapitalUsdt?: number;
  maxCycleNotionalUsdt?: number;
  maxOpenCycles?: number;
  singleLegTakerFeeRate?: number;
  minEntryNetSpreadBps?: number;
  exitConvergenceSpreadBps?: number;
  maxDrawdownLimitPct?: number;
}

const round4 = (n: number): number => Number(n.toFixed(4));
const round6 = (n: number): number => Number(n.toFixed(6));
const round8 = (n: number): number => Number(n.toFixed(8));

export class PaperStrategyEngine {
  readonly strategyId: PaperStrategyId;
  readonly strategyName: string;
  readonly modelVersion: string;
  readonly initialCapitalUsdt: number;
  readonly maxCycleNotionalUsdt: number;
  readonly maxOpenCycles: number;
  readonly singleLegTakerFeeRate: number;
  readonly minEntryNetSpreadBps: number;
  readonly exitConvergenceSpreadBps: number;
  readonly maxDrawdownLimitPct: number;

  private cashBalanceUsdt: number;
  private peakEquityUsdt: number;
  private maxDrawdownPct = 0;
  private haltedByDrawdown = false;
  private realizedNetPnlUsdt = 0;
  private totalFeesPaidUsdt = 0;
  private totalFundingUsdt = 0;
  private noTradeCount = 0;
  private desyncHaltCount = 0;

  private readonly openCycles = new Map<string, PaperOpenCycle>();
  private readonly closedCycles: PaperClosedCycle[] = [];
  private readonly decisions: PaperDecisionLog[] = [];

  constructor(config: StrategyEngineConfig) {
    this.strategyId = config.strategyId;
    this.strategyName =
      config.strategyId === 'spot-2exch'
        ? 'Cross-Exchange Spot (Binance vs Bybit)'
        : 'Spot-Perp Delta-Neutral Basis (1x USDT)';
    this.modelVersion = config.modelVersion ?? 'paper-v1.0.0';
    this.initialCapitalUsdt = config.initialCapitalUsdt ?? 10000;
    this.maxCycleNotionalUsdt = config.maxCycleNotionalUsdt ?? 500;
    this.maxOpenCycles = config.maxOpenCycles ?? 4;
    // 5 bps per leg * 4 legs (2 entry + 2 exit) = 20 bps (0.20% round-trip fee)
    this.singleLegTakerFeeRate = config.singleLegTakerFeeRate ?? 0.0005;
    this.minEntryNetSpreadBps = config.minEntryNetSpreadBps ?? 2.0;
    this.exitConvergenceSpreadBps = config.exitConvergenceSpreadBps ?? 3.0;
    this.maxDrawdownLimitPct = config.maxDrawdownLimitPct ?? 2.0;

    this.cashBalanceUsdt = this.initialCapitalUsdt;
    this.peakEquityUsdt = this.initialCapitalUsdt;
  }

  static computeIdempotencyKey(parts: Array<string | number>): string {
    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  }

  /**
   * Evaluate a single pair on the current sequencer state.
   */
  evaluatePair(
    sequencer: OrderbookSequencer,
    pair: PaperPair,
    tickIndex: number,
    nowTs: number,
    replayBatchId = 'live-buffer'
  ): PaperDecisionLog {
    if (this.haltedByDrawdown) {
      const log: PaperDecisionLog = {
        tickIndex,
        timestamp: nowTs,
        strategyId: this.strategyId,
        pair,
        decision: 'HALTED_DRAWDOWN',
        rawSpreadBps: 0,
        estimatedNetSpreadBps: 0,
        reason: `Strategy halted: max drawdown ${this.maxDrawdownPct}% exceeded ${this.maxDrawdownLimitPct}% limit`,
      };
      this.decisions.push(log);
      return log;
    }

    if (this.strategyId === 'spot-2exch') {
      return this.evaluateSpotTwoExch(sequencer, pair, tickIndex, nowTs, replayBatchId);
    }
    return this.evaluateSpotPerp(sequencer, pair, tickIndex, nowTs, replayBatchId);
  }

  private evaluateSpotTwoExch(
    sequencer: OrderbookSequencer,
    pair: PaperPair,
    tickIndex: number,
    nowTs: number,
    replayBatchId: string
  ): PaperDecisionLog {
    const keyBinance = OrderbookSequencer.makeStreamKey('binance', pair, 'spot');
    const keyBybit = OrderbookSequencer.makeStreamKey('bybit', pair, 'spot');
    const syncCheck = sequencer.validatePairSync(keyBinance, keyBybit, nowTs);

    if (!syncCheck.ok) {
      this.desyncHaltCount += 1;
      const log: PaperDecisionLog = {
        tickIndex,
        timestamp: nowTs,
        strategyId: this.strategyId,
        pair,
        decision: 'HALTED_DESYNC',
        rawSpreadBps: 0,
        estimatedNetSpreadBps: 0,
        reason: syncCheck.reason ?? `Feed sync check failed (${syncCheck.status})`,
      };
      this.decisions.push(log);
      return log;
    }

    const binanceBook = sequencer.getBook('binance', pair, 'spot')!;
    const bybitBook = sequencer.getBook('bybit', pair, 'spot')!;

    // Check if an open cycle exists for this pair and whether it should close
    const existingOpen = this.openCycles.get(pair);
    if (existingOpen) {
      const buyExitBook =
        existingOpen.legBExchange === 'bybit' ? bybitBook : binanceBook;
      const sellExitBook =
        existingOpen.legAExchange === 'binance' ? binanceBook : bybitBook;

      const exitSellFill = OrderbookSequencer.computeVwapFill(
        sellExitBook,
        'sell',
        existingOpen.notionalUsdt
      );
      const exitBuyFill = OrderbookSequencer.computeVwapFill(
        buyExitBook,
        'buy',
        existingOpen.notionalUsdt
      );

      if (exitSellFill.filled && exitBuyFill.filled) {
        const currentDiffBps =
          ((exitSellFill.vwapPrice - exitBuyFill.vwapPrice) / exitBuyFill.vwapPrice) *
          10000;

        // Close when spread converges or mean-reverts so we lock in the reversion
        if (currentDiffBps >= -this.exitConvergenceSpreadBps) {
          const closed = this.closeOpenCycle(
            existingOpen,
            exitSellFill.vwapPrice,
            exitBuyFill.vwapPrice,
            sellExitBook.sequenceId,
            buyExitBook.sequenceId,
            nowTs,
            0,
            replayBatchId
          );
          const log: PaperDecisionLog = {
            tickIndex,
            timestamp: nowTs,
            strategyId: this.strategyId,
            pair,
            decision: 'CLOSE_CYCLE',
            rawSpreadBps: closed.rawSpreadBps,
            estimatedNetSpreadBps: closed.netSpreadBps,
            reason: `Closed cycle ${closed.cycleId} with net P&L ${closed.netPnlUsdt} USDT`,
          };
          this.decisions.push(log);
          return log;
        }
      }

      const holdLog: PaperDecisionLog = {
        tickIndex,
        timestamp: nowTs,
        strategyId: this.strategyId,
        pair,
        decision: 'HOLD',
        rawSpreadBps: existingOpen.entrySpreadBps,
        estimatedNetSpreadBps: existingOpen.entrySpreadBps - this.roundTripFeeBps(),
        reason: `Holding open cycle ${existingOpen.cycleId}`,
      };
      this.decisions.push(holdLog);
      return holdLog;
    }

    // Evaluate entry in both directions:
    // Direction 1: Buy Binance Ask, Sell Bybit Bid
    const fillBuyBin = OrderbookSequencer.computeVwapFill(
      binanceBook,
      'buy',
      this.maxCycleNotionalUsdt
    );
    const fillSellByb = OrderbookSequencer.computeVwapFill(
      bybitBook,
      'sell',
      this.maxCycleNotionalUsdt
    );

    // Direction 2: Buy Bybit Ask, Sell Binance Bid
    const fillBuyByb = OrderbookSequencer.computeVwapFill(
      bybitBook,
      'buy',
      this.maxCycleNotionalUsdt
    );
    const fillSellBin = OrderbookSequencer.computeVwapFill(
      binanceBook,
      'sell',
      this.maxCycleNotionalUsdt
    );

    const spreadDir1Bps =
      fillBuyBin.filled && fillSellByb.filled
        ? ((fillSellByb.vwapPrice - fillBuyBin.vwapPrice) / fillBuyBin.vwapPrice) * 10000
        : -9999;
    const spreadDir2Bps =
      fillBuyByb.filled && fillSellBin.filled
        ? ((fillSellBin.vwapPrice - fillBuyByb.vwapPrice) / fillBuyByb.vwapPrice) * 10000
        : -9999;

    const useDir1 = spreadDir1Bps >= spreadDir2Bps;
    const rawSpreadBps = round4(useDir1 ? spreadDir1Bps : spreadDir2Bps);
    const netSpreadBps = round4(rawSpreadBps - this.roundTripFeeBps());

    if (
      netSpreadBps < this.minEntryNetSpreadBps ||
      this.openCycles.size >= this.maxOpenCycles ||
      this.cashBalanceUsdt < this.maxCycleNotionalUsdt
    ) {
      this.noTradeCount += 1;
      const noTradeLog: PaperDecisionLog = {
        tickIndex,
        timestamp: nowTs,
        strategyId: this.strategyId,
        pair,
        decision: 'NO_TRADE',
        rawSpreadBps,
        estimatedNetSpreadBps: netSpreadBps,
        reason:
          netSpreadBps < this.minEntryNetSpreadBps
            ? `Net spread ${netSpreadBps} bps below threshold ${this.minEntryNetSpreadBps} bps after ${this.roundTripFeeBps()} bps fees`
            : 'Max open cycles or capital limit reached',
      };
      this.decisions.push(noTradeLog);
      return noTradeLog;
    }

    const buyExchange = useDir1 ? 'binance' : 'bybit';
    const sellExchange = useDir1 ? 'bybit' : 'binance';
    const entryBuyPrice = useDir1 ? fillBuyBin.vwapPrice : fillBuyByb.vwapPrice;
    const entrySellPrice = useDir1 ? fillSellByb.vwapPrice : fillSellBin.vwapPrice;
    const seqA = useDir1 ? binanceBook.sequenceId : bybitBook.sequenceId;
    const seqB = useDir1 ? bybitBook.sequenceId : binanceBook.sequenceId;

    const cycle = this.openNewCycle({
      pair,
      nowTs,
      seqA,
      seqB,
      legAExchange: buyExchange,
      legAMarket: 'spot',
      legBExchange: sellExchange,
      legBMarket: 'spot',
      entryLegAPrice: entryBuyPrice,
      entryLegBPrice: entrySellPrice,
      rawSpreadBps,
    });

    const openLog: PaperDecisionLog = {
      tickIndex,
      timestamp: nowTs,
      strategyId: this.strategyId,
      pair,
      decision: 'OPEN_CYCLE',
      rawSpreadBps,
      estimatedNetSpreadBps: netSpreadBps,
      reason: `Opened cycle ${cycle.cycleId} (${buyExchange} -> ${sellExchange}) at ${rawSpreadBps} bps raw / ${netSpreadBps} bps net`,
    };
    this.decisions.push(openLog);
    return openLog;
  }

  private evaluateSpotPerp(
    sequencer: OrderbookSequencer,
    pair: PaperPair,
    tickIndex: number,
    nowTs: number,
    replayBatchId: string
  ): PaperDecisionLog {
    const keySpot = OrderbookSequencer.makeStreamKey('binance', pair, 'spot');
    const keyPerp = OrderbookSequencer.makeStreamKey('binance', pair, 'linear_perp');
    const syncCheck = sequencer.validatePairSync(keySpot, keyPerp, nowTs);

    if (!syncCheck.ok) {
      this.desyncHaltCount += 1;
      const log: PaperDecisionLog = {
        tickIndex,
        timestamp: nowTs,
        strategyId: this.strategyId,
        pair,
        decision: 'HALTED_DESYNC',
        rawSpreadBps: 0,
        estimatedNetSpreadBps: 0,
        reason: syncCheck.reason ?? `Feed sync check failed (${syncCheck.status})`,
      };
      this.decisions.push(log);
      return log;
    }

    const spotBook = sequencer.getBook('binance', pair, 'spot')!;
    const perpBook = sequencer.getBook('binance', pair, 'linear_perp')!;
    const fundingBps = perpBook.fundingRateBps ?? 1.0;

    const existingOpen = this.openCycles.get(pair);
    if (existingOpen) {
      // Accrue funding interval credit on short perp when fundingRateBps > 0
      const fundingStepUsdt = round4(
        existingOpen.notionalUsdt * (fundingBps / 10000) * 0.25
      );
      existingOpen.accruedFundingUsdt = round4(
        existingOpen.accruedFundingUsdt + fundingStepUsdt
      );

      const exitSpotSell = OrderbookSequencer.computeVwapFill(
        spotBook,
        'sell',
        existingOpen.notionalUsdt
      );
      const exitPerpBuy = OrderbookSequencer.computeVwapFill(
        perpBook,
        'buy',
        existingOpen.notionalUsdt
      );

      if (exitSpotSell.filled && exitPerpBuy.filled) {
        const exitBasisBps =
          ((exitPerpBuy.vwapPrice - exitSpotSell.vwapPrice) / exitSpotSell.vwapPrice) *
          10000;

        // Close when perp premium converges back toward spot
        if (exitBasisBps <= this.exitConvergenceSpreadBps) {
          const closed = this.closeOpenCycle(
            existingOpen,
            exitSpotSell.vwapPrice,
            exitPerpBuy.vwapPrice,
            spotBook.sequenceId,
            perpBook.sequenceId,
            nowTs,
            existingOpen.accruedFundingUsdt,
            replayBatchId
          );
          const log: PaperDecisionLog = {
            tickIndex,
            timestamp: nowTs,
            strategyId: this.strategyId,
            pair,
            decision: 'CLOSE_CYCLE',
            rawSpreadBps: closed.rawSpreadBps,
            estimatedNetSpreadBps: closed.netSpreadBps,
            reason: `Closed spot-perp cycle ${closed.cycleId} with net P&L ${closed.netPnlUsdt} USDT (funding ${closed.fundingDeltaUsdt} USDT)`,
          };
          this.decisions.push(log);
          return log;
        }
      }

      const holdLog: PaperDecisionLog = {
        tickIndex,
        timestamp: nowTs,
        strategyId: this.strategyId,
        pair,
        decision: 'HOLD',
        rawSpreadBps: existingOpen.entrySpreadBps,
        estimatedNetSpreadBps: existingOpen.entrySpreadBps - this.roundTripFeeBps(),
        reason: `Holding spot-perp cycle ${existingOpen.cycleId}`,
      };
      this.decisions.push(holdLog);
      return holdLog;
    }

    const buySpot = OrderbookSequencer.computeVwapFill(
      spotBook,
      'buy',
      this.maxCycleNotionalUsdt
    );
    const sellPerp = OrderbookSequencer.computeVwapFill(
      perpBook,
      'sell',
      this.maxCycleNotionalUsdt
    );

    const basisBps =
      buySpot.filled && sellPerp.filled
        ? ((sellPerp.vwapPrice - buySpot.vwapPrice) / buySpot.vwapPrice) * 10000
        : -9999;
    const rawSpreadBps = round4(basisBps + fundingBps);
    const netSpreadBps = round4(rawSpreadBps - this.roundTripFeeBps());

    if (
      netSpreadBps < this.minEntryNetSpreadBps ||
      this.openCycles.size >= this.maxOpenCycles ||
      this.cashBalanceUsdt < this.maxCycleNotionalUsdt
    ) {
      this.noTradeCount += 1;
      const noTradeLog: PaperDecisionLog = {
        tickIndex,
        timestamp: nowTs,
        strategyId: this.strategyId,
        pair,
        decision: 'NO_TRADE',
        rawSpreadBps,
        estimatedNetSpreadBps: netSpreadBps,
        reason: `Net basis+funding spread ${netSpreadBps} bps below ${this.minEntryNetSpreadBps} bps threshold`,
      };
      this.decisions.push(noTradeLog);
      return noTradeLog;
    }

    const cycle = this.openNewCycle({
      pair,
      nowTs,
      seqA: spotBook.sequenceId,
      seqB: perpBook.sequenceId,
      legAExchange: 'binance',
      legAMarket: 'spot',
      legBExchange: 'binance',
      legBMarket: 'linear_perp',
      entryLegAPrice: buySpot.vwapPrice,
      entryLegBPrice: sellPerp.vwapPrice,
      rawSpreadBps,
    });

    const openLog: PaperDecisionLog = {
      tickIndex,
      timestamp: nowTs,
      strategyId: this.strategyId,
      pair,
      decision: 'OPEN_CYCLE',
      rawSpreadBps,
      estimatedNetSpreadBps: netSpreadBps,
      reason: `Opened spot-perp cycle ${cycle.cycleId} at ${rawSpreadBps} bps raw / ${netSpreadBps} bps net`,
    };
    this.decisions.push(openLog);
    return openLog;
  }

  private roundTripFeeBps(): number {
    return round4(this.singleLegTakerFeeRate * 4 * 10000);
  }

  private openNewCycle(params: {
    pair: PaperPair;
    nowTs: number;
    seqA: number;
    seqB: number;
    legAExchange: 'binance' | 'bybit';
    legAMarket: 'spot' | 'linear_perp';
    legBExchange: 'binance' | 'bybit';
    legBMarket: 'spot' | 'linear_perp';
    entryLegAPrice: number;
    entryLegBPrice: number;
    rawSpreadBps: number;
  }): PaperOpenCycle {
    const notionalUsdt = this.maxCycleNotionalUsdt;
    const quantityBase = round8(notionalUsdt / params.entryLegAPrice);
    // 2 entry legs * singleLegTakerFeeRate
    const entryFeesUsdt = round4(notionalUsdt * this.singleLegTakerFeeRate * 2);
    const cycleId = `${this.strategyId}-${params.pair.replace('/', '')}-${params.seqA}-${params.seqB}`;

    this.cashBalanceUsdt = round4(this.cashBalanceUsdt - notionalUsdt);

    const openCycle: PaperOpenCycle = {
      cycleId,
      strategyId: this.strategyId,
      pair: params.pair,
      entryTs: params.nowTs,
      entrySeqA: params.seqA,
      entrySeqB: params.seqB,
      notionalUsdt,
      quantityBase,
      legAExchange: params.legAExchange,
      legAMarket: params.legAMarket,
      legBExchange: params.legBExchange,
      legBMarket: params.legBMarket,
      entryLegAPrice: round6(params.entryLegAPrice),
      entryLegBPrice: round6(params.entryLegBPrice),
      entrySpreadBps: round4(params.rawSpreadBps),
      entryFeesUsdt,
      accruedFundingUsdt: 0,
    };

    this.openCycles.set(params.pair, openCycle);
    return openCycle;
  }

  private closeOpenCycle(
    open: PaperOpenCycle,
    exitLegAPrice: number,
    exitLegBPrice: number,
    exitSeqA: number,
    exitSeqB: number,
    exitTs: number,
    fundingDeltaUsdt: number,
    replayBatchId: string
  ): PaperClosedCycle {
    // Leg A was bought at entryLegAPrice and sold at exitLegAPrice
    const legAPnl = (exitLegAPrice - open.entryLegAPrice) * open.quantityBase;
    // Leg B was sold at entryLegBPrice and bought back at exitLegBPrice
    const legBPnl = (open.entryLegBPrice - exitLegBPrice) * open.quantityBase;

    const grossPnlUsdt = round4(legAPnl + legBPnl);
    const exitFeesUsdt = round4(open.notionalUsdt * this.singleLegTakerFeeRate * 2);
    const totalFeesUsdt = round4(open.entryFeesUsdt + exitFeesUsdt);
    const netPnlUsdt = round4(grossPnlUsdt + fundingDeltaUsdt - totalFeesUsdt);

    const realizedSpreadBps = round4((grossPnlUsdt / open.notionalUsdt) * 10000);
    const netSpreadBps = round4((netPnlUsdt / open.notionalUsdt) * 10000);

    const idempotencyKey = PaperStrategyEngine.computeIdempotencyKey([
      open.strategyId,
      open.pair,
      open.entrySeqA,
      open.entrySeqB,
      exitSeqA,
      exitSeqB,
      this.modelVersion,
    ]);

    const closed: PaperClosedCycle = {
      cycleId: open.cycleId,
      idempotencyKey,
      strategyId: open.strategyId,
      pair: open.pair,
      entryTs: open.entryTs,
      exitTs,
      entrySeqA: open.entrySeqA,
      entrySeqB: open.entrySeqB,
      exitSeqA,
      exitSeqB,
      notionalUsdt: open.notionalUsdt,
      quantityBase: open.quantityBase,
      legAExchange: open.legAExchange,
      legAMarket: open.legAMarket,
      legBExchange: open.legBExchange,
      legBMarket: open.legBMarket,
      entryLegAPrice: open.entryLegAPrice,
      entryLegBPrice: open.entryLegBPrice,
      exitLegAPrice: round6(exitLegAPrice),
      exitLegBPrice: round6(exitLegBPrice),
      rawSpreadBps: realizedSpreadBps,
      netSpreadBps,
      grossPnlUsdt,
      totalFeesUsdt,
      fundingDeltaUsdt: round4(fundingDeltaUsdt),
      netPnlUsdt,
      modelVersion: this.modelVersion,
      replayObjectKey: `r2://paper-replay/${replayBatchId}/${idempotencyKey}.json.gz`,
      executionMode: 'PAPER',
    };

    this.openCycles.delete(open.pair);
    this.closedCycles.push(closed);

    this.cashBalanceUsdt = round4(this.cashBalanceUsdt + open.notionalUsdt + netPnlUsdt);
    this.realizedNetPnlUsdt = round4(this.realizedNetPnlUsdt + netPnlUsdt);
    this.totalFeesPaidUsdt = round4(this.totalFeesPaidUsdt + totalFeesUsdt);
    this.totalFundingUsdt = round4(this.totalFundingUsdt + fundingDeltaUsdt);

    const currentEquity = this.getCurrentEquityUsdt();
    if (currentEquity > this.peakEquityUsdt) {
      this.peakEquityUsdt = currentEquity;
    }
    const drawdownPct = round4(
      ((this.peakEquityUsdt - currentEquity) / this.peakEquityUsdt) * 100
    );
    if (drawdownPct > this.maxDrawdownPct) {
      this.maxDrawdownPct = drawdownPct;
    }
    if (this.maxDrawdownPct > this.maxDrawdownLimitPct) {
      this.haltedByDrawdown = true;
    }

    return closed;
  }

  getCurrentEquityUsdt(): number {
    let allocated = 0;
    for (const c of this.openCycles.values()) {
      allocated += c.notionalUsdt;
    }
    return round4(this.cashBalanceUsdt + allocated);
  }

  getSnapshot(): PaperStrategySnapshot {
    let allocated = 0;
    for (const c of this.openCycles.values()) {
      allocated += c.notionalUsdt;
    }
    const wins = this.closedCycles.filter((c) => c.netPnlUsdt > 0).length;
    const winRatePct =
      this.closedCycles.length > 0
        ? round4((wins / this.closedCycles.length) * 100)
        : 0;

    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      executionMode: 'PAPER',
      modelVersion: this.modelVersion,
      initialCapitalUsdt: this.initialCapitalUsdt,
      cashBalanceUsdt: this.cashBalanceUsdt,
      allocatedNotionalUsdt: round4(allocated),
      equityUsdt: round4(this.cashBalanceUsdt + allocated),
      peakEquityUsdt: this.peakEquityUsdt,
      realizedNetPnlUsdt: this.realizedNetPnlUsdt,
      totalFeesPaidUsdt: this.totalFeesPaidUsdt,
      totalFundingUsdt: this.totalFundingUsdt,
      maxDrawdownPct: this.maxDrawdownPct,
      haltedByDrawdown: this.haltedByDrawdown,
      openCyclesCount: this.openCycles.size,
      closedCyclesCount: this.closedCycles.length,
      noTradeCount: this.noTradeCount,
      desyncHaltCount: this.desyncHaltCount,
      winRatePct,
    };
  }

  getClosedCycles(): PaperClosedCycle[] {
    return [...this.closedCycles];
  }

  getDecisions(): PaperDecisionLog[] {
    return [...this.decisions];
  }
}
