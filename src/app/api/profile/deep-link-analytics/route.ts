/**
 * src/app/api/profile/deep-link-analytics/route.ts
 *
 * Feature F9: Batched Deep-Link Analytics Ingestion
 * Milestone M4: Mobile Wallet, Push, & Analytics
 *
 * Endpoint:
 * - POST /api/profile/deep-link-analytics: Batched analytics event ingestion
 *   Auth: Optional (supports authenticated users and anonymous mobile clients)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import { error as logError, warn as logWarn } from '@/lib/logger';

export interface DeepLinkEventInput {
  id?: string;
  kind?: string;
  route?: string;
  timestamp?: string | null;
  event_timestamp?: string | null;
  source?: 'notification' | 'direct' | string;
  metadata?: Record<string, unknown> | string | null;
}

export interface DeepLinkAnalyticsRequestBody {
  events?: DeepLinkEventInput[];
}

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
 * POST /api/profile/deep-link-analytics
 * Ingests batched deep-link analytics events from mobile clients.
 * Supports dual-mode authentication:
 * - If auth header or cookie exists, attempts to extract authenticated user id.
 * - If missing, expired, or invalid, accepts events as anonymous telemetry with userId = null.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. Optional Authentication Check
    let userId: string | null = null;
    try {
      const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
      const cookieHeader = request.headers.get('cookie') || request.headers.get('Cookie');
      if (authHeader || cookieHeader) {
        const user = await getAuthenticatedUser(request);
        if (user && user.id) {
          userId = user.id;
        }
      }
    } catch {
      // Unauthenticated / expired sessions are explicitly allowed for mobile deep-link telemetry
      userId = null;
    }

    // 2. Parse request body safely
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON request payload' },
        { status: 400 }
      );
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Request body must be a valid JSON object' },
        { status: 400 }
      );
    }

    const rawEvents = body.events;

    // Gracefully handle empty or missing events array
    if (!rawEvents || !Array.isArray(rawEvents) || rawEvents.length === 0) {
      return NextResponse.json(
        { success: true, processed: 0 },
        { status: 200 }
      );
    }

    // 3. Normalize events
    const nowIso = new Date().toISOString();
    const normalizedEvents = rawEvents.map((evt: DeepLinkEventInput) => {
      const eventId = (evt.id && typeof evt.id === 'string' && evt.id.trim().length > 0)
        ? evt.id.trim()
        : crypto.randomUUID();

      const kind = typeof evt.kind === 'string' && evt.kind.trim().length > 0
        ? evt.kind.trim()
        : 'unknown';

      // Preserve full route including query params (e.g. apex-os://billing/result?...)
      const route = typeof evt.route === 'string' && evt.route.length > 0
        ? evt.route
        : '/';

      // Fallback timestamp logic: if missing or invalid, use current ISO time
      let eventTimestamp: string;
      if (typeof evt.timestamp === 'string' && evt.timestamp.trim().length > 0) {
        eventTimestamp = evt.timestamp.trim();
      } else if (typeof evt.event_timestamp === 'string' && evt.event_timestamp.trim().length > 0) {
        eventTimestamp = evt.event_timestamp.trim();
      } else {
        eventTimestamp = nowIso;
      }

      // Safe source fallback: only 'notification' or 'direct', default to 'direct'
      const rawSource = String(evt.source || '').trim().toLowerCase();
      const source = rawSource === 'notification' ? 'notification' : 'direct';

      // Serialize metadata if object or pass through string
      let metadata: string | null = null;
      if (evt.metadata !== undefined && evt.metadata !== null) {
        if (typeof evt.metadata === 'string') {
          metadata = evt.metadata;
        } else {
          try {
            metadata = JSON.stringify(evt.metadata);
          } catch {
            metadata = null;
          }
        }
      }

      return {
        id: eventId,
        userId,
        kind,
        route,
        source,
        eventTimestamp,
        metadata,
      };
    });

    // 4. Acquire database connection
    const db = getDatabase();
    if (!db) {
      logError('[Profile:DeepLinkAnalytics] Database service unavailable');
      return NextResponse.json(
        { success: false, error: 'Database service unavailable' },
        { status: 503 }
      );
    }

    // 5. Batch insert statements
    // Compatible with MockBillingDatabase harness and migration 020
    const primarySql = "INSERT INTO deep_link_analytics (id, user_id, kind, route, source, event_timestamp, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))";

    const statements = normalizedEvents.map((evt) =>
      db.prepare(primarySql).bind(
        evt.id,
        evt.userId,
        evt.kind,
        evt.route,
        evt.source,
        evt.eventTimestamp,
        evt.metadata
      )
    );

    try {
      await db.batch(statements);
    } catch (batchError: unknown) {
      const errMsg = batchError instanceof Error ? batchError.message : String(batchError);
      // Fallback for D1 environments where migration 020 column is named 'timestamp' instead of 'event_timestamp'
      if (errMsg.includes('no such column: event_timestamp') || errMsg.includes('timestamp')) {
        logWarn('[Profile:DeepLinkAnalytics] Retrying with timestamp column');
        const fallbackSql = "INSERT INTO deep_link_analytics (id, user_id, kind, route, source, timestamp, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))";
        const fallbackStatements = normalizedEvents.map((evt) =>
          db.prepare(fallbackSql).bind(
            evt.id,
            evt.userId,
            evt.kind,
            evt.route,
            evt.source,
            evt.eventTimestamp,
            evt.metadata
          )
        );
        await db.batch(fallbackStatements);
      } else {
        throw batchError;
      }
    }

    // 6. Return response
    return NextResponse.json(
      {
        success: true,
        processed: normalizedEvents.length,
      },
      { status: 200 }
    );
  } catch (error) {
    logError('[Profile:DeepLinkAnalytics] Unhandled error during event ingestion:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal Server Error',
      },
      { status: 500 }
    );
  }
}
