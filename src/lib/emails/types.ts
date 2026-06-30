/**
 * Email notification types for ApexOS
 * Supports both transactional and marketing emails via Resend
 */

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailOptions {
  /** Recipient email address */
  to: string | EmailAddress | (string | EmailAddress)[];
  /** Sender email address (defaults to RESEND_FROM_EMAIL) */
  from?: string | EmailAddress;
  /** Email subject */
  subject: string;
  /** HTML content */
  html: string;
  /** Plain text alternative */
  text?: string;
  /** CC recipients */
  cc?: string | EmailAddress | (string | EmailAddress)[];
  /** BCC recipients */
  bcc?: string | EmailAddress | (string | EmailAddress)[];
  /** Reply-to address */
  replyTo?: string | EmailAddress;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Tags for analytics */
  tags?: { name: string; value: string }[];
}

export interface EmailTemplateData {
  /** User's preferred locale */
  locale: 'vi' | 'en';
  /** User's name */
  userName: string;
  /** User's email */
  userEmail: string;
  /** Base URL for links */
  baseUrl: string;
}

/** Commission earned notification */
export interface CommissionEarnedData extends EmailTemplateData {
  /** Amount in USD */
  amount: number;
  /** Deal/trade reference */
  dealName: string;
  /** Exchange name (Binance, Bybit, etc.) */
  exchange: string;
  /** Trade volume in USD */
  tradeVolume: number;
  /** Commission tier level */
  tier: 1 | 2 | 3;
  /** Payout status */
  payoutStatus: 'pending' | 'scheduled' | 'paid';
  /** Expected payout date (if scheduled) */
  payoutDate?: string;
}

/** Payout completed notification */
export interface PayoutCompletedData extends EmailTemplateData {
  /** Payout amount in USD */
  amount: number;
  /** Stellar transaction hash */
  transactionHash: string;
  /** Destination wallet address */
  walletAddress: string;
  /** Network (testnet/mainnet) */
  network: 'testnet' | 'mainnet';
  /** Payout date */
  payoutDate: string;
  /** Link to explore transaction */
  explorerUrl: string;
}

/** Weekly summary for affiliates */
export interface WeeklySummaryData extends EmailTemplateData {
  /** Period start date */
  periodStart: string;
  /** Period end date */
  periodEnd: string;
  /** Total earnings this week */
  totalEarnings: number;
  /** Number of conversions */
  conversionsCount: number;
  /** Active referrals count */
  activeReferrals: number;
  /** Rank/position in affiliate program */
  affiliateRank: string;
  /** Next payout date */
  nextPayoutDate: string;
}

/** Welcome email for new users */
export interface WelcomeData extends EmailTemplateData {
  /** Verification token if email verification is required */
  verificationToken?: string;
  /** Affiliate referral code (if user is affiliate) */
  referralCode?: string;
  /** User role */
  role: 'shopper' | 'affiliate' | 'admin';
}

/** Deal published notification (to affiliate who created it) */
export interface DealPublishedData extends EmailTemplateData {
  /** Deal name/title */
  dealName: string;
  /** Exchange */
  exchange: string;
  /** Cashback percentage */
  cashbackPercent: number;
  /** Deal URL */
  dealUrl: string;
}

/** Referral signed up notification */
export interface ReferralSignedUpData extends EmailTemplateData {
  /** Referral's name */
  referralName: string;
  /** Referral's email */
  referralEmail: string;
  /** Bonus amount for successful referral */
  bonusAmount: number;
  /** Affiliate's stats */
  totalReferrals: number;
  /** Link to affiliate dashboard */
  dashboardUrl: string;
}

/** Password reset request */
export interface PasswordResetData extends EmailTemplateData {
  /** Reset token */
  resetToken: string;
  /** Reset URL */
  resetUrl: string;
  /** Expiration time */
  expiresIn: string;
}

/** Email verification */
export interface EmailVerificationData extends EmailTemplateData {
  /** Verification URL */
  verificationUrl: string;
  /** Expires in */
  expiresIn: string;
}

export type EmailNotificationType =
  | 'commission-earned'
  | 'payout-completed'
  | 'weekly-summary'
  | 'welcome'
  | 'deal-published'
  | 'referral-signed-up'
  | 'password-reset'
  | 'email-verification'
  | 'custom';

export interface EmailNotification<T extends EmailNotificationType = EmailNotificationType, D extends object = Record<string, unknown>> {
  type: T;
  data: D;
  /** Custom template override */
  templateId?: string;
  /** Send asynchronously (non-blocking) */
  async?: boolean;
  /** Priority: 1=high, 2=normal, 3=low */
  priority?: 1 | 2 | 3;
}
