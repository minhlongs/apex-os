/**
 * src/lib/paper/worker-do.ts
 *
 * Cloudflare Durable Object implementation for the Greenfield Paper Trading Engine.
 * Coordinates OrderbookSequencer, two independent 10,000 USDT Strategy Engines
 * ('spot-2exch' and 'spot-perp'), and the Immutable PaperJournal.
 */

import type { D1Database } from '../db';
import { buildCanonical50TickSequence } from './fixtures';
import { PaperJournal, type R2BucketLike } from './journal';
import { OrderbookSequencer } from './orderbook-sequencer';
import { PaperReplayEngine } from './replay';
import { PaperStrategyEngine } from './strategy-engine';
import type {
  NormalizedOrderbook,
  PaperClosedCycle,
  PaperPair,
  PaperStrategyId,
  PaperStrategySnapshot,
} from './types';

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

export interface DurableObjectEnvLike {
  DB?: D1Database;
  STORAGE?: R2BucketLike;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

const PAIRS: PaperPair[] = ['BTC/USDT', 'ETH/USDT'];
const STRATEGY_IDS: PaperStrategyId[] = ['spot-2exch', 'spot-perp'];

export class PaperTradingDurableObject {
  private readonly state: DurableObjectStateLike;
  private readonly env?: DurableObjectEnvLike;
  private readonly sequencer: OrderbookSequencer;
  private readonly strategies: Map<PaperStrategyId, PaperStrategyEngine>;
  private readonly journal: PaperJournal;
  private tickCounter = 0;
  private readonly modelVersion = 'paper-v1.0.0';
  private initialized = false;

  constructor(state: DurableObjectStateLike, env?: DurableObjectEnvLike) {
    this.state = state;
    this.env = env;
    this.sequencer = new OrderbookSequencer({
      maxFeedAgeMs: 1000,
      maxClockSkewMs: 250,
    });
    this.strategies = new Map<PaperStrategyId, PaperStrategyEngine>();
    for (const sid of STRATEGY_IDS) {
      this.strategies.set(
        sid,
        new PaperStrategyEngine({
          strategyId: sid,
          modelVersion: this.modelVersion,
          initialCapitalUsdt: 10000,
        })
      );
    }
    this.journal = new PaperJournal();
  }

  async ensureRestored(): Promise<void> {
    if (this.initialized) return;
    const storedTick = await this.state.storage.get<number>('last_tick_counter');
    if (storedTick !== undefined) {
      this.tickCounter = storedTick;
    }
    const storedCycles = await this.state.storage.get<PaperClosedCycle[]>('paper_closed_cycles');
    if (storedCycles && Array.isArray(storedCycles)) {
      for (const cycle of storedCycles) {
        await this.journal.recordClosedCycle(cycle, this.env?.DB, this.env?.STORAGE);
      }
    } else if (this.env?.DB) {
      // Fallback: restore from immutable D1 paper_trade_journal
      await this.journal.loadFromD1(this.env.DB);
    }
    for (const sid of STRATEGY_IDS) {
      const savedStrategyState = await this.state.storage.get<
        ReturnType<PaperStrategyEngine['serializeState']>
      >(`strategy_state_${sid}`);
      if (savedStrategyState) {
        this.strategies.get(sid)?.restoreState(savedStrategyState);
      }
    }
    this.initialized = true;
  }

  async ingestOrderbook(
    book: NormalizedOrderbook,
    nowTs: number = book.receivedTs
  ): Promise<{
    streamState: ReturnType<OrderbookSequencer['ingest']>;
    snapshots: Record<PaperStrategyId, PaperStrategySnapshot>;
  }> {
    await this.ensureRestored();
    this.tickCounter += 1;
    const streamState = this.sequencer.ingest(book, nowTs);

    for (const engine of this.strategies.values()) {
      const prevClosedCount = engine.getClosedCycles().length;
      const prevClosedKeys = new Set(engine.getClosedCycles().map((c) => c.idempotencyKey));
      engine.evaluatePair(
        this.sequencer,
        book.pair,
        this.tickCounter,
        nowTs,
        'do-live-stream'
      );
      const currentClosed = engine.getClosedCycles();
      if (currentClosed.length > prevClosedCount) {
        for (const c of currentClosed) {
          if (!prevClosedKeys.has(c.idempotencyKey)) {
            await this.journal.recordClosedCycle(c, this.env?.DB, this.env?.STORAGE);
          }
        }
      }
      await this.journal.saveStrategySnapshot(engine.getSnapshot(), this.env?.DB);
      await this.state.storage.put(
        `strategy_state_${engine.strategyId}`,
        engine.serializeState()
      );
    }

    await this.state.storage.put('last_tick_counter', this.tickCounter);
    await this.state.storage.put('paper_closed_cycles', this.journal.getClosedCycles());

    return {
      streamState,
      snapshots: this.getStrategySnapshots(),
    };
  }

  async resyncStream(
    book: NormalizedOrderbook,
    nowTs: number = book.receivedTs
  ): Promise<ReturnType<OrderbookSequencer['resyncSnapshot']>> {
    await this.ensureRestored();
    return this.sequencer.resyncSnapshot(book, nowTs);
  }

  getStrategySnapshots(): Record<PaperStrategyId, PaperStrategySnapshot> {
    return {
      'spot-2exch': this.strategies.get('spot-2exch')!.getSnapshot(),
      'spot-perp': this.strategies.get('spot-perp')!.getSnapshot(),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname.endsWith('/ingest')) {
      const payload = (await request.json()) as {
        book: NormalizedOrderbook;
        nowTs?: number;
      };
      const result = await this.ingestOrderbook(payload.book, payload.nowTs);
      return Response.json({
        executionMode: 'PAPER',
        ...result,
      });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/resync')) {
      const payload = (await request.json()) as {
        book: NormalizedOrderbook;
        nowTs?: number;
      };
      const streamState = await this.resyncStream(payload.book, payload.nowTs);
      return Response.json({
        executionMode: 'PAPER',
        streamState,
      });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/replay-verify')) {
      const ticks = buildCanonical50TickSequence();
      const verification = PaperReplayEngine.verifyDeterminism(ticks, this.modelVersion);
      return Response.json({
        executionMode: 'PAPER',
        modelVersion: this.modelVersion,
        ...verification,
      });
    }

    // Default GET /status
    await this.ensureRestored();
    const snapshots = this.getStrategySnapshots();
    return Response.json({
      executionMode: 'PAPER',
      isLive: false,
      dataSource: 'DURABLE_OBJECT_PERSISTED',
      modelVersion: this.modelVersion,
      tickCounter: this.tickCounter,
      pairs: PAIRS,
      sequencerStates: this.sequencer.getAllStates(),
      strategies: snapshots,
      closedCycles: this.journal.getClosedCycles(),
    });
  }
}
