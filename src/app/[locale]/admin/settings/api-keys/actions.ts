
'use server'

import { getDB } from '@/lib/db'
import {
  setUserApiKey,
  deleteUserApiKey,
  listUserApiKeys,
  ByokProvider,
  ByokStoreError
} from '@/lib/byok'
import { error as logError, info as logInfo } from '@/lib/logger'
import { requireAdmin } from '@/lib/admin-auth'

export interface ApiKeyInfo {
  provider: ByokProvider
  created_at: string
  updated_at: string
}

export async function getUserKeys(): Promise<ApiKeyInfo[]> {
  try {
    const admin = await requireAdmin()
    if (!admin) {
      throw new Error('Unauthorized: Admin access required')
    }

    const keys = await listUserApiKeys(admin.userId)
    return keys
  } catch (error) {
    logError('[Admin API Keys] Error fetching keys:', error)
    if (error instanceof ByokStoreError) {
      throw error
    }
    throw new Error('Không thể tải danh sách API keys')
  }
}

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

    logInfo('[Admin API Keys] API key added', { userId: admin.userId, provider })
    return { success: true }
  } catch (error) {
    logError('[Admin API Keys] Error adding key:', error)
    const message = error instanceof ByokStoreError
      ? `Lỗi lưu API key: ${error.message}`
      : 'Không thể lưu API key'
    return { success: false, error: message }
  }
}

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

    logInfo('[Admin API Keys] API key deleted', { userId: admin.userId, provider })
    return { success: true }
  } catch (error) {
    logError('[Admin API Keys] Error deleting key:', error)
    const message = error instanceof ByokStoreError
      ? `Lỗi xóa API key: ${error.message}`
      : 'Không thể xóa API key'
    return { success: false, error: message }
  }
}
