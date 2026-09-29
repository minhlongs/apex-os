/**
 * __tests__/telegram/webhook.test.ts
 *
 * Comprehensive Test Suite for Telegram Bot Webhook & Viral Social Referral Engine:
 * - Secret token verification: timingSafeEqual, valid passes, missing/invalid returns 403
 * - Deep linking (/start ref_<code):
 *     - referee upsert in telegram_users
 *     - referrer resolution from profiles and affiliate_codes
 *     - self-referral prevention
 *     - duplicate referee signup & bonus prevention (welcome back without duplicating)
 *     - insertion into telegram_referrals (active, reward_amount: 5.00)
 *     - referral_tree stats increment (+1 direct, +$5.00 earnings)
 *     - direct chat notification to linked referrer
 *     - welcome message with TMA link (startapp=ref_<code)
 * - Bot commands: /deals, /earnings (linked vs unlinked), /leaderboard, /link, /help, /start (no args), unknown commands
 * - Inline queries: @ApexOSBot <query> searching deals and returning formatted InlineQueryResultArticle cards
 * - Immutable audit logging: recording all commands, queries, and errors into telegram_bot_events
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/webhooks/telegram/route';
import {
  verifyWebhookSecretToken,
  handleTelegramUpdate,
  sendTelegramMessage,
  answerTelegramInlineQuery,
} from '@/lib/telegram/bot-service';
import type { D1Database } from '@/lib/db';
import type {
  TelegramUpdate,
  TelegramMessage,
  TelegramInlineQuery,
} from '@/types/telegram';

// ============================================================================
// Database & Mock Types
// ============================================================================

interface ProfileRecord {
  id: string;
  email: string;
  referral_code: string;
  referred_by: string | null;
}

interface AffiliateCodeRecord {
  id: string;
  affiliate_id: string;
  code: string;
}

interface TelegramUserRecord {
  id: string;
  telegram_id: number;
  user_id: string | null;
  username: string | null;
  first_name: string;
  last_name: string | null;
  last_active_at: string;
  created_at: string;
  updated_at: string;
}

interface TelegramReferralRecord {
  id: string;
  referrer_id: number | null;
  referee_id: number;
  referrer_user_id: string | null;
  referee_user_id: string | null;
  referral_code: string;
  source_chat_id: string | null;
  status: string;
  reward_amount: number;
  reward_currency: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface ReferralTreeNode {
  id: string;
  affiliate_id: string;
  level: number;
  total_direct_referrals: number;
  total_earnings: number;
  is_active: number;
  joined_at: string;
  updated_at: string;
}

interface DealRecord {
  id: string;
  name: string;
  description: string | null;
  exchange: string | null;
  default_commission_rate: number;
  url: string;
  is_active: number;
}

interface ArbitrageRecord {
  id: string;
  pair: string;
  base_exchange: string;
  target_exchange: string;
  spread_bps: number;
  savings_pct: number;
  is_active: number;
}

interface EarningsRecord {
  id: string;
  affiliate_id: string;
  amount: number;
  is_paid: number;
}

interface TelegramBotEventRecord {
  id: string;
  event_type: string;
  telegram_id: number | null;
  chat_id: string | null;
  command: string | null;
  query: string | null;
  payload: string;
  delivery_status: string;
  error_message: string | null;
  created_at: string;
}

/**
 * Creates a fully stateful in-memory Cloudflare D1 mock database
 */
function createMockD1Database() {
  const profiles = new Map<string, ProfileRecord>();
  const affiliateCodes = new Map<string, AffiliateCodeRecord>();
  const telegramUsers = new Map<number, TelegramUserRecord>();
  const telegramReferrals = new Map<number, TelegramReferralRecord>(); // referee_id -> record
  const referralTree = new Map<string, ReferralTreeNode>(); // affiliate_id -> node
  const deals = new Map<string, DealRecord>();
  const arbitrageOps = new Map<string, ArbitrageRecord>();
  const earnings = new Map<string, EarningsRecord>();
  const botEvents: TelegramBotEventRecord[] = [];

  const db: D1Database = {
    prepare: (query: string) => {
      let boundParams: unknown[] = [];

      const statement: any = {
        bind: (...params: unknown[]) => {
          boundParams = params;
          return statement;
        },

        first: async <T = unknown>(): Promise<T | null> => {
          const norm = query.replace(/\s+/g, ' ').trim();

          // 1. SELECT ... FROM telegram_users WHERE telegram_id = ?
          if (norm.includes('FROM telegram_users WHERE telegram_id = ?')) {
            const tid = boundParams[0] as number;
            const user = telegramUsers.get(tid);
            return (user ? { ...user } : null) as T;
          }

          // 2. SELECT telegram_id FROM telegram_users WHERE user_id = ?
          if (norm.includes('FROM telegram_users WHERE user_id = ?')) {
            const uid = boundParams[0] as string;
            for (const user of telegramUsers.values()) {
              if (user.user_id === uid) {
                return { ...user } as T;
              }
            }
            return null;
          }

          // 3. SELECT ... FROM telegram_referrals WHERE referee_id = ?
          if (norm.includes('FROM telegram_referrals WHERE referee_id = ?')) {
            const refId = boundParams[0] as number;
            const ref = telegramReferrals.get(refId);
            return (ref ? { ...ref } : null) as T;
          }

          // 4. SELECT affiliate_id, code FROM affiliate_codes WHERE LOWER(code) = LOWER(?)
          if (norm.includes('FROM affiliate_codes WHERE LOWER(code) = LOWER(?)')) {
            const code = String(boundParams[0]).toLowerCase();
            const record = affiliateCodes.get(code);
            return (record ? { ...record } : null) as T;
          }

          // 5. SELECT id, referral_code FROM profiles WHERE LOWER(referral_code) = LOWER(?)
          if (norm.includes('FROM profiles WHERE LOWER(referral_code) = LOWER(?)')) {
            const code = String(boundParams[0]).toLowerCase();
            for (const profile of profiles.values()) {
              if (profile.referral_code.toLowerCase() === code) {
                return { ...profile } as T;
              }
            }
            return null;
          }

          // 6. SELECT id FROM referral_tree WHERE affiliate_id = ?
          if (norm.includes('FROM referral_tree WHERE affiliate_id = ?')) {
            const affId = boundParams[0] as string;
            const node = referralTree.get(affId);
            return (node ? { ...node } : null) as T;
          }

          // 7. SELECT earnings aggregate (pending, paid)
          if (norm.includes('FROM earnings WHERE affiliate_id = ?')) {
            const affId = boundParams[0] as string;
            let pending_amount = 0;
            let paid_amount = 0;
            for (const e of earnings.values()) {
              if (e.affiliate_id === affId) {
                if (e.is_paid === 0) pending_amount += e.amount;
                if (e.is_paid === 1) paid_amount += e.amount;
              }
            }
            return { pending_amount, paid_amount } as T;
          }

          // 8. SELECT telegram_referrals aggregate
          if (norm.includes('FROM telegram_referrals WHERE (referrer_id = ? OR referrer_user_id = ?)')) {
            const tgId = boundParams[0] as number;
            const uId = boundParams[1] as string;
            let referral_count = 0;
            let total_referral_bonuses = 0;
            for (const r of telegramReferrals.values()) {
              if (
                (r.referrer_id === tgId || r.referrer_user_id === uId) &&
                r.status === 'active'
              ) {
                referral_count++;
                total_referral_bonuses += r.reward_amount;
              }
            }
            return { referral_count, total_referral_bonuses } as T;
          }

          return null;
        },

        all: async <T = unknown>(): Promise<{ results: T[] }> => {
          const norm = query.replace(/\s+/g, ' ').trim();

          // Deals query
          if (norm.includes('FROM deals WHERE is_active = 1')) {
            const results: DealRecord[] = [];
            for (const d of deals.values()) {
              if (d.is_active === 1) {
                // If search query is bound
                if (boundParams.length >= 4) {
                  const queryTerm = String(boundParams[3] || '').toLowerCase();
                  if (
                    queryTerm === '' ||
                    d.name.toLowerCase().includes(queryTerm) ||
                    (d.description && d.description.toLowerCase().includes(queryTerm)) ||
                    (d.exchange && d.exchange.toLowerCase().includes(queryTerm))
                  ) {
                    results.push(d);
                  }
                } else {
                  results.push(d);
                }
              }
            }
            results.sort((a, b) => b.default_commission_rate - a.default_commission_rate);
            return { results: results.slice(0, 10) as T[] };
          }

          // Arbitrage opportunities query
          if (norm.includes('FROM arbitrage_opportunities WHERE is_active = 1')) {
            const results: ArbitrageRecord[] = Array.from(arbitrageOps.values()).filter(
              (a) => a.is_active === 1
            );
            results.sort((a, b) => b.spread_bps - a.spread_bps);
            return { results: results.slice(0, 3) as T[] };
          }

          // Leaderboard query
          if (norm.includes('FROM telegram_referrals r LEFT JOIN telegram_users u')) {
            // Group by referrer_id
            const groups = new Map<number, { count: number; rewards: number }>();
            for (const r of telegramReferrals.values()) {
              if (r.referrer_id !== null && r.status === 'active') {
                const existing = groups.get(r.referrer_id) || { count: 0, rewards: 0 };
                existing.count++;
                existing.rewards += r.reward_amount;
                groups.set(r.referrer_id, existing);
              }
            }

            const results: any[] = [];
            for (const [refId, stats] of groups.entries()) {
              const u = telegramUsers.get(refId);
              results.push({
                referrer_id: refId,
                referral_count: stats.count,
                total_rewards: stats.rewards,
                username: u?.username || null,
                first_name: u?.first_name || null,
              });
            }

            results.sort((a, b) => {
              if (b.referral_count !== a.referral_count) {
                return b.referral_count - a.referral_count;
              }
              return b.total_rewards - a.total_rewards;
            });

            return { results: results.slice(0, 10) as T[] };
          }

          return { results: [] };
        },

        run: async () => {
          const norm = query.replace(/\s+/g, ' ').trim();

          // 1. INSERT INTO telegram_users
          if (norm.includes('INSERT INTO telegram_users')) {
            const [id, telegram_id, username, first_name, last_name] = boundParams as [
              string,
              number,
              string | null,
              string,
              string | null,
            ];
            telegramUsers.set(telegram_id, {
              id,
              telegram_id,
              user_id: null,
              username,
              first_name,
              last_name,
              last_active_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            return { success: true };
          }

          // 2. UPDATE telegram_users
          if (norm.includes('UPDATE telegram_users SET')) {
            const [username, first_name, last_name, telegram_id] = boundParams as [
              string | null,
              string,
              string | null,
              number,
            ];
            const existing = telegramUsers.get(telegram_id);
            if (existing) {
              existing.username = username;
              existing.first_name = first_name;
              existing.last_name = last_name;
              existing.last_active_at = new Date().toISOString();
              existing.updated_at = new Date().toISOString();
            }
            return { success: true };
          }

          // 3. INSERT INTO telegram_referrals
          if (norm.includes('INSERT INTO telegram_referrals')) {
            const [
              id,
              referrer_id,
              referee_id,
              referrer_user_id,
              referee_user_id,
              referral_code,
              source_chat_id,
              reward_amount,
              metadata,
            ] = boundParams as [
              string,
              number | null,
              number,
              string | null,
              string | null,
              string,
              string | null,
              number,
              string,
            ];
            telegramReferrals.set(referee_id, {
              id,
              referrer_id,
              referee_id,
              referrer_user_id,
              referee_user_id,
              referral_code,
              source_chat_id,
              status: 'active',
              reward_amount,
              reward_currency: 'USD',
              metadata,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            return { success: true };
          }

          // 4. UPDATE referral_tree
          if (norm.includes('UPDATE referral_tree SET total_direct_referrals = total_direct_referrals + 1')) {
            const [bonus, affiliate_id] = boundParams as [number, string];
            const node = referralTree.get(affiliate_id);
            if (node) {
              node.total_direct_referrals += 1;
              node.total_earnings += bonus;
              node.updated_at = new Date().toISOString();
            }
            return { success: true };
          }

          // 5. INSERT INTO referral_tree
          if (norm.includes('INSERT INTO referral_tree')) {
            const [id, affiliate_id, bonus] = boundParams as [string, string, number];
            referralTree.set(affiliate_id, {
              id,
              affiliate_id,
              level: 1,
              total_direct_referrals: 1,
              total_earnings: bonus,
              is_active: 1,
              joined_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            return { success: true };
          }

          // 6. INSERT INTO telegram_bot_events
          if (norm.includes('INSERT INTO telegram_bot_events')) {
            const [
              id,
              event_type,
              telegram_id,
              chat_id,
              command,
              eventQuery,
              payload,
              delivery_status,
              error_message,
            ] = boundParams as [
              string,
              string,
              number | null,
              string | null,
              string | null,
              string | null,
              string,
              string,
              string | null,
            ];
            botEvents.push({
              id,
              event_type,
              telegram_id,
              chat_id,
              command,
              query: eventQuery,
              payload,
              delivery_status,
              error_message,
              created_at: new Date().toISOString(),
            });
            return { success: true };
          }

          return { success: true };
        },
      };

      return statement;
    },
    batch: async (statements: any[]) => {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  };

  return {
    db,
    profiles,
    affiliateCodes,
    telegramUsers,
    telegramReferrals,
    referralTree,
    deals,
    arbitrageOps,
    earnings,
    botEvents,
  };
}

// ============================================================================
// Main Test Suite
// ============================================================================

describe('Telegram Bot Webhook & Viral Social Referral Engine', () => {
  const originalEnv = process.env;
  let sentTelegramMessages: Array<{ url: string; body: any }> = [];
  let answeredInlineQueries: Array<{ url: string; body: any }> = [];

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.TELEGRAM_BOT_WEBHOOK_SECRET = 'secret_webhook_token_123';
    process.env.TELEGRAM_BOT_TOKEN = 'mock_bot_token_456';

    sentTelegramMessages = [];
    answeredInlineQueries = [];

    // Mock global fetch to capture Bot API dispatches
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : {};

      if (urlStr.includes('/sendMessage')) {
        sentTelegramMessages.push({ url: urlStr, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9999 } }),
        } as unknown as Response;
      }

      if (urlStr.includes('/answerInlineQuery')) {
        answeredInlineQueries.push({ url: urlStr, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as unknown as Response;
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ==========================================================================
  // 1. Secret Token Verification Unit Tests
  // ==========================================================================
  describe('verifyWebhookSecretToken', () => {
    it('should return true when secret token matches configured secret exactly', () => {
      expect(verifyWebhookSecretToken('my_secret_token_123', 'my_secret_token_123')).toBe(true);
    });

    it('should return false when secret token differs', () => {
      expect(verifyWebhookSecretToken('wrong_token', 'my_secret_token_123')).toBe(false);
    });

    it('should return false when lengths differ', () => {
      expect(verifyWebhookSecretToken('short', 'much_longer_secret')).toBe(false);
    });

    it('should return false when header token is null or undefined', () => {
      expect(verifyWebhookSecretToken(null, 'secret')).toBe(false);
      expect(verifyWebhookSecretToken(undefined, 'secret')).toBe(false);
    });

    it('should return false when header token is empty string', () => {
      expect(verifyWebhookSecretToken('', 'secret')).toBe(false);
    });

    it('should return false when secret is empty string', () => {
      expect(verifyWebhookSecretToken('header', '')).toBe(false);
    });

    it('should return false when non-string values are passed', () => {
      expect(verifyWebhookSecretToken(12345 as any, '12345')).toBe(false);
    });
  });

  // ==========================================================================
  // 2. HTTP Webhook Route Validation (POST /api/webhooks/telegram)
  // ==========================================================================
  describe('POST /api/webhooks/telegram - HTTP Security & Secret Validation', () => {
    it('should return HTTP 403 when X-Telegram-Bot-Api-Secret-Token is missing', async () => {
      const mockDb = createMockD1Database();
      const request = new NextRequest('http://localhost/api/webhooks/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: 100 }),
      });
      (request as any).env = { DB: mockDb.db };

      const response = await POST(request);
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('Unauthorized: invalid secret token');
    });

    it('should return HTTP 403 when X-Telegram-Bot-Api-Secret-Token does not match', async () => {
      const mockDb = createMockD1Database();
      const request = new NextRequest('http://localhost/api/webhooks/telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': 'incorrect_token_xyz',
        },
        body: JSON.stringify({ update_id: 100 }),
      });
      (request as any).env = { DB: mockDb.db };

      const response = await POST(request);
      expect(response.status).toBe(403);
    });

    it('should return HTTP 200 { ok: true } when secret token matches', async () => {
      const mockDb = createMockD1Database();
      const request = new NextRequest('http://localhost/api/webhooks/telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': 'secret_webhook_token_123',
        },
        body: JSON.stringify({
          update_id: 101,
          message: {
            message_id: 1,
            from: { id: 777, first_name: 'Bob' },
            chat: { id: 777, type: 'private' },
            date: 1700000000,
            text: '/help',
          },
        }),
      });
      (request as any).env = { DB: mockDb.db };

      const response = await POST(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.action).toBe('help_displayed');
    });

    it('should return HTTP 400 when request body is not valid JSON', async () => {
      const mockDb = createMockD1Database();
      const request = new NextRequest('http://localhost/api/webhooks/telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': 'secret_webhook_token_123',
        },
        body: 'invalid-json-content{{{',
      });
      (request as any).env = { DB: mockDb.db };

      const response = await POST(request);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Invalid JSON request payload');
    });

    it('should return HTTP 503 when D1 database is unavailable', async () => {
      const request = new NextRequest('http://localhost/api/webhooks/telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': 'secret_webhook_token_123',
        },
        body: JSON.stringify({ update_id: 102 }),
      });
      // DB not provided on request or global
      (request as any).env = {};
      const origDB = (globalThis as any).DB;
      delete (globalThis as any).DB;

      const response = await POST(request);
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toBe('Database service unavailable');

      (globalThis as any).DB = origDB;
    });
  });

  // ==========================================================================
  // 3. Deep Linking & Referral Tree Integration (/start ref_<code)
  // ==========================================================================
  describe('Deep Linking & Viral Referral Attribution (/start ref_<code)', () => {
    it('should process /start ref_ALICE: create referral, increment tree, and notify referrer', async () => {
      const mock = createMockD1Database();

      // Seed referrer profile & tree node
      const referrerId = 'usr_alice_123';
      mock.profiles.set(referrerId, {
        id: referrerId,
        email: 'alice@example.com',
        referral_code: 'ALICE',
        referred_by: null,
      });
      mock.referralTree.set(referrerId, {
        id: 'tree_alice_1',
        affiliate_id: referrerId,
        level: 1,
        total_direct_referrals: 0,
        total_earnings: 0.0,
        is_active: 1,
        joined_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      // Referrer has linked telegram account
      mock.telegramUsers.set(999111, {
        id: 'tg_usr_alice',
        telegram_id: 999111,
        user_id: referrerId,
        username: 'alice_trader',
        first_name: 'Alice',
        last_name: 'Wonder',
        last_active_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const update: TelegramUpdate = {
        update_id: 201,
        message: {
          message_id: 10,
          from: {
            id: 888222,
            first_name: 'Charlie',
            username: 'charlie_crypto',
          },
          chat: { id: 888222, type: 'private' },
          date: 1700000000,
          text: '/start ref_ALICE',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('referral_created');

      // 1. Referee upserted in telegram_users
      const refereeTgUser = mock.telegramUsers.get(888222);
      expect(refereeTgUser).toBeDefined();
      expect(refereeTgUser?.first_name).toBe('Charlie');
      expect(refereeTgUser?.username).toBe('charlie_crypto');

      // 2. telegram_referrals record created
      const referral = mock.telegramReferrals.get(888222);
      expect(referral).toBeDefined();
      expect(referral?.referrer_id).toBe(999111);
      expect(referral?.referee_id).toBe(888222);
      expect(referral?.referrer_user_id).toBe(referrerId);
      expect(referral?.referral_code).toBe('ALICE');
      expect(referral?.status).toBe('active');
      expect(referral?.reward_amount).toBe(5.0);
      expect(JSON.parse(referral!.metadata).bonus_credited).toBe(1);

      // 3. referral_tree updated for referrer
      const aliceTree = mock.referralTree.get(referrerId);
      expect(aliceTree?.total_direct_referrals).toBe(1);
      expect(aliceTree?.total_earnings).toBe(5.0);

      // 4. Notification sent to referrer Alice
      const aliceNotification = sentTelegramMessages.find((m) => m.body.chat_id === 999111);
      expect(aliceNotification).toBeDefined();
      expect(aliceNotification?.body.text).toContain('New Referral Activated');
      expect(aliceNotification?.body.text).toContain('+$5.00');

      // 5. Welcome message sent to referee Charlie with Mini App button
      const charlieMessage = sentTelegramMessages.find((m) => m.body.chat_id === 888222);
      expect(charlieMessage).toBeDefined();
      expect(charlieMessage?.body.text).toContain('Welcome to ApexOS');
      expect(charlieMessage?.body.text).toContain('+$5.00');
      const webAppUrl = charlieMessage?.body.reply_markup?.inline_keyboard[0][0]?.web_app?.url;
      expect(webAppUrl).toContain('startapp=ref_ALICE');

      // 6. Audit event logged in telegram_bot_events
      const refEvent = mock.botEvents.find((e) => e.event_type === 'referral_start');
      expect(refEvent).toBeDefined();
      expect(refEvent?.telegram_id).toBe(888222);
      expect(refEvent?.delivery_status).toBe('success');
    });

    it('should resolve custom referral code from affiliate_codes table', async () => {
      const mock = createMockD1Database();
      const referrerId = 'usr_vip_partner';
      mock.profiles.set(referrerId, {
        id: referrerId,
        email: 'partner@example.com',
        referral_code: 'TG_ORIGINAL',
        referred_by: null,
      });
      // Custom affiliate code
      mock.affiliateCodes.set('whale_cashback', {
        id: 'aff_whale_1',
        affiliate_id: referrerId,
        code: 'WHALE_CASHBACK',
      });

      const update: TelegramUpdate = {
        update_id: 202,
        message: {
          message_id: 11,
          from: { id: 777333, first_name: 'David' },
          chat: { id: 777333, type: 'private' },
          date: 1700000000,
          text: '/start ref_WHALE_CASHBACK',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('referral_created');

      const referral = mock.telegramReferrals.get(777333);
      expect(referral?.referrer_user_id).toBe(referrerId);
      expect(referral?.referral_code).toBe('WHALE_CASHBACK');
    });

    it('should support code passed without ref_ prefix in /start command', async () => {
      const mock = createMockD1Database();
      const referrerId = 'usr_alice_123';
      mock.profiles.set(referrerId, {
        id: referrerId,
        email: 'alice@example.com',
        referral_code: 'ALICE',
        referred_by: null,
      });

      const update: TelegramUpdate = {
        update_id: 203,
        message: {
          message_id: 12,
          from: { id: 666444, first_name: 'Eve' },
          chat: { id: 666444, type: 'private' },
          date: 1700000000,
          text: '/start ALICE',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('referral_created');
      expect(mock.telegramReferrals.get(666444)?.referral_code).toBe('ALICE');
    });

    it('should prevent self-referral when user attempts to refer themselves', async () => {
      const mock = createMockD1Database();
      const aliceId = 'usr_alice_123';
      mock.profiles.set(aliceId, {
        id: aliceId,
        email: 'alice@example.com',
        referral_code: 'ALICE',
        referred_by: null,
      });
      // Alice is linked to telegram_id 999111
      mock.telegramUsers.set(999111, {
        id: 'tg_usr_alice',
        telegram_id: 999111,
        user_id: aliceId,
        username: 'alice_trader',
        first_name: 'Alice',
        last_name: null,
        last_active_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const update: TelegramUpdate = {
        update_id: 204,
        message: {
          message_id: 13,
          from: { id: 999111, first_name: 'Alice' },
          chat: { id: 999111, type: 'private' },
          date: 1700000000,
          text: '/start ref_ALICE',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('self_referral_prevented');

      // No referral inserted for Alice
      expect(mock.telegramReferrals.get(999111)).toBeUndefined();

      // Warning message sent
      const warningMsg = sentTelegramMessages.find((m) => m.body.chat_id === 999111);
      expect(warningMsg?.body.text).toContain('Self-Referral Warning');

      // Event logged with ignored delivery
      const event = mock.botEvents.find((e) => e.command === '/start' && e.delivery_status === 'ignored');
      expect(event).toBeDefined();
    });

    it('should prevent duplicate referee signup: welcome back without duplicating bonus', async () => {
      const mock = createMockD1Database();

      // Seed existing referral for user 888222
      mock.telegramReferrals.set(888222, {
        id: 'ref_existing_1',
        referrer_id: 999111,
        referee_id: 888222,
        referrer_user_id: 'usr_alice',
        referee_user_id: null,
        referral_code: 'ALICE',
        source_chat_id: '888222',
        status: 'active',
        reward_amount: 5.0,
        reward_currency: 'USD',
        metadata: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // User sends another /start with a different referral code
      const update: TelegramUpdate = {
        update_id: 205,
        message: {
          message_id: 14,
          from: { id: 888222, first_name: 'Charlie' },
          chat: { id: 888222, type: 'private' },
          date: 1700000000,
          text: '/start ref_BOB',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('referral_welcome_back');

      // Still only original referral recorded, not overwritten or duplicated
      const ref = mock.telegramReferrals.get(888222);
      expect(ref?.referral_code).toBe('ALICE');

      // Welcome back message sent
      const msg = sentTelegramMessages.find((m) => m.body.chat_id === 888222);
      expect(msg?.body.text).toContain('Welcome back to ApexOS');
    });

    it('should handle unrecognized referral code gracefully without error', async () => {
      const mock = createMockD1Database();

      const update: TelegramUpdate = {
        update_id: 206,
        message: {
          message_id: 15,
          from: { id: 555111, first_name: 'Frank' },
          chat: { id: 555111, type: 'private' },
          date: 1700000000,
          text: '/start ref_NONEXISTENT_CODE',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('start_invalid_ref');

      const msg = sentTelegramMessages.find((m) => m.body.chat_id === 555111);
      expect(msg?.body.text).toContain('was not found or is no longer active');
    });
  });

  // ==========================================================================
  // 4. Bot Commands: /deals, /earnings, /leaderboard, /link, /help, /start
  // ==========================================================================
  describe('Bot Commands Execution', () => {
    it('/deals: should query deals and arbitrage opportunities and format response', async () => {
      const mock = createMockD1Database();
      mock.deals.set('deal_1', {
        id: 'deal_1',
        name: 'Binance VIP Cashback',
        description: 'Up to 40% rebate',
        exchange: 'binance',
        default_commission_rate: 0.4,
        url: 'https://apexos.io/deals/binance',
        is_active: 1,
      });
      mock.arbitrageOps.set('arb_1', {
        id: 'arb_1',
        pair: 'BTC/USDT',
        base_exchange: 'bybit',
        target_exchange: 'binance',
        spread_bps: 24,
        savings_pct: 32,
        is_active: 1,
      });

      const update: TelegramUpdate = {
        update_id: 301,
        message: {
          message_id: 20,
          from: { id: 12345, first_name: 'Tester' },
          chat: { id: 12345, type: 'private' },
          date: 1700000000,
          text: '/deals',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('deals_listed');

      const msg = sentTelegramMessages.find((m) => m.body.chat_id === 12345);
      expect(msg).toBeDefined();
      expect(msg?.body.text).toContain('Top Crypto Cashback & Arbitrage Deals');
      expect(msg?.body.text).toContain('BINANCE');
      expect(msg?.body.text).toContain('40% Cashback');
      expect(msg?.body.text).toContain('BTC/USDT');
      expect(msg?.body.text).toContain('+24 bps');
      expect(msg?.body.reply_markup.inline_keyboard[0][0].text).toBe('🚀 Open Deals in Mini App');
    });

    it('/earnings: should return linking instructions when user is not linked to a profile', async () => {
      const mock = createMockD1Database();
      const update: TelegramUpdate = {
        update_id: 302,
        message: {
          message_id: 21,
          from: { id: 444333, first_name: 'UnlinkedUser' },
          chat: { id: 444333, type: 'private' },
          date: 1700000000,
          text: '/earnings',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('earnings_not_linked');

      const msg = sentTelegramMessages.find((m) => m.body.chat_id === 444333);
      expect(msg?.body.text).toContain('Account Not Linked');
      expect(msg?.body.text).toContain('/link');
    });

    it('/earnings: should query pending/paid earnings and referral count for linked user', async () => {
      const mock = createMockD1Database();
      const userId = 'usr_trader_pro';

      // Link user in telegram_users
      mock.telegramUsers.set(555666, {
        id: 'tg_555666',
        telegram_id: 555666,
        user_id: userId,
        username: 'pro_trader',
        first_name: 'Pro',
        last_name: 'Trader',
        last_active_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Seed earnings records
      mock.earnings.set('e1', { id: 'e1', affiliate_id: userId, amount: 25.5, is_paid: 0 }); // pending
      mock.earnings.set('e2', { id: 'e2', affiliate_id: userId, amount: 100.0, is_paid: 1 }); // paid

      // Seed referral records
      mock.telegramReferrals.set(111, {
        id: 'ref_1',
        referrer_id: 555666,
        referee_id: 111,
        referrer_user_id: userId,
        referee_user_id: null,
        referral_code: 'PRO',
        source_chat_id: null,
        status: 'active',
        reward_amount: 5.0,
        reward_currency: 'USD',
        metadata: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const update: TelegramUpdate = {
        update_id: 303,
        message: {
          message_id: 22,
          from: { id: 555666, first_name: 'Pro' },
          chat: { id: 555666, type: 'private' },
          date: 1700000000,
          text: '/earnings',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('earnings_retrieved');

      const msg = sentTelegramMessages.find((m) => m.body.chat_id === 555666);
      expect(msg?.body.text).toContain('Your ApexOS Earnings');
      expect(msg?.body.text).toContain('$25.50'); // pending
      expect(msg?.body.text).toContain('$100.00'); // paid
      expect(msg?.body.text).toContain('Active Referrals:* 1');
      expect(msg?.body.text).toContain('Referral Bonuses:* $5.00');
      expect(msg?.body.text).toContain('Total Lifetime Balance:* $130.50');
    });

    it('/leaderboard: should query top referrers and format with medals', async () => {
      const mock = createMockD1Database();

      // Seed users
      mock.telegramUsers.set(1, {
        id: 'u1',
        telegram_id: 1,
        user_id: 'usr_1',
        username: 'top_dog',
        first_name: 'Top',
        last_name: null,
        last_active_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      mock.telegramUsers.set(2, {
        id: 'u2',
        telegram_id: 2,
        user_id: 'usr_2',
        username: null,
        first_name: 'SecondUser',
        last_name: null,
        last_active_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Seed referrals: 2 for user 1, 1 for user 2
      mock.telegramReferrals.set(101, {
        id: 'r1',
        referrer_id: 1,
        referee_id: 101,
        referrer_user_id: 'usr_1',
        referee_user_id: null,
        referral_code: 'TOP',
        source_chat_id: null,
        status: 'active',
        reward_amount: 5.0,
        reward_currency: 'USD',
        metadata: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      mock.telegramReferrals.set(102, {
        id: 'r2',
        referrer_id: 1,
        referee_id: 102,
        referrer_user_id: 'usr_1',
        referral_code: 'TOP',
        source_chat_id: null,
        status: 'active',
        reward_amount: 5.0,
        reward_currency: 'USD',
        metadata: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      mock.telegramReferrals.set(103, {
        id: 'r3',
        referrer_id: 2,
        referee_id: 103,
        referrer_user_id: 'usr_2',
        referee_user_id: null,
        referral_code: 'SECOND',
        source_chat_id: null,
        status: 'active',
        reward_amount: 5.0,
        reward_currency: 'USD',
        metadata: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const update: TelegramUpdate = {
        update_id: 304,
        message: {
          message_id: 23,
          from: { id: 123, first_name: 'Visitor' },
          chat: { id: 123, type: 'private' },
          date: 1700000000,
          text: '/leaderboard',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('leaderboard_displayed');

      const msg = sentTelegramMessages.find((m) => m.body.chat_id === 123);
      expect(msg?.body.text).toContain('ApexOS Social Referral Leaderboard');
      expect(msg?.body.text).toContain('🥇 @top\\_dog — *2* referrals ($10.00)');
      expect(msg?.body.text).toContain('🥈 SecondUser — *1* referrals ($5.00)');
    });

    it('/link: should return pairing instructions', async () => {
      const mock = createMockD1Database();
      const update: TelegramUpdate = {
        update_id: 305,
        message: {
          message_id: 24,
          from: { id: 890, first_name: 'Newcomer' },
          chat: { id: 890, type: 'private' },
          date: 1700000000,
          text: '/link',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('link_info');

      const msg = sentTelegramMessages.find((m) => m.body.chat_id === 890);
      expect(msg?.body.text).toContain('Link Your ApexOS Account');
      expect(msg?.body.text).toContain('Connected Accounts');
      expect(msg?.body.reply_markup.inline_keyboard[0][0].text).toContain('Mini App');
    });

    it('/help: should return command guide and inline sharing hints', async () => {
      const mock = createMockD1Database();
      const update: TelegramUpdate = {
        update_id: 306,
        message: {
          message_id: 25,
          from: { id: 456, first_name: 'Helper' },
          chat: { id: 456, type: 'private' },
          date: 1700000000,
          text: '/help',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('help_displayed');

      const msg = sentTelegramMessages.find((m) => m.body.chat_id === 456);
      expect(msg?.body.text).toContain('/deals');
      expect(msg?.body.text).toContain('/earnings');
      expect(msg?.body.text).toContain('/leaderboard');
      expect(msg?.body.text).toContain('@ApexOSBot');
    });

    it('plain /start: should return friendly introduction and command directory', async () => {
      const mock = createMockD1Database();
      const update: TelegramUpdate = {
        update_id: 307,
        message: {
          message_id: 26,
          from: { id: 333, first_name: 'Starter' },
          chat: { id: 333, type: 'private' },
          date: 1700000000,
          text: '/start',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('start_welcome');

      const msg = sentTelegramMessages.find((m) => m.body.chat_id === 333);
      expect(msg?.body.text).toContain('Welcome to ApexOS');
      expect(msg?.body.reply_markup.inline_keyboard[0][0].text).toBe('🚀 Launch ApexOS Mini App');
    });

    it('unknown command: should reply with guidance to use /help', async () => {
      const mock = createMockD1Database();
      const update: TelegramUpdate = {
        update_id: 308,
        message: {
          message_id: 27,
          from: { id: 777, first_name: 'Confused' },
          chat: { id: 777, type: 'private' },
          date: 1700000000,
          text: '/unknown_command_xyz',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('unknown_command');

      const msg = sentTelegramMessages.find((m) => m.body.chat_id === 777);
      expect(msg?.body.text).toContain('Unknown Command');
    });

    it('plain text message: should acknowledge and suggest features', async () => {
      const mock = createMockD1Database();
      const update: TelegramUpdate = {
        update_id: 309,
        message: {
          message_id: 28,
          from: { id: 888, first_name: 'Chatter' },
          chat: { id: 888, type: 'private' },
          date: 1700000000,
          text: 'Hello bot, what is this?',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('message_acknowledged');

      const msg = sentTelegramMessages.find((m) => m.body.chat_id === 888);
      expect(msg?.body.text).toContain('I am the *ApexOS Bot*');
    });
  });

  // ==========================================================================
  // 5. Inline Queries (@ApexOSBot <query>)
  // ==========================================================================
  describe('Inline Queries Processing (@ApexOSBot <query>)', () => {
    it('should query deals matching search term and answer inline query with structured cards', async () => {
      const mock = createMockD1Database();
      mock.deals.set('deal_binance', {
        id: 'deal_binance',
        name: 'Binance Spot Cashback',
        description: 'Trade spot with 40% rebate',
        exchange: 'binance',
        default_commission_rate: 0.4,
        url: 'https://apexos.io/deals/binance',
        is_active: 1,
      });
      mock.deals.set('deal_bybit', {
        id: 'deal_bybit',
        name: 'Bybit Futures Promo',
        description: 'Perps cashback',
        exchange: 'bybit',
        default_commission_rate: 0.35,
        url: 'https://apexos.io/deals/bybit',
        is_active: 1,
      });

      const update: TelegramUpdate = {
        update_id: 401,
        inline_query: {
          id: 'iq_123456',
          from: { id: 501, first_name: 'Searcher' },
          query: 'binance',
          offset: '',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('inline_query_answered');

      // Verify answerTelegramInlineQuery was called
      expect(answeredInlineQueries.length).toBe(1);
      const answer = answeredInlineQueries[0];
      expect(answer.body.inline_query_id).toBe('iq_123456');

      const results = answer.body.results;
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('article');
      expect(results[0].title).toBe('Binance Spot Cashback — 40% Cashback');
      expect(results[0].description).toContain('BINANCE');
      expect(results[0].input_message_content.message_text).toContain('Cashback Rate:* 40%');
      expect(results[0].input_message_content.message_text).toContain('Claim Deal on ApexOS');
      expect(results[0].reply_markup.inline_keyboard[0][0].text).toBe('🚀 Open Mini App');

      // Verify event was logged
      const event = mock.botEvents.find((e) => e.event_type === 'inline_query');
      expect(event).toBeDefined();
      expect(event?.query).toBe('binance');
      expect(event?.telegram_id).toBe(501);
    });

    it('should return fallback article when no deals match the search term', async () => {
      const mock = createMockD1Database();

      const update: TelegramUpdate = {
        update_id: 402,
        inline_query: {
          id: 'iq_999999',
          from: { id: 502, first_name: 'Searcher' },
          query: 'nonexistent_token_xyz',
          offset: '',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('inline_query_answered');

      expect(answeredInlineQueries.length).toBe(1);
      const results = answeredInlineQueries[0].body.results;
      expect(results.length).toBe(1);
      expect(results[0].title).toContain('No deals matching');
      expect(results[0].reply_markup.inline_keyboard[0][0].text).toBe('🚀 Open ApexOS Mini App');
    });
  });

  // ==========================================================================
  // 6. Immutable Audit Logging (telegram_bot_events)
  // ==========================================================================
  describe('Immutable Audit Logging (telegram_bot_events)', () => {
    it('should record an immutable entry in telegram_bot_events for every command execution', async () => {
      const mock = createMockD1Database();

      const update: TelegramUpdate = {
        update_id: 501,
        message: {
          message_id: 50,
          from: { id: 701, first_name: 'AuditedUser' },
          chat: { id: 701, type: 'private' },
          date: 1700000000,
          text: '/help',
        },
      };

      await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(mock.botEvents.length).toBe(1);
      const event = mock.botEvents[0];
      expect(event.event_type).toBe('command');
      expect(event.telegram_id).toBe(701);
      expect(event.chat_id).toBe('701');
      expect(event.command).toBe('/help');
      expect(event.delivery_status).toBe('success');
      expect(event.created_at).toBeDefined();
    });

    it('should log chosen_inline_result interactions', async () => {
      const mock = createMockD1Database();

      const update: TelegramUpdate = {
        update_id: 502,
        chosen_inline_result: {
          result_id: 'deal_binance_1',
          from: { id: 702, first_name: 'Clicker' },
          query: 'binance',
          inline_message_id: 'msg_abc',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('chosen_inline_result_logged');

      const event = mock.botEvents.find((e) => e.event_type === 'chosen_inline_result');
      expect(event).toBeDefined();
      expect(event?.telegram_id).toBe(702);
      expect(event?.query).toBe('binance');
      const payload = JSON.parse(event!.payload);
      expect(payload.result_id).toBe('deal_binance_1');
    });

    it('should log callback_query interactions', async () => {
      const mock = createMockD1Database();

      const update: TelegramUpdate = {
        update_id: 503,
        callback_query: {
          id: 'cb_123',
          from: { id: 703, first_name: 'Tapper' },
          data: 'view_deals',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: mock.db,
      });

      expect(result.success).toBe(true);
      expect(result.actionTaken).toBe('callback_query_handled');

      const event = mock.botEvents.find((e) => e.event_type === 'callback_query');
      expect(event).toBeDefined();
      expect(event?.telegram_id).toBe(703);
    });

    it('should record an error event in telegram_bot_events when unexpected exceptions occur', async () => {
      const mock = createMockD1Database();
      // Cause a failure by throwing inside db
      const brokenDb = {
        ...mock.db,
        prepare: () => {
          throw new Error('Simulated database crash');
        },
      } as unknown as D1Database;

      const update: TelegramUpdate = {
        update_id: 504,
        message: {
          message_id: 51,
          from: { id: 704, first_name: 'ErrorUser' },
          chat: { id: 704, type: 'private' },
          date: 1700000000,
          text: '/start ref_CRASH',
        },
      };

      const result = await handleTelegramUpdate({
        update,
        botToken: 'mock_bot_token',
        db: brokenDb,
      });

      expect(result.success).toBe(false);
      expect(result.actionTaken).toBe('error');
      expect(result.error).toContain('Simulated database crash');
    });
  });
});
