import type { NextRequest } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
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

function extractRequestIp(headers: Headers): string {
  const cfIp = headers.get('cf-connecting-ip');
  if (cfIp && cfIp.trim()) {
    return cfIp.trim();
  }
  const xff = headers.get('x-forwarded-for');
  if (xff && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  const realIp = headers.get('x-real-ip');
  if (realIp && realIp.trim()) {
    return realIp.trim();
  }
  return '0.0.0.0';
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

    const globals = globalThis as unknown as WorkerGlobalBindings;
    const kv = globals.SHORT_LINKS_KV ?? globals.KV ?? null;
    const analyticsEngine = globals.ANALYTICS_ENGINE ?? null;

    const outcome = await resolveAndTrackShortLink(code, {
      db,
      kv,
      analyticsEngine,
      clientIp: extractRequestIp(request.headers),
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
