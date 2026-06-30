/**
 * Exchange webhook parsers
 * Parse and standardize webhook payloads from different exchanges
 */

import { StandardizedTrade, Exchange } from './types';

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
  const quantity = parseFloat(String(order.l ?? order.q ?? '0'));
  const price = parseFloat(String(order.L ?? order.p ?? '0'));
  const fee = parseFloat(String(order.n ?? '0'));
  const feeCurrency = String(order.N ?? '');
  const execTime = Number(body.E ?? order.T ?? Date.now());

  // Validate required fields
  if (!symbol || !side || !quantity || !price) {
    return null;
  }

  return {
    exchange: 'binance',
    orderId: String(order.i ?? order.c ?? ''),
    symbol,
    side: side === 'BUY' ? 'BUY' : 'SELL',
    quantity,
    price,
    totalValue: quantity * price,
    currency: symbol.replace(/USDT|USDC|BUSD|BTC|ETH/g, ''), // Extract base currency
    fee,
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
  const size = parseFloat(String(body.size ?? '0'));
  const avgPrice = parseFloat(String(body.avgPrice ?? body.price ?? '0'));
  const fee = parseFloat(String(body.fee ?? '0'));
  const feeCurrency = String(body.feeCurrency ?? '');
  const transactTime = Number(body.transactTime ?? body.execTime ?? Date.now());
  const accountId = String(body.accountId ?? '');

  // Validate required fields
  if (!symbol || !side || !size || !avgPrice) {
    return null;
  }

  // Determine currency from symbol (e.g., BTCUSDT -> BTC)
  const currency = symbol.replace(/USDT|USDC|USD|PERP/g, '');

  return {
    exchange: 'bybit',
    orderId: String(body.orderId ?? ''),
    symbol,
    side: side === 'Buy' ? 'BUY' : 'SELL',
    quantity: size,
    price: avgPrice,
    totalValue: size * avgPrice,
    currency,
    fee,
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
  const sz = parseFloat(String(body.sz ?? '0'));
  const px = parseFloat(String(body.px ?? '0'));
  const fee = parseFloat(String(body.fee ?? '0'));
  const side = String(body.side ?? '').toLowerCase();
  const timestampMs = body.ts ? Number(body.ts) : Date.now();

  // Validate required fields
  if (!instId || !ordId || !sz || !px) {
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
    quantity: sz,
    price: px,
    totalValue: sz * px,
    currency,
    fee,
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
  const price = parseFloat(String(data.price ?? '0'));
  const size = parseFloat(String(data.size ?? '0'));
  const fee = parseFloat(String(data.fee ?? '0'));
  const funds = parseFloat(String(data.funds ?? '0')); // Total funds (alternative to size * price)
  const timestampMs = Number(body.ts ?? Date.now());

  // Validate required fields
  if (!orderId || !symbol || !side || !price || !size) {
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

  // Calculate total value: prefer funds if available, otherwise size * price
  const totalValue = funds > 0 ? funds : size * price;

  // KuCoin fee currency typically matches the quote currency
  const feeCurrency = symbol.includes('-') ? symbol.split('-')[1] : 'USDT';

  return {
    exchange: 'kucoin',
    orderId,
    symbol,
    side: side === 'buy' ? 'BUY' : 'SELL',
    quantity: size,
    price,
    totalValue,
    currency,
    fee,
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
