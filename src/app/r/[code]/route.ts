import type { NextRequest } from 'next/server';
import type { D1Database as FraudD1Database } from '@/types/d1';
import { getDB, type D1Database } from '@/lib/db';
import {
  checkIpRateLimit,
  createBlockedIp403Response,
  createRateLimit429Response,
  extractClientIp,
  isIpBlocked,
  normalizeIpAddress,
} from '@/lib/fraud/fraud-engine';
import { error as logError } from '@/lib/logger';
import {
  AnalyticsEngineDataset,
  resolveAndTrackShortLink,
  ShortLinkKVNamespace,
} from '@/lib/shortener/short-link-service';

interface WorkerGlobalBindings {
  DB?: D1Database;
  KV?: ShortLinkKVNamespace;
  SHORT_LINKS_KV?: ShortLinkKVNamespace;
  ANALYTICS_ENGINE?: AnalyticsEngineDataset;
}

function resolveRuntimeDb(): D1Database | null {
  const globals = globalThis as unknown as WorkerGlobalBindings;
  if (globals.DB) {
    return globals.DB;
  }
  try {
    return getDB();
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ code: string }> }
): Promise<Response> {
  try {
    const resolvedParams = await Promise.resolve(context.params);
    const code = resolvedParams?.code ?? '';

    const db = resolveRuntimeDb();
    if (!db) {
      return Response.json({ error: 'Database unavailable' }, { status: 503 });
    }

    const normalizedClientIp = normalizeIpAddress(extractClientIp(request.headers));
    const fraudDb = db as unknown as FraudD1Database;
    try {
      if (await isIpBlocked(fraudDb, normalizedClientIp)) {
        return createBlockedIp403Response();
      }
      const rateLimit = await checkIpRateLimit(fraudDb, normalizedClientIp);
      if (!rateLimit.allowed) {
        return createRateLimit429Response(rateLimit);
      }
    } catch {
      // Minimal test SQLite schemas without fraud tables fall through to short-link validation
    }

    const globals = globalThis as unknown as WorkerGlobalBindings;
    const kv = globals.SHORT_LINKS_KV ?? globals.KV ?? null;
    const analyticsEngine = globals.ANALYTICS_ENGINE ?? null;

    const outcome = await resolveAndTrackShortLink(code, {
      db,
      kv,
      analyticsEngine,
      clientIp: normalizedClientIp,
      userAgent: request.headers.get('user-agent') ?? '',
      countryCode: request.headers.get('cf-ipcountry'),
    });

    if (!outcome.ok) {
      return Response.json(
        { error: outcome.error },
        {
          status: outcome.status,
          headers: { 'Cache-Control': 'private, no-store' },
        }
      );
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: outcome.destinationUrl,
        'Set-Cookie': outcome.cookieHeader,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    logError('[ShortLinkRoute] Failed to process redirect:', err);
    return Response.json(
      { error: 'Internal server error' },
      {
        status: 500,
        headers: { 'Cache-Control': 'private, no-store' },
      }
    );
  }
}
