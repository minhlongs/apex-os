/**
 * Admin Notification Settings Server Actions (KV Storage)
 * Provides data fetching and operations for the notification configuration page
 */

'use server'

import { revalidatePath } from 'next/cache'
import { error as logError, warn as logWarn } from '@/lib/logger'
import type { NotificationConfig, SlackConfig, EmailConfig, TelegramConfig } from '@/lib/notifications/config'
import { loadConfig as loadEnvConfig } from '@/lib/notifications/config'

// KV storage keys
const CONFIG_PREFIX = 'notification_config:'

function getConfigKey(channelType: string): string {
  return `${CONFIG_PREFIX}${channelType}`
}

// Helper to get KV namespace
function getKV() {
  return (globalThis as unknown as { KV: KVNamespace }).KV
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

  // Get DB for auth (still need D1 for auth)
  const db = (globalThis as unknown as { DB: Parameters<typeof import('@/lib/auth/auth-factory').createAuth>[0]['DB'] }).DB!
  const sessionResult = await createAuth({ DB: db as any }).api.getSession({
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
 * GET notification configuration from KV
 * Falls back to environment variables for display
 */
export async function getNotificationSettings(): Promise<{
  envConfig: NotificationConfig
  dbConfig: Record<string, SlackConfig | EmailConfig | TelegramConfig | null>
}> {
  const isAdmin = await requireAdmin()
  if (!isAdmin) {
    return { envConfig: loadEnvConfig(), dbConfig: {} }
  }

  const kv = getKV()
  if (!kv) {
    logWarn('[NotificationSettings] KV namespace not available, returning empty config')
    return { envConfig: loadEnvConfig(), dbConfig: {} }
  }

  const channelTypes = ['slack', 'email', 'telegram'] as const
  const dbConfig: Record<string, SlackConfig | EmailConfig | TelegramConfig | null> = {}

  for (const channelType of channelTypes) {
    const key = getConfigKey(channelType)
    const value = await kv.get(key)

    if (value) {
      try {
        const config = JSON.parse(value) as Record<string, unknown>

        if (channelType === 'slack') {
          dbConfig.slack = {
            enabled: Boolean(config.enabled),
            webhookUrl: (config.webhookUrl as string) || '',
            channel: (config.channel as string | undefined) || undefined,
            username: (config.username as string | undefined) || 'ApexOS Bot',
            iconEmoji: (config.iconEmoji as string | undefined) || ':rocket:',
            iconUrl: (config.iconUrl as string | undefined) || undefined,
          }
        } else if (channelType === 'email') {
          dbConfig.email = {
            enabled: Boolean(config.enabled),
            apiKey: (config.apiKey as string) || '',
            fromEmail: (config.fromEmail as string) || 'noreply@apexos.io',
            fromName: (config.fromName as string) || 'ApexOS',
            defaultRecipients: (config.defaultRecipients as string[]) || [],
            replyTo: (config.replyTo as string | undefined) || undefined,
          }
        } else if (channelType === 'telegram') {
          dbConfig.telegram = {
            enabled: Boolean(config.enabled),
            botToken: (config.botToken as string) || '',
            chatIds: (config.chatIds as string[]) || [],
            parseMode: (config.parseMode as 'HTML' | 'Markdown') || 'HTML',
            disableWebPagePreview: Boolean(config.disableWebPagePreview ?? false),
          }
        }
      } catch (parseError) {
        logError(`Failed to parse KV config for ${channelType}:`, parseError)
      }
    }
  }

  return {
    envConfig: loadEnvConfig(),
    dbConfig,
  }
}

/**
 * Save notification configuration for a channel to KV
 */
export async function updateNotificationChannel(
  channelType: 'slack' | 'email' | 'telegram',
  config: SlackConfig | EmailConfig | TelegramConfig
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

    const key = getConfigKey(channelType)

    // Store config with metadata
    const storedConfig = {
      ...config,
      enabled: config.enabled ?? true,
      updatedAt: new Date().toISOString(),
    }

    await kv.put(key, JSON.stringify(storedConfig))

    // Clear any relevant caches
    revalidatePath('/api/admin/notifications')
    revalidatePath('/api/admin/notifications/config')

    return { success: true }
  } catch (error) {
    logError('Failed to update notification config:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

/**
 * Test connection for a specific notification channel
 * Uses provided config (not stored config) to test new settings
 */
export async function testNotificationConnection(
  channelType: 'slack' | 'email' | 'telegram',
  config: SlackConfig | EmailConfig | TelegramConfig
): Promise<{
  success: boolean
  error?: string
  details?: Record<string, unknown>
}> {
  const isAdmin = await requireAdmin()
  if (!isAdmin) {
    return { success: false, error: 'Unauthorized - admin access required' }
  }

  try {
    const { getNotificationService } = await import('@/lib/notifications')

    const testMessage = {
      type: 'custom' as const,
      title: 'Test Connection',
      message: `This is a test notification from ApexOS admin panel. If you receive this, the ${channelType} configuration is working correctly.`,
      priority: 'normal' as const,
      payload: {
        test: true,
        timestamp: new Date().toISOString(),
        channel: channelType,
      },
    }

    let result;
    switch (channelType) {
      case 'slack':
        const { SlackNotifier } = await import('@/lib/notifications/channels/slack')
        const slackConfig = config as SlackConfig
        const slackNotifier = new SlackNotifier({
          webhookUrl: slackConfig.webhookUrl,
          channel: slackConfig.channel,
          username: slackConfig.username || 'ApexOS Bot',
          iconEmoji: slackConfig.iconEmoji || ':rocket:',
          iconUrl: slackConfig.iconUrl,
        })
        result = await slackNotifier.send(testMessage)
        break

      case 'email':
        const { EmailNotifierChannel } = await import('@/lib/notifications/channels/email')
        const emailConfig = config as EmailConfig
        const emailNotifier = new EmailNotifierChannel(emailConfig)
        // Send to first recipient or a test address
        const testRecipient = emailConfig.defaultRecipients[0] || 'test@example.com'
        result = await emailNotifier.send(testMessage, testRecipient)
        break

      case 'telegram':
        const { TelegramNotifier } = await import('@/lib/notifications/channels/telegram')
        const telegramConfig = config as TelegramConfig
        const telegramNotifier = new TelegramNotifier({
          botToken: telegramConfig.botToken,
          chatIds: telegramConfig.chatIds,
          parseMode: telegramConfig.parseMode,
          disableWebPagePreview: telegramConfig.disableWebPagePreview,
        })
        result = await telegramNotifier.send({
          ...testMessage,
          payload: {
            ...testMessage.payload,
            text: `*Test Connection*\n\n${testMessage.message}\n\n_Sent at ${new Date().toLocaleString()}_`,
          },
        })
        break

      default:
        return { success: false, error: 'Unknown channel type' }
    }

    if (result.success) {
      return {
        success: true,
        details: {
          messageId: result.messageId,
          channel: result.channel,
          timestamp: result.timestamp,
        },
      }
    } else {
      return {
        success: false,
        error: result.error || 'Connection test failed',
      }
    }
  } catch (error) {
    logError(`Test connection failed for ${channelType}:`, error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during test',
    }
  }
}

/**
 * Delete notification channel configuration from KV
 */
export async function deleteNotificationChannel(
  channelType: 'slack' | 'email' | 'telegram'
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

    const key = getConfigKey(channelType)
    await kv.delete(key)

    revalidatePath('/api/admin/notifications')
    revalidatePath('/api/admin/notifications/config')

    return { success: true }
  } catch (error) {
    logError('Failed to delete notification config:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
