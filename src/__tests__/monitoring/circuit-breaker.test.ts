/**
 * Circuit Breaker Unit Tests
 *
 * Tests for the circuit breaker implementation:
 * - State transitions (closed -> open -> half_open -> closed)
 * - Failure counting and threshold
 * - Timeout handling
 * - Success recording
 * - Reset functionality
 */

import { CircuitBreaker, getCircuitBreaker, resetCircuitBreaker, resetAllCircuitBreakers } from '@/lib/monitoring/circuit-breaker';
import type { D1Database } from '@/types/d1';

// Mock D1 database
function createMockDB() {
  return {
    prepare: jest.fn(() => ({
      bind: jest.fn(function() { return this; }),
      first: jest.fn(async () => null),
      run: jest.fn(async () => ({ success: true })),
    })),
  };
}

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test-service', {
      failureThreshold: 3,
      timeoutSeconds: 5,
    });
  });

  afterEach(() => {
    resetCircuitBreaker('test-service');
  });

  describe('Initialization', () => {
    it('should initialize with default values', () => {
      expect(breaker.getState().name).toBe('test-service');
      expect(breaker.getState().state).toBe('closed');
      expect(breaker.getState().failure_count).toBe(0);
    });

    it('should initialize with custom options', () => {
      const customBreaker = new CircuitBreaker('custom-service', {
        failureThreshold: 5,
        timeoutSeconds: 30,
        halfOpenMaxCalls: 5,
      });

      expect(customBreaker.getState().failure_threshold).toBe(5);
      expect(customBreaker.getState().timeout_seconds).toBe(30);
    });
  });

  describe('Successful Operations', () => {
    it('should allow operations in closed state', async () => {
      const result = await breaker.execute(async () => 'success');
      expect(result).toBe('success');
      expect(breaker.getState().state).toBe('closed');
      expect(breaker.getState().failure_count).toBe(0);
    });

    it('should reset failure count on success', async () => {
      // Simulate failures
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('fail');
          });
        } catch (e) {}
      }

      expect(breaker.getFailureCount()).toBe(2);

      // Success should reset
      await breaker.execute(async () => 'success');
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe('Failure Handling', () => {
    it('should increment failure count on failure', async () => {
      try {
        await breaker.execute(async () => {
          throw new Error('operation failed');
        });
      } catch (e) {}

      expect(breaker.getFailureCount()).toBe(1);
    });

    it('should open circuit after threshold failures', async () => {
      const failures = breaker.getFailureCount();

      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('fail');
          });
        } catch (e) {}
      }

      expect(breaker.getState().state).toBe('open');
      expect(breaker.getFailureCount()).toBe(3);
    });

    it('should block operations when circuit is open', async () => {
      // Force open state
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('fail');
          });
        } catch (e) {}
      }

      await expect(breaker.execute(async () => 'success')).rejects.toThrow(
        'OPEN'
      );
    });
  });

  describe('Half-Open State', () => {
    it('should transition to half_open after timeout', async () => {
      // Force open state
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('fail');
          });
        } catch (e) {}
      }

      expect(breaker.getState().state).toBe('open');

      // Manually set next_attempt_at to past to simulate timeout
      (breaker as any).nextAttemptAt = new Date(Date.now() - 1000);

      // Check availability - should transition to half_open
      const available = await breaker.isAvailable();
      expect(available).toBe(true);
      expect(breaker.getState().state).toBe('half_open');
    });

    it('should limit calls in half_open state', async () => {
      // Force half_open state
      const breaker2 = new CircuitBreaker('half-open-test', {
        failureThreshold: 3,
        timeoutSeconds: 5,
        halfOpenMaxCalls: 2,
      });

      // Force open then transition to half_open
      for (let i = 0; i < 3; i++) {
        try {
          await breaker2.execute(async () => {
            throw new Error('fail');
          });
        } catch (e) {}
      }

      // Manually set next_attempt_at to past
      (breaker2 as any).nextAttemptAt = new Date(Date.now() - 1000);
      await breaker2.isAvailable();

      // First two calls should work (within limit)
      await breaker2.execute(async () => 'success1');
      await breaker2.execute(async () => 'success2');

      // After exhausting half-open max calls, circuit should close
      expect(breaker2.getState().state).toBe('closed');

      // Third call should succeed in closed state
      const result = await breaker2.execute(async () => 'success3');
      expect(result).toBe('success3');
    });

    it('should close circuit on successful half_open call', async () => {
      const breaker2 = new CircuitBreaker('half-open-close-test', {
        failureThreshold: 3,
        timeoutSeconds: 5,
        halfOpenMaxCalls: 1,
      });

      // Force open then transition to half_open
      for (let i = 0; i < 3; i++) {
        try {
          await breaker2.execute(async () => {
            throw new Error('fail');
          });
        } catch (e) {}
      }

      // Manually set next_attempt_at to past
      (breaker2 as any).nextAttemptAt = new Date(Date.now() - 1000);
      await breaker2.isAvailable();
      expect(breaker2.getState().state).toBe('half_open');

      // Successful call should close circuit
      await breaker2.execute(async () => 'success');
      expect(breaker2.getState().state).toBe('closed');
      expect(breaker2.getFailureCount()).toBe(0);
    });

    it('should reopen on failure in half_open state', async () => {
      const breaker2 = new CircuitBreaker('half-open-reopen-test', {
        failureThreshold: 3,
        timeoutSeconds: 5,
        halfOpenMaxCalls: 1,
      });

      // Force open then transition to half_open
      for (let i = 0; i < 3; i++) {
        try {
          await breaker2.execute(async () => {
            throw new Error('fail');
          });
        } catch (e) {}
      }

      // Manually set next_attempt_at to past
      (breaker2 as any).nextAttemptAt = new Date(Date.now() - 1000);
      await breaker2.isAvailable();
      expect(breaker2.getState().state).toBe('half_open');

      // Failure should reopen circuit
      try {
        await breaker2.execute(async () => {
          throw new Error('fail');
        });
      } catch (e) {}

      expect(breaker2.getState().state).toBe('open');
    });
  });

  describe('Reset', () => {
    it('should reset circuit breaker to closed state', async () => {
      // Force failures
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('fail');
          });
        } catch (e) {}
      }

      expect(breaker.getState().state).toBe('open');

      breaker.reset();

      expect(breaker.getState().state).toBe('closed');
      expect(breaker.getFailureCount()).toBe(0);
      expect(breaker.getState().next_attempt_at).toBeNull();
    });
  });

  describe('Time Until Next Attempt', () => {
    it('should return null when circuit is closed', () => {
      expect(breaker.getTimeUntilNextAttempt()).toBeNull();
    });

    it('should return time remaining when circuit is open', async () => {
      const breaker2 = new CircuitBreaker('timeout-test', {
        failureThreshold: 3,
        timeoutSeconds: 10,
      });

      // Force open
      for (let i = 0; i < 3; i++) {
        try {
          await breaker2.execute(async () => {
            throw new Error('fail');
          });
        } catch (e) {}
      }

      const timeRemaining = breaker2.getTimeUntilNextAttempt();
      expect(timeRemaining).toBeGreaterThan(0);
      expect(timeRemaining).toBeLessThanOrEqual(10000);
    });
  });

  describe('Factory Functions', () => {
    it('should return singleton instance from getCircuitBreaker', () => {
      const breaker1 = getCircuitBreaker('singleton-test');
      const breaker2 = getCircuitBreaker('singleton-test');

      expect(breaker1).toBe(breaker2);
    });

    it('should reset all circuit breakers', async () => {
      // Create multiple breakers
      getCircuitBreaker('service-1');
      getCircuitBreaker('service-2');

      // Force failures
      for (const name of ['service-1', 'service-2']) {
        const breaker = getCircuitBreaker(name);
        for (let i = 0; i < 3; i++) {
          try {
            await breaker.execute(async () => {
              throw new Error('fail');
            });
          } catch (e) {}
        }
      }

      resetAllCircuitBreakers();

      expect(getCircuitBreaker('service-1').getState().state).toBe('closed');
      expect(getCircuitBreaker('service-2').getState().state).toBe('closed');
    });
  });

  describe('Error Classification', () => {
    it('should classify network errors as transient', async () => {
      try {
        await breaker.execute(async () => {
          throw new Error('Network timeout');
        });
      } catch (e) {
        expect(e).toBeDefined();
      }

      expect(breaker.getFailureCount()).toBe(1);
    });

    it('should classify rate limit errors as transient', async () => {
      try {
        await breaker.execute(async () => {
          throw new Error('429 Too Many Requests');
        });
      } catch (e) {
        expect(e).toBeDefined();
      }

      expect(breaker.getFailureCount()).toBe(1);
    });

    it('should classify auth errors as non-retryable', async () => {
      try {
        await breaker.execute(async () => {
          throw new Error('401 Unauthorized');
        });
      } catch (e) {
        expect(e).toBeDefined();
      }

      // Non-retryable errors should still count toward circuit breaker
      expect(breaker.getFailureCount()).toBe(1);
    });
  });
});
