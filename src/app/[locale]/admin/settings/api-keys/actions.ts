/**
 * Admin API Key Management Server Actions
 * Quản lý BYOK API keys cho admin
 */

'use server'

import { getDB } from '@/lib/db'
import {
  setUserApiKey,
  deleteUserApiKey,
  listUserApiKeys,
  ByokProvider,
  ByokStoreError
} from '@/lib/byok'

/**
 * Helper kiểm tra admin role
 */
export async function requireAdmin(): Promise<{ userId: string; role: string } | null> {
  const db = getDB()
  const { createAuth } = await import('@/lib/auth/auth-factory')

  // Lấy session từ headers và cookies
  const { headers: getHeaders, cookies } = await import('next/headers')
  const readonlyHeaders = await getHeaders()
  const cookieStore = await cookies()

  // Convert ReadonlyHeaders to mutable Headers
  const headers = new Headers()
  readonlyHeaders.forEach((value, key) => headers.append(key, value))

  // Build cookies object
  const cookiesObj: Record<string, string> = {}
  const allCookies = cookieStore.getAll()
  for (const cookie of allCookies) {
    cookiesObj[cookie.name] = cookie.value
  }

  const sessionResult = await createAuth({ DB: db }).api.getSession({
    headers,
    cookies: cookiesObj,
  })

  if (!sessionResult?.user) {
    return null
  }

  // Kiểm tra role trong profile
  const userId = (sessionResult.user as { id: string }).id
  const profile = await db
    .prepare('SELECT role FROM profiles WHERE id = ?')
    .bind(userId)
    .first<{ role: string }>()

  if (!profile || profile.role !== 'admin') {
    return null
  }

  return { userId, role: profile.role }
}

/**
 * API Key metadata cho UI
 */
export interface ApiKeyInfo {
  provider: ByokProvider
  created_at: string
  updated_at: string
}

/**
 * GET danh sách API keys metadata của current admin user
 */
export async function getUserKeys(): Promise<ApiKeyInfo[]> {
  try {
    const admin = await requireAdmin()
    if (!admin) {
      throw new Error('Unauthorized: Admin access required')
    }

    const keys = await listUserApiKeys(admin.userId)
    return keys
  } catch (error) {
    console.error('[Admin API Keys] Error fetching keys:', error)
    if (error instanceof ByokStoreError) {
      throw error
    }
    throw new Error('Không thể tải danh sách API keys')
  }
}

/**
 * Thêm mới API key
 */
export async function addApiKey(formData: FormData): Promise<{ success: boolean; error?: string }> {
  try {
    const admin = await requireAdmin()
    if (!admin) {
      return { success: false, error: 'Unauthorized: Admin access required' }
    }

    const provider = formData.get('provider') as string
    const apiKey = formData.get('apiKey') as string

    // Validate provider
    const validProviders: ByokProvider[] = ['binance', 'bybit', 'resend']
    if (!provider || !validProviders.includes(provider as ByokProvider)) {
      return { success: false, error: 'Provider không hợp lệ' }
    }

    // Validate API key
    if (!apiKey || apiKey.trim().length < 5) {
      return { success: false, error: 'API key phải có ít nhất 5 ký tự' }
    }

    // Lưu key đã được mã hóa
    await setUserApiKey(admin.userId, provider as ByokProvider, apiKey.trim())

    console.log('[Admin API Keys] API key added', { userId: admin.userId, provider })
    return { success: true }
  } catch (error) {
    console.error('[Admin API Keys] Error adding key:', error)
    const message = error instanceof ByokStoreError
      ? `Lỗi lưu API key: ${error.message}`
      : 'Không thể lưu API key'
    return { success: false, error: message }
  }
}

/**
 * Xóa API key
 */
export async function deleteApiKey(provider: string): Promise<{ success: boolean; error?: string }> {
  try {
    const admin = await requireAdmin()
    if (!admin) {
      return { success: false, error: 'Unauthorized: Admin access required' }
    }

    const validProviders: ByokProvider[] = ['binance', 'bybit', 'resend']
    if (!provider || !validProviders.includes(provider as ByokProvider)) {
      return { success: false, error: 'Provider không hợp lệ' }
    }

    await deleteUserApiKey(admin.userId, provider as ByokProvider)

    console.log('[Admin API Keys] API key deleted', { userId: admin.userId, provider })
    return { success: true }
  } catch (error) {
    console.error('[Admin API Keys] Error deleting key:', error)
    const message = error instanceof ByokStoreError
      ? `Lỗi xóa API key: ${error.message}`
      : 'Không thể xóa API key'
    return { success: false, error: message }
  }
}
