/**
 * src/lib/paper/types.ts
 *
 * Type definitions for the ApexOS Greenfield Paper Trading Engine.
 * Strictly paper-only: zero live CEX order placement or withdrawal permissions.
 */

export type PaperExchange = 'binance' | 'bybit';
export type PaperPair = 'BTC/USDT' | 'ETH/USDT';
export type PaperMarketType = 'spot' | 'linear_perp';
export type PaperStrategyId = 'spot-2exch' | 'spot-perp';

export interface OrderbookLevel {
  price: number;
  quantity: number;
}

export interface NormalizedOrderbook {
  exchange: PaperExchange;
  pair: PaperPair;
  marketType: PaperMarketType;
  sequenceId: number;
  prevSequenceId?: number;
  exchangeTs: number;
  receivedTs: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  fundingRateBps?: number;
}

export type SequencerStatus =
  | 'SYNCED'
  | 'FEED_DESYNC'
  | 'STALE_FEED'
  | 'CLOCK_SKEW'
  | 'UNINITIALIZED';

export interface SequencerStreamState {
  streamKey: string;
  exchange: PaperExchange;
  pair: PaperPair;
  marketType: PaperMarketType;
  status: SequencerStatus;
  lastSequenceId: number;
  lastExchangeTs: number;
  lastReceivedTs: number;
  feedAgeMs: number;
  gapCount: number;
  staleCount: number;
  lastErrorReason?: string;
}

export interface VwapFillResult {
  filled: boolean;
  vwapPrice: number;
  filledQuantityBase: number;
  filledNotionalUsdt: number;
  slippageBps: number;
}

export type PaperCycleDecision =
  | 'OPEN_CYCLE'
  | 'CLOSE_CYCLE'
  | 'HOLD'
  | 'NO_TRADE'
  | 'HALTED_DESYNC'
  | 'HALTED_DRAWDOWN';

export interface PaperOpenCycle {
  cycleId: string;
  strategyId: PaperStrategyId;
  pair: PaperPair;
  entryTs: number;
  entrySeqA: number;
  entrySeqB: number;
  notionalUsdt: number;
  quantityBase: number;
  legAExchange: PaperExchange;
  legAMarket: PaperMarketType;
  legBExchange: PaperExchange;
  legBMarket: PaperMarketType;
  entryLegAPrice: number;
  entryLegBPrice: number;
  entrySpreadBps: number;
  entryFeesUsdt: number;
  accruedFundingUsdt: number;
}

export interface PaperClosedCycle {
  cycleId: string;
  idempotencyKey: string;
  strategyId: PaperStrategyId;
  pair: PaperPair;
  entryTs: number;
  exitTs: number;
  entrySeqA: number;
  entrySeqB: number;
  exitSeqA: number;
  exitSeqB: number;
  notionalUsdt: number;
  quantityBase: number;
  legAExchange: PaperExchange;
  legAMarket: PaperMarketType;
  legBExchange: PaperExchange;
  legBMarket: PaperMarketType;
  entryLegAPrice: number;
  entryLegBPrice: number;
  exitLegAPrice: number;
  exitLegBPrice: number;
  rawSpreadBps: number;
  netSpreadBps: number;
  grossPnlUsdt: number;
  totalFeesUsdt: number;
  fundingDeltaUsdt: number;
  netPnlUsdt: number;
  modelVersion: string;
  replayObjectKey: string;
  executionMode: 'PAPER';
}

export interface PaperDecisionLog {
  tickIndex: number;
  timestamp: number;
  strategyId: PaperStrategyId;
  pair: PaperPair;
  decision: PaperCycleDecision;
  rawSpreadBps: number;
  estimatedNetSpreadBps: number;
  reason: string;
}

export interface PaperStrategySnapshot {
  strategyId: PaperStrategyId;
  strategyName: string;
  executionMode: 'PAPER';
  modelVersion: string;
  initialCapitalUsdt: number;
  cashBalanceUsdt: number;
  allocatedNotionalUsdt: number;
  equityUsdt: number;
  peakEquityUsdt: number;
  realizedNetPnlUsdt: number;
  totalFeesPaidUsdt: number;
  totalFundingUsdt: number;
  maxDrawdownPct: number;
  haltedByDrawdown: boolean;
  openCyclesCount: number;
  closedCyclesCount: number;
  noTradeCount: number;
  desyncHaltCount: number;
  winRatePct: number;
}

export interface ReplayTick {
  tickIndex: number;
  nowTs: number;
  books: NormalizedOrderbook[];
}

export interface ReplayExecutionResult {
  modelVersion: string;
  tickCount: number;
  digest: string;
  strategies: Record<PaperStrategyId, PaperStrategySnapshot>;
  closedCycles: PaperClosedCycle[];
  decisions: PaperDecisionLog[];
  sequencerStates: SequencerStreamState[];
}

export interface EconomicResearchSummary {
  reportType: 'DESCRIPTIVE_RESEARCH_ONLY';
  isReleaseBlocker: false;
  generatedAt: string;
  modelVersion: string;
  strategies: Array<{
    strategyId: PaperStrategyId;
    observedContinuousDays: number;
    targetBenchmarkDays: number;
    closedCyclesCount: number;
    targetBenchmarkCycles: number;
    netPnlUsdt: number;
    maxDrawdownPct: number;
    maxDrawdownLimitPct: number;
    researchFinding: string;
  }>;
}
