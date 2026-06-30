/**
 * Business Alert Notifications
 * Bridges the business alert engine with the multi-channel notification service
 */

import { getNotificationService } from './index';
import type {
  BusinessAlertConfig,
  BusinessAlert,
  AlertEvaluationContext,
  NotificationChannel,
} from '@/types/business-alerting';
import type { NotificationChannel as ServiceNotificationChannel } from './config';

/**
 * Send business alert notification via configured channels
 * Called by business-alert-engine when an alert is triggered
 */
export async function sendBusinessAlertNotification(
  config: BusinessAlertConfig,
  alert: BusinessAlert,
  evaluationContext: AlertEvaluationContext
): Promise<void> {
  const notifier = getNotificationService();
  const serviceContext = notifier.getContext();

  // Build actionable links based on alert type
  const actions = buildAlertActions(config, alert, serviceContext);

  // Determine priority from severity
  const priority = mapSeverityToPriority(config.severity);

  // Send via all configured channels for this alert
  // Filter to only channels supported by the notification service
  const businessChannels = config.alert_channels as NotificationChannel[];
  const supportedChannels = businessChannels.filter((ch) =>
    ['slack', 'email', 'telegram'].includes(ch)
  ) as ServiceNotificationChannel[];

  try {
    await notifier.send(
      {
        type: 'business-alert',
        title: `[${serviceContext.environment}] ${config.name}`,
        message: buildAlertMessage(config, alert, evaluationContext, serviceContext.locale),
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
          // Include key evaluation context values
          ...evaluationContext,
        },
        timestamp: alert.triggered_at,
        metadata: {
          environment: serviceContext.environment,
          baseUrl: serviceContext.baseUrl,
          docsUrl: serviceContext.docsUrl,
          locale: serviceContext.locale,
        },
      },
      supportedChannels
    );
  } catch (error) {
    console.error('[BusinessAlertNotification] Failed to send:', error);
    throw error;
  }
}

/**
 * Build alert message text
 */
function buildAlertMessage(
  config: BusinessAlertConfig,
  alert: BusinessAlert,
  context: AlertEvaluationContext,
  locale: 'vi' | 'en'
): string {
  const severityEmoji = getSeverityEmoji(config.severity);

  let message = `${severityEmoji} *${config.name}*\n\n`;

  // Add metric-specific details
  switch (config.metric_type) {
    case 'revenue_drop':
      message += `📉 Revenue has dropped significantly\n\n`;
      message += `Today's Revenue: $${formatNumber(context.todayRevenue || 0)}\n`;
      message += `7-Day Average: $${formatNumber(context.sevenDayAvgRevenue || 0)}\n`;
      message += `Trend: ${context.revenueTrend || 'unknown'}\n`;
      break;

    case 'conversion_rate':
      message += `📊 Conversion rate below threshold\n\n`;
      message += `Current Rate: ${(context.todayConversionRate || 0).toFixed(2)}%\n`;
      message += `7-Day Average: ${(context.last7DayAvgConversionRate || 0).toFixed(2)}%\n`;
      message += `Today Clicks: ${context.clicksToday || 0}\n`;
      message += `Today Conversions: ${context.conversionsToday || 0}\n`;
      break;

    case 'webhook_failures':
      message += `🔗 Webhook failure rate elevated\n\n`;
      message += `Failure Rate: ${(context.webhookFailureRate || 0).toFixed(1)}%\n`;
      message += `Failed: ${context.webhookFailedAttempts || 0} / ${context.webhookTotalAttempts || 0}\n`;
      if (context.webhookType) {
        message += `Type: ${context.webhookType}\n`;
      }
      break;

    case 'payout_failures':
      message += `💰 Payout failure rate too high\n\n`;
      message += `Failure Rate: ${(context.payoutFailureRate || 0).toFixed(1)}%\n`;
      message += `Failed: ${context.failedPayouts || 0} / ${context.totalPayouts || 0}\n`;
      message += `Period: Last 24 hours\n`;
      break;

    case 'stellar_balance':
      message += `💳 Stellar USDC balance low\n\n`;
      message += `Current Balance: $${formatNumber(context.stellarBalance || 0)} USDC\n`;
      message += `Wallet: ${context.walletAddress ? context.walletAddress.slice(0, 10) + '...' : 'N/A'}\n`;
      message += `Network: ${context.network || 'testnet'}\n`;
      break;

    default:
      message += `Metric: ${config.metric_type}\n`;
      message += `Current Value: ${alert.current_value}\n`;
      message += `Threshold: ${config.threshold_value}\n`;
  }

  // Add description if available
  if (config.description) {
    message += `\n📝 ${config.description}\n`;
  }

  return message;
}

/**
 * Build actionable links for the alert
 */
function buildAlertActions(
  config: BusinessAlertConfig,
  alert: BusinessAlert,
  context: { baseUrl: string; docsUrl?: string; locale: 'vi' | 'en' }
): Array<{ label: string; url: string; secondary?: boolean }> {
  const actions: Array<{ label: string; url: string; secondary?: boolean }> = [];

  // Link to monitoring dashboard
  actions.push({
    label: context.locale === 'vi' ? 'Xem Bảng điều khiển' : 'View Dashboard',
    url: `${context.baseUrl}/admin/monitoring`,
    secondary: false,
  });

  // Link to specific alert details
  if (alert.id) {
    actions.push({
      label: context.locale === 'vi' ? 'Xem Chi tiết' : 'View Details',
      url: `${context.baseUrl}/admin/monitoring/alerts/${alert.id}`,
      secondary: true,
    });
  }

  // Metric-specific documentation
  if (config.metric_type) {
    actions.push({
      label: context.locale === 'vi' ? 'Tài liệu' : 'Documentation',
      url: `${context.docsUrl || 'https://docs.apexos.io'}/monitoring/alerts/${config.metric_type}`,
      secondary: true,
    });
  }

  // Link to alert configuration
  actions.push({
    label: context.locale === 'vi' ? 'Cấu hình cảnh báo' : 'Alert Configuration',
    url: `${context.baseUrl}/admin/alerts/config`,
    secondary: true,
  });

  return actions;
}

/**
 * Map severity to notification priority
 */
function mapSeverityToPriority(
  severity: 'info' | 'warning' | 'high' | 'critical'
): 'low' | 'normal' | 'high' | 'critical' {
  switch (severity) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'warning':
      return 'normal';
    case 'info':
      return 'low';
    default:
      return 'normal';
  }
}

/**
 * Get emoji based on severity
 */
function getSeverityEmoji(severity: string): string {
  switch (severity?.toLowerCase()) {
    case 'critical':
      return '🚨';
    case 'high':
      return '⚠️';
    case 'warning':
      return '🔶';
    case 'info':
      return 'ℹ️';
    default:
      return '📢';
  }
}

/**
 * Format number with locale
 */
function formatNumber(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
