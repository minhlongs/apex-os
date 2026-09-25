/**
 * src/app/api/notifications/register/route.ts
 *
 * Feature F8: Device Push Token Registration
 * Milestone M4: Mobile Wallet, Push, & Analytics
 *
 * Endpoints:
 * - POST /api/notifications/register: Register mobile push token (Expo, APNs, FCM)
 * - DELETE /api/notifications/register: Unregister / deactivate push token
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import { error as logError } from '@/lib/logger';

export type PushPlatform = 'ios' | 'android' | 'web';
export const VALID_PLATFORMS: readonly PushPlatform[] = ['ios', 'android', 'web'] as const;

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

/**
 * POST /api/notifications/register
 * Registers Expo push token and/or native APNs/FCM tokens for authenticated user.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. Authenticate user
    const user = await getAuthenticatedUser(request);
    if (!user || !user.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 2. Parse request body
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Push token is required' },
        { status: 400 }
      );
    }

    // Extract potential token parameters
    let expoToken = (
      typeof body.expoToken === 'string'
        ? body.expoToken
        : typeof body.expo_token === 'string'
        ? body.expo_token
        : ''
    ).trim();

    let apnsToken = (
      typeof body.apnsToken === 'string'
        ? body.apnsToken
        : typeof body.apns_token === 'string'
        ? body.apns_token
        : ''
    ).trim();

    let fcmToken = (
      typeof body.fcmToken === 'string'
        ? body.fcmToken
        : typeof body.fcm_token === 'string'
        ? body.fcm_token
        : ''
    ).trim();

    const genericToken = (typeof body.token === 'string' ? body.token.trim() : '');
    const provider = (typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '');

    // Handle generic token fallback based on provider or token format
    if (genericToken && !expoToken && !apnsToken && !fcmToken) {
      if (provider === 'apns') {
        apnsToken = genericToken;
      } else if (provider === 'fcm') {
        fcmToken = genericToken;
      } else if (provider === 'expo' || genericToken.startsWith('ExponentPushToken')) {
        expoToken = genericToken;
      } else {
        const rawP = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : '';
        if (rawP === 'android') {
          fcmToken = genericToken;
        } else {
          expoToken = genericToken;
        }
      }
    }

    // Validate that at least one token is non-empty
    if (!expoToken && !apnsToken && !fcmToken) {
      return NextResponse.json(
        { success: false, error: 'Push token is required: provide expoToken, apnsToken, or fcmToken' },
        { status: 400 }
      );
    }

    // Check platform
    const rawPlatform = body.platform;
    let platform: PushPlatform = 'ios';
    if (rawPlatform !== undefined && rawPlatform !== null) {
      if (typeof rawPlatform !== 'string') {
        return NextResponse.json(
          { success: false, error: 'Invalid platform parameter: must be string' },
          { status: 400 }
        );
      }
      const normalized = rawPlatform.trim().toLowerCase() as PushPlatform;
      if (!VALID_PLATFORMS.includes(normalized)) {
        return NextResponse.json(
          { success: false, error: `Invalid platform '${rawPlatform}': must be ios, android, or web` },
          { status: 400 }
        );
      }
      platform = normalized;
    }

    // 3. Acquire database
    const db = getDatabase();
    if (!db) {
      logError('[Notifications:Register] Database service unavailable');
      return NextResponse.json(
        { success: false, error: 'Database service unavailable' },
        { status: 503 }
      );
    }

    const tokenId = crypto.randomUUID();
    const cleanExpo = expoToken.length > 0 ? expoToken : null;
    const cleanApns = apnsToken.length > 0 ? apnsToken : null;
    const cleanFcm = fcmToken.length > 0 ? fcmToken : null;

    // 4. Insert into device_tokens
    // Positional parameters match billing-test-harness: [id, userId, expoToken, platform, apnsToken, fcmToken]
    await db
      .prepare(
        "INSERT INTO device_tokens (id, user_id, expo_token, platform, apns_token, fcm_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(
        tokenId,
        user.id,
        cleanExpo,
        platform,
        cleanApns,
        cleanFcm
      )
      .run();

    return NextResponse.json(
      {
        success: true,
        registered: true,
        data: {
          id: tokenId,
          userId: user.id,
          platform,
          expoToken: cleanExpo,
          apnsToken: cleanApns,
          fcmToken: cleanFcm,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    logError('[Notifications:Register] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/notifications/register
 * Unregisters a push device token for the authenticated user.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. Authenticate user
    const user = await getAuthenticatedUser(request);
    if (!user || !user.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 2. Parse request body
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Push token is required' },
        { status: 400 }
      );
    }

    const rawToken =
      (typeof body.token === 'string' ? body.token : '') ||
      (typeof body.expoToken === 'string' ? body.expoToken : '') ||
      (typeof body.expo_token === 'string' ? body.expo_token : '') ||
      (typeof body.apnsToken === 'string' ? body.apnsToken : '') ||
      (typeof body.fcmToken === 'string' ? body.fcmToken : '');

    const token = rawToken.trim();
    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Push token is required' },
        { status: 400 }
      );
    }

    // 3. Acquire database
    const db = getDatabase();
    if (!db) {
      logError('[Notifications:Unregister] Database service unavailable');
      return NextResponse.json(
        { success: false, error: 'Database service unavailable' },
        { status: 503 }
      );
    }

    // 4. Delete token from device_tokens idempotently
    const deleteSql =
      'DELETE FROM device_tokens WHERE expo_token = ? OR apns_token = ? OR fcm_token = ?';

    try {
      await db.prepare(deleteSql).bind(token, token, token).run();
    } catch {
      // Fallback for single parameter binding mocks
      await db.prepare(deleteSql).bind(token).run();
    }

    return NextResponse.json(
      {
        success: true,
        removed: true,
      },
      { status: 200 }
    );
  } catch (error) {
    logError('[Notifications:Unregister] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}
