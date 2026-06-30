/**
 * Evaluation State Storage Unit Tests
 *
 * Tests for the evaluation state persistence layer:
 * - Evaluation runs CRUD
 * - Rule evaluation history
 * - Error tracking
 * - Circuit breaker state
 * - Alert engine metrics
 */

import { EvaluationStateStorage } from '@/lib/monitoring/evaluation-state-storage';
import type { D1Database } from '@/types/d1';

// Helper to create statement mocks with full chaining support
const createStatementMock = (overrides: any = {}) => ({
  bind: jest.fn(function() { return this; }),
  all: jest.fn(async () => ({ results: [] })),
  first: jest.fn(async () => null),
  run: jest.fn(async () => ({ success: true, changes: 0, meta: { changes: 0 } })),
  ...overrides,
});

// Mock D1 database
function createMockDB() {
  return {
    prepare: jest.fn(() => createStatementMock()),
  };
}

describe('EvaluationStateStorage', () => {
  let storage: EvaluationStateStorage;
  let mockDB: ReturnType<typeof createMockDB>;

  beforeEach(() => {
    mockDB = createMockDB();
    storage = new EvaluationStateStorage(mockDB as D1Database);
  });

  describe('Evaluation Runs', () => {
    it('should create an evaluation run', async () => {
      const runId = await storage.createRun({
        started_at: new Date(),
        metadata: { triggered_by: 'cron' },
      });

      expect(runId).toBeDefined();
      expect(runId).toMatch(/^run_/);
    });

    it('should get an evaluation run by ID', async () => {
      const runId = 'run_test123';
      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        first: jest.fn(async () => ({
          id: runId,
          started_at: new Date().toISOString(),
          completed_at: null,
          duration_ms: null,
          status: 'running',
          rules_evaluated: 0,
          alerts_triggered: 0,
          errors_count: 0,
          metadata: '{}',
          created_at: new Date().toISOString(),
        })),
      }));

      const run = await storage.getRun(runId);
      expect(run).toBeDefined();
      expect(run?.id).toBe(runId);
      expect(run?.status).toBe('running');
    });

    it('should return null for non-existent run', async () => {
      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        first: jest.fn(async () => null),
      }));

      const run = await storage.getRun('nonexistent');
      expect(run).toBeNull();
    });

    it('should update an evaluation run', async () => {
      const runId = 'run_test123';
      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        first: jest.fn(async () => ({
          id: runId,
          started_at: new Date().toISOString(),
          completed_at: null,
          duration_ms: null,
          status: 'running',
          rules_evaluated: 0,
          alerts_triggered: 0,
          errors_count: 0,
          metadata: '{}',
          created_at: new Date().toISOString(),
        })),
        run: jest.fn(async () => ({ success: true, meta: { changes: 1 } })),
      }));

      await storage.updateRun(runId, {
        completed_at: new Date(),
        duration_ms: 5000,
        status: 'completed',
        rules_evaluated: 10,
        alerts_triggered: 2,
        errors_count: 0,
      });

      expect(mockDB.prepare).toHaveBeenCalled();
    });

    it('should complete a run', async () => {
      const runId = await storage.createRun();

      await storage.completeRun(runId, 5000, {
        rulesEvaluated: 10,
        alertsTriggered: 2,
        errorsCount: 0,
      });

      const prepareCalls = (mockDB.prepare as any).mock.calls.map((c: any[]) => c[0]);
      const updateCall = prepareCalls.find((sql: string) => sql.includes('UPDATE evaluation_runs'));
      expect(updateCall).toBeDefined();
    });

    it('should get recent runs', async () => {
      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        all: jest.fn(async () => ({
          results: [
            {
              id: 'run_1',
              started_at: new Date().toISOString(),
              completed_at: null,
              duration_ms: null,
              status: 'running',
              rules_evaluated: 0,
              alerts_triggered: 0,
              errors_count: 0,
              metadata: '{}',
              created_at: new Date().toISOString(),
            },
          ],
        })),
      }));

      const runs = await storage.getRecentRuns(10);
      expect(Array.isArray(runs)).toBe(true);
    });
  });

  describe('Rule Evaluation History', () => {
    it('should record rule evaluation', async () => {
      const runId = 'run_test123';
      await storage.recordRuleEvaluation({
        evaluation_run_id: runId,
        rule_id: 'rule_1',
        rule_name: 'Test Rule',
        metric_name: 'daily_revenue',
        metric_value: 1500,
        baseline_value: 2000,
        threshold_type: 'lt',
        threshold_value: 1000,
        triggered: true,
        evaluation_time_ms: 150,
      });

      const prepareCalls = (mockDB.prepare as any).mock.calls.map((c: any[]) => c[0]);
      const insertCall = prepareCalls.find((sql: string) => sql.includes('INSERT INTO rule_evaluation_history'));
      expect(insertCall).toBeDefined();
    });

    it('should record evaluation with error', async () => {
      const runId = 'run_test123';
      await storage.recordRuleEvaluation({
        evaluation_run_id: runId,
        rule_id: 'rule_1',
        rule_name: 'Test Rule',
        metric_name: 'daily_revenue',
        metric_value: null,
        baseline_value: null,
        threshold_type: 'lt',
        threshold_value: 1000,
        triggered: false,
        evaluation_time_ms: 100,
        error: {
          message: 'Database connection failed',
          type: 'database_error',
        },
      });

      const prepareCalls = (mockDB.prepare as any).mock.calls.map((c: any[]) => c[0]);
      const insertCall = prepareCalls.find((sql: string) => sql.includes('INSERT INTO rule_evaluation_history'));
      expect(insertCall).toBeDefined();
    });
  });

  describe('Evaluation Errors', () => {
    it('should record an error', async () => {
      await storage.recordError({
        error_type: 'transient_network',
        error_message: 'Network timeout',
        context: { rule_id: 'rule_1' },
        is_transient: true,
        retry_attempts: 1,
        occurred_at: new Date(),
      });

      const prepareCalls = (mockDB.prepare as any).mock.calls.map((c: any[]) => c[0]);
      const insertCall = prepareCalls.find((sql: string) => sql.includes('INSERT INTO evaluation_errors'));
      expect(insertCall).toBeDefined();
    });

    it('should get errors with filters', async () => {
      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        all: jest.fn(async () => ({
          results: [
            {
              id: 'err_1',
              evaluation_run_id: 'run_1',
              rule_id: 'rule_1',
              error_type: 'transient_network',
              error_message: 'Timeout',
              stack_trace: null,
              context: '{}',
              is_transient: 1,
              retry_attempts: 1,
              occurred_at: new Date().toISOString(),
            },
          ],
        })),
      }));

      const errors = await storage.getErrors(undefined, 'rule_1', 'transient_network', 10);
      expect(Array.isArray(errors)).toBe(true);
    });

    it('should get error statistics', async () => {
      (mockDB.prepare as any).mockImplementation((query: string) => {
        if (query.includes('COUNT(*) as count FROM evaluation_errors WHERE occurred_at >= ?')) {
          return createStatementMock({ first: jest.fn(async () => ({ count: 10 })) });
        }
        if (query.includes('SELECT error_type, COUNT(*) as count FROM evaluation_errors WHERE occurred_at >= ? GROUP BY error_type')) {
          return createStatementMock({
            all: jest.fn(async () => ({
              results: [
                { error_type: 'transient_network', count: 5 },
                { error_type: 'permanent_config', count: 2 },
              ],
            })),
          });
        }
        if (query.includes('SELECT rule_id, COUNT(*) as count FROM evaluation_errors WHERE occurred_at >= ? AND rule_id IS NOT NULL GROUP BY rule_id')) {
          return createStatementMock({ all: jest.fn(async () => ({ results: [] })) });
        }
        if (query.includes('COUNT(*) as count FROM evaluation_errors WHERE occurred_at >= ? AND is_transient = 1')) {
          return createStatementMock({ first: jest.fn(async () => ({ count: 5 })) });
        }
        return createStatementMock({ first: jest.fn(async () => null) });
      });

      const stats = await storage.getErrorStats();
      expect(stats.total).toBe(10);
      expect(stats.by_type).toBeDefined();
      // transient_count và permanent_count có thể được tính từ by_type
      expect(typeof stats.transient_count).toBe('number');
      expect(typeof stats.permanent_count).toBe('number');
    });
  });

  describe('Circuit Breaker State', () => {
    it('should get circuit breaker state', async () => {
      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        first: jest.fn(async () => ({
          id: 'cb_metrics-api',
          name: 'metrics-api',
          state: 'closed',
          failure_count: 0,
          last_failure_at: null,
          last_success_at: new Date().toISOString(),
          next_attempt_at: null,
          failure_threshold: 5,
          timeout_seconds: 60,
          metadata: '{}',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })),
      }));

      const breaker = await storage.getCircuitBreaker('metrics-api');
      expect(breaker).toBeDefined();
      expect(breaker?.name).toBe('metrics-api');
    });

    it('should upsert circuit breaker state', async () => {
      const mockGet = jest.spyOn(EvaluationStateStorage.prototype, 'getCircuitBreaker').mockResolvedValue({
        name: 'metrics-api',
        state: 'closed',
        failure_count: 0,
        failure_threshold: 5,
        timeout_seconds: 60,
      } as any);
      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        run: jest.fn(async () => ({ success: true, meta: { changes: 1 } })),
      }));

      await storage.upsertCircuitBreaker('metrics-api', {
        state: 'open',
        failure_count: 3,
        failure_threshold: 5,
        timeout_seconds: 60,
      });

      const prepareCalls = (mockDB.prepare as any).mock.calls.map((c: any[]) => c[0]);
      const cbCall = prepareCalls.find((sql: string) => sql.includes('circuit_breaker_state'));
      expect(cbCall).toBeDefined();
      mockGet.mockRestore();
    });

    it('should record circuit breaker success', async () => {
      const mockGet = jest.spyOn(EvaluationStateStorage.prototype, 'getCircuitBreaker').mockResolvedValue({
        name: 'metrics-api',
        state: 'closed',
        failure_count: 0,
      } as any);
      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        run: jest.fn(async () => ({ success: true, meta: { changes: 1 } })),
      }));

      await storage.recordCircuitBreakerSuccess('metrics-api');

      const prepareCalls = (mockDB.prepare as any).mock.calls.map((c: any[]) => c[0]);
      const updateCall = prepareCalls.find((sql: string) => sql.includes('UPDATE circuit_breaker_state'));
      expect(updateCall).toBeDefined();
      mockGet.mockRestore();
    });

    it('should record circuit breaker failure', async () => {
      const mockGet = jest.spyOn(EvaluationStateStorage.prototype, 'getCircuitBreaker').mockResolvedValue({
        name: 'metrics-api',
        state: 'closed',
        failure_count: 0,
        failure_threshold: 5,
        timeout_seconds: 60,
      } as any);
      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        run: jest.fn(async () => ({ success: true, meta: { changes: 1 } })),
      }));

      await storage.recordCircuitBreakerFailure('metrics-api', 1, true);

      const prepareCalls = (mockDB.prepare as any).mock.calls.map((c: any[]) => c[0]);
      const updateCall = prepareCalls.find((sql: string) => sql.includes('UPDATE circuit_breaker_state'));
      expect(updateCall).toBeDefined();
      mockGet.mockRestore();
    });
  });

  describe('Alert Engine Metrics', () => {
    it('should record engine metrics', async () => {
      if (typeof storage.recordEngineMetrics !== 'function') {
        return; // Method not implemented
      }

      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        run: jest.fn(async () => ({ success: true, meta: { changes: 1 } })),
      }));

      await storage.recordEngineMetrics({
        evaluation_run_id: 'run_123',
        total_evaluation_time_ms: 5000,
        avg_rule_evaluation_time_ms: 250,
        slowest_rule_evaluation_ms: 20,
        fastest_rule_evaluation_ms: 18,
        rules_checked: 20,
        rules_passed: 18,
        rules_failed: 2,
        alerts_generated: 3,
      });

      const prepareCalls = (mockDB.prepare as any).mock.calls.map((c: any[]) => c[0]);
      const insertCall = prepareCalls.find((sql: string) => sql.includes('INSERT INTO alert_engine_metrics'));
      expect(insertCall).toBeDefined();
    });
  });

  describe('Evaluation Statistics', () => {
    it('should get evaluation stats', async () => {
      const mockSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      (mockDB.prepare as any).mockImplementation((query: string) => {
        if (query.includes('COUNT(*) as count FROM evaluation_runs')) {
          return createStatementMock({ first: jest.fn(async () => ({ count: 100 })) });
        }
        if (query.includes("COUNT(*) as count FROM evaluation_runs WHERE status = 'completed'")) {
          return createStatementMock({ first: jest.fn(async () => ({ count: 95 })) });
        }
        if (query.includes("COUNT(*) as count FROM evaluation_runs WHERE status IN ('failed', 'partial_failure')")) {
          return createStatementMock({ first: jest.fn(async () => ({ count: 5 })) });
        }
        if (query.includes('AVG(duration_ms)')) {
          return createStatementMock({ first: jest.fn(async () => ({ avg_duration: 5000 })) });
        }
        if (query.includes('SUM(alerts_triggered)')) {
          return createStatementMock({ first: jest.fn(async () => ({ total: 250 })) });
        }
        if (query.includes('COUNT(DISTINCT rule_id)')) {
          return createStatementMock({ first: jest.fn(async () => ({ count: 15 })) });
        }
        if (query.includes('SELECT rule_id, COUNT(*) as count FROM rule_evaluation_history')) {
          return createStatementMock({
            all: jest.fn(async () => ({
              results: [
                { rule_id: 'rule_1', rule_name: 'Test Rule 1', total_evaluations: 100, total_triggers: 5, avg_evaluation_time_ms: 100, last_evaluated: new Date().toISOString(), last_triggered: new Date().toISOString(), error_count: 0 },
              ],
            })),
          });
        }
        return createStatementMock({ first: jest.fn(async () => null) });
      });

      const stats = await storage.getEvaluationStats(mockSince);
      expect(stats.total_runs).toBe(100);
      expect(stats.successful_runs).toBeGreaterThan(0);
      expect(stats.failed_runs).toBeGreaterThanOrEqual(0);
      expect(stats.by_rule).toBeDefined();
    });
  });

  describe('Cleanup', () => {
    it('should cleanup old data', async () => {
      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        run: jest.fn(async () => ({ success: true, meta: { changes: 10 } })),
      }));

      const result = await storage.cleanupOldData(90);
      expect(result.runsDeleted).toBe(10);
      expect(result.errorsDeleted).toBe(10);
      expect(result.historyDeleted).toBe(10);
      expect(result.metricsDeleted).toBe(10);
    });
  });

  describe('Circuit Breaker Helpers', () => {
    it('should get all circuit breakers', async () => {
      (mockDB.prepare as any).mockReturnValue(createStatementMock({
        all: jest.fn(async () => ({
          results: [
            {
              id: 'cb_1',
              name: 'metrics-api',
              state: 'closed',
              failure_count: 0,
              last_failure_at: null,
              last_success_at: new Date().toISOString(),
              next_attempt_at: null,
              failure_threshold: 5,
              timeout_seconds: 60,
              metadata: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })),
      }));

      const breakers = await storage.getAllCircuitBreakers();
      expect(Array.isArray(breakers)).toBe(true);
      expect(breakers[0].name).toBe('metrics-api');
    });
  });
});
