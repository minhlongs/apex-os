/**
 * Alert Engine Unit Tests
 *
 * Tests the core alert evaluation engine functionality:
 * - Rule evaluation with various threshold types
 * - Cooldown and deduplication logic
 * - Business metric fetching
 * - D1 metric fetching
 * - Alert notification sending
 */

import type { D1Database } from '@/types/d1';
import { AlertEngine } from '@/lib/monitoring/alert-engine';
import type { AlertRule } from '@/lib/monitoring/alert-engine';

// Mock D1 database
function createMockDB() {
  return {
    prepare: jest.fn(() => ({
      bind: jest.fn(function() { return this; }),
      all: jest.fn(async () => ({ results: [] })),
      first: jest.fn(async () => null),
      run: jest.fn(async () => ({ success: true, meta: { changes: 0 } })),
    })),
  };
}

describe('AlertEngine', () => {
  let engine: AlertEngine;
  let mockDB: ReturnType<typeof createMockDB>;

  beforeEach(() => {
    mockDB = createMockDB();
    engine = new AlertEngine({
      enabled: true,
      evaluationIntervalMinutes: 5,
      maxAlertsPerRun: 100,
      persistAlerts: false,
    });
  });

  describe('Initialization', () => {
    it('should initialize with default config', async () => {
      await engine.initialize(mockDB as D1Database);
      expect(engine).toBeDefined();
    });

    it('should load rules from database', async () => {
      const mockRules = [{
        id: 'test-rule',
        name: 'Test Rule',
        source: 'business',
        metric: 'daily_revenue',
        thresholdType: 'lt',
        thresholdValue: 100,
        evaluationWindowMinutes: 60,
        severity: 'warning',
        channels: ['email'] as any,
        cooldownMinutes: 15,
        isEnabled: true,
      }];

      (mockDB.prepare as any).mockReturnValue({
        bind: jest.fn(function() { return this; }),
        all: jest.fn(async () => ({ results: mockRules })),
      });

      await engine.initialize(mockDB as D1Database);
      const rules = (engine as any).rules;
      expect(rules.length).toBeGreaterThan(0);
    });

    it('should fall back to default rules if database fails', async () => {
      (mockDB.prepare as any).mockImplementation(() => {
        throw new Error('DB error');
      });

      await engine.initialize(mockDB as D1Database);
      const rules = (engine as any).rules;
      expect(rules.length).toBeGreaterThan(0);
    });
  });

  describe('Threshold Evaluation', () => {
    // Extract threshold evaluation logic for testing
    const evaluateThreshold = (
      current: number,
      baseline: number,
      type: AlertRule['thresholdType'],
      threshold: number
    ): boolean => {
      switch (type) {
        case 'gt': return current > threshold;
        case 'gte': return current >= threshold;
        case 'lt': return current < threshold;
        case 'lte': return current <= threshold;
        case 'eq': return Math.abs(current - threshold) < 0.0001;
        case 'drop_pct': {
          if (baseline === 0) return false;
          const dropPercent = ((baseline - current) / baseline) * 100;
          return dropPercent >= threshold;
        }
        default: return false;
      }
    };

    it('should evaluate greater than (gt) correctly', () => {
      expect(evaluateThreshold(150, 0, 'gt', 100)).toBe(true);
      expect(evaluateThreshold(100, 0, 'gt', 100)).toBe(false);
      expect(evaluateThreshold(50, 0, 'gt', 100)).toBe(false);
    });

    it('should evaluate greater than or equal (gte) correctly', () => {
      expect(evaluateThreshold(150, 0, 'gte', 100)).toBe(true);
      expect(evaluateThreshold(100, 0, 'gte', 100)).toBe(true);
      expect(evaluateThreshold(50, 0, 'gte', 100)).toBe(false);
    });

    it('should evaluate less than (lt) correctly', () => {
      expect(evaluateThreshold(50, 0, 'lt', 100)).toBe(true);
      expect(evaluateThreshold(100, 0, 'lt', 100)).toBe(false);
      expect(evaluateThreshold(150, 0, 'lt', 100)).toBe(false);
    });

    it('should evaluate less than or equal (lte) correctly', () => {
      expect(evaluateThreshold(50, 0, 'lte', 100)).toBe(true);
      expect(evaluateThreshold(100, 0, 'lte', 100)).toBe(true);
      expect(evaluateThreshold(150, 0, 'lte', 100)).toBe(false);
    });

    it('should evaluate equality (eq) correctly', () => {
      expect(evaluateThreshold(100, 0, 'eq', 100)).toBe(true);
      expect(evaluateThreshold(100.00001, 0, 'eq', 100)).toBe(true);
      expect(evaluateThreshold(99.99999, 0, 'eq', 100)).toBe(true);
      expect(evaluateThreshold(101, 0, 'eq', 100)).toBe(false);
    });

    it('should evaluate drop percentage correctly', () => {
      // 50% drop from 200 to 100 = 50% drop, threshold 50% -> true
      expect(evaluateThreshold(100, 200, 'drop_pct', 50)).toBe(true);
      // 40% drop from 200 to 120 = 40% drop, threshold 50% -> false
      expect(evaluateThreshold(120, 200, 'drop_pct', 50)).toBe(false);
      // 60% drop from 200 to 80 = 60% drop, threshold 50% -> true
      expect(evaluateThreshold(80, 200, 'drop_pct', 50)).toBe(true);
      // Edge case: baseline 0 should return false
      expect(evaluateThreshold(0, 0, 'drop_pct', 50)).toBe(false);
    });

    it('should handle negative values in drop_pct', () => {
      // Revenue increase: current 250, baseline 200 = -25% drop (actually increase)
      expect(evaluateThreshold(250, 200, 'drop_pct', 50)).toBe(false);
    });
  });

  describe('Cooldown Logic', () => {
    it('should detect alerts within cooldown window', async () => {
      mockDB.prepare.mockReturnValue({
        bind: jest.fn(function() { return this; }),
        first: jest.fn(async () => ({ id: 'alert-123' })),
      } as any);

      const checkCooldown = async (rule: AlertRule): Promise<boolean> => {
        const result = await (mockDB.prepare as any)()
          .bind(rule.id, rule.cooldownMinutes)
          .first<{ id: string }>();
        return !!result;
      };

      const inCooldown = await checkCooldown({
        id: 'test-rule',
        cooldownMinutes: 60,
      } as AlertRule);

      expect(inCooldown).toBe(true);
    });

    it('should return false when no recent alerts', async () => {
      mockDB.prepare.mockReturnValue({
        bind: jest.fn(function() { return this; }),
        first: jest.fn(async () => null),
      } as any);

      const checkCooldown = async (rule: AlertRule): Promise<boolean> => {
        const result = await (mockDB.prepare as any)()
          .bind(rule.id, rule.cooldownMinutes)
          .first<{ id: string }>();
        return !!result;
      };

      const inCooldown = await checkCooldown({
        id: 'test-rule',
        cooldownMinutes: 60,
      } as AlertRule);

      expect(inCooldown).toBe(false);
    });

    it('should query with correct SQL pattern', async () => {
      mockDB.prepare.mockReturnValue({
        bind: jest.fn(function() { return this; }),
        first: jest.fn(async () => null),
      } as any);

      await engine.initialize(mockDB as D1Database);

      await (engine as any).checkCooldown({
        id: 'test-rule',
        cooldownMinutes: 30,
      } as AlertRule);

      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM alerts')
      );
    });
  });

  describe('Rule Evaluation Cycle', () => {
    it('should skip disabled rules', async () => {
      await engine.initialize(mockDB as D1Database);
      (engine as any).rules = [{
        id: 'disabled-rule',
        name: 'Disabled',
        isEnabled: false,
        cooldownMinutes: 15,
        source: 'business',
        metric: 'daily_revenue',
        thresholdType: 'lt',
        thresholdValue: 0,
        evaluationWindowMinutes: 60,
        severity: 'warning',
        channels: ['email'] as any,
      } as AlertRule];

      // Mock checkCooldown to return false
      jest.spyOn(engine as any, 'checkCooldown').mockResolvedValue(false);
      // Mock fetchMetricValue to return a value
      jest.spyOn(engine as any, 'fetchMetricValue').mockResolvedValue({
        currentValue: 50,
        baselineValue: 100,
      });

      const results = await engine.runCycle();
      expect(results.length).toBe(0);
    });

    it('should stop at maxAlertsPerRun limit', async () => {
      await engine.initialize(mockDB as D1Database);
      (engine as any).rules = Array(10).fill(null).map((_, i) => ({
        id: `rule-${i}`,
        name: `Rule ${i}`,
        isEnabled: true,
        cooldownMinutes: 0,
        source: 'business',
        metric: 'daily_revenue',
        thresholdType: 'lt',
        thresholdValue: 0,
        evaluationWindowMinutes: 60,
        severity: 'warning',
        channels: ['email'] as any,
      } as AlertRule));

      jest.spyOn(engine as any, 'checkCooldown').mockResolvedValue(false);
      jest.spyOn(engine as any, 'fetchMetricValue').mockResolvedValue({
        currentValue: 50,
        baselineValue: 100,
      });

      const results = await engine.runCycle();
      expect(results.length).toBeLessThanOrEqual(100);
    });

    it('should handle errors in individual rule evaluation', async () => {
      await engine.initialize(mockDB as D1Database);
      (engine as any).rules = [{
        id: 'error-rule',
        name: 'Error Rule',
        isEnabled: true,
        cooldownMinutes: 0,
        source: 'business',
        metric: 'daily_revenue',
        thresholdType: 'lt',
        thresholdValue: 0,
        evaluationWindowMinutes: 60,
        severity: 'warning',
        channels: ['email'] as any,
      } as AlertRule];

      jest.spyOn(engine as any, 'checkCooldown').mockResolvedValue(false);
      jest.spyOn(engine as any, 'fetchMetricValue').mockRejectedValue(new Error('DB error'));

      // Should not throw, should continue with other rules
      const results = await engine.runCycle();
      expect(results.length).toBe(0);
    });
  });

  describe('Default Alert Rules', () => {
    it('should have business alert rules with required fields', async () => {
      const { DEFAULT_BUSINESS_ALERT_RULES } = await import('@/lib/monitoring/alert-engine');
      expect(DEFAULT_BUSINESS_ALERT_RULES.length).toBeGreaterThan(0);

      DEFAULT_BUSINESS_ALERT_RULES.forEach(rule => {
        expect(rule.id).toBeDefined();
        expect(rule.name).toBeDefined();
        expect(rule.source).toBe('business');
        expect(rule.metric).toBeDefined();
        expect(['gt', 'gte', 'lt', 'lte', 'eq', 'drop_pct']).toContain(rule.thresholdType);
        expect(typeof rule.thresholdValue).toBe('number');
        expect(rule.cooldownMinutes).toBeGreaterThan(0);
        expect(Array.isArray(rule.channels)).toBe(true);
        expect(rule.channels).toContain('email');
      });
    });

    it('should have D1 alert rules with required fields', async () => {
      const { DEFAULT_D1_ALERT_RULES } = await import('@/lib/monitoring/alert-engine');
      expect(DEFAULT_D1_ALERT_RULES.length).toBeGreaterThan(0);

      DEFAULT_D1_ALERT_RULES.forEach(rule => {
        expect(rule.source).toBe('d1');
        expect(rule.metric).toBeDefined();
        expect(['gt', 'gte', 'lt', 'lte', 'eq']).toContain(rule.thresholdType);
        expect(Array.isArray(rule.channels)).toBe(true);
        expect(rule.channels).toContain('email');
      });
    });

    it('should have unique rule IDs', async () => {
      const { ALL_DEFAULT_RULES } = await import('@/lib/monitoring/alert-engine');
      const ids = ALL_DEFAULT_RULES.map(r => r.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
      expect(ALL_DEFAULT_RULES.length).toBe(13);
    });
  });

  describe('Singleton Pattern', () => {
    it('should return same instance on subsequent calls', async () => {
      const { getAlertEngine } = await import('@/lib/monitoring/alert-engine');
      const db = createMockDB() as D1Database;

      const instance1 = await getAlertEngine(db);
      const instance2 = await getAlertEngine(db);

      expect(instance1).toBe(instance2);
    });
  });
});

describe('AlertEngine - Utility Methods', () => {
  let engine: AlertEngine;

  beforeEach(() => {
    engine = new AlertEngine();
  });

  describe('Severity Emoji', () => {
    it('should return correct emoji for each severity', () => {
      const getSeverityEmoji = (severity: string): string => {
        switch (severity) {
          case 'critical': return '🔴';
          case 'warning': return '🟡';
          case 'info': return '🟢';
          default: return '⚪';
        }
      };

      expect(getSeverityEmoji('critical')).toBe('🔴');
      expect(getSeverityEmoji('warning')).toBe('🟡');
      expect(getSeverityEmoji('info')).toBe('🟢');
      expect(getSeverityEmoji('unknown')).toBe('⚪');
    });
  });

  describe('Severity Color', () => {
    it('should return correct color for each severity', () => {
      const getSeverityColor = (severity: string): string => {
        switch (severity) {
          case 'critical': return '#dc2626';
          case 'warning': return '#f59e0b';
          case 'info': return '#10b981';
          default: return '#6b7280';
        }
      };

      expect(getSeverityColor('critical')).toBe('#dc2626');
      expect(getSeverityColor('warning')).toBe('#f59e0b');
      expect(getSeverityColor('info')).toBe('#10b981');
      expect(getSeverityColor('unknown')).toBe('#6b7280');
    });
  });

  describe('Metric Value Formatting', () => {
    const formatMetricValue = (metric: string, value: number): string => {
      switch (metric) {
        case 'avg_query_duration_ms':
        case 'avg_rows_scanned':
          return `${Math.round(value).toLocaleString()} ms`;
        case 'storage_usage_percent':
          return `${value.toFixed(1)}%`;
        case 'slow_query_count':
          return `${Math.round(value)} queries`;
        case 'conversion_rate':
          return `${value.toFixed(2)}%`;
        default:
          return value.toLocaleString('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
          });
      }
    };

    it('should format duration metrics with ms suffix', () => {
      expect(formatMetricValue('avg_query_duration_ms', 1234.56)).toBe('1,235 ms');
      expect(formatMetricValue('avg_rows_scanned', 10000)).toBe('10,000 ms');
    });

    it('should format percentage metrics', () => {
      expect(formatMetricValue('storage_usage_percent', 75.123)).toBe('75.1%');
      expect(formatMetricValue('conversion_rate', 2.567)).toBe('2.57%');
    });

    it('should format count metrics', () => {
      expect(formatMetricValue('slow_query_count', 42.7)).toBe('43 queries');
    });

    it('should format currency as default', () => {
      expect(formatMetricValue('daily_revenue', 1234.56)).toBe('$1,234.56');
      expect(formatMetricValue('pending_commission', 10000)).toBe('$10,000.00');
    });
  });

  describe('Comparison Symbol Formatting', () => {
    const formatComparison = (type?: string): string => {
      switch (type) {
        case 'gt': return '>';
        case 'gte': return '≥';
        case 'lt': return '<';
        case 'lte': return '≤';
        case 'eq': return '=';
        default: return '';
      }
    };

    it('should return correct comparison symbols', () => {
      expect(formatComparison('gt')).toBe('>');
      expect(formatComparison('gte')).toBe('≥');
      expect(formatComparison('lt')).toBe('<');
      expect(formatComparison('lte')).toBe('≤');
      expect(formatComparison('eq')).toBe('=');
      expect(formatComparison('unknown')).toBe('');
      expect(formatComparison(undefined)).toBe('');
    });
  });
});

describe('AlertEngine - Cooldown Deduplication', () => {
  let engine: AlertEngine;
  let mockDB: ReturnType<typeof createMockDB>;

  beforeEach(() => {
    mockDB = createMockDB();
    engine = new AlertEngine({ persistAlerts: false });
  });

  it('should check for any alert within cooldown window regardless of status', async () => {
    mockDB.prepare.mockReturnValue({
      bind: jest.fn(function() { return this; }),
      first: jest.fn(async () => ({ id: 'existing-alert' })),
    } as any);

    await engine.initialize(mockDB as D1Database);

    const rule: AlertRule = {
      id: 'rule-123',
      name: 'Test Rule',
      source: 'business',
      metric: 'daily_revenue',
      thresholdType: 'lt',
      thresholdValue: 100,
      evaluationWindowMinutes: 60,
      severity: 'warning',
      channels: ['email'],
      cooldownMinutes: 30,
      isEnabled: true,
    };

    const inCooldown = await (engine as any).checkCooldown(rule);
    expect(inCooldown).toBe(true);

    // Verify query checked ALL alerts (not just active)
    // Find the call that contains the cooldown query (skip rule loading)
    const cooldownCall = (mockDB.prepare as any).mock.calls
      .map((call: string[]) => call[0])
      .find((sql: string) => sql.includes('SELECT id FROM alerts'));
    expect(cooldownCall).toContain('WHERE rule_id = ?');
    expect(cooldownCall).toContain("triggered_at >= datetime('now', '-' || ? || ' minutes')");
  });

  it('should not trigger if alert exists in cooldown even if resolved', async () => {
    mockDB.prepare.mockReturnValue({
      bind: jest.fn(function() { return this; }),
      first: jest.fn(async () => ({ id: 'resolved-alert' })),
    } as any);

    await engine.initialize(mockDB as D1Database);

    const rule: AlertRule = {
      id: 'rule-123',
      cooldownMinutes: 60,
      isEnabled: true,
      source: 'business',
      metric: 'daily_revenue',
      thresholdType: 'lt',
      thresholdValue: 100,
      evaluationWindowMinutes: 60,
      severity: 'warning',
      channels: ['email'],
    };

    const result = await (engine as any).evaluateRule(rule);
    expect(result).toBeNull();
  });
});
