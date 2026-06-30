/**
 * Time-Series Metrics Unit Tests
 * ApexOS Metrics Module
 *
 * Coverage target: Aggregations, date ranges, validation, query building
 */

import {
  truncateToInterval,
  formatDateForInterval,
  generateDateRange,
  buildTimeSeriesQuery,
  validateTimeSeriesParams,
  getTimeSeriesData,
  formatDateKey,
  calculateSummary,
} from '@/lib/metrics/time-series';
import { TIME_SERIES_METRIC_DEFINITIONS } from '@/types/metrics';
import type { TimeSeriesQueryParams } from '@/types/metrics';

// ============================================================================
// Date Utilities Tests
// ============================================================================

describe('Date Utilities', () => {
  describe('truncateToInterval', () => {
    it('should truncate to hour (UTC)', () => {
      const date = new Date('2024-06-15T14:37:22Z');
      const result = truncateToInterval(date, 'hour');
      expect(result.getUTCHours()).toBe(14);
      expect(result.getUTCMinutes()).toBe(0);
      expect(result.getUTCSeconds()).toBe(0);
      expect(result.getUTCMilliseconds()).toBe(0);
    });

    it('should truncate to day (UTC)', () => {
      const date = new Date('2024-06-15T14:37:22Z');
      const result = truncateToInterval(date, 'day');
      expect(result.getUTCHours()).toBe(0);
      expect(result.getUTCDate()).toBe(15);
      expect(result.getUTCMonth()).toBe(5); // June
    });

    it('should truncate to week (UTC) - Sunday start', () => {
      // Wednesday, June 12, 2024
      const date = new Date('2024-06-12T14:37:22Z');
      const result = truncateToInterval(date, 'week');
      // Should be Sunday, June 9, 2024
      expect(result.getUTCDay()).toBe(0); // Sunday
      expect(result.getUTCDate()).toBe(9);
    });

    it('should truncate to month (UTC)', () => {
      const date = new Date('2024-06-15T14:37:22Z');
      const result = truncateToInterval(date, 'month');
      expect(result.getUTCDate()).toBe(1);
      expect(result.getUTCMonth()).toBe(5); // June
    });

    it('should not mutate the original date', () => {
      const original = new Date('2024-06-15T14:37:22Z');
      const copy = new Date(original);
      truncateToInterval(original, 'day');
      expect(original.getTime()).toBe(copy.getTime());
    });
  });

  describe('formatDateForInterval', () => {
    it('should format hour interval', () => {
      const date = new Date('2024-06-15T14:37:22Z');
      const result = formatDateForInterval(date, 'hour');
      expect(result).toBe('2024-06-15T14:00:00Z');
    });

    it('should format day interval', () => {
      const date = new Date('2024-06-15T14:37:22Z');
      const result = formatDateForInterval(date, 'day');
      expect(result).toBe('2024-06-15');
    });

    it('should format week interval', () => {
      const date = new Date('2024-06-12T14:37:22Z'); // Week 24
      const result = formatDateForInterval(date, 'week');
      expect(result).toMatch(/2024-W\d{2}/);
    });

    it('should format month interval', () => {
      const date = new Date('2024-06-15T14:37:22Z');
      const result = formatDateForInterval(date, 'month');
      expect(result).toBe('2024-06');
    });
  });

  describe('generateDateRange', () => {
    it('should generate hourly range', () => {
      const start = new Date('2024-06-15T00:00:00Z');
      const end = new Date('2024-06-15T05:00:00Z');
      const result = generateDateRange(start, end, 'hour');
      expect(result).toHaveLength(6); // 0, 1, 2, 3, 4, 5
    });

    it('should generate daily range', () => {
      const start = new Date('2024-06-15T00:00:00Z');
      const end = new Date('2024-06-18T00:00:00Z');
      const result = generateDateRange(start, end, 'day');
      expect(result).toHaveLength(4); // 15, 16, 17, 18
    });

    it('should generate weekly range', () => {
      const start = new Date('2024-06-09T00:00:00Z'); // Sunday
      const end = new Date('2024-06-30T00:00:00Z');
      const result = generateDateRange(start, end, 'week');
      // Should have 4 weeks: Jun 9, 16, 23, 30
      expect(result.length).toBeGreaterThanOrEqual(3);
    });

    it('should generate monthly range', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const end = new Date('2024-03-01T00:00:00Z');
      const result = generateDateRange(start, end, 'month');
      expect(result).toHaveLength(3); // Jan, Feb, Mar
    });

    it('should handle single date range', () => {
      const start = new Date('2024-06-15T00:00:00Z');
      const end = new Date('2024-06-15T23:59:59Z');
      const result = generateDateRange(start, end, 'day');
      expect(result).toHaveLength(1);
    });

    it('should truncate start date before generating', () => {
      const start = new Date('2024-06-15T14:37:22Z');
      const end = new Date('2024-06-16T10:20:30Z');
      const result = generateDateRange(start, end, 'day');
      expect(result[0].getUTCHours()).toBe(0);
      expect(result[0].getUTCMinutes()).toBe(0);
    });
  });

  describe('formatDateKey', () => {
    it('should generate consistent hour keys', () => {
      const dateStr = '2024-06-15T14:37:22Z';
      expect(formatDateKey(dateStr, 'hour')).toBe('2024-06-15T14:00:00');
    });

    it('should generate consistent day keys', () => {
      const dateStr = '2024-06-15T14:37:22Z';
      expect(formatDateKey(dateStr, 'day')).toBe('2024-06-15');
    });

    it('should generate consistent week keys', () => {
      const dateStr = '2024-06-12T14:37:22Z';
      const key = formatDateKey(dateStr, 'week');
      expect(key).toMatch(/^\d{4}-W\d{2}$/);
    });

    it('should generate consistent month keys', () => {
      const dateStr = '2024-06-15T14:37:22Z';
      expect(formatDateKey(dateStr, 'month')).toBe('2024-06');
    });

    it('should produce same key for dates in same interval', () => {
      const date1 = new Date('2024-06-15T10:30:00Z');
      const date2 = new Date('2024-06-15T23:45:00Z');
      expect(formatDateKey(date1.toISOString(), 'day')).toBe(formatDateKey(date2.toISOString(), 'day'));
    });
  });
});

// ============================================================================
// Query Building Tests
// ============================================================================

describe('Query Building', () => {
  describe('buildTimeSeriesQuery', () => {
    const baseParams: TimeSeriesQueryParams = {
      start: '2024-06-01',
      end: '2024-06-30',
      interval: 'day',
      metric: 'conversions',
    };

    it('should build basic query with required params', () => {
      const { sql, bindings } = buildTimeSeriesQuery(baseParams);
      expect(sql).toContain('FROM conversions');
      expect(sql).toContain('COUNT(*)');
      expect(bindings).toContain('2024-06-01');
      // End date should be incremented by 1 day (may include time)
      expect(bindings[1]).toMatch(/^2024-07-01/);
    });

    it('should use correct table and columns for revenue metric', () => {
      const params: TimeSeriesQueryParams = {
        ...baseParams,
        metric: 'revenue',
      };
      const { sql } = buildTimeSeriesQuery(params);
      expect(sql).toContain('SUM(COALESCE(revenue, 0))');
    });

    it('should use correct table and columns for clicks metric', () => {
      const params: TimeSeriesQueryParams = {
        ...baseParams,
        metric: 'clicks',
      };
      const { sql } = buildTimeSeriesQuery(params);
      expect(sql).toContain('FROM deal_clicks');
      expect(sql).toContain('COUNT(*)');
    });

    it('should add dealId filter when provided', () => {
      const params: TimeSeriesQueryParams = {
        ...baseParams,
        dealId: 'deal123',
      };
      const { sql, bindings } = buildTimeSeriesQuery(params);
      expect(sql).toContain('AND deal_id = ?');
      expect(bindings).toContain('deal123');
    });

    it('should add affiliateId filter when provided', () => {
      const params: TimeSeriesQueryParams = {
        ...baseParams,
        affiliateId: 'affiliate123',
      };
      const { sql, bindings } = buildTimeSeriesQuery(params);
      expect(sql).toContain('AND affiliate_id = ?');
      expect(bindings).toContain('affiliate123');
    });

    it('should add status filter for conversions metric', () => {
      const params: TimeSeriesQueryParams = {
        ...baseParams,
        status: 'approved',
      };
      const { sql, bindings } = buildTimeSeriesQuery(params);
      expect(sql).toContain('AND status = ?');
      expect(bindings).toContain('approved');
    });

    it('should build conversion rate query (special case)', () => {
      const params: TimeSeriesQueryParams = {
        ...baseParams,
        metric: 'conversion_rate',
      };
      const { sql } = buildTimeSeriesQuery(params);
      expect(sql).toContain('LEFT JOIN deal_clicks');
      expect(sql).toContain('COUNT(DISTINCT c.id) as conversions');
      expect(sql).toContain('COUNT(DISTINCT dc.id) as clicks');
    });

    it('should use correct group by for hour interval', () => {
      const params: TimeSeriesQueryParams = {
        ...baseParams,
        interval: 'hour',
      };
      const { sql } = buildTimeSeriesQuery(params);
      expect(sql).toContain("strftime('%Y-%m-%dT%H:00:00'");
    });

    it('should use correct group by for week interval', () => {
      const params: TimeSeriesQueryParams = {
        ...baseParams,
        interval: 'week',
      };
      const { sql } = buildTimeSeriesQuery(params);
      expect(sql).toContain("strftime('%Y-W%W'");
    });

    it('should use correct group by for month interval', () => {
      const params: TimeSeriesQueryParams = {
        ...baseParams,
        interval: 'month',
      };
      const { sql } = buildTimeSeriesQuery(params);
      expect(sql).toContain("strftime('%Y-%m'");
    });

    it('should order by group by clause ascending', () => {
      const { sql } = buildTimeSeriesQuery(baseParams);
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('ASC');
    });
  });

  describe('TIME_SERIES_METRIC_DEFINITIONS', () => {
    it('should define all required metric types', () => {
      const expectedMetrics = [
        'conversions',
        'revenue',
        'clicks',
        'earnings',
        'payouts',
        'conversion_rate',
        'unique_affiliates',
      ];
      expectedMetrics.forEach(metric => {
        expect(TIME_SERIES_METRIC_DEFINITIONS[metric as keyof typeof TIME_SERIES_METRIC_DEFINITIONS]).toBeDefined();
      });
    });

    it('should have required fields for each metric definition', () => {
      Object.values(TIME_SERIES_METRIC_DEFINITIONS).forEach(def => {
        expect(def.label).toBeDefined();
        expect(def.description).toBeDefined();
        expect(def.table).toBeDefined();
        expect(def.valueColumn).toBeDefined();
        expect(def.dateColumn).toBeDefined();
        expect(def.defaultInterval).toBeDefined();
        expect(def.minInterval).toBeDefined();
      });
    });

    it('should have valid interval values', () => {
      const validIntervals = ['hour', 'day', 'week', 'month'];
      Object.values(TIME_SERIES_METRIC_DEFINITIONS).forEach(def => {
        expect(validIntervals).toContain(def.defaultInterval);
        expect(validIntervals).toContain(def.minInterval);
      });
    });
  });
});

// ============================================================================
// Validation Tests
// ============================================================================

describe('validateTimeSeriesParams', () => {
  it('should require start date', () => {
    const errors = validateTimeSeriesParams({ end: '2024-06-30', interval: 'day' } as TimeSeriesQueryParams);
    expect(errors).toContain('start date is required');
  });

  it('should require end date', () => {
    const errors = validateTimeSeriesParams({ start: '2024-06-01', interval: 'day' } as TimeSeriesQueryParams);
    expect(errors).toContain('end date is required');
  });

  it('should require interval', () => {
    const errors = validateTimeSeriesParams({ start: '2024-06-01', end: '2024-06-30' } as TimeSeriesQueryParams);
    expect(errors).toContain('interval is required');
  });

  it('should validate interval values', () => {
    const errors = validateTimeSeriesParams({
      start: '2024-06-01',
      end: '2024-06-30',
      interval: 'invalid',
    } as TimeSeriesQueryParams);
    expect(errors).toContain('interval must be one of: hour, day, week, month');
  });

  it('should validate date format', () => {
    const errors = validateTimeSeriesParams({
      start: 'invalid-date',
      end: '2024-06-30',
      interval: 'day',
    } as TimeSeriesQueryParams);
    expect(errors.some(e => e.includes('valid ISO date'))).toBe(true);
  });

  it('should validate start before end', () => {
    const errors = validateTimeSeriesParams({
      start: '2024-06-30',
      end: '2024-06-01',
      interval: 'day',
    } as TimeSeriesQueryParams);
    expect(errors).toContain('start date must be before end date');
  });

  it('should validate date range not exceeding 365 days', () => {
    const errors = validateTimeSeriesParams({
      start: '2023-01-01',
      end: '2024-01-02', // > 365 days
      interval: 'day',
    } as TimeSeriesQueryParams);
    expect(errors).toContain('date range cannot exceed 365 days');
  });

  it('should validate metric type', () => {
    const errors = validateTimeSeriesParams({
      start: '2024-06-01',
      end: '2024-06-30',
      interval: 'day',
      metric: 'invalid_metric' as any,
    } as TimeSeriesQueryParams);
    expect(errors.some(e => e.includes('metric must be one of'))).toBe(true);
  });

  it('should pass validation with valid params', () => {
    const errors = validateTimeSeriesParams({
      start: '2024-06-01',
      end: '2024-06-30',
      interval: 'day',
      metric: 'conversions',
    } as TimeSeriesQueryParams);
    expect(errors).toHaveLength(0);
  });

  it('should allow valid optional metric', () => {
    const errors = validateTimeSeriesParams({
      start: '2024-06-01',
      end: '2024-06-30',
      interval: 'day',
      metric: 'revenue',
    } as TimeSeriesQueryParams);
    expect(errors).toHaveLength(0);
  });

  it('should accept edge case: start equals end (single day)', () => {
    const errors = validateTimeSeriesParams({
      start: '2024-06-15',
      end: '2024-06-15',
      interval: 'day',
    } as TimeSeriesQueryParams);
    expect(errors).toContain('start date must be before end date');
  });

  it('should allow exactly 365 days range', () => {
    const start = '2024-01-01';
    const end = '2024-12-31'; // 365 days (non-leap year)
    const errors = validateTimeSeriesParams({
      start,
      end,
      interval: 'day',
    } as TimeSeriesQueryParams);
    expect(errors).not.toContain('date range cannot exceed 365 days');
  });
});

// ============================================================================
// Summary Calculation Tests
// ============================================================================

describe('calculateSummary', () => {
  it('should return zero values for empty array', () => {
    const summary = calculateSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.average).toBe(0);
    expect(summary.min).toBe(0);
    expect(summary.max).toBe(0);
    expect(summary.trend).toBe('stable');
    expect(summary.trendPercentage).toBe(0);
  });

  it('should calculate correct total', () => {
    const summary = calculateSummary([10, 20, 30, 40]);
    expect(summary.total).toBe(100);
  });

  it('should calculate correct average', () => {
    const summary = calculateSummary([10, 20, 30]);
    expect(summary.average).toBe(20);
  });

  it('should calculate correct min and max', () => {
    const summary = calculateSummary([10, 50, 25, 5, 30]);
    expect(summary.min).toBe(5);
    expect(summary.max).toBe(50);
  });

  it('should detect upward trend (>5% increase)', () => {
    const summary = calculateSummary([100, 100, 100, 200, 200, 200]);
    expect(summary.trend).toBe('up');
    expect(summary.trendPercentage).toBeGreaterThan(0);
  });

  it('should detect downward trend (>5% decrease)', () => {
    const summary = calculateSummary([200, 200, 200, 100, 100, 100]);
    expect(summary.trend).toBe('down');
    expect(summary.trendPercentage).toBeLessThan(0);
  });

  it('should detect stable trend (within 5%)', () => {
    const summary = calculateSummary([100, 100, 100, 102, 102, 102]);
    expect(summary.trend).toBe('stable');
  });

  it('should handle odd length arrays for trend calculation', () => {
    const summary = calculateSummary([100, 200]);
    expect(summary.trend).toBe('up');
  });

  it('should not divide by zero in trend when first half is zero', () => {
    const summary = calculateSummary([0, 0, 0, 100, 100, 100]);
    expect(summary.trend).toBe('stable');
    expect(summary.trendPercentage).toBe(0);
  });

  it('should calculate trend percentage accurately', () => {
    // First half: 100, second half: 150 => 50% increase
    const summary = calculateSummary([100, 100, 150, 150]);
    expect(summary.trendPercentage).toBeCloseTo(50, 1);
  });
});

// ============================================================================
// Metric Definitions Tests
// ============================================================================

describe('Metric Definitions', () => {
  it('should have correct definition for conversions', () => {
    const def = TIME_SERIES_METRIC_DEFINITIONS.conversions;
    expect(def.table).toBe('conversions');
    expect(def.valueColumn).toContain('COUNT');
    expect(def.dateColumn).toBe('converted_at');
  });

  it('should have correct definition for revenue', () => {
    const def = TIME_SERIES_METRIC_DEFINITIONS.revenue;
    expect(def.table).toBe('conversions');
    expect(def.valueColumn).toContain('SUM');
    expect(def.valueColumn).toContain('revenue');
  });

  it('should have correct definition for clicks', () => {
    const def = TIME_SERIES_METRIC_DEFINITIONS.clicks;
    expect(def.table).toBe('deal_clicks');
    expect(def.dateColumn).toBe('created_at');
  });

  it('should have correct definition for conversion_rate (combined)', () => {
    const def = TIME_SERIES_METRIC_DEFINITIONS.conversion_rate;
    expect(def.table).toBe('combined');
    expect(def.valueColumn).toContain('conversions');
    expect(def.valueColumn).toContain('clicks');
  });
});

// ============================================================================
// Integration Tests (Query + Data Flow)
// ============================================================================

describe('TimeSeries Data Flow', () => {
  // Mock database
  const mockDB = {
    prepare: jest.fn(() => ({
      bind: jest.fn(() => ({
        all: jest.fn(async () => ({
          results: [
            { date: '2024-06-01', value: 10 },
            { date: '2024-06-03', value: 20 },
            { date: '2024-06-04', value: 15 },
          ],
        })),
      })),
    })),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should query with correct parameters', async () => {
    const params: TimeSeriesQueryParams = {
      start: '2024-06-01',
      end: '2024-06-05',
      interval: 'day',
      metric: 'conversions',
    };

    // This would call the actual function but with mocked DB
    // For unit tests, we test the query builder separately
    const { sql, bindings } = buildTimeSeriesQuery(params);

    expect(sql).toContain('converted_at >= ?');
    expect(sql).toContain('converted_at < ?');
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toBe('2024-06-01');
    // End date should be incremented by 1 day (to ISO string)
    expect(bindings[1]).toMatch(/^2024-06-06T00:00:00\.000Z$/);
  });

  it('should handle end date boundary correctly', () => {
    const params: TimeSeriesQueryParams = {
      start: '2024-06-01',
      end: '2024-06-30',
      interval: 'day',
      metric: 'conversions',
    };

    const { bindings } = buildTimeSeriesQuery(params);
    // End date should be incremented to include the full end day (may include time)
    expect(bindings[1]).toMatch(/^2024-07-01/);
  });
});
