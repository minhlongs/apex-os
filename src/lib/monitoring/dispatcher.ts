/**
 * Notification Dispatcher with Batched Async Processing
 *
 * Features:
 * - Batch processing (configurable batch size, default 10)
 * - Concurrency control (max 3 concurrent operations)
 * - Per-notification timeout (default 30 seconds)
 * - Dead letter queue for failed notifications
 * - Retry logic with exponential backoff
 *
 * Used by the Alert Engine to send notifications reliably.
 */

import { withRetry, DEFAULT_RETRY_CONFIG, RetryResult } from '@/lib/notifications/retry';
import type { D1Database } from '@/types/d1';
import { error as logError, info as logInfo } from '@/lib/logger';

/**
 * Retryable error patterns - same as in retry.ts
 */
const RETRYABLE_PATTERNS = [
  /timeout/i,
  /econnreset/i,
  /network/i,
  /fetch/i,
  /failed to fetch/i,
  /request failed/i,
  /too many requests/i,
  /rate limit/i,
  /429/i,
  /5\d{2}/i, // 5xx server errors
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
];

const NON_RETRYABLE_PATTERNS = [
  /unauthorized/i,
  /forbidden/i,
  /not found/i,
  /404/i,
  /invalid/i,
  /authentication/i,
  /apikey/i,
  /token/i,
];

/**
 * Check if an error is retryable
 */
function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Check non-retryable patterns first
  if (NON_RETRYABLE_PATTERNS.some(pattern => pattern.test(message))) {
    return false;
  }

  // Check if matches any retryable pattern
  if (RETRYABLE_PATTERNS.some(pattern => pattern.test(message))) {
    return true;
  }

  // Default: retry on any Error by default for transient issues
  return true;
}

/**
 * Notification dispatch job
 */
export interface DispatchJob {
  id: string;
  alertId: string;
  channel: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';
  createdAt: string;
  scheduledAt: string;
  lastAttemptAt?: string;
  error?: string;
  nextRetryAt?: string;
}

/**
 * Dead letter queue entry
 */
export interface DeadLetterEntry {
  id: string;
  originalJobId: string;
  alertId: string;
  channel: string;
  payload: Record<string, unknown>;
  error: string;
  attempts: number;
  createdAt: string;
  failedAt: string;
}

/**
 * Dispatcher configuration
 */
export interface DispatcherConfig {
  /** Batch size for processing (default: 10) */
  batchSize: number;
  /** Maximum concurrent operations (default: 3) */
  concurrency: number;
  /** Timeout per notification in milliseconds (default: 30000) */
  timeoutMs: number;
  /** Maximum retry attempts for failed notifications (default: 3) */
  maxRetries: number;
  /** Enabled notification channels */
  enabledChannels: string[];
}

/**
 * Dispatcher statistics
 */
export interface DispatcherStats {
  totalProcessed: number;
  totalSucceeded: number;
  totalFailed: number;
  totalDeadLetters: number;
  batchesProcessed: number;
  averageProcessingTimeMs: number;
  lastRunAt?: string;
}

/**
 * Semaphore for concurrency control
 */
class Semaphore {
  private current: number = 0;
  private max: number;
  private queue: (() => void)[] = [];

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.current--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.current++;
        next();
      }
    }
  }

  getCurrentConcurrency(): number {
    return this.current;
  }
}

/**
 * Notification Dispatcher
 *
 * Processes notifications in batches with controlled concurrency,
 * per-notification timeouts, and dead letter queue handling.
 */
export class NotificationDispatcher {
  private config: Required<DispatcherConfig>;
  private semaphore: Semaphore;
  private stats: DispatcherStats;
  private isProcessing: boolean = false;

  constructor(config: Partial<DispatcherConfig> = {}) {
    this.config = {
      batchSize: config.batchSize ?? 10,
      concurrency: config.concurrency ?? 3,
      timeoutMs: config.timeoutMs ?? 30000,
      maxRetries: config.maxRetries ?? 3,
      enabledChannels: config.enabledChannels ?? ['email', 'slack', 'telegram', 'webhook'],
    };
    this.semaphore = new Semaphore(this.config.concurrency);
    this.stats = {
      totalProcessed: 0,
      totalSucceeded: 0,
      totalFailed: 0,
      totalDeadLetters: 0,
      batchesProcessed: 0,
      averageProcessingTimeMs: 0,
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<DispatcherConfig> {
    return { ...this.config };
  }

  /**
   * Get dispatcher statistics
   */
  getStats(): DispatcherStats {
    return { ...this.stats };
  }

  /**
   * Process a batch of dispatch jobs
   *
   * @param jobs - Array of dispatch jobs to process
   * @param sendFn - Async function that sends a notification (receives job, returns void)
   * @param db - Database for dead letter queue operations (optional)
   */
  async processBatch(
    jobs: DispatchJob[],
    sendFn: (job: DispatchJob) => Promise<void>,
    db?: D1Database
  ): Promise<{ completed: number; failed: number; deadLetters: number }> {
    if (jobs.length === 0) {
      return { completed: 0, failed: 0, deadLetters: 0 };
    }

    this.stats.batchesProcessed++;
    const batchStartTime = Date.now();
    let completed = 0;
    let failed = 0;
    let deadLetters = 0;

    // Process jobs with concurrency control
    const promises = jobs.map(job => this.processJobWithSemaphore(job, sendFn, db));

    // Wait for all to complete
    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        completed++;
        this.stats.totalSucceeded++;
        if (result.value.deadLetterCreated) {
          deadLetters++;
          this.stats.totalDeadLetters++;
        }
      } else {
        failed++;
        this.stats.totalFailed++;
        logError('[Dispatcher] Job failed:', result.reason);
      }
    }

    // Update stats
    this.stats.totalProcessed += jobs.length;
    const batchDuration = Date.now() - batchStartTime;
    const newAvg = this.stats.averageProcessingTimeMs || batchDuration;
    this.stats.averageProcessingTimeMs = Math.round(
      (newAvg + batchDuration) / 2
    );

    return { completed, failed, deadLetters };
  }

  /**
   * Process a single job with concurrency semaphore
   */
  private async processJobWithSemaphore(
    job: DispatchJob,
    sendFn: (job: DispatchJob) => Promise<void>,
    db: D1Database | undefined
  ): Promise<{ deadLetterCreated: boolean }> {
    await this.semaphore.acquire();

    try {
      return await this.processSingleJob(job, sendFn, db);
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Process a single dispatch job with timeout and retry
   */
  private async processSingleJob(
    job: DispatchJob,
    sendFn: (job: DispatchJob) => Promise<void>,
    db: D1Database | undefined
  ): Promise<{ deadLetterCreated: boolean }> {
    const startTime = Date.now();
    let deadLetterCreated = false;
    let lastError: Error | null = null;

    // Retry loop
    while (job.attempts < job.maxAttempts) {
      job.attempts++;
      job.lastAttemptAt = new Date().toISOString();

      try {
        // Create a timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Notification dispatch timeout after ${this.config.timeoutMs}ms`));
          }, this.config.timeoutMs);
        });

        // Race the send function against the timeout
        const sendPromise = sendFn(job);
        await Promise.race([sendPromise, timeoutPromise]);

        // Success!
        job.status = 'completed';
        logInfo(`[Dispatcher] Job ${job.id} completed successfully (channel: ${job.channel}, attempts: ${job.attempts})`);
        return { deadLetterCreated: false };

      } catch (error: any) {
        lastError = error;
        const errorMessage = error?.message || String(error);
        logError(`[Dispatcher] Job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}):`, errorMessage);

        // Check if error is retryable
        const retryable = isRetryableError(error as Error);

        if (!retryable) {
          // Non-retryable error - fail immediately without further retries
          job.status = 'dead_letter';
          deadLetterCreated = true;

          if (db) {
            await this.sendToDeadLetterQueue(job, errorMessage, db);
          }

          logError(`[Dispatcher] Job ${job.id} non-retryable error, sent to dead letter queue immediately`);
          return { deadLetterCreated };
        }

        // If this was the last attempt, handle as dead letter
        if (job.attempts >= job.maxAttempts) {
          job.status = 'dead_letter';
          deadLetterCreated = true;

          if (db) {
            await this.sendToDeadLetterQueue(job, errorMessage, db);
          }

          logError(`[Dispatcher] Job ${job.id} sent to dead letter queue after ${job.attempts} attempts`);
          break;
        }

        // Not done yet, prepare for next retry
        job.status = 'pending';
        job.error = errorMessage;
        job.nextRetryAt = this.calculateNextRetryAt(job.attempts);

        // Wait before next retry (exponential backoff)
        const delayMs = this.calculateBackoffMs(job.attempts);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    const duration = Date.now() - startTime;
    logInfo(`[Dispatcher] Job ${job.id} processed in ${duration}ms, final status: ${job.status}`);

    return { deadLetterCreated };
  }

  /**
   * Calculate backoff delay in milliseconds for a given attempt number
   */
  private calculateBackoffMs(attempt: number): number {
    const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    const jitter = backoffMs * 0.2 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(backoffMs + jitter));
  }

  /**
   * Calculate next retry timestamp based on attempt number (exponential backoff)
   */
  private calculateNextRetryAt(attempt: number): string {
    const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    const jitter = backoffMs * 0.2 * (Math.random() * 2 - 1);
    const delayMs = Math.max(0, Math.round(backoffMs + jitter));
    const nextRetry = new Date(Date.now() + delayMs);
    return nextRetry.toISOString();
  }

  /**
   * Send failed job to dead letter queue
   */
  private async sendToDeadLetterQueue(
    job: DispatchJob,
    error: string,
    db: D1Database
  ): Promise<void> {
    try {
      await db
        .prepare(`
          INSERT INTO dead_letter_queue (
            id, job_id, alert_id, channel, payload, error, attempts, created_at, failed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          `dlq_${job.id}`,
          job.id,
          job.alertId,
          job.channel,
          JSON.stringify(job.payload),
          error,
          job.attempts,
          job.createdAt,
          new Date().toISOString()
        )
        .run();
    } catch (e) {
      logError('[Dispatcher] Failed to write to dead letter queue:', e);
    }
  }

  /**
   * Get jobs ready for retry from dead letter queue
   */
  async getRetryableDeadLetters(db: D1Database, limit: number = 10): Promise<DeadLetterEntry[]> {
    const result = await db
      .prepare(`
        SELECT * FROM dead_letter_queue
        WHERE attempts < ? AND next_retry_at <= datetime('now')
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .bind(this.config.maxRetries, limit)
      .all();

    return result.results as DeadLetterEntry[];
  }

  /**
   * Mark a dead letter as retried (increment attempts, update next_retry_at)
   */
  async markDeadLetterRetried(
    db: D1Database,
    deadLetterId: string,
    newJobId: string
  ): Promise<void> {
    await db
      .prepare(`
        UPDATE dead_letter_queue
        SET attempts = attempts + 1, next_retry_at = ?, job_id = ?
        WHERE id = ?
      `)
      .bind(
        this.calculateNextRetryAt(this.config.maxRetries), // Use max retries to avoid infinite loop
        newJobId,
        deadLetterId
      )
      .run();
  }

  /**
   * Get dead letter queue statistics
   */
  async getDeadLetterStats(db: D1Database): Promise<{ total: number; byChannel: Record<string, number> }> {
    const totalResult = await db
      .prepare('SELECT COUNT(*) as count FROM dead_letter_queue')
      .first<{ count: number }>();

    const byChannelResult = await db
      .prepare(`
        SELECT channel, COUNT(*) as count
        FROM dead_letter_queue
        GROUP BY channel
      `)
      .all<{ channel: string; count: number }>();

    return {
      total: totalResult?.count ?? 0,
      byChannel: byChannelResult.results.reduce((acc, row) => {
        acc[row.channel] = row.count;
        return acc;
      }, {} as Record<string, number>),
    };
  }

  /**
   * Clear old entries from dead letter queue (older than 30 days)
   */
  async cleanupOldDeadLetters(db: D1Database, daysOld: number = 30): Promise<number> {
    const result = await db
      .prepare(`
        DELETE FROM dead_letter_queue
        WHERE created_at < datetime('now', '-' || ? || ' days')
      `)
      .bind(daysOld)
      .run();

    return result.meta.changes ?? 0;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalProcessed: 0,
      totalSucceeded: 0,
      totalFailed: 0,
      totalDeadLetters: 0,
      batchesProcessed: 0,
      averageProcessingTimeMs: 0,
    };
  }

  /**
   * Check if dispatcher is currently processing
   */
  isCurrentlyProcessing(): boolean {
    return this.isProcessing;
  }

  /**
   * Create a dispatch job from alert data
   */
  static createDispatchJob(
    alertId: string,
    channel: string,
    priority: 'low' | 'normal' | 'high' | 'critical',
    payload: Record<string, unknown>
  ): DispatchJob {
    return {
      id: `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      alertId,
      channel,
      priority,
      payload,
      attempts: 0,
      maxAttempts: 3,
      status: 'pending',
      createdAt: new Date().toISOString(),
      scheduledAt: new Date().toISOString(),
    };
  }
}

/**
 * Factory function to create a new dispatcher
 */
export function createDispatcher(config?: Partial<DispatcherConfig>): NotificationDispatcher {
  return new NotificationDispatcher(config);
}

/**
 * Singleton instance for convenience
 */
let singletonDispatcher: NotificationDispatcher | null = null;

export function getDispatcher(config?: Partial<DispatcherConfig>): NotificationDispatcher {
  if (!singletonDispatcher) {
    singletonDispatcher = new NotificationDispatcher(config);
  }
  return singletonDispatcher;
}
