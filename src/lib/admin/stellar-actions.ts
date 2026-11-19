/**
 * Admin Stellar Settings Server Actions
 * Provides network switching and configuration management for Stellar payouts
 */

'use server'

import { revalidatePath } from 'next/cache'
import { error as logError } from '@/lib/logger'
import {
  StellarService,
  StellarNetwork,
  CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
  CANONICAL_STELLAR_TESTNET_USDC_ISSUER,
  isValidStellarAccountId,
  sanitizeStellarDiagnosticError,
} from '@/lib/payouts/stellar-service'

// KV storage key for Stellar config
const STELLAR_CONFIG_KEY = 'stellar_config'

const DEFAULT_ALLOWED_HORIZON_HOSTS = new Set<string>([
  'horizon.stellar.org',
  'horizon-testnet.stellar.org',
])

function isPrivateOrLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (
    !lower ||
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.includes(':') // IPv6 literal
  ) {
    return true
  }
  // Reject IPv4 literals (including loopback 127.x, RFC1918 10.x/172.16-31.x/192.168.x, link-local 169.254.x, 0.0.0.0)
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(lower) || /^\d+$/.test(lower) || /^0x[0-9a-f]+$/i.test(lower)) {
    return true
  }
  return false
}

function getAllowedHorizonHosts(): Set<string> {
  const allowed = new Set<string>(DEFAULT_ALLOWED_HORIZON_HOSTS)
  const extraRaw = process.env.STELLAR_ALLOWED_HORIZON_HOSTS ?? ''
  for (const entry of extraRaw.split(',')) {
    const host = entry.trim().toLowerCase().replace(/\.$/, '')
    if (host && !isPrivateOrLocalHostname(host)) {
      allowed.add(host)
    }
  }
  return allowed
}

function validateAllowedHorizonUrl(rawUrl: string): { ok: true; normalizedUrl: string } | { ok: false; error: string } {
  const trimmed = rawUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'Invalid horizon URL format' }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Horizon URL must use HTTPS protocol' }
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Horizon URL must not contain embedded credentials' }
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (isPrivateOrLocalHostname(hostname)) {
    return { ok: false, error: 'Horizon URL hostname is not permitted (local or IP addresses are blocked)' }
  }

  const allowedHosts = getAllowedHorizonHosts()
  if (!allowedHosts.has(hostname)) {
    return {
      ok: false,
      error: `Horizon URL host '${hostname}' is not in the allowed Stellar Horizon host allowlist`,
    }
  }

  return { ok: true, normalizedUrl: parsed.toString().replace(/\/+$/, '') }
}

// Minimal KV binding interface for Cloudflare Pages runtime
interface KVNamespace {
  get(key: string, type?: 'text' | 'json'): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

// Helper to get KV namespace
function getKV(): KVNamespace | undefined {
  return (globalThis as unknown as { KV?: KVNamespace }).KV
}

// Helper to check if user is admin
export async function requireAdmin(): Promise<boolean> {
  const { createAuth } = await import('@/lib/auth/auth-factory')

  const { headers: getHeaders, cookies } = await import('next/headers')
  const readonlyHeaders = await getHeaders()
  const cookieStore = await cookies()

  const headers = new Headers()
  readonlyHeaders.forEach((value, key) => headers.append(key, value))

  const cookiesObj: Record<string, string> = {}
  const allCookies = cookieStore.getAll()
  for (const cookie of allCookies) {
    cookiesObj[cookie.name] = cookie.value
  }

  type AuthFactoryDb = Parameters<typeof import('@/lib/auth/auth-factory').createAuth>[0]['DB']
  const db = (globalThis as unknown as { DB: AuthFactoryDb }).DB
  const sessionResult = await createAuth({ DB: db }).api.getSession({
    headers,
    cookies: cookiesObj,
  })

  if (!sessionResult?.user) {
    return false
  }

  const userId = (sessionResult.user as { id: string }).id
  const profile = await db
    .prepare('SELECT role FROM profiles WHERE id = ?')
    .bind(userId)
    .first<{ role: string }>()

  return !!(profile && profile.role === 'admin')
}

/**
 * Stellar configuration interface
 */
export interface StellarConfig {
  network: StellarNetwork
  secretKeyConfigured: boolean
  usdcIssuer: string
  horizonUrl: string
  senderAccountId: string | null
  updatedAt: string
}

/**
 * GET Stellar configuration from KV (with health status)
 */
export async function getStellarSettings(): Promise<{
  config: StellarConfig
  health: {
    horizonConnected: boolean
    senderBalanceUSDC: number
    senderBalanceXLM: number
    errors: string[]
  } | null
}> {
  const isAdmin = await requireAdmin()
  if (!isAdmin) {
    return {
      config: getDefaultConfig(),
      health: null,
    }
  }

  const kv = getKV()
  const config = getDefaultConfig()

  if (kv) {
    const stored = await kv.get(STELLAR_CONFIG_KEY)
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Partial<StellarConfig>
        config.network = parsed.network || StellarNetwork.TESTNET
        config.secretKeyConfigured = parsed.secretKeyConfigured || false
        config.usdcIssuer = parsed.usdcIssuer || config.usdcIssuer
        config.horizonUrl = parsed.horizonUrl || config.horizonUrl
        config.senderAccountId = parsed.senderAccountId || null
        config.updatedAt = parsed.updatedAt || new Date().toISOString()
      } catch (parseError) {
        logError('Failed to parse Stellar config:', parseError)
      }
    }
  }

  const turnkeyHotWallet = process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS?.trim()
  if (turnkeyHotWallet && isValidStellarAccountId(turnkeyHotWallet)) {
    config.secretKeyConfigured = true
    config.senderAccountId = turnkeyHotWallet
  } else if (config.senderAccountId && isValidStellarAccountId(config.senderAccountId)) {
    config.secretKeyConfigured = true
  } else {
    config.secretKeyConfigured = false
    config.senderAccountId = null
  }

  // Get read-only health status using Turnkey HSM hot-wallet public key only (zero raw secret in Worker memory)
  let health = null
  if (config.secretKeyConfigured && config.senderAccountId) {
    try {
      const service = new StellarService({
        network: config.network,
        horizonUrl: config.horizonUrl || undefined,
        usdcIssuer: config.usdcIssuer || undefined,
        senderPublicKey: config.senderAccountId,
      })
      const rawHealth = await service.healthCheck()
      health = {
        ...rawHealth,
        errors: rawHealth.errors.map(sanitizeStellarDiagnosticError),
      }
    } catch (error) {
      health = {
        horizonConnected: false,
        senderBalanceUSDC: 0,
        senderBalanceXLM: 0,
        errors: [
          sanitizeStellarDiagnosticError(
            error instanceof Error ? error.message : 'Failed to get health status'
          ),
        ],
      }
    }
  } else if (turnkeyHotWallet && !isValidStellarAccountId(turnkeyHotWallet)) {
    health = {
      horizonConnected: false,
      senderBalanceUSDC: 0,
      senderBalanceXLM: 0,
      errors: [
        'Invalid Stellar public account ID configured for TURNKEY_STELLAR_HOT_WALLET_ADDRESS (expected G... Ed25519 StrKey)',
      ],
    }
  }

  return { config, health }
}

/**
 * Get default Stellar configuration from code
 */
function getDefaultConfig(): StellarConfig {
  return {
    network: StellarNetwork.TESTNET,
    secretKeyConfigured: false,
    usdcIssuer: CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
    horizonUrl: 'https://horizon.stellar.org',
    senderAccountId: null,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Update Stellar configuration
 * Note: Secret key is handled via environment variables, not stored in KV
 */
export async function updateStellarConfig(
  updates: Partial<Pick<StellarConfig, 'network' | 'horizonUrl'>>
): Promise<{ success: boolean; error?: string }> {
  const isAdmin = await requireAdmin()
  if (!isAdmin) {
    return { success: false, error: 'Unauthorized - admin access required' }
  }

  try {
    const kv = getKV()
    if (!kv) {
      return { success: false, error: 'KV namespace not configured' }
    }

    const current = getDefaultConfig()
    const stored = await kv.get(STELLAR_CONFIG_KEY)
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Partial<StellarConfig>
        Object.assign(current, parsed)
      } catch {
        // Use defaults if parse fails
      }
    }

    if (updates.network) {
      if (!Object.values(StellarNetwork).includes(updates.network)) {
        return { success: false, error: `Invalid network: ${updates.network}` }
      }
      current.network = updates.network
    }

    if (updates.horizonUrl) {
      const validation = validateAllowedHorizonUrl(updates.horizonUrl)
      if (!validation.ok) {
        return { success: false, error: validation.error }
      }
      current.horizonUrl = validation.normalizedUrl
    }

    current.updatedAt = new Date().toISOString()

    await kv.put(STELLAR_CONFIG_KEY, JSON.stringify(current))

    revalidatePath('/api/admin/settings/stellar')
    revalidatePath('/api/admin/notifications')

    return { success: true }
  } catch (error) {
    const safeMessage = sanitizeStellarDiagnosticError(
      error instanceof Error ? error.message : 'Unknown error'
    )
    logError('Failed to update Stellar config:', safeMessage)
    return { success: false, error: safeMessage }
  }
}

/**
 * Test Stellar connection with current configuration
 */
export async function testStellarConnection(): Promise<{
  success: boolean
  network: string
  horizonConnected: boolean
  senderAccountId: string | null
  senderBalanceUSDC: number
  senderBalanceXLM: number
  error?: string
}> {
  const isAdmin = await requireAdmin()
  if (!isAdmin) {
    return {
      success: false,
      network: 'unknown',
      horizonConnected: false,
      senderAccountId: null,
      senderBalanceUSDC: 0,
      senderBalanceXLM: 0,
      error: 'Unauthorized - admin access required',
    }
  }

  try {
    const { config } = await getStellarSettings()

    const rawCandidate =
      process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS?.trim() ||
      config.senderAccountId?.trim() ||
      undefined

    if (!rawCandidate) {
      return {
        success: false,
        network: config.network,
        horizonConnected: false,
        senderAccountId: null,
        senderBalanceUSDC: 0,
        senderBalanceXLM: 0,
        error: 'TURNKEY_STELLAR_HOT_WALLET_ADDRESS not set in environment variables',
      }
    }

    if (!isValidStellarAccountId(rawCandidate)) {
      return {
        success: false,
        network: config.network,
        horizonConnected: false,
        senderAccountId: null,
        senderBalanceUSDC: 0,
        senderBalanceXLM: 0,
        error:
          'Invalid Stellar public account ID configured for TURNKEY_STELLAR_HOT_WALLET_ADDRESS (expected G... Ed25519 StrKey)',
      }
    }

    const service = new StellarService({
      network: config.network,
      horizonUrl: config.horizonUrl || undefined,
      senderPublicKey: rawCandidate,
      usdcIssuer: config.usdcIssuer || undefined,
    })

    const health = await service.healthCheck()
    const safeErrors = health.errors.map(sanitizeStellarDiagnosticError)

    return {
      success: health.healthy,
      network: health.network,
      horizonConnected: health.horizonConnected,
      senderAccountId: health.senderAccount,
      senderBalanceUSDC: health.senderBalanceUSDC,
      senderBalanceXLM: health.senderBalanceXLM,
      error: safeErrors.length > 0 ? safeErrors.join(', ') : undefined,
    }
  } catch (error) {
    return {
      success: false,
      network: 'unknown',
      horizonConnected: false,
      senderAccountId: null,
      senderBalanceUSDC: 0,
      senderBalanceXLM: 0,
      error: sanitizeStellarDiagnosticError(
        error instanceof Error ? error.message : 'Unknown error during connection test'
      ),
    }
  }
}

/**
 * Create a mainnet wallet using xPortal/Stellar Laboratory guidance
 */
export async function getWalletCreationInstructions(): Promise<{
  testnet: { url: string; description: string }
  mainnet: { url: string; description: string }
  secretKeyExample: string
  publicKeyExample: string
  instructions: string[]
}> {
  return {
    testnet: {
      url: 'https://laboratory.stellar.org',
      description: 'Stellar Laboratory - Create test account with Friendbot',
    },
    mainnet: {
      url: 'https://xportal.app',
      description: 'xPortal App - Recommended wallet for mainnet',
    },
    secretKeyExample: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    publicKeyExample: 'GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    instructions: [
      'Tải xPortal từ App Store hoặc Google Play',
      'Tạo wallet mới và chọn network Stellar',
      'Lưu Secret Key (phrase) an toàn, offline',
      'Copy Account ID (public key)',
      'Mua USDC từ sàn và withdraw về Account ID',
    ],
  }
}

/**
 * Get USDC issuer information for current network
 */
export async function getUSDCInfo(network: StellarNetwork): Promise<{
  issuer: string
  code: string
  horizonUrl: string
  explorerUrl: string
  network: string
}> {
  const config: Record<
    StellarNetwork,
    {
      issuer: string
      horizonUrl: string
      explorerUrl: string
    }
  > = {
    [StellarNetwork.TESTNET]: {
      issuer: CANONICAL_STELLAR_TESTNET_USDC_ISSUER,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      explorerUrl: `https://stellar.expert/explorer/testnet/asset/USDC-${CANONICAL_STELLAR_TESTNET_USDC_ISSUER}`,
    },
    [StellarNetwork.MAINNET]: {
      issuer: CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
      horizonUrl: 'https://horizon.stellar.org',
      explorerUrl: `https://stellar.expert/explorer/public/asset/USDC-${CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER}`,
    },
  }

  return {
    issuer: config[network].issuer,
    code: 'USDC',
    horizonUrl: config[network].horizonUrl,
    explorerUrl: config[network].explorerUrl,
    network,
  }
}
