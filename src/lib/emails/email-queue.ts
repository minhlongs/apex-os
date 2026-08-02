/**
 * Email Queue Service
 * Enqueue, dequeue, and track email lifecycle via D1
 */

import { getDB } from '@/lib/db';
import type { D1Database } from '@/lib/db';

export type EmailQueueStatus = 'pending' | 'queued' | 'sending' | 'sent' | 'failed' | 'bounced';

export interface EmailQueueRow {
  id: string;
  user_id: string;
  email: string;
  type: string;
  subject: string;
  html: string;
  text: string | null;
  priority: number;
  status: EmailQueueStatus;
  scheduled_at: string;
  sent_at: string | null;
  error: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailEventRow {
  id: string;
  queue_id: string;
  event_type: string;
  email: string;
  resend_id: string | null;
  reason: string | null;
  payload: string | null;
  created_at: string;
}

export interface EnqueueInput {
  userId: string;
  email: string;
  type: string;
  subject: string;
  html: string;
  text?: string;
  priority?: number;
  scheduledAt?: string;
  metadata?: Record<string, unknown>;
}

const STATUS_PENDING = 'pending';
const STATUS_SENDING = 'sending';
const STATUS_SENT = 'sent';
const STATUS_FAILED = 'failed';

export class EmailQueueService {
  private db: D1Database | null = null;
  private dedupeCache: Map<string, EmailQueueRow> = new Map();

  private getDb(): D1Database {
    if (!this.db) {
      this.db = getDB();
    }
    return this.db;
  }

  private makeDedupeKey(input: EnqueueInput): string {
    const key = input.metadata?.dedupeKey as string | undefined;
    if (!key) return '';
    return `${input.email}|${input.type}|${key}`;
  }

  /** Enqueue a new email for sending (sync — no D1 reads) */
  enqueue(input: EnqueueInput): EmailQueueRow {
    const dedupeKey = this.makeDedupeKey(input);
    if (dedupeKey && this.dedupeCache.has(dedupeKey)) {
      return this.dedupeCache.get(dedupeKey)!;
    }

    const db = this.getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const scheduledAt = input.scheduledAt || now;
    const priority = input.priority ?? 2;
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

    db.prepare(
      `INSERT INTO email_queue
       (id, user_id, email, type, subject, html, text, priority, status, scheduled_at, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, input.userId, input.email, input.type, input.subject, input.html, input.text || null, priority, STATUS_PENDING, scheduledAt, metadataJson, now, now)
      .run();

    const row: EmailQueueRow = {
      id, user_id: input.userId, email: input.email, type: input.type,
      subject: input.subject, html: input.html, text: input.text || null,
      priority, status: STATUS_PENDING, scheduled_at: scheduledAt,
      sent_at: null, error: null, metadata: metadataJson,
      created_at: now, updated_at: now,
    };

    if (dedupeKey) {
      this.dedupeCache.set(dedupeKey, row);
    }

    return row;
  }

  /** Enqueue multiple emails in a batch */
  enqueueBatch(inputs: EnqueueInput[]): EmailQueueRow[] {
    return inputs.map(input => this.enqueue(input));
  }

  /** Dequeue next batch of pending emails up to batchSize */
  async dequeue(batchSize = 50): Promise<EmailQueueRow[]> {
    const db = this.getDb();
    const now = new Date().toISOString();

    const rows = await db.prepare(
      `UPDATE email_queue
       SET status = ?, updated_at = ?
       WHERE id IN (
         SELECT id FROM email_queue
         WHERE status = ? AND scheduled_at <= ?
         ORDER BY priority ASC, scheduled_at ASC
         LIMIT ?
       )`
    )
      .bind(STATUS_SENDING, now, STATUS_PENDING, now, batchSize)
      .all();

    return rows.results as EmailQueueRow[];
  }

  /** Get pending emails without locking them */
  async getPending(limit = 100): Promise<EmailQueueRow[]> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const rows = await db.prepare(
      `SELECT * FROM email_queue
       WHERE status = ? AND scheduled_at <= ?
       ORDER BY priority ASC, scheduled_at ASC
       LIMIT ?`
    ).bind(STATUS_PENDING, now, limit).all();
    return rows.results as EmailQueueRow[];
  }

  /** Mark an email as sent after successful delivery */
  async markSent(id: string, resendId?: string): Promise<EmailQueueRow | null> {
    const db = this.getDb();
    const now = new Date().toISOString();

    await db.prepare(
      `UPDATE email_queue SET status = ?, sent_at = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(STATUS_SENT, now, now, id)
      .run();

    if (resendId) {
      await this.recordEvent(id, 'delivered', resendId);
    }

    return this.getById(id);
  }

  /** Mark an email as failed */
  async markFailed(id: string, error: string): Promise<EmailQueueRow | null> {
    const db = this.getDb();
    const now = new Date().toISOString();

    await db.prepare(
      `UPDATE email_queue SET status = ?, error = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(STATUS_FAILED, error, now, id)
      .run();

    await this.recordEvent(id, 'failed', null, error);
    return this.getById(id);
  }

  /** Get a single queue row by id */
  async getById(id: string): Promise<EmailQueueRow | null> {
    const db = this.getDb();
    const row = await db.prepare('SELECT * FROM email_queue WHERE id = ?').bind(id).first<EmailQueueRow | null>();
    return row;
  }

  /** Get queue stats */
  async getStats(): Promise<Record<string, number>> {
    const db = this.getDb();
    const rows = await db
      .prepare(
        `SELECT status, COUNT(*) as count FROM email_queue GROUP BY status`
      )
      .all();
    const stats: Record<string, number> = {};
    for (const row of rows.results as Array<{ status: string; count: number }>) {
      stats[row.status] = row.count;
    }
    return stats;
  }

  /** Record an email event */
  async recordEvent(queueId: string, eventType: string, resendId: string | null, reason?: string): Promise<EmailEventRow> {
    const db = this.getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const queueRow = await this.getById(queueId);
    const email = queueRow?.email || '';

    await db.prepare(
      `INSERT INTO email_events (id, queue_id, event_type, email, resend_id, reason, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, queueId, eventType, email, resendId, reason || null, null, now)
      .run();

    return this.getEventById(id);
  }

  /** Get events for a queue item */
  async getEvents(queueId: string): Promise<EmailEventRow[]> {
    const db = this.getDb();
    const rows = await db
      .prepare(
        `SELECT * FROM email_events WHERE queue_id = ? ORDER BY created_at ASC`
      )
      .bind(queueId)
      .all();
    return rows.results as EmailEventRow[];
  }

  /** Get a single event by id */
  async getEventById(id: string): Promise<EmailEventRow | null> {
    const db = this.getDb();
    const row = await db.prepare('SELECT * FROM email_events WHERE id = ?').bind(id).first<EmailEventRow | null>();
    return row;
  }

  /** Get recent events across all emails */
  async getRecentEvents(limit = 100): Promise<EmailEventRow[]> {
    const db = this.getDb();
    const rows = await db
      .prepare(
        `SELECT * FROM email_events ORDER BY created_at DESC LIMIT ?`
      )
      .bind(limit)
      .all();
    return rows.results as EmailEventRow[];
  }
}

/** Singleton instance */
let queueInstance: EmailQueueService | null = null;

export function getEmailQueueService(): EmailQueueService {
  if (!queueInstance) {
    queueInstance = new EmailQueueService();
  }
  return queueInstance;
}

export const emailQueueService = getEmailQueueService();
