/**
 * src/lib/telegram/bot-service.ts
 *
 * Telegram Bot Service for ApexOS:
 * - Secret token verification with constant-time equality (timingSafeEqual)
 * - /start ref_<code deep-linking with referral tree binding and social bonuses ($5.00)
 * - Bot commands: /deals, /earnings, /leaderboard, /link, /help
 * - Inline queries: @ApexOSBot <query> with structured article deal cards
 * - telegram_bot_events immutable audit logging
 */

import { timingSafeEqual } from '@/lib/telegram/crypto';
import type { D1Database } from '@/lib/db';
import type {
  TelegramUpdate,
  TelegramMessage,
  TelegramInlineQuery,
  InlineQueryResultArticle,
  InlineKeyboardMarkup,
  HandleTelegramUpdateOptions,
  HandleTelegramUpdateResult,
} from '@/types/telegram';
import { warn as logWarn, error as logError, info as logInfo } from '@/lib/logger';

// Re-export options & result types for convenience
export type { HandleTelegramUpdateOptions, HandleTelegramUpdateResult };

/**
 * Verifies the X-Telegram-Bot-Api-Secret-Token header using constant-time comparison
 * to eliminate timing side-channel attacks.
 *
 * @param headerToken The incoming secret token header string (or null/undefined)
 * @param secret The expected secret token configured for the webhook
 * @returns boolean indicating whether the token strictly matches
 */
export function verifyWebhookSecretToken(
  headerToken: string | null | undefined,
  secret: string
): boolean {
  if (!headerToken || !secret) {
    return false;
  }
  if (typeof headerToken !== 'string' || typeof secret !== 'string') {
    return false;
  }
  return timingSafeEqual(headerToken, secret);
}

/**
 * Escapes characters for Telegram Markdown format
 */
export function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([_*`\[\]])/g, '\\$1');
}

/**
 * Sends a message to a Telegram chat via Bot API POST /sendMessage
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: number | string,
  text: string,
  options?: {
    parseMode?: 'Markdown' | 'HTML';
    replyMarkup?: InlineKeyboardMarkup;
    disableWebPagePreview?: boolean;
  }
): Promise<{ ok: boolean; messageId?: number; description?: string }> {
  if (!botToken || botToken.trim().length === 0) {
    return { ok: false, description: 'Missing bot token' };
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: text,
      parse_mode: options?.parseMode || 'Markdown',
      disable_web_page_preview: options?.disableWebPagePreview ?? false,
    };
    if (options?.replyMarkup) {
      payload.reply_markup = options.replyMarkup;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    return {
      ok: Boolean(data?.ok),
      messageId: data?.result?.message_id,
      description: data?.description,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(`[Telegram Bot] Error sending message to chat ${chatId}: ${msg}`);
    return { ok: false, description: msg };
  }
}

/**
 * Answers an inline query via Bot API POST /answerInlineQuery
 */
export async function answerTelegramInlineQuery(
  botToken: string,
  inlineQueryId: string,
  results: InlineQueryResultArticle[],
  options?: {
    cacheTime?: number;
    isPersonal?: boolean;
    nextOffset?: string;
  }
): Promise<{ ok: boolean; description?: string }> {
  if (!botToken || botToken.trim().length === 0) {
    return { ok: false, description: 'Missing bot token' };
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/answerInlineQuery`;
    const payload = {
      inline_query_id: inlineQueryId,
      results,
      cache_time: options?.cacheTime ?? 300,
      is_personal: options?.isPersonal ?? false,
      next_offset: options?.nextOffset,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    return {
      ok: Boolean(data?.ok),
      description: data?.description,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(`[Telegram Bot] Error answering inline query ${inlineQueryId}: ${msg}`);
    return { ok: false, description: msg };
  }
}

/**
 * Records an immutable audit log entry into telegram_bot_events table.
 * Handled with exception swallowing to prevent breaking bot updates.
 */
export async function logBotEvent(
  db: D1Database,
  params: {
    eventType:
      | 'command'
      | 'message'
      | 'inline_query'
      | 'chosen_inline_result'
      | 'callback_query'
      | 'delivery_status'
      | 'referral_start'
      | 'error'
      | 'notification';
    telegramId?: number | null;
    chatId?: string | number | null;
    command?: string | null;
    query?: string | null;
    payload?: Record<string, unknown> | string;
    deliveryStatus?: 'pending' | 'sent' | 'success' | 'delivered' | 'failed' | 'ignored';
    errorMessage?: string | null;
  }
): Promise<void> {
  if (!db) return;

  try {
    const id = crypto.randomUUID();
    const payloadStr =
      typeof params.payload === 'string'
        ? params.payload
        : JSON.stringify(params.payload || {});
    const chatIdStr =
      params.chatId !== undefined && params.chatId !== null
        ? String(params.chatId)
        : null;
    const deliveryStatus = params.deliveryStatus || 'success';

    await db
      .prepare(
        `INSERT INTO telegram_bot_events (
          id, event_type, telegram_id, chat_id, command, query, payload, delivery_status, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .bind(
        id,
        params.eventType,
        params.telegramId ?? null,
        chatIdStr,
        params.command ?? null,
        params.query ?? null,
        payloadStr,
        deliveryStatus,
        params.errorMessage ?? null
      )
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(`[Telegram Bot] Failed to write telegram_bot_events log: ${msg}`);
  }
}

/**
 * Handles incoming Telegram bot updates: commands, deep-linking, inline queries, and callbacks.
 */
export async function handleTelegramUpdate(
  options: HandleTelegramUpdateOptions
): Promise<HandleTelegramUpdateResult> {
  const { update, botToken, db } = options;

  if (!update || typeof update !== 'object') {
    return { success: false, actionTaken: 'invalid_update', error: 'Missing update payload' };
  }

  try {
    // 1. Handle Inline Query (@ApexOSBot <query>)
    if (update.inline_query) {
      return await handleInlineQuery(update.inline_query, botToken, db);
    }

    // 2. Handle Chosen Inline Result
    if (update.chosen_inline_result) {
      const chosen = update.chosen_inline_result;
      await logBotEvent(db, {
        eventType: 'chosen_inline_result',
        telegramId: chosen.from?.id,
        query: chosen.query,
        payload: { result_id: chosen.result_id, inline_message_id: chosen.inline_message_id },
        deliveryStatus: 'success',
      });
      return { success: true, actionTaken: 'chosen_inline_result_logged' };
    }

    // 3. Handle Callback Query
    if (update.callback_query) {
      const cb = update.callback_query;
      await logBotEvent(db, {
        eventType: 'callback_query',
        telegramId: cb.from?.id,
        payload: { data: cb.data, id: cb.id },
        deliveryStatus: 'success',
      });
      return { success: true, actionTaken: 'callback_query_handled' };
    }

    // 4. Handle Message (Commands & Text)
    if (update.message) {
      return await handleMessageUpdate(update.message, botToken, db);
    }

    return { success: true, actionTaken: 'unhandled_update_type' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError(`[Telegram Bot] Error processing update: ${errorMsg}`);

    await logBotEvent(db, {
      eventType: 'error',
      deliveryStatus: 'failed',
      errorMessage: errorMsg,
      payload: { update_id: update.update_id },
    });

    return { success: false, actionTaken: 'error', error: errorMsg };
  }
}

/**
 * Handles message updates: commands (/start, /deals, /earnings, /leaderboard, /link, /help)
 */
async function handleMessageUpdate(
  message: TelegramMessage,
  botToken: string,
  db: D1Database
): Promise<HandleTelegramUpdateResult> {
  const text = (message.text || '').trim();
  const chatId = message.chat.id;
  const fromUser = message.from;
  const telegramId = fromUser?.id;

  if (!telegramId) {
    return { success: false, actionTaken: 'missing_from_user', error: 'Message has no sender user' };
  }

  // Parse command (e.g. "/start", "/deals@ApexOSBot", etc.)
  const commandMatch = text.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);

  if (commandMatch) {
    const command = commandMatch[1].toLowerCase();
    const commandArg = (commandMatch[2] || '').trim();

    switch (command) {
      case 'start':
        return await handleStartCommand(message, commandArg, botToken, db);

      case 'deals':
        return await handleDealsCommand(message, botToken, db);

      case 'earnings':
        return await handleEarningsCommand(message, botToken, db);

      case 'leaderboard':
        return await handleLeaderboardCommand(message, botToken, db);

      case 'link':
        return await handleLinkCommand(message, commandArg, botToken, db);

      case 'help':
        return await handleHelpCommand(message, botToken, db);

      default: {
        // Unknown command
        const replyText =
          `❓ *Unknown Command*\n\n` +
          `Use /help to view all available commands, or /deals to browse active cashback offers!`;
        const replyMarkup: InlineKeyboardMarkup = {
          inline_keyboard: [
            [
              {
                text: '🚀 Open ApexOS Mini App',
                web_app: { url: 'https://apexos.io/en/telegram/app' },
              },
            ],
          ],
        };

        await sendTelegramMessage(botToken, chatId, replyText, { replyMarkup });
        await logBotEvent(db, {
          eventType: 'command',
          telegramId,
          chatId,
          command: `/${command}`,
          deliveryStatus: 'ignored',
          payload: { text },
        });

        return { success: true, actionTaken: 'unknown_command' };
      }
    }
  }

  // Non-command plain text message
  const replyText =
    `👋 Hello! I am the *ApexOS Bot*.\n\n` +
    `Your gateway to crypto cashback deals, cross-exchange fee arbitrage, and viral referral rewards.\n\n` +
    `• /deals — Top cashback & arbitrage spreads\n` +
    `• /earnings — Your cashback & referral earnings\n` +
    `• /leaderboard — Top referrers rankings\n` +
    `• /help — Full commands directory`;

  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: '🚀 Launch ApexOS Mini App',
          web_app: { url: 'https://apexos.io/en/telegram/app' },
        },
      ],
    ],
  };

  await sendTelegramMessage(botToken, chatId, replyText, { replyMarkup });
  await logBotEvent(db, {
    eventType: 'message',
    telegramId,
    chatId,
    deliveryStatus: 'success',
    payload: { text },
  });

  return { success: true, actionTaken: 'message_acknowledged' };
}

/**
 * Handles /start command with support for deep-linking (/start ref_<code)
 */
async function handleStartCommand(
  message: TelegramMessage,
  startArg: string,
  botToken: string,
  db: D1Database
): Promise<HandleTelegramUpdateResult> {
  const chatId = message.chat.id;
  const fromUser = message.from!;
  const refereeTgId = fromUser.id;

  // 1. Upsert referee in telegram_users table
  await upsertTelegramUser(db, fromUser);

  // 2. Check if deep link referral code was provided
  if (startArg && startArg.length > 0) {
    const refMatch = startArg.match(/^(?:ref_)?([a-zA-Z0-9_-]+)$/i);
    const referralCode = refMatch ? refMatch[1] : startArg;

    return await processReferralDeepLink(
      message,
      referralCode,
      botToken,
      db
    );
  }

  // 3. Standard /start without referral code
  const welcomeText =
    `👋 *Welcome to ApexOS!*\n\n` +
    `ApexOS is your autonomous crypto cashback & trading intelligence terminal.\n\n` +
    `*What you can do here:*\n` +
    `• Browse the highest exchange cashback rates (/deals)\n` +
    `• Track your personal cashback balance (/earnings)\n` +
    `• Climb the community referral leaderboard (/leaderboard)\n` +
    `• Connect your account for instant chat alerts (/link)\n\n` +
    `💡 *Share Deals Instantly:*\n` +
    `Type \`@ApexOSBot\` in any chat to share live deal cards with friends!`;

  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: '🚀 Launch ApexOS Mini App',
          web_app: { url: 'https://apexos.io/en/telegram/app' },
        },
      ],
      [
        {
          text: '📊 View Top Deals',
          url: 'https://apexos.io/en/deals',
        },
      ],
    ],
  };

  await sendTelegramMessage(botToken, chatId, welcomeText, { replyMarkup });

  await logBotEvent(db, {
    eventType: 'command',
    telegramId: refereeTgId,
    chatId,
    command: '/start',
    deliveryStatus: 'success',
  });

  return { success: true, actionTaken: 'start_welcome' };
}

/**
 * Processes deep-linked referral (/start ref_<code)
 */
async function processReferralDeepLink(
  message: TelegramMessage,
  referralCode: string,
  botToken: string,
  db: D1Database
): Promise<HandleTelegramUpdateResult> {
  const chatId = message.chat.id;
  const fromUser = message.from!;
  const refereeTgId = fromUser.id;

  // Check if referee already has an active referral in telegram_referrals
  const existingReferral = await db
    .prepare(
      `SELECT id, referrer_id, referral_code, status, reward_amount 
       FROM telegram_referrals 
       WHERE referee_id = ? 
       LIMIT 1`
    )
    .bind(refereeTgId)
    .first<{ id: string; referrer_id: number | null; referral_code: string; status: string; reward_amount: number }>();

  if (existingReferral) {
    // Welcome back without duplicating bonus
    const welcomeBackText =
      `👋 *Welcome back to ApexOS!*\n\n` +
      `You are already participating in our viral referral program.\n` +
      `Launch our Mini App to track your earnings, browse crypto deals, and share your own referral link!`;

    const replyMarkup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          {
            text: '🚀 Open ApexOS Mini App',
            web_app: {
              url: `https://apexos.io/en/telegram/app?startapp=ref_${referralCode}`,
            },
          },
        ],
      ],
    };

    await sendTelegramMessage(botToken, chatId, welcomeBackText, { replyMarkup });

    await logBotEvent(db, {
      eventType: 'command',
      telegramId: refereeTgId,
      chatId,
      command: '/start',
      deliveryStatus: 'success',
      payload: { referral_code: referralCode, reason: 'already_referred' },
    });

    return { success: true, actionTaken: 'referral_welcome_back' };
  }

  // Resolve Referrer from affiliate_codes or profiles
  let referrerProfileId: string | null = null;

  // Check affiliate_codes first
  const affiliateCodeRow = await db
    .prepare(
      `SELECT affiliate_id, code FROM affiliate_codes WHERE LOWER(code) = LOWER(?) LIMIT 1`
    )
    .bind(referralCode)
    .first<{ affiliate_id: string; code: string }>();

  if (affiliateCodeRow) {
    referrerProfileId = affiliateCodeRow.affiliate_id;
  } else {
    // Fallback: check profiles
    const profileRow = await db
      .prepare(
        `SELECT id, referral_code FROM profiles WHERE LOWER(referral_code) = LOWER(?) LIMIT 1`
      )
      .bind(referralCode)
      .first<{ id: string; referral_code: string }>();

    if (profileRow) {
      referrerProfileId = profileRow.id;
    }
  }

  if (!referrerProfileId) {
    // Referral code not found
    const invalidText =
      `👋 *Welcome to ApexOS!*\n\n` +
      `The referral code *${escapeMarkdown(referralCode)}* was not found or is no longer active.\n` +
      `You can still access top crypto cashback rates and cross-exchange arbitrage!`;

    const replyMarkup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          {
            text: '🚀 Open ApexOS Mini App',
            web_app: { url: 'https://apexos.io/en/telegram/app' },
          },
        ],
      ],
    };

    await sendTelegramMessage(botToken, chatId, invalidText, { replyMarkup });

    await logBotEvent(db, {
      eventType: 'command',
      telegramId: refereeTgId,
      chatId,
      command: '/start',
      deliveryStatus: 'success',
      payload: { referral_code: referralCode, valid: false },
    });

    return { success: true, actionTaken: 'start_invalid_ref' };
  }

  // Self-Referral Prevention Check
  // 1. Check referee's linked user_id in telegram_users
  const refereeUserRow = await db
    .prepare(`SELECT user_id FROM telegram_users WHERE telegram_id = ? LIMIT 1`)
    .bind(refereeTgId)
    .first<{ user_id: string | null }>();

  const refereeUserId = refereeUserRow?.user_id || null;

  // 2. Check referrer's linked telegram_id in telegram_users
  const referrerTgRow = await db
    .prepare(`SELECT telegram_id FROM telegram_users WHERE user_id = ? LIMIT 1`)
    .bind(referrerProfileId)
    .first<{ telegram_id: number }>();

  const referrerTgId = referrerTgRow?.telegram_id || null;

  const isSelfReferral =
    (refereeUserId && refereeUserId === referrerProfileId) ||
    (referrerTgId && referrerTgId === refereeTgId) ||
    referralCode.toUpperCase() === `TG${refereeTgId}`;

  if (isSelfReferral) {
    const selfRefText =
      `⚠️ *Self-Referral Warning*\n\n` +
      `You cannot refer yourself to ApexOS.\n` +
      `Share your referral link with friends to earn cashback bonuses!`;

    const replyMarkup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          {
            text: '🚀 Open ApexOS Mini App',
            web_app: { url: 'https://apexos.io/en/telegram/app' },
          },
        ],
      ],
    };

    await sendTelegramMessage(botToken, chatId, selfRefText, { replyMarkup });

    await logBotEvent(db, {
      eventType: 'command',
      telegramId: refereeTgId,
      chatId,
      command: '/start',
      deliveryStatus: 'ignored',
      payload: { referral_code: referralCode, reason: 'self_referral_prevented' },
    });

    return { success: true, actionTaken: 'self_referral_prevented' };
  }

  // Valid Referral: Record into telegram_referrals and update referral_tree
  const referralId = crypto.randomUUID();
  const bonusAmount = 5.0;

  // Insert into telegram_referrals
  await db
    .prepare(
      `INSERT INTO telegram_referrals (
        id, referrer_id, referee_id, referrer_user_id, referee_user_id,
        referral_code, source_chat_id, status, reward_amount, reward_currency, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 'USD', ?, datetime('now'), datetime('now'))`
    )
    .bind(
      referralId,
      referrerTgId,
      refereeTgId,
      referrerProfileId,
      refereeUserId,
      referralCode,
      String(chatId),
      bonusAmount,
      JSON.stringify({ bonus_credited: 1, bonus_amount: bonusAmount })
    )
    .run();

  // Update referrer in referral_tree
  const treeRow = await db
    .prepare(`SELECT id FROM referral_tree WHERE affiliate_id = ? LIMIT 1`)
    .bind(referrerProfileId)
    .first<{ id: string }>();

  if (treeRow) {
    await db
      .prepare(
        `UPDATE referral_tree
         SET total_direct_referrals = total_direct_referrals + 1,
             total_earnings = total_earnings + ?,
             updated_at = datetime('now')
         WHERE affiliate_id = ?`
      )
      .bind(bonusAmount, referrerProfileId)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO referral_tree (
          id, affiliate_id, level, total_direct_referrals, total_earnings, is_active, joined_at, updated_at
        ) VALUES (?, ?, 1, 1, ?, 1, datetime('now'), datetime('now'))`
      )
      .bind(crypto.randomUUID(), referrerProfileId, bonusAmount)
      .run();
  }

  // Dispatch notification to referrer if their Telegram account is linked
  if (referrerTgId) {
    const referrerNotifyText =
      `🎉 *New Referral Activated!*\n\n` +
      `A new user joined using your referral code *${escapeMarkdown(referralCode)}*!\n` +
      `🎁 *+$5.00* social referral bonus has been credited to your balance.`;

    await sendTelegramMessage(botToken, referrerTgId, referrerNotifyText);
  }

  // Send welcome message to referee
  const refereeWelcomeText =
    `🎉 *Welcome to ApexOS!*\n\n` +
    `You have been referred by a friend via *${escapeMarkdown(referralCode)}*!\n` +
    `🎁 Your *+$5.00* welcome bonus is active.\n\n` +
    `Explore top crypto cashback rates, compare exchange fee spreads, and start earning today!`;

  const refereeMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: '🚀 Open ApexOS Mini App',
          web_app: {
            url: `https://apexos.io/en/telegram/app?startapp=ref_${referralCode}`,
          },
        },
      ],
      [
        {
          text: '🔥 Explore Deals',
          url: 'https://apexos.io/en/deals',
        },
      ],
    ],
  };

  await sendTelegramMessage(botToken, chatId, refereeWelcomeText, {
    replyMarkup: refereeMarkup,
  });

  await logBotEvent(db, {
    eventType: 'referral_start',
    telegramId: refereeTgId,
    chatId,
    command: '/start',
    deliveryStatus: 'success',
    payload: {
      referral_code: referralCode,
      referrer_profile_id: referrerProfileId,
      bonus_amount: bonusAmount,
    },
  });

  return { success: true, actionTaken: 'referral_created' };
}

/**
 * Handles /deals command: queries top deals & fee spreads
 */
async function handleDealsCommand(
  message: TelegramMessage,
  botToken: string,
  db: D1Database
): Promise<HandleTelegramUpdateResult> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  // 1. Query top active deals
  let deals: Array<{
    id: string;
    name: string;
    description: string | null;
    exchange: string | null;
    default_commission_rate: number;
    url: string;
  }> = [];

  try {
    const dealsResult = await db
      .prepare(
        `SELECT id, name, description, exchange, default_commission_rate, url
         FROM deals
         WHERE is_active = 1
         ORDER BY default_commission_rate DESC
         LIMIT 5`
      )
      .all<{
        id: string;
        name: string;
        description: string | null;
        exchange: string | null;
        default_commission_rate: number;
        url: string;
      }>();
    deals = dealsResult.results || [];
  } catch (err) {
    logWarn(`[Telegram Bot] Failed to query deals: ${err}`);
  }

  // 2. Query top arbitrage spreads
  let arbitradgeOps: Array<{
    pair: string;
    base_exchange: string;
    target_exchange: string;
    spread_bps: number;
    savings_pct: number;
  }> = [];

  try {
    const arbResult = await db
      .prepare(
        `SELECT pair, base_exchange, target_exchange, spread_bps, savings_pct
         FROM arbitrage_opportunities
         WHERE is_active = 1
         ORDER BY spread_bps DESC
         LIMIT 3`
      )
      .all<{
        pair: string;
        base_exchange: string;
        target_exchange: string;
        spread_bps: number;
        savings_pct: number;
      }>();
    arbitradgeOps = arbResult.results || [];
  } catch (err) {
    logWarn(`[Telegram Bot] Failed to query arbitrage opportunities: ${err}`);
  }

  // 3. Format message
  let text = `🔥 *Top Crypto Cashback & Arbitrage Deals*\n\n`;

  if (deals.length > 0) {
    text += `*Featured Deals:*\n`;
    for (const d of deals) {
      const pct = Math.round((d.default_commission_rate || 0.1) * 100);
      const ex = (d.exchange || 'Crypto').toUpperCase();
      text += `• *${ex}*: ${pct}% Cashback — [Claim Deal](${d.url})\n`;
    }
    text += `\n`;
  } else {
    text += `• *Binance*: Up to 40% Cashback\n• *Bybit*: Up to 35% Cashback\n• *OKX*: Up to 30% Cashback\n\n`;
  }

  if (arbitradgeOps.length > 0) {
    text += `⚡ *Top Arbitrage Spreads:*\n`;
    for (const a of arbitradgeOps) {
      text += `• *${a.pair}*: ${a.base_exchange.toUpperCase()} ➔ ${a.target_exchange.toUpperCase()} (+${a.spread_bps} bps, ${Math.round(a.savings_pct)}% savings)\n`;
    }
    text += `\n`;
  }

  text += `🚀 Tap below to launch the full interactive deals catalog!`;

  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: '🚀 Open Deals in Mini App',
          web_app: { url: 'https://apexos.io/en/telegram/app?tab=deals' },
        },
      ],
    ],
  };

  await sendTelegramMessage(botToken, chatId, text, { replyMarkup });

  await logBotEvent(db, {
    eventType: 'command',
    telegramId,
    chatId,
    command: '/deals',
    deliveryStatus: 'success',
  });

  return { success: true, actionTaken: 'deals_listed' };
}

/**
 * Handles /earnings command: queries user earnings and referrals
 */
async function handleEarningsCommand(
  message: TelegramMessage,
  botToken: string,
  db: D1Database
): Promise<HandleTelegramUpdateResult> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  // Check if telegram_id is linked to profiles
  const tgUser = await db
    .prepare(`SELECT user_id FROM telegram_users WHERE telegram_id = ? LIMIT 1`)
    .bind(telegramId)
    .first<{ user_id: string | null }>();

  if (!tgUser || !tgUser.user_id) {
    const unlinkedText =
      `ℹ️ *Account Not Linked*\n\n` +
      `Your Telegram account is not yet connected to an ApexOS profile.\n` +
      `Use /link to pair your account or open our Mini App to automatically bind your identity.`;

    const replyMarkup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          {
            text: '🚀 Open Mini App & Auto-Link',
            web_app: { url: 'https://apexos.io/en/telegram/app' },
          },
        ],
      ],
    };

    await sendTelegramMessage(botToken, chatId, unlinkedText, { replyMarkup });

    await logBotEvent(db, {
      eventType: 'command',
      telegramId,
      chatId,
      command: '/earnings',
      deliveryStatus: 'success',
      payload: { linked: false },
    });

    return { success: true, actionTaken: 'earnings_not_linked' };
  }

  const userId = tgUser.user_id;

  // Query earnings
  let pendingAmount = 0;
  let paidAmount = 0;

  try {
    const earningsRow = await db
      .prepare(
        `SELECT 
          COALESCE(SUM(CASE WHEN is_paid = 0 THEN amount ELSE 0 END), 0) as pending_amount,
          COALESCE(SUM(CASE WHEN is_paid = 1 THEN amount ELSE 0 END), 0) as paid_amount
         FROM earnings
         WHERE affiliate_id = ?`
      )
      .bind(userId)
      .first<{ pending_amount: number; paid_amount: number }>();

    if (earningsRow) {
      pendingAmount = earningsRow.pending_amount || 0;
      paidAmount = earningsRow.paid_amount || 0;
    }
  } catch (err) {
    logWarn(`[Telegram Bot] Failed to query earnings: ${err}`);
  }

  // Query telegram referrals
  let referralCount = 0;
  let totalReferralBonuses = 0;

  try {
    const refRow = await db
      .prepare(
        `SELECT 
          COUNT(id) as referral_count,
          COALESCE(SUM(reward_amount), 0) as total_referral_bonuses
         FROM telegram_referrals
         WHERE (referrer_id = ? OR referrer_user_id = ?) AND status = 'active'`
      )
      .bind(telegramId, userId)
      .first<{ referral_count: number; total_referral_bonuses: number }>();

    if (refRow) {
      referralCount = refRow.referral_count || 0;
      totalReferralBonuses = refRow.total_referral_bonuses || 0;
    }
  } catch (err) {
    logWarn(`[Telegram Bot] Failed to query referrals: ${err}`);
  }

  const totalBalance = pendingAmount + paidAmount + totalReferralBonuses;

  const earningsText =
    `💰 *Your ApexOS Earnings*\n\n` +
    `⏳ *Pending Cashback:* $${pendingAmount.toFixed(2)}\n` +
    `✅ *Paid Cashback:* $${paidAmount.toFixed(2)}\n` +
    `👥 *Active Referrals:* ${referralCount}\n` +
    `🎁 *Referral Bonuses:* $${totalReferralBonuses.toFixed(2)}\n` +
    `💵 *Total Lifetime Balance:* $${totalBalance.toFixed(2)}\n\n` +
    `_Payouts are processed automatically to your connected multi-chain wallet._`;

  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: '📊 View Details in Mini App',
          web_app: { url: 'https://apexos.io/en/telegram/app?tab=earnings' },
        },
      ],
    ],
  };

  await sendTelegramMessage(botToken, chatId, earningsText, { replyMarkup });

  await logBotEvent(db, {
    eventType: 'command',
    telegramId,
    chatId,
    command: '/earnings',
    deliveryStatus: 'success',
    payload: { pendingAmount, paidAmount, referralCount, totalBalance },
  });

  return { success: true, actionTaken: 'earnings_retrieved' };
}

/**
 * Handles /leaderboard command: top 10 referrers with medals
 */
async function handleLeaderboardCommand(
  message: TelegramMessage,
  botToken: string,
  db: D1Database
): Promise<HandleTelegramUpdateResult> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  let leaders: Array<{
    referrer_id: number;
    referral_count: number;
    total_rewards: number;
    username: string | null;
    first_name: string | null;
  }> = [];

  try {
    const result = await db
      .prepare(
        `SELECT 
          r.referrer_id,
          COUNT(r.id) as referral_count,
          COALESCE(SUM(r.reward_amount), 0) as total_rewards,
          u.username,
          u.first_name
         FROM telegram_referrals r
         LEFT JOIN telegram_users u ON u.telegram_id = r.referrer_id
         WHERE r.referrer_id IS NOT NULL AND r.status = 'active'
         GROUP BY r.referrer_id
         ORDER BY referral_count DESC, total_rewards DESC
         LIMIT 10`
      )
      .all<{
        referrer_id: number;
        referral_count: number;
        total_rewards: number;
        username: string | null;
        first_name: string | null;
      }>();
    leaders = result.results || [];
  } catch (err) {
    logWarn(`[Telegram Bot] Failed to query leaderboard: ${err}`);
  }

  let text = `🏆 *ApexOS Social Referral Leaderboard*\n\n`;

  if (leaders.length > 0) {
    const medals = ['🥇', '🥈', '🥉'];
    leaders.forEach((leader, idx) => {
      const badge = idx < 3 ? medals[idx] : `${idx + 1}.`;
      const name = leader.username
        ? `@${escapeMarkdown(leader.username)}`
        : escapeMarkdown(leader.first_name || `User ${leader.referrer_id}`);
      text += `${badge} ${name} — *${leader.referral_count}* referrals ($${Number(leader.total_rewards || 0).toFixed(2)})\n`;
    });
    text += `\n🚀 Invite friends with \`/start ref_<your_code>\` to climb the leaderboard!`;
  } else {
    text += `No referrals recorded yet! Be the first on the leaderboard by inviting your friends.`;
  }

  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: '🏆 Open Full Leaderboard',
          web_app: { url: 'https://apexos.io/en/telegram/app?tab=leaderboard' },
        },
      ],
    ],
  };

  await sendTelegramMessage(botToken, chatId, text, { replyMarkup });

  await logBotEvent(db, {
    eventType: 'command',
    telegramId,
    chatId,
    command: '/leaderboard',
    deliveryStatus: 'success',
  });

  return { success: true, actionTaken: 'leaderboard_displayed' };
}

/**
 * Handles /link command: pairing instructions
 */
async function handleLinkCommand(
  message: TelegramMessage,
  _arg: string,
  botToken: string,
  db: D1Database
): Promise<HandleTelegramUpdateResult> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const linkText =
    `🔗 *Link Your ApexOS Account*\n\n` +
    `Connecting your Telegram identity enables instant chat notifications for:\n` +
    `• Confirmed cashback from exchange trading\n` +
    `• New social referral activations & bonuses\n` +
    `• Multi-chain payout settlement alerts\n\n` +
    `*How to link:*\n` +
    `1. Visit the [ApexOS Web Terminal](https://apexos.io)\n` +
    `2. Navigate to *Settings > Connected Accounts*\n` +
    `3. Select *Connect Telegram*, or simply launch our Mini App below!`;

  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: '🚀 Open Mini App & Auto-Link',
          web_app: { url: 'https://apexos.io/en/telegram/app' },
        },
      ],
    ],
  };

  await sendTelegramMessage(botToken, chatId, linkText, { replyMarkup });

  await logBotEvent(db, {
    eventType: 'command',
    telegramId,
    chatId,
    command: '/link',
    deliveryStatus: 'success',
  });

  return { success: true, actionTaken: 'link_info' };
}

/**
 * Handles /help command: command guide and inline search tips
 */
async function handleHelpCommand(
  message: TelegramMessage,
  botToken: string,
  db: D1Database
): Promise<HandleTelegramUpdateResult> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const helpText =
    `🤖 *ApexOS Bot Commands & Features*\n\n` +
    `• /deals — Browse top crypto cashback deals & arbitrage spreads\n` +
    `• /earnings — Check your pending & paid cashback and referral bonuses\n` +
    `• /leaderboard — View top referrers & viral rankings\n` +
    `• /link — Pair your Telegram account with your ApexOS profile\n` +
    `• /help — Show this help manual\n\n` +
    `💡 *Inline Deal Sharing:*\n` +
    `Type \`@ApexOSBot <exchange or token>\` in any Telegram group or chat to share live interactive deal cards directly with friends!`;

  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: '🚀 Launch ApexOS Mini App',
          web_app: { url: 'https://apexos.io/en/telegram/app' },
        },
      ],
    ],
  };

  await sendTelegramMessage(botToken, chatId, helpText, { replyMarkup });

  await logBotEvent(db, {
    eventType: 'command',
    telegramId,
    chatId,
    command: '/help',
    deliveryStatus: 'success',
  });

  return { success: true, actionTaken: 'help_displayed' };
}

/**
 * Handles inline queries (@ApexOSBot <query>)
 */
async function handleInlineQuery(
  inlineQuery: TelegramInlineQuery,
  botToken: string,
  db: D1Database
): Promise<HandleTelegramUpdateResult> {
  const query = (inlineQuery.query || '').trim();
  const queryId = inlineQuery.id;
  const telegramId = inlineQuery.from?.id;

  let deals: Array<{
    id: string;
    name: string;
    description: string | null;
    exchange: string | null;
    default_commission_rate: number;
    url: string;
  }> = [];

  try {
    const searchPattern = `%${query.toLowerCase()}%`;
    const result = await db
      .prepare(
        `SELECT id, name, description, exchange, default_commission_rate, url
         FROM deals
         WHERE is_active = 1
           AND (
             LOWER(name) LIKE ? OR
             LOWER(description) LIKE ? OR
             LOWER(exchange) LIKE ? OR
             ? = ''
           )
         ORDER BY default_commission_rate DESC
         LIMIT 10`
      )
      .bind(searchPattern, searchPattern, searchPattern, query)
      .all<{
        id: string;
        name: string;
        description: string | null;
        exchange: string | null;
        default_commission_rate: number;
        url: string;
      }>();
    deals = result.results || [];
  } catch (err) {
    logWarn(`[Telegram Bot] Failed to query deals for inline query: ${err}`);
  }

  const results: InlineQueryResultArticle[] = [];

  for (const deal of deals) {
    const cashbackPct = Math.round((deal.default_commission_rate || 0.1) * 100);
    const exchangeName = (deal.exchange || 'Crypto').toUpperCase();

    const messageText =
      `🔥 *ApexOS Crypto Deal: ${escapeMarkdown(deal.name)}*\n\n` +
      `💰 *Cashback Rate:* ${cashbackPct}%\n` +
      `📊 *Exchange:* ${exchangeName}\n\n` +
      `👉 [Claim Deal on ApexOS](${deal.url})\n` +
      `🚀 [Open in Telegram Mini App](https://apexos.io/en/telegram/app?deal=${deal.id})`;

    results.push({
      type: 'article',
      id: `deal_${deal.id}`,
      title: `${deal.name} — ${cashbackPct}% Cashback`,
      description: `${exchangeName} | High-yield cashback on ApexOS`,
      input_message_content: {
        message_text: messageText,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🚀 Open Mini App',
              web_app: {
                url: `https://apexos.io/en/telegram/app?deal=${deal.id}`,
              },
            },
            {
              text: '📈 Claim Deal',
              url: deal.url,
            },
          ],
        ],
      },
    });
  }

  // If no deals found and query is non-empty, provide helpful fallback article
  if (results.length === 0 && query.length > 0) {
    results.push({
      type: 'article',
      id: `fallback_${Date.now()}`,
      title: `No deals matching "${query}"`,
      description: 'Tap to browse all active crypto deals on ApexOS',
      input_message_content: {
        message_text:
          `🔍 No deals found matching *${escapeMarkdown(query)}*.\n\n` +
          `Visit the ApexOS Mini App to explore top exchange cashback deals and fee spreads!`,
        parse_mode: 'Markdown',
      },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🚀 Open ApexOS Mini App',
              web_app: { url: 'https://apexos.io/en/telegram/app' },
            },
          ],
        ],
      },
    });
  }

  // Answer inline query via Telegram API
  await answerTelegramInlineQuery(botToken, queryId, results);

  await logBotEvent(db, {
    eventType: 'inline_query',
    telegramId,
    query,
    deliveryStatus: 'success',
    payload: { results_count: results.length },
  });

  return { success: true, actionTaken: 'inline_query_answered' };
}

/**
 * Upserts a Telegram user in the telegram_users table
 */
async function upsertTelegramUser(
  db: D1Database,
  fromUser: {
    id: number;
    username?: string;
    first_name: string;
    last_name?: string;
  }
): Promise<void> {
  try {
    const existing = await db
      .prepare(`SELECT id FROM telegram_users WHERE telegram_id = ? LIMIT 1`)
      .bind(fromUser.id)
      .first<{ id: string }>();

    if (!existing) {
      await db
        .prepare(
          `INSERT INTO telegram_users (
            id, telegram_id, username, first_name, last_name, last_active_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
        )
        .bind(
          crypto.randomUUID(),
          fromUser.id,
          fromUser.username || null,
          fromUser.first_name,
          fromUser.last_name || null
        )
        .run();
    } else {
      await db
        .prepare(
          `UPDATE telegram_users 
           SET username = ?, first_name = ?, last_name = ?, last_active_at = datetime('now'), updated_at = datetime('now')
           WHERE telegram_id = ?`
        )
        .bind(
          fromUser.username || null,
          fromUser.first_name,
          fromUser.last_name || null,
          fromUser.id
        )
        .run();
    }
  } catch (err) {
    logWarn(`[Telegram Bot] Error upserting telegram_users: ${err}`);
  }
}
