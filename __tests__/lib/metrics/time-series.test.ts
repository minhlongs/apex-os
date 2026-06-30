/**
 * Time-Series Metrics Utilities Tests
 */

import {
  truncateToInterval,
  formatDateForInterval,
  generateDateRange,
  formatDateKey,
  calculateSummary,
  validateTimeSeriesParams,
} from '@/lib/metrics/time-series';
import type { TimeSeriesQueryParams } from '@/types/metrics';

describe('Time-Series Utilities', () => {
  describe('truncateToInterval', () => {
    it('truncates to start of day for "day" interval', () => {
      const date = new Date('2026-06-15T14:30:45Z');
      const result = truncateToInterval(date, 'day');
      // Check that date is at midnight UTC using toISOString
      expect(result.toISOString()).toMatch(/^2026-06-15T00:00:00/);
    });

    it('truncates to start of hour for "hour" interval', () => {
      const date = new Date('2026-06-15T14:30:45Z');
      const result = truncateToInterval(date, 'hour');
      expect(result.toISOString()).toMatch(/^2026-06-15T14:00:00/);
    });

    it('truncates to start of week (Sunday) for "week" interval', () => {
      // Wednesday should go back to Sunday
      const date = new Date('2026-06-17T14:30:45Z'); // Wednesday in UTC
      const result = truncateToInterval(date, 'week');
      // Result should be a Sunday (June 14, 2026 is a Sunday)
      expect(result.getUTCDay()).toBe(0);
      expect(result.toISOString()).toMatch(/^2026-06-1[4-5]T00:00:00/);
    });

    it('truncates to first of month for "month" interval', () => {
      const date = new Date('2026-06-15T14:30:45Z');
      const result = truncateToInterval(date, 'month');
      expect(result.getUTCDate()).toBe(1);
      expect(result.toISOString()).toMatch(/^2026-06-01T00:00:00/);
    });
  });

  describe('formatDateForInterval', () => {
    it('formats as ISO date string for day interval', () => {
      const date = new Date('2026-06-15T14:30:45Z');
      const result = formatDateForInterval(date, 'day');
      expect(result).toBe('2026-06-15');
    });

    it('formats as ISO hour string for hour interval', () => {
      const date = new Date('2026-06-15T14:30:45Z');
      const result = formatDateForInterval(date, 'hour');
      expect(result).toBe('2026-06-15T14:00:00Z');
    });

    it('formats as year-week for week interval', () => {
      const date = new Date('2026-06-15T14:30:45Z'); // Week 24 of 2026
      const result = formatDateForInterval(date, 'week');
      expect(result).toMatch(/^2026-W\d{2}$/);
    });

    it('formats as year-month for month interval', () => {
      const date = new Date('2026-06-15T14:30:45Z');
      const result = formatDateForInterval(date, 'month');
      expect(result).toBe('2026-06');
    });
  });

  describe('generateDateRange', () => {
    it('generates daily dates for day interval', () => {
      const start = new Date('2026-06-01T00:00:00Z');
      const end = new Date('2026-06-05T00:00:00Z');
      const result = generateDateRange(start, end, 'day');
      expect(result.length).toBe(5);
      expect(result[0].toISOString().slice(0, 10)).toBe('2026-06-01');
      expect(result[4].toISOString().slice(0, 10)).toBe('2026-06-05');
    });

    it('generates hourly dates for hour interval', () => {
      const start = new Date('2026-06-01T00:00:00Z');
      const end = new Date('2026-06-01T05:00:00Z');
      const result = generateDateRange(start, end, 'hour');
      expect(result.length).toBe(6);
    });

    it('generates weekly dates for week interval', () => {
      const start = new Date('2026-06-01T00:00:00Z'); // Monday
      const end = new Date('2026-06-29T00:00:00Z'); // ~4 weeks
      const result = generateDateRange(start, end, 'week');
      expect(result.length).toBeGreaterThanOrEqual(4);
    });

    it('generates monthly dates for month interval', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const end = new Date('2026-06-01T00:00:00Z');
      const result = generateDateRange(start, end, 'month');
      expect(result.length).toBe(6);
    });
  });

  describe('formatDateKey', () => {
    it('formats day interval key correctly', () => {
      const result = formatDateKey('2026-06-15T14:30:45Z', 'day');
      expect(result).toBe('2026-06-15');
    });

    it('formats hour interval key correctly', () => {
      const result = formatDateKey('2026-06-15T14:30:45Z', 'hour');
      expect(result).toBe('2026-06-15T14:00:00');
    });
  });

  describe('calculateSummary', () => {
    it('calculates correct summary for non-empty array', () => {
      const values = [10, 20, 30, 40, 50];
      const result = calculateSummary(values);

      expect(result.total).toBe(150);
      expect(result.average).toBe(30);
      expect(result.min).toBe(10);
      expect(result.max).toBe(50);
    });

    it('returns zeros for empty array', () => {
      const result = calculateSummary([]);

      expect(result.total).toBe(0);
      expect(result.average).toBe(0);
      expect(result.min).toBe(0);
      expect(result.max).toBe(0);
      expect(result.trend).toBe('stable');
      expect(result.trendPercentage).toBe(0);
    });

    it('detects upward trend', () => {
      const values = [10, 10, 10, 20, 20, 20]; // Second half higher
      const result = calculateSummary(values);

      expect(result.trend).toBe('up');
      expect(result.trendPercentage).toBeGreaterThan(0);
    });

    it('detects downward trend', () => {
      const values = [20, 20, 20, 10, 10, 10]; // Second half lower
      const result = calculateSummary(values);

      expect(result.trend).toBe('down');
      expect(result.trendPercentage).toBeLessThan(0);
    });

    it('detects stable trend', () => {
      const values = [15, 15, 15, 15, 15, 15]; // Equal
      const result = calculateSummary(values);

      expect(result.trend).toBe('stable');
      expect(Math.abs(result.trendPercentage)).toBeLessThan(5);
    });
  });

  describe('validateTimeSeriesParams', () => {
    const validParams: TimeSeriesQueryParams = {
      start: '2026-06-01',
      end: '2026-06-30',
      interval: 'day',
    };

    it('accepts valid parameters', () => {
      const errors = validateTimeSeriesParams(validParams);
      expect(errors).toHaveLength(0);
    });

    it('rejects missing start date', () => {
      const params = { ...validParams, start: '' };
      const errors = validateTimeSeriesParams(params);
      expect(errors).toContain('start date is required');
    });

    it('rejects missing end date', () => {
      const params = { ...validParams, end: '' };
      const errors = validateTimeSeriesParams(params);
      expect(errors).toContain('end date is required');
    });

    it('rejects invalid start date', () => {
      const params = { ...validParams, start: 'invalid-date' };
      const errors = validateTimeSeriesParams(params);
      expect(errors).toContain('start date must be a valid ISO date');
    });

    it('rejects invalid interval', () => {
      const params = { ...validParams, interval: 'invalid' as any };
      const errors = validateTimeSeriesParams(params);
      expect(errors).toContain("interval must be one of: hour, day, week, month");
    });

    it('rejects invalid metric', () => {
      const params = { ...validParams, metric: 'invalid_metric' as any };
      const errors = validateTimeSeriesParams(params);
      expect(errors[0]).toContain('metric must be one of');
    });

    it('rejects start date after end date', () => {
      const params = { ...validParams, start: '2026-07-01', end: '2026-06-01' };
      const errors = validateTimeSeriesParams(params);
      expect(errors).toContain('start date must be before end date');
    });

    it('rejects date range exceeding 365 days', () => {
      const params: TimeSeriesQueryParams = {
        start: '2025-06-01',
        end: '2026-07-01', // More than 365 days
        interval: 'day',
      };
      const errors = validateTimeSeriesParams(params);
      expect(errors).toContain('date range cannot exceed 365 days');
    });

    it('accepts optional parameters when present', () => {
      const params: TimeSeriesQueryParams = {
        start: '2026-06-01',
        end: '2026-06-30',
        interval: 'day',
        metric: 'revenue',
        dealId: 'abc123',
        affiliateId: 'def456',
        status: 'approved',
      };
      const errors = validateTimeSeriesParams(params);
      expect(errors).toHaveLength(0);
    });
  });
});
