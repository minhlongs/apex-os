/**
 * Non-Custodial Partner Exchange UID Binding API
 *
 * Endpoints:
 * - GET    /api/affiliate/uids -> Owner-scoped list of bound partner UIDs
 * - POST   /api/affiliate/uids -> Bind a read-only exchange UID (`bybit`, `okx`, `bitget`, `kucoin`, `gateio`)
 * - DELETE /api/affiliate/uids?id=... -> Delete `PENDING_FIRST_TRADE` or `REJECTED` UID owned by user
 *
 * Security & Compliance Invariants:
 * - Strictly non-custodial: rejects any payload containing API keys/secrets (`400 NON_CUSTODIAL_UID_ONLY`).
 * - Explicitly rejects `binance` / `binance_referral_pro` (`422 BINANCE_UID_ATTRIBUTION_UNSUPPORTED`)
 *   because Binance Standard Referral Pro hides referee UIDs.
 * - Enforces global uniqueness on `(exchange, exchange_uid)` (`409 EXCHANGE_UID_ALREADY_BOUND`).
 * - Enforces strict anti-IDOR (`WHERE profile_id = user.id` + `403 IDOR_FORBIDDEN` on cross-owner access).
 * - Blocks deletion of `VERIFIED_BY_PARTNER` bindings (`409 VERIFIED_UID_IMMUTABLE`).
 */

import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { D1Database } from '@/lib/db';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import {
  assertNoIdor,
  sanitizeApiErrorResponse,
} from '@/lib/auth/passkey-step-up';
import {
  buildD1RateLimitResponse,
  enforcePersistentD1RateLimit,
  extractTrustedClientIp,
} from '@/lib/security/d1-rate-limiter';
import {
  buildCsrfForbiddenResponse,
  verifyTrustedMutationOrigin,
} from '@/lib/security/http-hardening';
import { isValidShortCode } from '@/lib/shortener/short-link-service';

const ALLOWED_UID_EXCHANGES = [
  'bybit',
  'okx',
  'bitget',
  'kucoin',
  'gateio',
] as const;

export type AllowedUidExchange = (typeof ALLOWED_UID_EXCHANGES)[number];

export type UidVerificationStatus =
  | 'PENDING_FIRST_TRADE'
  | 'VERIFIED_BY_PARTNER'
  | 'REJECTED';

export interface BoundExchangeUidItem {
  id: string;
  profileId: string;
  exchange: AllowedUidExchange;
  exchangeMode: 'LIVE' | 'SHADOW_30D';
  exchangeUid: string;
  linkedShortCode: string | null;
  verificationStatus: UidVerificationStatus;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TraderExchangeUidRow {
  id: string;
  profile_id: string;
  exchange: AllowedUidExchange;
  exchange_uid: string;
  linked_short_code: string | null;
  verification_status: UidVerificationStatus;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

const PARTNER_EXCHANGE_UID_STRUCTURE_REGEX =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|[_-](?=[A-Za-z0-9])){3,30}[A-Za-z0-9]$/;

function isValidPartnerExchangeUid(rawUid: string): boolean {
  if (typeof rawUid !== 'string') {
    return false;
  }
  if (rawUid.length < 5 || rawUid.length > 32) {
    return false;
  }
  if (!PARTNER_EXCHANGE_UID_STRUCTURE_REGEX.test(rawUid)) {
    return false;
  }
  return (rawUid.match(/\d/g)?.length ?? 0) >= 4;
}

const FORBIDDEN_CUSTODIAL_CREDENTIAL_FIELDS = [
  'apiKey',
  'apiSecret',
  'passphrase',
  'privateKey',
  'api_key',
  'api_secret',
  'private_key',
  'secretKey',
  'secret_key',
] as const;

const initializedUidTables = new WeakSet<object>();

async function ensureTraderExchangeUidsTable(db: D1Database): Promise<void> {
  if (initializedUidTables.has(db)) {
    return;
  }

  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS trader_exchange_uids (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          exchange TEXT NOT NULL CHECK (exchange IN ('bybit', 'okx', 'bitget', 'kucoin', 'gateio')),
          exchange_uid TEXT NOT NULL,
          linked_short_code TEXT REFERENCES short_links(code) ON DELETE SET NULL,
          verification_status TEXT NOT NULL DEFAULT 'PENDING_FIRST_TRADE' CHECK (
            verification_status IN ('PENDING_FIRST_TRADE', 'VERIFIED_BY_PARTNER', 'REJECTED')
          ),
          verified_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (exchange, exchange_uid)
        )`
      )
      .run();
    initializedUidTables.add(db);
  } catch {
    // Table is already provisioned via migration 031 in managed environments
  }
}

async function resolveExchangeModes(
  db: D1Database
): Promise<Record<AllowedUidExchange, 'LIVE' | 'SHADOW_30D'>> {
  const modes: Record<AllowedUidExchange, 'LIVE' | 'SHADOW_30D'> = {
    bybit: 'LIVE',
    okx: 'LIVE',
    bitget: 'LIVE',
    kucoin: 'SHADOW_30D',
    gateio: 'SHADOW_30D',
  };

  try {
    const flags = await db
      .prepare(
        `SELECT flag_key, flag_value
         FROM system_runtime_flags
         WHERE flag_key IN ('PARTNER_KUCOIN_LIVE', 'PARTNER_GATEIO_LIVE')`
      )
      .all<{ flag_key: string; flag_value: string }>();

    for (const row of flags.results ?? []) {
      if (row.flag_key === 'PARTNER_KUCOIN_LIVE' && row.flag_value === 'true') {
        modes.kucoin = 'LIVE';
      }
      if (row.flag_key === 'PARTNER_GATEIO_LIVE' && row.flag_value === 'true') {
        modes.gateio = 'LIVE';
      }
    }
  } catch {
    // Default shadow gate modes apply if system_runtime_flags is absent
  }

  return modes;
}

function mapUidRow(
  row: TraderExchangeUidRow,
  modes: Record<AllowedUidExchange, 'LIVE' | 'SHADOW_30D'>
): BoundExchangeUidItem {
  return {
    id: row.id,
    profileId: row.profile_id,
    exchange: row.exchange,
    exchangeMode: modes[row.exchange] ?? 'LIVE',
    exchangeUid: row.exchange_uid,
    linkedShortCode: row.linked_short_code,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isAllowedExchange(value: string): value is AllowedUidExchange {
  return (ALLOWED_UID_EXCHANGES as readonly string[]).includes(value);
}

function extractRequestedOwnerParam(searchParams: URLSearchParams): string | null {
  const candidates = [
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
            error: 'Forbidden: Cross-account UID lookup denied',
          },
          { status: 403 }
        );
      }
    }

    await ensureTraderExchangeUidsTable(db);
    const [rowsResult, modes] = await Promise.all([
      db
        .prepare(
          `SELECT id, profile_id, exchange, exchange_uid, linked_short_code,
                  verification_status, verified_at, created_at, updated_at
           FROM trader_exchange_uids
           WHERE profile_id = ?
           ORDER BY created_at DESC, id DESC`
        )
        .bind(user.id)
        .all<TraderExchangeUidRow>(),
      resolveExchangeModes(db),
    ]);

    const uids = (rowsResult.results ?? []).map((row) => mapUidRow(row, modes));

    return NextResponse.json(
      {
        success: true,
        uids,
        supportedExchanges: ALLOWED_UID_EXCHANGES,
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

    const userRateCheck = await enforcePersistentD1RateLimit(db, {
      endpointType: 'affiliate_uid_post_user',
      identifier: user.id,
      maxRequests: 10,
      windowSeconds: 60,
    });
    if (!userRateCheck.allowed) {
      if (userRateCheck.status === 503) {
        return buildD1RateLimitResponse(userRateCheck);
      }
      return NextResponse.json(
        {
          success: false,
          code: 'RATE_LIMITED',
          error:
            'Too many exchange UID bind attempts for this account. Please retry shortly.',
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.max(1, userRateCheck.retryAfterSeconds)),
          },
        }
      );
    }

    const clientIp = extractTrustedClientIp(request);
    const ipRateCheck = await enforcePersistentD1RateLimit(db, {
      endpointType: 'affiliate_uid_post_ip',
      identifier: clientIp,
      maxRequests: 20,
      windowSeconds: 60,
    });
    if (!ipRateCheck.allowed) {
      if (ipRateCheck.status === 503) {
        return buildD1RateLimitResponse(ipRateCheck);
      }
      return NextResponse.json(
        {
          success: false,
          code: 'RATE_LIMITED',
          error:
            'Too many exchange UID bind attempts from this IP address. Please retry shortly.',
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.max(1, ipRateCheck.retryAfterSeconds)),
          },
        }
      );
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

    // 1. Strict non-custodial boundary: reject any API key / secret / passphrase fields
    for (const forbiddenKey of FORBIDDEN_CUSTODIAL_CREDENTIAL_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, forbiddenKey) && body[forbiddenKey] !== undefined) {
        return NextResponse.json(
          {
            success: false,
            code: 'NON_CUSTODIAL_UID_ONLY',
            error:
              'ApexOS is strictly non-custodial. Never submit exchange API keys, secrets, passphrases, or private keys — provide only your public Partner Exchange UID.',
          },
          { status: 400 }
        );
      }
    }

    // 2. Anti-IDOR check if caller explicitly supplied a target profile identifier
    const requestedProfileId =
      typeof body.profileId === 'string'
        ? body.profileId.trim()
        : typeof body.profile_id === 'string'
          ? body.profile_id.trim()
          : null;
    if (requestedProfileId) {
      const idor = assertNoIdor(user.id, requestedProfileId, false);
      if (!idor.allowed) {
        return NextResponse.json(
          {
            success: false,
            code: 'IDOR_FORBIDDEN',
            error: 'Forbidden: Cannot bind exchange UIDs for another account',
          },
          { status: 403 }
        );
      }
    }

    // 3. Exchange validation (explicit 422 rejection for Binance Standard Referral Pro)
    const rawExchange = typeof body.exchange === 'string' ? body.exchange.trim().toLowerCase() : '';
    if (
      rawExchange === 'binance' ||
      rawExchange === 'binance_referral_pro' ||
      rawExchange.startsWith('binance')
    ) {
      return NextResponse.json(
        {
          success: false,
          code: 'BINANCE_UID_ATTRIBUTION_UNSUPPORTED',
          error:
            'Binance Standard Referral Pro hides referee UIDs from partner APIs and cannot support deterministic per-trader UID rebate attribution. Bind Bybit, OKX, Bitget, KuCoin, or Gate.io instead.',
        },
        { status: 422 }
      );
    }

    if (!isAllowedExchange(rawExchange)) {
      return NextResponse.json(
        {
          success: false,
          code: 'UNSUPPORTED_EXCHANGE',
          error: `Unsupported exchange '${rawExchange || 'empty'}'. Allowed partner exchanges: bybit, okx, bitget, kucoin, gateio.`,
        },
        { status: 400 }
      );
    }

    // 4. Validate read-only exchange UID format
    const rawUid =
      typeof body.exchangeUid === 'string'
        ? body.exchangeUid.trim()
        : typeof body.exchange_uid === 'string'
          ? body.exchange_uid.trim()
          : '';

    if (!isValidPartnerExchangeUid(rawUid)) {
      return NextResponse.json(
        {
          success: false,
          code: 'INVALID_EXCHANGE_UID',
          error:
            'exchangeUid must be 5-32 characters, start and end with an alphanumeric character, use only single (non-consecutive) dashes or underscores as separators, and contain at least 4 numeric digits.',
        },
        { status: 400 }
      );
    }

    // 5. Optional linkedShortCode ownership check
    const rawShortCode =
      body.linkedShortCode !== undefined
        ? body.linkedShortCode
        : body.linked_short_code;
    let validatedShortCode: string | null = null;

    if (rawShortCode !== undefined && rawShortCode !== null && String(rawShortCode).trim() !== '') {
      if (typeof rawShortCode !== 'string' || !isValidShortCode(rawShortCode.trim())) {
        return NextResponse.json(
          {
            success: false,
            code: 'INVALID_SHORT_CODE',
            error: 'linkedShortCode must match /^[A-Za-z0-9_-]{4,32}$/.',
          },
          { status: 400 }
        );
      }

      const candidateCode = rawShortCode.trim();
      const shortLinkRow = await db
        .prepare(
          'SELECT code, affiliate_id, exchange FROM short_links WHERE code = ? LIMIT 1'
        )
        .bind(candidateCode)
        .first<{ code: string; affiliate_id: string; exchange: string }>();

      if (!shortLinkRow) {
        return NextResponse.json(
          {
            success: false,
            code: 'SHORT_LINK_NOT_FOUND',
            error: `Short link '${candidateCode}' was not found.`,
          },
          { status: 404 }
        );
      }

      if (shortLinkRow.affiliate_id !== user.id) {
        return NextResponse.json(
          {
            success: false,
            code: 'IDOR_FORBIDDEN',
            error: 'Forbidden: linkedShortCode does not belong to your account.',
          },
          { status: 403 }
        );
      }

      if (shortLinkRow.exchange !== rawExchange) {
        return NextResponse.json(
          {
            success: false,
            code: 'SHORT_LINK_EXCHANGE_MISMATCH',
            error: `Short link '${candidateCode}' belongs to '${shortLinkRow.exchange}', not '${rawExchange}'.`,
          },
          { status: 400 }
        );
      }

      validatedShortCode = shortLinkRow.code;
    }

    await ensureTraderExchangeUidsTable(db);

    // 6. Enforce global uniqueness on (exchange, exchange_uid) across ALL users
    const existingClaim = await db
      .prepare(
        `SELECT id, profile_id
         FROM trader_exchange_uids
         WHERE exchange = ? AND exchange_uid = ?
         LIMIT 1`
      )
      .bind(rawExchange, rawUid)
      .first<{ id: string; profile_id: string }>();

    if (existingClaim) {
      return NextResponse.json(
        {
          success: false,
          code: 'EXCHANGE_UID_ALREADY_BOUND',
          error: `Exchange UID '${rawUid}' on ${rawExchange} is already bound.`,
        },
        { status: 409 }
      );
    }

    const id = `tuid_${crypto.randomUUID()}`;
    const nowIso = new Date().toISOString();

    try {
      await db
        .prepare(
          `INSERT INTO trader_exchange_uids (
             id, profile_id, exchange, exchange_uid, linked_short_code,
             verification_status, verified_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'PENDING_FIRST_TRADE', NULL, ?, ?)`
        )
        .bind(id, user.id, rawExchange, rawUid, validatedShortCode, nowIso, nowIso)
        .run();
    } catch (insertErr: unknown) {
      const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
      if (msg.includes('UNIQUE constraint failed')) {
        return NextResponse.json(
          {
            success: false,
            code: 'EXCHANGE_UID_ALREADY_BOUND',
            error: `Exchange UID '${rawUid}' on ${rawExchange} is already bound.`,
          },
          { status: 409 }
        );
      }
      throw insertErr;
    }

    const modes = await resolveExchangeModes(db);
    const createdItem: BoundExchangeUidItem = {
      id,
      profileId: user.id,
      exchange: rawExchange,
      exchangeMode: modes[rawExchange] ?? 'LIVE',
      exchangeUid: rawUid,
      linkedShortCode: validatedShortCode,
      verificationStatus: 'PENDING_FIRST_TRADE',
      verifiedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    return NextResponse.json(
      {
        success: true,
        code: 'EXCHANGE_UID_BOUND',
        uid: createdItem,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
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

    const deleteRateCheck = await enforcePersistentD1RateLimit(db, {
      endpointType: 'affiliate_uid_delete_user',
      identifier: user.id,
      maxRequests: 15,
      windowSeconds: 60,
    });
    if (!deleteRateCheck.allowed) {
      if (deleteRateCheck.status === 503) {
        return buildD1RateLimitResponse(deleteRateCheck);
      }
      return NextResponse.json(
        {
          success: false,
          code: 'RATE_LIMITED',
          error:
            'Too many exchange UID removal attempts for this account. Please retry shortly.',
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.max(1, deleteRateCheck.retryAfterSeconds)),
          },
        }
      );
    }

    const url = new URL(request.url);
    let bindingId = url.searchParams.get('id')?.trim() ?? '';

    if (!bindingId) {
      try {
        const body = (await request.json()) as { id?: unknown };
        if (typeof body?.id === 'string') {
          bindingId = body.id.trim();
        }
      } catch {
        // Query param `?id=` is primary
      }
    }

    if (!bindingId) {
      return NextResponse.json(
        {
          success: false,
          code: 'MISSING_UID_ID',
          error: 'Provide UID binding id via ?id=... query parameter.',
        },
        { status: 400 }
      );
    }

    await ensureTraderExchangeUidsTable(db);

    const existing = await db
      .prepare(
        `SELECT id, profile_id, exchange, exchange_uid, verification_status
         FROM trader_exchange_uids
         WHERE id = ?
         LIMIT 1`
      )
      .bind(bindingId)
      .first<{
        id: string;
        profile_id: string;
        exchange: AllowedUidExchange;
        exchange_uid: string;
        verification_status: UidVerificationStatus;
      }>();

    if (!existing) {
      return NextResponse.json(
        {
          success: false,
          code: 'UID_BINDING_NOT_FOUND',
          error: 'Exchange UID binding not found.',
        },
        { status: 404 }
      );
    }

    // Strict anti-IDOR boundary on DELETE
    const idor = assertNoIdor(user.id, existing.profile_id, false);
    if (!idor.allowed) {
      return NextResponse.json(
        {
          success: false,
          code: 'IDOR_FORBIDDEN',
          error: 'Forbidden: Cannot remove an exchange UID bound to another account.',
        },
        { status: 403 }
      );
    }

    if (existing.verification_status === 'VERIFIED_BY_PARTNER') {
      return NextResponse.json(
        {
          success: false,
          code: 'VERIFIED_UID_IMMUTABLE',
          error:
            'Partner-verified exchange UIDs have an immutable rebate audit trail and cannot be deleted.',
        },
        { status: 409 }
      );
    }

    await db
      .prepare(
        `DELETE FROM trader_exchange_uids
         WHERE id = ? AND profile_id = ?
           AND verification_status IN ('PENDING_FIRST_TRADE', 'REJECTED')`
      )
      .bind(existing.id, user.id)
      .run();

    return NextResponse.json(
      {
        success: true,
        code: 'EXCHANGE_UID_REMOVED',
        deletedId: existing.id,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}
