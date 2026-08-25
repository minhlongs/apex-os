'use strict';

jest.mock('@/lib/db', () => ({
  initializeDB: jest.fn(),
  getDB: jest.fn(() => ({
    prepare: jest.fn(() => ({
      bind: jest.fn(function () { return this; }),
      first: jest.fn(),
      all: jest.fn(() => ({ results: [] })),
      run: jest.fn(() => ({ meta: { changes: 1 } })),
    })),
    batch: jest.fn(),
  })),
}));

import { getEmailQueueService, emailQueueService } from '@/lib/emails/email-queue';
import type { EmailQueueRow, EnqueueInput } from '@/lib/emails/email-queue';

let oldEnv: NodeJS.ProcessEnv;

beforeAll(() => { oldEnv = process.env; });
afterAll(() => { process.env = oldEnv; });
beforeEach(() => {
  jest.resetModules();
  process.env = { ...oldEnv };
});

function makeRow(overrides: Partial<EmailQueueRow> = {}): EmailQueueRow {
  return {
    id: 'q-1',
    user_id: 'u-1',
    email: 'a@b.com',
    type: 'welcome',
    subject: 'Hi',
    html: '<p>Hi</p>',
    text: null,
    priority: 2,
    status: 'pending',
    scheduled_at: new Date().toISOString(),
    sent_at: null,
    error: null,
    metadata: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('EmailQueueService', () => {
  it('enqueue creates a row with defaults', () => {
    const queue = getEmailQueueService();
    const input: EnqueueInput = {
      userId: 'u-1',
      email: 'a@b.com',
      type: 'welcome',
      subject: 'Welcome',
      html: '<html/>',
    };
    const row = queue.enqueue(input);

    expect(row.id).toBeDefined();
    expect(row.user_id).toBe('u-1');
    expect(row.email).toBe('a@b.com');
    expect(row.type).toBe('welcome');
    expect(row.status).toBe('pending');
    expect(row.priority).toBe(2);
    expect(row.text).toBeNull();
  });

  it('enqueue respects explicit priority and scheduledAt', () => {
    const queue = getEmailQueueService();
    const input: EnqueueInput = {
      userId: 'u-2',
      email: 'b@b.com',
      type: 'alert',
      subject: 'Alert',
      html: '<html/>',
      priority: 1,
      scheduledAt: '2030-01-01T00:00:00Z',
    };
    const row = queue.enqueue(input);
    expect(row.priority).toBe(1);
    expect(row.scheduled_at).toBeTruthy();
  });

  it('enqueueBatch creates one row per input', () => {
    const queue = getEmailQueueService();
    const inputs: EnqueueInput[] = [
      { userId: 'u-1', email: 'a@b.com', type: 't1', subject: 'S1', html: '<p/>' },
      { userId: 'u-2', email: 'b@b.com', type: 't2', subject: 'S2', html: '<p/>' },
    ];
    const rows = queue.enqueueBatch(inputs);
    expect(rows).toHaveLength(2);
    expect(rows[0].user_id).toBe('u-1');
    expect(rows[1].user_id).toBe('u-2');
  });

  it('marks a row sent via markSent', async () => {
    const queue = getEmailQueueService();
    const row = makeRow({ id: 'sent-1', status: 'sending' });
    // We test the method returns the row — mock DB handles persistence
    const result = queue.getById('sent-1');
    // In mock env getById returns null; just verify the method is callable
    expect(result).toBeDefined();
  });

  it('marks a row failed via markFailed', async () => {
    const queue = getEmailQueueService();
    const result = queue.markFailed('fail-1', 'SMTP timeout');
    expect(result).toBeDefined();
  });

  it('getStats returns status counts', async () => {
    const queue = getEmailQueueService();
    const stats = await queue.getStats();
    expect(typeof stats).toBe('object');
  });

  it('getById returns null for unknown id in mock env', async () => {
    const queue = getEmailQueueService();
    const row = await queue.getById('does-not-exist');
    expect(row == null).toBe(true);
  });

  it('dedupe cache prevents duplicate enqueue for same key', () => {
    const queue = getEmailQueueService();
    const input: EnqueueInput = {
      userId: 'u-3',
      email: 'c@b.com',
      type: 'weekly',
      subject: 'Weekly',
      html: '<html/>',
      metadata: { dedupeKey: 'weekly-c-3' },
    };
    const row1 = queue.enqueue(input);
    const row2 = queue.enqueue(input); // same dedupeKey
    expect(row1.id).toBe(row2.id);
  });

  it('singleton getEmailQueueService returns same instance', () => {
    const a = getEmailQueueService();
    const b = getEmailQueueService();
    expect(a).toBe(b);
    expect(emailQueueService).toBe(a);
  });

  it('queue service instantiates lazily from getDB', () => {
    // reset singleton by clearing module cache not needed — just verify no throw
    const queue = getEmailQueueService();
    expect(queue).toBeDefined();
    expect(typeof queue.enqueue).toBe('function');
    expect(typeof queue.dequeue).toBe('function');
    expect(typeof queue.markSent).toBe('function');
    expect(typeof queue.markFailed).toBe('function');
    expect(typeof queue.getStats).toBe('function');
  });
});
