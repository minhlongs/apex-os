/**
 * Admin Notifications Settings Server Actions
 * Provides authentication and configuration operations
 */

'use server'

import { getDB } from '@/lib/db';
import { error as logError } from '@/lib/logger';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/admin-auth';

/**
 * Get notification channel configurations
 */
export async function getNotificationConfigs() {
  const admin = await requireAdmin();
  if (!admin) {
    return { success: false, error: 'Unauthorized' };
  }

  const db = getDB();

  try {
    // Get notification channel configs
    const configs = await db.prepare(`
      SELECT channel_type, enabled, config, created_at, updated_at
      FROM notification_channels
      ORDER BY channel_type
    `).all();

    // Get test results
    const testResults = await db.prepare(`
      SELECT channel_type, last_test_at, last_test_status, last_test_error
      FROM notification_test_results
      ORDER BY last_test_at DESC
    `).all();

    return {
      success: true,
      configs: configs.results,
      testResults: testResults.results,
    };
  } catch (error) {
    logError('Error fetching notification configs:', error);
    return { success: false, error: 'Failed to fetch configurations' };
  }
}

/**
 * Update notification channel configuration
 */
export async function updateNotificationConfig(
  channelType: string,
  enabled: boolean,
  config: Record<string, unknown>
) {
  const admin = await requireAdmin();
  if (!admin) {
    return { success: false, error: 'Unauthorized' };
  }

  const db = getDB();

  try {
    // Upsert configuration
    const existing = await db.prepare(
      'SELECT id FROM notification_channels WHERE channel_type = ?'
    ).bind(channelType).first();

    if (existing) {
      await db.prepare(`
        UPDATE notification_channels
        SET enabled = ?, config = ?, updated_at = datetime('now')
        WHERE channel_type = ?
      `).bind(
        enabled ? 1 : 0,
        JSON.stringify(config),
        channelType
      ).run();
    } else {
      await db.prepare(`
        INSERT INTO notification_channels (channel_type, enabled, config, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `).bind(
        channelType,
        enabled ? 1 : 0,
        JSON.stringify(config)
      ).run();
    }

    revalidatePath('/admin/settings/notifications');

    return { success: true };
  } catch (error) {
    logError('Error updating notification config:', error);
    return { success: false, error: 'Failed to update configuration' };
  }
}

/**
 * Test notification channel connection
 */
export async function testNotificationChannel(channelType: string): Promise<{ success: boolean; error?: string; details?: unknown }> {
  const admin = await requireAdmin();
  if (!admin) {
    return { success: false, error: 'Unauthorized' };
  }

  const db = getDB();

  try {
    // Get channel configuration
    const configRow = await db.prepare(
      'SELECT config FROM notification_channels WHERE channel_type = ? AND enabled = 1'
    ).bind(channelType).first<{ config: string }>();

    if (!configRow) {
      return { success: false, error: 'Channel not configured or disabled' };
    }

    const config = JSON.parse(configRow.config);

    // Test the channel based on type
    let testResult: { success: boolean; error?: string };

    switch (channelType) {
      case 'email':
        testResult = await testEmail(config);
        break;
      case 'slack':
        testResult = await testSlack(config);
        break;
      case 'telegram':
        testResult = await testTelegram(config);
        break;
      case 'webhook':
        testResult = await testWebhook(config);
        break;
      default:
        return { success: false, error: 'Unknown channel type' };
    }

    // Return with details for successful tests
    if (testResult.success) {
      return { success: true, details: testResult };
    }
    return { success: false, error: testResult.error };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logError(`Error testing notification channel ${channelType}:`, error);

    return { success: false, error: errorMessage };
  }
}

async function testEmail(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = (config.fromEmail as string) || process.env.ALERT_EMAIL || 'noreply@apexos.io';
  const testEmailAddr = (config.testEmail as string) || 'test@example.com';

  if (!apiKey) {
    return { success: false, error: 'RESEND_API_KEY not configured' };
  }

  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);

    await resend.emails.send({
      from: fromEmail,
      to: testEmailAddr,
      subject: 'ApexOS Notification Test',
      text: 'This is a test email from ApexOS notification system.',
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to send test email' };
  }
}

async function testSlack(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const webhookUrl = config.webhookUrl as string;

  if (!webhookUrl) {
    return { success: false, error: 'Webhook URL not configured' };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Test notification from ApexOS',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*ApexOS Test*\nNotification channel test successful.',
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      return { success: false, error: `Slack API error: ${response.status}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to send Slack message' };
  }
}

async function testTelegram(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const botToken = config.botToken as string;
  const chatId = config.chatId as string;

  if (!botToken || !chatId) {
    return { success: false, error: 'Bot token or chat ID not configured' };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Test notification from ApexOS',
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      return { success: false, error: `Telegram API error: ${data.description}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to send Telegram message' };
  }
}

async function testWebhook(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const webhookUrl = config.url as string;

  if (!webhookUrl) {
    return { success: false, error: 'Webhook URL not configured' };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        test: true,
        message: 'ApexOS notification test',
        timestamp: new Date().toISOString(),
      }),
    });

    // 2xx or 3xx are considered success for webhooks
    if (response.status >= 200 && response.status < 400) {
      return { success: true };
    }

    return { success: false, error: `Webhook returned status ${response.status}` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to call webhook' };
  }
}
