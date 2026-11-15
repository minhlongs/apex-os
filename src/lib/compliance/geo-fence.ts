/**
 * Edge Geo-Fencing & Regulatory Jurisdiction Gate
 *
 * Enforces hard blocks on restricted/sanctioned jurisdictions (MAS PS-G02 SG,
 * US, FCA GB, all 30 EEA member states, CN, HK, JP, TR, RU, BY, and OFAC
 * comprehensive-sanctions countries KP, IR, SY, CU) and implements the
 * runtime kill-switch `BLOCK_VN_SIGNUPS` (default: false) for Vietnam.
 */

import { NextResponse } from 'next/server';
import type { D1Database } from '@/lib/db';

export const EEA_MEMBER_STATES = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IS',
  'IE',
  'IT',
  'LV',
  'LI',
  'LT',
  'LU',
  'MT',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
] as const;

export const SANCTIONED_JURISDICTIONS = ['KP', 'IR', 'SY', 'CU'] as const;

export const ADDITIONAL_RESTRICTED_JURISDICTIONS = [
  'SG',
  'US',
  'GB',
  'CN',
  'HK',
  'JP',
  'TR',
  'RU',
  'BY',
] as const;

export const HARD_BLOCKED_JURISDICTIONS: ReadonlySet<string> = new Set<string>([
  ...ADDITIONAL_RESTRICTED_JURISDICTIONS,
  ...EEA_MEMBER_STATES,
  ...SANCTIONED_JURISDICTIONS,
  'T1', // Cloudflare Tor exit node sentinel — fail-closed against jurisdiction bypass
]);

export type GeoFenceBlockCode = 'GEO_RESTRICTED' | 'GEO_RESTRICTED_VN_KILLSWITCH';

export interface GeoFenceOptions {
  db?: D1Database | null;
  blockVnSignups?: boolean;
  bypassPrefixes?: readonly string[];
  trustVercelGeoHeader?: boolean;
}

export interface GeoFenceDecision {
  allowed: boolean;
  status: 200 | 451;
  country: string | null;
  code?: GeoFenceBlockCode;
  error?: string;
}

const DEFAULT_BYPASS_PREFIXES: readonly string[] = ['/api/health', '/api/cron'];

const VN_KILLSWITCH_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/(?:(?:en|vi)\/)?(?:signup|register|onboarding)(?:\/|$)/i,
  /^\/(?:(?:en|vi)\/)?(?:affiliate|deals)(?:\/|$)/i,
  /^\/(?:(?:en|vi)\/)?telegram(?:\/|$)/i,
  /^\/api\/auth\/(?:signup|sign-up|register|telegram)(?:\/|$)/i,
  /^\/api\/(?:onboarding|affiliate|deals|tracking\/click)(?:\/|$)/i,
  /^\/(?:r|ref)(?:\/|$)/i,
];

/**
 * Extracts ISO-3166-1 alpha-2 country code (or Cloudflare 'T1' Tor sentinel) strictly from
 * Cloudflare edge `CF-IPCountry` headers by default so unauthenticated clients cannot spoof
 * `x-vercel-ip-country` behind Cloudflare Workers/Pages.
 */
export function extractCountryCode(
  request: Request,
  options?: { trustVercelGeoHeader?: boolean }
): string | null {
  const trustVercel =
    options?.trustVercelGeoHeader ?? process.env.TRUST_VERCEL_GEO_HEADER === 'true';
  const raw =
    request.headers.get('CF-IPCountry') ??
    request.headers.get('cf-ipcountry') ??
    (trustVercel ? request.headers.get('x-vercel-ip-country') : null);

  if (!raw) {
    return null;
  }

  const normalized = raw.trim().toUpperCase();
  if (!normalized || normalized === 'XX') {
    return null;
  }

  // Cloudflare emits 'T1' for Tor exit nodes; standard jurisdictions are 2 uppercase letters.
  if (normalized === 'T1' || /^[A-Z]{2}$/.test(normalized)) {
    return normalized;
  }

  return null;
}

export function isVnSignupOrReferralRoute(url: URL): boolean {
  const { pathname, searchParams } = url;
  if (
    searchParams.has('ref') ||
    searchParams.has('referral') ||
    searchParams.has('affiliate_code')
  ) {
    return true;
  }

  return VN_KILLSWITCH_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

async function resolveBlockVnSignupsFlag(options?: GeoFenceOptions): Promise<boolean> {
  if (typeof options?.blockVnSignups === 'boolean') {
    return options.blockVnSignups;
  }

  const envVal = process.env.BLOCK_VN_SIGNUPS;
  if (typeof envVal === 'string' && envVal.trim().length > 0) {
    const normalized = envVal.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }

  const db =
    options?.db ??
    ((globalThis as unknown as { DB?: D1Database }).DB ?? null);

  if (db) {
    try {
      const row = await db
        .prepare(
          "SELECT flag_value FROM system_runtime_flags WHERE flag_key = 'BLOCK_VN_SIGNUPS' LIMIT 1"
        )
        .first<{ flag_value: string }>();
      if (row && typeof row.flag_value === 'string') {
        const normalized = row.flag_value.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
      }
    } catch {
      // Table may not exist in isolated unit test schemas; default safely to false
    }
  }

  return false;
}

/**
 * Evaluates edge geo-fencing rules for an incoming request.
 */
export async function evaluateGeoFence(
  request: Request,
  options?: GeoFenceOptions
): Promise<GeoFenceDecision> {
  const url = new URL(request.url);
  const bypassPrefixes = options?.bypassPrefixes ?? DEFAULT_BYPASS_PREFIXES;

  if (bypassPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    return {
      allowed: true,
      status: 200,
      country: extractCountryCode(request, {
        trustVercelGeoHeader: options?.trustVercelGeoHeader,
      }),
    };
  }

  const country = extractCountryCode(request, {
    trustVercelGeoHeader: options?.trustVercelGeoHeader,
  });
  if (!country) {
    return {
      allowed: true,
      status: 200,
      country: null,
    };
  }

  if (HARD_BLOCKED_JURISDICTIONS.has(country)) {
    return {
      allowed: false,
      status: 451,
      country,
      code: 'GEO_RESTRICTED',
      error: 'Service unavailable in your jurisdiction',
    };
  }

  if (country === 'VN') {
    const vnBlocked = await resolveBlockVnSignupsFlag(options);
    if (vnBlocked && isVnSignupOrReferralRoute(url)) {
      return {
        allowed: false,
        status: 451,
        country: 'VN',
        code: 'GEO_RESTRICTED_VN_KILLSWITCH',
        error: 'Service unavailable in your jurisdiction',
      };
    }
  }

  return {
    allowed: true,
    status: 200,
    country,
  };
}

/**
 * Builds a structured HTTP 451 Unavailable For Legal Reasons response.
 */
export function buildGeoRestrictedResponse(decision: GeoFenceDecision): NextResponse {
  return NextResponse.json(
    {
      error: decision.error ?? 'Service unavailable in your jurisdiction',
      code: decision.code ?? 'GEO_RESTRICTED',
      country: decision.country,
    },
    { status: 451 }
  );
}
