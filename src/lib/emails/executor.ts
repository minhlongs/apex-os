/**
 * Email task executor
 * Thin wrapper so callers do not need to know the queue schema/options shape.
 */

import { getEmailQueueService, type EmailQueueRow } from './email-queue';

export interface QueueEmailInput {
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

export type QueuedEmail = EmailQueueRow;

export function enqueueTransactional(input: QueueEmailInput): QueuedEmail {
  const queue = getEmailQueueService();
  return queue.enqueue({
    ...input,
    priority: input.priority ?? 1,
    scheduledAt: input.scheduledAt ?? new Date().toISOString(),
    metadata: { ...(input.metadata ?? {}), category: 'transactional' },
  }) as QueuedEmail;
}

export function enqueueCampaign(input: QueueEmailInput): QueuedEmail {
  const queue = getEmailQueueService();
  return queue.enqueue({
    ...input,
    priority: input.priority ?? 2,
    scheduledAt: input.scheduledAt ?? new Date().toISOString(),
    metadata: { ...(input.metadata ?? {}), category: 'campaign' },
  }) as QueuedEmail;
}

export function getQueueStats(): { pending: number; sending: number; sent: number; failed: number; total: number } {
  // Return a safe default shape; richer stats can be added via emailQueueService when needed.
  return { pending: 0, sending: 0, sent: 0, failed: 0, total: 0 };
}
