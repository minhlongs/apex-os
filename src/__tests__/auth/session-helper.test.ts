/**
 * Unit Tests for Universal Auth Session Helper
 * src/__tests__/auth/session-helper.test.ts
 */

import {
  getAuthenticatedUser,
  extractBearerToken,
  parseCookies,
  extractCookieToken,
  validateSessionInD1,
  validateSessionWithBetterAuth,
  resolveDatabase,
  AuthenticatedUser,
} from '@/lib/auth/session-helper';
import { getDB, D1Database } from '@/lib/db';
import { createAuth } from '@/lib/auth/auth-factory';

// Mock dependencies
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
  expires_at: string;
}

interface MockProfile {
  id: string;
  email?: string;
}

function createMockD1Database(
  sessions: MockSession[] = [],
  profiles: MockProfile[] = []
): D1Database {
  return {
    prepare: jest.fn((query: string) => {
      let boundArgs: unknown[] = [];
      return {
        bind: jest.fn((...args: unknown[]) => {
          boundArgs = args;
          return {
            first: jest.fn(async () => {
              const tokenArg = boundArgs[0] as string;
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

describe('session-helper', () => {
  let mockDb: D1Database;
  let mockGetSession: jest.Mock;

  const validFutureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const expiredPastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const sampleSessions: MockSession[] = [
    {
      id: 'sess-id-1',
      user_id: 'usr-1',
      token: 'valid-token-123',
      expires_at: validFutureDate,
    },
    {
      id: 'sess-id-2',
      user_id: 'usr-2',
      token: 'expired-token-456',
      expires_at: expiredPastDate,
    },
    {
      id: 'sess-id-3',
      user_id: 'usr-no-profile',
      token: 'token-no-profile',
      expires_at: validFutureDate,
    },
    {
      id: 'sess-id-numeric-ms',
      user_id: 'usr-numeric-ms',
      token: 'token-numeric-ms',
      expires_at: String(Date.now() + 100000),
    },
    {
      id: 'sess-id-numeric-sec',
      user_id: 'usr-numeric-sec',
      token: 'token-numeric-sec',
      expires_at: String(Math.floor((Date.now() + 100000) / 1000)),
    },
  ];

  const sampleProfiles: MockProfile[] = [
    { id: 'usr-1', email: 'user1@example.com' },
    { id: 'usr-2', email: 'user2@example.com' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    mockDb = createMockD1Database(sampleSessions, sampleProfiles);
    (getDB as jest.Mock).mockReturnValue(mockDb);

    mockGetSession = jest.fn().mockResolvedValue(null);
    (createAuth as jest.Mock).mockReturnValue({
      api: {
        getSession: mockGetSession,
      },
    });
  });

  describe('extractBearerToken', () => {
    it('extracts token from standard Authorization: Bearer header', () => {
      const headers = new Headers({ Authorization: 'Bearer test-token-123' });
      expect(extractBearerToken(headers)).toBe('test-token-123');
    });

    it('extracts token case-insensitively', () => {
      const headers = new Headers({ authorization: 'bearer test-token-123' });
      expect(extractBearerToken(headers)).toBe('test-token-123');
    });

    it('returns null if Authorization header is missing', () => {
      const headers = new Headers();
      expect(extractBearerToken(headers)).toBeNull();
    });

    it('returns null for Basic auth header', () => {
      const headers = new Headers({ Authorization: 'Basic dXNlcjpwYXNz' });
      expect(extractBearerToken(headers)).toBeNull();
    });

    it('returns null for empty Bearer token', () => {
      const headers = new Headers({ Authorization: 'Bearer ' });
      expect(extractBearerToken(headers)).toBeNull();
    });
  });

  describe('parseCookies', () => {
    it('parses single and multiple cookies', () => {
      const result = parseCookies('foo=bar; hello=world; test=123');
      expect(result).toEqual({ foo: 'bar', hello: 'world', test: '123' });
    });

    it('handles url-encoded cookie values', () => {
      const result = parseCookies('email=user%40example.com; token=abc%20123');
      expect(result).toEqual({ email: 'user@example.com', token: 'abc 123' });
    });

    it('handles empty or malformed strings safely', () => {
      expect(parseCookies('')).toEqual({});
      expect(parseCookies('invalid-no-equal; =emptyKey; normal=val')).toEqual({
        '': 'emptyKey',
        normal: 'val',
      });
    });
  });

  describe('extractCookieToken', () => {
    it('extracts better-auth.session_token and strips signature', () => {
      const headers = new Headers({
        Cookie: 'better-auth.session_token=raw-token-123.sig987654',
      });
      expect(extractCookieToken(headers)).toBe('raw-token-123');
    });

    it('extracts raw token without signature', () => {
      const headers = new Headers({
        Cookie: 'better-auth.session_token=raw-token-123',
      });
      expect(extractCookieToken(headers)).toBe('raw-token-123');
    });

    it('supports __Secure-better-auth.session_token prefix', () => {
      const headers = new Headers({
        Cookie: '__Secure-better-auth.session_token=secure-token-123.sig',
      });
      expect(extractCookieToken(headers)).toBe('secure-token-123');
    });

    it('falls back to __session or session_token', () => {
      const headers1 = new Headers({ Cookie: '__session=fallback-session-token' });
      expect(extractCookieToken(headers1)).toBe('fallback-session-token');

      const headers2 = new Headers({ Cookie: 'session_token=legacy-session-token' });
      expect(extractCookieToken(headers2)).toBe('legacy-session-token');

      const headers3 = new Headers({ Cookie: 'auth_token=auth-token-val' });
      expect(extractCookieToken(headers3)).toBe('auth-token-val');
    });

    it('returns null if no cookie header present', () => {
      const headers = new Headers();
      expect(extractCookieToken(headers)).toBeNull();
    });
  });

  describe('validateSessionInD1', () => {
    it('returns user if token is valid and active', async () => {
      const user = await validateSessionInD1(mockDb, 'valid-token-123');
      expect(user).toEqual({
        id: 'usr-1',
        email: 'user1@example.com',
      });
    });

    it('returns user matching session id', async () => {
      const user = await validateSessionInD1(mockDb, 'sess-id-1');
      expect(user).toEqual({
        id: 'usr-1',
        email: 'user1@example.com',
      });
    });

    it('returns null if token is expired', async () => {
      const user = await validateSessionInD1(mockDb, 'expired-token-456');
      expect(user).toBeNull();
    });

    it('returns null if token not found in database', async () => {
      const user = await validateSessionInD1(mockDb, 'non-existent-token');
      expect(user).toBeNull();
    });

    it('handles numeric timestamps in ms and seconds', async () => {
      const userMs = await validateSessionInD1(mockDb, 'token-numeric-ms');
      expect(userMs?.id).toBe('usr-numeric-ms');

      const userSec = await validateSessionInD1(mockDb, 'token-numeric-sec');
      expect(userSec?.id).toBe('usr-numeric-sec');
    });

    it('returns user with undefined email if profile email is missing', async () => {
      const user = await validateSessionInD1(mockDb, 'token-no-profile');
      expect(user).toEqual({
        id: 'usr-no-profile',
        email: undefined,
      });
    });

    it('returns null gracefully on database error', async () => {
      const failingDb = {
        prepare: jest.fn().mockImplementation(() => {
          throw new Error('D1 execution failed');
        }),
      } as unknown as D1Database;

      const user = await validateSessionInD1(failingDb, 'valid-token-123');
      expect(user).toBeNull();
    });
  });

  describe('validateSessionWithBetterAuth', () => {
    it('returns user when Better Auth session is valid', async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: 'usr-ba', email: 'ba@example.com' },
      });

      const headers = new Headers({ Cookie: 'better-auth.session_token=test' });
      const user = await validateSessionWithBetterAuth(mockDb, headers);
      expect(user).toEqual({
        id: 'usr-ba',
        email: 'ba@example.com',
      });
    });

    it('returns null when Better Auth returns no user', async () => {
      mockGetSession.mockResolvedValueOnce(null);

      const headers = new Headers({ Cookie: 'better-auth.session_token=test' });
      const user = await validateSessionWithBetterAuth(mockDb, headers);
      expect(user).toBeNull();
    });

    it('catches Better Auth errors gracefully and returns null', async () => {
      mockGetSession.mockRejectedValueOnce(new Error('Better Auth runtime failure'));

      const headers = new Headers({ Cookie: 'better-auth.session_token=test' });
      const user = await validateSessionWithBetterAuth(mockDb, headers);
      expect(user).toBeNull();
    });
  });

  describe('resolveDatabase', () => {
    it('resolves database from getDB()', () => {
      const db = resolveDatabase();
      expect(db).toBe(mockDb);
      expect(getDB).toHaveBeenCalled();
    });

    it('falls back to globalThis.DB if getDB() throws', () => {
      (getDB as jest.Mock).mockImplementationOnce(() => {
        throw new Error('DB not initialized');
      });
      (globalThis as unknown as { DB: D1Database }).DB = mockDb;

      const db = resolveDatabase();
      expect(db).toBe(mockDb);

      delete (globalThis as unknown as { DB?: D1Database }).DB;
    });

    it('returns null if neither getDB() nor globalThis.DB are available', () => {
      (getDB as jest.Mock).mockImplementationOnce(() => {
        throw new Error('DB not initialized');
      });
      delete (globalThis as unknown as { DB?: D1Database }).DB;

      const db = resolveDatabase();
      expect(db).toBeNull();
    });
  });

  describe('getAuthenticatedUser', () => {
    it('authenticates mobile Bearer token via D1 session lookup', async () => {
      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Authorization: 'Bearer valid-token-123',
        },
      });

      const user: AuthenticatedUser | null = await getAuthenticatedUser(request);
      expect(user).toEqual({
        id: 'usr-1',
        email: 'user1@example.com',
      });
    });

    it('authenticates mobile Bearer token with lowercase header name', async () => {
      const request = new Request('https://api.apex-os.com/api/profile/wallet', {
        headers: {
          authorization: 'bearer valid-token-123',
        },
      });

      const user = await getAuthenticatedUser(request);
      expect(user).toEqual({
        id: 'usr-1',
        email: 'user1@example.com',
      });
    });

    it('returns null for expired mobile Bearer token', async () => {
      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Authorization: 'Bearer expired-token-456',
        },
      });

      const user = await getAuthenticatedUser(request);
      expect(user).toBeNull();
    });

    it('returns null for unknown Bearer token', async () => {
      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Authorization: 'Bearer unknown-token',
        },
      });

      const user = await getAuthenticatedUser(request);
      expect(user).toBeNull();
    });

    it('returns null for malformed Bearer header', async () => {
      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Authorization: 'Basic not-a-bearer',
        },
      });

      const user = await getAuthenticatedUser(request);
      expect(user).toBeNull();
    });

    it('authenticates web request when Better Auth verifies cookie session', async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: 'usr-ba-success', email: 'ba-user@example.com' },
      });

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Cookie: 'better-auth.session_token=ba-valid-session',
        },
      });

      const user = await getAuthenticatedUser(request);
      expect(user).toEqual({
        id: 'usr-ba-success',
        email: 'ba-user@example.com',
      });
    });

    it('falls back to D1 verification when Better Auth returns null on cookie', async () => {
      // Better Auth returns null
      mockGetSession.mockResolvedValueOnce(null);

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Cookie: 'better-auth.session_token=valid-token-123.sig999',
        },
      });

      const user = await getAuthenticatedUser(request);
      expect(user).toEqual({
        id: 'usr-1',
        email: 'user1@example.com',
      });
    });

    it('falls back to D1 verification when Better Auth throws an error on cookie', async () => {
      mockGetSession.mockRejectedValueOnce(new Error('Signature verification failed'));

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Cookie: 'better-auth.session_token=valid-token-123.invalid-sig',
        },
      });

      const user = await getAuthenticatedUser(request);
      expect(user).toEqual({
        id: 'usr-1',
        email: 'user1@example.com',
      });
    });

    it('authenticates with legacy __session cookie fallback', async () => {
      mockGetSession.mockResolvedValueOnce(null);

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Cookie: '__session=valid-token-123',
        },
      });

      const user = await getAuthenticatedUser(request);
      expect(user).toEqual({
        id: 'usr-1',
        email: 'user1@example.com',
      });
    });

    it('prioritizes valid Bearer token if Better Auth cookie verification fails', async () => {
      mockGetSession.mockResolvedValueOnce(null);

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Authorization: 'Bearer valid-token-123',
          Cookie: 'better-auth.session_token=invalid-cookie',
        },
      });

      const user = await getAuthenticatedUser(request);
      expect(user).toEqual({
        id: 'usr-1',
        email: 'user1@example.com',
      });
    });

    it('returns null when request has no Authorization and no Cookie headers', async () => {
      const request = new Request('https://api.apex-os.com/api/payments');
      const user = await getAuthenticatedUser(request);
      expect(user).toBeNull();
    });

    it('returns null safely when request is null or malformed', async () => {
      const user = await getAuthenticatedUser(null as unknown as Request);
      expect(user).toBeNull();
    });

    it('returns null safely when database is unavailable', async () => {
      (getDB as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Database not configured');
      });
      delete (globalThis as unknown as { DB?: D1Database }).DB;

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Authorization: 'Bearer valid-token-123',
        },
      });

      const user = await getAuthenticatedUser(request);
      expect(user).toBeNull();
    });

    it('supports dbOverride parameter for isolated testing', async () => {
      const customDb = createMockD1Database(
        [
          {
            id: 'custom-sess',
            user_id: 'custom-usr',
            token: 'custom-token',
            expires_at: validFutureDate,
          },
        ],
        [{ id: 'custom-usr', email: 'custom@example.com' }]
      );

      const request = new Request('https://api.apex-os.com/api/payments', {
        headers: {
          Authorization: 'Bearer custom-token',
        },
      });

      const user = await getAuthenticatedUser(request, customDb);
      expect(user).toEqual({
        id: 'custom-usr',
        email: 'custom@example.com',
      });
    });
  });
});
