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
  firstUpdateId?: number;
  exchangeTs: number;
  receivedTs: number;
  isDelta?: boolean;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  fundingRateBps?: number;
  nextFundingTimeMs?: number;
  fundingEventId?: string;
  fundingSettlementTs?: number;
}

export interface FundingSettlementEvent {
  eventId: string;
  exchange: PaperExchange;
  pair: PaperPair;
  settlementTs: number;
  fundingRateBps: number;
  notionalUsdt: number;
  fundingDeltaUsdt: number;
}

export type SequencerStatus =
  | 'SYNCED'
  | 'FEED_DESYNC'
  | 'STALE_FEED'
  | 'CLOCK_SKEW'
  | 'DISCONNECTED'
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
  lastFundingAccrualTs?: number;
  appliedFundingEventIds?: string[];
  /** Last recorded unrealized P&L mark for this cycle, in USDT. */
  lastUnrealizedPnlUsdt?: number;
  /** Net quote cash delta applied to free+allocated collateral upon opening this cycle. */
  openCycleCashDeltaUsdt?: number;
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

export interface VenueCollateralBalance {
  exchange: PaperExchange;
  freeCollateralUsdt: number;
  allocatedCollateralUsdt: number;
  baseInventory: Record<PaperPair, number>;
  baseInventoryCostBasisUsdt?: Record<PaperPair, number>;
}

export interface PaperStrategySnapshot {
  strategyId: PaperStrategyId;
  strategyName: string;
  executionMode: 'PAPER';
  modelVersion: string;
  initialCapitalUsdt: number;
  cashBalanceUsdt: number;
  allocatedNotionalUsdt: number;
  inventoryValueUsdt?: number;
  unrealizedPnlUsdt?: number;
  equityUsdt: number;
  peakEquityUsdt: number;
  realizedNetPnlUsdt: number;
  totalFeesPaidUsdt: number;
  totalRebalanceFeesUsdt?: number;
  totalFundingUsdt: number;
  maxDrawdownPct: number;
  haltedByDrawdown: boolean;
  openCyclesCount: number;
  closedCyclesCount: number;
  noTradeCount: number;
  desyncHaltCount: number;
  winRatePct: number;
  venueBalances?: Record<PaperExchange, VenueCollateralBalance>;
  fundingLedger?: FundingSettlementEvent[];
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

export interface StrategyEconomicAudit {
  strategyId: PaperStrategyId;
  observedContinuousDays: number;
  targetBenchmarkDays: number;
  daysPassed: boolean;
  closedCyclesCount: number;
  targetBenchmarkCycles: number;
  cyclesPassed: boolean;
  netPnlUsdt: number;
  pnlPassed: boolean;
  maxDrawdownPct: number;
  maxDrawdownLimitPct: number;
  drawdownPassed: boolean;
  isReadyForLive: boolean;
  verdict: 'GO' | 'NO_GO';
  researchFinding: string;
}

export interface EconomicResearchSummary {
  reportType: 'STRICT_ECONOMIC_AUDIT';
  isReleaseBlocker: true;
  overallVerdict: 'GO' | 'NO_GO';
  generatedAt: string;
  modelVersion: string;
  strategies: StrategyEconomicAudit[];
}
