/**
 * Canonical Origin & Quarantined Third-Party Host Guard (Gate G2)
 *
 * Single source of truth for public application URLs, WebAuthn Relying Party
 * (`RP_ID` / `Origin`) fallbacks, SEO metadata, short-link copy URLs, and alert
 * action links.
 *
 * Live DNS/HTTP/Wrangler audit (2026-11-18) verified that `apexos.app`,
 * `apex-os.pages.dev`, `apex-os.com`, and `apexos.io` are NOT owned by this
 * Cloudflare account and resolve to unrelated third parties or parked servers.
 * Any configured env var pointing at a quarantined hostname is rejected so
 * traffic and auth redirects never leak off-platform.
 */

export const CANONICAL_PRODUCTION_WORKER_HOST = 'apex-os.agencyos-openclaw.workers.dev';
export const CANONICAL_PRODUCTION_ORIGIN = `https://${CANONICAL_PRODUCTION_WORKER_HOST}`;

export const CANONICAL_STAGING_WORKER_HOST = 'apex-os-staging.agencyos-openclaw.workers.dev';
export const CANONICAL_STAGING_ORIGIN = `https://${CANONICAL_STAGING_WORKER_HOST}`;

export const LOCAL_DEV_ORIGIN = 'http://localhost:3000';

/**
 * Hostnames confirmed via DNS/HTTP audit to belong to third parties, global
 * `pages.dev` squatters, parked registrars, or stale Worker subdomains.
 */
export const QUARANTINED_UNOWNED_HOSTS: ReadonlySet<string> = new Set([
  'apexos.app',
  'www.apexos.app',
  'apex-os.pages.dev',
  'apex-os.com',
  'www.apex-os.com',
  'apexos.io',
  'www.apexos.io',
  'my.apexos.io',
  'apex-os-staging.long-tran624.workers.dev',
  'apex-os-production.long-tran624.workers.dev',
  'apex-os-production.agencyos-openclaw.workers.dev',
]);

export function isQuarantinedThirdPartyHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) {
    return true;
  }
  if (QUARANTINED_UNOWNED_HOSTS.has(normalized)) {
    return true;
  }
  for (const blocked of QUARANTINED_UNOWNED_HOSTS) {
    if (!blocked.startsWith('www.') && normalized.endsWith(`.${blocked}`)) {
      return true;
    }
  }
  return false;
}

export interface ResolveCanonicalOriginOptions {
  appUrl?: string | null;
  siteUrl?: string | null;
  baseUrl?: string | null;
  appEnv?: string | null;
  nodeEnv?: string | null;
}

function sanitizeConfiguredOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    if (isQuarantinedThirdPartyHost(parsed.hostname)) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Resolves the verified public origin for the current runtime environment.
 * When an owned Cloudflare Custom Domain is provisioned later, setting
 * `NEXT_PUBLIC_APP_URL` switches every consumer atomically from one place.
 */
export function resolveCanonicalAppOrigin(options?: ResolveCanonicalOriginOptions): string {
  const candidates = [
    options?.appUrl ?? process.env.NEXT_PUBLIC_APP_URL,
    options?.siteUrl ?? process.env.NEXT_PUBLIC_SITE_URL,
    options?.baseUrl ?? process.env.NEXT_PUBLIC_BASE_URL,
  ];

  for (const candidate of candidates) {
    const valid = sanitizeConfiguredOrigin(candidate);
    if (valid) {
      return valid;
    }
  }

  const appEnv = (options?.appEnv ?? process.env.APP_ENV ?? '').trim().toLowerCase();
  if (appEnv === 'staging') {
    return CANONICAL_STAGING_ORIGIN;
  }
  if (appEnv === 'production') {
    return CANONICAL_PRODUCTION_ORIGIN;
  }

  const nodeEnv = (options?.nodeEnv ?? process.env.NODE_ENV ?? '').trim().toLowerCase();
  if (nodeEnv === 'production') {
    return CANONICAL_PRODUCTION_ORIGIN;
  }

  return LOCAL_DEV_ORIGIN;
}

/**
 * Returns the canonical public metadata base URL for static/SEO build artifacts
 * (`sitemap.xml`, `robots.txt`, OpenGraph `metadataBase`, JSON-LD).
 */
export function resolvePublicMetadataOrigin(): string {
  const explicit =
    sanitizeConfiguredOrigin(process.env.NEXT_PUBLIC_APP_URL) ??
    sanitizeConfiguredOrigin(process.env.NEXT_PUBLIC_SITE_URL) ??
    sanitizeConfiguredOrigin(process.env.NEXT_PUBLIC_BASE_URL);
  if (explicit) {
    return explicit;
  }
  const appEnv = (process.env.APP_ENV ?? '').trim().toLowerCase();
  if (appEnv === 'staging') {
    return CANONICAL_STAGING_ORIGIN;
  }
  return CANONICAL_PRODUCTION_ORIGIN;
}

/**
 * Returns the explicit list of trusted first-party browser origins for Better Auth
 * and route-level CSRF guards. Quarantined third-party domains (`apexos.app`,
 * `apex-os.pages.dev`, `apex-os.com`, `apexos.io`) are never included.
 */
export function resolveTrustedBrowserOrigins(): string[] {
  const origins = new Set<string>();
  const primary = resolveCanonicalAppOrigin();
  if (primary) {
    origins.add(primary);
  }
  for (const candidate of [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.WEBAUTHN_ORIGIN,
    process.env.BETTER_AUTH_URL,
  ]) {
    const valid = sanitizeConfiguredOrigin(candidate);
    if (valid) {
      origins.add(valid);
    }
  }
  const appEnv = (process.env.APP_ENV ?? '').trim().toLowerCase();
  const isManaged =
    appEnv === 'production' || appEnv === 'staging' || process.env.NODE_ENV === 'production';
  if (!isManaged) {
    origins.add('http://localhost:3000');
    origins.add('http://127.0.0.1:3000');
  }
  return Array.from(origins);
}

