/**
 * Notification templates types
 */

export type { NotificationTemplate } from '../config';

/**
 * System alert specific data
 */
export interface SystemAlertData {
  /** Alert identifier */
  alertId?: string;
  /** Alert name/identifier */
  alertName?: string;
  /** Severity level */
  severity: 'info' | 'warning' | 'high' | 'critical';
  /** Metric name that triggered the alert */
  metricName?: string;
  /** Current value */
  currentValue?: number | string;
  /** Threshold value */
  thresholdValue?: number | string;
  /** Additional details */
  details?: string;
  /** Affected endpoint/component */
  endpoint?: string;
  /** Error message if applicable */
  error?: string;
  /** Metric type for documentation link */
  metricType?: string;
}

/**
 * Payout notification data
 */
export interface PayoutData {
  /** Payout amount in USD */
  amount: number;
  /** Wallet address */
  walletAddress: string;
  /** Transaction hash */
  transactionHash: string;
  /** Blockchain network */
  network: 'stellar' | 'stellar-testnet';
  /** Payout status */
  status: 'completed' | 'failed' | 'processing';
  /** Payout date */
  payoutDate: string;
  /** Whether this is a batch payout */
  isBatch?: boolean;
  /** Number of affiliates in batch */
  affiliateCount?: number;
  /** Payout ID */
  payoutId?: string;
}

/**
 * Commission earned data
 */
export interface CommissionEarnedData {
  /** User who earned commission */
  userName: string;
  /** User ID */
  userId: string;
  /** Commission amount in USD */
  amount: number;
  /** Deal/trade description */
  dealName: string;
  /** Exchange name */
  exchange: string;
  /** Trade volume in USD */
  tradeVolume: number;
  /** Commission tier (1, 2, or 3) */
  tier: 1 | 2 | 3;
  /** Payout status */
  payoutStatus: 'pending' | 'scheduled' | 'paid';
  /** Expected payout date */
  payoutDate?: string;
  /** Referral chain information */
  referralChain?: Array<{ name: string; tier: number }>;
}

/**
 * Health alert data
 */
export interface HealthData {
  /** Component name */
  component: string;
  /** Issue description */
  issue: string;
  /** Severity */
  severity: 'info' | 'warning' | 'high' | 'critical';
  /** Health endpoint URL */
  healthEndpoint?: string;
  /** Response time in ms */
  responseTime?: number;
  /** Error rate (0-1) */
  errorRate?: number;
  /** Database size in bytes */
  databaseSize?: number;
  /** Additional metrics */
  metrics?: Record<string, number | string | boolean>;
}

/**
 * Weekly summary data
 */
export interface WeeklySummaryData {
  /** Period start date */
  period: { start: string; end: string };
  /** Total earnings for the week */
  totalEarnings: number;
  /** Number of conversions */
  conversions: number;
  /** Number of active affiliates */
  activeAffiliates: number;
  /** Number of new users */
  newUsers: number;
  /** Next payout date */
  nextPayoutDate?: string;
  /** Affiliate rank change */
  affiliateRank?: string;
}
