/**
 * src/app/api/webhooks/telegram/route.ts
 *
 * Edge-Compatible Telegram Bot Webhook Route
 * Endpoint: POST /api/webhooks/telegram
 *
 * Features:
 * - Edge runtime (export const runtime = 'edge';)
 * - Secret token verification via X-Telegram-Bot-Api-Secret-Token header (HTTP 403 on invalid)
 * - Dispatches payload to handleTelegramUpdate for bot commands, deep linking, and inline queries
 * - Returns HTTP 200 { ok: true } on valid update processing
 */

export const runtime = 'edge';

import { NextRequest, NextResponse } from 'next/server';
import { verifyWebhookSecretToken, handleTelegramUpdate } from '@/lib/telegram/bot-service';
import { getDB, type D1Database } from '@/lib/db';
import { warn as logWarn, error as logError } from '@/lib/logger';
import type { TelegramUpdate } from '@/types/telegram';

/**
 * Resolves the webhook secret token from environment or request bindings.
 */
function getWebhookSecret(request?: Request): string {
  if (request && 'env' in request && (request as any).env?.TELEGRAM_BOT_WEBHOOK_SECRET) {
    return (request as any).env.TELEGRAM_BOT_WEBHOOK_SECRET;
  }
  const secret = process.env.TELEGRAM_BOT_WEBHOOK_SECRET;
  if (secret && secret.trim().length > 0) {
    return secret.trim();
  }
  if (process.env.NODE_ENV !== 'production') {
    return 'test_telegram_webhook_secret';
  }
  return '';
}

/**
 * Resolves the Telegram Bot API Token.
 */
function getBotToken(request?: Request): string {
  if (request && 'env' in request && (request as any).env?.TELEGRAM_BOT_TOKEN) {
    return (request as any).env.TELEGRAM_BOT_TOKEN;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token && token.trim().length > 0) {
    return token.trim();
  }
  if (process.env.NODE_ENV !== 'production') {
    return 'test_bot_token';
  }
  return '';
}

/**
 * Resolves the Cloudflare D1 database connection across edge, bindings, and local fallbacks.
 */
function getDatabase(request?: Request): D1Database | null {
  if (request && 'env' in request && (request as any).env?.DB) {
    return (request as any).env.DB;
  }
  try {
    return getDB();
  } catch {
    const globalDb = (globalThis as unknown as { DB?: D1Database }).DB;
    return globalDb || null;
  }
}

/**
 * Inbound Telegram Webhook update handler
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Verify X-Telegram-Bot-Api-Secret-Token Header
  const headerToken = request.headers.get('x-telegram-bot-api-secret-token');
  const configuredSecret = getWebhookSecret(request);

  if (!configuredSecret || !verifyWebhookSecretToken(headerToken, configuredSecret)) {
    logWarn('[Telegram Webhook] Unauthorized request: missing or invalid secret token header');
    return NextResponse.json(
      { error: 'Unauthorized: invalid secret token' },
      { status: 403 }
    );
  }

  // 2. Parse JSON update payload
  let updatePayload: TelegramUpdate;
  try {
    updatePayload = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON request payload' },
      { status: 400 }
    );
  }

  if (!updatePayload || typeof updatePayload !== 'object') {
    return NextResponse.json(
      { error: 'Missing update payload' },
      { status: 400 }
    );
  }

  // 3. Resolve Database
  const db = getDatabase(request);
  if (!db) {
    logError('[Telegram Webhook] Database connection unavailable');
    return NextResponse.json(
      { error: 'Database service unavailable' },
      { status: 503 }
    );
  }

  // 4. Resolve Bot Token
  const botToken = getBotToken(request);

  // 5. Process Telegram Update
  const result = await handleTelegramUpdate({
    update: updatePayload,
    botToken,
    db,
  });

  return NextResponse.json(
    {
      ok: true,
      action: result.actionTaken,
    },
    { status: 200 }
  );
}
