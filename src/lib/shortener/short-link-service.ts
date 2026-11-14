import type { D1Database } from '@/lib/auth/adapters/d1-adapter';

export const SHORT_LINK_CODE_REGEX = /^[A-Za-z0-9_-]{4,32}$/;
export const SHORT_LINK_KV_TTL_SECONDS = 300;
export const ATTRIBUTION_COOKIE_NAME = 'apex_ref';
export const ATTRIBUTION_COOKIE_MAX_AGE_SECONDS = 2592000;

export const ALLOWLISTED_PARTNER_DOMAINS = [
  'bybit.com',
  'okx.com',
  'bitget.com',
  'kucoin.com',
  'gate.io',
] as const;

export interface ShortLinkKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface AnalyticsEngineDataset {
  writeDataPoint(event: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

export interface ShortLinkRecord {
  code: string;
  affiliate_id: string;
  deal_id: string | null;
  exchange: 'bybit' | 'okx' | 'bitget' | 'kucoin' | 'gateio';
  destination_url: string;
  campaign_tag: string | null;
  is_active: number;
}

export interface ShortLinkResolutionContext {
  db: D1Database;
  kv?: ShortLinkKVNamespace | null;
  analyticsEngine?: AnalyticsEngineDataset | null;
  clientIp: string;
  userAgent: string;
  countryCode: string | null;
}

export type ShortLinkResolveResult =
  | {
      ok: true;
      destinationUrl: string;
      cookieHeader: string;
      record: ShortLinkRecord;
      cacheHit: boolean;
      ipHash: string;
      uaHash: string;
    }
  | {
      ok: false;
      status: 400 | 403 | 404;
      error: string;
    };

const initializedShortLinkClickSchema = new WeakSet<object>();

export function isValidShortCode(code: string): boolean {
  return SHORT_LINK_CODE_REGEX.test(code);
}

export function validatePartnerDestinationUrl(rawUrl: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const isAllowlisted = ALLOWLISTED_PARTNER_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );

  return isAllowlisted ? parsed : null;
}

export async function sha256Anonymize(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function ensureShortLinkClicksTable(db: D1Database): Promise<void> {
  if (initializedShortLinkClickSchema.has(db)) {
    return;
  }
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS short_link_clicks (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        affiliate_id TEXT NOT NULL,
        deal_id TEXT,
        exchange TEXT NOT NULL,
        ip_hash TEXT NOT NULL,
        ua_hash TEXT NOT NULL,
        country_code TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    .bind()
    .run();
  initializedShortLinkClickSchema.add(db);
}

export function buildAttributionCookieHeader(code: string): string {
  return `${ATTRIBUTION_COOKIE_NAME}=${encodeURIComponent(code)}; Path=/; Max-Age=${ATTRIBUTION_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export async function resolveAndTrackShortLink(
  code: string,
  ctx: ShortLinkResolutionContext
): Promise<ShortLinkResolveResult> {
  if (!isValidShortCode(code)) {
    return { ok: false, status: 400, error: 'Invalid short link code format' };
  }

  const kvKey = `shortlink:${code}`;
  let record: ShortLinkRecord | null = null;
  let cacheHit = false;

  if (ctx.kv) {
    const cachedJson = await ctx.kv.get(kvKey);
    if (cachedJson) {
      try {
        const parsed = JSON.parse(cachedJson) as ShortLinkRecord;
        if (parsed && parsed.code === code && parsed.is_active === 1) {
          record = parsed;
          cacheHit = true;
        }
      } catch {
        record = null;
      }
    }
  }

  if (!record) {
    const row = await ctx.db
      .prepare(
        `SELECT code, affiliate_id, deal_id, exchange, destination_url, campaign_tag, is_active
         FROM short_links
         WHERE code = ? AND is_active = 1
         LIMIT 1`
      )
      .bind(code)
      .first<ShortLinkRecord>();

    if (!row) {
      return { ok: false, status: 404, error: 'Short link not found or inactive' };
    }
    record = row;
  }

  const validatedUrl = validatePartnerDestinationUrl(record.destination_url);
  if (!validatedUrl) {
    return {
      ok: false,
      status: 403,
      error: 'Destination URL rejected by partner domain allowlist policy',
    };
  }

  if (!cacheHit && ctx.kv) {
    await ctx.kv.put(kvKey, JSON.stringify(record), {
      expirationTtl: SHORT_LINK_KV_TTL_SECONDS,
    });
  }

  const [ipHash, uaHash] = await Promise.all([
    sha256Anonymize(ctx.clientIp || '0.0.0.0'),
    sha256Anonymize(ctx.userAgent || 'unknown'),
  ]);

  await ensureShortLinkClicksTable(ctx.db);
  const clickId = globalThis.crypto.randomUUID().replace(/-/g, '');

  await ctx.db
    .prepare(
      `UPDATE short_links
       SET click_count = click_count + 1, updated_at = datetime('now')
       WHERE code = ?`
    )
    .bind(record.code)
    .run();

  await ctx.db
    .prepare(
      `INSERT INTO short_link_clicks (id, code, affiliate_id, deal_id, exchange, ip_hash, ua_hash, country_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      clickId,
      record.code,
      record.affiliate_id,
      record.deal_id,
      record.exchange,
      ipHash,
      uaHash,
      ctx.countryCode
    )
    .run();

  if (ctx.analyticsEngine && typeof ctx.analyticsEngine.writeDataPoint === 'function') {
    ctx.analyticsEngine.writeDataPoint({
      blobs: [record.code, record.exchange, record.affiliate_id, ctx.countryCode ?? 'XX', ipHash],
      doubles: [1],
      indexes: [record.code],
    });
  }

  return {
    ok: true,
    destinationUrl: validatedUrl.toString(),
    cookieHeader: buildAttributionCookieHeader(record.code),
    record,
    cacheHit,
    ipHash,
    uaHash,
  };
}
