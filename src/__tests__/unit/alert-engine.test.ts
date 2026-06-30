/**
 * Unit Tests: AlertEngine
 *
 * Tests core alert engine logic with mocked dependencies.
 */

import { AlertEngine } from '@/lib/monitoring/alert-engine';
import type { D1Database } from '@/types/d1';

// Helper to create a mock D1 statement chain
function createMockStatement() {
  const statement: any = {
    _boundParams: [] as any[],
    bind: jest.fn().mockImplementation((...params: any[]) => {
      statement._boundParams = params;
      return statement;
    }),
    run: jest.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    first: jest.fn().mockResolvedValue(null),
    all: jest.fn().mockResolvedValue({ results: [] }),
  };
  return statement;
}

function createMockDB(): jest.Mocked<D1Database> {
  return {
    prepare: jest.fn().mockImplementation(() => createMockStatement()),
  } as any;
}

describe('AlertEngine', () => {
  let engine: AlertEngine;
  let mockDB: jest.Mocked<D1Database>;

  beforeEach(() => {
    mockDB = createMockDB();
    engine = new AlertEngine();
    // Initialize engine with mock DB
    (engine as any).db = mockDB;
    (engine as any).alertStorage = { getById: jest.fn(), create: jest.fn() } as any;
    (engine as any).evaluationStorage = {
      createRun: jest.fn().mockResolvedValue('run_test'),
      completeRun: jest.fn(),
      recordRuleEvaluation: jest.fn(),
      recordError: jest.fn(),
      recordMetrics: jest.fn(),
      getEvaluationStats: jest.fn().mockResolvedValue({ total_runs: 100, successful_runs: 95, failed_runs: 5, by_rule: [] }),
      getRuleStats: jest.fn().mockResolvedValue([]),
      getRecentRuns: jest.fn().mockResolvedValue([]),
      getErrorStats: jest.fn().mockResolvedValue({ total: 0, by_type: {}, by_rule: {}, transient_count: 0, permanent_count: 0 }),
      getAllCircuitBreakers: jest.fn().mockResolvedValue([]),
      resetCircuitBreaker: jest.fn(),
      recordCircuitBreakerSuccess: jest.fn(),
      recordCircuitBreakerFailure: jest.fn(),
    } as any;
    // Set default rules
    (engine as any).rules = [
      {
        id: 'test-rule',
        name: 'Test Rule',
        source: 'business',
        metric: 'daily_revenue',
        thresholdType: 'drop_pct',
        thresholdValue: 50,
        evaluationWindowMinutes: 120,
        severity: 'critical',
        channels: ['email'],
        cooldownMinutes: 60,
        isEnabled: true,
      },
    ];
  });

  describe('evaluateThreshold', () => {
    it('should detect revenue drop percentage correctly', () => {
      const evalThresh = (engine as any).evaluateThreshold;
      // 66% drop from 300 to 100, threshold 50% -> true
      expect(evalThresh(100, 300, 'drop_pct', 50)).toBe(true);
      // 20% drop from 300 to 240, threshold 50% -> false
      expect(evalThresh(240, 300, 'drop_pct', 50)).toBe(false);
      // Edge: baseline 0 should return false
      expect(evalThresh(100, 0, 'drop_pct', 50)).toBe(false);
    });

    it('should handle revenue increase (negative drop)', () => {
      const evalThresh = (engine as any).evaluateThreshold;
      // Revenue increased: current 400, baseline 300 = -33% drop
      expect(evalThresh(400, 300, 'drop_pct', 50)).toBe(false);
    });

    it('should evaluate other threshold types', () => {
      const evalThresh = (engine as any).evaluateThreshold;
      expect(evalThresh(150, 0, 'gt', 100)).toBe(true);
      expect(evalThresh(100, 0, 'gte', 100)).toBe(true);
      expect(evalThresh(50, 0, 'lt', 100)).toBe(true);
      expect(evalThresh(100, 0, 'lte', 100)).toBe(true);
      expect(evalThresh(100, 0, 'eq', 100)).toBe(true);
      expect(evalThresh(101, 0, 'eq', 100)).toBe(false);
    });

    it('should handle fractional drop percentages', () => {
      const evalThresh = (engine as any).evaluateThreshold;
      // 25.5% drop from 200 to 149
      expect(evalThresh(149, 200, 'drop_pct', 25)).toBe(true);
      expect(evalThresh(149, 200, 'drop_pct', 30)).toBe(false);
    });
  });

  describe('checkCooldown', () => {
    it('should return true if an alert exists within cooldown window', async () => {
      // Mock the query to return an alert
      const mockStmt = createMockStatement();
      mockStmt.first.mockResolvedValue({ id: 'alert_123' });
      mockDB.prepare.mockReturnValue(mockStmt);

      const inCooldown = await (engine as any).checkCooldown((engine as any).rules[0]);
      expect(inCooldown).toBe(true);
    });

    it('should return false if no alert within cooldown window', async () => {
      const mockStmt = createMockStatement();
      mockStmt.first.mockResolvedValue(null);
      mockDB.prepare.mockReturnValue(mockStmt);

      const inCooldown = await (engine as any).checkCooldown((engine as any).rules[0]);
      expect(inCooldown).toBe(false);
    });
  });

  describe('runCycle', () => {
    it('should evaluate rules and trigger alerts when threshold breached', async () => {
      (engine as any).checkCooldown = jest.fn().mockResolvedValue(false);
      (engine as any).fetchMetricValue = jest.fn().mockResolvedValue({
        currentValue: 100,
        baselineValue: 300,
      });
      (engine as any).sendAlert = jest.fn().mockResolvedValue(undefined);

      const results = await engine.runCycle();

      expect(results.length).toBe(1);
      expect(results[0].ruleId).toBe('test-rule');
      // Status after sendAlert is set to 'sent'
      expect(results[0].status).toBe('sent');
    });

    it('should not trigger alert if in cooldown', async () => {
      (engine as any).checkCooldown = jest.fn().mockResolvedValue(true);
      (engine as any).fetchMetricValue = jest.fn(); // should not be called

      const results = await engine.runCycle();

      expect(results.length).toBe(0);
      expect((engine as any).fetchMetricValue).not.toHaveBeenCalled();
    });

    it('should not trigger alert if threshold not breached', async () => {
      (engine as any).checkCooldown = jest.fn().mockResolvedValue(false);
      (engine as any).fetchMetricValue = jest.fn().mockResolvedValue({
        currentValue: 300,
        baselineValue: 300,
      });
      (engine as any).sendAlert = jest.fn();

      const results = await engine.runCycle();

      expect(results.length).toBe(0);
      expect((engine as any).sendAlert).not.toHaveBeenCalled();
    });

    it('should stop after maxAlertsPerRun', async () => {
      // Override rules with 5 rules
      const manyRules = Array.from({ length: 5 }, (_, i) => ({
        id: `rule-${i}`,
        name: `Rule ${i}`,
        source: 'business' as const,
        metric: 'daily_revenue',
        thresholdType: 'drop_pct' as const,
        thresholdValue: 50,
        evaluationWindowMinutes: 120,
        severity: 'critical' as const,
        channels: ['email'] as any,
        cooldownMinutes: 60,
        isEnabled: true,
      }));
      (engine as any).rules = manyRules;
      // Update config to limit to 2
      (engine as any).config = { ...(engine as any).config, maxAlertsPerRun: 2 };
      (engine as any).checkCooldown = jest.fn().mockResolvedValue(false);
      (engine as any).fetchMetricValue = jest.fn().mockResolvedValue({
        currentValue: 100,
        baselineValue: 300,
      });
      (engine as any).sendAlert = jest.fn().mockResolvedValue(undefined);

      await engine.runCycle();

      // Should only process up to 2 rules
      expect((engine as any).fetchMetricValue).toHaveBeenCalledTimes(2);
    });
  });
});
