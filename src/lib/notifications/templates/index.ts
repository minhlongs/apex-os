/**
 * Notification Templates
 * Templates for common notification types with actionable links
 */

import type { NotificationTemplate, NotificationMessage, NotificationContext } from '../config';
import { defaultContext } from '../config';

/**
 * System alert template (for system errors, monitoring alerts)
 */
export const systemAlertTemplate: NotificationTemplate = {
  type: 'system-alert',
  render: (ctx: NotificationContext, data: Record<string, unknown>) => {
    const title = (() => {
      const alertName = (data.alertName as string) || (data.metricName as string) || 'System Alert';
      return `[${ctx.environment}] ${alertName}`;
    })();

    const severity = data.severity as string || 'warning';
    const message = buildAlertMessage(ctx, data);

    return {
      title,
      message,
      payload: {
        ...data,
        actions: buildAlertActions(ctx, data),
        severity,
        environment: ctx.environment,
      },
    };
  },
};

function buildAlertMessage(ctx: NotificationContext, data: Record<string, unknown>): string {
  const severity = data.severity as string;
  const metricName = data.metricName as string;
  const currentValue = data.currentValue;
  const thresholdValue = data.thresholdValue;
  const details = data.details as string | undefined;

  const emoji = getSeverityEmoji(severity);
  const title = (data.alertName as string) || metricName || 'Alert triggered';

  let msg = `${emoji} *${title}*\n\n`;

  if (metricName && currentValue !== undefined && thresholdValue !== undefined) {
    msg += `📈 ${metricName}\n`;
    msg += `   Current: ${formatValue(currentValue)}\n`;
    msg += `   Threshold: ${formatValue(thresholdValue)}\n\n`;
  }

  if (details) {
    msg += `${details}\n\n`;
  }

  if (data.endpoint) {
    msg += `🔗 Endpoint: \`${data.endpoint}\`\n`;
  }

  if (data.error) {
    msg += `\n❌ Error: ${data.error}\n`;
  }

  return msg;
}

function buildAlertActions(
  ctx: NotificationContext,
  data: Record<string, unknown>
): Array<{ label: string; url: string; secondary?: boolean }> {
  const actions: Array<{ label: string; url: string; secondary?: boolean }> = [];

  // Dashboard link (always present)
  actions.push({
    label: 'View Dashboard',
    url: `${ctx.baseUrl}/admin/monitoring`,
    secondary: false,
  });

  // Specific alert link
  if (data.alertId) {
    actions.push({
      label: 'View Alert Details',
      url: `${ctx.baseUrl}/admin/monitoring/alerts/${data.alertId}`,
      secondary: true,
    });
  }

  // Documentation link for metric-specific docs
  if (data.metricType) {
    actions.push({
      label: 'Documentation',
      url: `${ctx.docsUrl}/monitoring/${data.metricType}`,
      secondary: true,
    });
  }

  return actions;
}

/**
 * Payout notification template
 */
export const payoutTemplate: NotificationTemplate = {
  type: 'payout',
  render: (ctx: NotificationContext, data: Record<string, unknown>) => {
    const amount = data.amount as number;
    const walletAddress = data.walletAddress as string;
    const transactionHash = data.transactionHash as string;
    const network = data.network as string || 'stellar';
    const status = data.status as string || 'completed';
    const payoutDate = data.payoutDate as string || new Date().toISOString();
    const affiliateCount = data.affiliateCount as number || 0;

    const isBatch = data.isBatch === true;

    const title = isBatch
      ? `Batch Payout Completed: ${affiliateCount} affiliates`
      : `Payout Completed: $${amount.toFixed(2)} USDC`;

    const message = buildPayoutMessage(ctx, {
      amount,
      walletAddress,
      transactionHash,
      network,
      status,
      payoutDate,
      affiliateCount,
      isBatch,
    });

    return {
      title,
      message,
      payload: {
        amount,
        walletAddress,
        transactionHash,
        network,
        status,
        payoutDate,
        affiliateCount,
        isBatch,
        actions: buildPayoutActions(ctx, {
          transactionHash,
          walletAddress,
          isBatch,
          affiliateCount,
          network,
        }),
      },
    };
  },
};

function buildPayoutMessage(
  ctx: NotificationContext,
  data: {
    amount: number;
    walletAddress: string;
    transactionHash: string;
    network: string;
    status: string;
    payoutDate: string;
    affiliateCount: number;
    isBatch: boolean;
  }
): string {
  const locale = ctx.locale;

  const amountFormatted = data.amount.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  });

  const shortHash = `${data.transactionHash.slice(0, 8)}...${data.transactionHash.slice(-8)}`;

  let msg = `💰 *Payout ${data.status}*\n\n`;

  if (data.isBatch) {
    msg += `📊 Batch payout completed for ${data.affiliateCount} affiliates\n`;
    msg += `💵 Total amount: ${amountFormatted} USDC\n`;
  } else {
    msg += `✅ Payout of ${amountFormatted} USDC has been processed\n`;
  }

  msg += `\n📡 Network: ${data.network}\n`;
  msg += `💳 Wallet: \`${data.walletAddress.slice(0, 10)}...${data.walletAddress.slice(-8)}\`\n`;
  msg += `🔗 Transaction: \`${shortHash}\`\n`;
  msg += `📅 Date: ${new Date(data.payoutDate).toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US')}\n`;

  return msg;
}

function buildPayoutActions(
  ctx: NotificationContext,
  data: {
    transactionHash: string;
    walletAddress: string;
    isBatch: boolean;
    affiliateCount: number;
    network: string;
  }
): Array<{ label: string; url: string; secondary?: boolean }> {
  const actions: Array<{ label: string; url: string; secondary?: boolean }> = [];

  // Transaction explorer link
  const isTestnet = data.network === 'stellar-testnet';
  const explorerUrl = isTestnet
    ? `https://stellar.expert/explorer/testnet/tx/${data.transactionHash}`
    : `https://stellar.expert/explorer/public/tx/${data.transactionHash}`;

  actions.push({
    label: 'View Transaction',
    url: explorerUrl,
    secondary: false,
  });

  // Payout history
  actions.push({
    label: 'Payout History',
    url: `${ctx.baseUrl}/dashboard/payouts`,
    secondary: true,
  });

  // Batch details if applicable
  if (data.isBatch) {
    actions.push({
      label: 'Batch Details',
      url: `${ctx.baseUrl}/admin/payouts/batch?tx=${data.transactionHash.slice(0, 16)}`,
      secondary: true,
    });
  }

  return actions;
}

/**
 * Commission earned template
 */
export const commissionEarnedTemplate: NotificationTemplate = {
  type: 'commission-earned',
  render: (ctx: NotificationContext, data: Record<string, unknown>) => {
    const amount = data.amount as number;
    const dealName = data.dealName as string;
    const exchange = data.exchange as string;
    const tradeVolume = data.tradeVolume as number;
    const tier = data.tier as number;
    const userName = data.userName as string;
    const referralChain = data.referralChain as Array<{ name: string; tier: number }>;

    const title = `Commission Earned: $${amount.toFixed(2)} by ${userName}`;

    const message = buildCommissionMessage(ctx, {
      amount,
      dealName,
      exchange,
      tradeVolume,
      tier,
      userName,
      referralChain,
    });

    return {
      title,
      message,
      payload: {
        amount,
        dealName,
        exchange,
        tradeVolume,
        tier,
        userName,
        referralChain,
        actions: buildCommissionActions(ctx, {
          dealName,
          exchange,
          userId: data.userId as string,
        }),
      },
    };
  },
};

function buildCommissionMessage(
  ctx: NotificationContext,
  data: {
    amount: number;
    dealName: string;
    exchange: string;
    tradeVolume: number;
    tier: number;
    userName: string;
    referralChain: Array<{ name: string; tier: number }>;
  }
): string {
  const locale = ctx.locale;

  const amountFormatted = data.amount.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  });

  const tradeVolumeFormatted = data.tradeVolume.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  });

  const tierText = locale === 'vi'
    ? `Cấp ${data.tier} (${data.tier === 1 ? '30%' : data.tier === 2 ? '10%' : '5%'})`
    : `Tier ${data.tier} (${data.tier === 1 ? '30%' : data.tier === 2 ? '10%' : '5%'})`;

  let msg = `🎉 *Commission Earned*\n\n`;
  msg += `👤 *User:* ${data.userName}\n`;
  msg += `💰 *Amount:* ${amountFormatted}\n`;
  msg += `📈 *Trade Volume:* ${tradeVolumeFormatted}\n\n`;

  msg += `*Deal:* ${data.dealName}\n`;
  msg += `*Exchange:* ${data.exchange}\n`;
  msg += `*Tier:* ${tierText}\n\n`;

  if (data.referralChain && data.referralChain.length > 0) {
    msg += `*Referral Chain:*\n`;
    data.referralChain.forEach((ref, idx) => {
      msg += `  ${idx + 1}. ${ref.name} (Tier ${ref.tier})\n`;
    });
  }

  return msg;
}

function buildCommissionActions(
  ctx: NotificationContext,
  data: { dealName: string; exchange: string; userId: string }
): Array<{ label: string; url: string; secondary?: boolean }> {
  return [
    {
      label: 'View Affiliate Profile',
      url: `${ctx.baseUrl}/admin/affiliates/${data.userId}`,
      secondary: false,
    },
    {
      label: 'View Deal',
      url: `${ctx.baseUrl}/admin/deals?exchange=${data.exchange}&search=${encodeURIComponent(data.dealName)}`,
      secondary: true,
    },
  ];
}

/**
 * Health degraded template (for system monitoring)
 */
export const healthDegradedTemplate: NotificationTemplate = {
  type: 'health-degraded',
  render: (ctx: NotificationContext, data: Record<string, unknown>) => {
    const component = data.component as string || 'System';
    const issue = data.issue as string || 'Health check failed';
    const severity = data.severity as string || 'warning';

    const title = `Health Alert: ${component}`;
    const message = buildHealthMessage(ctx, { component, issue, severity, data });

    return {
      title,
      message,
      payload: {
        component,
        issue,
        severity,
        actions: buildHealthActions(ctx, { component, healthEndpoint: data.healthEndpoint as string }),
        ...data,
      },
    };
  },
};

function buildHealthMessage(
  ctx: NotificationContext,
  data: { component: string; issue: string; severity: string; data: Record<string, unknown> }
): string {
  const emoji = getSeverityEmoji(data.severity);

  let msg = `${emoji} *${data.component} Health Issue*\n\n`;
  msg += `⚠️ ${data.issue}\n\n`;

  if (data.data.responseTime) {
    msg += `⏱️ Response Time: ${data.data.responseTime}ms\n`;
  }

  if (data.data.errorRate !== undefined && data.data.errorRate !== null) {
    const errorRate = Number(data.data.errorRate);
    msg += `❌ Error Rate: ${(errorRate * 100).toFixed(1)}%\n`;
  }

  if (data.data.databaseSize !== undefined && data.data.databaseSize !== null) {
    const dbSize = Number(data.data.databaseSize);
    const sizeGB = (dbSize / 1024 / 1024 / 1024).toFixed(2);
    msg += `💾 Database Size: ${sizeGB} GB\n`;
  }

  return msg;
}

function buildHealthActions(
  ctx: NotificationContext,
  data: { component: string; healthEndpoint: string }
): Array<{ label: string; url: string; secondary?: boolean }> {
  return [
    {
      label: 'View Health Dashboard',
      url: `${ctx.baseUrl}/admin/health`,
      secondary: false,
    },
    {
      label: 'System Metrics',
      url: `${ctx.baseUrl}/admin/metrics`,
      secondary: true,
    },
  ];
}

/**
 * Weekly summary template
 */
export const weeklySummaryTemplate: NotificationTemplate = {
  type: 'weekly-summary',
  render: (ctx: NotificationContext, data: Record<string, unknown>) => {
    const period = data.period as { start: string; end: string };
    const totalEarnings = data.totalEarnings as number;
    const conversions = data.conversions as number;
    const activeAffiliates = data.activeAffiliates as number;
    const newUsers = data.newUsers as number || 0;

    const title = `Weekly Summary: $${totalEarnings.toFixed(2)} earned`;

    const message = buildWeeklyMessage(ctx, {
      totalEarnings,
      conversions,
      activeAffiliates,
      newUsers,
      period,
    });

    return {
      title,
      message,
      payload: {
        totalEarnings,
        conversions,
        activeAffiliates,
        newUsers,
        period,
        actions: buildWeeklyActions(ctx),
      },
    };
  },
};

function buildWeeklyMessage(
  ctx: NotificationContext,
  data: {
    totalEarnings: number;
    conversions: number;
    activeAffiliates: number;
    newUsers: number;
    period: { start: string; end: string };
  }
): string {
  const locale = ctx.locale;

  const amountFormatted = data.totalEarnings.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  });

  let msg = `📊 *Weekly Summary*\n\n`;
  msg += `💰 *Total Earnings:* ${amountFormatted}\n`;
  msg += `🔄 *Conversions:* ${data.conversions}\n`;
  msg += `👥 *Active Affiliates:* ${data.activeAffiliates}\n`;
  msg += `🆕 *New Users:* ${data.newUsers}\n\n`;

  const periodStart = new Date(data.period.start).toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US');
  const periodEnd = new Date(data.period.end).toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US');
  msg += `📅 Period: ${periodStart} - ${periodEnd}\n`;

  return msg;
}

function buildWeeklyActions(
  ctx: NotificationContext
): Array<{ label: string; url: string; secondary?: boolean }> {
  return [
    {
      label: 'View Analytics',
      url: `${ctx.baseUrl}/admin/analytics`,
      secondary: false,
    },
    {
      label: 'Export Report',
      url: `${ctx.baseUrl}/admin/analytics/export?period=weekly`,
      secondary: true,
    },
  ];
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
 * Format value for display
 */
function formatValue(value: unknown): string {
  if (typeof value === 'number') {
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(2)}M`;
    }
    if (value >= 1000) {
      return `${(value / 1000).toFixed(2)}K`;
    }
    return value.toFixed(2).replace(/\.00$/, '');
  }
  return String(value ?? '-');
}

/**
 * Template registry
 */
export function getTemplate(type: string): NotificationTemplate | undefined {
  const templates: Record<string, NotificationTemplate> = {
    'system-alert': systemAlertTemplate,
    'payout': payoutTemplate,
    'commission-earned': commissionEarnedTemplate,
    'health-degraded': healthDegradedTemplate,
    'weekly-summary': weeklySummaryTemplate,
  };

  return templates[type];
}

/**
 * Get all available templates
 */
export function getAllTemplates(): NotificationTemplate[] {
  return Object.values({
    systemAlertTemplate,
    payoutTemplate,
    commissionEarnedTemplate,
    healthDegradedTemplate,
    weeklySummaryTemplate,
  });
}
