/**
 * Email Notifier Service
 * Integration with Resend API for transactional emails
 */

import { Resend } from 'resend';
import { error as logError, info as logInfo } from '@/lib/logger';
import {
  EmailOptions,
  EmailNotification,
  EmailAddress,
  CommissionEarnedData,
  PayoutCompletedData,
  WeeklySummaryData,
  WelcomeData,
  PasswordResetData,
  EmailVerificationData,
} from './types';

if (process.env.NODE_ENV === 'test') {
  logInfo('[EmailNotifier] Resend class loaded:', Resend);
}
import {
  commissionEarnedTemplate,
  payoutCompletedTemplate,
  weeklySummaryTemplate,
  welcomeTemplate,
  passwordResetTemplate,
  plainTextTemplate,
} from './templates';

export interface NotifierConfig {
  /** From email address (defaults to RESEND_FROM_EMAIL) */
  fromEmail?: string;
  /** From name (defaults to RESEND_FROM_NAME or company name) */
  fromName?: string;
  /** Whether to actually send emails (useful for testing) */
  enabled?: boolean;
  /** Log emails to console instead of sending */
  dryRun?: boolean;
}

/**
 * Convert recipient to string format for Resend
 * Resend accepts: "email@example.com" or ["email1@example.com", "email2@example.com"]
 */
function toResendRecipient(
  to: string | EmailAddress | (string | EmailAddress)[]
): string | string[] {
  if (typeof to === 'string') return to;
  if (Array.isArray(to)) {
    return to.map(t => (typeof t === 'string' ? t : t.email));
  }
  return to.email;
}

/**
 * Email Notifier service for ApexOS
 * Handles all transactional email sending via Resend
 */
export class EmailNotifier {
  private config: Required<NotifierConfig>;
  private resend: Resend | null = null;

  constructor(config: NotifierConfig = {}) {
    const defaultFromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@apexos.io';
    const defaultFromName = process.env.RESEND_FROM_NAME || 'ApexOS';

    this.config = {
      fromEmail: config.fromEmail || defaultFromEmail,
      fromName: config.fromName || defaultFromName,
      enabled: config.enabled !== false, // default true
      dryRun: config.dryRun || process.env.NODE_ENV === 'development' && !process.env.RESEND_SEND_REAL,
    };
  }

  /**
   * Get Resend instance, creating it lazily if needed
   */
  private getResend(): Resend | null {
    if (!this.resend) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
        return null;
      }
      this.resend = new Resend(apiKey);
    }
    return this.resend;
  }

  /**
   * Get the configured from address
   */
  getFromAddress(): { email: string; name: string } {
    return {
      email: this.config.fromEmail,
      name: this.config.fromName,
    };
  }

  /**
   * Check if email sending is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled && !!process.env.RESEND_API_KEY;
  }

  /**
   * Send an email with full options
   */
  async send(options: EmailOptions): Promise<{ success: boolean; id?: string; error?: string }> {
    if (!this.isEnabled()) {
      const msg = 'Email sending is disabled or RESEND_API_KEY is not set';
      if (this.config.dryRun) {
        logInfo('[EmailNotifier] DRY RUN - would send:', { subject: options.subject, to: options.to });
        return { success: true, id: 'dry-run-' + Date.now() };
      }
      return { success: false, error: msg };
    }

    try {
      const from = options.from || this.getFromAddress();

      const payload = {
        from: typeof from === 'string' ? from : `${from.name} <${from.email}>`,
        to: toResendRecipient(options.to),
        subject: options.subject,
        html: options.html,
        text: options.text,
        ...(options.cc && { cc: toResendRecipient(options.cc) }),
        ...(options.bcc && { bcc: toResendRecipient(options.bcc) }),
        ...(options.replyTo && { replyTo: toResendRecipient(options.replyTo) }),
        ...(options.headers && { headers: options.headers }),
        ...(options.tags && { tags: options.tags }),
      };

      const resend = this.getResend();
      if (!resend) {
        return { success: false, error: 'Resend API key not configured' };
      }

      if (process.env.NODE_ENV === 'test') {
        logInfo('[EmailNotifier] resend object:', resend);
        logInfo('[EmailNotifier] resend.emails:', resend.emails);
      }

      const result = await resend.emails.send(payload);

      logInfo(`[EmailNotifier] Sent: ${options.subject} → ${options.to}`);
      const emailId = (result as any)?.data?.id;
      return { success: true, id: emailId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logError(`[EmailNotifier] Failed to send: ${options.subject}`, error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Build subject line with prefix
   */
  private buildSubject(locale: 'vi' | 'en', fallback: string): string {
    const prefix = locale === 'vi' ? '[ApexOS] ' : '[ApexOS] ';
    return prefix + fallback;
  }

  /**
   * Send email from a notification object
   */
  async sendNotification<T extends EmailNotification>(
    notification: T
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const data = notification.data as Record<string, unknown>;
    const templateData = {
      locale: (data.locale as 'vi' | 'en') || 'en',
      baseUrl: (data.baseUrl as string) || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000',
      userName: (data.userName as string) || '',
      userEmail: (data.userEmail as string) || '',
    };

    let html: string;
    let text: string;
    let subject: string;
    const anyData = notification.data as any;

    switch (notification.type) {
      case 'commission-earned':
        html = this.commissionEarned({ ...anyData, baseUrl: templateData.baseUrl });
        subject = this.buildSubject(
          templateData.locale,
          templateData.locale === 'vi'
            ? '🎉 Bạn vừa nhận được hoa hồng!'
            : '🎉 You earned a commission!'
        );
        text = plainTextTemplate(
          templateData.locale,
          templateData.baseUrl,
          templateData.userName,
          subject,
          this.buildCommissionEarnedText(anyData)
        );
        break;

      case 'payout-completed':
        html = this.payoutCompleted({ ...anyData, baseUrl: templateData.baseUrl });
        subject = this.buildSubject(
          templateData.locale,
          templateData.locale === 'vi'
            ? '💰 Thanh toán đã hoàn tất'
            : '💰 Payout Completed'
        );
        text = plainTextTemplate(
          templateData.locale,
          templateData.baseUrl,
          templateData.userName,
          subject,
          this.buildPayoutCompletedText(anyData)
        );
        break;

      case 'weekly-summary':
        html = this.weeklySummary({ ...anyData, baseUrl: templateData.baseUrl });
        subject = this.buildSubject(
          templateData.locale,
          templateData.locale === 'vi'
            ? '📊 Tóm tắt hàng tuần - ApexOS'
            : '📊 Weekly Summary - ApexOS'
        );
        text = plainTextTemplate(
          templateData.locale,
          templateData.baseUrl,
          templateData.userName,
          subject,
          this.buildWeeklySummaryText(anyData)
        );
        break;

      case 'welcome':
        html = this.welcome({ ...anyData, baseUrl: templateData.baseUrl });
        subject = this.buildSubject(
          templateData.locale,
          templateData.locale === 'vi'
            ? '👋 Chào mừng đến ApexOS!'
            : '👋 Welcome to ApexOS!'
        );
        text = plainTextTemplate(
          templateData.locale,
          templateData.baseUrl,
          templateData.userName,
          subject,
          this.buildWelcomeText(anyData)
        );
        break;

      case 'password-reset':
        html = this.passwordReset({ ...anyData, baseUrl: templateData.baseUrl });
        subject = this.buildSubject(
          templateData.locale,
          templateData.locale === 'vi'
            ? '🔐 Đặt lại mật khẩu - ApexOS'
            : '🔐 Reset Your Password - ApexOS'
        );
        text = plainTextTemplate(
          templateData.locale,
          templateData.baseUrl,
          templateData.userName,
          subject,
          this.buildPasswordResetText(anyData),
          [{ label: templateData.locale === 'vi' ? 'Đặt lại mật khẩu' : 'Reset Password', url: anyData.resetUrl }]
        );
        break;

      case 'email-verification':
        html = this.emailVerification({ ...anyData, baseUrl: templateData.baseUrl });
        subject = this.buildSubject(
          templateData.locale,
          templateData.locale === 'vi'
            ? '✅ Xác minh email của bạn'
            : '✅ Verify Your Email'
        );
        const verifyUrl = `${templateData.baseUrl}/verify-email?token=${anyData.verificationUrl}`;
        text = plainTextTemplate(
          templateData.locale,
          templateData.baseUrl,
          templateData.userName,
          subject,
          templateData.locale === 'vi'
            ? `Vui lòng xác minh email của bạn bằng cách truy cập: ${verifyUrl}`
            : `Please verify your email by visiting: ${verifyUrl}`,
          [{ label: templateData.locale === 'vi' ? 'Xác minh Email' : 'Verify Email', url: `/verify-email?token=${anyData.verificationUrl}` }]
        );
        break;

      default:
        return { success: false, error: `Unknown notification type: ${notification.type}` };
    }

    return this.send({
      to: templateData.userEmail,
      subject,
      html,
      text,
    });
  }

  // Individual template methods (expect data with baseUrl)
  commissionEarned(data: CommissionEarnedData & { baseUrl: string }): string {
    return commissionEarnedTemplate(data);
  }

  payoutCompleted(data: PayoutCompletedData & { baseUrl: string }): string {
    return payoutCompletedTemplate(data);
  }

  weeklySummary(data: WeeklySummaryData & { baseUrl: string }): string {
    return weeklySummaryTemplate(data);
  }

  welcome(data: WelcomeData & { baseUrl: string }): string {
    return welcomeTemplate(data);
  }

  passwordReset(data: PasswordResetData & { baseUrl: string }): string {
    return passwordResetTemplate(data);
  }

  emailVerification(data: EmailVerificationData & { baseUrl: string }): string {
    return passwordResetTemplate({
      ...data,
      resetUrl: data.verificationUrl,
      resetToken: data.verificationUrl,
      expiresIn: data.expiresIn,
    });
  }

  // Text builders for plain text emails
  private buildCommissionEarnedText(data: any): string {
    const amount = new Intl.NumberFormat(data.locale === 'vi' ? 'vi-VN' : 'en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(data.amount);

    const tradeVolume = new Intl.NumberFormat(data.locale === 'vi' ? 'vi-VN' : 'en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(data.tradeVolume);

    const tierText = data.locale === 'vi'
      ? `Cấp ${data.tier}`
      : `Tier ${data.tier}`;

    return `${data.locale === 'vi' ? 'Bạn vừa nhận được hoa hồng!' : 'You earned a commission!'}

${data.locale === 'vi' ? 'Giao dịch:' : 'Deal:'} ${data.dealName}
${data.locale === 'vi' ? 'Sàn giao dịch:' : 'Exchange:'} ${data.exchange}
${data.locale === 'vi' ? 'Khối lượng giao dịch:' : 'Trade Volume:'} ${tradeVolume}
${data.locale === 'vi' ? 'Cấp hoa hồng:' : 'Commission Tier:'} ${tierText}
${data.locale === 'vi' ? 'Số tiền nhận được:' : 'Amount Earned:'} ${amount}
${data.locale === 'vi' ? 'Trạng thái:' : 'Status:'} ${data.payoutStatus}`;
  }

  private buildPayoutCompletedText(data: any): string {
    const amount = new Intl.NumberFormat(data.locale === 'vi' ? 'vi-VN' : 'en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(data.amount);

    return `${data.locale === 'vi' ? 'Thanh toán đã hoàn tất!' : 'Payout Completed!'}

${data.locale === 'vi' ? 'Số tiền:' : 'Amount:'} ${amount} USDC
${data.locale === 'vi' ? 'Mạng lưới:' : 'Network:'} ${data.network === 'testnet' ? 'Stellar Testnet' : 'Stellar Mainnet'}
${data.locale === 'vi' ? 'Địa chỉ ví:' : 'Wallet Address:'} ${data.walletAddress}
${data.locale === 'vi' ? 'Mã giao dịch:' : 'Transaction Hash:'} ${data.transactionHash}
${data.locale === 'vi' ? 'Ngày thanh toán:' : 'Payout Date:'} ${data.payoutDate}

${data.locale === 'vi' ? 'Xác nhận giao dịch:' : 'Verify transaction:'} ${data.explorerUrl}`;
  }

  private buildWeeklySummaryText(data: any): string {
    const total = new Intl.NumberFormat(data.locale === 'vi' ? 'vi-VN' : 'en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(data.totalEarnings);

    return `${data.locale === 'vi' ? 'Tóm tắt hàng tuần' : 'Weekly Summary'}

${data.locale === 'vi' ? 'Kỳ thanh toán:' : 'Period:'} ${data.periodStart} - ${data.periodEnd}
${data.locale === 'vi' ? 'Giao dịch:' : 'Conversions:'} ${data.conversionsCount}
${data.locale === 'vi' ? 'Giới thiệu đang hoạt động:' : 'Active Referrals:'} ${data.activeReferrals}
${data.locale === 'vi' ? 'Thu nhập tuần này:' : 'Weekly Earnings:'} ${total}
${data.locale === 'vi' ? 'Xếp hạng affiliate:' : 'Affiliate Rank:'} ${data.affiliateRank}
${data.locale === 'vi' ? 'Thanh toán tiếp theo:' : 'Next Payout:'} ${data.nextPayoutDate}`;
  }

  private buildWelcomeText(data: any): string {
    const roleText = data.locale === 'vi'
      ? { shopper: 'Người mua hàng', affiliate: 'Đối tác affiliate', admin: 'Quản trị viên' }
      : { shopper: 'Shopper', affiliate: 'Affiliate Partner', admin: 'Administrator' };

    let text = `${data.locale === 'vi' ? 'Chào mừng đến ApexOS!' : 'Welcome to ApexOS!'}

${data.locale === 'vi' ? 'Vai trò tài khoản của bạn:' : 'Your account role:'} ${roleText[data.role as keyof typeof roleText]}

`;

    if (data.referralCode) {
      text += `${data.locale === 'vi' ? 'Mã giới thiệu của bạn:' : 'Your referral code:'} ${data.referralCode}\n\n`;
    }

    text += `${data.locale === 'vi'
      ? 'Hoàn thiện hồ sơ và bắt đầu kiếm tiền!'
      : 'Complete your profile and start earning!'}`;

    return text;
  }

  private buildPasswordResetText(data: any): string {
    return `${data.locale === 'vi' ? 'Đặt lại mật khẩu' : 'Reset Your Password'}

${data.locale === 'vi'
  ? 'Nhấp vào liên kết sau để đặt lại mật khẩu:'
  : 'Click the link below to reset your password:'}

${data.resetUrl}

${data.locale === 'vi'
  ? `Liên kết này sẽ hết hạn sau ${data.expiresIn}.`
  : `This link will expire in ${data.expiresIn}.`}

${data.locale === 'vi'
  ? 'Nếu bạn không yêu cầu đặt lại mật khẩu, vui lòng bỏ qua email này.'
  : 'If you did not request a password reset, please ignore this email.'}`;
  }
}

/**
 * Create a new EmailNotifier instance with default configuration
 */
export function createEmailNotifier(config?: NotifierConfig): EmailNotifier {
  return new EmailNotifier(config);
}

/**
 * Singleton instance for convenience
 */
export const emailNotifier = createEmailNotifier();
