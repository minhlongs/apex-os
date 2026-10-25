import {
  parseBinanceWebhook,
  parseBybitWebhook,
  parseOkxWebhook,
  parseKuCoinWebhook,
  parseWebhookPayload,
} from '../parsers';
import type { Exchange, StandardizedTrade } from '../types';

/**
 * The webhook parsers must hand the exact integer notional to the commission
 * calculator, not a product of two floats.
 *
 * `0.016667 BTC at 60000 USDT` reads as 1000.0200000000001 in binary floating
 * point. Multiplied out across every tier, that error is real money paid to the
 * wrong party, so `totalValueMinor` is the figure commissions are computed from
 * and the float `totalValue` is only for display. These tests hold the
 * relationship between the two: an exact notional the USDC scale cannot hold is
 * left absent rather than rounded into a plausible-looking amount, and a
 * malformed figure is refused rather than coerced to zero.
 */

/** The one trade shape all four exchanges express: a small BTC fill near 30k. */
const QUANTITY = '0.01';
const PRICE = '30000';
/** QUANTITY * PRICE in whole USDC, as exact USDC minor units. */
const EXPECTED_MINOR = 300_000_000n;

const NO_HEADERS: Record<string, string> = {};

/** The same fill as each venue writes it, so one expectation covers all four. */
const BODIES: Record<
  Exclude<Exchange, 'okx'>,
  (quantity: string, price: string) => Record<string, unknown>
> = {
  binance: (quantity, price) => ({
    e: 'executionReport',
    E: 1_700_000_000_000,
    u: 'binance-user-1',
    o: {
      s: 'BTCUSDT',
      S: 'BUY',
      i: 7,
      c: 'client-order-1',
      l: quantity,
      L: price,
      n: '0.001',
      N: 'BTC',
      T: 1_700_000_000_000,
    },
  }),
  bybit: (quantity, price) => ({
    execType: 'Trade',
    category: 'spot',
    symbol: 'BTCUSDT',
    side: 'Buy',
    size: quantity,
    avgPrice: price,
    orderId: 'bybit-order-1',
    fee: '0.001',
    feeCurrency: 'USDT',
    transactTime: 1_700_000_000_000,
    accountId: 'bybit-account-1',
  }),
  kucoin: (quantity, price) => ({
    topic: 'order/trade',
    ts: 1_700_000_000_000,
    data: {
      orderId: 'kucoin-order-1',
      symbol: 'BTC-USDT',
      side: 'buy',
      price,
      size: quantity,
      fee: '0.001',
      status: 'filled',
    },
  }),
};

/** OKX keeps its amounts at the top level rather than under a nested object. */
function okxBody(quantity: string, price: string): Record<string, unknown> {
  return {
    instId: 'BTC-USDT',
    ordId: 'okx-order-1',
    sz: quantity,
    px: price,
    fee: '0.001',
    side: 'buy',
    ts: '1700000000000',
    tradeId: 'okx-trade-1',
  };
}

/** The raw payload each venue would send for a fill of the given size. */
function rawBody(
  exchange: Exchange,
  quantity: string,
  price: string
): Record<string, unknown> {
  return exchange === 'okx' ? okxBody(quantity, price) : BODIES[exchange](quantity, price);
}

/** Parse a raw payload with the parser its venue names. */
function parseBody(exchange: Exchange, body: Record<string, unknown>): StandardizedTrade | null {
  switch (exchange) {
    case 'binance':
      return parseBinanceWebhook(body, NO_HEADERS);
    case 'bybit':
      return parseBybitWebhook(body, NO_HEADERS);
    case 'okx':
      return parseOkxWebhook(body, NO_HEADERS);
    default:
      return parseKuCoinWebhook(body, NO_HEADERS);
  }
}

/** Parse the fill a venue would send, without building the payload by hand. */
function parseFor(exchange: Exchange, quantity: string, price: string): StandardizedTrade | null {
  return parseBody(exchange, rawBody(exchange, quantity, price));
}

/**
 * Parse a payload with the fee field removed, the way a venue that charges no
 * commission on the fill sends it.
 */
function withoutFee(exchange: Exchange, quantity: string, price: string): StandardizedTrade | null {
  const body = rawBody(exchange, quantity, price);

  // Each venue tucks its fee somewhere different: Binance under the order
  // object, KuCoin under the event data, the other two at the top level.
  const nested = body.data as Record<string, unknown> | undefined;
  if (nested !== undefined) {
    delete nested.fee;
  } else if (body.o !== undefined) {
    delete (body.o as Record<string, unknown>).n;
  } else {
    delete body.fee;
  }

  return parseBody(exchange, body);
}

describe('the notional every exchange reports', () => {
  it.each(['binance', 'bybit', 'kucoin'] as const)(
    'reads %s as an exact USDC amount and a matching float',
    (exchange) => {
      const trade = parseFor(exchange, QUANTITY, PRICE);

      expect(trade).not.toBeNull();
      expect(trade?.totalValueMinor).toBe(EXPECTED_MINOR);
      expect(trade?.totalValue).toBe(300);
      expect(trade?.quantity).toBe(0.01);
      expect(trade?.price).toBe(30000);
    }
  );

  it('reads okx the same way, from its top-level amounts', () => {
    const trade = parseOkxWebhook(okxBody(QUANTITY, PRICE), NO_HEADERS);

    expect(trade?.totalValueMinor).toBe(EXPECTED_MINOR);
    expect(trade?.totalValue).toBe(300);
    expect(trade?.quantity).toBe(0.01);
    expect(trade?.price).toBe(30000);
  });

  it('routes each exchange through parseWebhookPayload to the same figures', async () => {
    const routed: readonly [Exchange, Promise<StandardizedTrade | null>][] = [
      ['binance', parseWebhookPayload('binance', BODIES.binance(QUANTITY, PRICE), NO_HEADERS)],
      ['bybit', parseWebhookPayload('bybit', BODIES.bybit(QUANTITY, PRICE), NO_HEADERS)],
      ['okx', parseWebhookPayload('okx', okxBody(QUANTITY, PRICE), NO_HEADERS)],
      ['kucoin', parseWebhookPayload('kucoin', BODIES.kucoin(QUANTITY, PRICE), NO_HEADERS)],
    ];

    for (const [exchange, pending] of routed) {
      const trade = await pending;
      expect(trade?.exchange).toBe(exchange);
      expect(trade?.totalValueMinor).toBe(EXPECTED_MINOR);
    }
  });
});

describe('a quantity the USDC scale cannot hold', () => {
  // One satoshi at a price of 1 is worth 0.00000001 USDC. Rounding that up to
  // zero, or down to a single minor unit, would state a commission the trade
  // does not support, so the notional stays absent and the quantity is still
  // reported exactly.
  it.each(['binance', 'bybit', 'kucoin'] as const)(
    'leaves %s without a notional rather than rounding one',
    (exchange) => {
      const trade = parseFor(exchange, '0.00000001', '1');

      expect(trade).not.toBeNull();
      expect(trade?.totalValueMinor).toBeUndefined();
      expect(trade?.totalValue).toBe(0);
      expect(trade?.quantity).toBe(0.00000001);
      expect(trade?.price).toBe(1);
    }
  );

  it('leaves okx without a notional for the same reason', () => {
    const trade = parseOkxWebhook(okxBody('0.00000001', '1'), NO_HEADERS);

    expect(trade?.totalValueMinor).toBeUndefined();
    expect(trade?.totalValue).toBe(0);
    expect(trade?.quantity).toBe(0.00000001);
  });

  it('refuses a quantity finer than the asset scale, rather than truncating it', () => {
    // Nine fractional digits cannot be held at the fixed asset scale. The
    // parser must refuse the trade instead of silently dropping the digit.
    const trade = parseBinanceWebhook(BODIES.binance('0.000000001', '30000'), NO_HEADERS);

    expect(trade).toBeNull();
  });

  it('refuses a price finer than the asset scale', () => {
    const trade = parseBinanceWebhook(BODIES.binance('0.01', '0.000000001'), NO_HEADERS);

    expect(trade).toBeNull();
  });
});

describe('a notional the exchange reports itself', () => {
  // KuCoin sends its own notional, and it is money in the quote currency, so it
  // is read at the USDC scale. Reading it at the asset scale would multiply it
  // by a hundred and pay a hundredfold commission. It also stands in for the
  // derived product: the venue's figure can differ from size times price.
  it('prefers reported funds over the derived product when they disagree', () => {
    const body = BODIES.kucoin(QUANTITY, PRICE);
    const data = body.data as Record<string, unknown>;
    data.funds = '499.999999';

    const trade = parseKuCoinWebhook(body, NO_HEADERS);

    expect(trade?.totalValueMinor).toBe(499_999_999n);
    expect(trade?.totalValue).toBe(499.999999);
    // The exact size and price still ride along, so the figures stay auditable.
    expect(trade?.quantity).toBe(0.01);
    expect(trade?.price).toBe(30000);
  });

  it('holds a reported funds the derived product could not express', () => {
    // A satoshi at 30000 is 0.0003 USDC, which is divisible at the USDC scale,
    // but the venue may report a notional with a digit the product would have
    // lost. The venue's figure wins either way.
    const body = BODIES.kucoin('0.00000001', '30000');
    const data = body.data as Record<string, unknown>;
    data.funds = '0.000301';

    const trade = parseKuCoinWebhook(body, NO_HEADERS);

    expect(trade?.totalValueMinor).toBe(301n);
    expect(trade?.totalValue).toBe(0.000301);
  });

  it('derives the notional from size and price when funds is absent', () => {
    const trade = parseKuCoinWebhook(BODIES.kucoin(QUANTITY, PRICE), NO_HEADERS);

    expect(trade?.totalValueMinor).toBe(EXPECTED_MINOR);
  });
});

describe('a payload missing a required amount', () => {
  it.each(['binance', 'bybit', 'okx', 'kucoin'] as const)(
    'refuses %s on a zero quantity',
    (exchange) => {
      expect(parseFor(exchange, '0', PRICE)).toBeNull();
    }
  );

  it.each(['binance', 'bybit', 'okx', 'kucoin'] as const)(
    'refuses %s on a zero price',
    (exchange) => {
      expect(parseFor(exchange, QUANTITY, '0')).toBeNull();
    }
  );

  it.each(['binance', 'bybit', 'okx', 'kucoin'] as const)(
    'refuses %s on a non-numeric quantity',
    (exchange) => {
      expect(parseFor(exchange, 'not-a-number', PRICE)).toBeNull();
    }
  );

  it.each(['binance', 'bybit', 'okx', 'kucoin'] as const)(
    'refuses %s on an empty quantity',
    (exchange) => {
      expect(parseFor(exchange, '', PRICE)).toBeNull();
    }
  );
});

describe('a payload with no fee field', () => {
  it.each(['binance', 'bybit', 'okx', 'kucoin'] as const)(
    'treats a missing fee on %s as zero and still parses the trade',
    (exchange) => {
      const trade = withoutFee(exchange, QUANTITY, PRICE);

      expect(trade).not.toBeNull();
      expect(trade?.fee).toBe(0);
      expect(trade?.totalValueMinor).toBe(EXPECTED_MINOR);
    }
  );

  it('reads a fee the exchange does report, at the asset scale', () => {
    // Binance charges a BTC fee of 0.001 in the fixture. Eight decimal places
    // of it must survive: reading the fee at the USDC scale would drop the
    // least significant digit.
    const trade = parseBinanceWebhook(BODIES.binance(QUANTITY, PRICE), NO_HEADERS);

    expect(trade?.fee).toBe(0.001);
    expect(trade?.feeCurrency).toBe('BTC');
  });
});

describe('the exact figures and their float rendering', () => {
  it.each([
    ['0.01', 0.01, '30000', 30000],
    ['0.25', 0.25, '1000', 1000],
    ['0.00000001', 0.00000001, '1', 1],
  ] as const)(
    'reports quantity %s and price %s as their exact floats',
    (rawQuantity, quantity, rawPrice, price) => {
      const trade = parseBinanceWebhook(BODIES.binance(rawQuantity, rawPrice), NO_HEADERS);

      expect(trade?.quantity).toBe(quantity);
      expect(trade?.price).toBe(price);
    }
  );

  it('holds a notional far beyond the float safe-integer range', () => {
    // 2^53 - 1 is the largest integer a double holds exactly. Above it the
    // float rendering starts skipping values, but the exact figure must still
    // be the whole amount the trade was worth.
    const trade = parseBinanceWebhook(BODIES.binance('1', '9007199254740992'), NO_HEADERS);

    expect(trade?.totalValueMinor).toBe(9007199254740992000000n);
  });
});
