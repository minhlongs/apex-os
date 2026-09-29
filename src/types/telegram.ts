/**
 * src/types/telegram.ts
 *
 * Core TypeScript definitions for Telegram Mini App (TMA),
 * Bot API updates, WebApp JS SDK, cryptographic verification,
 * and social referral leaderboard.
 */

// ============================================================================
// 1. Telegram WebApp JS SDK Interfaces
// ============================================================================

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
  allows_write_to_pm?: boolean;
}

export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
  [key: string]: string | undefined;
}

export interface TelegramBackButton {
  isVisible: boolean;
  onClick(fn: () => void): void;
  offClick(fn: () => void): void;
  show(): void;
  hide(): void;
}

export interface TelegramMainButton {
  text: string;
  color: string;
  textColor: string;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  setText(text: string): void;
  onClick(fn: () => void): void;
  offClick(fn: () => void): void;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
}

export interface TelegramHapticFeedback {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  selectionChanged(): void;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    query_id?: string;
    user?: TelegramUser;
    receiver?: TelegramUser;
    start_param?: string;
    auth_date?: number;
    hash?: string;
    chat_type?: string;
    chat_instance?: string;
  };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: TelegramThemeParams;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  headerColor: string;
  backgroundColor: string;
  BackButton: TelegramBackButton;
  MainButton: TelegramMainButton;
  HapticFeedback: TelegramHapticFeedback;
  ready(): void;
  expand(): void;
  close(): void;
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  openTelegramLink(url: string): void;
  openInvoice?(url: string, callback?: (status: string) => void): void;
  sendData?(data: string): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  onEvent(eventType: string, eventHandler: (...args: any[]) => void): void;
  offEvent(eventType: string, eventHandler: (...args: any[]) => void): void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp: TelegramWebApp;
    };
  }
}

// ============================================================================
// 2. Telegram Bot API Update Models
// ============================================================================

export interface TelegramChat {
  id: number | string;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessageEntity {
  type: 'mention' | 'hashtag' | 'cashtag' | 'bot_command' | 'url' | 'email' | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'pre' | 'text_link' | 'text_mention' | 'custom_emoji';
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
  language?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  date: number;
  chat: TelegramChat;
  text?: string;
  entities?: TelegramMessageEntity[];
  caption?: string;
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
}

export interface TelegramInlineQuery {
  id: string;
  from: TelegramUser;
  query: string;
  offset: string;
  chat_type?: 'sender' | 'private' | 'group' | 'supergroup' | 'channel';
}

export interface TelegramChosenInlineResult {
  result_id: string;
  from: TelegramUser;
  query: string;
  inline_message_id?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  inline_message_id?: string;
  chat_instance?: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  inline_query?: TelegramInlineQuery;
  chosen_inline_result?: TelegramChosenInlineResult;
  callback_query?: TelegramCallbackQuery;
}

export interface InputTextMessageContent {
  message_text: string;
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  disable_web_page_preview?: boolean;
}

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
  web_app?: { url: string };
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface InlineQueryResultArticle {
  type: 'article';
  id: string;
  title: string;
  input_message_content: InputTextMessageContent;
  reply_markup?: InlineKeyboardMarkup;
  url?: string;
  hide_url?: boolean;
  description?: string;
  thumb_url?: string;
}

export type InlineQueryResult = InlineQueryResultArticle;

// ============================================================================
// 3. Cryptographic & initData Verification Interfaces
// ============================================================================

export interface TelegramUserPayload {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
  is_premium?: boolean;
  allows_write_to_pm?: boolean;
}

export interface ParsedTelegramInitData {
  user: TelegramUserPayload;
  auth_date: number;
  hash: string;
  query_id?: string;
  start_param?: string;
  chat_type?: string;
  chat_instance?: string;
  raw_params: Record<string, string>;
}

export interface VerificationResult {
  isValid: boolean;
  error?: string;
  data?: ParsedTelegramInitData;
}

// ============================================================================
// 4. Cloudflare D1 Database Row Models
// ============================================================================

export interface TelegramUserRow {
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
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface TelegramReferralRow {
  id: string;
  referrer_id: number | null;
  referee_id: number;
  referrer_user_id: string | null;
  referee_user_id: string | null;
  referral_code: string;
  source_chat_id: string | null;
  status: 'pending' | 'active' | 'converted' | 'completed' | 'rewarded' | 'invalid' | 'rejected';
  reward_amount: number;
  reward_currency: string;
  converted_at: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface TelegramBotEventRow {
  id: string;
  event_type: 'command' | 'message' | 'inline_query' | 'chosen_inline_result' | 'callback_query' | 'delivery_status' | 'referral_start' | 'error' | 'notification';
  telegram_id: number | null;
  chat_id: string | null;
  command: string | null;
  query: string | null;
  payload: string;
  delivery_status: 'pending' | 'sent' | 'success' | 'delivered' | 'failed' | 'ignored';
  error_message: string | null;
  created_at: string;
}

// ============================================================================
// 5. Social Referral Leaderboard Models
// ============================================================================

export type LeaderboardPeriod = 'all_time' | 'monthly' | 'weekly';

export interface LeaderboardEntry {
  rank: number;
  telegram_id?: string | number;
  username: string | null;
  first_name: string;
  display_name: string;
  photo_url?: string | null;
  referral_code: string;
  verified_referees: number;
  total_volume_usd: number;
  total_earnings_usd: number;
  badge?: 'gold' | 'silver' | 'bronze' | 'top_10' | 'contender';
}

export interface LeaderboardResponse {
  success: boolean;
  period: LeaderboardPeriod;
  data: LeaderboardEntry[];
  user_rank?: {
    rank: number;
    verified_referees: number;
    total_volume_usd: number;
    total_earnings_usd: number;
  } | null;
  total_participants: number;
  updated_at: string;
  error?: string;
}

// ============================================================================
// 6. TMA Authentication API Models
// ============================================================================

export interface TelegramAuthRequest {
  initData: string;
  wallet_address?: string;
  preferred_chain?: 'ethereum' | 'solana' | 'stellar';
}

export interface TelegramAuthResponse {
  success: boolean;
  token?: string;
  user?: {
    id: string;
    email: string;
    telegram_id: number;
    username: string | null;
    first_name: string;
    referral_code: string;
    wallet_address?: string | null;
    preferred_chain?: string | null;
    kyc_tier?: string;
  };
  is_new_user?: boolean;
  error?: string;
}

// ============================================================================
// 7. Bot Service Handler Interfaces
// ============================================================================

export interface HandleTelegramUpdateOptions {
  update: TelegramUpdate;
  botToken: string;
  db: any; // D1Database
}

export interface HandleTelegramUpdateResult {
  success: boolean;
  actionTaken: string;
  error?: string;
}
