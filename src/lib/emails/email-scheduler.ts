/**
 * Email Scheduler
 * Cron-based batch processor for the email queue.
 */

import { getEmailQueueService, type EmailQueueRow } from './email-queue';
import { createEmailNotifier } from './notifier';
import { getDB } from '@/lib/db';

export interface BatchProcessResult {
  processed: number;
  sent: number;
  failed: number;
  errors: string[];
  durationMs: number;
}

const BATCH_SIZE = 50;

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Process the email queue: dequeue, send, mark sent/failed */
export async function processEmailQueue(): Promise<BatchProcessResult> {
  const start = Date.now();
  const queue = getEmailQueueService();
  const notifier = createEmailNotifier({ dryRun: false });
  const errors: string[] = [];
  let sent = 0;
  let failed = 0;

  const batch = await queue.dequeue(BATCH_SIZE);

  for (const item of batch) {
    try {
      const result = await notifier.send({
        to: item.email,
        subject: item.subject,
        html: item.html,
        text: item.text ?? undefined,
      });

      if (result.success) {
        await queue.markSent(item.id, result.id);
        sent++;
      } else {
        const err = result.error ?? 'Unknown send error';
        await queue.markFailed(item.id, err);
        errors.push(`${item.id}: ${err}`);
        failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      await queue.markFailed(item.id, msg);
      errors.push(`${item.id}: ${msg}`);
      failed++;
    }
  }

  return {
    processed: batch.length,
    sent,
    failed,
    errors,
    durationMs: Date.now() - start,
  };
}

/** Retry failed emails (max 3 attempts tracked in metadata) */
export async function retryFailedEmails(maxRetries = 3): Promise<BatchProcessResult> {
  const start = Date.now();
  const queue = getEmailQueueService();
  const notifier = createEmailNotifier({ dryRun: false });
  const errors: string[] = [];
  let sent = 0;
  let failed = 0;

  const db = getDB();

  const rowsResult = await db.prepare(
    `SELECT * FROM email_queue
     WHERE status = ? AND json_extract(metadata, '$.retry_count') < ?
     ORDER BY priority ASC, scheduled_at ASC
     LIMIT ?`
  ).bind('failed', maxRetries, BATCH_SIZE).all();

  const failedItems = rowsResult.results as EmailQueueRow[];

  for (const item of failedItems) {
    const metadata = parseMetadata(item.metadata);
    const retryCount = (metadata.retry_count as number) ?? 0;

    if (retryCount >= maxRetries) continue;

    try {
      await db.prepare(`UPDATE email_queue SET status = ?, updated_at = ? WHERE id = ?`)
        .bind('sending', new Date().toISOString(), item.id).run();

      const result = await notifier.send({
        to: item.email,
        subject: item.subject,
        html: item.html,
        text: item.text ?? undefined,
      });

      if (result.success) {
        await queue.markSent(item.id, result.id);
        sent++;
      } else {
        const err = result.error ?? 'Unknown error';
        const newRetryCount = retryCount + 1;
        const updatedMeta = { ...metadata, retry_count: newRetryCount };
        await db.prepare(
          `UPDATE email_queue SET status = ?, error = ?, metadata = ?, updated_at = ? WHERE id = ?`
        ).bind('failed', err, JSON.stringify(updatedMeta), new Date().toISOString(), item.id).run();
        errors.push(`${item.id}: ${err}`);
        failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      const newRetryCount = retryCount + 1;
      const updatedMeta = { ...metadata, retry_count: newRetryCount };
      await db.prepare(
        `UPDATE email_queue SET status = ?, error = ?, metadata = ?, updated_at = ? WHERE id = ?`
      ).bind('failed', msg, JSON.stringify(updatedMeta), new Date().toISOString(), item.id).run();
      errors.push(`${item.id}: ${msg}`);
      failed++;
    }
  }

  return {
    processed: failedItems.length,
    sent,
    failed,
    errors,
    durationMs: Date.now() - start,
  };
}

/** Get queue health snapshot for monitoring */
export async function getQueueHealth(): Promise<{
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  total: number;
  oldestPendingAgeMinutes: number | null;
}> {
  const queue = getEmailQueueService();
  const stats = await queue.getStats();
  const db = getDB();
  let oldestPendingAgeMinutes: number | null = null;

  if (db) {
    const row = await db.prepare(
      `SELECT MIN(created_at) as oldest FROM email_queue WHERE status = ?`
    ).bind('pending').first<{ oldest: string | null }>();
    if (row?.oldest) {
      const oldest = new Date(row.oldest).getTime();
      oldestPendingAgeMinutes = Math.floor((Date.now() - oldest) / 60000);
    }
  }

  return {
    pending: stats.pending ?? 0,
    sending: stats.sending ?? 0,
    sent: stats.sent ?? 0,
    failed: stats.failed ?? 0,
    total: Object.values(stats).reduce((a, b) => a + b, 0),
    oldestPendingAgeMinutes,
  };
}
