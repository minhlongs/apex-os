/**
 * Business Alert Engine Unit Tests
 *
 * Tests for business-alert-engine.ts covering:
 * - Alert configuration management
 * - Evaluation context building
 * - Alert evaluation logic
 * - Cooldown checking
 * - Metric calculations (moving average, trend)
 */

import { jest } from '@jest/globals';
const vi = jest;
import {
  evaluateBusinessAlerts,
  getEnabledAlertConfigs,
  getAllAlertConfigs,
  updateAlertConfig,
  resolveAlert,
  acknowledgeAlert,
  isInCooldown,
  calculateMovingAverage,
  calculateTrend,
  getActiveAlertsCount,
  getRecentAlerts,
  buildAlertEvaluationContext,
  evaluateAlert,
} from '@/lib/notifications/business-alert-engine';
import type { BusinessAlertConfig, AlertEvaluationContext, BusinessAlert } from '@/types/business-alerting';

// Mock D1 Database
// D1 prepared statements support both direct calls (.all/.first/.run) and chained calls (.bind(...).all/.run).
// All mock functions must be shared references so test setup on any access path configures the same mocks.
const createMockDB = () => {
  const allMock = vi.fn();
  const firstMock = vi.fn();
  const runMock = vi.fn();

  const bindResult = { all: allMock, first: firstMock, run: runMock };
  const bindFn = vi.fn(() => bindResult);

  const stmt = { bind: bindFn, all: allMock, first: firstMock, run: runMock };

  return {
    prepare: vi.fn(() => stmt),
    exec: vi.fn(),
    batch: vi.fn(),
    close: vi.fn(),
  };
};

// Mock config fixture
const createMockAlertConfig = (overrides: Partial<BusinessAlertConfig> = {}): BusinessAlertConfig => ({
  id: 'test-config-id',
  name: 'Test Alert',
  description: 'Test alert description',
  metric_type: 'revenue_drop',
  threshold_type: 'drop_pct',
  threshold_value: 50,
  evaluation_window_minutes: 120,
  severity: 'warning',
  alert_channels: ['email'],
  cooldown_minutes: 60,
  is_enabled: 1,
  comparison_period_days: 7,
  moving_average_days: 7,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('calculateMovingAverage', () => {
  it('should calculate correct average', () => {
    const data = [
      { revenue: 100 },
      { revenue: 200 },
      { revenue: 300 },
      { revenue: 400 },
    ];
    const avg = calculateMovingAverage(data, 'revenue');
    expect(avg).toBe(250);
  });

  it('should return 0 for empty array', () => {
    const avg = calculateMovingAverage([], 'revenue');
    expect(avg).toBe(0);
  });

  it('should handle zero values', () => {
    const data = [
      { revenue: 0 },
      { revenue: 0 },
      { revenue: 0 },
    ];
    const avg = calculateMovingAverage(data, 'revenue');
    expect(avg).toBe(0);
  });

  it('should handle missing metric key', () => {
    const data = [
      { value: 100 },
      { revenue: 200 },
    ];
    const avg = calculateMovingAverage(data, 'revenue');
    expect(avg).toBe(100); // Only second item has revenue
  });
});

describe('calculateTrend', () => {
  it('should detect upward trend', () => {
    const data = [
      { revenue: 100 },
      { revenue: 120 },
      { revenue: 150 },
      { revenue: 200 },
      { revenue: 250 },
    ];
    expect(calculateTrend(data, 'revenue')).toBe('up');
  });

  it('should detect downward trend', () => {
    const data = [
      { revenue: 250 },
      { revenue: 200 },
      { revenue: 150 },
      { revenue: 120 },
      { revenue: 100 },
    ];
    expect(calculateTrend(data, 'revenue')).toBe('down');
  });

  it('should detect stable trend', () => {
    const data = [
      { revenue: 100 },
      { revenue: 102 },
      { revenue: 98 },
      { revenue: 101 },
      { revenue: 99 },
    ];
    expect(calculateTrend(data, 'revenue')).toBe('stable');
  });

  it('should return stable for single element', () => {
    expect(calculateTrend([{ revenue: 100 }], 'revenue')).toBe('stable');
  });

  it('should return stable for two elements', () => {
    const data = [
      { revenue: 100 },
      { revenue: 110 },
    ];
    expect(calculateTrend(data, 'revenue')).toBe('stable'); // <5% change
  });
});

// ============================================================================
// Alert Config Management Tests
// ============================================================================

describe('getEnabledAlertConfigs', () => {
  it('should return only enabled configs', async () => {
    const mockDB = createMockDB();
    const mockConfigs = [
      { ...createMockAlertConfig(), alert_channels: '["email"]' },
    ];
    (mockDB.prepare().all as any).mockResolvedValue({ results: mockConfigs });

    const configs = await getEnabledAlertConfigs(mockDB);

    expect(configs).toHaveLength(1);
    expect(configs[0].is_enabled).toBe(1);
  });

  it('should parse alert_channels JSON', async () => {
    const mockDB = createMockDB();
    const mockConfigs = [
      { ...createMockAlertConfig(), alert_channels: '["email", "webhook", "slack"]' },
    ];
    (mockDB.prepare().all as any).mockResolvedValue({ results: mockConfigs });

    const configs = await getEnabledAlertConfigs(mockDB);

    expect(configs[0].alert_channels).toEqual(['email', 'webhook', 'slack']);
  });
});

describe('getAllAlertConfigs', () => {
  it('should return all configs ordered by created_at', async () => {
    const mockDB = createMockDB();
    const mockConfigs = [
      { ...createMockAlertConfig(), created_at: '2024-01-02T00:00:00Z', alert_channels: '[]' },
      { ...createMockAlertConfig(), id: 'older-config', created_at: '2024-01-01T00:00:00Z', alert_channels: '[]' },
    ];
    (mockDB.prepare().all as any).mockResolvedValue({ results: mockConfigs });

    const configs = await getAllAlertConfigs(mockDB);

    expect(configs).toHaveLength(2);
    expect(configs[0].created_at).toBe('2024-01-02T00:00:00Z'); // Newer first
  });
});

describe('updateAlertConfig', () => {
  it('should update allowed fields', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
    (mockDB.prepare().first as any).mockResolvedValue({
      ...createMockAlertConfig(),
      alert_channels: '["email"]',
    });

    const result = await updateAlertConfig(mockDB, 'config-id', {
      threshold_value: 75,
      severity: 'critical',
    });

    expect(result).not.toBeNull();
    expect(mockDB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE business_alert_configs SET threshold_value = ?, severity = ?')
    );
  });

  it('should not update disallowed fields', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
    (mockDB.prepare().first as any).mockResolvedValue({
      ...createMockAlertConfig(),
      alert_channels: '[]',
    });

    await updateAlertConfig(mockDB, 'config-id', {
      id: 'new-id',
      invalid_field: 'value',
    });

    expect(mockDB.prepare).toHaveBeenCalled();
  });

  it('should serialize alert_channels array', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
    (mockDB.prepare().first as any).mockResolvedValue({
      ...createMockAlertConfig(),
      alert_channels: '[]',
    });

    await updateAlertConfig(mockDB, 'config-id', {
      alert_channels: ['email', 'slack'],
    });

    expect(mockDB.prepare).toHaveBeenCalled();
  });

  it('should return null when no updates provided', async () => {
    const mockDB = createMockDB();

    const result = await updateAlertConfig(mockDB, 'config-id', {});

    expect(result).toBeNull();
  });

  it('should return null when updated config not found', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
    (mockDB.prepare().first as any).mockResolvedValue(null);

    const result = await updateAlertConfig(mockDB, 'config-id', { threshold_value: 100 });

    expect(result).toBeNull();
  });
});

// ============================================================================
// Alert State Management Tests
// ============================================================================

describe('resolveAlert', () => {
  it('should resolve active alert', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });

    const result = await resolveAlert(mockDB, 'alert-id', 'user-123');

    expect(result).toBe(true);
    expect(mockDB.prepare).toHaveBeenCalledWith(
      expect.stringContaining("status = 'resolved'")
    );
  });

  it('should return false when alert not found or not active', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 0 } });

    const result = await resolveAlert(mockDB, 'non-existent');

    expect(result).toBe(false);
  });
});

describe('acknowledgeAlert', () => {
  it('should acknowledge active alert', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });

    const result = await acknowledgeAlert(mockDB, 'alert-id', 'user-123');

    expect(result).toBe(true);
    expect(mockDB.prepare).toHaveBeenCalledWith(
      expect.stringContaining("status = 'acknowledged'")
    );
  });
});

describe('isInCooldown', () => {
  it('should detect cooldown when recent alert exists', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().first as any).mockResolvedValue({ count: 1 });

    const result = await isInCooldown(mockDB, 'config-id', 60);

    expect(result).toBe(true);
    expect(mockDB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('datetime')
    );
  });

  it('should not be in cooldown when no recent alerts', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().first as any).mockResolvedValue({ count: 0 });

    const result = await isInCooldown(mockDB, 'config-id', 60);

    expect(result).toBe(false);
  });

  it('should handle undefined result', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().first as any).mockResolvedValue(undefined);

    const result = await isInCooldown(mockDB, 'config-id', 60);

    expect(result).toBe(false);
  });
});

// ============================================================================
// Alert Evaluation Tests
// ============================================================================

describe('evaluateAlert', () => {
  const createContext = (overrides: Partial<AlertEvaluationContext> = {}): AlertEvaluationContext => ({
    evaluationTimestamp: '2024-01-15T10:00:00Z',
    evaluationWindowMinutes: 120,
    todayRevenue: 500,
    yesterdayRevenue: 1000,
    sevenDayAvgRevenue: 1000,
    revenueTrend: 'down',
    todayConversionRate: 1.5,
    last7DayAvgConversionRate: 2.5,
    clicksToday: 100,
    conversionsToday: 2,
    webhookFailureRate: 5,
    webhookTotalAttempts: 100,
    webhookFailedAttempts: 5,
    payoutFailureRate: 2,
    totalPayouts: 50,
    failedPayouts: 1,
    stellarBalance: 500,
    ...overrides,
  });

  describe('revenue_drop metric', () => {
    it('should trigger when drop exceeds threshold', () => {
      const config = createMockAlertConfig({
        metric_type: 'revenue_drop',
        threshold_type: 'drop_pct',
        threshold_value: 30,
      });
      const context = createContext({
        todayRevenue: 600,
        sevenDayAvgRevenue: 1000,
      });

      const result = evaluateAlert(config, context);

      expect(result).toBe(true);
    });

    it('should not trigger when drop below threshold', () => {
      const config = createMockAlertConfig({
        metric_type: 'revenue_drop',
        threshold_type: 'drop_pct',
        threshold_value: 50,
      });
      const context = createContext({
        todayRevenue: 600,
        sevenDayAvgRevenue: 1000,
      });

      const result = evaluateAlert(config, context);

      expect(result).toBe(false);
    });

    it('should not trigger when average is zero', () => {
      const config = createMockAlertConfig({ metric_type: 'revenue_drop' });
      const context = createContext({ sevenDayAvgRevenue: 0 });

      const result = evaluateAlert(config, context);

      expect(result).toBe(false);
    });
  });

  describe('conversion_rate metric', () => {
    it('should trigger when below threshold (lt)', () => {
      const config = createMockAlertConfig({
        metric_type: 'conversion_rate',
        threshold_type: 'lt',
        threshold_value: 2.0,
      });
      const context = createContext({ todayConversionRate: 1.5 });

      expect(evaluateAlert(config, context)).toBe(true);
    });

    it('should trigger when below or equal (lte)', () => {
      const config = createMockAlertConfig({
        metric_type: 'conversion_rate',
        threshold_type: 'lte',
        threshold_value: 2.0,
      });
      const context = createContext({ todayConversionRate: 2.0 });

      expect(evaluateAlert(config, context)).toBe(true);
    });
  });

  describe('webhook_failures metric', () => {
    it('should trigger when failure rate exceeds threshold', () => {
      const config = createMockAlertConfig({
        metric_type: 'webhook_failures',
        threshold_type: 'gt',
        threshold_value: 10,
      });
      const context = createContext({ webhookFailureRate: 15 });

      expect(evaluateAlert(config, context)).toBe(true);
    });
  });

  describe('payout_failures metric', () => {
    it('should trigger when failure rate exceeds threshold', () => {
      const config = createMockAlertConfig({
        metric_type: 'payout_failures',
        threshold_type: 'gte',
        threshold_value: 5,
      });
      const context = createContext({ payoutFailureRate: 5 });

      expect(evaluateAlert(config, context)).toBe(true);
    });
  });

  describe('stellar_balance metric', () => {
    it('should trigger when below threshold', () => {
      const config = createMockAlertConfig({
        metric_type: 'stellar_balance',
        threshold_type: 'lt',
        threshold_value: 100,
      });
      const context = createContext({ stellarBalance: 50 });

      expect(evaluateAlert(config, context)).toBe(true);
    });
  });

  describe('unknown metric type', () => {
    it('should return false for unknown metric', () => {
      const config = createMockAlertConfig({ metric_type: 'unknown' as any });
      const context = createContext();

      expect(evaluateAlert(config, context)).toBe(false);
    });
  });
});

// ============================================================================
// Count Queries Tests
// ============================================================================

describe('getActiveAlertsCount', () => {
  it('should return count of active alerts', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().first as any).mockResolvedValue({ count: 25 });

    const count = await getActiveAlertsCount(mockDB);

    expect(count).toBe(25);
  });

  it('should return 0 when no active alerts', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().first as any).mockResolvedValue({ count: 0 });

    const count = await getActiveAlertsCount(mockDB);

    expect(count).toBe(0);
  });

  it('should return 0 when result is undefined', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().first as any).mockResolvedValue(undefined);

    const count = await getActiveAlertsCount(mockDB);

    expect(count).toBe(0);
  });
});

describe('getRecentAlerts', () => {
  it('should return paginated alerts with metadata', async () => {
    const mockDB = createMockDB();
    const mockRows = [{
      id: 'alert-1',
      alert_config_id: 'config-1',
      triggered_at: '2024-01-15T10:00:00Z',
      current_value: 50,
      threshold_value: 100,
      details: JSON.stringify({ test: 'data' }),
      status: 'active',
      config_name: 'Test Config',
      severity: 'critical',
      metric_type: 'revenue_drop',
    }];
    (mockDB.prepare().all as any).mockResolvedValue({ results: mockRows });

    const alerts = await getRecentAlerts(mockDB, 10, 0);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe('alert-1');
    expect(alerts[0].config_id).toBe('config-1');
    expect(alerts[0].triggered_at).toBeInstanceOf(Date);
    expect(alerts[0].details).toEqual({ test: 'data' });
    expect(alerts[0].metadata.configName).toBe('Test Config');
  });

  it('should filter by status', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().all as any).mockResolvedValue({ results: [] });

    await getRecentAlerts(mockDB, 10, 0, 'active');

    expect(mockDB.prepare).toHaveBeenCalledWith(
      expect.stringContaining("WHERE h.status")
    );
  });

  it('should ignore "all" status filter', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().all as any).mockResolvedValue({ results: [] });

    await getRecentAlerts(mockDB, 10, 0, 'all');

    expect(mockDB.prepare).toHaveBeenCalledWith(
      expect.not.stringContaining('WHERE')
    );
  });

  it('should apply limit and offset', async () => {
    const mockDB = createMockDB();
    (mockDB.prepare().all as any).mockResolvedValue({ results: [] });

    await getRecentAlerts(mockDB, 20, 40);

    expect(mockDB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT ? OFFSET ?')
    );
  });
});
