/**
 * Generic Webhook Notification Channel
 * Sends notifications to any HTTP webhook endpoint with retry logic
 */

import { WebhookConfig, NotificationMessage, SendResult } from '../config';
import { withRetry, DEFAULT_RETRY_CONFIG } from '../retry';

/**
 * Webhook channel sender
 */
export class WebhookNotifier {
  private config: WebhookConfig;
  private retryConfig: Required<import('../retry').RetryConfig>;

  constructor(config: WebhookConfig) {
    this.config = config;
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
   * Send notification to webhook with retry
   */
  async send(message: NotificationMessage): Promise<SendResult> {
    const startTime = Date.now();

    try {
      const result = await withRetry(
        async () => {
          const payload = this.buildPayload(message);
          const response = await fetch(this.config.webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.config.headers || {}),
            },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Webhook failed: ${response.status} - ${errorText}`);
          }

          return `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        },
        this.retryConfig,
        (attempt, error, delayMs) => {
        }
      );

      return {
        success: true,
        channel: 'webhook',
        messageId: result.value,
        timestamp: new Date(),
        retry: {
          attempts: result.attempts,
          totalDurationMs: result.totalDurationMs,
          errors: [],
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[WebhookNotifier] Unexpected error:', errorMessage);

      return {
        success: false,
        channel: 'webhook',
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
   * Build webhook payload from notification message
   */
  private buildPayload(message: NotificationMessage): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      type: message.type,
      title: message.title,
      message: message.message,
      priority: message.priority,
      timestamp: message.timestamp?.toISOString() || new Date().toISOString(),
      payload: message.payload,
      metadata: message.metadata,
    };

    // If custom payload format is provided, merge/override
    if (this.config.payloadFormat === 'flat') {
      // Flatten the structure
      return {
        alert: message.title,
        message: message.message,
        severity: message.priority,
        ...message.payload,
        timestamp: payload.timestamp,
      };
    }

    return payload;
  }

  /**
   * Get configuration
   */
  getConfig(): WebhookConfig {
    return this.config;
  }
}

/**
 * Create webhook notifier instance
 */
export function createWebhookNotifier(config: WebhookConfig): WebhookNotifier {
  return new WebhookNotifier(config);
}
