/**
 * Admin Notification Config API (KV Storage)
 * GET /api/admin/notifications/config - Get all channel configurations
 * PUT /api/admin/notifications/config - Update a channel configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { error as logError } from '@/lib/logger';
import { requireAdmin } from '../../actions';

// KV storage keys
const CONFIG_PREFIX = 'notification_config:';

function getConfigKey(channelType: string): string {
  return `${CONFIG_PREFIX}${channelType}`;
}

/**
 * GET /api/admin/notifications/config
 * Returns all notification channel configurations from KV
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    // Access KV namespace from global bindings
    const kv = (globalThis as unknown as { KV: KVNamespace }).KV;
    if (!kv) {
      return NextResponse.json(
        { success: false, error: 'KV namespace not configured' },
        { status: 503 }
      );
    }

    const channels: Array<{
      channelType: string;
      enabled: boolean;
      config: Record<string, unknown>;
      updatedAt: string | null;
    }> = [];

    // Fetch configs for all three channels
    const channelTypes = ['slack', 'email', 'telegram'] as const;

    for (const channelType of channelTypes) {
      const key = getConfigKey(channelType);
      const value = await kv.get(key);

      if (value) {
        try {
          const config = JSON.parse(value);
          channels.push({
            channelType,
            enabled: config.enabled ?? false,
            config: config,
            updatedAt: config.updatedAt ?? null,
          });
        } catch (parseError) {
          logError(`Failed to parse config for ${channelType}:`, parseError);
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: { channels },
    });
  } catch (error) {
    logError('Error fetching notification configs:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch configurations' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/admin/notifications/config
 * Updates configuration for a specific channel
 * Body: { channelType: 'slack' | 'email' | 'telegram', config: Record<string, unknown> }
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const { channelType, config } = body as {
      channelType: 'slack' | 'email' | 'telegram';
      config: Record<string, unknown>;
    };

    if (!channelType || !['slack', 'email', 'telegram'].includes(channelType)) {
      return NextResponse.json(
        { success: false, error: 'Invalid channel type' },
        { status: 400 }
      );
    }

    const kv = (globalThis as unknown as { KV: KVNamespace }).KV;
    if (!kv) {
      return NextResponse.json(
        { success: false, error: 'KV namespace not configured' },
        { status: 503 }
      );
    }

    // Store config with metadata
    const storedConfig = {
      ...config,
      enabled: config.enabled ?? true,
      updatedAt: new Date().toISOString(),
      updatedBy: admin.userId,
    };

    const key = getConfigKey(channelType);
    await kv.put(key, JSON.stringify(storedConfig), {
      expirationTtl: undefined, // persist indefinitely
    });

    return NextResponse.json({
      success: true,
      data: { channelType, enabled: storedConfig.enabled, config: storedConfig },
    });
  } catch (error) {
    logError('Error updating notification config:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update configuration' },
      { status: 500 }
    );
  }
}
