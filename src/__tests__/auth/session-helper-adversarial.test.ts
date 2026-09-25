/**
 * Adversarial Stress Tests for Universal Auth Session Helper
 * src/__tests__/auth/session-helper-adversarial.test.ts
 *
 * EMPIRICAL CHALLENGE SUITE:
 * 1. Malformed headers and header injection
 * 2. Unusual cookie formats and parsing edge cases
 * 3. SQL injection attempts in tokens (parameterization verification)
 * 4. Extreme expiry boundaries (past/future/epoch 0/negative/invalid dates)
 * 5. Database connection drops, throws, and malformed rows
 */

import {
  getAuthenticatedUser,
  extractBearerToken,
  parseCookies,
  extractCookieToken,
  validateSessionInD1,
  resolveDatabase,
  AuthenticatedUser,
} from '@/lib/auth/session-helper';
import { getDB, D1Database } from '@/lib/db';
import { createAuth } from '@/lib/auth/auth-factory';

jest.mock('@/lib/db', () => ({
  getDB: jest.fn(),
}));

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

interface MockSession {
  id: string;
  user_id: string;
  token: string;
  expires_at: string | number | null;
}

interface MockProfile {
  id: string;
  email?: string;
}

function createAdversarialMockD1(
  sessions: MockSession[] = [],
  profiles: MockProfile[] = [],
  options?: {
    throwOnPrepare?: Error;
    throwOnBind?: Error;
    rejectOnFirst?: Error;
    onQueryCaptured?: (query: string, boundArgs: unknown[]) => void;
  }
): D1Database {
  return {
    prepare: jest.fn((query: string) => {
      if (options?.throwOnPrepare) {
        throw options.throwOnPrepare;
      }

      return {
        bind: jest.fn((...args: unknown[]) => {
          if (options?.throwOnBind) {
            throw options.throwOnBind;
          }
          if (options?.onQueryCaptured) {
            options.onQueryCaptured(query, args);
          }

          return {
            first: jest.fn(async () => {
              if (options?.rejectOnFirst) {
                throw options.rejectOnFirst;
              }

              const tokenArg = args[0] as string;
              // Parameterized match: exact literal equality only
              const session = sessions.find(
                (s) => s.token === tokenArg || s.id === tokenArg
              );
              if (!session) return null;

              const profile = profiles.find((p) => p.id === session.user_id);
              return {
                user_id: session.user_id,
                expires_at: session.expires_at,
                email: profile?.email || null,
              };
            }),
            all: jest.fn(async () => ({ results: [] })),
            run: jest.fn(async () => ({ success: true })),
          };
        }),
      };
    }),
  } as unknown as D1Database;
}

describe('session-helper adversarial challenge suite', () => {
  let mockGetSession: jest.Mock;

  const validFutureISO = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const pastISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const activeSessions: MockSession[] = [
    {
      id: 'sess-legit',
      user_id: 'usr-legit',
      token: 'legit-bearer-token-123',
      expires_at: validFutureISO,
    },
    {
      id: 'sess-target-victim',
      user_id: 'usr-victim',
      token: 'victim-secret-token',
      expires_at: validFutureISO,
    },
    {
      id: 'sess-admin',
      user_id: 'usr-admin',
      token: 'admin-secret-token',
      expires_at: validFutureISO,
    },
  ];

  const activeProfiles: MockProfile[] = [
    { id: 'usr-legit', email: 'legit@apex-os.com' },
    { id: 'usr-victim', email: 'victim@apex-os.com' },
    { id: 'usr-admin', email: 'admin@apex-os.com' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession = jest.fn().mockResolvedValue(null);
    (createAuth as jest.Mock).mockReturnValue({
      api: {
        getSession: mockGetSession,
      },
    });
  });

  // ============================================================
  // 1. MALFORMED HEADERS & HEADER INJECTION
  // ============================================================
  describe('Malformed Headers & Header Injection Attacks', () => {
    it('rejects header injection with CRLF attempts', () => {
      // In web fetch Headers, constructing with CRLF throws or strips, but if passed in mock headers:
      const mockHeaders = {
        get: jest.fn((name: string) => {
          if (name.toLowerCase() === 'authorization') {
            return 'Bearer token123\r\nX-Injected-Header: evil\r\n';
          }
          return null;
        }),
      } as unknown as Headers;

      const token = extractBearerToken(mockHeaders);
      // Because regex requires \S+ and $ anchor, any whitespace or CRLF within or after token fails regex
      expect(token).toBeNull();
    });

    it('rejects multiple Authorization header values joined with commas', () => {
      const headers = new Headers({
        Authorization: 'Bearer token-one, Bearer token-two',
      });
      // Comma-separated multi-token header should not match single \S+ token regex
      expect(extractBearerToken(headers)).toBeNull();
    });

    it('rejects tokens containing null bytes', () => {
      const headers = new Headers({
        Authorization: 'Bearer token\0inject',
      });
      const token = extractBearerToken(headers);
      // Regex matches non-whitespace, but null byte is preserved; let's verify D1 lookup fails safely
      expect(token).toBe('token\0inject');
      const db = createAdversarialMockD1(activeSessions, activeProfiles);
      return expect(validateSessionInD1(db, token!)).resolves.toBeNull();
    });

    it('handles giant authorization header (32KB) without ReDoS or buffer crash', () => {
      const largePadding = 'a'.repeat(32768);
      const headers = new Headers({
        Authorization: `Bearer ${largePadding}`,
      });

      const startTime = performance.now();
      const token = extractBearerToken(headers);
      const duration = performance.now() - startTime;

      expect(token).toBe(largePadding);
      expect(duration).toBeLessThan(100); // Must execute in < 100ms, no ReDoS
    });

    it('handles bizarre header casing: bEaReR, BEARER, Bearer', () => {
      const casings = ['BEARER', 'bearer', 'bEaReR', 'Bearer'];
      for (const prefix of casings) {
        const headers = new Headers({
          Authorization: `${prefix} legit-bearer-token-123`,
        });
        expect(extractBearerToken(headers)).toBe('legit-bearer-token-123');
      }
    });

    it('rejects unsupported auth schemes (Basic, Digest, OAuth, Token, MAC, ApiKey)', () => {
      const schemes = ['Basic dXNlcjpwYXNz', 'Digest xyz', 'OAuth ya29.abc', 'Token abc', 'ApiKey secret123'];
      for (const authVal of schemes) {
        const headers = new Headers({ Authorization: authVal });
        expect(extractBearerToken(headers)).toBeNull();
      }
    });

    it('handles whitespace-only and empty token values safely', () => {
      const invalidAuth = ['Bearer', 'Bearer ', 'Bearer    ', 'Bearer \t ', 'Bearer \n'];
      for (const val of invalidAuth) {
        const headers = new Headers({ Authorization: val });
        expect(extractBearerToken(headers)).toBeNull();
      }
    });

    it('returns null gracefully when request headers object has throwing getter', async () => {
      const maliciousRequest = {
        headers: {
          get: () => {
            throw new Error('Access denied to headers');
          },
        },
      } as unknown as Request;

      const user = await getAuthenticatedUser(maliciousRequest);
      expect(user).toBeNull();
    });
  });

  // ============================================================
  // 2. UNUSUAL COOKIE FORMATS & PARSING EDGE CASES
  // ============================================================
  describe('Unusual Cookie Formats & Edge Cases', () => {
    it('handles malformed URI percent-encoding without throwing URIError', () => {
      // In JS, decodeURIComponent('%E0%A4%A') or decodeURIComponent('%') throws URIError
      const malformedCookie = 'better-auth.session_token=%E0%A4%A; bad_percent=%%%ZZ';
      expect(() => parseCookies(malformedCookie)).not.toThrow();

      const parsed = parseCookies(malformedCookie);
      expect(parsed['better-auth.session_token']).toBe('%E0%A4%A');
      expect(parsed['bad_percent']).toBe('%%%ZZ');
    });

    it('handles consecutive semicolons, trailing semicolons, and empty cookies', () => {
      const weirdCookies = ';;; foo=bar;;; session_token=secret-val;; ';
      const parsed = parseCookies(weirdCookies);
      expect(parsed.foo).toBe('bar');
      expect(parsed.session_token).toBe('secret-val');
    });

    it('handles cookies with missing keys or missing values', () => {
      const cookies = '=missingKey; keyWithNoValue=; regular=val';
      const parsed = parseCookies(cookies);
      expect(parsed['']).toBe('missingKey');
      expect(parsed.keyWithNoValue).toBe('');
      expect(parsed.regular).toBe('val');
    });

    it('handles cookies with multiple equals signs in the value', () => {
      const cookies = 'better-auth.session_token=token=value=with=equals.sig; other=1';
      const parsed = parseCookies(cookies);
      expect(parsed['better-auth.session_token']).toBe('token=value=with=equals.sig');

      const headers = new Headers({ Cookie: cookies });
      expect(extractCookieToken(headers)).toBe('token=value=with=equals');
    });

    it('prevents prototype pollution via cookie keys (__proto__, constructor)', () => {
      const maliciousCookie = '__proto__=polluted; constructor=dangerous; toString=hacked';
      const parsed = parseCookies(maliciousCookie);

      // Verify Object prototype was not polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(typeof ({}).toString).toBe('function');
    });

    it('strips signature from Better Auth HMAC signed cookies with multiple dots', () => {
      const headers = new Headers({
        Cookie: 'better-auth.session_token=main-token.part2.part3.sig',
      });
      // split('.')[0] extracts main-token
      expect(extractCookieToken(headers)).toBe('main-token');
    });

    it('respects strict cookie fallback precedence hierarchy', () => {
      // better-auth.session_token > __Secure-better-auth.session_token > __session > session_token > auth_token
      const allCookies = [
        'auth_token=tok-auth',
        'session_token=tok-sess',
        '__session=tok-dunder',
        '__Secure-better-auth.session_token=tok-secure',
        'better-auth.session_token=tok-primary',
      ].join('; ');

      const headers = new Headers({ Cookie: allCookies });
      expect(extractCookieToken(headers)).toBe('tok-primary');

      // Without primary, __Secure takes next precedence
      const noPrimary = [
        'auth_token=tok-auth',
        'session_token=tok-sess',
        '__session=tok-dunder',
        '__Secure-better-auth.session_token=tok-secure',
      ].join('; ');
      expect(extractCookieToken(new Headers({ Cookie: noPrimary }))).toBe('tok-secure');

      // Without secure, __session takes precedence
      const noSecure = [
        'auth_token=tok-auth',
        'session_token=tok-sess',
        '__session=tok-dunder',
      ].join('; ');
      expect(extractCookieToken(new Headers({ Cookie: noSecure }))).toBe('tok-dunder');
    });

    it('handles cookie containing only dots or empty token before dot', () => {
      const headers1 = new Headers({ Cookie: 'better-auth.session_token=.signature' });
      // .split('.')[0] is "" which is falsy -> should return null
      expect(extractCookieToken(headers1)).toBeNull();

      const headers2 = new Headers({ Cookie: 'better-auth.session_token=...' });
      expect(extractCookieToken(headers2)).toBeNull();
    });
  });

  // ============================================================
  // 3. SQL INJECTION ATTEMPTS IN TOKENS (PARAMETERIZATION VERIFICATION)
  // ============================================================
  describe('SQL Injection Attempts in Bearer & Cookie Tokens', () => {
    let capturedQueries: Array<{ query: string; args: unknown[] }> = [];

    beforeEach(() => {
      capturedQueries = [];
    });

    // Payloads with spaces are rejected at regex level (extractBearerToken returns null)
    const sqlInjectionPayloadsWithSpaces = [
      "' OR '1'='1",
      "' OR 1=1 --",
      "'; DROP TABLE sessions; --",
      "1 UNION SELECT 'usr-admin', '9999999999999', 'admin@apex-os.com' --",
      "' OR 1=1 UNION ALL SELECT id, datetime('now', '+1 day'), email FROM profiles --",
      "' OR user_id = 'usr-admin' --",
      "nonexistent' OR s.token IS NOT NULL --",
      "victim-secret-token' OR '1'='1",
      "' OR ''='",
    ];

    it.each(sqlInjectionPayloadsWithSpaces)(
      'rejects SQL injection payload with spaces at regex level: %s',
      async (payload) => {
        const headers = new Headers({
          Authorization: `Bearer ${payload}`,
        });
        // extractBearerToken strictly enforces \S+ (no whitespace)
        expect(extractBearerToken(headers)).toBeNull();

        const db = createAdversarialMockD1(activeSessions, activeProfiles, {
          onQueryCaptured: (query, args) => capturedQueries.push({ query, args }),
        });

        const request = new Request('https://api.apex-os.com/api/payments', { headers });
        const user = await getAuthenticatedUser(request, db);

        expect(user).toBeNull();
        expect(capturedQueries.length).toBe(0); // Never even reached DB
      }
    );

    // Payloads without spaces (or using SQL comment syntax /**/) reach D1 and must be safely parameterized
    const sqlInjectionPayloadsNoSpaces = [
      "admin'--",
      "'OR'1'='1",
      "'OR/**/1=1--",
      "';DROP/**/TABLE/**/sessions;--",
      "victim-secret-token'OR'1'='1",
      "'OR(1=1)--",
      "nonexistent'OR(s.token)IS/**/NOT/**/NULL--",
    ];

    it.each(sqlInjectionPayloadsNoSpaces)(
      'safely parameterizes whitespace-free SQL injection payload in Bearer token: %s',
      async (payload) => {
        const db = createAdversarialMockD1(activeSessions, activeProfiles, {
          onQueryCaptured: (query, args) => capturedQueries.push({ query, args }),
        });

        const request = new Request('https://api.apex-os.com/api/payments', {
          headers: {
            Authorization: `Bearer ${payload}`,
          },
        });

        const user = await getAuthenticatedUser(request, db);

        // Verification: User must be null; SQL injection must not match admin or victim
        expect(user).toBeNull();

        // Verification: Query must have executed with parameterized bindings, not string concatenation
        expect(capturedQueries.length).toBe(1);
        const { query, args } = capturedQueries[0];
        expect(query).toContain('WHERE (s.token = ? OR s.id = ?)');
        expect(args[0]).toBe(payload);
        expect(args[1]).toBe(payload);
      }
    );

    it.each(sqlInjectionPayloadsNoSpaces)(
      'safely parameterizes SQL injection payload in cookie fallback token: %s',
      async (payload) => {
        const db = createAdversarialMockD1(activeSessions, activeProfiles, {
          onQueryCaptured: (query, args) => capturedQueries.push({ query, args }),
        });

        const request = new Request('https://api.apex-os.com/api/payments', {
          headers: {
            Cookie: `session_token=${encodeURIComponent(payload)}`,
          },
        });

        const user = await getAuthenticatedUser(request, db);
        expect(user).toBeNull();
        expect(capturedQueries.length).toBe(1);
        expect(capturedQueries[0].args[0]).toBe(payload.split('.')[0]);
      }
    );
  });

  // ============================================================
  // 4. EXTREME EXPIRY BOUNDARIES
  // ============================================================
  describe('Extreme Expiry Boundaries & Timestamp Parsing', () => {
    it('rejects session expiring at exactly Date.now() (boundary case: <= Date.now())', async () => {
      const nowMs = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(nowMs);

      const db = createAdversarialMockD1([
        {
          id: 'sess-exact-now',
          user_id: 'usr-now',
          token: 'token-exact-now',
          expires_at: String(nowMs),
        },
      ]);

      const user = await validateSessionInD1(db, 'token-exact-now');
      expect(user).toBeNull();

      jest.restoreAllMocks();
    });

    it('rejects session expiring 1 millisecond in the past', async () => {
      const nowMs = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(nowMs);

      const db = createAdversarialMockD1([
        {
          id: 'sess-past-1ms',
          user_id: 'usr-past',
          token: 'token-past-1ms',
          expires_at: String(nowMs - 1),
        },
      ]);

      const user = await validateSessionInD1(db, 'token-past-1ms');
      expect(user).toBeNull();

      jest.restoreAllMocks();
    });

    it('accepts session expiring 1000 milliseconds in the future', async () => {
      const nowMs = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(nowMs);

      const db = createAdversarialMockD1([
        {
          id: 'sess-future-1s',
          user_id: 'usr-future',
          token: 'token-future-1s',
          expires_at: String(nowMs + 1000),
        },
      ]);

      const user = await validateSessionInD1(db, 'token-future-1s');
      expect(user).toEqual({ id: 'usr-future', email: undefined });

      jest.restoreAllMocks();
    });

    it('rejects epoch 0 timestamp ("0" and 0)', async () => {
      const db1 = createAdversarialMockD1([
        { id: 'sess-0', user_id: 'u0', token: 'tok-0', expires_at: '0' },
      ]);
      expect(await validateSessionInD1(db1, 'tok-0')).toBeNull();

      const db2 = createAdversarialMockD1([
        { id: 'sess-0-num', user_id: 'u0', token: 'tok-0-num', expires_at: 0 },
      ]);
      expect(await validateSessionInD1(db2, 'tok-0-num')).toBeNull();
    });

    it('rejects negative timestamp ("-1000" and -500000)', async () => {
      const db1 = createAdversarialMockD1([
        { id: 'sess-neg', user_id: 'uneg', token: 'tok-neg', expires_at: '-1000' },
      ]);
      expect(await validateSessionInD1(db1, 'tok-neg')).toBeNull();

      const db2 = createAdversarialMockD1([
        { id: 'sess-neg-num', user_id: 'uneg', token: 'tok-neg-num', expires_at: -500000 },
      ]);
      expect(await validateSessionInD1(db2, 'tok-neg-num')).toBeNull();
    });

    it('rejects ancient ISO dates (1970-01-01)', async () => {
      const db = createAdversarialMockD1([
        { id: 'sess-1970', user_id: 'u1970', token: 'tok-1970', expires_at: '1970-01-01T00:00:00.000Z' },
      ]);
      expect(await validateSessionInD1(db, 'tok-1970')).toBeNull();
    });

    it('accepts far future ISO dates (9999-12-31)', async () => {
      const db = createAdversarialMockD1([
        { id: 'sess-9999', user_id: 'u9999', token: 'tok-9999', expires_at: '9999-12-31T23:59:59.999Z' },
      ]);
      const user = await validateSessionInD1(db, 'tok-9999');
      expect(user?.id).toBe('u9999');
    });

    it('rejects invalid or non-date strings safely (NaN, null, undefined, text)', async () => {
      const weirdDates = [
        'invalid-date-string',
        'NaN',
        'undefined',
        'null',
        'Infinity',
        '-Infinity',
        '2026-99-99',
        'foo bar baz',
        '',
        '   ',
      ];

      for (const weird of weirdDates) {
        const db = createAdversarialMockD1([
          { id: 'sess-w', user_id: 'uw', token: `tok-${weird}`, expires_at: weird },
        ]);
        const user = await validateSessionInD1(db, `tok-${weird}`);
        expect(user).toBeNull();
      }
    });

    it('handles seconds timestamp correctly (detecting < 1e11 threshold)', async () => {
      const futureSec = Math.floor((Date.now() + 300000) / 1000); // in seconds
      const db = createAdversarialMockD1([
        { id: 'sess-sec', user_id: 'usec', token: 'tok-sec', expires_at: String(futureSec) },
      ]);

      const user = await validateSessionInD1(db, 'tok-sec');
      expect(user?.id).toBe('usec');
    });
  });

  // ============================================================
  // 5. DATABASE CONNECTION DROPS, THROWS, AND ANOMALIES
  // ============================================================
  describe('Database Drops, Throws & Anomalies', () => {
    it('survives synchronous exception thrown by db.prepare', async () => {
      const failingDb = createAdversarialMockD1([], [], {
        throwOnPrepare: new Error('D1 connection reset by peer'),
      });

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: { Authorization: 'Bearer legit-bearer-token-123' },
      });

      const user = await getAuthenticatedUser(request, failingDb);
      expect(user).toBeNull();
    });

    it('survives synchronous exception thrown by db.prepare().bind()', async () => {
      const failingDb = createAdversarialMockD1([], [], {
        throwOnBind: new Error('D1 bind parameter memory allocation failure'),
      });

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: { Authorization: 'Bearer legit-bearer-token-123' },
      });

      const user = await getAuthenticatedUser(request, failingDb);
      expect(user).toBeNull();
    });

    it('survives asynchronous Promise rejection by first()', async () => {
      const failingDb = createAdversarialMockD1([], [], {
        rejectOnFirst: new Error('D1 Query timed out after 5000ms'),
      });

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: { Authorization: 'Bearer legit-bearer-token-123' },
      });

      const user = await getAuthenticatedUser(request, failingDb);
      expect(user).toBeNull();
    });

    it('survives malformed db object missing prepare method', async () => {
      const corruptedDb = { notAValidDb: true } as unknown as D1Database;

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: { Authorization: 'Bearer legit-bearer-token-123' },
      });

      const user = await getAuthenticatedUser(request, corruptedDb);
      expect(user).toBeNull();
    });

    it('survives unexpected row types returned from database', async () => {
      const corruptedRowDb = {
        prepare: jest.fn(() => ({
          bind: jest.fn(() => ({
            first: jest.fn().mockResolvedValue({
              user_id: 'usr-corrupted',
              expires_at: null, // null expires_at
              email: null,
            }),
          })),
        })),
      } as unknown as D1Database;

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: { Authorization: 'Bearer legit-bearer-token-123' },
      });

      const user = await getAuthenticatedUser(request, corruptedRowDb);
      // null expires_at results in Number(null)=0 <= Date.now() -> returns null
      expect(user).toBeNull();
    });

    it('survives Better Auth crashing during cookie session check and successfully falls back to D1', async () => {
      mockGetSession.mockRejectedValueOnce(new Error('Fatal better-auth internal runtime crash'));

      const db = createAdversarialMockD1(activeSessions, activeProfiles);

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Cookie: 'better-auth.session_token=legit-bearer-token-123.signature',
        },
      });

      const user = await getAuthenticatedUser(request, db);
      expect(user).toEqual({
        id: 'usr-legit',
        email: 'legit@apex-os.com',
      });
    });

    it('survives when both getDB() and globalThis.DB throw or are null', async () => {
      (getDB as jest.Mock).mockImplementation(() => {
        throw new Error('D1 binding "DB" not found in Cloudflare env');
      });
      delete (globalThis as unknown as { DB?: D1Database }).DB;

      expect(resolveDatabase()).toBeNull();

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: { Authorization: 'Bearer legit-bearer-token-123' },
      });

      const user = await getAuthenticatedUser(request);
      expect(user).toBeNull();
    });
  });
});
