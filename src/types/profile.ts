/**
 * Profile types for ApexOS
 * User profile and blockchain/wallet related type definitions
 */

/**
 * User role enum - matches database constraint
 * - trader: regular user who can follow signals
 * - master_trader: user who publishes trading signals
 * - admin: platform administrator
 */
export enum UserRole {
  TRADER = 'trader',
  MASTER_TRADER = 'master_trader',
  ADMIN = 'admin',
}

/**
 * Supported blockchain networks for wallet connections
 */
export enum SupportedChain {
  ETHEREUM = 'ethereum',
  BSC = 'bsc',
  POLYGON = 'polygon',
  ARBITRUM = 'arbitrum',
  OPTIMISM = 'optimism',
  BASE = 'base',
  SOLANA = 'solana',
  AVALANCHE = 'avalanche',
}

/**
 * Profile database record - matches src/database/migrations/001_initial_schema_d1.sql
 */
export interface Profile {
  /** Primary key, references users.id */
  id: string
  /** User email (unique) */
  email: string
  /** Full name display */
  full_name: string | null
  /** Avatar image URL */
  avatar_url: string | null
  /** User role (trader, master_trader, admin) */
  role: UserRole
  /** Subscription plan level */
  plan: UserPlan
  /** Unique referral code (auto-generated) */
  referral_code: string | null
  /** Referral code that referred this user */
  referred_by: string | null
  /** Notification preferences (JSON) */
  notification_settings: string | null
  /** External exchange identifiers JSON (okx, kucoin, binance, bybit) */
  external_ids?: string | null
  /** Creation timestamp */
  created_at: string
  /** Last update timestamp */
  updated_at: string
}

/**
 * Supported exchanges for external API key linking
 */
export type LinkedExchange = 'okx' | 'kucoin' | 'binance' | 'bybit'

/**
 * Single exchange API key linkage entry stored in profiles.external_ids
 */
export interface ExchangeKeyLink {
  api_key_id: string
  label?: string
  linked_at: string
}

export type LinkedExchangeBinding = ExchangeKeyLink

/**
 * Map of linked exchange identifiers stored in profiles.external_ids
 */
export type ProfileExternalIds = Partial<Record<LinkedExchange, ExchangeKeyLink>>

/**
 * User plan enum - subscription tier
 */
export enum UserPlan {
  FREE = 'free',
  STARTER = 'starter',
  GROWTH = 'growth',
  PREMIUM = 'premium',
  MASTER = 'master',
}

/**
 * Wallet connection record
 * Links a blockchain wallet address to a user profile
 */
export interface WalletConnection {
  /** Primary key */
  id: string
  /** User profile ID (references profiles.id) */
  profile_id: string
  /** Blockchain wallet address (checksummed) */
  wallet_address: string
  /** Preferred blockchain network */
  preferred_chain: SupportedChain
  /** Is this the primary/active wallet? */
  is_primary: boolean
  /** Connection timestamp */
  connected_at: string
  /** Last used timestamp */
  last_used_at: string | null
}

/**
 * Extended profile with wallet connections
 * Combines Profile + wallet information for frontend use
 */
export interface ProfileWithWallets extends Profile {
  wallet_connections: WalletConnection[]
}

/**
 * Form input for adding a new wallet connection
 */
export interface AddWalletInput {
  /** Wallet address to connect */
  wallet_address: string
  /** Blockchain network */
  preferred_chain: SupportedChain
}

/**
 * Profile update input (partial fields)
 */
export type UpdateProfileInput = Partial<{
  full_name: string
  avatar_url: string
  preferred_chain: SupportedChain
  notification_settings: NotificationSettings
}>

/**
 * Notification channel types available to users
 */
export type UserNotificationChannel = 'email' | 'slack' | 'telegram'

/**
 * Alert severity levels
 */
export type AlertSeverityLevel = 'info' | 'warning' | 'critical'

/**
 * User notification preferences
 * Controls which alerts a user receives and through which channels
 */
export interface NotificationSettings {
  /**
   * Enabled notification channels
   * User can enable one or more channels to receive alerts
   */
  enabled_channels: UserNotificationChannel[]

  /**
   * Minimum severity level to receive notifications
   * Users will only receive alerts at or above this severity
   * e.g., if set to 'warning', 'info' alerts are suppressed
   */
  severity_threshold: AlertSeverityLevel

  /**
   * Channel-specific configurations (e.g., Telegram chat ID)
   * Stored as key-value pairs for each channel
   */
  channel_config: Record<UserNotificationChannel, {
    enabled: boolean
    config?: Record<string, unknown>
  }>

  /**
   * Quiet hours settings (optional)
   * Suppress notifications during specific hours
   */
  quiet_hours?: {
    enabled: boolean
    start_hour: number // 0-23
    end_hour: number // 0-23
    timezone?: string // IANA timezone, e.g., "Asia/Ho_Chi_Minh"
  }

  /**
   * Email address for email notifications
   * If not set, uses profile.email
   */
  email_override?: string

  /**
   * Weekly summary preference
   */
  weekly_summary_enabled: boolean
}

/**
 * Default notification settings for new users
 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled_channels: ['email'],
  severity_threshold: 'info',
  channel_config: {
    email: { enabled: true },
    slack: { enabled: false },
    telegram: { enabled: false },
  },
  quiet_hours: {
    enabled: false,
    start_hour: 22,
    end_hour: 8,
    timezone: 'UTC',
  },
  weekly_summary_enabled: true,
}
