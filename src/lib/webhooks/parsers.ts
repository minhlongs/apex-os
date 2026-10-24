/**
 * Exchange webhook parsers
 * Parse and standardize webhook payloads from different exchanges
 */

import { StandardizedTrade, Exchange } from './types';
import { MoneyError, parseDecimal, toMinorUnits, type MinorUnits } from '../money';

/**
 * Read a decimal field from a payload and convert it to exact minor units.
 *
 * Returns null when the field is absent or not a decimal, so a malformed or
 * missing field fails the parser's own required-field checks rather than
 * becoming a silently rounded number.
 */
function readDecimal(raw: unknown): MinorUnits | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  try {
    return parseDecimal(String(raw));
  } catch (error) {
    if (error instanceof MoneyError) {
      return null;
    }
    throw error;
  }
}

/**
 * Read a decimal field as a money amount at the USDC scale.
 *
 * Separate from `readDecimal` because payloads mix the two: a trade size is an
 * asset quantity at 8 decimals, while a reported notional such as KuCoin's
 * `funds` is money in the quote currency. Reading the latter at the asset scale
 * would multiply it by a hundred and pay a hundredfold commission.
 */
function readUsdcAmount(raw: unknown): MinorUnits | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  try {
    return toMinorUnits(String(raw));
  } catch (error) {
    if (error instanceof MoneyError) {
      return null;
    }
    throw error;
  }
}

/** Render an exact asset quantity as the float its consumers expect. */
function toAssetFloat(value: MinorUnits): number {
  return Number(value as bigint) / 1e8;
}

/** Render an exact USDC amount as a float in whole units. */
function toUsdcFloat(value: MinorUnits): number {
  return Number(value as bigint) / 1e6;
}

/** Decimal places the asset scale holds. */
const ASSET_DECIMALS = 8;

/** Decimal places the USDC scale holds. */
const USDC_DECIMALS = 6;

/**
 * Multiply two exact asset quantities into an exact USDC amount.
 *
 * `quantity * price` in float propagates both operands' binary error into the
 * commission every tier then draws on: 0.016667 BTC at 60000 USDT reads as
 * 1000.0200000000001 rather than 1000.02. Multiplying the exact integers gives
 * the true product, and the scale it needs is simply the number of decimals the
 * two operands carry between them -- here six plus two, not sixteen.
 *
 * Returns null when that product is finer than the USDC scale can hold, so the
 * caller leaves `totalValueMinor` unset rather than round a real amount.
 */
function exactNotional(quantity: MinorUnits, price: MinorUnits): MinorUnits | null {
  // Each operand is an integer at the asset scale, so their product is an
  // integer at twice that scale. Shifting it down to the USDC scale keeps only
  // the digits the USDC amount actually has.
  const shift = BigInt(10) ** BigInt(ASSET_DECIMALS * 2 - USDC_DECIMALS);
  const product = (quantity as bigint) * (price as bigint);

  if (product % shift !== BigInt(0)) {
    return null;
  }

  try {
    return toMinorUnits(product / shift);
  } catch {
    return null;
  }
}

/** The exact figures behind one trade's amounts. */
interface TradeAmounts {
  quantity: MinorUnits | null;
  price: MinorUnits | null;
  /** A notional the exchange reported directly, when it sends one. */
  reportedTotal: MinorUnits | null;
}

/**
 * Fill in the amount fields of a standardized trade from exact figures.
 *
 * Shared by all four exchange parsers so the relationship between the exact and
 * float representations -- and which one stands in when the payload cannot be
 * held at the USDC scale -- is written once rather than four times.
 *
 * A notional the exchange reported directly wins over the derived one: it is
 * what the venue says the trade was worth, which can differ from size times
 * price once the venue has rounded.
 */
function amountFields(amounts: TradeAmounts): {
  quantity: number;
  price: number;
  totalValue: number;
  totalValueMinor?: bigint;
} {
  const { quantity, price, reportedTotal } = amounts;

  const derived =
    quantity !== null && price !== null ? exactNotional(quantity, price) : null;
  const exact = reportedTotal ?? derived;

  return {
    quantity: quantity === null ? 0 : toAssetFloat(quantity),
    price: price === null ? 0 : toAssetFloat(price),
    totalValue: exact === null ? 0 : toUsdcFloat(exact),
    totalValueMinor: exact === null ? undefined : (exact as bigint),
  };
}

/**
 * Parse Binance webhook payload
 * @see https://binance-docs.github.io/apidocs/spot/en/#payload-hashing
 */
export function parseBinanceWebhook(
  body: Record<string, unknown>,
  headers: Record<string, string>
): StandardizedTrade | null {
  // Binance sends executionReport events for trades
  if (body.e !== 'executionReport') {
    return null;
  }

  const order = body.o as Record<string, unknown> | undefined;
  if (!order) {
    return null;
  }

  // Extract wallet address from user ID or other fields if available
  // Binance webhooks don't directly include user wallet, need to map via account
  const userId = String(body.u ?? ''); // User ID on Binance
  const symbol = String(order.s ?? '');
  const side = String(order.S ?? '');
  const quantityExact = readDecimal(String(order.l ?? order.q ?? '0'));
  const priceExact = readDecimal(String(order.L ?? order.p ?? '0'));
  const feeExact = readDecimal(String(order.n ?? '0'));
  const feeCurrency = String(order.N ?? '');
  const execTime = Number(body.E ?? order.T ?? Date.now());

  // Validate required fields. A quantity or price that cannot be read exactly
  // is refused rather than accepted as a rounded float: the exact figures are
  // what the commission is computed from, so admitting an unreadable one would
  // compute money from a value nobody checked.
  if (
    !symbol ||
    !side ||
    quantityExact === null ||
    priceExact === null ||
    (quantityExact as bigint) === BigInt(0) ||
    (priceExact as bigint) === BigInt(0)
  ) {
    return null;
  }

  return {
    exchange: 'binance',
    orderId: String(order.i ?? order.c ?? ''),
    symbol,
    side: side === 'BUY' ? 'BUY' : 'SELL',
    ...amountFields({
      quantity: quantityExact,
      price: priceExact,
      reportedTotal: null,
    }),
    currency: symbol.replace(/USDT|USDC|BUSD|BTC|ETH/g, ''), // Extract base currency
    fee: feeExact === null ? 0 : toAssetFloat(feeExact),
    feeCurrency,
    executedAt: new Date(execTime),
    userId,
    rawPayload: body,
  };
}

/**
 * Parse Bybit webhook payload
 * @see https://bybit-exchange.github.io/docs/v5/account/transaction
 */
export function parseBybitWebhook(
  body: Record<string, unknown>,
  headers: Record<string, string>
): StandardizedTrade | null {
  // Bybit sends transaction records for executed trades
  const execType = String(body.execType ?? '');
  const category = String(body.category ?? '');

  // Filter to only actual trades (not order updates)
  if (execType !== 'Trade' && execType !== 'Fill') {
    return null;
  }

  const symbol = String(body.symbol ?? '');
  const side = String(body.side ?? body.type ?? '');
  const sizeExact = readDecimal(String(body.size ?? '0'));
  const priceExact = readDecimal(String(body.avgPrice ?? body.price ?? '0'));
  const feeExact = readDecimal(String(body.fee ?? '0'));
  const feeCurrency = String(body.feeCurrency ?? '');
  const transactTime = Number(body.transactTime ?? body.execTime ?? Date.now());
  const accountId = String(body.accountId ?? '');

  // Validate required fields. An unreadable size or price is refused rather
  // than rounded into a float nobody can audit.
  if (
    !symbol ||
    !side ||
    sizeExact === null ||
    priceExact === null ||
    (sizeExact as bigint) === BigInt(0) ||
    (priceExact as bigint) === BigInt(0)
  ) {
    return null;
  }

  // Determine currency from symbol (e.g., BTCUSDT -> BTC)
  const currency = symbol.replace(/USDT|USDC|USD|PERP/g, '');

  return {
    exchange: 'bybit',
    orderId: String(body.orderId ?? ''),
    symbol,
    side: side === 'Buy' ? 'BUY' : 'SELL',
    ...amountFields({
      quantity: sizeExact,
      price: priceExact,
      reportedTotal: null,
    }),
    currency,
    fee: feeExact === null ? 0 : toAssetFloat(feeExact),
    feeCurrency,
    executedAt: new Date(transactTime),
    userId: accountId,
    rawPayload: body,
  };
}

/**
 * Parse OKX webhook payload
 * @see https://www.okx.com/docs-v5/en/#rest-api-webhooks
 */
export function parseOkxWebhook(
  body: Record<string, unknown>,
  headers: Record<string, string>
): StandardizedTrade | null {
  // OKX sends order update events
  const instId = String(body.instId ?? '');
  const ordId = String(body.ordId ?? '');
  const szExact = readDecimal(String(body.sz ?? '0'));
  const pxExact = readDecimal(String(body.px ?? '0'));
  const feeExact = readDecimal(String(body.fee ?? '0'));
  const side = String(body.side ?? '').toLowerCase();
  const timestampMs = body.ts ? Number(body.ts) : Date.now();

  // Validate required fields
  if (
    !instId ||
    !ordId ||
    szExact === null ||
    pxExact === null ||
    (szExact as bigint) === BigInt(0) ||
    (pxExact as bigint) === BigInt(0)
  ) {
    return null;
  }

  // OKX instId format: "BTC-USDT" or "BTC-USD-SWAP"
  // Extract base currency from symbol
  const symbol = instId;
  const currency = instId.split('-')[0]; // Extract "BTC" from "BTC-USDT"

  // OKX fee currency may be in a separate field or same as base currency
  // Typically fee is in the quote currency (USDT) for spot trades
  const feeCurrency = instId.split('-')[1] || 'USDT';

  return {
    exchange: 'okx',
    orderId: ordId,
    symbol,
    side: side === 'buy' ? 'BUY' : 'SELL',
    ...amountFields({
      quantity: szExact,
      price: pxExact,
      reportedTotal: null,
    }),
    currency,
    fee: feeExact === null ? 0 : toAssetFloat(feeExact),
    feeCurrency,
    executedAt: new Date(timestampMs),
    userId: undefined, // OKX does not include user identifier in webhook
    rawPayload: body,
  };
}

/**
 * Parse KuCoin webhook payload
 * @see https://docs.kucoin.com/#webhooks
 */
export function parseKuCoinWebhook(
  body: Record<string, unknown>,
  headers: Record<string, string>
): StandardizedTrade | null {
  // KuCoin sends order/trade events
  const topic = String(body.topic ?? '');
  const data = body.data as Record<string, unknown> | undefined;

  if (!data) {
    return null;
  }

  // Only process trade/filled events
  if (!topic.includes('trade') && !topic.includes('filled')) {
    return null;
  }

  const orderId = String(data.orderId ?? '');
  const symbol = String(data.symbol ?? '');
  const side = String(data.side ?? '').toLowerCase();
  const priceExact = readDecimal(String(data.price ?? '0'));
  const sizeExact = readDecimal(String(data.size ?? '0'));
  const feeExact = readDecimal(String(data.fee ?? '0'));
  const timestampMs = Number(body.ts ?? Date.now());

  // Validate required fields
  if (
    !orderId ||
    !symbol ||
    !side ||
    priceExact === null ||
    sizeExact === null ||
    (priceExact as bigint) === BigInt(0) ||
    (sizeExact as bigint) === BigInt(0)
  ) {
    return null;
  }

  // KuCoin symbol format: "BTC-USDT" (spot) or "XBTUSDM" (futures)
  // Extract base currency
  let currency: string;
  if (symbol.includes('-')) {
    // Spot format: BTC-USDT -> BTC
    currency = symbol.split('-')[0];
  } else {
    // Futures format: XBTUSDM -> XBT (convert to BTC for consistency)
    currency = symbol.replace(/USDT|USDC|USD|PERP|M$/g, '');
  }

  // Calculate total value: prefer funds if available, otherwise size * price.
  // Unlike size and price, `funds` is a money amount in the quote currency, so
  // it is read at the USDC scale -- reading it at the asset scale would
  // multiply it by a hundred and pay a hundredfold commission.
  const reportedTotal = readUsdcAmount(data.funds);

  // KuCoin fee currency typically matches the quote currency
  const feeCurrency = symbol.includes('-') ? symbol.split('-')[1] : 'USDT';

  return {
    exchange: 'kucoin',
    orderId,
    symbol,
    side: side === 'buy' ? 'BUY' : 'SELL',
    ...amountFields({ quantity: sizeExact, price: priceExact, reportedTotal }),
    currency,
    fee: feeExact === null ? 0 : toAssetFloat(feeExact),
    feeCurrency,
    executedAt: new Date(timestampMs),
    userId: undefined, // KuCoin does not include user identifier in webhook
    rawPayload: body,
  };
}

/**
 * Parse webhook based on exchange type
 */
export async function parseWebhookPayload(
  exchange: Exchange,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<StandardizedTrade | null> {
  switch (exchange) {
    case 'binance':
      return parseBinanceWebhook(body, headers);
    case 'bybit':
      return parseBybitWebhook(body, headers);
    case 'okx':
      return parseOkxWebhook(body, headers);
    case 'kucoin':
      return parseKuCoinWebhook(body, headers);
    default:
      return null;
  }
}
