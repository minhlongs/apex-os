/**
 * Exchange Webhook Endpoint
 * Handles trade notifications from Binance and Bybit with enhanced security
 *
 * POST /api/webhooks/exchange
 *
 * SUPPORTED EXCHANGES:
 * -------------------
 * 1. Binance
 *    - Signature: HMAC-SHA256 of raw request body
 *    - Header: X-Binance-Signature
 *    - Event types: executionReport (for filled trades)
 *    - Docs: https://binance-docs.github.io/apidocs/spot/en/#payload-hashing
 *
 * 2. Bybit
 *    - Signature: HMAC-SHA256 of timestamp+method+path+body
 *    - Headers: X-Bybit-HMAC-Signature, X-Bybit-Signature-Timestamp
 *    - Event types: Transaction records with execType=Trade/Fill
 *    - Docs: https://bybit-exchange.github.io/docs/v5/account/transaction
 *
 * SECURITY:
 * ---------
 * - HMAC signature verification (required)
 * - Timestamp validation (5-minute window)
 * - Replay protection (KV-backed, 24h TTL)
 * - Structured error responses with error codes
 *
 * PROCESSING FLOW:
 * ----------------
 * 1. Detect exchange
 * 2. Verify HMAC signature exists
 * 3. Verify HMAC signature validity
 * 4. Validate timestamp (5min window)
 * 5. Parse and standardize trade data
 * 6. Check replay protection
 * 7. Find matching active deal
 * 8. Check idempotency
 * 9. Match user by wallet/email
 * 10. Find associated deal click
 * 11. Create conversion record
 * 12. Generate tiered earnings (30/10/5%)
 *
 * ENVIRONMENT VARIABLES:
 * ---------------------
 * BINANCE_WEBHOOK_SECRET
 * BYBIT_WEBHOOK_SECRET
 *
 * HEALTH CHECK:
 * -------------
 * GET /api/webhooks/exchange returns security status
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyBinanceSignature, verifyBybitSignature, verifyOkxSignature, verifyKuCoinSignature, WebhookCrypto, DEFAULT_TIMESTAMP_WINDOW_MS } from '@/lib/webhooks/crypto';
import { parseWebhookPayload } from '@/lib/webhooks/parsers';
import { isWebhookReplay, markWebhookProcessed, REPLAY_PROTECTION_TTL } from '@/lib/webhooks/replay-protection';
import { invalidateAffiliateCache } from '@/lib/cache/cache-invalidation';
import { track } from '@/lib/analytics-http';
import { extractIpAddress, withRateLimit } from '@/lib/ratelimit/middleware';
import {
  WebhookErrorCode,
  type Exchange,
  type StandardizedTrade,
} from '@/lib/webhooks/types';
import {
  WebhookErrorResponses,
  getHttpStatusCode,
} from '@/lib/webhooks/error-responses';
import { getDB } from '@/lib/db';
import type { D1Database } from '@/lib/db';
import { guardLegacyExchangeWebhook } from '@/lib/compliance/legacy-route-guards';
import { commissionOf, createEarnings, toUsdc, type Commission } from '@/lib/webhooks/earnings';
import { error as logError, info as logInfo, warn as logWarn } from '@/lib/logger';

function getExchangeSecret(exchange: Exchange): string | undefined {
  switch (exchange) {
    case 'binance':
      return process.env.BINANCE_WEBHOOK_SECRET;
    case 'bybit':
      return process.env.BYBIT_WEBHOOK_SECRET;
    case 'okx':
      return process.env.OKX_WEBHOOK_SECRET;
    case 'kucoin':
      return process.env.KUCOIN_WEBHOOK_SECRET;
  }
}

function validateTimestampOrError(
  exchange: Exchange,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  requestId: string
): { valid: true } | { valid: false; response: Response } {
  const timestamp = WebhookCrypto.extractTimestamp(exchange, headers, body);
  if (timestamp === null) {
    return {
      valid: false,
      response: NextResponse.json(
        WebhookErrorResponses.missingTimestamp(requestId),
        { status: getHttpStatusCode(WebhookErrorCode.MISSING_TIMESTAMP) }
      ),
    };
  }
  const validation = WebhookCrypto.validateTimestamp(timestamp, undefined, DEFAULT_TIMESTAMP_WINDOW_MS);
  if (!validation.valid) {
    return {
      valid: false,
      response: NextResponse.json(
        WebhookErrorResponses.timestampOutsideWindow(validation.ageMs, DEFAULT_TIMESTAMP_WINDOW_MS, requestId),
        { status: getHttpStatusCode(WebhookErrorCode.TIMESTAMP_OUTSIDE_WINDOW) }
      ),
    };
  }
  return { valid: true };
}

function detectExchange(headers: Record<string, string>): Exchange | null {
  if (headers['x-binance-signature'] || headers['signature']) return 'binance';
  if (headers['x-bybit-hmac-signature']) return 'bybit';
  if (headers['ok-access-sign'] || headers['ok-access-signature']) return 'okx';
  if (headers['kc-api-sign']) return 'kucoin';
  return null;
}

async function verifyWebhookSignature(
  exchange: Exchange,
  rawBody: string,
  headers: Record<string, string>
): Promise<{ valid: boolean; error?: string }> {
  const secret = getExchangeSecret(exchange);
  if (!secret) {
    return { valid: false, error: `Webhook secret not configured for exchange: ${exchange}` };
  }
  try {
    let isValid: boolean;
    switch (exchange) {
      case 'binance':
        isValid = await verifyBinanceSignature(rawBody, headers['x-binance-signature'] || headers['signature'] || null, secret);
        break;
      case 'bybit':
        isValid = await verifyBybitSignature(rawBody, headers['x-bybit-hmac-signature'] || null, secret, headers['x-bybit-signature-timestamp'] || headers['timestamp'] || null);
        break;
      case 'okx':
        isValid = await verifyOkxSignature(rawBody, headers['ok-access-sign'] || null, secret, headers['ok-access-timestamp'] || null, 'POST', '/api/webhooks/exchange/okx');
        break;
      case 'kucoin':
        isValid = await verifyKuCoinSignature(rawBody, headers['kc-api-sign'] || null, secret, headers['kc-api-timestamp'] || null, 'POST', '/api/webhooks/exchange/kucoin');
        break;
      default:
        return { valid: false, error: `Unsupported exchange: ${exchange}` };
    }
    return { valid: isValid };
  } catch (error) {
    return { valid: false, error: `Signature verification error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function conversionExists(db: D1Database, orderId: string, exchange: Exchange): Promise<boolean> {
  const result = await db.prepare('SELECT id FROM conversions WHERE exchange_trade_id = ? AND exchange_name = ? LIMIT 1').bind(orderId, exchange).first<{ id: string }>();
  return !!result;
}

async function findProfileByIdentifier(
  db: D1Database,
  identifier: string | undefined
): Promise<{ id: string; email: string; wallet_address?: string } | null> {
  if (!identifier) return null;
  const byWallet = await db.prepare('SELECT id, email, wallet_address FROM profiles WHERE wallet_address = ? AND role IN ("shopper", "affiliate") LIMIT 1').bind(identifier).first<{ id: string; email: string; wallet_address?: string }>();
  if (byWallet) return byWallet;
  const byEmail = await db.prepare('SELECT id, email, wallet_address FROM profiles WHERE email = ? AND role IN ("shopper", "affiliate") LIMIT 1').bind(identifier).first<{ id: string; email: string; wallet_address?: string }>();
  return byEmail || null;
}

async function findDeal(
  db: D1Database,
  exchange: Exchange,
  symbol: string
): Promise<{ id: string; name: string; cashback_percent: number | null; default_commission_rate: number } | null> {
  const result = await db.prepare(
    `SELECT id, name, cashback_percent, default_commission_rate
     FROM deals
     WHERE exchange = ? AND is_active = 1
       AND (starts_at IS NULL OR starts_at <= datetime('now'))
       AND (ends_at IS NULL OR ends_at >= datetime('now'))
     LIMIT 1`
  ).bind(exchange).first<{ id: string; name: string; cashback_percent: number | null; default_commission_rate: number }>();
  return result || null;
}

async function createConversion(
  db: D1Database,
  trade: StandardizedTrade,
  dealId: string,
  affiliateId: string,
  affiliateCode?: string,
  dealClickId?: string
): Promise<string> {
  const conversionId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const deal = await findDeal(db, trade.exchange, trade.symbol);
  const commission = commissionOf(trade, deal?.cashback_percent ?? 0);
  // A payload finer than the USDC scale holds has no exact notional, so the
  // conversion is recorded without a commission. Mark it, or the row is
  // indistinguishable from a trade whose shopper had no referral tree.
  const exactNotional = commission.total !== null;
  await db.prepare(`
    INSERT INTO conversions (
      id, deal_id, deal_click_id, affiliate_code, affiliate_id,
      customer_id, order_id, exchange_trade_id, exchange_name,
      revenue, currency, commission_amount,
      commission_type, conversion_type, status, conversion_data,
      converted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    conversionId,
    dealId,
    dealClickId || null,
    affiliateCode || null,
    affiliateId,
    null,
    trade.orderId,
    trade.orderId,
    trade.exchange,
    toUsdc(commission.revenue),
    trade.currency,
    commission.total === null ? 0 : toUsdc(commission.total),
    'percentage',
    'sale',
    'approved',
    JSON.stringify({
      exchange: trade.exchange,
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price,
      fee: trade.fee,
      feeCurrency: trade.feeCurrency,
      userId: trade.userId,
      executedAt: trade.executedAt.toISOString(),
      // Present and false only when the notional could not be held exactly.
      exact_notional: exactNotional,
    })
  ).run();
  return conversionId;
}

export const POST = withRateLimit(async (request: NextRequest): Promise<Response> => {
  const startTime = Date.now();
  const requestId = `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const db = getDB();

  if (!db) {
    return NextResponse.json(WebhookErrorResponses.databaseError('Database not initialized', requestId), { status: 500 });
  }

  try {
    // Read the raw bytes first: a Request body is a single-use stream, so reading
    // .json() before .text() consumes it and leaves HMAC verification over ''.
    const rawBody = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    const exchange = detectExchange(headers);
    if (!exchange) {
      return NextResponse.json(WebhookErrorResponses.unsupportedExchange('unknown', requestId), { status: getHttpStatusCode(WebhookErrorCode.UNSUPPORTED_EXCHANGE) });
    }

    const signatureHeader = headers['x-binance-signature'] || headers['signature'] || headers['x-bybit-hmac-signature'] || headers['ok-access-sign'] || headers['kc-api-sign'];
    if (!signatureHeader) {
      return NextResponse.json(WebhookErrorResponses.missingSignature(requestId), { status: getHttpStatusCode(WebhookErrorCode.MISSING_SIGNATURE) });
    }

    // Verify the signature over the raw bytes BEFORE parsing. Parsing first and
    // answering malformed JSON with 200 would let an unsigned caller skip the
    // signature check entirely. An unsigned caller without any recognised
    // signature header is already rejected above, so what this guards is a
    // wrong-secret caller, who gets 401 here rather than reaching the parser.
    const verification = await verifyWebhookSignature(exchange, rawBody, headers);
    if (!verification.valid) {
      logWarn(`[Webhook] ${exchange} signature verification failed:`, verification.error);
      return NextResponse.json(WebhookErrorResponses.invalidSignature(verification.error, requestId), { status: getHttpStatusCode(WebhookErrorCode.INVALID_SIGNATURE) });
    }

    // Parse only now that the bytes are proven authentic. A caller who cannot
    // sign was rejected with 401 above; one who CAN sign but sent non-JSON
    // lands here and is answered 400 INVALID_PAYLOAD.
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        WebhookErrorResponses.invalidPayload('Invalid JSON in request body', requestId),
        { status: getHttpStatusCode(WebhookErrorCode.INVALID_PAYLOAD) }
      );
    }

    const timestampCheck = validateTimestampOrError(exchange, headers, body, requestId);
    if (timestampCheck.valid) {
      // Continue
    } else {
      logWarn(`[Webhook] ${exchange} timestamp validation failed`);
      return (timestampCheck as { valid: false; response: Response }).response;
    }

    const trade = await parseWebhookPayload(exchange, body, headers);
    if (!trade) {
      return NextResponse.json(WebhookErrorResponses.invalidPayload('Could not parse webhook payload', requestId), { status: getHttpStatusCode(WebhookErrorCode.INVALID_PAYLOAD) });
    }

    const rawTimestamp = WebhookCrypto.extractTimestamp(exchange, headers, body);
    const strictGuardRes = await guardLegacyExchangeWebhook({
      db,
      source: exchange,
      eventId: `${trade.symbol}:${trade.orderId}`,
      timestamp: rawTimestamp !== null ? String(rawTimestamp) : null,
      signature: signatureHeader,
      rawBody,
      secret: getExchangeSecret(exchange),
      requestPath:
        exchange === 'okx'
          ? '/api/webhooks/exchange/okx'
          : exchange === 'kucoin'
            ? '/api/webhooks/exchange/kucoin'
            : '/api/webhooks/exchange',
    });
    if (strictGuardRes) {
      return strictGuardRes;
    }

    const isReplay = await isWebhookReplay(exchange, trade.orderId, trade.symbol);
    if (isReplay) {
      logWarn(`[Webhook] Replay attack detected: ${exchange} order ${trade.orderId} for ${trade.symbol}`);
      return NextResponse.json(WebhookErrorResponses.potentialReplayAttack(requestId), { status: getHttpStatusCode(WebhookErrorCode.POTENTIAL_REPLAY_ATTACK) });
    }

    const deal = await findDeal(db, exchange, trade.symbol);
    if (!deal) {
      logInfo(`[Webhook] No active ${exchange} deal found for symbol: ${trade.symbol}`);
      return NextResponse.json({ success: true, skipped: true, reason: 'No matching deal' }, { status: 200 });
    }

    const exists = await conversionExists(db, trade.orderId, exchange);
    if (exists) {
      logInfo(`[Webhook] Duplicate conversion detected: ${exchange} order ${trade.orderId}`);
      return NextResponse.json(WebhookErrorResponses.duplicateWebhook(trade.orderId, requestId), { status: getHttpStatusCode(WebhookErrorCode.DUPLICATE_WEBHOOK) });
    }

    const identifier = trade.walletAddress || trade.email || trade.userId;
    const profile = identifier ? await findProfileByIdentifier(db, identifier) : null;
    if (!profile) {
      logInfo(`[Webhook] No matching user found for identifier: ${identifier}`);
      return NextResponse.json({ success: true, skipped: true, reason: 'User not found or account not linked' }, { status: 200 });
    }

    const click = await db.prepare(
      `SELECT dc.id, dc.affiliate_code, dc.affiliate_id
       FROM deal_clicks dc
       WHERE dc.deal_id = ? AND dc.affiliate_id = ? AND dc.created_at >= datetime('now', '-30 days')
       ORDER BY dc.created_at DESC LIMIT 1`
    ).bind(deal.id, profile.id).first<{ id: string; affiliate_code?: string; affiliate_id: string }>();

    const commission = commissionOf(trade, deal.cashback_percent ?? 0);
    if (commission.total === null) {
      // Money was not silently dropped, but it also cannot be stated exactly:
      // the payload's quantity-times-price is finer than the USDC scale holds.
      // Logged so it is distinguishable from a trade with no referral tree.
      logWarn(
        `[Webhook] ${exchange} trade ${trade.orderId} for ${trade.symbol} has no exact notional ` +
        `at the USDC scale; recording the conversion without a commission`
      );
    }
    const conversionId = await createConversion(db, trade, deal.id, profile.id, click?.affiliate_code, click?.id);
    const earningsIds = await createEarnings(db, conversionId, profile.id, commission);

    // Sprint 4: Queue commission-earned email for the primary affiliate (non-blocking)
if (click?.affiliate_id && commission.total !== null) {
  const affiliateProfile = await db.prepare('SELECT email, full_name FROM profiles WHERE id = ?').bind(click.affiliate_id).first<{ email: string; full_name: string }>();
  if (affiliateProfile?.email) {
    const { commissionEarnedTemplate } = await import('@/lib/emails/templates');
    const { getEmailQueueService } = await import('@/lib/emails/email-queue');
    const html = commissionEarnedTemplate({
      userName: affiliateProfile.full_name || 'Affiliate',
      userEmail: affiliateProfile.email,
      locale: 'en',
      baseUrl: process.env.NEXT_PUBLIC_BASE_URL || 'https://apex-os.com',
      amount: toUsdc(commission.total),
      dealName: deal.name,
      exchange,
      tradeVolume: toUsdc(commission.revenue),
      tier: 1,
      payoutStatus: 'pending',
    });
    void getEmailQueueService().enqueue({
      userId: click.affiliate_id,
      email: affiliateProfile.email,
      type: 'commission-earned',
      subject: `Commission earned: ${toUsdc(commission.total).toFixed(2)} USDC from ${exchange}`,
      html,
      text: '',
      priority: 1,
      metadata: { conversionId, dealId: deal.id, exchange, amount: toUsdc(commission.total) },
 });
  }
}

// Track analytics (fire-and-forget)
    const clientIP = extractIpAddress(request.headers);
    track('conversion', profile.id, {
      conversion_id: conversionId,
      deal_id: deal.id,
      deal_name: deal.name,
      exchange: exchange,
      symbol: trade.symbol,
      volume: toUsdc(commission.revenue),
      commission: commission.total === null ? 0 : toUsdc(commission.total),
      // Distinguishes "no exact commission was possible" from earnings_count: 0
      // with no exact-notional problem, which is a shopper with no referral tree.
      exact_notional: commission.total !== null,
      currency: trade.currency,
      affiliate_code: click?.affiliate_code,
      click_id: click?.id,
      earnings_count: earningsIds.length,
    }, clientIP).catch(() => {});

    const duration = Date.now() - startTime;

    await markWebhookProcessed(exchange, trade.orderId, trade.symbol);

    // Invalidate cache for the affiliate (async, don't block response)
    // Invalidates dashboard and conversions cache
    void invalidateAffiliateCache(profile.id, ['affiliate-dashboard', 'affiliate-conversions']).catch(err =>
      logError('[Webhook] Cache invalidation error:', err)
    );

 return NextResponse.json({ success: true, conversionId, earningsIds, message: 'Trade recorded and earnings calculated' }, { status: 200 });
  } catch (error) {
    logError('[Webhook] Processing error:', error);
    return NextResponse.json(WebhookErrorResponses.processingError(error instanceof Error ? error.message : String(error), `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`), { status: 500 });
  }
}, {
 endpointType: 'webhook'
});
export async function GET(): Promise<Response> {
  const exchanges = ['binance', 'bybit', 'okx', 'kucoin']
    .filter((ex) => Boolean(getExchangeSecret(ex as Exchange)))
    .map((ex) => ({ exchange: ex, configured: true }));
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    exchanges,
    security: {
      signatureVerification: true,
      timestampValidation: { enabled: true, windowSeconds: DEFAULT_TIMESTAMP_WINDOW_MS / 1000 },
      replayProtection: { enabled: true, ttlSeconds: REPLAY_PROTECTION_TTL, method: 'kv' },
      structuredErrors: true,
    },
  });
}
