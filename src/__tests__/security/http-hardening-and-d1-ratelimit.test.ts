/**
 * @jest-environment node
 *
 * Security Verification Suite — F-02 (Nonce CSP & Security Headers),
 * F-03 (Persistent D1 Atomic Rate Limiting), and F-04 (CSRF Mutation Origin Guard)
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import * as dbModule from '@/lib/db';
import { SqliteD1Adapter } from '@/lib/ledger';
import { middleware } from '@/middleware';
import {
  buildContentSecurityPolicy,
  generateCspNonce,
  verifyTrustedMutationOrigin,
} from '@/lib/security/http-hardening';
import { enforcePersistentD1RateLimit } from '@/lib/security/d1-rate-limiter';
import { POST as shortLinksPost } from '@/app/api/affiliate/short-links/route';
import { POST as uidsPost } from '@/app/api/affiliate/uids/route';
import { POST as adminPasskeyPost } from '@/app/api/admin/passkey/route';
import { GET as shortLinkRedirectGet } from '@/app/r/[code]/route';

describe('Security Hardening — F-02 Nonce CSP, F-03 Persistent D1 Rate Limiter, F-04 CSRF Origin Guard', () => {
  let sqlite: Database.Database;
  let db: SqliteD1Adapter;
  const originalAppEnv = process.env.APP_ENV;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const migrationsDir = path.join(process.cwd(), 'src', 'database', 'migrations');
    for (const file of [
      '001_initial_schema_d1.sql',
      '003_affiliate_schema.sql',
      '028_ascendancy_audit_core.sql',
      '031_ascendancy_phase2_ui_and_poller.sql',
      '032_persistent_d1_rate_limits.sql',
    ]) {
      sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    }

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);

    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    sqlite
      .prepare('INSERT INTO profiles (id, email, role, referral_code) VALUES (?, ?, ?, ?)')
      .run('user_sec_1', 'sec@example.com', 'affiliate', 'SEC_CODE_1');
    sqlite
      .prepare('INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)')
      .run('sess_sec_1', 'user_sec_1', 'tok_sec_valid', futureIso);
    sqlite
      .prepare(
        'INSERT INTO short_links (code, affiliate_id, exchange, destination_url, is_active) VALUES (?, ?, ?, ?, 1)'
      )
      .run('sec_bybit1', 'user_sec_1', 'bybit', 'https://partner.bybit.com/b/APEXSEC');

    db = new SqliteD1Adapter(sqlite);
    jest.spyOn(dbModule, 'getDB').mockReturnValue(db as unknown as dbModule.D1Database);
    (globalThis as Record<string, unknown>).DB = db;
  });

  afterEach(() => {
    process.env.APP_ENV = originalAppEnv;
    delete (globalThis as Record<string, unknown>).DB;
    jest.restoreAllMocks();
    sqlite.close();
  });

  describe('F-02: Nonce-based Content-Security-Policy & Hardened Response Headers', () => {
    it('emits per-request cryptographic nonce CSP with strict-dynamic and zero script-src unsafe-inline or unsafe-eval', () => {
      const nonceA = generateCspNonce();
      const nonceB = generateCspNonce();
      expect(nonceA).not.toBe(nonceB);
      expect(nonceA.length).toBeGreaterThanOrEqual(16);

      const csp = buildContentSecurityPolicy({ nonce: nonceA, pathname: '/en/dashboard' });
      const directives = Object.fromEntries(
        csp.split(';').map((part) => {
          const [name, ...rest] = part.trim().split(/\s+/);
          return [name, rest.join(' ')];
        })
      );

      expect(directives['script-src']).toContain(`'nonce-${nonceA}'`);
      expect(directives['script-src']).toContain(`'strict-dynamic'`);
      expect(directives['script-src']).not.toContain(`'unsafe-inline'`);
      expect(directives['script-src']).not.toContain(`'unsafe-eval'`);
      expect(directives['object-src']).toBe(`'none'`);
      expect(directives['base-uri']).toBe(`'self'`);
      expect(directives['form-action']).toBe(`'self'`);
      expect(directives['frame-ancestors']).toBe(`'none'`);
    });

    it('restricts frame-ancestors to Telegram Web only on /en/telegram/app while keeping XFO DENY everywhere else', async () => {
      const dashReq = new NextRequest(
        'https://apex-os.agencyos-openclaw.workers.dev/en/dashboard'
      );
      const dashRes = await middleware(dashReq);
      expect(dashRes.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(dashRes.headers.get('X-Frame-Options')).toBe('DENY');
      expect(dashRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(dashRes.headers.get('Strict-Transport-Security')).toContain('max-age=63072000');

      const tgReq = new NextRequest(
        'https://apex-os.agencyos-openclaw.workers.dev/en/telegram/app'
      );
      const tgRes = await middleware(tgReq);
      expect(tgRes.headers.get('Content-Security-Policy')).toContain(
        "frame-ancestors 'self' https://web.telegram.org"
      );
      expect(tgRes.headers.get('X-Frame-Options')).toBeNull();
    });
  });

  describe('F-03: Persistent Cloudflare D1 Atomic Rate Limiting Across Isolates', () => {
    it('persists counters in SQLite/D1 rate_limits table, resets cleanly after window expiry, and fails closed in production when D1 is unavailable', async () => {
      const baseNow = 1_760_000_000_000;

      for (let i = 1; i <= 3; i++) {
        const res = await enforcePersistentD1RateLimit(db as unknown as dbModule.D1Database, {
          endpointType: 'auth_identifier',
          identifier: 'Trader@Example.com',
          maxRequests: 3,
          windowSeconds: 60,
          nowMs: baseNow + i * 100,
        });
        expect(res.allowed).toBe(true);
        expect(res.source).toBe('d1');
        expect(res.currentCount).toBe(i);
      }

      // 4th attempt inside the 60s window must be blocked from persistent SQLite row
      const blocked = await enforcePersistentD1RateLimit(db as unknown as dbModule.D1Database, {
        endpointType: 'auth_identifier',
        identifier: 'trader@example.com',
        maxRequests: 3,
        windowSeconds: 60,
        nowMs: baseNow + 1_000,
      });
      expect(blocked.allowed).toBe(false);
      expect(blocked.status).toBe(429);
      expect(blocked.errorCode).toBe('RATE_LIMITED');

      const persistedRow = sqlite
        .prepare('SELECT current_count FROM rate_limits WHERE key = ?')
        .get('d1rl:auth_identifier:trader@example.com') as { current_count: number } | undefined;
      expect(persistedRow?.current_count).toBe(4);

      // After 61 seconds, atomic CASE expression resets window to 1 in a single statement
      const afterExpiry = await enforcePersistentD1RateLimit(
        db as unknown as dbModule.D1Database,
        {
          endpointType: 'auth_identifier',
          identifier: 'trader@example.com',
          maxRequests: 3,
          windowSeconds: 60,
          nowMs: baseNow + 62_000,
        }
      );
      expect(afterExpiry.allowed).toBe(true);
      expect(afterExpiry.currentCount).toBe(1);

      // Fail-closed 503 in production when D1 binding is missing
      process.env.APP_ENV = 'production';
      const failClosed = await enforcePersistentD1RateLimit(null, {
        endpointType: 'auth_ip',
        identifier: '203.0.113.10',
        maxRequests: 5,
        windowSeconds: 60,
      });
      expect(failClosed.allowed).toBe(false);
      expect(failClosed.status).toBe(503);
      expect(failClosed.errorCode).toBe('RATE_LIMIT_STORE_UNAVAILABLE');
    });

    it('enforces persistent D1 rate limit on POST /api/affiliate/short-links and ignores spoofed X-Forwarded-Host', async () => {
      const firstReq = new NextRequest(
        'https://apex-os.agencyos-openclaw.workers.dev/api/affiliate/short-links',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'better-auth.session_token=tok_sec_valid',
            Origin: 'https://apex-os.agencyos-openclaw.workers.dev',
            'X-Forwarded-Host': 'evil-phishing.example',
            'CF-Connecting-IP': '198.51.100.42',
          },
          body: JSON.stringify({
            exchange: 'bybit',
            destinationUrl: 'https://partner.bybit.com/b/APEX01',
            customCode: 'safe_bybit01',
          }),
        }
      );
      const firstRes = await shortLinksPost(firstReq);
      expect(firstRes.status).toBe(201);
      const firstJson = await firstRes.json();
      expect(firstJson.shortLink.shortUrl).toBe(
        'https://apex-os.agencyos-openclaw.workers.dev/r/safe_bybit01'
      );
      expect(firstJson.shortLink.shortUrl).not.toContain('evil-phishing.example');

      // Exhaust remaining 14 user requests in the 60s window (limit = 15)
      for (let i = 2; i <= 15; i++) {
        const req = new NextRequest(
          'https://apex-os.agencyos-openclaw.workers.dev/api/affiliate/short-links',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: 'better-auth.session_token=tok_sec_valid',
              Origin: 'https://apex-os.agencyos-openclaw.workers.dev',
              'CF-Connecting-IP': `198.51.100.${i}`, // rotate IP as an attacker would; user D1 limit still catches it
            },
            body: JSON.stringify({
              exchange: 'bybit',
              destinationUrl: 'https://partner.bybit.com/b/APEX01',
              customCode: `safe_bybit_${i}`,
            }),
          }
        );
        const res = await shortLinksPost(req);
        expect(res.status).toBe(201);
      }

      const sixteenthReq = new NextRequest(
        'https://apex-os.agencyos-openclaw.workers.dev/api/affiliate/short-links',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'better-auth.session_token=tok_sec_valid',
            Origin: 'https://apex-os.agencyos-openclaw.workers.dev',
            'CF-Connecting-IP': '198.51.100.250',
          },
          body: JSON.stringify({
            exchange: 'bybit',
            destinationUrl: 'https://partner.bybit.com/b/APEX01',
            customCode: 'safe_bybit_16',
          }),
        }
      );
      const sixteenthRes = await shortLinksPost(sixteenthReq);
      expect(sixteenthRes.status).toBe(429);
    });

    it('enforces persistent D1 rate limit on GET /r/[code] after 60 redirects per IP per minute', async () => {
      for (let i = 1; i <= 60; i++) {
        const req = new NextRequest(
          'https://apex-os.agencyos-openclaw.workers.dev/r/sec_bybit1',
          {
            headers: {
              'CF-Connecting-IP': '203.0.113.77',
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            },
          }
        );
        const res = await shortLinkRedirectGet(req, {
          params: Promise.resolve({ code: 'sec_bybit1' }),
        });
        expect(res.status).toBe(302);
      }

      const blockedReq = new NextRequest(
        'https://apex-os.agencyos-openclaw.workers.dev/r/sec_bybit1',
        {
          headers: {
            'CF-Connecting-IP': '203.0.113.77',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          },
        }
      );
      const blockedRes = await shortLinkRedirectGet(blockedReq, {
        params: Promise.resolve({ code: 'sec_bybit1' }),
      });
      expect(blockedRes.status).toBe(429);
    });
  });

  describe('F-04: Cross-Site Request Forgery (Origin / Referer / Sec-Fetch-Site) Defense', () => {
    it('blocks cross-origin and sibling workers.dev tenant mutations with 403 on direct route handlers and middleware', async () => {
      const evilUidReq = new NextRequest(
        'https://apex-os.agencyos-openclaw.workers.dev/api/affiliate/uids',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'better-auth.session_token=tok_sec_valid',
            Origin: 'https://evil-attacker.example',
            'Sec-Fetch-Site': 'cross-site',
          },
          body: JSON.stringify({ exchange: 'okx', exchangeUid: '12345678' }),
        }
      );
      const evilUidRes = await uidsPost(evilUidReq);
      expect(evilUidRes.status).toBe(403);

      // Sibling *.workers.dev tenant sends Sec-Fetch-Site: same-site or cross-site with different Origin
      const siblingPasskeyReq = new NextRequest(
        'https://apex-os.agencyos-openclaw.workers.dev/api/admin/passkey',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'better-auth.session_token=tok_sec_valid',
            Origin: 'https://attacker-tenant.agencyos-openclaw.workers.dev',
            'Sec-Fetch-Site': 'same-site',
          },
          body: JSON.stringify({ action: 'stepup-options' }),
        }
      );
      const siblingPasskeyRes = await adminPasskeyPost(siblingPasskeyReq);
      expect(siblingPasskeyRes.status).toBe(403);

      // Cookie-authenticated mutation missing Origin & Referer in edge middleware fails closed (403)
      const missingOriginEdgeReq = new NextRequest(
        'https://apex-os.agencyos-openclaw.workers.dev/api/affiliate/short-links',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'better-auth.session_token=tok_sec_valid',
          },
          body: JSON.stringify({}),
        }
      );
      const missingOriginEdgeRes = await middleware(missingOriginEdgeReq);
      expect(missingOriginEdgeRes.status).toBe(403);
    });

    it('permits same-origin mutations and signed machine-to-machine webhook paths', () => {
      const sameOriginReq = new NextRequest(
        'https://apex-os.agencyos-openclaw.workers.dev/api/affiliate/uids',
        {
          method: 'POST',
          headers: {
            Cookie: 'better-auth.session_token=tok_sec_valid',
            Origin: 'https://apex-os.agencyos-openclaw.workers.dev',
            'Sec-Fetch-Site': 'same-origin',
          },
        }
      );
      expect(
        verifyTrustedMutationOrigin(sameOriginReq, { requireOriginWhenCookiePresent: true }).allowed
      ).toBe(true);

      const webhookReq = new NextRequest(
        'https://apex-os.agencyos-openclaw.workers.dev/api/webhooks/exchange',
        {
          method: 'POST',
          headers: {
            'X-Webhook-Signature': 'sha256=deadbeef',
          },
        }
      );
      expect(
        verifyTrustedMutationOrigin(webhookReq, { requireOriginWhenCookiePresent: true }).allowed
      ).toBe(true);
    });
  });
});
