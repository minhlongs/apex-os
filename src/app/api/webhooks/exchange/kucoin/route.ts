/**
 * KuCoin Webhook Endpoint
 * Handles trade notifications from KuCoin exchange with signature verification
 *
 * POST /api/webhooks/exchange/kucoin
 *
 * KUCOIN SIGNATURE VERIFICATION:
 * ------------------------------
 * - Headers required:
 *   - KC-API-KEY: API key identifier
 *   - KC-API-SIGN: HMAC-SHA256 signature (base64 encoded)
 *   - KC-API-TIMESTAMP: Request timestamp in milliseconds
 *   - KC-API-PASSPHRASE: API passphrase (signed separately during key creation)
 *
 * - Signature calculation:
 *   sign_string = timestamp + HTTP_METHOD + REQUEST_PATH + REQUEST_BODY
 *   signature = base64(HMAC-SHA256(secret, sign_string))
 *
 * - Timestamp must be within 5 minutes of server time
 * - Passphrase is validated during API key setup (not per-request)
 *
 * WEBHOOK PAYLOAD:
 * ----------------
 * KuCoin sends order/trade events. Example payload:
 * {
 *   "topic": "order/trade",
 *   "ts": 1625098320000,
 *   "data": {
 *     "orderId": "123456",
 *     "symbol": "BTC-USDT",
 *     "side": "buy",
 *     "price": "50000",
 *     "size": "0.01",
 *     "funds": "500",
 *     "fee": "0.5",
 *     "status": "filled"
 *   }
 * }
 *
 * USER MATCHING:
 * --------------
 * KuCoin webhooks do NOT include user email directly.
 * Strategy: Require users to link their KuCoin API key in profile.
 * - Store kucoin_api_key_id in profiles.external_ids JSON
 * - Match via KC-API-KEY header to stored API key identifier
 *
 * PROCESSING FLOW:
 * ----------------
 * 1. Extract headers (KC-API-KEY, KC-API-SIGN, KC-API-TIMESTAMP)
 * 2. Verify HMAC signature using KUCOIN_WEBHOOK_SECRET
 * 3. Validate timestamp (5-minute window)
 * 4. Parse and standardize trade data
 * 5. Check replay protection
 * 6. Find matching active KuCoin deal for symbol
 * 7. Check idempotency (order already processed)
 * 8. Match user by API key (from header) -> profile
 * 9. Find associated deal click (within 30 days)
 * 10. Create conversion record
 * 11. Generate tiered earnings (30/10/5%)
 *
 * ENVIRONMENT VARIABLES:
 * ---------------------
 * KUCOIN_WEBHOOK_SECRET=your-kucoin-webhook-secret
 *
 * SECURITY:
 * ---------
 * - HMAC signature verification (required)
 * - Timestamp validation (5-minute window)
 * - Replay protection (KV-backed, 24h TTL)
 * - Structured error responses with error codes
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyKuCoinSignature, DEFAULT_TIMESTAMP_WINDOW_MS, getSignatureHeaderName, WebhookCrypto } from '@/lib/webhooks/crypto';
import { parseKuCoinWebhook } from '@/lib/webhooks/parsers';
import { isWebhookReplay, markWebhookProcessed, REPLAY_PROTECTION_TTL } from '@/lib/webhooks/replay-protection';
import { invalidateAffiliateCache } from '@/lib/cache/cache-invalidation';
import { track } from '@/lib/analytics-http';
import { extractIpAddress } from '@/lib/ratelimit/middleware';
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
import { error as logError, info as logInfo, warn as logWarn } from '@/lib/logger';

const KUCOIN_WEBHOOK_SECRET = process.env.KUCOIN_WEBHOOK_SECRET;

function validateTimestampOrError(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  requestId: string
): { valid: true } | { valid: false; response: Response } {
  const timestamp = WebhookCrypto.extractTimestamp('kucoin', headers, body);
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

async function verifyKuCoinSignatureInternal(
  rawBody: string,
  headers: Record<string, string>
): Promise<{ valid: boolean; error?: string }> {
  if (!KUCOIN_WEBHOOK_SECRET) {
    return { valid: false, error: 'KuCoin webhook secret not configured' };
  }

  const signatureHeader = headers['kc-api-sign'];
  const timestamp = headers['kc-api-timestamp'];

  if (!signatureHeader || !timestamp) {
    return { valid: false, error: 'Missing KuCoin signature headers' };
  }

  try {
    const isValid = await verifyKuCoinSignature(
      rawBody,
      signatureHeader,
      KUCOIN_WEBHOOK_SECRET,
      timestamp,
      'POST',
      '/api/webhooks/exchange/kucoin'
    );
    return { valid: isValid };
  } catch (error) {
    return { valid: false, error: `Signature verification error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function conversionExists(db: D1Database, orderId: string): Promise<boolean> {
  const result = await db.prepare('SELECT id FROM conversions WHERE exchange_trade_id = ? AND exchange_name = ? LIMIT 1').bind(orderId, 'kucoin').first<{ id: string }>();
  return !!result;
}

async function findProfileByKuCoinApiKey(
  db: D1Database,
  apiKey: string | undefined
): Promise<{ id: string; email: string; wallet_address?: string } | null> {
  if (!apiKey) return null;

  // Search in profiles.external_ids JSON for kucoin_api_key_id
  const result = await db.prepare(
    `SELECT id, email, wallet_address, external_ids
     FROM profiles
     WHERE json_extract(external_ids, '$.kucoin.api_key_id') = ?
       AND role IN ("shopper", "affiliate")
     LIMIT 1`
  ).bind(apiKey).first<{ id: string; email: string; wallet_address?: string; external_ids: string }>();

  return result || null;
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
  const cashbackPercent = deal?.cashback_percent ?? 0;
  const commissionAmount = trade.totalValue * (cashbackPercent / 100);
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
    trade.totalValue,
    trade.currency,
    commissionAmount,
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
    })
  ).run();
  return conversionId;
}

async function createEarnings(
  db: D1Database,
  conversionId: string,
  affiliateId: string,
  dealId: string,
  commissionAmount: number
): Promise<string[]> {
  const earningsIds: string[] = [];
  const tree = await db.prepare(
    `SELECT id, parent_id, level, path
     FROM referral_tree
     WHERE affiliate_id = ?
     LIMIT 1`
  ).bind(affiliateId).first<{ id: string; parent_id?: string; level: number; path?: string }>();
  if (!tree) return earningsIds;

  const level1Rate = 0.30;
  const level1Amount = commissionAmount * level1Rate;
  const earnings1Id = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  await db.prepare(`
    INSERT INTO earnings (id, conversion_id, affiliate_id, referral_tree_id, amount, commission_type, commission_rate, level, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(earnings1Id, conversionId, affiliateId, tree.id, level1Amount, 'percentage', level1Rate, 1).run();
  earningsIds.push(earnings1Id);

  if (tree.parent_id) {
    const parent = await db.prepare(
      `SELECT rt.id, p.id as affiliate_id
       FROM referral_tree rt
       JOIN profiles p ON rt.affiliate_id = p.id
       WHERE rt.id = ? AND p.role IN ("affiliate", "master_trader")
       LIMIT 1`
    ).bind(tree.parent_id).first<{ id: string; affiliate_id: string }>();
    if (parent) {
      const level2Rate = 0.10;
      const level2Amount = commissionAmount * level2Rate;
      const earnings2Id = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
      await db.prepare(`
        INSERT INTO earnings (id, conversion_id, affiliate_id, referral_tree_id, amount, commission_type, commission_rate, level, parent_earnings_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).bind(earnings2Id, conversionId, parent.affiliate_id, parent.id, level2Amount, 'percentage', level2Rate, 2, earnings1Id).run();
      earningsIds.push(earnings2Id);

      if (tree.level >= 3) {
        const grandparent = await db.prepare(
          `SELECT rt.id, p.id as affiliate_id
           FROM referral_tree rt
           JOIN profiles p ON rt.affiliate_id = p.id
           WHERE rt.id = (SELECT parent_id FROM referral_tree WHERE id = ?)
             AND p.role IN ("affiliate", "master_trader")
           LIMIT 1`
        ).bind(tree.parent_id).first<{ id: string; affiliate_id: string }>();
        if (grandparent) {
          const level3Rate = 0.05;
          const level3Amount = commissionAmount * level3Rate;
          const earnings3Id = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
          await db.prepare(`
            INSERT INTO earnings (id, conversion_id, affiliate_id, referral_tree_id, amount, commission_type, commission_rate, level, parent_earnings_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).bind(earnings3Id, conversionId, grandparent.affiliate_id, grandparent.id, level3Amount, 'percentage', level3Rate, 3, earnings2Id).run();
          earningsIds.push(earnings3Id);
        }
      }
    }
  }
  return earningsIds;
}

export async function POST(request: NextRequest): Promise<Response> {
  const startTime = Date.now();
  const requestId = `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const db = getDB();

  if (!db) {
    return NextResponse.json(
      WebhookErrorResponses.databaseError('Database not initialized', requestId),
      { status: 500 }
    );
  }

  try {
    // Read the raw bytes first: a Request body is a single-use stream, so reading
    // .json() before .text() consumes it and leaves HMAC verification over ''.
    const rawBody = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    // Verify the signature over the raw bytes BEFORE parsing. Parsing first and
    // answering malformed JSON with 200 would let an unsigned caller skip the
    // signature check entirely, so malformed bytes must answer 401 below.
    const signatureCheck = await verifyKuCoinSignatureInternal(rawBody, headers);
    if (!signatureCheck.valid) {
      logWarn(`[KuCoin Webhook] Signature verification failed:`, signatureCheck.error);
      return NextResponse.json(
        WebhookErrorResponses.invalidSignature(signatureCheck.error, requestId),
        { status: getHttpStatusCode(WebhookErrorCode.INVALID_SIGNATURE) }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        WebhookErrorResponses.invalidPayload('Invalid JSON in request body', requestId),
        { status: getHttpStatusCode(WebhookErrorCode.INVALID_PAYLOAD) }
      );
    }

    // Validate timestamp
    const timestampCheck = validateTimestampOrError(headers, body, requestId);
    if (!timestampCheck.valid) {
      logWarn(`[KuCoin Webhook] Timestamp validation failed`);
      return (timestampCheck as { valid: false; response: Response }).response;
    }

    // Parse payload
    const trade = parseKuCoinWebhook(body, headers);
    if (!trade) {
      return NextResponse.json(
        WebhookErrorResponses.invalidPayload('Could not parse KuCoin webhook payload', requestId),
        { status: getHttpStatusCode(WebhookErrorCode.INVALID_PAYLOAD) }
      );
    }

    // Replay protection
    const isReplay = await isWebhookReplay('kucoin', trade.orderId, trade.symbol);
    if (isReplay) {
      logWarn(`[KuCoin Webhook] Replay attack detected: order ${trade.orderId} for ${trade.symbol}`);
      return NextResponse.json(
        WebhookErrorResponses.potentialReplayAttack(requestId),
        { status: getHttpStatusCode(WebhookErrorCode.POTENTIAL_REPLAY_ATTACK) }
      );
    }

    // Find matching deal
    const deal = await findDeal(db, 'kucoin', trade.symbol);
    if (!deal) {
      logInfo(`[KuCoin Webhook] No active KuCoin deal found for symbol: ${trade.symbol}`);
      return NextResponse.json(
        { success: true, skipped: true, reason: 'No matching deal' },
        { status: 200 }
      );
    }

    // Check idempotency
    const exists = await conversionExists(db, trade.orderId);
    if (exists) {
      logInfo(`[KuCoin Webhook] Duplicate conversion detected: order ${trade.orderId}`);
      return NextResponse.json(
        WebhookErrorResponses.duplicateWebhook(trade.orderId, requestId),
        { status: getHttpStatusCode(WebhookErrorCode.DUPLICATE_WEBHOOK) }
      );
    }

    // Match user by KuCoin API key from header
    const apiKey = headers['kc-api-key'];
    const profile = await findProfileByKuCoinApiKey(db, apiKey);
    if (!profile) {
      logInfo(`[KuCoin Webhook] No matching user found for API key: ${apiKey?.slice(0, 8)}...`);
      return NextResponse.json(
        { success: true, skipped: true, reason: 'User not found or API key not linked' },
        { status: 200 }
      );
    }

    // Find associated deal click
    const click = await db.prepare(
      `SELECT dc.id, dc.affiliate_code, dc.affiliate_id
       FROM deal_clicks dc
       WHERE dc.deal_id = ? AND dc.affiliate_id = ? AND dc.created_at >= datetime('now', '-30 days')
       ORDER BY dc.created_at DESC LIMIT 1`
    ).bind(deal.id, profile.id).first<{ id: string; affiliate_code?: string; affiliate_id: string }>();

    // Create conversion
    const conversionId = await createConversion(db, trade, deal.id, profile.id, click?.affiliate_code, click?.id);

    // Calculate commission and create earnings
    const commissionAmount = trade.totalValue * ((deal?.cashback_percent ?? 0) / 100);
    const earningsIds = await createEarnings(db, conversionId, profile.id, deal.id, commissionAmount);

    // Track analytics
    const clientIP = extractIpAddress(request.headers);
    track('conversion', profile.id, {
      conversion_id: conversionId,
      deal_id: deal.id,
      deal_name: deal.name,
      exchange: 'kucoin',
      symbol: trade.symbol,
      volume: trade.totalValue,
      commission: commissionAmount,
      currency: trade.currency,
      affiliate_code: click?.affiliate_code,
    });

    // Mark as processed for replay protection
    await markWebhookProcessed('kucoin', trade.orderId, trade.symbol);

    // Invalidate cache for the affiliate
    void invalidateAffiliateCache(profile.id, ['affiliate-dashboard', 'affiliate-conversions']).catch(err =>
      logError('[KuCoin Webhook] Cache invalidation error:', err)
    );

    return NextResponse.json(
      { success: true, conversionId, earningsIds, message: 'KuCoin trade recorded and earnings calculated' },
      { status: 200 }
    );
  } catch (error) {
    logError('[KuCoin Webhook] Processing error:', error);
    return NextResponse.json(
      WebhookErrorResponses.processingError(error instanceof Error ? error.message : String(error), `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`),
      { status: 500 }
    );
  }
}

export async function GET(): Promise<Response> {
  return NextResponse.json({
    status: 'ok',
    exchange: 'kucoin',
    timestamp: new Date().toISOString(),
    configured: !!KUCOIN_WEBHOOK_SECRET,
    security: {
      signatureVerification: true,
      timestampValidation: { enabled: true, windowSeconds: DEFAULT_TIMESTAMP_WINDOW_MS / 1000 },
      replayProtection: { enabled: true, ttlSeconds: REPLAY_PROTECTION_TTL },
    },
  });
}
