/**
 * Business Metrics Utilities Unit Tests
 * ApexOS Metrics Module
 *
 * Tests for query parsing, summary building, and formatting utilities
 */

import {
  parseQueryParams,
  buildSummary,
  formatDateForQuery,
  isDateInRange,
  formatCurrency,
  formatPercentage,
  formatCompactNumber,
} from '@/lib/metrics/business-metrics';
import type { BusinessMetricsResponse } from '@/types/metrics';

// ============================================================================
// Query Parameter Parsing Tests
// ============================================================================

describe('parseQueryParams', () => {
  const baseUrl = 'http://localhost:3000/api/metrics/business';

  it('should parse minimal query (use defaults)', () => {
    const request = { url: baseUrl };
    const result = parseQueryParams(request);

    expect(result.start_date).toBeDefined();
    expect(result.end_date).toBeDefined();
    expect(result.group_by).toBe('daily');
    expect(result.deal_type).toBeUndefined();
    expect(result.exchange).toBeUndefined();
    expect(result.status).toBe('approved');
    expect(result.startDateObj).toBeInstanceOf(Date);
    expect(result.endDateObj).toBeInstanceOf(Date);
  });

  it('should parse all query parameters', () => {
    const request = {
      url: `${baseUrl}?start_date=2024-06-01&end_date=2024-06-15&group_by=weekly&deal_type=product&exchange=binance&status=pending`,
    };
    const result = parseQueryParams(request);

    expect(result.start_date).toBe('2024-06-01');
    expect(result.end_date).toBe('2024-06-15');
    expect(result.group_by).toBe('weekly');
    expect(result.deal_type).toBe('product');
    expect(result.exchange).toBe('binance');
    expect(result.status).toBe('pending');
  });

  it('should default group_by to daily', () => {
    const request = { url: `${baseUrl}?start_date=2024-06-01&end_date=2024-06-15` };
    const result = parseQueryParams(request);
    expect(result.group_by).toBe('daily');
  });

  it('should default status to approved', () => {
    const request = { url: `${baseUrl}?start_date=2024-06-01&end_date=2024-06-15` };
    const result = parseQueryParams(request);
    expect(result.status).toBe('approved');
  });

  it('should throw on invalid date format', () => {
    const request = { url: `${baseUrl}?start_date=invalid&end_date=2024-06-15` };
    expect(() => parseQueryParams(request)).toThrow('Invalid date format');
  });

  it('should throw when start_date is after end_date', () => {
    const request = { url: `${baseUrl}?start_date=2024-06-30&end_date=2024-06-01` };
    expect(() => parseQueryParams(request)).toThrow('start_date must be before end_date');
  });

  it('should calculate default dates correctly (last 30 days)', () => {
    const now = new Date();
    const request = { url: baseUrl };
    const result = parseQueryParams(request);

    const expectedStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(result.startDateObj.getTime()).toBeCloseTo(expectedStart.getTime(), -5); // Within 5 days (test tolerance)
  });

  it('should return Date objects for date calculations', () => {
    const request = { url: `${baseUrl}?start_date=2024-06-01&end_date=2024-06-15` };
    const result = parseQueryParams(request);

    expect(result.startDateObj.getUTCFullYear()).toBe(2024);
    expect(result.startDateObj.getUTCMonth()).toBe(5); // June (0-indexed)
    expect(result.startDateObj.getUTCDate()).toBe(1);

    expect(result.endDateObj.getUTCFullYear()).toBe(2024);
    expect(result.endDateObj.getUTCMonth()).toBe(5);
    expect(result.endDateObj.getUTCDate()).toBe(15);
  });
});

// ============================================================================
// Summary Building Tests
// ============================================================================

describe('buildSummary', () => {
  const baseParams = {
    start_date: '2024-06-01',
    end_date: '2024-06-15',
    group_by: 'daily' as const,
  };

  const emptyDailyRevenue: BusinessMetricsResponse['daily_revenue'] = [];
  const emptyAffiliates: BusinessMetricsResponse['active_affiliates'] = {
    total_affiliates: 0,
    affiliates_with_conversions: 0,
    new_affiliates: 0,
    avg_lifetime_earnings: 0,
    top_performers: [],
    distribution_by_level: { level_1: 0, level_2: 0, level_3: 0 },
  };
  const emptyTopDeals: BusinessMetricsResponse['top_deals'] = {
    period: { start_date: '2024-06-01', end_date: '2024-06-15' },
    limit: 10,
    deals: [],
    summary: { total_clicks: 0, total_conversions: 0, total_revenue: 0, avg_conversion_rate: 0 },
  };

  it('should handle empty data sets', () => {
    const summary = buildSummary(
      { ...baseParams, startDateObj: new Date(), endDateObj: new Date() },
      emptyDailyRevenue,
      emptyAffiliates,
      emptyTopDeals
    );

    expect(summary.total_revenue).toBe(0);
    expect(summary.total_conversions).toBe(0);
    expect(summary.overall_conversion_rate).toBe(0);
    expect(summary.active_affiliates_count).toBe(0);
    expect(summary.total_commission_liability).toBe(0);
    expect(summary.top_deal_name).toBe('N/A');
    expect(summary.top_affiliate_name).toBe('N/A');
  });

  it('should sum total revenue correctly', () => {
    const dailyRevenue = [
      { revenue: 1000, conversions: 10, commission_paid: 300, commission_rate_percent: 30 },
      { revenue: 2000, conversions: 20, commission_paid: 600, commission_rate_percent: 30 },
      { revenue: 1500, conversions: 15, commission_paid: 450, commission_rate_percent: 30 },
    ];

    const summary = buildSummary(
      { ...baseParams, startDateObj: new Date(), endDateObj: new Date() },
      dailyRevenue,
      emptyAffiliates,
      emptyTopDeals
    );

    expect(summary.total_revenue).toBe(4500);
    expect(summary.total_conversions).toBe(45);
    expect(summary.total_commission_liability).toBe(1350);
  });

  it('should identify top deal', () => {
    const dailyRevenue = [
      { revenue: 1000, conversions: 10, commission_paid: 300, commission_rate_percent: 30 },
    ];
    const topDeals: BusinessMetricsResponse['top_deals'] = {
      period: { start_date: '2024-06-01', end_date: '2024-06-15' },
      limit: 10,
      deals: [
        { name: 'Top Deal', conversion_rate: 15, total_revenue: 5000, total_commission: 1500, avg_commission_rate: 30, is_active: true, top_affiliate: undefined, id: '', total_clicks: 0, unique_clicks: 0, total_conversions: 0 },
      ],
      summary: { total_clicks: 0, total_conversions: 0, total_revenue: 0, avg_conversion_rate: 0 },
    };

    const summary = buildSummary(
      { ...baseParams, startDateObj: new Date(), endDateObj: new Date() },
      dailyRevenue,
      emptyAffiliates,
      topDeals
    );

    expect(summary.top_deal_name).toBe('Top Deal');
  });

  it('should identify top affiliate', () => {
    const dailyRevenue: any[] = [];
    const activeAffiliates: BusinessMetricsResponse['active_affiliates'] = {
      total_affiliates: 10,
      affiliates_with_conversions: 8,
      new_affiliates: 2,
      avg_lifetime_earnings: 1000,
      top_performers: [
        { full_name: 'Top Affiliate', email: '', level: 1, lifetime_earnings: 10000, pending_earnings: 0, total_conversions: 0, total_revenue: 0, conversion_rate: 0, total_clicks: 0, is_active: true, last_activity_date: null, direct_referrals: 0, indirect_referrals: 0, commission_rate: 0.3, last_payout_date: null },
      ],
      distribution_by_level: { level_1: 5, level_2: 3, level_3: 2 },
    };

    const summary = buildSummary(
      { ...baseParams, startDateObj: new Date(), endDateObj: new Date() },
      dailyRevenue,
      activeAffiliates,
      emptyTopDeals
    );

    expect(summary.top_affiliate_name).toBe('Top Affiliate');
  });

  it('should use email if full_name is null', () => {
    const activeAffiliates: BusinessMetricsResponse['active_affiliates'] = {
      ...emptyAffiliates,
      top_performers: [
        { full_name: null, email: 'affiliate@example.com', level: 1, lifetime_earnings: 10000, pending_earnings: 0, total_conversions: 0, total_revenue: 0, conversion_rate: 0, total_clicks: 0, is_active: true, last_activity_date: null, direct_referrals: 0, indirect_referrals: 0, commission_rate: 0.3, last_payout_date: null },
      ],
    };

    const summary = buildSummary(
      { ...baseParams, startDateObj: new Date(), endDateObj: new Date() },
      emptyDailyRevenue,
      activeAffiliates,
      emptyTopDeals
    );

    expect(summary.top_affiliate_name).toBe('affiliate@example.com');
  });

  it('should round revenue to 2 decimal places', () => {
    const dailyRevenue = [
      { revenue: 1000.123, conversions: 10, commission_paid: 300.456, commission_rate_percent: 30 },
      { revenue: 2000.789, conversions: 20, commission_paid: 600.321, commission_rate_percent: 30 },
    ];

    const summary = buildSummary(
      { ...baseParams, startDateObj: new Date(), endDateObj: new Date() },
      dailyRevenue,
      emptyAffiliates,
      emptyTopDeals
    );

    expect(summary.total_revenue).toBe(3000.91); // 1000.123 + 2000.789 = 3000.912, rounded to 3000.91
    expect(summary.total_commission_liability).toBe(900.78);
  });
});

// ============================================================================
// Date Utility Tests
// ============================================================================

describe('formatDateForQuery', () => {
  it('should format date to YYYY-MM-DD', () => {
    const date = new Date('2024-06-15T14:37:22Z');
    expect(formatDateForQuery(date)).toBe('2024-06-15');
  });

  it('should handle beginning of month', () => {
    const date = new Date('2024-01-01T00:00:00Z');
    expect(formatDateForQuery(date)).toBe('2024-01-01');
  });

  it('should handle end of year', () => {
    const date = new Date('2024-12-31T23:59:59Z');
    expect(formatDateForQuery(date)).toBe('2024-12-31');
  });
});

describe('isDateInRange', () => {
  const startDate = new Date('2024-06-01T00:00:00Z');
  const endDate = new Date('2024-06-30T23:59:59Z');

  it('should return true for date within range', () => {
    const date = new Date('2024-06-15T12:00:00Z');
    expect(isDateInRange(date, startDate, endDate)).toBe(true);
  });

  it('should return true for start boundary', () => {
    const date = new Date('2024-06-01T00:00:00Z');
    expect(isDateInRange(date, startDate, endDate)).toBe(true);
  });

  it('should return true for end boundary', () => {
    const date = new Date('2024-06-30T23:59:59Z');
    expect(isDateInRange(date, startDate, endDate)).toBe(true);
  });

  it('should return false for date before start', () => {
    const date = new Date('2024-05-31T23:59:59Z');
    expect(isDateInRange(date, startDate, endDate)).toBe(false);
  });

  it('should return false for date after end', () => {
    const date = new Date('2024-07-01T00:00:00Z');
    expect(isDateInRange(date, startDate, endDate)).toBe(false);
  });

  it('should accept string date input', () => {
    expect(isDateInRange('2024-06-15', startDate, endDate)).toBe(true);
    expect(isDateInRange('2024-05-15', startDate, endDate)).toBe(false);
  });
});

// ============================================================================
// Formatting Utility Tests
// ============================================================================

describe('formatCurrency', () => {
  it('should format USD correctly', () => {
    expect(formatCurrency(1234.56)).toBe('$1,234.56');
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatCurrency(1000000)).toBe('$1,000,000.00');
  });

  it('should handle different currencies', () => {
    expect(formatCurrency(1000, 'EUR')).toContain('1,000');
    expect(formatCurrency(1000, 'GBP')).toContain('1,000');
  });

  it('should always show 2 decimal places', () => {
    expect(formatCurrency(100)).toBe('$100.00');
    expect(formatCurrency(100.1)).toBe('$100.10');
    expect(formatCurrency(100.567)).toBe('$100.57'); // Rounded
  });
});

describe('formatPercentage', () => {
  it('should format with default 2 decimals', () => {
    expect(formatPercentage(12.345)).toBe('12.35%');
    expect(formatPercentage(0)).toBe('0.00%');
    expect(formatPercentage(100)).toBe('100.00%');
  });

  it('should format with custom decimals', () => {
    expect(formatPercentage(12.3456, 3)).toBe('12.346%');
    expect(formatPercentage(12.3456, 0)).toBe('12%');
  });

  it('should handle edge cases', () => {
    expect(formatPercentage(0.001, 3)).toBe('0.001%');
    expect(formatPercentage(99.999, 2)).toBe('100.00%'); // Rounded up
  });
});

describe('formatCompactNumber', () => {
  it('should format millions with M suffix', () => {
    expect(formatCompactNumber(1500000)).toBe('1.5M');
    expect(formatCompactNumber(1000000)).toBe('1.0M');
    expect(formatCompactNumber(9999999)).toBe('10.0M');
  });

  it('should format thousands with K suffix', () => {
    expect(formatCompactNumber(1500)).toBe('1.5K');
    expect(formatCompactNumber(1000)).toBe('1.0K');
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(10000)).toBe('10.0K');
  });

  it('should return plain number for values under 1000', () => {
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(100)).toBe('100');
  });

  it('should handle negative numbers as plain (no suffix)', () => {
    // The implementation doesn't add suffix for negatives, just returns string of value
    expect(formatCompactNumber(-1500)).toBe('-1500');
    expect(formatCompactNumber(-1500000)).toBe('-1500000');
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Formatting Integration', () => {
  it('should format currency with compact number', () => {
    const value = 1500000;
    const compact = formatCompactNumber(value); // '1.5M'
    // Could combine: `${compact} USD` = '1.5M USD'
    expect(compact).toBe('1.5M');
  });

  it('should format percentage of formatted currency', () => {
    const commission = 300;
    const revenue = 1000;
    const percentage = (commission / revenue) * 100;
    expect(formatPercentage(percentage)).toBe('30.00%');
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  it('should handle large revenue numbers', () => {
    expect(formatCurrency(1000000)).toBe('$1,000,000.00');
    expect(formatCurrency(999999)).toBe('$999,999.00');
  });

  it('should handle negative revenue (refunds)', () => {
    const revenue = -500;
    expect(formatCurrency(revenue)).toBe('-$500.00');
  });

  it('should handle NaN in formatCurrency gracefully', () => {
    // @ts-ignore - intentional NaN
    expect(formatCurrency(NaN)).toContain('NaN');
  });

  it('should handle zero values', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatPercentage(0)).toBe('0.00%');
  });
});
