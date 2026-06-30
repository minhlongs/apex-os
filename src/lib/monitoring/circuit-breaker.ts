/**
 * Circuit Breaker Implementation
 *
 * Protects the alert engine from cascading failures when external services
 * are experiencing issues. Implements the circuit breaker pattern with
 * three states: closed (normal), open (failing), and half_open (testing).
 *
 * Based on Michael Nygard's "Release It!" pattern.
 */

import type { CircuitBreakerEntry, CircuitBreakerOptions, CircuitBreakerState } from '@/types/evaluation-state';
import { getEvaluationStateStorage } from './evaluation-state-storage';
import type { D1Database } from '@/types/d1';

export class CircuitBreaker {
  private name: string;
  private state: CircuitBreakerState;
  private failureCount: number;
  private lastFailureAt: Date | null;
  private lastSuccessAt: Date | null;
  private nextAttemptAt: Date | null;
  private failureThreshold: number;
  private timeoutMs: number;
  private halfOpenMaxCalls: number;
  private halfOpenCallCount: number = 0;
  private onStateChange?: (name: string, oldState: CircuitBreakerState, newState: CircuitBreakerState) => void;
  private db: D1Database | null = null;
  private storage: ReturnType<typeof getEvaluationStateStorage> | null = null;

  constructor(
    name: string,
    options: CircuitBreakerOptions = {},
    db?: D1Database
  ) {
    this.name = name;
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.nextAttemptAt = null;
    this.failureThreshold = options.failureThreshold || 5;
    this.timeoutMs = (options.timeoutSeconds || 60) * 1000;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls || 3;
    this.onStateChange = options.onStateChange;

    if (db) {
      this.initialize(db);
    }
  }

  /**
   * Initialize with database for state persistence
   */
  async initialize(db: D1Database): Promise<void> {
    this.db = db;
    this.storage = getEvaluationStateStorage(db);

    // Load persisted state
    const persisted = await this.storage.getCircuitBreaker(this.name);
    if (persisted) {
      this.state = persisted.state;
      this.failureCount = persisted.failure_count;
      this.lastFailureAt = persisted.last_failure_at ? new Date(persisted.last_failure_at) : null;
      this.lastSuccessAt = persisted.last_success_at ? new Date(persisted.last_success_at) : null;
      this.nextAttemptAt = persisted.next_attempt_at ? new Date(persisted.next_attempt_at) : null;

      // Check if open state timeout has elapsed
      if (this.state === 'open' && this.nextAttemptAt && Date.now() >= this.nextAttemptAt.getTime()) {
        this.transitionTo('half_open');
        this.halfOpenCallCount = 0;
      }
    }
  }

  /**
   * Check if the circuit breaker allows the operation to proceed
   */
  async isAvailable(): Promise<boolean> {
    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      // Check if timeout has elapsed
      if (this.nextAttemptAt && Date.now() >= this.nextAttemptAt.getTime()) {
        this.transitionTo('half_open');
        this.halfOpenCallCount = 0;
        return true;
      }
      return false;
    }

    // half_open: allow limited calls
    return this.halfOpenCallCount < this.halfOpenMaxCalls;
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const available = await this.isAvailable();
    if (!available) {
      throw new Error(`Circuit breaker '${this.name}' is OPEN - operation blocked`);
    }

    this.halfOpenCallCount++;

    try {
      const result = await fn();
      await this.recordSuccess();
      // After successful call in half_open, if we've used max attempts, close the circuit
      if (this.state === 'half_open' && this.halfOpenCallCount >= this.halfOpenMaxCalls) {
        this.transitionTo('closed');
        this.halfOpenCallCount = 0;
      }
      return result;
    } catch (error) {
      await this.recordFailure();
      throw error;
    }
  }

  /**
   * Force reset the circuit breaker to closed state
   */
  async reset(): Promise<void> {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.nextAttemptAt = null;
    this.halfOpenCallCount = 0;

    if (this.storage) {
      await this.storage.resetCircuitBreaker(this.name);
    }
  }

  /**
   * Get current state information
   */
  getState(): CircuitBreakerEntry {
    return {
      id: `cb_${this.name}`, // Generated ID for compatibility
      name: this.name,
      state: this.state,
      failure_count: this.failureCount,
      last_failure_at: this.lastFailureAt?.toISOString() || null,
      last_success_at: this.lastSuccessAt?.toISOString() || null,
      next_attempt_at: this.nextAttemptAt?.toISOString() || null,
      failure_threshold: this.failureThreshold,
      timeout_seconds: Math.round(this.timeoutMs / 1000),
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Record a successful operation
   */
  public async recordSuccess(): Promise<void> {
    this.lastSuccessAt = new Date();

    if (this.state === 'half_open') {
      // Reset failure count but don't transition to closed automatically
      this.failureCount = 0;
      // Note: Transition to closed is handled in execute() after checking max calls
    } else if (this.state === 'closed') {
      this.failureCount = 0;
    }

    if (this.storage) {
      await this.storage.recordCircuitBreakerSuccess(this.name);
    }
  }

  /**
   * Record a failed operation
   */
  public async recordFailure(): Promise<void> {
    this.lastFailureAt = new Date();
    this.failureCount++;

    if (this.state === 'half_open') {
      // Any failure in half_open goes back to open
      this.transitionTo('open');
      this.halfOpenCallCount = 0;
    } else if (this.state === 'closed' && this.failureCount >= this.failureThreshold) {
      this.transitionTo('open');
    }

    if (this.storage) {
      const shouldOpen = this.state === 'open';
      await this.storage.recordCircuitBreakerFailure(this.name, 1, shouldOpen);
    }
  }

  /**
   * Transition to a new state with notification
   */
  private transitionTo(newState: CircuitBreakerState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === 'open') {
      this.nextAttemptAt = new Date(Date.now() + this.timeoutMs);
      this.halfOpenCallCount = 0;
    }

    if (this.onStateChange) {
      this.onStateChange(this.name, oldState, newState);
    }

    console.log(`[CircuitBreaker] ${this.name}: ${oldState} -> ${newState}`);
  }

  /**
   * Get failure count
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Get time until next allowed attempt (for open circuit)
   */
  getTimeUntilNextAttempt(): number | null {
    if (!this.nextAttemptAt) return null;
    return Math.max(0, this.nextAttemptAt.getTime() - Date.now());
  }
}

// ============================================================================
// Circuit Breaker Factory
// ============================================================================

const circuitBreakers: Map<string, CircuitBreaker> = new Map();

export function getCircuitBreaker(
  name: string,
  options: CircuitBreakerOptions = {},
  db?: D1Database
): CircuitBreaker {
  let breaker = circuitBreakers.get(name);

  if (!breaker) {
    breaker = new CircuitBreaker(name, options, db);
    circuitBreakers.set(name, breaker);
  } else if (db && !breaker['db']) {
    // Initialize with DB if not already set
    breaker.initialize(db);
  }

  return breaker;
}

export function resetCircuitBreaker(name: string): void {
  const breaker = circuitBreakers.get(name);
  if (breaker) {
    breaker.reset();
  }
}

export function resetAllCircuitBreakers(): void {
  for (const breaker of circuitBreakers.values()) {
    breaker.reset();
  }
}

export async function initializeAllCircuitBreakers(db: D1Database): Promise<void> {
  const defaultNames = ['metrics-api', 'd1-database', 'notification-email', 'notification-slack', 'notification-webhook'];
  for (const name of defaultNames) {
    const breaker = getCircuitBreaker(name, {}, db);
    await breaker.initialize(db);
  }
}

export function getAllCircuitBreakerStates(): Array<{
  name: string;
  state: CircuitBreakerState;
  failureCount: number;
  nextAttemptAt: Date | null;
}> {
  return Array.from(circuitBreakers.values()).map(breaker => ({
    name: breaker['name'],
    state: breaker['state'],
    failureCount: breaker['failureCount'],
    nextAttemptAt: breaker['nextAttemptAt'],
  }));
}
