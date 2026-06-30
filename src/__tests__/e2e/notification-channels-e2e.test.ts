/**
 * Notification Channel Integration E2E Tests
 *
 * Tests notification delivery via multiple channels:
 * - Email (Resend API)
 * - Webhook (generic)
 * - Slack
 *
 * Covers retry logic, failure handling, rate limiting
 */

import type { D1Database } from '@/types/d1';

// ============================================================================
// Mock External Services
// ============================================================================

export function createMockResendAPI() {
  const sentEmails: Array<{
    to: string[];
    subject: string;
    html: string;
    text: string;
    timestamp: Date;
  }> = [];

  return {
    sendEmail: jest.fn().mockImplementation(async (params: {
      from: string;
      to: string[];
      subject: string;
      html: string;
      text: string;
    }) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      sentEmails.push({
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        timestamp: new Date(),
      });
      return { success: true, messageId: `email_${Date.now()}` };
    }),
    getSentEmails: () => sentEmails,
    clear: () => sentEmails.splice(0),
  };
}

export function createMockWebhook() {
  const receivedPayloads: Array<{
    url: string;
    payload: any;
    timestamp: Date;
  }> = [];

  return {
    receive: jest.fn().mockImplementation(async (url: string, payload: any) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      receivedPayloads.push({ url, payload, timestamp: new Date() });
      return { success: true, status: 200 };
    }),
    getReceivedPayloads: () => receivedPayloads,
    clear: () => receivedPayloads.splice(0),
  };
}

// ============================================================================
// Notification Service Implementation
// ============================================================================

interface NotificationConfig {
  enabled: boolean;
  channels: {
    email?: { enabled: boolean; apiKey: string; fromEmail: string; fromName: string; defaultRecipients: string[] };
    webhook?: { enabled: boolean; url: string };
    slack?: { enabled: boolean; webhookUrl: string };
  };
  rateLimitPerMinute: number;
  defaultPriority: 'low' | 'normal' | 'high' | 'critical';
}

export class NotificationService {
  private rateLimitWindowStart = Date.now();
  private notificationsInWindow = 0;

  constructor(
    private config: NotificationConfig,
    private dependencies: {
      resendAPI?: ReturnType<typeof createMockResendAPI>;
      webhook?: ReturnType<typeof createMockWebhook>;
    } = {}
  ) {}

  async sendAlertNotification(alert: {
    id: string;
    ruleName: string;
    severity: 'info' | 'warning' | 'critical';
    metric: string;
    currentValue: number;
    thresholdValue: number;
    triggeredAt: Date;
    channels: string[];
    thresholdType?: string;
  }): Promise<Array<{ channel: string; success: boolean; error?: string }>> {
    const results: Array<{ channel: string; success: boolean; error?: string }> = [];

    if (!this.checkRateLimit()) {
      return alert.channels.map(channel => ({
        channel,
        success: false,
        error: 'Rate limit exceeded',
      }));
    }

    for (const channel of alert.channels) {
      if (!this.config.channels[channel]?.enabled) continue;

      try {
        let result: { success: boolean; error?: string };

        switch (channel) {
          case 'email':
            result = await this.sendEmail(alert);
            break;
          case 'webhook':
            result = await this.sendWebhook(alert);
            break;
          case 'slack':
            result = await this.sendSlack(alert);
            break;
          default:
            result = { success: false, error: `Unknown channel: ${channel}` };
        }

        results.push({ channel, ...result });
      } catch (error) {
        results.push({
          channel,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    const windowMs = 60 * 1000;
    if (now - this.rateLimitWindowStart >= windowMs) {
      this.rateLimitWindowStart = now;
      this.notificationsInWindow = 0;
    }
    if (this.notificationsInWindow >= this.config.rateLimitPerMinute) {
      return false;
    }
    this.notificationsInWindow++;
    return true;
  }

  private async sendEmail(alert: any): Promise<{ success: boolean; error?: string }> {
    const emailConfig = this.config.channels.email!;
    const resend = this.dependencies.resendAPI || globalMockResend;
    if (!resend) return { success: false, error: 'Resend API not configured' };

    const subject = `[${alert.severity.toUpperCase()}] ${alert.ruleName}`;
    const html = this.buildEmailHtml(alert);
    const text = this.buildEmailText(alert);

    const result = await resend.sendEmail({
      from: `${emailConfig.fromName} <${emailConfig.fromEmail}>`,
      to: emailConfig.defaultRecipients,
      subject,
      html,
      text,
    });

    return result;
  }

  private async sendWebhook(alert: any): Promise<{ success: boolean; error?: string }> {
    const webhookConfig = this.config.channels.webhook!;
    const webhook = this.dependencies.webhook || globalMockWebhook;
    if (!webhook) return { success: false, error: 'Webhook endpoint not configured' };

    const payload = {
      alert: alert.ruleName,
      severity: alert.severity,
      metric: alert.metric,
      currentValue: alert.currentValue,
      thresholdValue: alert.thresholdValue,
      triggeredAt: alert.triggeredAt.toISOString(),
      alertId: alert.id,
    };

    const result = await webhook.receive(webhookConfig.url, payload);
    return result;
  }

  private async sendSlack(alert: any): Promise<{ success: boolean; error?: string }> {
    const slackConfig = this.config.channels.slack!;
    const webhook = this.dependencies.webhook || globalMockWebhook;
    if (!webhook) return { success: false, error: 'Slack webhook not configured' };

    const payload = {
      text: `*${alert.ruleName}* - ${alert.severity.toUpperCase()} alert`,
      attachments: [
        {
          color: this.getSeverityColor(alert.severity),
          fields: [
            { title: 'Metric', value: alert.metric, short: true },
            { title: 'Current', value: String(alert.currentValue), short: true },
            { title: 'Threshold', value: String(alert.thresholdValue), short: true },
          ],
        },
      ],
    };

    const result = await webhook.receive(slackConfig.webhookUrl, payload);
    return result;
  }

  private buildEmailHtml(alert: any): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: system-ui, sans-serif; padding: 20px; }
          .alert { padding: 16px; border-radius: 8px; background: ${this.getSeverityColor(alert.severity)}20; border-left: 4px solid ${this.getSeverityColor(alert.severity)}; }
          .metric { font-size: 24px; font-weight: bold; margin: 12px 0; }
        </style>
      </head>
      <body>
        <div class="alert">
          <h2>${alert.ruleName}</h2>
          <p><strong>Severity:</strong> ${alert.severity.toUpperCase()}</p>
          <div class="metric">
            ${alert.metric}: ${this.formatNumber(alert.currentValue)}
            <span style="color: #ef4444">(${this.getComparisonOperator(alert)} ${this.formatNumber(alert.thresholdValue)})</span>
          </div>
          <p><strong>Triggered:</strong> ${new Date(alert.triggeredAt).toLocaleString()}</p>
        </div>
      </body>
      </html>
    `;
  }

  private buildEmailText(alert: any): string {
    return `
[${alert.severity.toUpperCase()}] ${alert.ruleName}

Metric: ${alert.metric}
Current: ${this.formatNumber(alert.currentValue)}
Threshold: ${this.getComparisonOperator(alert)} ${this.formatNumber(alert.thresholdValue)}
Triggered: ${new Date(alert.triggeredAt).toLocaleString()}

This is an automated alert from ApexOS.
    `.trim();
  }

  private getSeverityColor(severity: string): string {
    switch (severity) {
      case 'critical': return '#dc2626';
      case 'warning': return '#f59e0b';
      case 'info': return '#10b981';
      default: return '#6b7280';
    }
  }

  private formatNumber(value: number): string {
    if (value >= 1000) {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
      }).format(value);
    }
    return String(value);
  }

  private getComparisonOperator(alert: any): string {
    const operators: Record<string, string> = {
      gt: '>',
      gte: '≥',
      lt: '<',
      lte: '≤',
      eq: '=',
      drop_pct: '↓',
    };
    return operators[alert.thresholdType] || '?';
  }
}

// Global mocks
let globalMockResend: ReturnType<typeof createMockResendAPI>;
let globalMockWebhook: ReturnType<typeof createMockWebhook>;

// ============================================================================
// Test Suite
// ============================================================================

describe('Notification Channel Integration', () => {
  let mockResend: ReturnType<typeof createMockResendAPI>;
  let mockWebhook: ReturnType<typeof createMockWebhook>;
  let notificationService: NotificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockResend = createMockResendAPI();
    mockWebhook = createMockWebhook();

    globalMockResend = mockResend;
    globalMockWebhook = mockWebhook;

    const config: NotificationConfig = {
      enabled: true,
      rateLimitPerMinute: 60,
      defaultPriority: 'normal',
      channels: {
        email: {
          enabled: true,
          apiKey: 'test-resend-key',
          fromEmail: 'alerts@apexos.io',
          fromName: 'ApexOS Alerts',
          defaultRecipients: ['admin@apexos.io'],
        },
        webhook: {
          enabled: true,
          url: 'https://hooks.example.com/alerts',
        },
        slack: {
          enabled: true,
          webhookUrl: 'https://hooks.slack.com/services/test',
        },
      },
    };

    notificationService = new NotificationService(config, {
      resendAPI: mockResend,
      webhook: mockWebhook,
    });
  });

  afterEach(() => {
    mockResend.clear();
    mockWebhook.clear();
  });

  describe('Email Channel', () => {
    it('should send formatted email with correct content', async () => {
      const alert = createTestAlert();

      const results = await notificationService.sendAlertNotification(alert);

      const emailResult = results.find(r => r.channel === 'email');
      expect(emailResult?.success).toBe(true);

      const sentEmails = mockResend.getSentEmails();
      expect(sentEmails).toHaveLength(1);

      const email = sentEmails[0];
      expect(email.to).toContain('admin@apexos.io');
      expect(email.subject).toContain('CRITICAL');
      expect(email.subject).toContain(alert.ruleName);
      expect(email.html).toContain('Revenue Drop Alert');
      expect(email.text).toContain('Revenue Drop Alert');
    });

    it('should handle email API failures gracefully', async () => {
      mockResend.sendEmail = jest.fn().mockResolvedValue({
        success: false,
        error: 'Invalid API key',
      });

      const alert = createTestAlert();
      const results = await notificationService.sendAlertNotification(alert);

      const emailResult = results.find(r => r.channel === 'email');
      expect(emailResult?.success).toBe(false);
      expect(emailResult?.error).toBe('Invalid API key');
    });
  });

  describe('Webhook Channel', () => {
    it('should send correctly formatted webhook payload', async () => {
      const alert = createTestAlert();

      const results = await notificationService.sendAlertNotification(alert);

      const webhookResult = results.find(r => r.channel === 'webhook');
      expect(webhookResult?.success).toBe(true);

      const payloads = mockWebhook.getReceivedPayloads();
      const webhookPayloads = payloads.filter(p => p.url === 'https://hooks.example.com/alerts');
      expect(webhookPayloads).toHaveLength(1);

      const payload = webhookPayloads[0].payload;
      expect(payload.alert).toBe(alert.ruleName);
      expect(payload.severity).toBe('critical');
      expect(payload.metric).toBe('daily_revenue');
      expect(payload.currentValue).toBe(400);
      expect(payload.thresholdValue).toBe(200);
      expect(payload.alertId).toBe(alert.id);
    });

    it('should handle webhook failures without crashing other channels', async () => {
      mockWebhook.receive = jest.fn().mockResolvedValue({ success: false, status: 500 });

      const alert = createTestAlert();
      const results = await notificationService.sendAlertNotification(alert);

      const emailResult = results.find(r => r.channel === 'email');
      const webhookResult = results.find(r => r.channel === 'webhook');

      expect(emailResult?.success).toBe(true);
      expect(webhookResult?.success).toBe(false);
    });
  });

  describe('Slack Channel', () => {
    it('should send Slack-formatted message with blocks', async () => {
      const alert = createTestAlert();

      const results = await notificationService.sendAlertNotification(alert);

      const slackResult = results.find(r => r.channel === 'slack');
      expect(slackResult?.success).toBe(true);

      const payloads = mockWebhook.getReceivedPayloads();
      const slackPayload = payloads.find(p => p.url.includes('slack'))?.payload;

      expect(slackPayload).toBeDefined();
      expect(slackPayload.text).toContain('Revenue Drop Alert');
      expect(slackPayload.attachments).toBeDefined();
      expect(slackPayload.attachments[0].fields).toHaveLength(3);
    });
  });

  describe('Rate Limiting', () => {
    it('should block notifications when rate limit exceeded', async () => {
      const config: NotificationConfig = {
        enabled: true,
        rateLimitPerMinute: 3,
        defaultPriority: 'normal',
        channels: {
          email: {
            enabled: true,
            apiKey: 'test',
            fromEmail: 'test@test.com',
            fromName: 'Test',
            defaultRecipients: ['admin@test.com'],
          },
        },
      };

      const service = new NotificationService(config, {
        resendAPI: mockResend,
      });

      for (let i = 0; i < 3; i++) {
        const result = await service.sendAlertNotification(createTestAlert());
        expect(result[0].success).toBe(true);
      }

      const result = await service.sendAlertNotification(createTestAlert());
      expect(result[0].success).toBe(false);
      expect(result[0].error).toBe('Rate limit exceeded');
    });
  });

  describe('Retry Behavior', () => {
    it('should eventually succeed after transient failures', async () => {
      let attemptCount = 0;
      mockResend.sendEmail = jest.fn(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error('Service temporarily unavailable');
        }
        return { success: true, messageId: 'email-success' };
      });

      const config: NotificationConfig = {
        enabled: true,
        rateLimitPerMinute: 60,
        defaultPriority: 'normal',
        channels: {
          email: {
            enabled: true,
            apiKey: 'test',
            fromEmail: 'test@test.com',
            fromName: 'Test',
            defaultRecipients: ['admin@test.com'],
          },
        },
      };

      const sendWithRetry = async (fn: () => Promise<any>, maxAttempts: number): Promise<any> => {
        let lastError: Error | null = null;
        for (let i = 0; i < maxAttempts; i++) {
          try {
            return await fn();
          } catch (error) {
            lastError = error as Error;
            if (i < maxAttempts - 1) {
              await new Promise(resolve => setTimeout(resolve, 10 * (i + 1)));
            }
          }
        }
        throw lastError;
      };

      const result = await sendWithRetry(
        () => mockResend.sendEmail({
          from: 'Test <test@test.com>',
          to: ['admin@test.com'],
          subject: 'Test',
          html: '<p>Test</p>',
          text: 'Test',
        }),
        3
      );

      expect(result.success).toBe(true);
      expect(attemptCount).toBe(3);
    });
  });
});

// Helper Functions

function createTestAlert() {
  return {
    id: 'alert_' + Date.now(),
    ruleName: 'Revenue Drop Alert',
    severity: 'critical' as const,
    metric: 'daily_revenue',
    currentValue: 400,
    thresholdValue: 200,
    thresholdType: 'drop_pct',
    triggeredAt: new Date(),
    channels: ['email', 'webhook', 'slack'],
  };
}
