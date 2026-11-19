/**
 * Clean-Room Affiliate Short-Links API (/r/:code)
 *
 * Endpoints:
 * - GET   /api/affiliate/short-links -> Owner-scoped list of short links ordered by `created_at DESC`
 * - POST  /api/affiliate/short-links -> Create a validated `/r/:code` partner short link
 * - PATCH /api/affiliate/short-links -> Toggle `is_active` on a short link owned by the caller
 *
 * Security & Compliance Invariants:
 * - Strict anti-IDOR owner scoping (`WHERE affiliate_id = user.id`)
 * - Approved 5-exchange clean-room allowlist (`bybit`, `okx`, `bitget`, `kucoin`, `gateio`)
 * - HTTPS allowlisted partner domain validation via `validatePartnerDestinationUrl`
 * - Zero secret leakage via `sanitizeApiErrorResponse`
 */

import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { D1Database } from '@/lib/db';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import { assertNoIdor, sanitizeApiErrorResponse } from '@/lib/auth/passkey-step-up';
import { resolveCanonicalAppOrigin } from '@/config/canonical-origin';
import {
  buildD1RateLimitResponse,
  enforcePersistentD1RateLimit,
  extractTrustedClientIp,
} from '@/lib/security/d1-rate-limiter';
import {
  buildCsrfForbiddenResponse,
  verifyTrustedMutationOrigin,
} from '@/lib/security/http-hardening';
import {
  isValidShortCode,
  validatePartnerDestinationUrl,
} from '@/lib/shortener/short-link-service';

const APPROVED_SHORT_LINK_EXCHANGES = [
  'bybit',
  'okx',
  'bitget',
  'kucoin',
  'gateio',
] as const;

export type ApprovedShortLinkExchange = (typeof APPROVED_SHORT_LINK_EXCHANGES)[number];

const EXCHANGE_EXPECTED_DOMAIN: Record<ApprovedShortLinkExchange, string> = {
  bybit: 'bybit.com',
  okx: 'okx.com',
  bitget: 'bitget.com',
  kucoin: 'kucoin.com',
  gateio: 'gate.io',
};

const EXCHANGE_DEFAULT_DESTINATION: Record<ApprovedShortLinkExchange, string> = {
  bybit: 'https://www.bybit.com/invite',
  okx: 'https://www.okx.com/join',
  bitget: 'https://www.bitget.com/referral',
  kucoin: 'https://www.kucoin.com/r',
  gateio: 'https://www.gate.io/signup',
};

const CAMPAIGN_TAG_REGEX = /^[A-Za-z0-9_.: -]{1,64}$/;
const SHORT_CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface ShortLinkDbRow {
  code: string;
  affiliate_id: string;
  exchange: ApprovedShortLinkExchange;
  destination_url: string;
  campaign_tag: string | null;
  is_active: number;
  click_count: number;
  created_at: string;
}

export interface AffiliateShortLinkItem {
  code: string;
  shortUrl: string;
  exchange: ApprovedShortLinkExchange;
  exchangeMode: 'LIVE' | 'SHADOW_30D';
  destinationUrl: string;
  campaignTag: string | null;
  isActive: boolean;
  clickCount: number;
  createdAt: string;
}

function isApprovedExchange(value: unknown): value is ApprovedShortLinkExchange {
  return (
    typeof value === 'string' &&
    (APPROVED_SHORT_LINK_EXCHANGES as readonly string[]).includes(value.trim().toLowerCase())
  );
}

function generateRandomShortCode(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SHORT_CODE_ALPHABET[bytes[i] % SHORT_CODE_ALPHABET.length];
  }
  return out;
}

function resolveBaseOrigin(request: NextRequest): string {
  // Derive from validated request URL origin (never `x-forwarded-host` to prevent host-header injection),
  // falling back to the canonical owned Worker origin.
  try {
    const urlOrigin = new URL(request.url).origin;
    if (urlOrigin && urlOrigin !== 'null') {
      return urlOrigin;
    }
  } catch {
    // Fall back to canonical origin
  }
  return resolveCanonicalAppOrigin();
}

async function resolveExchangeModes(
  db: D1Database
): Promise<Record<ApprovedShortLinkExchange, 'LIVE' | 'SHADOW_30D'>> {
  const modes: Record<ApprovedShortLinkExchange, 'LIVE' | 'SHADOW_30D'> = {
    bybit: 'LIVE',
    okx: 'LIVE',
    bitget: 'LIVE',
    kucoin: 'SHADOW_30D',
    gateio: 'SHADOW_30D',
  };

  try {
    const rows = await db
      .prepare(
        `SELECT flag_key, flag_value
         FROM system_runtime_flags
         WHERE flag_key IN ('PARTNER_KUCOIN_LIVE', 'PARTNER_GATEIO_LIVE')`
      )
      .all<{ flag_key: string; flag_value: string }>();

    for (const row of rows.results ?? []) {
      if (row.flag_key === 'PARTNER_KUCOIN_LIVE' && row.flag_value === 'true') {
        modes.kucoin = 'LIVE';
      }
      if (row.flag_key === 'PARTNER_GATEIO_LIVE' && row.flag_value === 'true') {
        modes.gateio = 'LIVE';
      }
    }
  } catch {
    // Shadow-gate defaults apply when runtime flags are unavailable
  }

  return modes;
}

function extractRequestedOwnerParam(searchParams: URLSearchParams): string | null {
  const candidates = [
    searchParams.get('affiliate_id'),
    searchParams.get('affiliateId'),
    searchParams.get('profile_id'),
    searchParams.get('profileId'),
    searchParams.get('user_id'),
    searchParams.get('userId'),
  ];
  for (const val of candidates) {
    if (val && val.trim().length > 0) {
      return val.trim();
    }
  }
  return null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const db = resolveDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, code: 'DB_UNAVAILABLE', error: 'Database unavailable' },
        { status: 503 }
      );
    }

    const user = await getAuthenticatedUser(request, db);
    if (!user?.id) {
      return NextResponse.json(
        { success: false, code: 'UNAUTHENTICATED', error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const url = new URL(request.url);
    const requestedOwner = extractRequestedOwnerParam(url.searchParams);
    if (requestedOwner !== null) {
      const idor = assertNoIdor(user.id, requestedOwner, false);
      if (!idor.allowed) {
        return NextResponse.json(
          {
            success: false,
            code: 'IDOR_FORBIDDEN',
            error: 'Forbidden: Cross-account short-link access denied',
          },
          { status: 403 }
        );
      }
    }

    const [rowsResult, modes] = await Promise.all([
      db
        .prepare(
          `SELECT code, affiliate_id, exchange, destination_url, campaign_tag,
                  is_active, click_count, created_at
           FROM short_links
           WHERE affiliate_id = ?
           ORDER BY created_at DESC`
        )
        .bind(user.id)
        .all<ShortLinkDbRow>(),
      resolveExchangeModes(db),
    ]);

    const origin = resolveBaseOrigin(request);
    const shortLinks: AffiliateShortLinkItem[] = (rowsResult.results ?? []).map((row) => ({
      code: row.code,
      shortUrl: `${origin}/r/${row.code}`,
      exchange: row.exchange,
      exchangeMode: modes[row.exchange] ?? 'LIVE',
      destinationUrl: row.destination_url,
      campaignTag: row.campaign_tag,
      isActive: row.is_active === 1,
      clickCount: row.click_count,
      createdAt: row.created_at,
    }));

    return NextResponse.json(
      {
        success: true,
        shortLinks,
        supportedExchanges: APPROVED_SHORT_LINK_EXCHANGES,
        exchangeModes: modes,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const csrfDecision = verifyTrustedMutationOrigin(request);
    if (!csrfDecision.allowed) {
      return buildCsrfForbiddenResponse(csrfDecision);
    }

    const db = resolveDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, code: 'DB_UNAVAILABLE', error: 'Database unavailable' },
        { status: 503 }
      );
    }

    const user = await getAuthenticatedUser(request, db);
    if (!user?.id) {
      return NextResponse.json(
        { success: false, code: 'UNAUTHENTICATED', error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Persistent D1 rate limits across Worker isolates (15 creates/60s per user, 30/60s per IP)
    const userRate = await enforcePersistentD1RateLimit(db, {
      endpointType: 'short_link_post_user',
      identifier: user.id,
      maxRequests: 15,
      windowSeconds: 60,
    });
    if (!userRate.allowed) {
      return buildD1RateLimitResponse(userRate);
    }

    const clientIp = extractTrustedClientIp(request);
    const ipRate = await enforcePersistentD1RateLimit(db, {
      endpointType: 'short_link_post_ip',
      identifier: clientIp,
      maxRequests: 30,
      windowSeconds: 60,
    });
    if (!ipRate.allowed) {
      return buildD1RateLimitResponse(ipRate);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { success: false, code: 'INVALID_JSON', error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { success: false, code: 'INVALID_PAYLOAD', error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    const requestedOwner =
      typeof body.affiliateId === 'string'
        ? body.affiliateId.trim()
        : typeof body.affiliate_id === 'string'
          ? body.affiliate_id.trim()
          : null;
    if (requestedOwner) {
      const idor = assertNoIdor(user.id, requestedOwner, false);
      if (!idor.allowed) {
        return NextResponse.json(
          {
            success: false,
            code: 'IDOR_FORBIDDEN',
            error: 'Forbidden: Cannot create short links for another account',
          },
          { status: 403 }
        );
      }
    }

    if (!isApprovedExchange(body.exchange)) {
      return NextResponse.json(
        {
          success: false,
          code: 'UNSUPPORTED_EXCHANGE',
          error: 'exchange must be one of: bybit, okx, bitget, kucoin, gateio.',
        },
        { status: 400 }
      );
    }
    const exchange = body.exchange.trim().toLowerCase() as ApprovedShortLinkExchange;

    // Destination URL: caller-supplied or generated clean-room partner default
    const rawDestinationUrl =
      body.destinationUrl ?? body.destination_url ?? body.url ?? null;
    const candidateDestination =
      typeof rawDestinationUrl === 'string' && rawDestinationUrl.trim().length > 0
        ? rawDestinationUrl.trim()
        : EXCHANGE_DEFAULT_DESTINATION[exchange];

    const validatedDestination = validatePartnerDestinationUrl(candidateDestination);
    if (!validatedDestination) {
      return NextResponse.json(
        {
          success: false,
          code: 'UNTRUSTED_DESTINATION_URL',
          error: `destinationUrl must be an HTTPS URL on the allowlisted ${EXCHANGE_EXPECTED_DOMAIN[exchange]} partner domain.`,
        },
        { status: 400 }
      );
    }

    const destinationHost = validatedDestination.hostname.toLowerCase();
    if (!destinationHost.endsWith(EXCHANGE_EXPECTED_DOMAIN[exchange])) {
      return NextResponse.json(
        {
          success: false,
          code: 'DESTINATION_EXCHANGE_MISMATCH',
          error: `destinationUrl host '${destinationHost}' does not match exchange '${exchange}'.`,
        },
        { status: 400 }
      );
    }

    const rawCampaignTag = body.campaignTag ?? body.campaign_tag ?? null;
    let campaignTag: string | null = null;
    if (rawCampaignTag !== null && rawCampaignTag !== undefined && String(rawCampaignTag).trim() !== '') {
      if (typeof rawCampaignTag !== 'string' || !CAMPAIGN_TAG_REGEX.test(rawCampaignTag.trim())) {
        return NextResponse.json(
          {
            success: false,
            code: 'INVALID_CAMPAIGN_TAG',
            error: 'campaignTag must be 1-64 chars of letters, digits, spaces, "-", "_", ":", or ".".',
          },
          { status: 400 }
        );
      }
      campaignTag = rawCampaignTag.trim();
    }

    const rawCustomCode = body.customCode ?? body.custom_code ?? null;
    let code: string | null = null;

    if (rawCustomCode !== null && rawCustomCode !== undefined && String(rawCustomCode).trim() !== '') {
      if (typeof rawCustomCode !== 'string' || !isValidShortCode(rawCustomCode.trim())) {
        return NextResponse.json(
          {
            success: false,
            code: 'INVALID_SHORT_CODE',
            error: 'customCode must match /^[A-Za-z0-9_-]{4,32}$/.',
          },
          { status: 400 }
        );
      }
      const candidate = rawCustomCode.trim();
      const existing = await db
        .prepare('SELECT code FROM short_links WHERE code = ? LIMIT 1')
        .bind(candidate)
        .first<{ code: string }>();
      if (existing) {
        return NextResponse.json(
          {
            success: false,
            code: 'SHORT_CODE_EXISTS',
            error: `Short code '${candidate}' is already in use.`,
          },
          { status: 409 }
        );
      }
      code = candidate;
    } else {
      // Generate a collision-free random code
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = generateRandomShortCode();
        const existing = await db
          .prepare('SELECT code FROM short_links WHERE code = ? LIMIT 1')
          .bind(candidate)
          .first<{ code: string }>();
        if (!existing) {
          code = candidate;
          break;
        }
      }
      if (!code) {
        return NextResponse.json(
          {
            success: false,
            code: 'SHORT_CODE_GENERATION_FAILED',
            error: 'Unable to allocate a unique short code. Retry or supply a customCode.',
          },
          { status: 409 }
        );
      }
    }

    const nowIso = new Date().toISOString();

    try {
      await db
        .prepare(
          `INSERT INTO short_links (
             code, affiliate_id, deal_id, exchange, destination_url,
             campaign_tag, is_active, click_count, created_at, updated_at
           ) VALUES (?, ?, NULL, ?, ?, ?, 1, 0, ?, ?)`
        )
        .bind(
          code,
          user.id,
          exchange,
          validatedDestination.toString(),
          campaignTag,
          nowIso,
          nowIso
        )
        .run();
    } catch (insertErr: unknown) {
      const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
      if (msg.includes('UNIQUE constraint failed')) {
        return NextResponse.json(
          {
            success: false,
            code: 'SHORT_CODE_EXISTS',
            error: `Short code '${code}' is already in use.`,
          },
          { status: 409 }
        );
      }
      throw insertErr;
    }

    const modes = await resolveExchangeModes(db);
    const origin = resolveBaseOrigin(request);

    return NextResponse.json(
      {
        success: true,
        code: 'SHORT_LINK_CREATED',
        shortLink: {
          code,
          shortUrl: `${origin}/r/${code}`,
          exchange,
          exchangeMode: modes[exchange] ?? 'LIVE',
          destinationUrl: validatedDestination.toString(),
          campaignTag,
          isActive: true,
          clickCount: 0,
          createdAt: nowIso,
        } satisfies AffiliateShortLinkItem,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const csrfDecision = verifyTrustedMutationOrigin(request);
    if (!csrfDecision.allowed) {
      return buildCsrfForbiddenResponse(csrfDecision);
    }

    const db = resolveDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, code: 'DB_UNAVAILABLE', error: 'Database unavailable' },
        { status: 503 }
      );
    }

    const user = await getAuthenticatedUser(request, db);
    if (!user?.id) {
      return NextResponse.json(
        { success: false, code: 'UNAUTHENTICATED', error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const patchRate = await enforcePersistentD1RateLimit(db, {
      endpointType: 'short_link_patch_user',
      identifier: user.id,
      maxRequests: 20,
      windowSeconds: 60,
    });
    if (!patchRate.allowed) {
      return buildD1RateLimitResponse(patchRate);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { success: false, code: 'INVALID_JSON', error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { success: false, code: 'INVALID_PAYLOAD', error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    const rawCode = body.code ?? body.shortCode ?? body.short_code ?? null;
    if (typeof rawCode !== 'string' || !isValidShortCode(rawCode.trim())) {
      return NextResponse.json(
        {
          success: false,
          code: 'INVALID_SHORT_CODE',
          error: 'code must match /^[A-Za-z0-9_-]{4,32}$/.',
        },
        { status: 400 }
      );
    }
    const code = rawCode.trim();

    const rawIsActive = body.isActive ?? body.is_active ?? null;
    let isActive: 0 | 1;
    if (rawIsActive === true || rawIsActive === 1 || rawIsActive === '1' || rawIsActive === 'true') {
      isActive = 1;
    } else if (
      rawIsActive === false ||
      rawIsActive === 0 ||
      rawIsActive === '0' ||
      rawIsActive === 'false'
    ) {
      isActive = 0;
    } else {
      return NextResponse.json(
        {
          success: false,
          code: 'INVALID_IS_ACTIVE',
          error: 'isActive must be a boolean, 0, or 1.',
        },
        { status: 400 }
      );
    }

    // Owner-scoped lookup: a short link owned by another account is reported
    // as 403 IDOR_FORBIDDEN rather than leaking its existence.
    const existing = await db
      .prepare('SELECT code, affiliate_id FROM short_links WHERE code = ? LIMIT 1')
      .bind(code)
      .first<{ code: string; affiliate_id: string }>();

    if (!existing) {
      return NextResponse.json(
        { success: false, code: 'SHORT_LINK_NOT_FOUND', error: `Short link '${code}' not found.` },
        { status: 404 }
      );
    }

    const idor = assertNoIdor(user.id, existing.affiliate_id, false);
    if (!idor.allowed) {
      return NextResponse.json(
        {
          success: false,
          code: 'IDOR_FORBIDDEN',
          error: 'Forbidden: Cannot toggle a short link owned by another account.',
        },
        { status: 403 }
      );
    }

    const updatedIso = new Date().toISOString();
    await db
      .prepare(
        `UPDATE short_links
         SET is_active = ?, updated_at = ?
         WHERE code = ? AND affiliate_id = ?`
      )
      .bind(isActive, updatedIso, code, user.id)
      .run();

    return NextResponse.json(
      {
        success: true,
        code: 'SHORT_LINK_TOGGLED',
        shortLink: { code, isActive: isActive === 1, updatedAt: updatedIso },
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}
