/**
 * Alert Engine Unit Tests
 */

import { jest } from '@jest/globals';
const vi = jest;
import { AlertEngine } from '@/lib/monitoring/alert-engine';
import {
  DEFAULT_BUSINESS_ALERT_RULES,
  DEFAULT_D1_ALERT_RULES,
  ALL_DEFAULT_RULES,
} from '@/lib/monitoring/alert-engine';

// Mock database interface
const createMockDB = () => ({
  prepare: vi.fn(() => ({
    bind: vi.fn(() => ({
      first: vi.fn(),
      all: vi.fn(),
      run: vi.fn(),
    })),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  })),
});

describe('AlertEngine', () => {
  let engine: AlertEngine;
  let mockDB: ReturnType<typeof createMockDB>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDB = createMockDB();
    engine = new AlertEngine();
  });

  describe('Default Rules', () => {
    it('should have business alert rules', () => {
      expect(DEFAULT_BUSINESS_ALERT_RULES.length).toBeGreaterThan(0);

      const ruleIds = DEFAULT_BUSINESS_ALERT_RULES.map(r => r.id);
      expect(ruleIds).toContain('biz-revenue-drop-pct');
      expect(ruleIds).toContain('biz-revenue-low');
      expect(ruleIds).toContain('biz-conversion-rate-low');
      expect(ruleIds).toContain('biz-zero-conversions');
      expect(ruleIds).toContain('biz-high-commission-liability');
      expect(ruleIds).toContain('biz-low-stellar-balance');
    });

    it('should have D1 alert rules', () => {
      expect(DEFAULT_D1_ALERT_RULES.length).toBeGreaterThan(0);

      const ruleIds = DEFAULT_D1_ALERT_RULES.map(r => r.id);
      expect(ruleIds).toContain('d1-slow-query');
      expect(ruleIds).toContain('d1-storage-critical');
      expect(ruleIds).toContain('d1-excessive-slow-queries');
      expect(ruleIds).toContain('d1-high-rows-scanned');
    });

    it('should combine all default rules', () => {
      expect(ALL_DEFAULT_RULES).toHaveLength(13);
    });

    it('each default rule should have required fields', () => {
      for (const rule of ALL_DEFAULT_RULES) {
        expect(rule.id).toBeDefined();
        expect(rule.name).toBeDefined();
        expect(rule.source).toBeDefined();
        expect(['business', 'd1', 'custom']).toContain(rule.source);
        expect(rule.metric).toBeDefined();
        expect(['gt', 'gte', 'lt', 'lte', 'eq', 'drop_pct']).toContain(rule.thresholdType);
        expect(typeof rule.thresholdValue).toBe('number');
        expect(typeof rule.evaluationWindowMinutes).toBe('number');
        expect(['info', 'warning', 'critical']).toContain(rule.severity);
        expect(Array.isArray(rule.channels)).toBe(true);
        expect(typeof rule.cooldownMinutes).toBe('number');
        expect(typeof rule.isEnabled).toBe('boolean');
      }
    });

    it('business rules should have correct metric types', () => {
      const businessMetrics = DEFAULT_BUSINESS_ALERT_RULES.map(r => r.metric);
      expect(businessMetrics).toContain('daily_revenue');
      expect(businessMetrics).toContain('conversion_rate');
      expect(businessMetrics).toContain('total_conversions');
      expect(businessMetrics).toContain('pending_commission');
    });

    it('D1 rules should have correct metric types', () => {
      const d1Metrics = DEFAULT_D1_ALERT_RULES.map(r => r.metric);
      expect(d1Metrics).toContain('avg_query_duration_ms');
      expect(d1Metrics).toContain('storage_usage_percent');
      expect(d1Metrics).toContain('slow_query_count');
      expect(d1Metrics).toContain('avg_rows_scanned');
    });
  });

  describe('AlertEngine Configuration', () => {
    it('should create engine with default config', () => {
      const defaultEngine = new AlertEngine();
      expect(defaultEngine['config'].enabled).toBe(true);
      expect(defaultEngine['config'].evaluationIntervalMinutes).toBe(5);
      expect(defaultEngine['config'].maxAlertsPerRun).toBe(100);
      expect(defaultEngine['config'].persistAlerts).toBe(true);
    });

    it('should accept custom config', () => {
      const customEngine = new AlertEngine({
        enabled: false,
        evaluationIntervalMinutes: 10,
        maxAlertsPerRun: 50,
      });
      expect(customEngine['config'].enabled).toBe(false);
      expect(customEngine['config'].evaluationIntervalMinutes).toBe(10);
      expect(customEngine['config'].maxAlertsPerRun).toBe(50);
      expect(customEngine['config'].persistAlerts).toBe(true); // default
    });
  });

  describe('Threshold Evaluation', () => {
    // Access private method via engine instance for testing
    // Signature: evaluateThreshold(current, baseline, type, threshold)
    const evaluateThreshold = (engine: AlertEngine, current: number, baseline: number, type: string, threshold: number) => {
      return engine['evaluateThreshold'](current, baseline, type, threshold);
    };

    it('should evaluate greater than', () => {
      expect(evaluateThreshold(engine, 1500, 0, 'gt', 1000)).toBe(true);
      expect(evaluateThreshold(engine, 1000, 0, 'gt', 1000)).toBe(false);
      expect(evaluateThreshold(engine, 500, 0, 'gt', 1000)).toBe(false);
    });

    it('should evaluate greater than or equal', () => {
      expect(evaluateThreshold(engine, 1500, 0, 'gte', 1000)).toBe(true);
      expect(evaluateThreshold(engine, 1000, 0, 'gte', 1000)).toBe(true);
      expect(evaluateThreshold(engine, 500, 0, 'gte', 1000)).toBe(false);
    });

    it('should evaluate less than', () => {
      expect(evaluateThreshold(engine, 500, 0, 'lt', 1000)).toBe(true);
      expect(evaluateThreshold(engine, 1000, 0, 'lt', 1000)).toBe(false);
      expect(evaluateThreshold(engine, 1500, 0, 'lt', 1000)).toBe(false);
    });

    it('should evaluate less than or equal', () => {
      expect(evaluateThreshold(engine, 500, 0, 'lte', 1000)).toBe(true);
      expect(evaluateThreshold(engine, 1000, 0, 'lte', 1000)).toBe(true);
      expect(evaluateThreshold(engine, 1500, 0, 'lte', 1000)).toBe(false);
    });

    it('should evaluate equality with float tolerance', () => {
      expect(evaluateThreshold(engine, 2.0, 0, 'eq', 2.0)).toBe(true);
      expect(evaluateThreshold(engine, 2.00001, 0, 'eq', 2.0)).toBe(true);
      expect(evaluateThreshold(engine, 2.001, 0, 'eq', 2.0)).toBe(false);
    });

    it('should evaluate drop percentage correctly', () => {
      // 66% drop from 300 to 100, threshold 50% -> true
      expect(evaluateThreshold(engine, 100, 300, 'drop_pct', 50)).toBe(true);
      // 20% drop from 300 to 240, threshold 50% -> false
      expect(evaluateThreshold(engine, 240, 300, 'drop_pct', 50)).toBe(false);
      // Edge: baseline 0 should return false
      expect(evaluateThreshold(engine, 100, 0, 'drop_pct', 50)).toBe(false);
      // Revenue increase: current 400, baseline 300 = -33% drop
      expect(evaluateThreshold(engine, 400, 300, 'drop_pct', 50)).toBe(false);
      // Fractional drop: 25.5% drop from 200 to 149, threshold 25%
      expect(evaluateThreshold(engine, 149, 200, 'drop_pct', 25)).toBe(true);
      expect(evaluateThreshold(engine, 149, 200, 'drop_pct', 30)).toBe(false);
    });
  });

  describe('Metric Formatting', () => {
    // Access private method via engine instance
    const formatMetricValue = (engine: AlertEngine, metric: string, value: number) => {
      return engine['formatMetricValue'](metric, value);
    };

    it('should format query duration in ms', () => {
      expect(formatMetricValue(engine, 'avg_query_duration_ms', 1500)).toBe('1,500 ms');
      expect(formatMetricValue(engine, 'avg_rows_scanned', 10000)).toBe('10,000 ms');
    });

    it('should format storage percentage', () => {
      expect(formatMetricValue(engine, 'storage_usage_percent', 75.5)).toBe('75.5%');
    });

    it('should format slow query count', () => {
      expect(formatMetricValue(engine, 'slow_query_count', 10)).toBe('10 queries');
    });

    it('should format conversion rate as percentage', () => {
      expect(formatMetricValue(engine, 'conversion_rate', 2.5)).toBe('2.50%');
    });

    it('should format currency values', () => {
      expect(formatMetricValue(engine, 'daily_revenue', 1234.56)).toBe('$1,234.56');
      expect(formatMetricValue(engine, 'pending_commission', 10000)).toBe('$10,000.00');
    });
  });

  describe('Severity Utilities', () => {
    // Access private method via engine instance
    const getSeverityEmoji = (engine: AlertEngine, severity: string) => {
      return engine['getSeverityEmoji'](severity as any);
    };

    const getSeverityColor = (engine: AlertEngine, severity: string) => {
      return engine['getSeverityColor'](severity as any);
    };

    it('should return correct emoji for severity', () => {
      expect(getSeverityEmoji(engine, 'critical')).toBe('🔴');
      expect(getSeverityEmoji(engine, 'warning')).toBe('🟡');
      expect(getSeverityEmoji(engine, 'info')).toBe('🟢');
      expect(getSeverityEmoji(engine, 'unknown')).toBe('⚪');
    });

    it('should return correct color for severity', () => {
      expect(getSeverityColor(engine, 'critical')).toBe('#dc2626');
      expect(getSeverityColor(engine, 'warning')).toBe('#f59e0b');
      expect(getSeverityColor(engine, 'info')).toBe('#10b981');
      expect(getSeverityColor(engine, 'unknown')).toBe('#6b7280');
    });
  });

  describe('Metric Type Mapping', () => {
    // Access private method
    const mapMetricToType = (engine: AlertEngine, metric: string) => {
      return engine['mapMetricToType'](metric);
    };

    it('should map business metrics correctly', () => {
      expect(mapMetricToType(engine, 'daily_revenue')).toBe('revenue_drop');
      expect(mapMetricToType(engine, 'conversion_rate')).toBe('conversion_rate_low');
      expect(mapMetricToType(engine, 'total_conversions')).toBe('zero_conversions');
      expect(mapMetricToType(engine, 'pending_commission')).toBe('high_commission_liability');
    });

    it('should map D1 metrics correctly', () => {
      expect(mapMetricToType(engine, 'avg_query_duration_ms')).toBe('slow_query');
      expect(mapMetricToType(engine, 'storage_usage_percent')).toBe('storage_critical');
      expect(mapMetricToType(engine, 'slow_query_count')).toBe('excessive_slow_queries');
      expect(mapMetricToType(engine, 'avg_rows_scanned')).toBe('high_rows_scanned');
    });

    it('should return custom for unknown metrics', () => {
      expect(mapMetricToType(engine, 'unknown_metric')).toBe('custom');
    });
  });
});

describe('Alert Engine Integration', () => {
  let engine: AlertEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new AlertEngine();
  });

  it('should not run if disabled', async () => {
    engine['config'].enabled = false;
    const results = await engine.runCycle();
    expect(results).toHaveLength(0);
  });

  it('should not exceed max alerts per run', async () => {
    engine['config'].maxAlertsPerRun = 2;
    engine['rules'] = ALL_DEFAULT_RULES.map(r => ({ ...r, isEnabled: true }));
    engine['db'] = createMockDB();
 engine['evaluationStorage'] = {
   createRun: vi.fn().mockResolvedValue('run-1'),
   recordRuleEvaluation: vi.fn(),
   completeRun: vi.fn(),
   recordError: vi.fn(),
   recordMetrics: vi.fn(),
 } as any;

    // Mock evaluation to always trigger
    vi.spyOn(engine, 'evaluateRule').mockResolvedValue({
      id: 'test',
      ruleId: 'test',
      ruleName: 'Test',
      severity: 'warning',
      metric: 'test',
      currentValue: 100,
      thresholdValue: 50,
      triggeredAt: new Date(),
      channels: ['email'],
      details: {},
      status: 'triggered',
    });

    const results = await engine.runCycle();
    expect(results.length).toBeLessThanOrEqual(2);
  });
});
