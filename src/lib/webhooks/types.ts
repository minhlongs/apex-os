/**
 * Exchange Webhook Types
 * HMAC verification and payload parsing for Binance and Bybit
 */

/**
 * Supported exchanges
 */
export type Exchange = 'binance' | 'bybit' | 'okx' | 'kucoin';

/**
 * Webhook verification result
 */
export interface VerificationResult {
  valid: boolean;
  error?: string;
  exchange: Exchange;
}

/**
 * Timestamp validation result
 */
export interface TimestampValidationResult {
  valid: boolean;
  error?: string;
  receivedAt: number;
  webhookTimestamp: number;
  ageMs: number;
}

/**
 * Replay protection result
 */
export interface ReplayProtectionResult {
  isReplay: boolean;
  error?: string;
  signatureHash: string;
}

/**
 * Structured webhook error categories
 */
export enum WebhookErrorCode {
  // Authentication errors (401)
  MISSING_SIGNATURE = 'MISSING_SIGNATURE',
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
  SIGNATURE_VERIFICATION_ERROR = 'SIGNATURE_VERIFICATION_ERROR',

  // Validation errors (400)
  MISSING_TIMESTAMP = 'MISSING_TIMESTAMP',
  TIMESTAMP_OUTSIDE_WINDOW = 'TIMESTAMP_OUTSIDE_WINDOW',
  INVALID_TIMESTAMP_FORMAT = 'INVALID_TIMESTAMP_FORMAT',

  // Replay protection errors (409)
  POTENTIAL_REPLAY_ATTACK = 'POTENTIAL_REPLAY_ATTACK',
  DUPLICATE_WEBHOOK = 'DUPLICATE_WEBHOOK',

  // Exchange errors (400/404)
  UNSUPPORTED_EXCHANGE = 'UNSUPPORTED_EXCHANGE',
  EXCHANGE_NOT_CONFIGURED = 'EXCHANGE_NOT_CONFIGURED',

  // Processing errors (400)
  INVALID_PAYLOAD = 'INVALID_PAYLOAD',
  UNSUPPORTED_EVENT_TYPE = 'UNSUPPORTED_EVENT_TYPE',

  // System errors (500)
  DATABASE_ERROR = 'DATABASE_ERROR',
  PROCESSING_ERROR = 'PROCESSING_ERROR',
}

/**
 * Structured webhook error response
 */
export interface WebhookError {
  code: WebhookErrorCode;
  message: string;
  details?: string;
  timestamp: string;
  requestId?: string;
}

/**
 * Webhook nonce entry for replay protection
 */
export interface WebhookNonce {
  id: string;
  exchange: Exchange;
  signatureHash: string;
  payloadHash: string;
  webhookTimestamp: number;
  receivedAt: string;
}

/**
 * Standardized trade data from webhook
 */
export interface BinanceWebhookPayload {
  e: string;           // Event type (e.g., "outboundAccountPosition", "executionReport")
  E: number;           // Event time
  s: string;           // Symbol
  o: {
    s: string;         // Symbol
    c: string;         // Client order ID
    S: string;         // Side (BUY/SELL)
    o: string;         // Order type
    f: string;         // Time in force
    q: string;         // Order quantity
    p: string;         // Order price
    ap: string;        // Average price
    sp: string;        // Stop price
    x: string;         // Execution type
    X: string;         // Order status
    i: number;         // Order ID
    l: string;         // Last executed quantity
    z: string;         // Cumulative filled quantity
    L: string;         // Last executed price
    n: string;         // Commission amount
    N: string;         // Commission asset
    T: number;         // Transaction time
    t: number;         // Trade ID
  };
}

/**
 * Bybit webhook payload structure
 * @see https://bybit-exchange.github.io/docs/v5/account/transaction
 */
export interface BybitWebhookPayload {
  symbol: string;
  side: string;
  size: string;
  price: string;
  avgPrice: string;
  execType: string;
  orderType: string;
  orderId: string;
  fee: string;
  feeCurrency: string;
  execTime: string;
  transactTime: string;
  tradeId: string;
  accountId: string;
  category: string;     // spot, linear, inverse, option
  type?: string;        // Buy/Sell (legacy field)
}

/**
 * OKX webhook payload structure
 * @see https://www.okx.com/docs-v5/en/#rest-api-webhooks
 */
export interface OkxWebhookPayload {
  instId: string;       // Instrument ID (e.g., "BTC-USDT")
  ordId: string;        // Order ID
  sz: string;           // Order size
  px: string;           // Order price
  fee: string;          // Fee amount
  side: string;         // "buy" or "sell"
  tradeId?: string;     // Trade ID (optional)
  ts?: string;          // Timestamp in milliseconds (optional)
  ccy?: string;         // Currency (optional)
}

/**
 * KuCoin webhook payload structure
 * @see https://docs.kucoin.com/#webhooks
 */
export interface KuCoinWebhookPayload {
  topic: string;        // e.g., "order/trade"
  ts: number;           // Timestamp in milliseconds
  data: {
    orderId: string;    // Order ID
    symbol: string;     // Trading symbol (e.g., "BTC-USDT")
    side: string;       // "buy" or "sell"
    price: string;      // Execution price
    size: string;       // Execution size
    funds: string;      // Total funds (optional)
    fee: string;        // Fee amount
    status: string;     // Order status (e.g., "filled")
    tradeId?: string;   // Trade ID (optional)
  };
}

/**
 * Standardized trade data from webhook
 */
export interface StandardizedTrade {
  exchange: Exchange;
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  totalValue: number;
  currency: string;
  fee: number;
  feeCurrency: string;
  executedAt: Date;
  userId?: string;      // Exchange user ID
  walletAddress?: string;
  email?: string;
  rawPayload: Record<string, unknown>;
}

/**
 * Webhook processing result
 */
export interface WebhookProcessResult {
  success: boolean;
  conversionId?: string;
  earningsCreated?: string[];
  error?: string;
  skipped?: boolean;    // True if duplicate webhook
}

/**
 * Webhook logger interface
 */
export interface WebhookLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * HMAC verification function signature
 */
export type VerifySignatureFn = (
  payload: string,
  signature: string,
  secret: string
) => boolean;

/**
 * Payload parser function signature
 */
export type ParsePayloadFn = (
  body: Record<string, unknown>,
  headers: Record<string, string>
) => Promise<StandardizedTrade | null>;
