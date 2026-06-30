/**
 * Business Alerting Types
 * Defines types for the business metrics alerting system
 */

import type { TimeSeriesQueryParams } from './metrics';

// ============================================================================
// Alert Configuration Types
// ============================================================================

export type BusinessMetricType =
  | 'revenue_drop'
  | 'conversion_rate'
  | 'webhook_failures'
  | 'payout_failures'
  | 'stellar_balance';

export type ThresholdType = 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'drop_pct';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type AlertStatus = 'active' | 'resolved' | 'acknowledged';

export type NotificationChannel = 'email' | 'webhook' | 'slack' | 'telegram';

export interface BusinessAlertConfig {
  id: string;
  name: string;
  description?: string;
  metric_type: BusinessMetricType;
  threshold_type: ThresholdType;
  threshold_value: number;
  comparison_period_days: number;
  moving_average_days: number;
  evaluation_window_minutes: number;
  min_data_points: number;
  severity: AlertSeverity;
  alert_channels: NotificationChannel[];
  cooldown_minutes: number;
  include_context: boolean;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface BusinessAlert {
  id: string;
  config_id: string;
  triggered_at: Date;
  current_value: number;
  threshold_value: number;
  details: AlertDetails;
  status: AlertStatus;
  metadata?: AlertMetadata;
}

export interface AlertDetails {
  metricType: BusinessMetricType;
  severity: AlertSeverity;
  metricName: string;
  snapshot?: {
    storageBytes?: number;
    avgQueryDuration?: number;
    totalQueries?: number;
  };
  // Business-specific details
  comparisonValue?: number;
  period?: string;
  trend?: 'up' | 'down' | 'stable';
  affectedEntities?: AffectedEntity[];
}

export interface AffectedEntity {
  type: 'affiliate' | 'deal' | 'payout' | 'webhook';
  id: string;
  name?: string;
  value: number;
}

export interface AlertMetadata {
  affectedEntities?: string[];
  dashboardUrl?: string;
  documentationUrl?: string;
  // Extended fields from alert history query
  configName?: string;
  severity?: AlertSeverity;
  metricType?: BusinessMetricType;
}

// ============================================================================
// Notification Types
// ============================================================================

export interface NotificationLog {
  id: string;
  alert_history_id: string;
  channel: NotificationChannel;
  recipient: string;
  status: 'pending' | 'sent' | 'failed' | 'retrying';
  response?: string;
  attempts: number;
  sent_at?: string;
  delivered_at?: string;
  failed_at?: string;
  error_message?: string;
  created_at: string;
}

// ============================================================================
// Stats Tracking Types
// ============================================================================

export interface WebhookFailureStats {
  id: string;
  webhook_type: string;
  endpoint_path: string;
  total_attempts: number;
  successful_attempts: number;
  failed_attempts: number;
  failure_reasons: string[];
  window_start: string;
  window_end: string;
  last_attempt_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PayoutFailureStats {
  id: string;
  period_start: string;
  period_end: string;
  total_payouts: number;
  successful_payouts: number;
  failed_payouts: number;
  failure_breakdown: Record<string, number>;
  total_amount_usdc: number;
  successful_amount_usdc: number;
  failed_amount_usdc: number;
  last_payout_at?: string;
  created_at: string;
  updated_at: string;
}

export interface StellarBalanceRecord {
  id: string;
  balance_usdc: number;
  balance_native: number;
  wallet_address: string;
  network: 'testnet' | 'mainnet';
  sequence_number?: number;
  last_transaction_hash?: string;
  recorded_at: string;
}

// ============================================================================
// Alert Evaluation Context
// ============================================================================

export interface AlertEvaluationContext {
  // Revenue context
  todayRevenue?: number;
  yesterdayRevenue?: number;
  sevenDayAvgRevenue?: number;
  revenueTrend?: 'up' | 'down' | 'stable';

  // Conversion context
  todayConversionRate?: number;
  last7DayAvgConversionRate?: number;
  clicksToday?: number;
  conversionsToday?: number;

  // Webhook context
  webhookFailureRate?: number;
  webhookTotalAttempts?: number;
  webhookFailedAttempts?: number;
  webhookType?: string;

  // Payout context
  payoutFailureRate?: number;
  totalPayouts?: number;
  failedPayouts?: number;
  payoutPeriod?: string;

  // Stellar context
  stellarBalance?: number;
  walletAddress?: string;
  network?: 'testnet' | 'mainnet';

  // General
  evaluationTimestamp: string;
  evaluationWindowMinutes: number;
}

// ============================================================================
// Alert Notification Templates
// ============================================================================

export interface AlertNotificationTemplate {
  subject: (context: AlertEvaluationContext & { config: BusinessAlertConfig }) => string;
  html: (context: AlertEvaluationContext & { config: BusinessAlertConfig; alert: BusinessAlert }) => string;
  text: (context: AlertEvaluationContext & { config: BusinessAlertConfig; alert: BusinessAlert }) => string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface EvaluateAlertsRequest {
  force?: boolean; // Force evaluation even if in cooldown
}

export interface EvaluateAlertsResponse {
  success: boolean;
  triggeredAlerts: BusinessAlert[];
  skippedAlerts: { configId: string; reason: 'cooldown' | 'no_data' | 'not_breached' }[];
  evaluationTimestamp: string;
}

export interface AlertConfigUpdate {
  name?: string;
  description?: string;
  threshold_value?: number;
  comparison_period_days?: number;
  moving_average_days?: number;
  evaluation_window_minutes?: number;
  severity?: AlertSeverity;
  alert_channels?: NotificationChannel[];
  cooldown_minutes?: number;
  is_enabled?: boolean;
}

export interface AlertHistoryQueryParams {
  start_date?: string;
  end_date?: string;
  status?: AlertStatus | 'all';
  metric_type?: BusinessMetricType | 'all';
  limit?: number;
  offset?: number;
}

export interface AlertNotificationTest {
  configId: string;
  channel: NotificationChannel;
  recipient: string;
}

// ============================================================================
// Default Configs
// ============================================================================

export const DEFAULT_BUSINESS_ALERT_CONFIGS: Omit<BusinessAlertConfig, 'id' | 'created_at' | 'updated_at'>[] = [
  {
    name: 'Revenue Drop Alert',
    description: 'Triggers when daily revenue drops >50% compared to 7-day moving average',
    metric_type: 'revenue_drop',
    threshold_type: 'drop_pct',
    threshold_value: 50,
    comparison_period_days: 1,
    moving_average_days: 7,
    evaluation_window_minutes: 120,
    min_data_points: 7,
    severity: 'critical',
    alert_channels: ['email', 'slack'],
    cooldown_minutes: 60,
    include_context: true,
    is_enabled: true,
  },
  {
    name: 'Low Conversion Rate',
    description: 'Triggers when conversion rate falls below 2%',
    metric_type: 'conversion_rate',
    threshold_type: 'lt',
    threshold_value: 2,
    comparison_period_days: 1,
    moving_average_days: 7,
    evaluation_window_minutes: 120,
    min_data_points: 1,
    severity: 'warning',
    alert_channels: ['email'],
    cooldown_minutes: 60,
    include_context: true,
    is_enabled: true,
  },
  {
    name: 'High Webhook Failure Rate',
    description: 'Triggers when webhook failure rate exceeds 10% in the last hour',
    metric_type: 'webhook_failures',
    threshold_type: 'gt',
    threshold_value: 10,
    comparison_period_days: 0,
    moving_average_days: 0,
    evaluation_window_minutes: 60,
    min_data_points: 1,
    severity: 'critical',
    alert_channels: ['email', 'slack'],
    cooldown_minutes: 15,
    include_context: true,
    is_enabled: true,
  },
  {
    name: 'High Payout Failure Rate',
    description: 'Triggers when payout failure rate exceeds 5%',
    metric_type: 'payout_failures',
    threshold_type: 'gt',
    threshold_value: 5,
    comparison_period_days: 1,
    moving_average_days: 7,
    evaluation_window_minutes: 120,
    min_data_points: 1,
    severity: 'critical',
    alert_channels: ['email', 'slack'],
    cooldown_minutes: 30,
    include_context: true,
    is_enabled: true,
  },
  {
    name: 'Low Stellar USDC Balance',
    description: 'Triggers when Stellar wallet balance falls below 100 USDC',
    metric_type: 'stellar_balance',
    threshold_type: 'lt',
    threshold_value: 100,
    comparison_period_days: 0,
    moving_average_days: 0,
    evaluation_window_minutes: 60,
    min_data_points: 1,
    severity: 'critical',
    alert_channels: ['email', 'slack'],
    cooldown_minutes: 120,
    include_context: true,
    is_enabled: true,
  },
];
