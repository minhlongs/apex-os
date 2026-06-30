/**
 * Admin Notifications API
 * Send multi-channel notifications (admin only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getNotificationService } from '@/lib/notifications';
import type { NotificationChannel } from '@/lib/notifications/config';

/**
 * POST /api/admin/notifications
 * Send a notification via configured channels
 *
 * Headers:
 *   Authorization: Bearer <ADMIN_API_TOKEN>
 *
 * Body:
 *   {
 *     "type": "custom" | "system-alert" | "payout" | "health-degraded",
 *     "title": "string",
 *     "message": "string",
 *     "data": { ...type-specific fields },
 *     "channels": ["slack", "email", "telegram"] (optional - defaults to all enabled)
 *   }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Check admin authorization
  const authHeader = request.headers.get('authorization');
  const adminToken = process.env.ADMIN_API_TOKEN;

  if (!adminToken || !authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized - Invalid or missing admin token' },
      { status: 401 }
    );
  }

  const providedToken = authHeader.slice(7);
  if (providedToken !== adminToken) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized - Invalid admin token' },
      { status: 401 }
    );
  }

  try {
    const admin = await requireAdmin(request);
    if (!admin) {
      return NextResponse.json(
        { success: false, error: 'Forbidden: Admin access required' },
        { status: 403 }
      );
    }
    const body = await request.json();
    const { type, title, message, data, channels } = body as {
      type: string;
      title?: string;
      message?: string;
      data?: Record<string, unknown>;
      channels?: NotificationChannel[];
    };

    if (!type) {
      return NextResponse.json(
        { success: false, error: 'Missing required field: type' },
        { status: 400 }
      );
    }

    const notifier = getNotificationService();

    let results;

    switch (type) {
      case 'system-alert':
        results = await notifier.sendSystemAlert(
          {
            ...data,
            alertId: data?.alertId as string,
            severity: data?.severity as 'info' | 'warning' | 'high' | 'critical',
            metricName: data?.metricName as string,
            currentValue: data?.currentValue as number,
            thresholdValue: data?.thresholdValue as number,
            details: data?.details as string,
          },
          message
        );
        break;

      case 'payout':
        results = await notifier.sendPayoutNotification({
          amount: data?.amount as number,
          walletAddress: data?.walletAddress as string,
          transactionHash: data?.transactionHash as string,
          network: data?.network as 'stellar' | 'stellar-testnet',
          status: data?.status as 'completed' | 'failed' | 'processing',
          payoutDate: data?.payoutDate as string,
          isBatch: data?.isBatch as boolean,
          affiliateCount: data?.affiliateCount as number,
          payoutId: data?.payoutId as string,
        });
        break;

      case 'health-degraded':
        results = await notifier.sendHealthAlert({
          component: data?.component as string,
          issue: data?.issue as string,
          severity: data?.severity as 'info' | 'warning' | 'high' | 'critical',
          healthEndpoint: data?.healthEndpoint as string,
          responseTime: data?.responseTime as number,
          errorRate: data?.errorRate as number,
          databaseSize: data?.databaseSize as number,
          metrics: data?.metrics as Record<string, number | string | boolean>,
        });
        break;

      case 'weekly-summary':
        results = await notifier.sendWeeklySummary({
          period: data?.period as { start: string; end: string },
          totalEarnings: data?.totalEarnings as number,
          conversions: data?.conversions as number,
          activeAffiliates: data?.activeAffiliates as number,
          newUsers: data?.newUsers as number,
          nextPayoutDate: data?.nextPayoutDate as string,
          affiliateRank: data?.affiliateRank as string,
        });
        break;

      case 'commission-earned':
        results = await notifier.sendCommissionEarned({
          userName: data?.userName as string,
          userId: data?.userId as string,
          amount: data?.amount as number,
          dealName: data?.dealName as string,
          exchange: data?.exchange as string,
          tradeVolume: data?.tradeVolume as number,
          tier: data?.tier as 1 | 2 | 3,
          payoutStatus: data?.payoutStatus as 'pending' | 'scheduled' | 'paid',
          payoutDate: data?.payoutDate as string,
          referralChain: data?.referralChain as Array<{ name: string; tier: number }>,
        });
        break;

      case 'custom':
        if (!title || !message) {
          return NextResponse.json(
            { success: false, error: 'Custom notifications require title and message' },
            { status: 400 }
          );
        }
        results = await notifier.sendCustom(title, message, data, { channels });
        break;

      default:
        return NextResponse.json(
          { success: false, error: `Unknown notification type: ${type}` },
          { status: 400 }
        );
    }

    // Summarize results
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return NextResponse.json({
      success: successful.length > 0,
      data: {
        sentTo: successful.map(s => s.channel),
        failed: failed.map(f => ({ channel: f.channel, error: f.error })),
        totalChannels: results.length,
        successCount: successful.length,
        failureCount: failed.length,
      },
    });
  } catch (error) {
    console.error('[Notifications API] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/notifications
 * Get notification configuration status from environment
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Check admin authorization (same as POST)
  const authHeader = request.headers.get('authorization');
  const adminToken = process.env.ADMIN_API_TOKEN;

  if (!adminToken || !authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  const providedToken = authHeader.slice(7);
  if (providedToken !== adminToken) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  const notifier = getNotificationService();
  const config = notifier.getConfig();
  const enabledChannels = notifier.getEnabledChannels();

  return NextResponse.json({
    success: true,
    data: {
      enabled: config.enabled,
      environment: config.environment,
      enabledChannels,
      defaultPriority: config.defaultPriority,
      rateLimitPerMinute: config.rateLimitPerMinute,
      context: notifier.getContext(),
      channels: {
        slack: config.channels.slack?.enabled
          ? { enabled: true, webhookUrl: config.channels.slack.webhookUrl }
          : undefined,
        email: config.channels.email?.enabled
          ? { enabled: true, fromEmail: config.channels.email.fromEmail, recipients: config.channels.email.defaultRecipients }
          : undefined,
        telegram: config.channels.telegram?.enabled
          ? { enabled: true, chatIds: config.channels.telegram.chatIds.length }
          : undefined,
      },
    },
  });
}
