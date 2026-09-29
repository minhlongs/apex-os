/**
 * __tests__/telegram/auth.test.ts
 *
 * Comprehensive test suite for Telegram Mini App (TMA) Authentication & Account Binding:
 * - POST /api/auth/telegram
 * - Input validation & edge cases (malformed JSON, missing/empty initData)
 * - Cryptographic verification & security rejections (tampered hash, wrong bot token, expired >24h, future clock skew)
 * - Unauthenticated TMA signup (synthetic email auto-provisioning, role, plan, tier, referral code, telegram_users row, session issuance)
 * - Idempotent repeated login (returns existing profile without duplicate email constraint violation)
 * - Pre-authenticated account linking (links existing ApexOS profile to telegram_users)
 * - Wallet address validation & binding (Ethereum, Solana, Stellar valid vs invalid formats, missing preferred_chain, unsupported chains)
 * - Viral referral attribution & deep linking (start_param ref_XYZ, referral_tree linking, direct referrals increment, self-referral prevention)
 * - Database unavailable error (HTTP 503) & production token error handling (HTTP 500)
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/telegram/route';
import { signTelegramInitData } from '@/lib/telegram/crypto';
import * as dbModule from '@/lib/db';
import type { D1Database } from '@/lib/db';

interface ProfileRecord {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: string;
  plan: string;
  tier: string;
  referral_code: string;
  referred_by: string | null;
  wallet_address: string | null;
  preferred_chain: string | null;
  kyc_status: string;
  kyc_tier: string;
  created_at: string;
  updated_at: string;
}

interface TelegramUserRecord {
  id: string;
  telegram_id: number;
  user_id: string | null;
  username: string | null;
  first_name: string;
  last_name: string | null;
  photo_url: string | null;
  language_code: string;
  is_premium: number;
  auth_date: number | null;
  last_active_at: string;
  created_at: string;
  updated_at: string;
}

interface SessionRecord {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  created_at: string;
}

interface TelegramReferralRecord {
  id: string;
  referrer_id: number | null;
  referee_id: number;
  referrer_user_id: string | null;
  referee_user_id: string | null;
  referral_code: string;
  status: string;
  reward_amount: number;
  reward_currency: string;
  created_at: string;
  updated_at: string;
}

interface ReferralTreeNode {
  id: string;
  affiliate_id: string;
  parent_id: string | null;
  root_id: string | null;
  level: number;
  path: string | null;
  total_direct_referrals: number;
  total_indirect_referrals: number;
  total_earnings: number;
  total_payouts: number;
  is_active: number;
  joined_at: string;
  updated_at: string;
}

interface AffiliateCodeRecord {
  id: string;
  affiliate_id: string;
  code: string;
}

/**
 * Creates a fully stateful in-memory Cloudflare D1 mock database
 */
function createMockD1Database() {
  const profiles = new Map<string, ProfileRecord>();
  const telegramUsers = new Map<number, TelegramUserRecord>();
  const sessions = new Map<string, SessionRecord>();
  const referrals = new Map<number, TelegramReferralRecord>();
  const referralTree = new Map<string, ReferralTreeNode>();
  const affiliateCodes = new Map<string, AffiliateCodeRecord>();

  const db: D1Database = {
    prepare: (query: string) => {
      let boundArgs: any[] = [];
      const trimmed = query.trim().replace(/\s+/g, ' ');

      const stmt = {
        bind: (...args: any[]) => {
          boundArgs = args;
          return stmt;
        },
        first: async <T = unknown>(): Promise<T | null> => {
          // 1. Session lookup (from session-helper)
          if (trimmed.includes('FROM sessions s LEFT JOIN profiles p ON s.user_id = p.id WHERE (s.token = ? OR s.id = ?)')) {
            const tokenOrId = boundArgs[0];
            for (const sess of sessions.values()) {
              if (sess.token === tokenOrId || sess.id === tokenOrId) {
                const prof = profiles.get(sess.user_id);
                return {
                  user_id: sess.user_id,
                  expires_at: sess.expires_at,
                  email: prof?.email || null,
                } as unknown as T;
              }
            }
            return null;
          }

          // 2. telegram_users by telegram_id
          if (trimmed.includes('FROM telegram_users WHERE telegram_id = ?')) {
            const tgId = Number(boundArgs[0]);
            const record = telegramUsers.get(tgId);
            return (record ? { ...record } : null) as unknown as T;
          }

          // 3. telegram_users by user_id
          if (trimmed.includes('FROM telegram_users WHERE user_id = ?')) {
            const userId = String(boundArgs[0]);
            for (const record of telegramUsers.values()) {
              if (record.user_id === userId) {
                return { ...record } as unknown as T;
              }
            }
            return null;
          }

          // 4. profiles by id
          if (trimmed.includes('FROM profiles WHERE id = ?')) {
            const pId = String(boundArgs[0]);
            const p = profiles.get(pId);
            return (p ? { ...p } : null) as unknown as T;
          }

          // 5. profiles by email
          if (trimmed.includes('FROM profiles WHERE email = ?')) {
            const email = String(boundArgs[0]);
            for (const p of profiles.values()) {
              if (p.email.toLowerCase() === email.toLowerCase()) {
                return { ...p } as unknown as T;
              }
            }
            return null;
          }

          // 6. profiles by referral_code
          if (trimmed.includes('FROM profiles WHERE UPPER(referral_code) = UPPER(?) OR UPPER(referral_code) = UPPER(?)')) {
            const code1 = String(boundArgs[0] || '').toUpperCase();
            const code2 = String(boundArgs[1] || '').toUpperCase();
            for (const p of profiles.values()) {
              if (p.referral_code.toUpperCase() === code1 || p.referral_code.toUpperCase() === code2) {
                return { id: p.id, referral_code: p.referral_code } as unknown as T;
              }
            }
            return null;
          }

          // 7. affiliate_codes lookup
          if (trimmed.includes('FROM affiliate_codes WHERE UPPER(code) = UPPER(?) OR UPPER(code) = UPPER(?)')) {
            const code1 = String(boundArgs[0] || '').toUpperCase();
            const code2 = String(boundArgs[1] || '').toUpperCase();
            for (const ac of affiliateCodes.values()) {
              if (ac.code.toUpperCase() === code1 || ac.code.toUpperCase() === code2) {
                return { id: ac.affiliate_id, referral_code: ac.code } as unknown as T;
              }
            }
            return null;
          }

          // 8. telegram_referrals by referee_id
          if (trimmed.includes('FROM telegram_referrals WHERE referee_id = ?')) {
            const refereeId = Number(boundArgs[0]);
            const ref = referrals.get(refereeId);
            return (ref ? { ...ref } : null) as unknown as T;
          }

          // 9. referral_tree by affiliate_id
          if (trimmed.includes('FROM referral_tree WHERE affiliate_id = ?')) {
            const affId = String(boundArgs[0]);
            const node = referralTree.get(affId);
            return (node ? { ...node } : null) as unknown as T;
          }

          return null;
        },
        all: async <T = unknown>(): Promise<{ results: T[] }> => {
          return { results: [] };
        },
        run: async (): Promise<{ success: boolean; meta?: any }> => {
          // 1. INSERT INTO profiles
          if (trimmed.startsWith('INSERT INTO profiles')) {
            const [id, email, fullName, avatarUrl, referralCode] = boundArgs;
            const newProfile: ProfileRecord = {
              id,
              email,
              full_name: fullName || null,
              avatar_url: avatarUrl || null,
              role: 'shopper',
              plan: 'free',
              tier: 'BASIC',
              referral_code: referralCode,
              referred_by: null,
              wallet_address: null,
              preferred_chain: null,
              kyc_status: 'unverified',
              kyc_tier: 'tier0_unverified',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            profiles.set(id, newProfile);
            return { success: true };
          }

          // 2. UPDATE profiles (wallet or referred_by)
          if (trimmed.startsWith('UPDATE profiles SET')) {
            if (trimmed.includes('wallet_address = ?')) {
              const [address, chain, id] = boundArgs;
              const p = profiles.get(id);
              if (p) {
                p.wallet_address = address;
                p.preferred_chain = chain;
                p.updated_at = new Date().toISOString();
              }
            } else if (trimmed.includes('referred_by = ?')) {
              const [referrerId, userId] = boundArgs;
              const p = profiles.get(userId);
              if (p && !p.referred_by) {
                p.referred_by = referrerId;
                p.updated_at = new Date().toISOString();
              }
            }
            return { success: true };
          }

          // 3. INSERT INTO telegram_users
          if (trimmed.startsWith('INSERT INTO telegram_users')) {
            const [
              id,
              telegramId,
              userId,
              username,
              firstName,
              lastName,
              photoUrl,
              languageCode,
              isPremium,
              authDate,
            ] = boundArgs;
            const newTgUser: TelegramUserRecord = {
              id,
              telegram_id: Number(telegramId),
              user_id: userId || null,
              username: username || null,
              first_name: firstName,
              last_name: lastName || null,
              photo_url: photoUrl || null,
              language_code: languageCode || 'en',
              is_premium: Number(isPremium) || 0,
              auth_date: Number(authDate) || null,
              last_active_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            telegramUsers.set(Number(telegramId), newTgUser);
            return { success: true };
          }

          // 4. UPDATE telegram_users
          if (trimmed.startsWith('UPDATE telegram_users SET')) {
            if (trimmed.includes('user_id = ?')) {
              const [
                userId,
                username,
                firstName,
                lastName,
                photoUrl,
                languageCode,
                isPremium,
                authDate,
                tgId,
              ] = boundArgs;
              const record = telegramUsers.get(Number(tgId));
              if (record) {
                record.user_id = userId;
                record.username = username || null;
                record.first_name = firstName;
                record.last_name = lastName || null;
                record.photo_url = photoUrl || null;
                record.language_code = languageCode || 'en';
                record.is_premium = Number(isPremium) || 0;
                record.auth_date = Number(authDate) || null;
                record.last_active_at = new Date().toISOString();
                record.updated_at = new Date().toISOString();
              }
            } else {
              const [
                username,
                firstName,
                lastName,
                photoUrl,
                languageCode,
                isPremium,
                authDate,
                tgId,
              ] = boundArgs;
              const record = telegramUsers.get(Number(tgId));
              if (record) {
                record.username = username || null;
                record.first_name = firstName;
                record.last_name = lastName || null;
                record.photo_url = photoUrl || null;
                record.language_code = languageCode || 'en';
                record.is_premium = Number(isPremium) || 0;
                record.auth_date = Number(authDate) || null;
                record.last_active_at = new Date().toISOString();
                record.updated_at = new Date().toISOString();
              }
            }
            return { success: true };
          }

          // 5. INSERT INTO sessions
          if (trimmed.startsWith('INSERT INTO sessions')) {
            const [id, userId, token, expiresAt] = boundArgs;
            sessions.set(token, {
              id,
              user_id: userId,
              token,
              expires_at: expiresAt,
              created_at: new Date().toISOString(),
            });
            return { success: true };
          }

          // 6. INSERT INTO telegram_referrals
          if (trimmed.startsWith('INSERT INTO telegram_referrals')) {
            const [id, referrerId, refereeId, referrerUserId, refereeUserId, referralCode] =
              boundArgs;
            referrals.set(Number(refereeId), {
              id,
              referrer_id: referrerId !== null ? Number(referrerId) : null,
              referee_id: Number(refereeId),
              referrer_user_id: referrerUserId || null,
              referee_user_id: refereeUserId || null,
              referral_code: referralCode,
              status: 'pending',
              reward_amount: 0.0,
              reward_currency: 'USD',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            return { success: true };
          }

          // 7. referral_tree operations
          if (trimmed.startsWith('INSERT INTO referral_tree')) {
            if (trimmed.includes('parent_id, root_id, level, path')) {
              const [id, affiliateId, parentId, rootId, level, path] = boundArgs;
              referralTree.set(affiliateId, {
                id,
                affiliate_id: affiliateId,
                parent_id: parentId || null,
                root_id: rootId || null,
                level: Number(level) || 1,
                path: path || null,
                total_direct_referrals: 0,
                total_indirect_referrals: 0,
                total_earnings: 0,
                total_payouts: 0,
                is_active: 1,
                joined_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });
            } else {
              const [id, affiliateId] = boundArgs;
              referralTree.set(affiliateId, {
                id,
                affiliate_id: affiliateId,
                parent_id: null,
                root_id: null,
                level: 1,
                path: null,
                total_direct_referrals: 0,
                total_indirect_referrals: 0,
                total_earnings: 0,
                total_payouts: 0,
                is_active: 1,
                joined_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });
            }
            return { success: true };
          }

          if (trimmed.startsWith('UPDATE referral_tree SET')) {
            if (trimmed.includes('total_direct_referrals = total_direct_referrals + 1')) {
              const [nodeId] = boundArgs;
              for (const node of referralTree.values()) {
                if (node.id === nodeId) {
                  node.total_direct_referrals += 1;
                  node.updated_at = new Date().toISOString();
                }
              }
            } else if (trimmed.includes('parent_id = ?, root_id = ?')) {
              const [parentId, rootId, level, path, affiliateId] = boundArgs;
              const node = referralTree.get(affiliateId);
              if (node) {
                node.parent_id = parentId;
                node.root_id = rootId;
                node.level = level;
                node.path = path;
                node.updated_at = new Date().toISOString();
              }
            }
            return { success: true };
          }

          // 8. wallet_connections (optional table)
          if (trimmed.startsWith('INSERT INTO wallet_connections')) {
            return { success: true };
          }

          return { success: true };
        },
      };
      return stmt as any;
    },
    batch: async () => [],
    exec: async () => ({} as any),
    dump: async () => new ArrayBuffer(0),
  };

  return {
    db,
    tables: {
      profiles,
      telegramUsers,
      sessions,
      referrals,
      referralTree,
      affiliateCodes,
    },
  };
}

describe('Telegram Mini App Authentication Route (POST /api/auth/telegram)', () => {
  const TEST_BOT_TOKEN = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_TestToken';
  let mockEnv: {
    db: D1Database;
    tables: ReturnType<typeof createMockD1Database>['tables'];
  };
  let originalEnv: string | undefined;

  beforeEach(() => {
    mockEnv = createMockD1Database();
    jest.spyOn(dbModule, 'getDB').mockReturnValue(mockEnv.db);
    (globalThis as any).DB = mockEnv.db;

    originalEnv = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (globalThis as any).DB;
    process.env.TELEGRAM_BOT_TOKEN = originalEnv;
  });

  // ============================================================================
  // 1. Request Body & Input Validation
  // ============================================================================
  describe('Input Validation & Malformed Payloads', () => {
    it('should return HTTP 400 when request body is not valid JSON', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: 'invalid-non-json-payload',
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Invalid JSON request body/i);
    });

    it('should return HTTP 400 when initData parameter is missing', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ wallet_address: '0x1234567890123456789012345678901234567890' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Missing or invalid initData/i);
    });

    it('should return HTTP 400 when initData is empty string or whitespace', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData: '   ' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Missing or invalid initData/i);
    });
  });

  // ============================================================================
  // 2. Cryptographic Verification & Replay Protection
  // ============================================================================
  describe('Cryptographic Verification & Security Rejections', () => {
    it('should return HTTP 401 when HMAC signature is forged or tampered', async () => {
      const validInitData = await signTelegramInitData(
        {
          user: { id: 7001001, first_name: 'Attacker' },
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      // Tamper with the hash parameter
      const forgedInitData = validInitData.replace(
        /hash=[0-9a-f]{64}/,
        'hash=0000000000000000000000000000000000000000000000000000000000000000'
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData: forgedInitData }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Cryptographic signature mismatch/i);
    });

    it('should return HTTP 401 when initData was signed with a different bot token', async () => {
      const wrongTokenInitData = await signTelegramInitData(
        {
          user: { id: 7001002, first_name: 'Impostor' },
          auth_date: Math.floor(Date.now() / 1000),
        },
        '987654321:DifferentBotToken_XYZ_NotRecognized'
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData: wrongTokenInitData }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Cryptographic signature mismatch/i);
    });

    it('should return HTTP 401 when initData is older than 24 hours (replay attack prevention)', async () => {
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 86401; // 24h + 1s ago
      const expiredInitData = await signTelegramInitData(
        {
          user: { id: 7001003, first_name: 'ReplayVictim' },
          auth_date: expiredTimestamp,
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData: expiredInitData }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Authentication data expired/i);
    });

    it('should return HTTP 401 when auth_date is in the future beyond 5 minutes skew tolerance', async () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 400; // 400s in the future (>300s limit)
      const futureInitData = await signTelegramInitData(
        {
          user: { id: 7001004, first_name: 'TimeTraveler' },
          auth_date: futureTimestamp,
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData: futureInitData }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Authentication date is in the future/i);
    });
  });

  // ============================================================================
  // 3. Unauthenticated TMA Signup Flow
  // ============================================================================
  describe('Unauthenticated TMA Signup & Auto-Provisioning', () => {
    it('should auto-provision new profile, telegram_users row, issue 30-day session and set cookie', async () => {
      const telegramId = 8812345;
      const now = Math.floor(Date.now() / 1000);
      const validInitData = await signTelegramInitData(
        {
          user: {
            id: telegramId,
            first_name: 'Alice',
            last_name: 'Wonderland',
            username: 'alice_wonder',
            photo_url: 'https://t.me/i/userpic/320/alice.jpg',
            language_code: 'en',
            is_premium: true,
          },
          auth_date: now,
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData: validInitData }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.is_new_user).toBe(true);
      expect(typeof json.session_token).toBe('string');
      expect(json.session_token?.length).toBeGreaterThan(20);
      expect(json.token).toBe(json.session_token);

      // Verify user payload
      expect(json.user).toBeDefined();
      expect(json.user?.telegram_id).toBe(telegramId);
      expect(json.user?.email).toBe(`tg_${telegramId}@telegram.apexos.io`);
      expect(json.user?.first_name).toBe('Alice');
      expect(json.user?.username).toBe('alice_wonder');
      expect(json.user?.referral_code).toBe(`TG${telegramId}`);
      expect(json.user?.role).toBe('shopper');
      expect(json.user?.plan).toBe('free');
      expect(json.user?.tier).toBe('BASIC');
      expect(json.user?.kyc_tier).toBe('tier0_unverified');

      // Verify telegram_user payload
      expect(json.telegram_user).toBeDefined();
      expect(json.telegram_user?.telegram_id).toBe(telegramId);
      expect(json.telegram_user?.user_id).toBe(json.user?.id);
      expect(json.telegram_user?.first_name).toBe('Alice');
      expect(json.telegram_user?.last_name).toBe('Wonderland');
      expect(json.telegram_user?.photo_url).toBe('https://t.me/i/userpic/320/alice.jpg');
      expect(json.telegram_user?.language_code).toBe('en');
      expect(json.telegram_user?.is_premium).toBe(1);

      // Verify persistence in in-memory D1 tables
      const persistedProfile = mockEnv.tables.profiles.get(json.user!.id);
      expect(persistedProfile).toBeDefined();
      expect(persistedProfile?.email).toBe(`tg_${telegramId}@telegram.apexos.io`);
      expect(persistedProfile?.full_name).toBe('Alice Wonderland');

      const persistedTgUser = mockEnv.tables.telegramUsers.get(telegramId);
      expect(persistedTgUser).toBeDefined();
      expect(persistedTgUser?.user_id).toBe(json.user!.id);
      expect(persistedTgUser?.username).toBe('alice_wonder');

      const persistedSession = mockEnv.tables.sessions.get(json.session_token!);
      expect(persistedSession).toBeDefined();
      expect(persistedSession?.user_id).toBe(json.user!.id);

      // Verify 30-day expiration window (~30 days from now in ms)
      const expiresAtMs = new Date(persistedSession!.expires_at).getTime();
      const expectedMinExpiresAt = Date.now() + 29 * 24 * 60 * 60 * 1000;
      const expectedMaxExpiresAt = Date.now() + 31 * 24 * 60 * 60 * 1000;
      expect(expiresAtMs).toBeGreaterThan(expectedMinExpiresAt);
      expect(expiresAtMs).toBeLessThan(expectedMaxExpiresAt);

      // Verify Set-Cookie header
      const cookieHeader = res.headers.get('set-cookie');
      expect(cookieHeader).toBeDefined();
      expect(cookieHeader).toContain(`session_token=${json.session_token}`);
      expect(cookieHeader).toContain('Path=/');
    });
  });

  // ============================================================================
  // 4. Idempotent Repeated Login
  // ============================================================================
  describe('Idempotent Repeated Login', () => {
    it('should return existing profile on subsequent logins without duplicate constraint error', async () => {
      const telegramId = 9922334;
      const now = Math.floor(Date.now() / 1000);
      const initData = await signTelegramInitData(
        {
          user: {
            id: telegramId,
            first_name: 'Bob',
            username: 'bob_the_trader',
          },
          auth_date: now,
        },
        TEST_BOT_TOKEN
      );

      // 1st request: Signup
      const req1 = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData }),
        headers: { 'Content-Type': 'application/json' },
      });
      const res1 = await POST(req1);
      const json1 = await res1.json();

      expect(res1.status).toBe(200);
      expect(json1.is_new_user).toBe(true);
      const userId = json1.user.id;

      // 2nd request: Re-login with same initData or refreshed auth_date
      const refreshInitData = await signTelegramInitData(
        {
          user: {
            id: telegramId,
            first_name: 'Bob (Updated)',
            username: 'bob_the_pro',
          },
          auth_date: now + 60,
        },
        TEST_BOT_TOKEN
      );

      const req2 = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData: refreshInitData }),
        headers: { 'Content-Type': 'application/json' },
      });
      const res2 = await POST(req2);
      const json2 = await res2.json();

      expect(res2.status).toBe(200);
      expect(json2.success).toBe(true);
      expect(json2.is_new_user).toBe(false);
      expect(json2.user.id).toBe(userId);
      expect(json2.user.email).toBe(`tg_${telegramId}@telegram.apexos.io`);
      expect(mockEnv.tables.profiles.size).toBe(1);

      // Verify telegram_users record updated with new name and username
      const tgRecord = mockEnv.tables.telegramUsers.get(telegramId);
      expect(tgRecord?.first_name).toBe('Bob (Updated)');
      expect(tgRecord?.username).toBe('bob_the_pro');
    });
  });

  // ============================================================================
  // 5. Pre-Authenticated Account Linking
  // ============================================================================
  describe('Pre-Authenticated Account Linking', () => {
    it('should bind existing logged-in profile to telegram_users when Authorization Bearer token is provided', async () => {
      // Setup existing authenticated user in D1
      const preExistingUserId = 'usr_vip_enterprise_001';
      const sessionToken = 'secret-preauth-session-bearer-token';
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      mockEnv.tables.profiles.set(preExistingUserId, {
        id: preExistingUserId,
        email: 'founder@apexos.io',
        full_name: 'Apex Founder',
        avatar_url: 'https://apexos.io/avatars/founder.png',
        role: 'master_trader',
        plan: 'master',
        tier: 'MASTER',
        referral_code: 'APEX_CEO',
        referred_by: null,
        wallet_address: null,
        preferred_chain: null,
        kyc_status: 'approved',
        kyc_tier: 'tier2_enhanced',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      mockEnv.tables.sessions.set(sessionToken, {
        id: 'sess-vip-1',
        user_id: preExistingUserId,
        token: sessionToken,
        expires_at: futureDate,
        created_at: new Date().toISOString(),
      });

      const telegramId = 55443322;
      const initData = await signTelegramInitData(
        {
          user: {
            id: telegramId,
            first_name: 'Founder',
            username: 'apex_founder_tg',
          },
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.is_new_user).toBe(false);
      expect(json.user?.id).toBe(preExistingUserId);
      expect(json.user?.email).toBe('founder@apexos.io');
      expect(json.user?.referral_code).toBe('APEX_CEO');
      expect(json.user?.telegram_id).toBe(telegramId);

      // Verify telegram_users row linked to preExistingUserId
      const linkedTgUser = mockEnv.tables.telegramUsers.get(telegramId);
      expect(linkedTgUser).toBeDefined();
      expect(linkedTgUser?.user_id).toBe(preExistingUserId);
      expect(linkedTgUser?.username).toBe('apex_founder_tg');
    });
  });

  // ============================================================================
  // 6. Wallet Address Validation & Binding
  // ============================================================================
  describe('Wallet Address Validation & Profile Binding', () => {
    it('should validate and bind a valid Ethereum address', async () => {
      const ethAddress = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
      const telegramId = 6655441;
      const initData = await signTelegramInitData(
        {
          user: { id: telegramId, first_name: 'CryptoWhale' },
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({
          initData,
          wallet_address: ethAddress,
          preferred_chain: 'ethereum',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.user?.wallet_address).toBe(ethAddress);
      expect(json.user?.preferred_chain).toBe('ethereum');

      const profile = mockEnv.tables.profiles.get(json.user!.id);
      expect(profile?.wallet_address).toBe(ethAddress);
      expect(profile?.preferred_chain).toBe('ethereum');
    });

    it('should validate and bind a valid Solana address', async () => {
      const solAddress = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
      const telegramId = 6655442;
      const initData = await signTelegramInitData(
        {
          user: { id: telegramId, first_name: 'SolanaDegen' },
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({
          initData,
          wallet_address: solAddress,
          preferred_chain: 'solana',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.user?.wallet_address).toBe(solAddress);
      expect(json.user?.preferred_chain).toBe('solana');
    });

    it('should validate and bind a valid Stellar address', async () => {
      const stellarAddress = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
      const telegramId = 6655443;
      const initData = await signTelegramInitData(
        {
          user: { id: telegramId, first_name: 'StellarStroop' },
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({
          initData,
          wallet_address: stellarAddress,
          preferred_chain: 'stellar',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.user?.wallet_address).toBe(stellarAddress);
      expect(json.user?.preferred_chain).toBe('stellar');
    });

    it('should return HTTP 400 when wallet_address is provided without preferred_chain', async () => {
      const telegramId = 6655444;
      const initData = await signTelegramInitData(
        {
          user: { id: telegramId, first_name: 'NoChainUser' },
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({
          initData,
          wallet_address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/preferred_chain is required/i);
    });

    it('should return HTTP 400 when an unsupported blockchain network is specified', async () => {
      const telegramId = 6655445;
      const initData = await signTelegramInitData(
        {
          user: { id: telegramId, first_name: 'BtcUser' },
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({
          initData,
          wallet_address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
          preferred_chain: 'bitcoin',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Unsupported blockchain network/i);
    });

    it('should return HTTP 400 when wallet address format does not match the network regex', async () => {
      const telegramId = 6655446;
      const initData = await signTelegramInitData(
        {
          user: { id: telegramId, first_name: 'BadAddressUser' },
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({
          initData,
          wallet_address: '0xInvalidEthereumAddressNot40HexCharacters',
          preferred_chain: 'ethereum',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Invalid wallet address format/i);
    });
  });

  // ============================================================================
  // 7. Viral Referral Attribution & Deep Linking
  // ============================================================================
  describe('Viral Referral Attribution & Tree Integration', () => {
    it('should attribute referral from start_param ref_XYZ and insert into telegram_referrals and referral_tree', async () => {
      // 1. Seed referrer in profiles and referral_tree
      const referrerId = 'usr_referrer_888';
      const referrerCode = 'VIP_TRADER';
      const referrerTgId = 11223344;

      mockEnv.tables.profiles.set(referrerId, {
        id: referrerId,
        email: 'referrer@apexos.io',
        full_name: 'Top Referrer',
        avatar_url: null,
        role: 'affiliate',
        plan: 'growth',
        tier: 'PREMIUM',
        referral_code: referrerCode,
        referred_by: null,
        wallet_address: null,
        preferred_chain: null,
        kyc_status: 'approved',
        kyc_tier: 'tier1_basic',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      mockEnv.tables.telegramUsers.set(referrerTgId, {
        id: 'tg-u-referrer',
        telegram_id: referrerTgId,
        user_id: referrerId,
        username: 'top_referrer',
        first_name: 'Top',
        last_name: 'Referrer',
        photo_url: null,
        language_code: 'en',
        is_premium: 1,
        auth_date: Math.floor(Date.now() / 1000),
        last_active_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      mockEnv.tables.referralTree.set(referrerId, {
        id: 'node_referrer_root',
        affiliate_id: referrerId,
        parent_id: null,
        root_id: null,
        level: 1,
        path: 'node_referrer_root',
        total_direct_referrals: 5,
        total_indirect_referrals: 0,
        total_earnings: 250.0,
        total_payouts: 0.0,
        is_active: 1,
        joined_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // 2. Referee signs up via TMA deep link start_param="ref_VIP_TRADER"
      const refereeTgId = 99887711;
      const initData = await signTelegramInitData(
        {
          user: { id: refereeTgId, first_name: 'NewReferee' },
          start_param: `ref_${referrerCode}`,
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);

      const refereeUserId = json.user.id;

      // 3. Verify referee profile was updated with referred_by
      const refereeProfile = mockEnv.tables.profiles.get(refereeUserId);
      expect(refereeProfile?.referred_by).toBe(referrerId);

      // 4. Verify telegram_referrals row was created
      const referralRecord = mockEnv.tables.referrals.get(refereeTgId);
      expect(referralRecord).toBeDefined();
      expect(referralRecord?.referrer_id).toBe(referrerTgId);
      expect(referralRecord?.referee_id).toBe(refereeTgId);
      expect(referralRecord?.referrer_user_id).toBe(referrerId);
      expect(referralRecord?.referee_user_id).toBe(refereeUserId);
      expect(referralRecord?.referral_code).toBe(`ref_${referrerCode}`);
      expect(referralRecord?.status).toBe('pending');

      // 5. Verify referral_tree node linked under referrer
      const refereeTreeNode = mockEnv.tables.referralTree.get(refereeUserId);
      expect(refereeTreeNode).toBeDefined();
      expect(refereeTreeNode?.parent_id).toBe('node_referrer_root');
      expect(refereeTreeNode?.level).toBe(2);

      // 6. Verify referrer's total_direct_referrals was incremented from 5 to 6
      const referrerTreeNode = mockEnv.tables.referralTree.get(referrerId);
      expect(referrerTreeNode?.total_direct_referrals).toBe(6);
    });

    it('should support referral code passed via request body referral_code and resolve custom affiliate_codes', async () => {
      // 1. Seed custom affiliate code mapping
      const affiliateUserId = 'usr_affiliate_custom_77';
      mockEnv.tables.profiles.set(affiliateUserId, {
        id: affiliateUserId,
        email: 'affiliate@deal.com',
        full_name: 'Custom Affiliate',
        avatar_url: null,
        role: 'affiliate',
        plan: 'starter',
        tier: 'BASIC',
        referral_code: 'AUTO_GEN_123',
        referred_by: null,
        wallet_address: null,
        preferred_chain: null,
        kyc_status: 'unverified',
        kyc_tier: 'tier0_unverified',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      mockEnv.tables.affiliateCodes.set('CUSTOM_PROMO', {
        id: 'ac_001',
        affiliate_id: affiliateUserId,
        code: 'CUSTOM_PROMO',
      });

      const refereeTgId = 44556677;
      const initData = await signTelegramInitData(
        {
          user: { id: refereeTgId, first_name: 'PromoUser' },
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({
          initData,
          referral_code: 'CUSTOM_PROMO',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);

      const refereeProfile = mockEnv.tables.profiles.get(json.user.id);
      expect(refereeProfile?.referred_by).toBe(affiliateUserId);
    });

    it('should prevent self-referral when user enters their own referral code', async () => {
      const telegramId = 33221199;
      const myReferralCode = `TG${telegramId}`;

      const initData = await signTelegramInitData(
        {
          user: { id: telegramId, first_name: 'SelfReferrer' },
          start_param: `ref_${myReferralCode}`,
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);

      // Verify no self-referral recorded in telegram_referrals
      const ref = mockEnv.tables.referrals.get(telegramId);
      expect(ref).toBeUndefined();

      const profile = mockEnv.tables.profiles.get(json.user.id);
      expect(profile?.referred_by).toBeNull();
    });
  });

  // ============================================================================
  // 8. Infrastructure & Error Handling
  // ============================================================================
  describe('Infrastructure Failures & Error Handling', () => {
    it('should return HTTP 503 when Cloudflare D1 database service is unavailable', async () => {
      jest.spyOn(dbModule, 'getDB').mockImplementation(() => {
        throw new Error('D1 connection failed');
      });
      delete (globalThis as any).DB;

      const initData = await signTelegramInitData(
        {
          user: { id: 1111111, first_name: 'FailDBUser' },
          auth_date: Math.floor(Date.now() / 1000),
        },
        TEST_BOT_TOKEN
      );

      const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(503);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Database service unavailable/i);
    });

    it('should return HTTP 500 when TELEGRAM_BOT_TOKEN is missing in production environment', async () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevToken = process.env.TELEGRAM_BOT_TOKEN;

      try {
        (process.env as any).NODE_ENV = 'production';
        delete process.env.TELEGRAM_BOT_TOKEN;

        const req = new NextRequest('http://localhost:3000/api/auth/telegram', {
          method: 'POST',
          body: JSON.stringify({ initData: 'some_init_data' }),
          headers: { 'Content-Type': 'application/json' },
        });

        const res = await POST(req);
        const json = await res.json();

        expect(res.status).toBe(500);
        expect(json.success).toBe(false);
        expect(json.error).toMatch(/missing bot token/i);
      } finally {
        (process.env as any).NODE_ENV = prevNodeEnv;
        process.env.TELEGRAM_BOT_TOKEN = prevToken;
      }
    });
  });
});
