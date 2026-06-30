/* @ts-nocheck - Usage examples, not type-checked */
/**
 * Notification System Usage Examples
 * Demonstrates how to use the multi-channel notification system
 */

import { getNotificationService, createNotificationService } from '@/lib/notifications';
import { createEmailNotifierChannel } from '@/lib/notifications/channels/email';
import type { NotificationChannel } from '@/lib/notifications/config';

// ============================================================================
// Basic Setup
// ============================================================================

// Get the singleton instance (auto-initializes from env vars)
const notifier = getNotificationService();

// Or create a custom instance with specific config
const customNotifier = createNotificationService(
  {
    environment: 'production',
    enabled: true,
    defaultPriority: 'normal',
    rateLimitPerMinute: 100,
    retries: { maxAttempts: 3, backoffMs: 1000 },
    channels: {
      slack: {
        enabled: true,
        webhookUrl: process.env.SLACK_WEBHOOK_URL!,
        username: 'ApexOS Alerts',
        iconEmoji: ':warning:',
      },
      email: {
        enabled: true,
        apiKey: process.env.RESEND_API_KEY!,
        fromEmail: 'alerts@apexos.io',
        fromName: 'ApexOS Alerts',
        defaultRecipients: ['admin@apexos.io', 'devops@apexos.io'],
      },
      telegram: {
        enabled: true,
        botToken: process.env.TELEGRAM_BOT_TOKEN!,
        chatIds: ['-1001234567890'],
        parseMode: 'HTML',
      },
    },
  },
  {
    baseUrl: 'https://apexos.io',
    locale: 'en',
    appName: 'ApexOS',
    environment: 'production',
    supportEmail: 'support@apexos.io',
    docsUrl: 'https://docs.apexos.io',
  }
);

// ============================================================================
// Send Custom Notification (any channel)
// ============================================================================

async function sendCustomAlert() {
  const results = await notifier.sendCustom(
    'Database Storage Warning',
    'D1 database storage has reached 8GB out of 10GB quota. Consider archiving old data.',
    {
      metric: 'database_storage',
      currentValue: 8.2,
      thresholdValue: 8.0,
      unit: 'GB',
      database_name: 'apex-os-db',
      actions: [
        { label: 'View Metrics', url: '/admin/metrics' },
        { label: 'Run Cleanup', url: '/admin/maintenance/cleanup' },
      ],
    },
    {
      priority: 'high',
      channels: ['slack', 'email', 'telegram'], // optional - defaults to all enabled
    }
  );

}

// ============================================================================
// System Alert (for monitoring/health checks)
// ============================================================================

async function sendSystemAlert() {
  await notifier.sendSystemAlert(
    {
      alertId: 'alert_12345',
      alertName: 'High API Error Rate',
      severity: 'high',
      metricName: 'API Error Rate',
      currentValue: 0.05, // 5%
      thresholdValue: 0.02, // 2%
      details: 'API error rate exceeded 2% threshold over the last 5 minutes. Affected endpoints: /api/deals, /api/tracking/click.',
      endpoint: '/api/deals',
      metricType: 'api-errors',
    },
    // Optional custom message overrides the default
    'Critical: API error rate spike detected on production'
  );
}

// ============================================================================
// Payout Notification
// ============================================================================

async function sendPayoutNotification() {
  await notifier.sendPayoutNotification({
    amount: 1250.50,
    walletAddress: 'GABCDEF1234567890GHIJKLMNOPQRSTUV',
    transactionHash: 'ABCDEF1234567890GHIJKLMNOPQRSTUVWXYZ1234567890',
    network: 'stellar',
    status: 'completed',
    payoutDate: '2026-06-21T10:30:00Z',
    isBatch: true,
    affiliateCount: 47,
    payoutId: 'payout_abc123',
  });
}

// ============================================================================
// Commission Earned (real-time)
// ============================================================================

async function sendCommissionEarned() {
  await notifier.sendCommissionEarned({
    userName: 'John Doe',
    userId: 'user_123',
    amount: 45.50,
    dealName: 'Binance BTC/USDT 0.1% rebate',
    exchange: 'Binance',
    tradeVolume: 1500.00,
    tier: 2,
    payoutStatus: 'pending',
    referralChain: [
      { name: 'Affiliate Alpha', tier: 1 },
      { name: 'Super Affiliate Beta', tier: 0 },
    ],
  });
}

// ============================================================================
// Health Alert
// ============================================================================

async function sendHealthAlert() {
  await notifier.sendHealthAlert({
    component: 'Database Connection Pool',
    issue: 'Connection pool utilization at 95%',
    severity: 'warning',
    healthEndpoint: '/health/database',
    responseTime: 150,
    errorRate: 0.01,
    databaseSize: 8589934592, // 8GB
  });
}

// ============================================================================
// Weekly Summary
// ============================================================================

async function sendWeeklySummary() {
  await notifier.sendWeeklySummary({
    period: {
      start: '2026-06-15T00:00:00Z',
      end: '2026-06-21T23:59:59Z',
    },
    totalEarnings: 15420.50,
    conversions: 234,
    activeAffiliates: 89,
    newUsers: 45,
    nextPayoutDate: '2026-06-28',
    affiliateRank: 'Gold',
  });
}

// ============================================================================
// Channel-Specific Sending
// ============================================================================

async function sendToSlackOnly() {
  // Use a specific channel
  const results = await notifier.sendCustom(
    'Deployment Complete',
    'Production deployment finished successfully. All systems operational.',
    {
      deploymentId: 'deploy_abc123',
      version: 'v1.2.3',
      commit: 'a1b2c3d',
    },
    { channels: ['slack'] }
  );
}

async function sendEmailToAdminsOnly() {
  // Send email to specific recipients
  const emailChannel = createEmailNotifierChannel({
    apiKey: process.env.RESEND_API_KEY!,
    fromEmail: 'reports@apexos.io',
    fromName: 'ApexOS Reports',
    defaultRecipients: ['finance@apexos.io', 'ceo@apexos.io'],
  });

  const result = await emailChannel.send({
    type: 'custom',
    title: 'Weekly Financial Report',
    message: 'Attached is the weekly financial report...',
    priority: 'normal',
    payload: {
      reportPeriod: '2026-W25',
      totalRevenue: 50000,
      expenses: 15000,
      profit: 35000,
    },
  });

}

// ============================================================================
// API Route Example (Server Action / Route Handler)
// ============================================================================

/*
// In src/app/api/notifications/send/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getNotificationService } from '@/lib/notifications';

export async function POST(request: NextRequest) {
  // Verify admin authorization
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.ADMIN_API_TOKEN}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { type, data } = body;

  const notifier = getNotificationService();

  try {
    switch (type) {
      case 'system-alert':
        await notifier.sendSystemAlert(data);
        break;
      case 'payout':
        await notifier.sendPayoutNotification(data);
        break;
      case 'health':
        await notifier.sendHealthAlert(data);
        break;
      default:
        await notifier.sendCustom(data.title, data.message, data.payload);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to send' },
      { status: 500 }
    );
  }
}
*/

// ============================================================================
// Utility: Test All Channels
// ============================================================================

export async function testAllChannels() {
  const notifier = getNotificationService();


  // Send test notification to all enabled channels
  const results = await notifier.sendCustom(
    'Notification System Test',
    'This is a test notification from ApexOS. All channels are working correctly.',
    {
      test: true,
      timestamp: new Date().toISOString(),
      actions: [
        { label: 'View Dashboard', url: '/admin/monitoring' },
        { label: 'Documentation', url: '/docs/notifications' },
      ],
    },
    { priority: 'low' }
  );


  const successCount = results.filter(r => r.success).length;

  return results;
}
