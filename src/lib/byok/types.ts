// BYOK Provider types — supported external service providers
export type ByokProvider = 'binance' | 'bybit' | 'resend'

// User API key metadata (without exposing encrypted value)
export interface UserApiKeyMeta {
  user_id: string
  provider: ByokProvider
  created_at: string
  updated_at: string
}

// Resolution options
export interface ResolveApiKeyOptions {
  /**
   * If true, fallback to global secret when user key not found
   * @default true
   */
  fallbackToGlobal?: boolean
  /**
   * If true, throw error when no key found (overrides fallbackToGlobal)
   * @default false
   */
  requireUserKey?: boolean
}
