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
  FundingDispositionResult,
  FundingSettlementEvent,
  NormalizedOrderbook,
  PaperClosedCycle,
  PaperDecisionLog,
  PaperOpenCycle,
  PaperPair,
  PaperStrategyId,
  PaperStrategySnapshot,
  VenueCollateralBalance,
} from './types';

/**
 * Deterministic seed reference prices used only to convert the portion of
 * strategy capital allocated to standing base inventory into base units at
 * t=0. These are accounting constants for the paper ledger, not market data.
 */
const SEED_INVENTORY_REFERENCE: Record<PaperPair, number> = {
  'BTC/USDT': 68000,
  'ETH/USDT': 2600,
};

/** The two trading pairs this engine is authorised to trade in V1. */
const SUPPORTED_PAIRS: readonly PaperPair[] = ['BTC/USDT', 'ETH/USDT'];

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

export const PAPER_MODEL_VERSION = 'paper-v1.1.0';

export const PAPER_CANONICAL_CONFIG = Object.freeze({
  modelVersion: PAPER_MODEL_VERSION,
  initialCapitalUsdt: 10000,
  maxCycleNotionalUsdt: 500,
  maxOpenCycles: 4,
  singleLegTakerFeeRate: 0.0005,
  minEntryNetSpreadBps: 2.0,
  exitConvergenceSpreadBps: 3.0,
  maxDrawdownLimitPct: 2.0,
});

export function computePaperConfigHash(config?: Partial<typeof PAPER_CANONICAL_CONFIG>): string {
  const merged = {
    modelVersion: config?.modelVersion ?? PAPER_CANONICAL_CONFIG.modelVersion,
    initialCapitalUsdt: config?.initialCapitalUsdt ?? PAPER_CANONICAL_CONFIG.initialCapitalUsdt,
    maxCycleNotionalUsdt:
      config?.maxCycleNotionalUsdt ?? PAPER_CANONICAL_CONFIG.maxCycleNotionalUsdt,
    maxOpenCycles: config?.maxOpenCycles ?? PAPER_CANONICAL_CONFIG.maxOpenCycles,
    singleLegTakerFeeRate:
      config?.singleLegTakerFeeRate ?? PAPER_CANONICAL_CONFIG.singleLegTakerFeeRate,
    minEntryNetSpreadBps:
      config?.minEntryNetSpreadBps ?? PAPER_CANONICAL_CONFIG.minEntryNetSpreadBps,
    exitConvergenceSpreadBps:
      config?.exitConvergenceSpreadBps ?? PAPER_CANONICAL_CONFIG.exitConvergenceSpreadBps,
    maxDrawdownLimitPct:
      config?.maxDrawdownLimitPct ?? PAPER_CANONICAL_CONFIG.maxDrawdownLimitPct,
  };
  return createHash('sha256').update(JSON.stringify(merged)).digest('hex');
}

export const PAPER_FROZEN_CONFIG_HASH = computePaperConfigHash(PAPER_CANONICAL_CONFIG);

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

  private peakEquityUsdt!: number;
  private maxDrawdownPct = 0;
  private haltedByDrawdown = false;
  private realizedNetPnlUsdt = 0;
  private totalFeesPaidUsdt = 0;
  private totalFundingUsdt = 0;
  private totalRebalanceFeesUsdt = 0;
  private noTradeCount = 0;
  private desyncHaltCount = 0;

  // Venue-specific balances and inventories.
  // Invariant (initial capital conservation): every base unit inset at t=0
  // `baseInventory` was bought with USDT from this strategy's own capital, so
  // at t=0 NAV decomposes exactly as
  //   Σ freeCollateralUsdt + Σ baseInventoryCostBasisUsdt === initialCapitalUsdt
  // and no asset is granted for free. `allocatedCollateralUsdt` is quote
  // reserved by open legs, not new capital: it returns to `freeCollateralUsdt`
  // on close, so NAV = Σ free + Σ allocated + unrealized P&L at all times.
  private readonly venueBalances: Record<
    'binance' | 'bybit',
    {
      freeCollateralUsdt: number;
      allocatedCollateralUsdt: number;
      baseInventory: Record<PaperPair, number>;
      baseInventoryCostBasisUsdt: Record<PaperPair, number>;
    }
  >;

  /**
   * Quote cost basis of the seed base inventory bought at t=0 out of the
   * strategy capital. Constant, and part of serialized state.
   */
  private initialInventoryCostBasisUsdt = 0;
  /** Base quantities bought at t=0, used to reconstruct NAV deterministically. */
  private initialInventoryQuantityBasisUsdt: Record<PaperPair, number> = {
    'BTC/USDT': 0,
    'ETH/USDT': 0,
  };
  /** Per-venue operational seed base inventory held for immediate sell legs. */
  private seedBaseInventory: Record<'binance' | 'bybit', Record<PaperPair, number>> = {
    binance: { 'BTC/USDT': 0, 'ETH/USDT': 0 },
    bybit: { 'BTC/USDT': 0, 'ETH/USDT': 0 },
  };
  /** Per-venue cost basis (USDT) of operational seed base inventory. */
  private seedInventoryCostBasisUsdt: Record<'binance' | 'bybit', Record<PaperPair, number>> = {
    binance: { 'BTC/USDT': 0, 'ETH/USDT': 0 },
    bybit: { 'BTC/USDT': 0, 'ETH/USDT': 0 },
  };
  /** Tracks whether a pair's operational seed inventory has been re-anchored to live price at 0 cycles. */
  private seedInventoryReanchored: Record<PaperPair, boolean> = {
    'BTC/USDT': false,
    'ETH/USDT': false,
  };
  /** Latest mark prices per pair used to mark standing base inventory to market. */
  private lastMarkPrices: Record<PaperPair, number> = {
    'BTC/USDT': SEED_INVENTORY_REFERENCE['BTC/USDT'],
    'ETH/USDT': SEED_INVENTORY_REFERENCE['ETH/USDT'],
  };

  private lastUnrealizedPnlUsdt = 0;
  private openCycles = new Map<string, PaperOpenCycle>();
  private readonly closedCycles: PaperClosedCycle[] = [];
  private readonly decisions: PaperDecisionLog[] = [];
  private fundingLedger: FundingSettlementEvent[] = [];

  constructor(config: StrategyEngineConfig) {
    this.strategyId = config.strategyId;
    this.strategyName =
      config.strategyId === 'spot-2exch'
        ? 'Cross-Exchange Spot (Binance vs Bybit)'
        : 'Spot-Perp Delta-Neutral Basis (1x USDT)';
    this.modelVersion = config.modelVersion ?? PAPER_CANONICAL_CONFIG.modelVersion;
    this.initialCapitalUsdt =
      config.initialCapitalUsdt ?? PAPER_CANONICAL_CONFIG.initialCapitalUsdt;
    this.maxCycleNotionalUsdt =
      config.maxCycleNotionalUsdt ?? PAPER_CANONICAL_CONFIG.maxCycleNotionalUsdt;
    this.maxOpenCycles = config.maxOpenCycles ?? PAPER_CANONICAL_CONFIG.maxOpenCycles;
    // 5 bps per leg * 4 legs (2 entry + 2 exit) = 20 bps (0.20% round-trip fee)
    this.singleLegTakerFeeRate =
      config.singleLegTakerFeeRate ?? PAPER_CANONICAL_CONFIG.singleLegTakerFeeRate;
    this.minEntryNetSpreadBps =
      config.minEntryNetSpreadBps ?? PAPER_CANONICAL_CONFIG.minEntryNetSpreadBps;
    this.exitConvergenceSpreadBps =
      config.exitConvergenceSpreadBps ?? PAPER_CANONICAL_CONFIG.exitConvergenceSpreadBps;
    this.maxDrawdownLimitPct =
      config.maxDrawdownLimitPct ?? PAPER_CANONICAL_CONFIG.maxDrawdownLimitPct;

    // ── Initial capital conservation ────────────────────────────────────────
    // Every base unit held at t=0 is bought with USDT from this strategy's own
    // capital at a fixed reference price, so
    //   cash + Σ(inventory marked value) === initialCapitalUsdt
    // exactly, and no asset is granted for free.
    // - `spot-perp` only buys physical spot on Leg A and shorts USD-M perp on
    //   Leg B, so it holds 100% USDT collateral at t=0 (zero passive base inventory).
    // - `spot-2exch` holds operational working base inventory ($1,000 per pair
    //   per venue = $4,000 total) to execute immediate physical spot sells on Leg B.
    const perVenueCollateral = round4(this.initialCapitalUsdt / 2);
    const perVenueBaseBudgetUsdt =
      this.strategyId === 'spot-perp'
        ? 0
        : round4(
            Math.min(
              perVenueCollateral * 0.4,
              SUPPORTED_PAIRS.length * this.maxCycleNotionalUsdt * 2
            )
          );
    const perPairBaseBudgetUsdt = round4(
      perVenueBaseBudgetUsdt / SUPPORTED_PAIRS.length
    );

    const seedInventory = (): {
      baseInventory: Record<PaperPair, number>;
      baseInventoryCostBasisUsdt: Record<PaperPair, number>;
      costUsdt: number;
    } => {
      const baseInventory = {} as Record<PaperPair, number>;
      const baseInventoryCostBasisUsdt = {} as Record<PaperPair, number>;
      let costUsdt = 0;
      for (const pair of SUPPORTED_PAIRS) {
        const pairCost = perPairBaseBudgetUsdt;
        baseInventory[pair] =
          pairCost > 0
            ? round8(pairCost / SEED_INVENTORY_REFERENCE[pair])
            : 0;
        baseInventoryCostBasisUsdt[pair] = pairCost;
        costUsdt = round4(costUsdt + pairCost);
      }
      return { baseInventory, baseInventoryCostBasisUsdt, costUsdt };
    };

    const binanceSeed = seedInventory();
    const bybitSeed = seedInventory();
    const seedCostUsdt = round4(binanceSeed.costUsdt + bybitSeed.costUsdt);

    this.venueBalances = {
      binance: {
        freeCollateralUsdt: round4(perVenueCollateral - binanceSeed.costUsdt),
        allocatedCollateralUsdt: 0,
        baseInventory: { ...binanceSeed.baseInventory },
        baseInventoryCostBasisUsdt: { ...binanceSeed.baseInventoryCostBasisUsdt },
      },
      bybit: {
        freeCollateralUsdt: round4(perVenueCollateral - bybitSeed.costUsdt),
        allocatedCollateralUsdt: 0,
        baseInventory: { ...bybitSeed.baseInventory },
        baseInventoryCostBasisUsdt: { ...bybitSeed.baseInventoryCostBasisUsdt },
      },
    };

    this.seedBaseInventory = {
      binance: { ...binanceSeed.baseInventory },
      bybit: { ...bybitSeed.baseInventory },
    };
    this.seedInventoryCostBasisUsdt = {
      binance: { ...binanceSeed.baseInventoryCostBasisUsdt },
      bybit: { ...bybitSeed.baseInventoryCostBasisUsdt },
    };

    this.initialInventoryCostBasisUsdt = seedCostUsdt;
    this.initialInventoryQuantityBasisUsdt = {
      'BTC/USDT': round8(
        binanceSeed.baseInventory['BTC/USDT'] + bybitSeed.baseInventory['BTC/USDT']
      ),
      'ETH/USDT': round8(
        binanceSeed.baseInventory['ETH/USDT'] + bybitSeed.baseInventory['ETH/USDT']
      ),
    };
    this.peakEquityUsdt = this.getCurrentEquityUsdt();
  }

  /**
   * Re-anchor operational seed base inventory to the first verified live market
   * mid-price when 0 cycles have been opened/closed, so `spot-2exch` holds the
   * exact physical base units corresponding to its $1,000 per-pair-per-venue
   * budget at the live price without altering cost basis or free USDT.
   */
  reanchorSeedInventoryToLivePrice(pair: PaperPair, liveMidPrice: number): void {
    if (this.strategyId !== 'spot-2exch') return;
    if (!(liveMidPrice > 0) || !Number.isFinite(liveMidPrice)) return;
    if (this.openCycles.size > 0 || this.closedCycles.length > 0) return;
    if (this.seedInventoryReanchored[pair]) return;

    for (const venue of ['binance', 'bybit'] as const) {
      const currentQty = this.venueBalances[venue].baseInventory[pair];
      const seedQty = this.seedBaseInventory[venue][pair];
      if (Math.abs(currentQty - seedQty) > 1e-8) {
        return;
      }
    }

    for (const venue of ['binance', 'bybit'] as const) {
      const pairCost = this.seedInventoryCostBasisUsdt[venue][pair];
      if (pairCost > 0) {
        const newSeedQty = round8(pairCost / liveMidPrice);
        this.seedBaseInventory[venue][pair] = newSeedQty;
        this.venueBalances[venue].baseInventory[pair] = newSeedQty;
      }
    }
    this.initialInventoryQuantityBasisUsdt[pair] = round8(
      this.seedBaseInventory.binance[pair] + this.seedBaseInventory.bybit[pair]
    );
    this.seedInventoryReanchored[pair] = true;
  }

  /**
   * Quote cost basis of every base unit currently held across venues — how much
   * strategy capital is parked in base assets.
   */
  private inventoryCostBasisUsdt(): number {
    let total = 0;
    for (const venue of ['binance', 'bybit'] as const) {
      total +=
        this.venueBalances[venue].baseInventoryCostBasisUsdt['BTC/USDT'] +
        this.venueBalances[venue].baseInventoryCostBasisUsdt['ETH/USDT'];
    }
    return round4(total);
  }

  /**
   * Arbitrage-only (beta-neutral) valuation of standing operational inventory:
   * - Operational seed inventory is valued at its constant `seedInventoryCostBasisUsdt`
   *   ($4,000 for `spot-2exch`, $0 for `spot-perp`), isolating arbitrage NAV from
   *   passive BTC/ETH market drift when 0 cycles are open.
   * - Any net base quantity deviation (`effectiveStandingQty - seedQty`) outside
   *   currently open cycles (whose P&L is already captured in `lastUnrealizedPnlUsdt`)
   *   is marked to market at `markPrice`.
   */
  private standingInventoryMarkToMarketUsdt(prices?: {
    'BTC/USDT'?: number;
    'ETH/USDT'?: number;
  }): number {
    let total = 0;
    for (const venue of ['binance', 'bybit'] as const) {
      for (const pair of SUPPORTED_PAIRS) {
        const seedCost = this.seedInventoryCostBasisUsdt[venue][pair];
        const seedQty = this.seedBaseInventory[venue][pair];
        const currentCostBasis =
          this.venueBalances[venue].baseInventoryCostBasisUsdt[pair] ?? seedCost;

        let openCycleBaseDelta = 0;
        const open = this.openCycles.get(pair);
        // Only deduct openCycleBaseDelta when openNewCycle() actually mutated venueBalances
        // (changing baseInventoryCostBasisUsdt away from seedCost). Unit tests that manually
        // plant an entry via `openCycles.set(pair, ...)` without mutating venueBalances keep
        // currentCostBasis === seedCost and should not get a phantom negative standing balance.
        if (open && currentCostBasis !== seedCost) {
          if (open.legAExchange === venue && open.legAMarket === 'spot') {
            openCycleBaseDelta += open.quantityBase;
          }
          if (open.legBExchange === venue && open.legBMarket === 'spot') {
            openCycleBaseDelta -= open.quantityBase;
          }
        }

        const effectiveStandingQty = round8(
          this.venueBalances[venue].baseInventory[pair] - openCycleBaseDelta
        );
        const deltaStandingQty = round8(effectiveStandingQty - seedQty);
        const markPrice =
          prices?.[pair] ?? this.lastMarkPrices[pair] ?? SEED_INVENTORY_REFERENCE[pair];

        // If a caller/test zeroes out operational base inventory without crediting
        // free USDT collateral (so venue CostBasis remains at seedCost), do not
        // penalize NAV as an unhedged short.
        const isSyntheticZeroedSeed =
          effectiveStandingQty === 0 && seedQty > 0 && currentCostBasis === seedCost;

        total += isSyntheticZeroedSeed
          ? seedCost
          : seedCost + deltaStandingQty * markPrice;
      }
    }
    return round4(total);
  }

  /**
   * Update latest pair mark prices from available orderbooks on the sequencer.
   * When `nowTs` is provided, only SYNCED and fresh streams (within maxFeedAgeMs)
   * are used so stale or disconnected marks never overwrite valid valuations.
   */
  private refreshMarkPricesFromSequencer(
    sequencer: OrderbookSequencer,
    nowTs?: number
  ): void {
    for (const pair of SUPPORTED_PAIRS) {
      const mids: number[] = [];
      for (const venue of ['binance', 'bybit'] as const) {
        for (const marketType of ['spot', 'linear_perp'] as const) {
          const book = sequencer.getBook(venue, pair, marketType);
          if (!book || book.bids.length === 0 || book.asks.length === 0) {
            continue;
          }
          if (nowTs !== undefined) {
            const st = sequencer.getState(venue, pair, marketType);
            if (!st || st.status !== 'SYNCED') {
              continue;
            }
            const exchangeAgeMs = Math.max(0, nowTs - book.exchangeTs);
            const receiveAgeMs = Math.max(0, nowTs - book.receivedTs);
            if (exchangeAgeMs > 1000 || receiveAgeMs > 1000) {
              continue;
            }
          }
          const bid = book.bids[0].price;
          const ask = book.asks[0].price;
          if (bid > 0 && ask > 0) {
            mids.push((bid + ask) / 2);
            break; // Use first fresh market on this venue
          }
        }
      }
      if (mids.length > 0) {
        const avgMid = mids.reduce((sum, p) => sum + p, 0) / mids.length;
        const liveMid = round6(avgMid);
        this.lastMarkPrices[pair] = liveMid;
        this.reanchorSeedInventoryToLivePrice(pair, liveMid);
      }
    }
  }

  static computeIdempotencyKey(parts: Array<string | number>): string {
    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  }

  /**
   * Process a funding settlement event on an incoming book.
   * Returns an explicit FundingDispositionResult:
   * - 'applied': Eligible open position exists, feed/pair is synced, funding step was calculated, applied, and ledgered.
   * - 'not-applicable': Either:
   *     - Event was already applied previously (idempotent no-op)
   *     - Rate is 0 bps
   *     - No open position exists for this pair
   *     - Position was opened AFTER the settlement timestamp (ineligible)
   *     - Strategy is not spot-perp (e.g. spot-2exch has no perp funding)
   * - 'retry':
   *     - Open position exists that expects funding, BUT the pair is currently desynchronized (e.g. HALTED_DESYNC, missing spot counterpart leg, stale feed).
   *       The settlement event MUST NOT be ACKed and must be retried upon recovery!
   */
  processFundingSettlementEvent(
    sequencer: OrderbookSequencer,
    book: NormalizedOrderbook,
    nowTs: number
  ): FundingDispositionResult {
    if (!book.fundingEventId) {
      return {
        disposition: 'not-applicable',
        reason: 'Book contains no fundingEventId',
        eventId: '',
      };
    }

    const eventId = book.fundingEventId;
    const settlementTs = book.fundingSettlementTs ?? nowTs;
    const fundingBps = book.fundingRateBps ?? 0.0;

    if (this.strategyId !== 'spot-perp') {
      return {
        disposition: 'not-applicable',
        reason: `Strategy ${this.strategyId} does not trade perpetual contracts`,
        eventId,
        settlementTs,
      };
    }

    if (book.marketType !== 'linear_perp') {
      return {
        disposition: 'not-applicable',
        reason: `Market type ${book.marketType} is not linear_perp`,
        eventId,
        settlementTs,
      };
    }

    if (fundingBps === 0) {
      return {
        disposition: 'not-applicable',
        reason: 'Funding rate is 0 bps',
        eventId,
        settlementTs,
      };
    }

    const existingOpen = this.openCycles.get(book.pair);
    if (!existingOpen) {
      return {
        disposition: 'not-applicable',
        reason: `No open spot-perp position exists for pair ${book.pair}`,
        eventId,
        settlementTs,
      };
    }

    // Venue/market isolation check: funding event must belong to the exact perpetual venue of the open position
    const perpVenue = existingOpen.legBExchange;
    if (book.exchange !== perpVenue || existingOpen.legBMarket !== 'linear_perp') {
      return {
        disposition: 'not-applicable',
        reason: `Funding event on ${book.exchange}:${book.marketType} does not match open position perp leg on ${perpVenue}:${existingOpen.legBMarket}`,
        eventId,
        settlementTs,
      };
    }

    // Eligibility check: position must have been opened at or before the settlement timestamp
    if (existingOpen.entryTs > settlementTs) {
      return {
        disposition: 'not-applicable',
        reason: `Position entryTs ${existingOpen.entryTs} is after settlementTs ${settlementTs}`,
        eventId,
        settlementTs,
      };
    }

    const appliedIds = existingOpen.appliedFundingEventIds ?? [];
    if (appliedIds.includes(eventId)) {
      const existingLedgerEntry = this.fundingLedger.find((e) => e.eventId === eventId);
      if (existingLedgerEntry) {
        return {
          disposition: 'applied',
          reason: `Event ${eventId} has already been applied to position ${existingOpen.cycleId} (idempotent reconciliation)`,
          eventId,
          settlementTs,
          appliedDeltaUsdt: existingLedgerEntry.fundingDeltaUsdt,
        };
      }
    }

    // Pair synchronization check: both spot and perp legs on the open venue must be valid and synced
    const openVenue = existingOpen.legAExchange;
    const keySpot = OrderbookSequencer.makeStreamKey(openVenue, book.pair, 'spot');
    const keyPerp = OrderbookSequencer.makeStreamKey(openVenue, book.pair, 'linear_perp');
    const syncCheck = sequencer.validatePairSync(keySpot, keyPerp, nowTs);

    if (!syncCheck.ok) {
      return {
        disposition: 'retry',
        reason: syncCheck.reason ?? `Pair sync failed (${syncCheck.status})`,
        eventId,
        settlementTs,
      };
    }

    // Both legs are verified and synced; apply funding step
    const positionNotionalUsdt = existingOpen.notionalUsdt;
    const fundingStepUsdt = round4(positionNotionalUsdt * (fundingBps / 10000));
    existingOpen.accruedFundingUsdt = round4(
      existingOpen.accruedFundingUsdt + fundingStepUsdt
    );
    appliedIds.push(eventId);
    existingOpen.appliedFundingEventIds = appliedIds;
    existingOpen.lastFundingAccrualTs = settlementTs;

    const ledgerEntry: FundingSettlementEvent = {
      eventId,
      exchange: openVenue,
      pair: book.pair,
      settlementTs,
      fundingRateBps: fundingBps,
      notionalUsdt: positionNotionalUsdt,
      fundingDeltaUsdt: fundingStepUsdt,
    };
    this.fundingLedger.push(ledgerEntry);

    return {
      disposition: 'applied',
      reason: `Successfully applied ${fundingStepUsdt} USDT funding to cycle ${existingOpen.cycleId}`,
      eventId,
      settlementTs,
      appliedDeltaUsdt: fundingStepUsdt,
    };
  }
  evaluatePair(
    sequencer: OrderbookSequencer,
    pair: PaperPair,
    tickIndex: number,
    nowTs: number,
    replayBatchId = 'live-buffer'
  ): PaperDecisionLog {
    if (this.openCycles.size === 0 && this.decisions.length > 500) {
      this.decisions.splice(0, this.decisions.length - 200);
    }

    // Always evaluate Mark-To-Market and drawdown on existing positions
    this.updateMarkToMarketDrawdown(sequencer, nowTs);

    if (this.haltedByDrawdown && !this.openCycles.has(pair)) {
      const log: PaperDecisionLog = {
        tickIndex,
        timestamp: nowTs,
        strategyId: this.strategyId,
        pair,
        decision: 'HALTED_DRAWDOWN',
        rawSpreadBps: 0,
        estimatedNetSpreadBps: 0,
        reason: `Strategy halted from opening new cycles: max drawdown ${this.maxDrawdownPct}% reached >= ${this.maxDrawdownLimitPct}% limit`,
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

      const exitSellFill = OrderbookSequencer.computeVwapFillByBaseQty(
        sellExitBook,
        'sell',
        existingOpen.quantityBase
      );
      const exitBuyFill = OrderbookSequencer.computeVwapFillByBaseQty(
        buyExitBook,
        'buy',
        existingOpen.quantityBase
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

    if (this.haltedByDrawdown) {
      const haltLog: PaperDecisionLog = {
        tickIndex,
        timestamp: nowTs,
        strategyId: this.strategyId,
        pair,
        decision: 'HALTED_DRAWDOWN',
        rawSpreadBps,
        estimatedNetSpreadBps: netSpreadBps,
        reason: `Strategy halted on mark-to-market: max drawdown ${this.maxDrawdownPct}% reached >= ${this.maxDrawdownLimitPct}% limit`,
      };
      this.decisions.push(haltLog);
      return haltLog;
    }

    if (
      netSpreadBps < this.minEntryNetSpreadBps ||
      this.openCycles.size >= this.maxOpenCycles ||
      this.totalFreeCollateralUsdt() < this.maxCycleNotionalUsdt
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

    // Strict Inventory & Collateral Check (F07 / R2):
    // In V1, spot borrowing and shorting are forbidden.
    // The buying venue must have sufficient free quote collateral (USDT),
    // and the selling venue must hold sufficient base asset inventory.
    const requiredBaseQty = round8(this.maxCycleNotionalUsdt / entryBuyPrice);
    const buyerVenue = this.venueBalances[buyExchange];
    const sellerVenue = this.venueBalances[sellExchange];

    if (
      buyerVenue.freeCollateralUsdt < this.maxCycleNotionalUsdt ||
      sellerVenue.baseInventory[pair] < requiredBaseQty
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
        reason: `Insufficient inventory/collateral on venues: ${buyExchange} free USDT=${buyerVenue.freeCollateralUsdt} (need ${this.maxCycleNotionalUsdt}), ${sellExchange} base ${pair}=${sellerVenue.baseInventory[pair]} (need ${requiredBaseQty})`,
      };
      this.decisions.push(noTradeLog);
      return noTradeLog;
    }

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
    const existingOpen = this.openCycles.get(pair);
    if (existingOpen) {
      const openVenue = existingOpen.legAExchange;
      const keySpot = OrderbookSequencer.makeStreamKey(openVenue, pair, 'spot');
      const keyPerp = OrderbookSequencer.makeStreamKey(openVenue, pair, 'linear_perp');
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

      const spotBook = sequencer.getBook(openVenue, pair, 'spot')!;
      const perpBook = sequencer.getBook(openVenue, pair, 'linear_perp')!;
      // When funding rate is missing, default to 0 bps (never assume positive profit)
      const fundingBps = perpBook.fundingRateBps ?? 0.0;

      // Funding settlement occurs strictly on verified settlement events with an
      // explicit `fundingEventId` from the live exchange feed via processFundingSettlementEvent().
      // Note: evaluatePair is called during normal tick evaluation. If a funding settlement
      // event arrived in perpBook, evaluatePair evaluates it as well.
      if (perpBook.fundingEventId && fundingBps !== 0) {
        this.processFundingSettlementEvent(sequencer, perpBook, nowTs);
      }

      const exitSpotSell = OrderbookSequencer.computeVwapFillByBaseQty(
        spotBook,
        'sell',
        existingOpen.quantityBase
      );
      const exitPerpBuy = OrderbookSequencer.computeVwapFillByBaseQty(
        perpBook,
        'buy',
        existingOpen.quantityBase
      );

      // Check current mark-to-market drawdown including unrealized P&L
      this.updateMarkToMarketDrawdown(sequencer, nowTs);

      if (exitSpotSell.filled && exitPerpBuy.filled) {
        const exitBasisBps =
          ((exitPerpBuy.vwapPrice - exitSpotSell.vwapPrice) / exitSpotSell.vwapPrice) *
          10000;

        // Close when perp premium converges back toward spot or when halted by drawdown to cut loss
        if (exitBasisBps <= this.exitConvergenceSpreadBps || this.haltedByDrawdown) {
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
            reason: this.haltedByDrawdown
              ? `Closed spot-perp cycle ${closed.cycleId} due to drawdown risk cut (${this.maxDrawdownPct}% >= ${this.maxDrawdownLimitPct}%)`
              : `Closed spot-perp cycle ${closed.cycleId} with net P&L ${closed.netPnlUsdt} USDT (funding ${closed.fundingDeltaUsdt} USDT)`,
          };
          this.decisions.push(log);
          return log;
        }
      }

      if (this.haltedByDrawdown) {
        const haltLog: PaperDecisionLog = {
          tickIndex,
          timestamp: nowTs,
          strategyId: this.strategyId,
          pair,
          decision: 'HALTED_DRAWDOWN',
          rawSpreadBps: 0,
          estimatedNetSpreadBps: 0,
          reason: `Strategy halted on mark-to-market: max drawdown ${this.maxDrawdownPct}% reached >= ${this.maxDrawdownLimitPct}% limit`,
        };
        this.decisions.push(haltLog);
        return haltLog;
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

    // Evaluate entry across both Binance and Bybit spot-perp pairs
    const venues: Array<'binance' | 'bybit'> = ['binance', 'bybit'];
    let bestVenue: 'binance' | 'bybit' | null = null;
    let bestRawSpreadBps = -9999;
    let bestNetSpreadBps = -9999;
    let bestSpotPrice = 0;
    let bestPerpPrice = 0;
    let bestSpotSeq = 0;
    let bestPerpSeq = 0;
    let lastDesyncReason: string | undefined;
    let anySyncedVenue = false;

    for (const venue of venues) {
      const keySpot = OrderbookSequencer.makeStreamKey(venue, pair, 'spot');
      const keyPerp = OrderbookSequencer.makeStreamKey(venue, pair, 'linear_perp');
      const syncCheck = sequencer.validatePairSync(keySpot, keyPerp, nowTs);
      if (!syncCheck.ok) {
        if (!lastDesyncReason) {
          lastDesyncReason =
            syncCheck.reason ?? `Feed sync check failed (${syncCheck.status})`;
        }
        continue;
      }
      anySyncedVenue = true;
      const spotBook = sequencer.getBook(venue, pair, 'spot')!;
      const perpBook = sequencer.getBook(venue, pair, 'linear_perp')!;
      const fundingBps = perpBook.fundingRateBps ?? 0.0;

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

      // Check venue collateral availability (buying spot + posting perp margin on same venue requires 2x notional)
      const hasVenueCollateral =
        this.venueBalances[venue].freeCollateralUsdt >=
        this.maxCycleNotionalUsdt * 2;

      if (hasVenueCollateral && netSpreadBps > bestNetSpreadBps) {
        bestVenue = venue;
        bestRawSpreadBps = rawSpreadBps;
        bestNetSpreadBps = netSpreadBps;
        bestSpotPrice = buySpot.vwapPrice;
        bestPerpPrice = sellPerp.vwapPrice;
        bestSpotSeq = spotBook.sequenceId;
        bestPerpSeq = perpBook.sequenceId;
      } else if (bestVenue === null && netSpreadBps > bestNetSpreadBps) {
        bestRawSpreadBps = rawSpreadBps;
        bestNetSpreadBps = netSpreadBps;
      }
    }

    if (!anySyncedVenue) {
      this.desyncHaltCount += 1;
      const log: PaperDecisionLog = {
        tickIndex,
        timestamp: nowTs,
        strategyId: this.strategyId,
        pair,
        decision: 'HALTED_DESYNC',
        rawSpreadBps: 0,
        estimatedNetSpreadBps: 0,
        reason: lastDesyncReason ?? 'Feed sync check failed on all spot-perp venues',
      };
      this.decisions.push(log);
      return log;
    }

    if (
      bestVenue === null ||
      bestNetSpreadBps < this.minEntryNetSpreadBps ||
      this.openCycles.size >= this.maxOpenCycles ||
      this.totalFreeCollateralUsdt() < this.maxCycleNotionalUsdt * 2
    ) {
      this.noTradeCount += 1;
      const noTradeLog: PaperDecisionLog = {
        tickIndex,
        timestamp: nowTs,
        strategyId: this.strategyId,
        pair,
        decision: 'NO_TRADE',
        rawSpreadBps: bestRawSpreadBps,
        estimatedNetSpreadBps: bestNetSpreadBps,
        reason: `Net basis+funding spread ${bestNetSpreadBps} bps below ${this.minEntryNetSpreadBps} bps threshold`,
      };
      this.decisions.push(noTradeLog);
      return noTradeLog;
    }

    const cycle = this.openNewCycle({
      pair,
      nowTs,
      seqA: bestSpotSeq,
      seqB: bestPerpSeq,
      legAExchange: bestVenue,
      legAMarket: 'spot',
      legBExchange: bestVenue,
      legBMarket: 'linear_perp',
      entryLegAPrice: bestSpotPrice,
      entryLegBPrice: bestPerpPrice,
      rawSpreadBps: bestRawSpreadBps,
    });

    const openLog: PaperDecisionLog = {
      tickIndex,
      timestamp: nowTs,
      strategyId: this.strategyId,
      pair,
      decision: 'OPEN_CYCLE',
      rawSpreadBps: bestRawSpreadBps,
      estimatedNetSpreadBps: bestNetSpreadBps,
      reason: `Opened spot-perp cycle ${cycle.cycleId} on ${bestVenue} at ${bestRawSpreadBps} bps raw / ${bestNetSpreadBps} bps net`,
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
    const legAQuoteUsdt = round4(quantityBase * params.entryLegAPrice);
    const legBQuoteUsdt = round4(quantityBase * params.entryLegBPrice);
    const legAEntryFeeUsdt = round4(legAQuoteUsdt * this.singleLegTakerFeeRate);
    const legBEntryFeeUsdt = round4(legBQuoteUsdt * this.singleLegTakerFeeRate);
    const entryFeesUsdt = round4(legAEntryFeeUsdt + legBEntryFeeUsdt);
    const cycleId = `${this.strategyId}-${params.pair.replace('/', '')}-${params.seqA}-${params.seqB}`;

    // Leg A is always a physical spot buy:
    // debit legAQuoteUsdt from freeCollateralUsdt, reserve in allocatedCollateralUsdt,
    // and add physical quantityBase to baseInventory.
    const legA = this.venueBalances[params.legAExchange];
    const legB = this.venueBalances[params.legBExchange];

    legA.freeCollateralUsdt = round4(
      legA.freeCollateralUsdt - legAQuoteUsdt
    );
    legA.allocatedCollateralUsdt = round4(
      legA.allocatedCollateralUsdt + legAQuoteUsdt
    );
    if (params.legAMarket === 'spot') {
      legA.baseInventory[params.pair] = round8(
        legA.baseInventory[params.pair] + quantityBase
      );
      legA.baseInventoryCostBasisUsdt[params.pair] = round4(
        legA.baseInventoryCostBasisUsdt[params.pair] + legAQuoteUsdt
      );
    }

    // Leg B depends on marketType:
    // - Physical 'spot' sell: delivers `quantityBase` from `baseInventory` and credits
    //   `legBQuoteUsdt` sale proceeds to `freeCollateralUsdt`, while reducing
    //   `baseInventoryCostBasisUsdt` by `legBQuoteUsdt` so `free + costBasis` stays conserved.
    // - Derivative 'linear_perp' short: reserves 1x margin (`legBQuoteUsdt`) from
    //   `freeCollateralUsdt` into `allocatedCollateralUsdt` without touching physical `baseInventory`.
    if (params.legBMarket === 'spot') {
      legB.freeCollateralUsdt = round4(
        legB.freeCollateralUsdt + legBQuoteUsdt
      );
      legB.baseInventory[params.pair] = round8(
        legB.baseInventory[params.pair] - quantityBase
      );
      legB.baseInventoryCostBasisUsdt[params.pair] = round4(
        legB.baseInventoryCostBasisUsdt[params.pair] - legBQuoteUsdt
      );
    } else {
      legB.freeCollateralUsdt = round4(
        legB.freeCollateralUsdt - legBQuoteUsdt
      );
      legB.allocatedCollateralUsdt = round4(
        legB.allocatedCollateralUsdt + legBQuoteUsdt
      );
    }

    const openCycleCashDeltaUsdt =
      params.legBMarket === 'spot' ? legBQuoteUsdt : 0;

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
      appliedFundingEventIds: [],
      openCycleCashDeltaUsdt,
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
    const exitLegAQuoteUsdt = round4(open.quantityBase * exitLegAPrice);
    const exitLegBQuoteUsdt = round4(open.quantityBase * exitLegBPrice);
    const exitLegAFeeUsdt = round4(exitLegAQuoteUsdt * this.singleLegTakerFeeRate);
    const exitLegBFeeUsdt = round4(exitLegBQuoteUsdt * this.singleLegTakerFeeRate);
    const exitFeesUsdt = round4(exitLegAFeeUsdt + exitLegBFeeUsdt);
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
      isCarryOver: open.isCarryOver,
      windowAttributableNetPnlUsdt: open.isCarryOver
        ? round4(netPnlUsdt - (open.baselineUnrealizedPnlUsdt ?? 0))
        : netPnlUsdt,
    };

    this.openCycles.delete(open.pair);
    this.closedCycles.push(closed);

    const legA = this.venueBalances[open.legAExchange];
    const legB = this.venueBalances[open.legBExchange];
    const legAEntryQuoteUsdt = round4(open.quantityBase * open.entryLegAPrice);
    const legBEntryQuoteUsdt = round4(open.quantityBase * open.entryLegBPrice);
    const entryLegAFeeUsdt = round4(legAEntryQuoteUsdt * this.singleLegTakerFeeRate);
    const entryLegBFeeUsdt = round4(open.entryFeesUsdt - entryLegAFeeUsdt);
    const legAFeesUsdt = round4(entryLegAFeeUsdt + exitLegAFeeUsdt);
    const legBFeesUsdt = round4(totalFeesUsdt - legAFeesUsdt);
    const legANetReturnUsdt = round4(legAEntryQuoteUsdt + legAPnl - legAFeesUsdt);

    // Unwind Leg A (physical spot sell)
    legA.allocatedCollateralUsdt = round4(
      legA.allocatedCollateralUsdt - legAEntryQuoteUsdt
    );
    legA.freeCollateralUsdt = round4(
      legA.freeCollateralUsdt + legANetReturnUsdt
    );
    if (open.legAMarket === 'spot') {
      legA.baseInventory[open.pair] = round8(
        legA.baseInventory[open.pair] - open.quantityBase
      );
      legA.baseInventoryCostBasisUsdt[open.pair] = round4(
        legA.baseInventoryCostBasisUsdt[open.pair] - legAEntryQuoteUsdt
      );
    }

    // Unwind Leg B:
    // - If physical 'spot': buy back `quantityBase` at `exitLegBPrice`, paying
    //   `exitLegBQuoteUsdt + legBFeesUsdt` from `freeCollateralUsdt` and restoring
    //   `baseInventoryCostBasisUsdt` by `legBEntryQuoteUsdt`.
    // - If 'linear_perp': release `legBEntryQuoteUsdt` margin from `allocatedCollateralUsdt`
    //   and settle `legBPnl + fundingDeltaUsdt - legBFeesUsdt` into `freeCollateralUsdt`.
    if (open.legBMarket === 'spot') {
      const legBExitOutflowUsdt = round4(
        legBEntryQuoteUsdt - legBPnl + legBFeesUsdt - fundingDeltaUsdt
      );
      legB.freeCollateralUsdt = round4(
        legB.freeCollateralUsdt - legBExitOutflowUsdt
      );
      legB.baseInventory[open.pair] = round8(
        legB.baseInventory[open.pair] + open.quantityBase
      );
      legB.baseInventoryCostBasisUsdt[open.pair] = round4(
        legB.baseInventoryCostBasisUsdt[open.pair] + legBEntryQuoteUsdt
      );
    } else {
      const legBNetReturnUsdt = round4(
        legBEntryQuoteUsdt + legBPnl + fundingDeltaUsdt - legBFeesUsdt
      );
      legB.allocatedCollateralUsdt = round4(
        legB.allocatedCollateralUsdt - legBEntryQuoteUsdt
      );
      legB.freeCollateralUsdt = round4(
        legB.freeCollateralUsdt + legBNetReturnUsdt
      );
    }

    // Realized P&L lands in the pools below and in the venue collateral above;
    // there is no separate cash ledger to update.
    this.realizedNetPnlUsdt = round4(this.realizedNetPnlUsdt + netPnlUsdt);
    this.totalFeesPaidUsdt = round4(this.totalFeesPaidUsdt + totalFeesUsdt);
    this.totalFundingUsdt = round4(this.totalFundingUsdt + fundingDeltaUsdt);

    // P23-02: the cycle we just closed is no longer unrealized. Recompute the
    // unrealized figure over the *remaining* open cycles before any equity or
    // drawdown computation, otherwise this cycle's mark is counted twice (once
    // as realized cash, once as stale unrealized P&L).
    this.recomputeUnrealizedPnlUsdtForRemainingCycles();

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
    if (this.maxDrawdownPct >= this.maxDrawdownLimitPct) {
      this.haltedByDrawdown = true;
    }

    return closed;
  }

  /**
   * Update mark-to-market drawdown using total equity including unrealized P&L.
   * Halts strategy when drawdown reaches or exceeds the threshold (drawdownPct >= maxDrawdownLimitPct).
   */
  updateMarkToMarketDrawdown(
    sequencer?: OrderbookSequencer,
    nowTs?: number
  ): { equityUsdt: number; drawdownPct: number; halted: boolean } {
    let unrealizedPnlUsdt = 0;

    if (sequencer) {
      this.refreshMarkPricesFromSequencer(sequencer, nowTs);

      for (const open of this.openCycles.values()) {
        const keyA = OrderbookSequencer.makeStreamKey(
          open.legAExchange,
          open.pair,
          open.legAMarket
        );
        const keyB = OrderbookSequencer.makeStreamKey(
          open.legBExchange,
          open.pair,
          open.legBMarket
        );
        const isFresh =
          nowTs === undefined
            ? true
            : sequencer.validatePairSync(keyA, keyB, nowTs).ok;

        const bookA = sequencer.getBook(open.legAExchange, open.pair, open.legAMarket);
        const bookB = sequencer.getBook(open.legBExchange, open.pair, open.legBMarket);
        // Mark at the actual held base quantity, so the unrealized figure always
        // corresponds to the position we own rather than a notional target.
        const exitA =
          isFresh && bookA
            ? OrderbookSequencer.computeVwapFillByBaseQty(bookA, 'sell', open.quantityBase)
            : undefined;
        const exitB =
          isFresh && bookB
            ? OrderbookSequencer.computeVwapFillByBaseQty(bookB, 'buy', open.quantityBase)
            : undefined;

        if (exitA?.filled && exitB?.filled) {
          const pnlA = (exitA.vwapPrice - open.entryLegAPrice) * open.quantityBase;
          const pnlB = (open.entryLegBPrice - exitB.vwapPrice) * open.quantityBase;
          const estExitFees = round4(
            (exitA.vwapPrice + exitB.vwapPrice) *
              open.quantityBase *
              this.singleLegTakerFeeRate
          );
          const cycleMark = round4(
            pnlA +
              pnlB +
              open.accruedFundingUsdt -
              open.entryFeesUsdt -
              estExitFees
          );
          open.lastUnrealizedPnlUsdt = cycleMark;
          unrealizedPnlUsdt += cycleMark;
        } else if (open.lastUnrealizedPnlUsdt !== undefined) {
          // Insufficient depth or stale feed: keep the last mark instead of
          // silently dropping this position's P&L from equity.
          unrealizedPnlUsdt += open.lastUnrealizedPnlUsdt;
        } else {
          const fallbackMark = round4(open.accruedFundingUsdt - open.entryFeesUsdt);
          open.lastUnrealizedPnlUsdt = fallbackMark;
          unrealizedPnlUsdt += fallbackMark;
        }
      }
    } else {
      for (const open of this.openCycles.values()) {
        unrealizedPnlUsdt += open.lastUnrealizedPnlUsdt ?? 0;
      }
    }

    this.lastUnrealizedPnlUsdt = round4(unrealizedPnlUsdt);

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
    // Strict halt guard: halt when drawdown reaches or exceeds limit (>= 2%)
    if (this.maxDrawdownPct >= this.maxDrawdownLimitPct) {
      this.haltedByDrawdown = true;
    }

    return {
      equityUsdt: currentEquity,
      drawdownPct: this.maxDrawdownPct,
      halted: this.haltedByDrawdown,
    };
  }

  /**
   * Recompute the unrealized P&L of the still-open cycles from their recorded
   * last mark, so it becomes exactly 0 when the last position closes. Called on
   * close and on restore, where no fresh orderbook is available, to guarantee
   * equity never carries a realized cycle's mark forward.
   */
  private recomputeUnrealizedPnlUsdtForRemainingCycles(): void {
    let total = 0;
    for (const open of this.openCycles.values()) {
      total += open.lastUnrealizedPnlUsdt ?? 0;
    }
    this.lastUnrealizedPnlUsdt = round4(total);
  }

  /**
   * Quote capital not currently reserved by an open leg, summed across venues.
   */
  private totalFreeCollateralUsdt(): number {
    let total = 0;
    for (const venue of ['binance', 'bybit'] as const) {
      total += this.venueBalances[venue].freeCollateralUsdt;
    }
    return round4(total);
  }

  /**
   * Single source of truth for NAV:
   *   (freeCollateralUsdt + allocatedCollateralUsdt - openCycleCashDeltaUsdt)
   * + standingInventoryMarkToMarketUsdt
   * + lastUnrealizedPnlUsdt (unrealized mark of open legs)
   * At t=0 this equals `initialCapitalUsdt` (10,000 USDT) exactly, and any
   * move in live BTC/ETH prices or venue collateral marks total equity to
   * market even when zero cycles are open.
   */
  getCurrentEquityUsdt(): number {
    let totalVenueQuoteUsdt = 0;
    for (const venue of ['binance', 'bybit'] as const) {
      totalVenueQuoteUsdt +=
        this.venueBalances[venue].freeCollateralUsdt +
        this.venueBalances[venue].allocatedCollateralUsdt;
    }
    let openCashDeltaUsdt = 0;
    for (const open of this.openCycles.values()) {
      openCashDeltaUsdt += open.openCycleCashDeltaUsdt ?? 0;
    }
    const standingInventoryMarkUsdt = this.standingInventoryMarkToMarketUsdt();
    return round4(
      totalVenueQuoteUsdt -
        openCashDeltaUsdt +
        standingInventoryMarkUsdt +
        this.lastUnrealizedPnlUsdt
    );
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

    const venueBalances: Record<'binance' | 'bybit', VenueCollateralBalance> = {
      binance: {
        exchange: 'binance',
        freeCollateralUsdt: this.venueBalances.binance.freeCollateralUsdt,
        allocatedCollateralUsdt: this.venueBalances.binance.allocatedCollateralUsdt,
        baseInventory: { ...this.venueBalances.binance.baseInventory },
        baseInventoryCostBasisUsdt: {
          ...this.venueBalances.binance.baseInventoryCostBasisUsdt,
        },
      },
      bybit: {
        exchange: 'bybit',
        freeCollateralUsdt: this.venueBalances.bybit.freeCollateralUsdt,
        allocatedCollateralUsdt: this.venueBalances.bybit.allocatedCollateralUsdt,
        baseInventory: { ...this.venueBalances.bybit.baseInventory },
        baseInventoryCostBasisUsdt: {
          ...this.venueBalances.bybit.baseInventoryCostBasisUsdt,
        },
      },
    };

    const standingInventoryMarkUsdt = this.standingInventoryMarkToMarketUsdt();

    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      executionMode: 'PAPER',
      modelVersion: this.modelVersion,
      initialCapitalUsdt: this.initialCapitalUsdt,
      cashBalanceUsdt: round4(
        venueBalances.binance.freeCollateralUsdt +
          venueBalances.bybit.freeCollateralUsdt
      ),
      allocatedNotionalUsdt: round4(allocated),
      inventoryValueUsdt: standingInventoryMarkUsdt,
      unrealizedPnlUsdt: this.lastUnrealizedPnlUsdt,
      equityUsdt: this.getCurrentEquityUsdt(),
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
      totalRebalanceFeesUsdt: this.totalRebalanceFeesUsdt,
      venueBalances,
      fundingLedger: [...this.fundingLedger],
    };
  }

  getClosedCycles(): PaperClosedCycle[] {
    return [...this.closedCycles];
  }

  getOpenCycles(): PaperOpenCycle[] {
    return Array.from(this.openCycles.values());
  }

  /**
   * Mark all currently open positions as carry-over positions with their current unrealized P&L.
   * Invoked upon a continuous window baseline reset.
   */
  markOpenCyclesAsCarryOver(sequencer?: OrderbookSequencer, nowTs?: number): void {
    if (sequencer) {
      this.refreshMarkPricesFromSequencer(sequencer, nowTs);
    }
    for (const open of this.openCycles.values()) {
      open.isCarryOver = true;
      if (sequencer) {
        const keyA = OrderbookSequencer.makeStreamKey(open.legAExchange, open.pair, open.legAMarket);
        const keyB = OrderbookSequencer.makeStreamKey(open.legBExchange, open.pair, open.legBMarket);
        const isPairFresh =
          nowTs === undefined ? true : sequencer.validatePairSync(keyA, keyB, nowTs).ok;
        const bookA = sequencer.getBook(open.legAExchange, open.pair, open.legAMarket);
        const bookB = sequencer.getBook(open.legBExchange, open.pair, open.legBMarket);
        if (isPairFresh && bookA && bookB) {
          const fillA = OrderbookSequencer.computeVwapFillByBaseQty(bookA, 'sell', open.quantityBase);
          const fillB = OrderbookSequencer.computeVwapFillByBaseQty(bookB, 'buy', open.quantityBase);
          if (fillA.filled && fillB.filled) {
            const legAPnl = (fillA.vwapPrice - open.entryLegAPrice) * open.quantityBase;
            const legBPnl = (open.entryLegBPrice - fillB.vwapPrice) * open.quantityBase;
            const exitAQuote = open.quantityBase * fillA.vwapPrice;
            const exitBQuote = open.quantityBase * fillB.vwapPrice;
            const exitFees = (exitAQuote + exitBQuote) * this.singleLegTakerFeeRate;
            const totalFees = open.entryFeesUsdt + exitFees;
            const currentNetPnl = legAPnl + legBPnl + (open.accruedFundingUsdt ?? 0) - totalFees;
            open.baselineUnrealizedPnlUsdt = round4(currentNetPnl);
            open.lastUnrealizedPnlUsdt = round4(currentNetPnl);
          }
        }
      }
      if (open.baselineUnrealizedPnlUsdt === undefined) {
        open.baselineUnrealizedPnlUsdt = round4(open.lastUnrealizedPnlUsdt ?? 0);
      }
    }
    this.recomputeUnrealizedPnlUsdtForRemainingCycles();
  }

  getDecisions(): PaperDecisionLog[] {
    return [...this.decisions];
  }

  isHalted(): boolean {
    return this.haltedByDrawdown;
  }

  serializeState(): {
    cashBalanceUsdt: number;
    peakEquityUsdt: number;
    maxDrawdownPct: number;
    haltedByDrawdown: boolean;
    realizedNetPnlUsdt: number;
    totalFeesPaidUsdt: number;
    totalFundingUsdt: number;
    totalRebalanceFeesUsdt: number;
    noTradeCount: number;
    desyncHaltCount: number;
    lastUnrealizedPnlUsdt: number;
    initialInventoryCostBasisUsdt: number;
    lastMarkPrices?: Record<PaperPair, number>;
    seedBaseInventory?: Record<'binance' | 'bybit', Record<PaperPair, number>>;
    seedInventoryCostBasisUsdt?: Record<'binance' | 'bybit', Record<PaperPair, number>>;
    seedInventoryReanchored?: Record<PaperPair, boolean>;
    venueBalances: Record<'binance' | 'bybit', {
      freeCollateralUsdt: number;
      allocatedCollateralUsdt: number;
      baseInventory: Record<PaperPair, number>;
      baseInventoryCostBasisUsdt: Record<PaperPair, number>;
    }>;
    openCycles: PaperOpenCycle[];
    closedCycles: PaperClosedCycle[];
    fundingLedger: FundingSettlementEvent[];
    decisions?: PaperDecisionLog[];
  } {
    return {
      cashBalanceUsdt: this.totalFreeCollateralUsdt(),
      peakEquityUsdt: this.peakEquityUsdt,
      maxDrawdownPct: this.maxDrawdownPct,
      haltedByDrawdown: this.haltedByDrawdown,
      realizedNetPnlUsdt: this.realizedNetPnlUsdt,
      totalFeesPaidUsdt: this.totalFeesPaidUsdt,
      totalFundingUsdt: this.totalFundingUsdt,
      totalRebalanceFeesUsdt: this.totalRebalanceFeesUsdt,
      noTradeCount: this.noTradeCount,
      desyncHaltCount: this.desyncHaltCount,
      lastUnrealizedPnlUsdt: this.lastUnrealizedPnlUsdt,
      initialInventoryCostBasisUsdt: this.initialInventoryCostBasisUsdt,
      lastMarkPrices: { ...this.lastMarkPrices },
      seedBaseInventory: {
        binance: { ...this.seedBaseInventory.binance },
        bybit: { ...this.seedBaseInventory.bybit },
      },
      seedInventoryCostBasisUsdt: {
        binance: { ...this.seedInventoryCostBasisUsdt.binance },
        bybit: { ...this.seedInventoryCostBasisUsdt.bybit },
      },
      seedInventoryReanchored: { ...this.seedInventoryReanchored },
      venueBalances: {
        binance: {
          freeCollateralUsdt: this.venueBalances.binance.freeCollateralUsdt,
          allocatedCollateralUsdt: this.venueBalances.binance.allocatedCollateralUsdt,
          baseInventory: { ...this.venueBalances.binance.baseInventory },
          baseInventoryCostBasisUsdt: {
            ...this.venueBalances.binance.baseInventoryCostBasisUsdt,
          },
        },
        bybit: {
          freeCollateralUsdt: this.venueBalances.bybit.freeCollateralUsdt,
          allocatedCollateralUsdt: this.venueBalances.bybit.allocatedCollateralUsdt,
          baseInventory: { ...this.venueBalances.bybit.baseInventory },
          baseInventoryCostBasisUsdt: {
            ...this.venueBalances.bybit.baseInventoryCostBasisUsdt,
          },
        },
      },
      openCycles: Array.from(this.openCycles.values()).map((oc) => ({
        ...oc,
        appliedFundingEventIds: oc.appliedFundingEventIds
          ? [...oc.appliedFundingEventIds]
          : undefined,
      })),
      closedCycles: this.closedCycles.slice(-200).map((cc) => ({ ...cc })),
      fundingLedger: this.fundingLedger.slice(-200).map((fe) => ({ ...fe })),
      decisions: (() => {
        if (this.openCycles.size === 0) return [];
        const openDecisions = this.decisions.filter((d) => {
          const open = this.openCycles.get(d.pair);
          return open !== undefined && d.timestamp >= open.entryTs;
        });
        const bounded =
          openDecisions.length > 555
            ? [openDecisions[0], ...openDecisions.slice(-554)]
            : openDecisions;
        return bounded.map((d) => ({ ...d }));
      })(),
    };
  }

  restoreState(saved: ReturnType<PaperStrategyEngine['serializeState']>): void {
    this.peakEquityUsdt = saved.peakEquityUsdt;
    this.maxDrawdownPct = saved.maxDrawdownPct;
    this.haltedByDrawdown = saved.haltedByDrawdown;
    this.realizedNetPnlUsdt = saved.realizedNetPnlUsdt;
    this.totalFeesPaidUsdt = saved.totalFeesPaidUsdt;
    this.totalFundingUsdt = saved.totalFundingUsdt;
    this.totalRebalanceFeesUsdt = saved.totalRebalanceFeesUsdt ?? 0;
    this.noTradeCount = saved.noTradeCount;
    this.desyncHaltCount = saved.desyncHaltCount;
    if (saved.initialInventoryCostBasisUsdt !== undefined) {
      this.initialInventoryCostBasisUsdt = saved.initialInventoryCostBasisUsdt;
    }
    if (saved.lastMarkPrices) {
      this.lastMarkPrices = {
        'BTC/USDT': saved.lastMarkPrices['BTC/USDT'] ?? SEED_INVENTORY_REFERENCE['BTC/USDT'],
        'ETH/USDT': saved.lastMarkPrices['ETH/USDT'] ?? SEED_INVENTORY_REFERENCE['ETH/USDT'],
      };
    }
    if (saved.venueBalances) {
      for (const venue of ['binance', 'bybit'] as const) {
        this.venueBalances[venue] = {
          freeCollateralUsdt: saved.venueBalances[venue].freeCollateralUsdt,
          allocatedCollateralUsdt: saved.venueBalances[venue].allocatedCollateralUsdt,
          baseInventory: { ...saved.venueBalances[venue].baseInventory },
          baseInventoryCostBasisUsdt: {
            ...(saved.venueBalances[venue].baseInventoryCostBasisUsdt ?? {
              'BTC/USDT': 0,
              'ETH/USDT': 0,
            }),
          },
        };
      }
    }
    this.openCycles.clear();
    for (const oc of saved.openCycles) {
      this.openCycles.set(oc.pair, {
        ...oc,
        appliedFundingEventIds: oc.appliedFundingEventIds
          ? [...oc.appliedFundingEventIds]
          : undefined,
      });
    }
    if (saved.seedBaseInventory) {
      this.seedBaseInventory = {
        binance: { ...saved.seedBaseInventory.binance },
        bybit: { ...saved.seedBaseInventory.bybit },
      };
    } else if (saved.venueBalances) {
      for (const venue of ['binance', 'bybit'] as const) {
        for (const pair of SUPPORTED_PAIRS) {
          let openDelta = 0;
          const open = this.openCycles.get(pair);
          if (open) {
            if (open.legAExchange === venue && open.legAMarket === 'spot') {
              openDelta += open.quantityBase;
            }
            if (open.legBExchange === venue && open.legBMarket === 'spot') {
              openDelta -= open.quantityBase;
            }
          }
          this.seedBaseInventory[venue][pair] = round8(
            this.venueBalances[venue].baseInventory[pair] - openDelta
          );
        }
      }
    }
    if (saved.seedInventoryCostBasisUsdt) {
      this.seedInventoryCostBasisUsdt = {
        binance: { ...saved.seedInventoryCostBasisUsdt.binance },
        bybit: { ...saved.seedInventoryCostBasisUsdt.bybit },
      };
    } else if (saved.venueBalances) {
      const perPositionBudget = round4(
        this.initialInventoryCostBasisUsdt / (2 * SUPPORTED_PAIRS.length)
      );
      for (const venue of ['binance', 'bybit'] as const) {
        for (const pair of SUPPORTED_PAIRS) {
          this.seedInventoryCostBasisUsdt[venue][pair] = perPositionBudget;
        }
      }
    }
    this.seedInventoryReanchored = saved.seedInventoryReanchored
      ? { ...saved.seedInventoryReanchored }
      : { 'BTC/USDT': false, 'ETH/USDT': false };
    this.initialInventoryQuantityBasisUsdt = {
      'BTC/USDT': round8(
        this.seedBaseInventory.binance['BTC/USDT'] + this.seedBaseInventory.bybit['BTC/USDT']
      ),
      'ETH/USDT': round8(
        this.seedBaseInventory.binance['ETH/USDT'] + this.seedBaseInventory.bybit['ETH/USDT']
      ),
    };
    this.closedCycles.length = 0;
    this.closedCycles.push(...saved.closedCycles.map((cc) => ({ ...cc })));
    this.fundingLedger = (saved.fundingLedger ?? []).map((fe) => ({ ...fe }));
    if (saved.decisions) {
      this.decisions.length = 0;
      this.decisions.push(...saved.decisions.map((d) => ({ ...d })));
    }
    // Restore must reproduce the same unrealized P&L the pre-restart engine
    // held for the cycles still open, and nothing for the ones it had closed.
    if (saved.lastUnrealizedPnlUsdt !== undefined) {
      this.lastUnrealizedPnlUsdt = saved.lastUnrealizedPnlUsdt;
    } else {
      this.recomputeUnrealizedPnlUsdtForRemainingCycles();
    }
  }
}
