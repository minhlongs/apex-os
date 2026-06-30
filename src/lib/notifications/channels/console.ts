/**
 * Console Notification Channel
 * Logs notifications to console for development/debugging
 */

import { ConsoleConfig, NotificationMessage, SendResult } from '../config';

/**
 * Console channel sender
 */
export class ConsoleNotifier {
  private config: ConsoleConfig;
  private logLevel: 'log' | 'info' | 'warn';

  constructor(config: ConsoleConfig = {}) {
    this.config = config;
    this.logLevel = config.logLevel || 'log';
  }

  /**
   * Send notification to console
   */
  async send(message: NotificationMessage): Promise<SendResult> {
    const startTime = Date.now();
    const logFn = console[this.logLevel] || console.log;

    try {
      const logOutput = this.buildLogOutput(message);
      logFn(`[ConsoleNotifier] ${logOutput}`);

      return {
        success: true,
        channel: 'console',
        messageId: `console-${Date.now()}`,
        timestamp: new Date(),
        retry: {
          attempts: 1,
          totalDurationMs: Date.now() - startTime,
          errors: [],
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[ConsoleNotifier] Error:', errorMessage);

      return {
        success: false,
        channel: 'console',
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
   * Build formatted log output
   */
  private buildLogOutput(message: NotificationMessage): string {
    const severity = message.priority.toUpperCase();
    const timestamp = new Date().toISOString();

    let output = `\n${'='.repeat(60)}\n`;
    output += `ALERT: ${message.title}\n`;
    output += `${'='.repeat(60)}\n`;
    output += `Time: ${timestamp}\n`;
    output += `Severity: ${severity}\n`;
    output += `Type: ${message.type}\n`;
    output += `\nMessage:\n${message.message}\n`;

    if (Object.keys(message.payload).length > 0) {
      output += `\nPayload:\n${JSON.stringify(message.payload, null, 2)}\n`;
    }

    if (message.metadata) {
      output += `\nMetadata:\n${JSON.stringify(message.metadata, null, 2)}\n`;
    }

    output += `${'='.repeat(60)}\n`;

    return output;
  }

  /**
   * Get configuration
   */
  getConfig(): ConsoleConfig {
    return this.config;
  }
}

/**
 * Create console notifier instance
 */
export function createConsoleNotifier(config?: ConsoleConfig): ConsoleNotifier {
  return new ConsoleNotifier(config);
}
