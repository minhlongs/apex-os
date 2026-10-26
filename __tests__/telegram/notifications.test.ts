/**
 * __tests__/telegram/notifications.test.ts
 *
 * Comprehensive Test Suite for Telegram Direct Messaging & Lifecycle Alerts:
 * - Direct messaging: sendDirectMessage with Markdown, HTML, replyMarkup, and web page preview options
 * - Error resilience: missing bot token, HTTP 403 blocked/not started, HTTP 429 rate limit, network exceptions
 * - Celebratory templates:
 *     - sendCashbackConfirmation (emojis, amount, merchant, cashback %, txId, TMA launch button)
 *     - sendReferralActivation (emojis, referee name, reward bonus, total referrals, leaderboard button)
 *     - sendPayoutDispatch (emojis, amount, wallet truncation, explorer links for Ethereum/Solana/Stellar)
 * - User telegram_id resolution: resolveUserTelegramId with D1 mock, null handling, and error resilience
 * - Backward compatibility: TelegramNotifier instance methods and standalone function exports
 */

import {
  TelegramNotifier,
  createTelegramNotifier,
  sendDirectMessage,
  sendCashbackConfirmation,
  sendReferralActivation,
  sendPayoutDispatch,
  resolveUserTelegramId,
} from '@/lib/notifications/channels/telegram';
import type { D1Database } from '@/lib/db';

describe('Telegram Notifications & Direct Messaging Suite', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11' };
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  // ============================================================================
  // 1. sendDirectMessage Tests
  // ============================================================================
  describe('sendDirectMessage', () => {
    it('should successfully send direct message via Telegram Bot API POST /sendMessage', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            message_id: 998811,
            chat: { id: 777123456, type: 'private' },
            date: 1727500000,
            text: 'Hello from ApexOS!',
          },
        }),
      });

      const notifier = new TelegramNotifier({ botToken: '123456:ABC' });
      const res = await notifier.sendDirectMessage(777123456, 'Hello from ApexOS!');

      expect(res.ok).toBe(true);
      expect(res.messageId).toBe(998811);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, requestInit] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/bot123456:ABC/sendMessage');
      expect(requestInit.method).toBe('POST');
      expect(requestInit.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(requestInit.body);
      expect(body.chat_id).toBe(777123456);
      expect(body.text).toBe('Hello from ApexOS!');
      expect(body.parse_mode).toBe('Markdown');
      expect(body.disable_web_page_preview).toBe(false);
    });

    it('should support custom parseMode (HTML) and disableWebPagePreview', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: 10101 },
        }),
      });

      const notifier = new TelegramNotifier();
      const res = await notifier.sendDirectMessage('777123456', '<b>Important</b> notice', {
        parseMode: 'HTML',
        disableWebPagePreview: true,
      });

      expect(res.ok).toBe(true);
      expect(res.messageId).toBe(10101);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.parse_mode).toBe('HTML');
      expect(body.disable_web_page_preview).toBe(true);
    });

    it('should include replyMarkup when provided (e.g. inline keyboard)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: 12345 },
        }),
      });

      const replyMarkup = {
        inline_keyboard: [
          [{ text: 'Open App', web_app: { url: 'https://apexos.io/en/telegram/app' } }],
        ],
      };

      const res = await sendDirectMessage(987654321, 'Check this out', { replyMarkup });
      expect(res.ok).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reply_markup).toEqual(replyMarkup);
    });

    it('should return error without calling fetch when telegramId is missing', async () => {
      const notifier = new TelegramNotifier();
      const res = await notifier.sendDirectMessage('' as any, 'Hello');
      expect(res.ok).toBe(false);
      expect(res.error).toBe('Missing telegramId');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return error gracefully when botToken is completely missing', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const notifier = new TelegramNotifier({ botToken: '' });
      const res = await notifier.sendDirectMessage(123456, 'Hello');

      expect(res.ok).toBe(false);
      expect(res.error).toBe('Missing bot token');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle HTTP 403 (user blocked bot / chat not started) gracefully without throwing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          ok: false,
          error_code: 403,
          description: 'Forbidden: bot was blocked by the user',
        }),
      });

      const notifier = new TelegramNotifier();
      const res = await notifier.sendDirectMessage(555666777, 'Alert!');

      expect(res.ok).toBe(false);
      expect(res.description).toContain('bot was blocked by the user');
      expect(res.error).toContain('Forbidden');
    });

    it('should handle HTTP 429 (rate limits) gracefully without throwing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 35',
          parameters: { retry_after: 35 },
        }),
      });

      const notifier = new TelegramNotifier();
      const res = await notifier.sendDirectMessage(555666777, 'High volume alert');

      expect(res.ok).toBe(false);
      expect(res.error).toContain('Too Many Requests');
      expect(res.description).toContain('retry after 35');
    });

    it('should handle network fetch exceptions gracefully without throwing', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection timed out to api.telegram.org'));

      const notifier = new TelegramNotifier();
      const res = await notifier.sendDirectMessage(555666777, 'Alert');

      expect(res.ok).toBe(false);
      expect(res.error).toContain('Connection timed out');
    });
  });

  // ============================================================================
  // 2. sendCashbackConfirmation Tests
  // ============================================================================
  describe('sendCashbackConfirmation', () => {
    it('should format celebratory message with emojis, amount, merchant, and TMA launch button', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: 445566 },
        }),
      });

      const res = await sendCashbackConfirmation({
        telegramId: 123456789,
        amount: 35.75,
        currency: 'USDT',
        merchant: 'Binance VIP',
        txId: '0xabcdef1234567890abcdef1234567890',
        cashbackPct: 30,
      });

      expect(res.ok).toBe(true);
      expect(res.messageId).toBe(445566);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe(123456789);
      expect(body.parse_mode).toBe('Markdown');

      // Check celebratory emojis
      expect(body.text).toContain('🎉');
      expect(body.text).toContain('💰');
      expect(body.text).toContain('💎');

      // Check content details
      expect(body.text).toContain('$35.75 USDT');
      expect(body.text).toContain('Binance VIP');
      expect(body.text).toContain('30%');
      expect(body.text).toContain('0xabcdef...567890');

      // Check TMA launch button
      const replyMarkup = body.reply_markup;
      expect(replyMarkup.inline_keyboard).toBeDefined();
      const button = replyMarkup.inline_keyboard[0][0];
      expect(button.text).toContain('Open ApexOS Mini App');
      expect(button.web_app.url).toContain('/en/telegram/app?tab=earnings');
    });

    it('should format message correctly when optional txId and cashbackPct are omitted', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: 112233 },
        }),
      });

      const notifier = new TelegramNotifier();
      const res = await notifier.sendCashbackConfirmation({
        telegramId: 987654321,
        amount: 10,
        currency: 'USD',
        merchant: 'Bybit Spot',
      });

      expect(res.ok).toBe(true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('$10.00 USD');
      expect(body.text).toContain('Bybit Spot');
      expect(body.text).not.toContain('Transaction ID');
      expect(body.text).not.toContain('Cashback Rate');
    });
  });

  // ============================================================================
  // 3. sendReferralActivation Tests
  // ============================================================================
  describe('sendReferralActivation', () => {
    it('should format notification to referrer announcing new referee and bonus earned', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: 778899 },
        }),
      });

      const res = await sendReferralActivation({
        referrerTelegramId: 888999000,
        refereeName: 'Vitalik Buterin',
        rewardAmount: 5.0,
        currency: 'USD',
        totalReferrals: 12,
      });

      expect(res.ok).toBe(true);
      expect(res.messageId).toBe(778899);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe(888999000);
      expect(body.text).toContain('🎉');
      expect(body.text).toContain('🤝');
      expect(body.text).toContain('Vitalik Buterin');
      expect(body.text).toContain('$5.00 USD');
      expect(body.text).toContain('Total Active Referrals:* 12');
      expect(body.text).toContain('referral leaderboard');

      // Check Leaderboard TMA button
      const replyMarkup = body.reply_markup;
      const button = replyMarkup.inline_keyboard[0][0];
      expect(button.text).toContain('View Leaderboard');
      expect(button.web_app.url).toContain('/en/telegram/app?tab=leaderboard');
    });

    it('should work with default currency and omitted totalReferrals', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: 334455 },
        }),
      });

      const notifier = new TelegramNotifier();
      const res = await notifier.sendReferralActivation({
        referrerTelegramId: 111222333,
        refereeName: 'Satoshi',
        rewardAmount: 10,
      });

      expect(res.ok).toBe(true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('Satoshi');
      expect(body.text).toContain('$10.00 USD');
      expect(body.text).not.toContain('Total Active Referrals');
    });
  });

  // ============================================================================
  // 4. sendPayoutDispatch Tests
  // ============================================================================
  describe('sendPayoutDispatch', () => {
    it('should format payout dispatch with truncated wallet and explorer link for Ethereum', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: 556677 },
        }),
      });

      const res = await sendPayoutDispatch({
        telegramId: 444333222,
        amount: 250.0,
        currency: 'USDC',
        destinationWallet: '0x71C8363837918a71018283748291038472910291',
        txHash: '0xabc123def45678901234567890abcdef1234567890',
        chain: 'ethereum',
      });

      expect(res.ok).toBe(true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('💸');
      expect(body.text).toContain('⚡');
      expect(body.text).toContain('$250.00 USDC');
      expect(body.text).toContain('0x71C8...0291');
      expect(body.text).toContain('etherscan.io/tx/0xabc123def45678901234567890abcdef1234567890');

      const button = body.reply_markup.inline_keyboard[0][0];
      expect(button.text).toContain('View Wallet & History');
      expect(button.web_app.url).toContain('/en/telegram/app?tab=earnings');
    });

    it('should format explorer link correctly for Solana and Stellar', async () => {
      // Solana test
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });

      await sendPayoutDispatch({
        telegramId: 123,
        amount: 50,
        currency: 'USDC',
        destinationWallet: '7EYnhQoR9YM3N7UoaKRoA44Uy8Jeaici3DXJhwo5w8pj',
        txHash: '5K3yM3F8r1q9W4',
        chain: 'solana',
      });

      const solBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(solBody.text).toContain('solscan.io/tx/5K3yM3F8r1q9W4');

      // Stellar test
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 2 } }),
      });

      await sendPayoutDispatch({
        telegramId: 123,
        amount: 50,
        currency: 'USDC',
        destinationWallet: 'GCKF734892482390483204982390483209483209',
        txHash: 'stellar_tx_998877',
        chain: 'stellar',
      });

      const stelBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(stelBody.text).toContain('stellar.expert/explorer/public/tx/stellar_tx_998877');
    });
  });

  // ============================================================================
  // 5. resolveUserTelegramId Tests
  // ============================================================================
  describe('resolveUserTelegramId', () => {
    it('should return numeric telegram_id when matching row exists in telegram_users', async () => {
      const mockDb: D1Database = {
        prepare: jest.fn().mockReturnValue({
          bind: jest.fn().mockReturnValue({
            first: jest.fn().mockResolvedValue({ telegram_id: 99887766 }),
          }),
        }),
      } as any;

      const tid = await resolveUserTelegramId(mockDb, 'usr_abc_123');
      expect(tid).toBe(99887766);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT telegram_id FROM telegram_users WHERE user_id = ?')
      );
    });

    it('should return null when user is not found in telegram_users', async () => {
      const mockDb: D1Database = {
        prepare: jest.fn().mockReturnValue({
          bind: jest.fn().mockReturnValue({
            first: jest.fn().mockResolvedValue(null),
          }),
        }),
      } as any;

      const tid = await resolveUserTelegramId(mockDb, 'non_existent_user');
      expect(tid).toBeNull();
    });

    it('should return null when userId or db is missing', async () => {
      expect(await resolveUserTelegramId(null as any, 'usr_1')).toBeNull();
      expect(await resolveUserTelegramId({} as any, '')).toBeNull();
    });

    it('should handle database errors gracefully and return null', async () => {
      const mockDb: D1Database = {
        prepare: jest.fn().mockImplementation(() => {
          throw new Error('D1 connection reset');
        }),
      } as any;

      const tid = await resolveUserTelegramId(mockDb, 'usr_error');
      expect(tid).toBeNull();
    });

    it('should be callable as an instance method on TelegramNotifier', async () => {
      const mockDb: D1Database = {
        prepare: jest.fn().mockReturnValue({
          bind: jest.fn().mockReturnValue({
            first: jest.fn().mockResolvedValue({ telegram_id: 123456 }),
          }),
        }),
      } as any;

      const notifier = createTelegramNotifier();
      const tid = await notifier.resolveUserTelegramId(mockDb, 'usr_test');
      expect(tid).toBe(123456);
    });
  });
});
