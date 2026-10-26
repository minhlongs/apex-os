/**
 * src/app/api/profile/exchange-keys/route.ts
 *
 * Profile Exchange API Key Identifier Linking
 * Links exchange API key identifiers (OKX, KuCoin, Binance, Bybit) to
 * `profiles.external_ids` JSON so exchange webhooks (`ok-access-key`,
 * `kc-api-key`) can match trades to the authenticated user profile.
 *
 * Endpoints:
 * - GET /api/profile/exchange-keys: Fetch linked exchange API key identifiers
 * - POST /api/profile/exchange-keys: Bind an exchange API key identifier
 * - DELETE /api/profile/exchange-keys: Unbind an exchange API key identifier
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import { error as logError } from '@/lib/logger';
import type { LinkedExchange, ProfileExternalIds } from '@/types/profile';

export const SUPPORTED_LINKED_EXCHANGES: readonly LinkedExchange[] = [
  'okx',
  'kucoin',
  'binance',
  'bybit',
] as const;

const API_KEY_ID_REGEX = /^[A-Za-z0-9_-]{6,128}$/;

function getDatabase(): D1Database | null {
  try {
    const db = resolveDatabase();
    if (db) return db;
  } catch {
    // Fallback below
  }
  try {
    return getDB();
  } catch {
    const globalDb = (globalThis as unknown as { DB?: D1Database }).DB;
    return globalDb || null;
  }
}

export function parseExternalIds(raw: string | null | undefined): ProfileExternalIds {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ProfileExternalIds;
    }
    return {};
  } catch {
    return {};
  }
}

export function isSupportedLinkedExchange(value: string): value is LinkedExchange {
  return (SUPPORTED_LINKED_EXCHANGES as readonly string[]).includes(value);
}

/**
 * GET /api/profile/exchange-keys
 * Returns the authenticated user's linked exchange API key identifiers.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user || !user.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const db = getDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database service unavailable' },
        { status: 503 }
      );
    }

    const row = await db
      .prepare('SELECT external_ids FROM profiles WHERE id = ?')
      .bind(user.id)
      .first<{ external_ids?: string | null }>();

    const externalIds = parseExternalIds(row?.external_ids);

    return NextResponse.json(
      {
        success: true,
        data: {
          external_ids: externalIds,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    logError('[Profile:ExchangeKeys:GET] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/profile/exchange-keys
 * Links an exchange API key identifier (`api_key_id`) into `profiles.external_ids`.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user || !user.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    const rawExchange = typeof body.exchange === 'string' ? body.exchange.trim().toLowerCase() : '';
    const rawApiKeyId =
      typeof body.api_key_id === 'string'
        ? body.api_key_id.trim()
        : typeof body.apiKeyId === 'string'
          ? body.apiKeyId.trim()
          : '';
    const rawLabel = typeof body.label === 'string' ? body.label.trim().slice(0, 64) : undefined;

    if (!rawExchange || !isSupportedLinkedExchange(rawExchange)) {
      return NextResponse.json(
        {
          success: false,
          error: `Unsupported exchange: '${rawExchange}'. Supported: ${SUPPORTED_LINKED_EXCHANGES.join(', ')}`,
        },
        { status: 400 }
      );
    }

    if (!rawApiKeyId || !API_KEY_ID_REGEX.test(rawApiKeyId)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid api_key_id format (must be 6-128 alphanumeric, dash, or underscore characters)',
        },
        { status: 400 }
      );
    }

    const db = getDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database service unavailable' },
        { status: 503 }
      );
    }

    const existing = await db
      .prepare('SELECT external_ids FROM profiles WHERE id = ?')
      .bind(user.id)
      .first<{ external_ids?: string | null }>();

    const currentExternalIds = parseExternalIds(existing?.external_ids);
    const linkedAt = new Date().toISOString();

    const updatedExternalIds: ProfileExternalIds = {
      ...currentExternalIds,
      [rawExchange]: {
        api_key_id: rawApiKeyId,
        ...(rawLabel ? { label: rawLabel } : {}),
        linked_at: linkedAt,
      },
    };

    await db
      .prepare("UPDATE profiles SET external_ids = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(updatedExternalIds), user.id)
      .run();

    return NextResponse.json(
      {
        success: true,
        data: {
          exchange: rawExchange,
          api_key_id: rawApiKeyId,
          linked_at: linkedAt,
          external_ids: updatedExternalIds,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    logError('[Profile:ExchangeKeys:POST] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/profile/exchange-keys
 * Unlinks an exchange API key identifier from `profiles.external_ids`.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user || !user.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    let rawExchange = request.nextUrl.searchParams.get('exchange')?.trim().toLowerCase() ?? '';
    if (!rawExchange) {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        if (typeof body.exchange === 'string') {
          rawExchange = body.exchange.trim().toLowerCase();
        }
      } catch {
        // Ignore empty body if query param was meant to be used
      }
    }

    if (!rawExchange || !isSupportedLinkedExchange(rawExchange)) {
      return NextResponse.json(
        {
          success: false,
          error: `Unsupported or missing exchange parameter. Supported: ${SUPPORTED_LINKED_EXCHANGES.join(', ')}`,
        },
        { status: 400 }
      );
    }

    const db = getDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database service unavailable' },
        { status: 503 }
      );
    }

    const existing = await db
      .prepare('SELECT external_ids FROM profiles WHERE id = ?')
      .bind(user.id)
      .first<{ external_ids?: string | null }>();

    const currentExternalIds = parseExternalIds(existing?.external_ids);
    delete currentExternalIds[rawExchange];

    await db
      .prepare("UPDATE profiles SET external_ids = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(currentExternalIds), user.id)
      .run();

    return NextResponse.json(
      {
        success: true,
        unlinked: rawExchange,
        data: {
          external_ids: currentExternalIds,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    logError('[Profile:ExchangeKeys:DELETE] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}
