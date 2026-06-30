/**
 * Notification Dispatcher Unit Tests
 */

import { NotificationDispatcher, createDispatcher, DispatchJob } from '@/lib/monitoring/dispatcher';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock D1 database
const createMockDb = () => ({
  prepare: jest.fn(() => ({
    bind: jest.fn(() => ({
      all: jest.fn().mockResolvedValue({ results: [] }),
      first: jest.fn().mockResolvedValue(undefined),
      run: jest.fn().mockResolvedValue({ changes: 0 }),
    })),
    all: jest.fn().mockResolvedValue({ results: [] }),
    first: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockResolvedValue({ changes: 0 }),
  })),
});

describe('NotificationDispatcher', () => {
  let dispatcher: NotificationDispatcher;

  beforeEach(() => {
    jest.clearAllMocks();
    dispatcher = createDispatcher({
      batchSize: 10,
      concurrency: 3,
      timeoutMs: 30000,
      maxRetries: 3,
    });
  });

  describe('Configuration', () => {
    it('should use default configuration when not provided', () => {
      const defaultDispatcher = createDispatcher();
      const config = defaultDispatcher.getConfig();

      expect(config.batchSize).toBe(10);
      expect(config.concurrency).toBe(3);
      expect(config.timeoutMs).toBe(30000);
      expect(config.maxRetries).toBe(3);
    });

    it('should use provided configuration', () => {
      const customDispatcher = createDispatcher({
        batchSize: 20,
        concurrency: 5,
        timeoutMs: 60000,
        maxRetries: 5,
      });
      const config = customDispatcher.getConfig();

      expect(config.batchSize).toBe(20);
      expect(config.concurrency).toBe(5);
      expect(config.timeoutMs).toBe(60000);
      expect(config.maxRetries).toBe(5);
    });
  });

  describe('Statistics', () => {
    it('should start with zero statistics', () => {
      const stats = dispatcher.getStats();

      expect(stats.totalProcessed).toBe(0);
      expect(stats.totalSucceeded).toBe(0);
      expect(stats.totalFailed).toBe(0);
      expect(stats.totalDeadLetters).toBe(0);
      expect(stats.batchesProcessed).toBe(0);
      expect(stats.averageProcessingTimeMs).toBe(0);
    });

    it('should reset statistics correctly', () => {
      // Manually set some stats
      (dispatcher as any).stats = {
        totalProcessed: 100,
        totalSucceeded: 90,
        totalFailed: 5,
        totalDeadLetters: 5,
        batchesProcessed: 10,
        averageProcessingTimeMs: 500,
      };

      dispatcher.resetStats();
      const stats = dispatcher.getStats();

      expect(stats.totalProcessed).toBe(0);
      expect(stats.totalSucceeded).toBe(0);
      expect(stats.batchesProcessed).toBe(0);
    });
  });

  describe('Batch Processing', () => {
    it('should return zero results for empty batch', async () => {
      const result = await dispatcher.processBatch([], async () => {});

      expect(result).toEqual({ completed: 0, failed: 0, deadLetters: 0 });
    });

    it('should process successful jobs correctly', async () => {
      const jobs: DispatchJob[] = [
        {
          id: 'job1',
          alertId: 'alert1',
          channel: 'email',
          priority: 'normal',
          payload: { test: 'data1' },
          attempts: 0,
          maxAttempts: 3,
          status: 'pending',
          createdAt: new Date().toISOString(),
          scheduledAt: new Date().toISOString(),
        },
        {
          id: 'job2',
          alertId: 'alert2',
          channel: 'slack',
          priority: 'high',
          payload: { test: 'data2' },
          attempts: 0,
          maxAttempts: 3,
          status: 'pending',
          createdAt: new Date().toISOString(),
          scheduledAt: new Date().toISOString(),
        },
      ];

      const sendFn = jest.fn().mockResolvedValue(undefined);

      const result = await dispatcher.processBatch(jobs, sendFn);

      expect(result.completed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.deadLetters).toBe(0);
      expect(sendFn).toHaveBeenCalledTimes(2);
    });

    it('should handle failed jobs that exceed max retries', async () => {
      const jobs: DispatchJob[] = [
        {
          id: 'job1',
          alertId: 'alert1',
          channel: 'email',
          priority: 'normal',
          payload: { test: 'data1' },
          attempts: 0,
          maxAttempts: 2,
          status: 'pending',
          createdAt: new Date().toISOString(),
          scheduledAt: new Date().toISOString(),
        },
      ];

      // Simulate failing send function
      const sendFn = jest.fn().mockRejectedValue(new Error('Network error'));

      const mockDb = createMockDb();
      const result = await dispatcher.processBatch(jobs, sendFn, mockDb as any);

      // The job is processed (handled by dispatcher) so completed=1
      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0); // No batch-level failure
      expect(result.deadLetters).toBe(1); // Job sent to dead letter queue

      // Verify the job was attempted maxAttempts times (2)
      expect(sendFn).toHaveBeenCalledTimes(2);
    });

    it('should respect concurrency limit', async () => {
      const numJobs = 10;
      const jobs: DispatchJob[] = Array.from({ length: numJobs }, (_, i) => ({
        id: `job${i}`,
        alertId: `alert${i}`,
        channel: 'email',
        priority: 'normal',
        payload: { test: `data${i}` },
        attempts: 0,
        maxAttempts: 3,
        status: 'pending',
        createdAt: new Date().toISOString(),
        scheduledAt: new Date().toISOString(),
      }));

      // Track concurrent executions
      let concurrentCount = 0;
      let maxConcurrent = 0;
      const sendFn = jest.fn().mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise(resolve => setTimeout(resolve, 50)); // Simulate work
        concurrentCount--;
      });

      await dispatcher.processBatch(jobs, sendFn);

      // With concurrency=3, max concurrent should not exceed 3
      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });
  });

  describe('Timeout Handling', () => {
    it('should fail jobs that exceed timeout', async () => {
      const jobs: DispatchJob[] = [
        {
          id: 'job1',
          alertId: 'alert1',
          channel: 'email',
          priority: 'normal',
          payload: { test: 'data1' },
          attempts: 0,
          maxAttempts: 1, // Only one attempt
          status: 'pending',
          createdAt: new Date().toISOString(),
          scheduledAt: new Date().toISOString(),
        },
      ];

      // Simulate a slow send function that exceeds timeout
      const fastDispatcher = createDispatcher({
        batchSize: 10,
        concurrency: 3,
        timeoutMs: 100, // Very short timeout
        maxRetries: 1,
      });

      const sendFn = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
      });

      const mockDb = createMockDb();
      const result = await fastDispatcher.processBatch(jobs, sendFn, mockDb as any);

      // Job times out and goes to DLQ
      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.deadLetters).toBe(1);
    });
  });

  describe('Dead Letter Queue', () => {
    it('should write to dead letter queue when max retries exceeded', async () => {
      const jobs: DispatchJob[] = [
        {
          id: 'job1',
          alertId: 'alert1',
          channel: 'email',
          priority: 'normal',
          payload: { test: 'data1' },
          attempts: 0,
          maxAttempts: 2,
          status: 'pending',
          createdAt: new Date().toISOString(),
          scheduledAt: new Date().toISOString(),
        },
      ];

      const sendFn = jest.fn().mockRejectedValue(new Error('Permanent failure'));
      const mockDb = createMockDb();

      // Mock the insert query
      const mockRun = jest.fn().mockResolvedValue({ changes: 1 });
      (mockDb.prepare as any).mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO dead_letter_queue')) {
          return {
            bind: jest.fn(() => ({ run: mockRun })),
          };
        }
        return {
          bind: jest.fn(() => ({
            all: jest.fn().mockResolvedValue({ results: [] }),
            first: jest.fn().mockResolvedValue(undefined),
            run: jest.fn().mockResolvedValue({ changes: 0 }),
          })),
        };
      });

      await dispatcher.processBatch(jobs, sendFn, mockDb as any);

      // Verify dead letter was written
      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('DispatchJob Factory', () => {
    it('should create dispatch job with correct fields', () => {
      const job = NotificationDispatcher.createDispatchJob(
        'alert123',
        'email',
        'high',
        { message: 'Test alert' }
      );

      expect(job.id).toMatch(/^job_\d+_[a-z0-9]+$/);
      expect(job.alertId).toBe('alert123');
      expect(job.channel).toBe('email');
      expect(job.priority).toBe('high');
      expect(job.payload).toEqual({ message: 'Test alert' });
      expect(job.attempts).toBe(0);
      expect(job.maxAttempts).toBe(3);
      expect(job.status).toBe('pending');
    });
  });

  describe('Concurrency Control', () => {
    it('should not exceed concurrency limit', async () => {
      const dispatcherWithLowConcurrency = createDispatcher({
        batchSize: 10,
        concurrency: 2, // Only 2 concurrent
        timeoutMs: 30000,
        maxRetries: 1,
      });

      const jobs: DispatchJob[] = Array.from({ length: 20 }, (_, i) => ({
        id: `job${i}`,
        alertId: `alert${i}`,
        channel: 'email',
        priority: 'normal',
        payload: { test: `data${i}` },
        attempts: 0,
        maxAttempts: 1,
        status: 'pending',
        createdAt: new Date().toISOString(),
        scheduledAt: new Date().toISOString(),
      }));

      const executionOrder: number[] = [];
      const activeJobs = new Set<number>();
      const sendFn = jest.fn().mockImplementation(async (job: DispatchJob) => {
        const jobIndex = parseInt(job.id.replace('job', ''), 10);
        executionOrder.push(jobIndex);
        activeJobs.add(jobIndex);

        // Check concurrency while running
        expect(activeJobs.size).toBeLessThanOrEqual(2);

        await new Promise(resolve => setTimeout(resolve, 10));
        activeJobs.delete(jobIndex);
      });

      await dispatcherWithLowConcurrency.processBatch(jobs, sendFn);

      expect(sendFn).toHaveBeenCalledTimes(20);
    });
  });

  describe('Retry Logic', () => {
    it('should retry on transient failures', async () => {
      const jobs: DispatchJob[] = [
        {
          id: 'job1',
          alertId: 'alert1',
          channel: 'email',
          priority: 'normal',
          payload: { test: 'data1' },
          attempts: 0,
          maxAttempts: 3,
          status: 'pending',
          createdAt: new Date().toISOString(),
          scheduledAt: new Date().toISOString(),
        },
      ];

      // Fail twice, then succeed
      const sendFn = jest.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce(undefined);

      const result = await dispatcher.processBatch(jobs, sendFn);

      expect(result.completed).toBe(1);
      expect(sendFn).toHaveBeenCalledTimes(3);
    });

    it('should not retry on non-retryable errors', async () => {
      const jobs: DispatchJob[] = [
        {
          id: 'job1',
          alertId: 'alert1',
          channel: 'email',
          priority: 'normal',
          payload: { test: 'data1' },
          attempts: 0,
          maxAttempts: 3,
          status: 'pending',
          createdAt: new Date().toISOString(),
          scheduledAt: new Date().toISOString(),
        },
      ];

      // Fail with non-retryable error
      const sendFn = jest.fn().mockRejectedValue(new Error('Invalid API key'));

      const result = await dispatcher.processBatch(jobs, sendFn);

      // Job is processed but fails (non-retryable) - goes to dead letter
      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.deadLetters).toBe(1);
      expect(sendFn).toHaveBeenCalledTimes(1); // Only one attempt
    });
  });
});
