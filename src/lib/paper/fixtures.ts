/**
 * src/lib/paper/fixtures.ts
 *
 * Deterministic 50-tick multi-exchange L2 orderbook dataset for replay
 * verification, exercising:
 *   - Cross-exchange spot entry & convergence exit ('spot-2exch')
 *   - Spot-perpetual basis + funding entry & exit ('spot-perp')
 *   - Negative net spread rejection ('NO_TRADE')
 */

import type { NormalizedOrderbook, PaperPair, ReplayTick } from './types';

function makeBook(params: {
  exchange: 'binance' | 'bybit';
  pair: PaperPair;
  marketType: 'spot' | 'linear_perp';
  sequenceId: number;
  ts: number;
  midPrice: number;
  halfSpreadBps?: number;
  fundingRateBps?: number;
}): NormalizedOrderbook {
  const halfSpread = (params.halfSpreadBps ?? 1.0) / 10000;
  const bestBid = Number((params.midPrice * (1 - halfSpread)).toFixed(2));
  const bestAsk = Number((params.midPrice * (1 + halfSpread)).toFixed(2));
  const qty = params.pair === 'BTC/USDT' ? 0.5 : 10.0;

  return {
    exchange: params.exchange,
    pair: params.pair,
    marketType: params.marketType,
    sequenceId: params.sequenceId,
    prevSequenceId: params.sequenceId - 1,
    exchangeTs: params.ts,
    receivedTs: params.ts + 15,
    bids: [
      { price: bestBid, quantity: qty },
      { price: Number((bestBid * 0.9998).toFixed(2)), quantity: qty * 2 },
    ],
    asks: [
      { price: bestAsk, quantity: qty },
      { price: Number((bestAsk * 1.0002).toFixed(2)), quantity: qty * 2 },
    ],
    fundingRateBps: params.fundingRateBps,
  };
}

/**
 * Generate a deterministic 50-tick orderbook sequence across Binance and Bybit.
 */
export function buildCanonical50TickSequence(): ReplayTick[] {
  const baseTs = 1761840000000; // Fixed epoch for 100% deterministic replay
  const ticks: ReplayTick[] = [];

  for (let i = 1; i <= 50; i++) {
    const nowTs = baseTs + i * 1000;
    const seq = 1000 + i;

    // Cycle pattern every 10 ticks:
    // - Phase 1 (mod 10 === 2): Wide cross-exchange & perp basis spread -> triggers OPEN_CYCLE
    // - Phase 2 (mod 10 === 3..5): Intermediate spread -> triggers HOLD
    // - Phase 3 (mod 10 === 6): Converged spread -> triggers CLOSE_CYCLE
    // - Other ticks: Tight spread (< 20 bps fees) -> triggers NO_TRADE
    const phase = i % 10;

    let binanceBtcSpotMid = 68000;
    let bybitBtcSpotMid = 68010; // ~1.47 bps diff -> NO_TRADE after 20 bps fees
    let binanceBtcPerpMid = 68015;
    let btcFundingBps = 1.5;

    let binanceEthSpotMid = 2600;
    let bybitEthSpotMid = 2600.5;
    let binanceEthPerpMid = 2600.8;
    let ethFundingBps = 1.2;

    if (phase === 2) {
      // Wide positive spread: ~38 bps raw (> 22 bps needed for > 2 bps net after 20 bps fees)
      bybitBtcSpotMid = 68275;
      binanceBtcPerpMid = 68265;
      btcFundingBps = 3.0;

      bybitEthSpotMid = 2610.5;
      binanceEthPerpMid = 2610.2;
      ethFundingBps = 2.5;
    } else if (phase >= 3 && phase <= 5) {
      // Holding phase: spread still elevated
      bybitBtcSpotMid = 68190;
      binanceBtcPerpMid = 68185;
      bybitEthSpotMid = 2607.5;
      binanceEthPerpMid = 2607.0;
    } else if (phase === 6) {
      // Convergence phase: prices align back at reference equilibrium so both strategies close profitably
      binanceBtcSpotMid = 68000;
      bybitBtcSpotMid = 68000;
      binanceBtcPerpMid = 68000;

      binanceEthSpotMid = 2600.0;
      bybitEthSpotMid = 2600.0;
      binanceEthPerpMid = 2600.0;
    }

    ticks.push({
      tickIndex: i,
      nowTs: nowTs + 20,
      books: [
        makeBook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: seq,
          ts: nowTs,
          midPrice: binanceBtcSpotMid,
        }),
        makeBook({
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: seq,
          ts: nowTs,
          midPrice: bybitBtcSpotMid,
        }),
        makeBook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: seq,
          ts: nowTs,
          midPrice: binanceBtcPerpMid,
          fundingRateBps: btcFundingBps,
        }),
        makeBook({
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: seq,
          ts: nowTs,
          midPrice: binanceBtcPerpMid - 2,
          fundingRateBps: btcFundingBps - 0.2,
        }),
        makeBook({
          exchange: 'binance',
          pair: 'ETH/USDT',
          marketType: 'spot',
          sequenceId: seq,
          ts: nowTs,
          midPrice: binanceEthSpotMid,
        }),
        makeBook({
          exchange: 'bybit',
          pair: 'ETH/USDT',
          marketType: 'spot',
          sequenceId: seq,
          ts: nowTs,
          midPrice: bybitEthSpotMid,
        }),
        makeBook({
          exchange: 'binance',
          pair: 'ETH/USDT',
          marketType: 'linear_perp',
          sequenceId: seq,
          ts: nowTs,
          midPrice: binanceEthPerpMid,
          fundingRateBps: ethFundingBps,
        }),
        makeBook({
          exchange: 'bybit',
          pair: 'ETH/USDT',
          marketType: 'linear_perp',
          sequenceId: seq,
          ts: nowTs,
          midPrice: binanceEthPerpMid - 0.1,
          fundingRateBps: ethFundingBps - 0.1,
        }),
      ],
    });
  }

  return ticks;
}
