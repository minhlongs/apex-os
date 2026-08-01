/**
 * Business Alert Notification Channels

 * Formatting and sending functions for business alerts across channels.
 * These are convenience wrappers around the notification service.
 */

import { getNotificationService } from './index';
import type { NotificationChannel } from './config';
import { error as logError } from '@/lib/logger';
import type { BusinessAlert, AlertEvaluationContext, BusinessAlertConfig } from '@/types/business-alerting';

// ============================================================================
// Message Building
// ============================================================================

/**
 * Build alert message components
 */
export function buildAlertMessage(
  alert: BusinessAlert,
  context: AlertEvaluationContext
): { subject: string; body: string; trend: string } {
  const severityEmoji = getSeverityEmoji(alert.details?.severity || 'warning');

  const subject = `${severityEmoji} ${alert.details?.metricName || 'Business Alert'}`;

  // Build body based on metric type
  let body = '';
  const trend = alert.details?.trend || 'unknown';

  switch (alert.details?.metricType) {
    case 'revenue_drop':
      body = `Revenue has dropped to $${formatNumber(context.todayRevenue || 0)}.\n` +
        `7-day average: $${formatNumber(context.sevenDayAvgRevenue || 0)}\n` +
        `Trend: ${trend}`;
      break;
    case 'conversion_rate':
      body = `Conversion rate: ${(context.todayConversionRate || 0).toFixed(2)}%\n` +
        `7-day average: ${(context.last7DayAvgConversionRate || 0).toFixed(2)}%\n` +
        `Clicks: ${context.clicksToday}, Conversions: ${context.conversionsToday}`;
      break;
    case 'webhook_failures':
      body = `Webhook failure rate: ${(context.webhookFailureRate || 0).toFixed(1)}%\n` +
        `Failed: ${context.webhookFailedAttempts || 0} / ${context.webhookTotalAttempts || 0}`;
      break;
    case 'payout_failures':
      body = `Payout failure rate: ${(context.payoutFailureRate || 0).toFixed(1)}%\n` +
        `Failed: ${context.failedPayouts || 0} / ${context.totalPayouts || 0}`;
      break;
    case 'stellar_balance':
      body = `Stellar USDC balance: $${formatNumber(context.stellarBalance || 0)}\n` +
        `Wallet: ${context.walletAddress ? context.walletAddress.slice(0, 10) + '...' : 'N/A'}`;
      break;
    default:
      body = `Current value: ${alert.current_value}\nThreshold: ${alert.threshold_value}`;
  }

  return { subject, body, trend };
}

/**
 * Get emoji for severity
 */
export function getSeverityEmoji(severity: string): string {
  switch (severity?.toLowerCase()) {
    case 'critical': return '🔴';
    case 'warning': return '🟡';
    case 'info': return '🟢';
    default: return '⚪';
  }
}

/**
 * Format number with locale
 */
export function formatNumber(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ============================================================================
// Email Formatting
// ============================================================================

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
}

/**
 * Format alert as email
 */
export function formatAlertEmail(
  alert: BusinessAlert,
  context: AlertEvaluationContext,
  options?: { appName?: string; baseUrl?: string; recipients?: string | string[] }
): EmailMessage {
  const appName = options?.appName || process.env.NEXT_PUBLIC_APP_NAME || 'ApexOS';
  const baseUrl = options?.baseUrl || process.env.NEXT_PUBLIC_BASE_URL || 'https://apex-os.pages.dev';
  const recipients = options?.recipients || process.env.ALERT_EMAIL || process.env.NOTIFICATION_EMAIL_RECIPIENTS || 'alerts@example.com';

  const { subject, body } = buildAlertMessage(alert, context);
  const severity = alert.details?.severity || 'warning';
  const severityUpper = severity.toUpperCase();

  // HTML version
  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${subject}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 24px; border-radius: 8px; }
.header { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; padding: 16px; border-radius: 8px 8px 0 0; margin: -24px -24px 16px; }
.title { margin: 0; font-size: 18px; }
.body { white-space: pre-wrap; font-size: 14px; line-height: 1.6; }
.footer { margin-top: 20px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #666; }
a { color: #6366f1; }
</style>
</head>
<body>
<div class="container">
<div class="header">
<h1 class="title">${subject}</h1>
</div>
<div class="body">${body}</div>
<div class="footer">
<p><a href="${baseUrl}/admin/alerts">View Alerts</a> | <a href="${baseUrl}/admin/monitoring">Dashboard</a> | <a href="${baseUrl}/admin/alerts/config">Configure</a></p>
<p>Sent by ${appName}</p>
</div>
</div>
</body>
</html>`;

  // Text version
  const text = `${subject}\n\n${body}\n\nView: ${baseUrl}/admin/alerts`;

  return {
    to: recipients,
    subject: `[${appName}] [${severityUpper}] ${subject}`,
    html,
    text,
  };
}

// ============================================================================
// Webhook Formatting
// ============================================================================

export interface WebhookPayload {
  alert: string;
  severity: string;
  metric: string;
  currentValue: number;
  thresholdValue: number;
  alertId: string;
  details?: Record<string, unknown>;
  triggeredAt: string;
}

/**
 * Format alert as webhook payload
 */
export function formatAlertWebhook(
  alert: BusinessAlert,
  context: AlertEvaluationContext
): WebhookPayload {
  return {
    alert: alert.details?.metricName || 'Business Alert',
    severity: alert.details?.severity || 'warning',
    metric: alert.details?.metricType || 'unknown',
    currentValue: alert.current_value,
    thresholdValue: alert.threshold_value,
    alertId: alert.id,
    details: {
      ...alert.details,
      evaluationContext: {
        todayRevenue: context.todayRevenue,
        sevenDayAvgRevenue: context.sevenDayAvgRevenue,
        revenueTrend: context.revenueTrend,
        todayConversionRate: context.todayConversionRate,
        clicksToday: context.clicksToday,
        conversionsToday: context.conversionsToday,
      },
    },
    triggeredAt: alert.triggered_at.toISOString(),
  };
}

// ============================================================================
// Slack Formatting
// ============================================================================

export interface SlackMessage {
  text: string;
  blocks: Array<{ type: string; [key: string]: unknown }>;
}

/**
 * Format alert as Slack message with blocks
 */
export function formatAlertSlack(
  alert: BusinessAlert,
  context: AlertEvaluationContext,
  options?: { baseUrl?: string }
): SlackMessage {
  const baseUrl = options?.baseUrl || process.env.NEXT_PUBLIC_BASE_URL || 'https://apex-os.pages.dev';
  const severity = alert.details?.severity || 'warning';
  const emoji = getSeverityEmoji(severity);

  const text = `${emoji} *${alert.details?.metricName || 'Business Alert'}*`;

  const blocks: Array<{ type: string; [key: string]: unknown }> = [
    { type: 'header', text: { type: 'plain_text', text: alert.details?.metricName || 'Alert' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Severity:* ${severity.toUpperCase()}\n*Metric:* ${alert.details?.metricType || 'unknown'}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Current*\n${alert.current_value}` },
        { type: 'mrkdwn', text: `*Threshold*\n${alert.threshold_value}` },
        { type: 'mrkdwn', text: `*Trend*\n${context.revenueTrend || 'N/A'}` },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Dashboard' },
          url: `${baseUrl}/admin/monitoring`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Alerts' },
          url: `${baseUrl}/admin/alerts`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Configure' },
          url: `${baseUrl}/admin/alerts/config`,
          style: 'primary',
        },
      ],
    },
  ];

  return { text, blocks };
}

// ============================================================================
// Notification Sending
// ============================================================================

/**
 * Alert configuration factory for tests
 */
export function createMockAlertConfig(overrides: Partial<BusinessAlertConfig> = {}): BusinessAlertConfig {
  return {
    id: 'test-config',
    name: 'Test Alert',
    metric_type: 'revenue_drop',
    severity: 'warning',
    alert_channels: ['email'],
    evaluation_window_minutes: 60,
    threshold_value: 100,
    ...overrides,
  } as BusinessAlertConfig;
}

/**
 * Send business alert notification
 */
export async function sendBusinessAlertNotification(
  config: BusinessAlertConfig,
  alert: BusinessAlert,
  evaluationContext: AlertEvaluationContext
): Promise<void> {
  const notifier = getNotificationService();
  const serviceContext = notifier.getContext();

  // Build actionable links
  const actions = [
    { label: 'View Dashboard', url: `${serviceContext.baseUrl}/admin/monitoring`, secondary: false },
    { label: 'View Details', url: `${serviceContext.baseUrl}/admin/monitoring/alerts/${alert.id}`, secondary: true },
    { label: 'Alert Configuration', url: `${serviceContext.baseUrl}/admin/alerts/config`, secondary: true },
  ];

  // Determine priority
  const priority = mapSeverityToPriority(config.severity);

  // Supported channels
  const businessChannels = config.alert_channels as Array<'email' | 'webhook' | 'slack' | 'telegram' | 'console'>;
  const supportedChannels: NotificationChannel[] = businessChannels.filter(
    ch => ['slack', 'email', 'telegram', 'webhook', 'console'].includes(ch)
  ) as NotificationChannel[];

  const messagePayload = {
    type: 'business-alert' as const,
    title: `[${serviceContext.environment}] ${config.name}`,
    message: buildAlertMessage(alert, evaluationContext).body,
    priority,
    payload: {
      alertId: alert.id,
      configId: config.id,
      metricType: config.metric_type,
      currentValue: alert.current_value,
      thresholdValue: alert.threshold_value,
      severity: config.severity,
      details: alert.details,
      actions,
      ...evaluationContext,
    },
    timestamp: alert.triggered_at,
    metadata: {
      environment: serviceContext.environment,
      baseUrl: serviceContext.baseUrl,
      docsUrl: serviceContext.docsUrl,
      locale: serviceContext.locale,
    },
  };

  // Send to each channel individually so one failure doesn't block others
  for (const channel of supportedChannels) {
    try {
      await notifier.send(messagePayload, [channel]);
    } catch (error) {
      logError(`[BusinessAlertNotification] Channel ${channel} failed:`, error);
      // continue to next channel
    }
  }
}

/**
 * Map severity to priority
 */
function mapSeverityToPriority(
  severity: 'info' | 'warning' | 'high' | 'critical'
): 'low' | 'normal' | 'high' | 'critical' {
  switch (severity) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'warning': return 'normal';
    case 'info': return 'low';
    default: return 'normal';
  }
}
