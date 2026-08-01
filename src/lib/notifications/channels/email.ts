/**
 * Email Notification Channel
 * Wrapper around existing Resend-based email notifier with retry logic
 */

import { EmailConfig, NotificationMessage, SendResult, NotificationContext } from '../config';
import { error as logError } from '@/lib/logger';
import { EmailNotifier, createEmailNotifier } from '@/lib/emails/notifier';
import { EmailNotification } from '@/lib/emails/types';
import { withRetry, DEFAULT_RETRY_CONFIG } from '../retry';

/**
 * Email channel sender
 */
export class EmailNotifierChannel {
  private config: EmailConfig;
  private emailNotifier: EmailNotifier;
  private context: NotificationContext;
  private retryConfig: Required<import('../retry').RetryConfig>;

  constructor(config: EmailConfig, context?: NotificationContext) {
    this.config = config;
    this.emailNotifier = createEmailNotifier({
      fromEmail: config.fromEmail,
      fromName: config.fromName,
    });
    this.context = context || {
      baseUrl: process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000',
      locale: 'en',
      appName: 'ApexOS',
      environment: 'development',
    };
    // Get retry config from environment or use defaults
    const retryMaxAttempts = parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10);
    const retryBackoffMs = parseInt(process.env.NOTIFICATION_RETRY_BACKOFF || '1000', 10);
    this.retryConfig = {
      maxAttempts: retryMaxAttempts,
      backoffMs: retryBackoffMs,
      maxBackoffMs: 30000,
      retryablePatterns: DEFAULT_RETRY_CONFIG.retryablePatterns,
      nonRetryablePatterns: DEFAULT_RETRY_CONFIG.nonRetryablePatterns,
    };
  }

  /**
   * Send notification via email with retry
   */
  async send(message: NotificationMessage, to?: string | string[]): Promise<SendResult> {
    const startTime = Date.now();

    // Debug: log recipients config in test mode
    if (process.env.NODE_ENV === 'test') {
    }

    try {
      const result = await withRetry(
        async () => {
          // Determine recipients
          const recipients = to || this.config.defaultRecipients;

          if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) {
            throw new Error('No email recipients configured');
          }

          // Build email from notification
          const email = this.buildEmail(message, recipients);

          const sendResult = await this.emailNotifier.send({
            to: recipients,
            subject: email.subject,
            html: email.html,
            text: email.text,
            replyTo: this.config.replyTo,
            tags: [
              { name: 'notification', value: message.type },
              { name: 'priority', value: message.priority },
            ],
          });

          if (!sendResult.success) {
            throw new Error(sendResult.error || 'Email send failed');
          }

          return sendResult.id || `email-${Date.now()}`;
        },
        this.retryConfig,
        (attempt, error, delayMs) => {
        }
      );

      if (result.success) {
        return {
          success: true,
          channel: 'email',
          messageId: result.value,
          timestamp: new Date(),
          retry: {
            attempts: result.attempts,
            totalDurationMs: result.totalDurationMs,
            errors: result.errors.map(e => e.message),
          },
        };
      } else {
        return {
          success: false,
          channel: 'email',
          error: result.errors[result.errors.length - 1]?.message || 'Failed after retries',
          timestamp: new Date(),
          retry: {
            attempts: result.attempts,
            totalDurationMs: result.totalDurationMs,
            errors: result.errors.map(e => e.message),
          },
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logError('[EmailNotifierChannel] Unexpected error:', errorMessage);

      return {
        success: false,
        channel: 'email',
        error: errorMessage,
        timestamp: new Date(),
        retry: {
          attempts: 1,
          totalDurationMs: Date.now() - startTime,
          errors: [errorMessage],
        },
      };
    }
  }

  /**
   * Build email from notification message
   */
  private buildEmail(
    message: NotificationMessage,
    to: string | string[]
  ): { subject: string; html: string; text: string } {
    const { title, message: msg, type, payload, priority, metadata } = message;
    const locale = this.context.locale;

    // Create HTML email with template
    const html = this.renderHtmlEmail(message);
    const text = this.renderTextEmail(message);

    return {
      subject: this.buildSubject(title, priority),
      html,
      text,
    };
  }

  /**
   * Build subject line with priority indicator
   */
  private buildSubject(title: string, priority: string): string {
    const priorityPrefixes: Record<string, string> = {
      low: '',
      normal: '',
      high: '[HIGH] ',
      critical: '[CRITICAL] ',
    };

    const prefix = priorityPrefixes[priority] || '';
    return `[${this.context.appName}] ${prefix}${title}`;
  }

  /**
   * Render HTML email
   */
  private renderHtmlEmail(message: NotificationMessage): string {
    const { title, message: msg, payload, priority } = message;
    const t = this.getTranslations();

    // Priority colors
    const priorityColors: Record<string, string> = {
      low: '#6b7280',
      normal: '#3b82f6',
      high: '#f59e0b',
      critical: '#ef4444',
    };
    const color = priorityColors[priority] || priorityColors.normal;

    // Build action buttons HTML
    const actionsHtml = this.renderActionButtons(payload);

    // Build details table from payload
    const detailsHtml = this.renderDetailsTable(payload);

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.escapeHtml(this.buildSubject(title, priority))}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background-color: #f5f5f5;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
    }
    .header {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
      padding: 24px 32px;
      text-align: center;
    }
    .logo {
      font-size: 24px;
      font-weight: bold;
      margin: 0;
    }
    .tagline {
      margin: 8px 0 0;
      font-size: 14px;
      opacity: 0.9;
    }
    .content {
      padding: 32px;
    }
    .priority-bar {
      height: 4px;
      background-color: ${color};
      margin: -32px -32px 24px;
    }
    .title {
      font-size: 20px;
      font-weight: bold;
      margin: 0 0 16px;
      color: #111827;
    }
    .message {
      font-size: 16px;
      color: #4b5563;
      margin: 0 0 24px;
      line-height: 1.7;
    }
    .section {
      margin-bottom: 24px;
      padding: 16px;
      background-color: #f9fafb;
      border-radius: 8px;
      border-left: 4px solid ${color};
    }
    .section-title {
      font-size: 12px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
    }
    .details-table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
    }
    .details-table th,
    .details-table td {
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
    }
    .details-table th {
      font-weight: 600;
      color: #6b7280;
      font-size: 13px;
      text-transform: uppercase;
      width: 40%;
    }
    .details-table td {
      color: #1f2937;
    }
    .actions {
      margin-top: 24px;
      text-align: center;
    }
    .button {
      display: inline-block;
      padding: 12px 24px;
      background-color: #6366f1;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      margin: 8px 4px;
    }
    .button.secondary {
      background-color: #f3f4f6;
      color: #374151;
    }
    .footer {
      text-align: center;
      padding: 24px;
      color: #6b7280;
      font-size: 13px;
      border-top: 1px solid #e5e7eb;
      background-color: #fafafa;
    }
    .footer a {
      color: #6366f1;
      text-decoration: none;
    }
    .environment-badge {
      display: inline-block;
      padding: 4px 12px;
      background-color: ${this.getEnvironmentColor()};
      color: white;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      margin-bottom: 16px;
    }
    .timestamp {
      color: #9ca3af;
      font-size: 12px;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="logo">${this.context.appName}</h1>
      <p class="tagline">${this.getTagline()}</p>
    </div>
    <div class="content">
      <div class="priority-bar"></div>
      <span class="environment-badge">${this.context.environment}</span>
      <h2 class="title">${this.escapeHtml(title)}</h2>
      <p class="message">${this.escapeHtml(msg)}</p>

      ${detailsHtml}

      ${actionsHtml}

      <p class="timestamp">
        ${t.sentAt}: ${new Date().toLocaleString()}
      </p>
    </div>
    <div class="footer">
      <p>
        <a href="${this.context.baseUrl}/dashboard">${t.viewDashboard}</a>
        | <a href="${this.context.supportEmail}">${t.contactSupport}</a>
      </p>
      <p style="margin-top: 16px; font-size: 12px;">
        <a href="${this.context.baseUrl}/settings/notifications">${t.manageNotifications}</a>
        | <a href="${this.context.docsUrl}">${t.documentation}</a>
      </p>
      <p style="margin-top: 16px;">
        © 2026 ${this.context.appName}. ${t.allRightsReserved}.
      </p>
    </div>
  </div>
</body>
</html>
    `;
  }

  /**
   * Render text email
   */
  private renderTextEmail(message: NotificationMessage): string {
    const { title, message: msg, payload } = message;
    const t = this.getTranslations();

    const text = `
${this.context.appName} Notification
${'='.repeat(50)}

${title}

${msg}

${t.details}:
${this.renderTextDetails(payload)}

${t.actions}:
${this.renderTextActions(payload)}

---
${t.sentAt}: ${new Date().toLocaleString()}
${t.manageNotifications}: ${this.context.baseUrl}/settings/notifications
${t.contactSupport}: ${this.context.supportEmail}
${t.appName} - ${this.context.baseUrl}
    `;

    return text.trim();
  }

  /**
   * Render action buttons HTML
   */
  private renderActionButtons(payload: Record<string, unknown>): string {
    const actions = payload.actions as Array<{ label: string; url: string; secondary?: boolean }> | undefined;

    if (!actions || actions.length === 0) {
      return '';
    }

    return `
      <div class="actions">
        ${actions
          .map(
            action => `<a href="${this.escapeHtml(action.url)}" class="button${action.secondary ? ' secondary' : ''}">${this.escapeHtml(action.label)}</a>`
          )
          .join('\n        ')}
      </div>
    `;
  }

  /**
   * Render details table HTML
   */
  private renderDetailsTable(payload: Record<string, unknown>): string {
    const excludeKeys = ['actions', 'links'];

    const entries = Object.entries(payload)
      .filter(([key]) => !excludeKeys.includes(key))
      .filter(([, value]) => value !== undefined && value !== null);

    if (entries.length === 0) {
      return '';
    }

    const rows = entries
      .map(([key, value]) => {
        const formattedValue = this.formatDetailValue(value);
        return `
        <tr>
          <th>${this.formatFieldTitle(key)}</th>
          <td>${formattedValue}</td>
        </tr>
      `;
      })
      .join('');

    return `
      <div class="section">
        <div class="section-title">${this.getTranslations().details}</div>
        <table class="details-table">
          ${rows}
        </table>
      </div>
    `;
  }

  /**
   * Render text details
   */
  private renderTextDetails(payload: Record<string, unknown>): string {
    const excludeKeys = ['actions', 'links'];

    return Object.entries(payload)
      .filter(([key]) => !excludeKeys.includes(key))
      .map(([key, value]) => {
        return `${this.formatFieldTitle(key)}: ${this.formatDetailValue(value)}`;
      })
      .join('\n');
  }

  /**
   * Render text actions
   */
  private renderTextActions(payload: Record<string, unknown>): string {
    const actions = payload.actions as Array<{ label: string; url: string }> | undefined;

    if (!actions || actions.length === 0) {
      return 'No actions available';
    }

    return actions
      .map(action => `- ${action.label}: ${this.context.baseUrl}${action.url}`)
      .join('\n');
  }

  /**
   * Format detail value for display
   */
  private formatDetailValue(value: unknown): string {
    if (value === null || value === undefined) return '-';

    if (typeof value === 'number') {
      return value.toLocaleString(this.context.locale);
    }

    if (value instanceof Date) {
      return value.toLocaleString(this.context.locale);
    }

    if (typeof value === 'boolean') {
      return value ? 'Yes' : 'No';
    }

    if (typeof value === 'object') {
      return JSON.stringify(value, null, 2);
    }

    return String(value);
  }

  /**
   * Format field title
   */
  private formatFieldTitle(key: string): string {
    return key
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    let escaped = div.innerHTML;
    // Also escape double quotes for safety in attributes
    escaped = escaped.replace(/"/g, '&quot;');
    return escaped;
  }

  /**
   * Get environment badge color
   */
  private getEnvironmentColor(): string {
    switch (this.context.environment) {
      case 'production':
        return '#10b981'; // green
      case 'staging':
        return '#f59e0b'; // orange
      default:
        return '#6b7280'; // gray
    }
  }

  /**
   * Get tagline based on environment
   */
  private getTagline(): string {
    switch (this.context.environment) {
      case 'production':
        return this.localeString('taglineProduction', 'Global Crypto Cashback Platform');
      case 'staging':
        return this.localeString('taglineStaging', 'Staging Environment');
      default:
        return this.localeString('taglineDevelopment', 'Development Environment');
    }
  }

  /**
   * Get localized string
   */
  private localeString(key: string, fallback: string): string {
    const translations: Record<string, Record<string, string>> = {
      en: {
        taglineProduction: 'Global Crypto Cashback Platform',
        taglineStaging: 'Staging Environment',
        taglineDevelopment: 'Development Environment',
        details: 'Details',
        actions: 'Actions',
        sentAt: 'Sent at',
        manageNotifications: 'Manage Notifications',
        contactSupport: 'Contact Support',
        documentation: 'Documentation',
        allRightsReserved: 'All rights reserved.',
        viewDashboard: 'View Dashboard',
      },
      vi: {
        taglineProduction: 'Nền tảng Cashback Crypto Toàn cầu',
        taglineStaging: 'Môi trường Staging',
        taglineDevelopment: 'Môi trường Phát triển',
        details: 'Chi tiết',
        actions: 'Hành động',
        sentAt: 'Gửi lúc',
        manageNotifications: 'Quản lý Thông báo',
        contactSupport: 'Liên hệ Hỗ trợ',
        documentation: 'Tài liệu',
        allRightsReserved: 'Mọi quyền được bảo lưu.',
        viewDashboard: 'Xem Bảng điều khiển',
      },
    };

    return translations[this.context.locale]?.[key] || fallback;
  }

  /**
   * Get context
   */
  getContext(): NotificationContext {
    return this.context;
  }

  /**
   * Get localized translations
   */
  private getTranslations(): Record<string, string> {
    const locale = this.context.locale;
    const baseUrl = this.context.baseUrl;

    const en = {
      taglineProduction: 'Global Crypto Cashback Platform',
      taglineStaging: 'Staging Environment',
      taglineDevelopment: 'Development Environment',
      details: 'Details',
      actions: 'Actions',
      sentAt: 'Sent at',
      manageNotifications: 'Manage Notifications',
      contactSupport: 'Contact Support',
      documentation: 'Documentation',
      allRightsReserved: 'All rights reserved.',
      viewDashboard: 'View Dashboard',
      viewPayoutHistory: 'View Payout History',
    };

    const vi = {
      taglineProduction: 'Nền tảng Cashback Crypto Toàn cầu',
      taglineStaging: 'Môi trường Staging',
      taglineDevelopment: 'Môi trường Phát triển',
      details: 'Chi tiết',
      actions: 'Hành động',
      sentAt: 'Gửi lúc',
      manageNotifications: 'Quản lý Thông báo',
      contactSupport: 'Liên hệ Hỗ trợ',
      documentation: 'Tài liệu',
      allRightsReserved: 'Mọi quyền được bảo lưu.',
      viewDashboard: 'Xem Bảng điều khiển',
      viewPayoutHistory: 'Xem Lịch sử Thanh toán',
    };

    return locale === 'vi' ? vi : en;
  }
}

/**
 * Create email channel notifier
 */
export function createEmailNotifierChannel(
  config: EmailConfig,
  context?: NotificationContext
): EmailNotifierChannel {
  return new EmailNotifierChannel(config, context);
}
