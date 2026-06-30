/**
 * Business Metrics Types and Validation Tests
 */

import { parseQueryParams, buildSummary } from '@/lib/metrics/business-metrics';
import type { BusinessMetricsResponse } from '@/types/metrics';

// Mock NextRequest
function createMockRequest(queryParams: Record<string, string> = {}): any {
  const url = new URL('http://localhost/api/metrics/business');
  Object.entries(queryParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return {
    url: url.toString(),
    nextUrl: url,
    headers: new Map(),
    cookies: new Map(),
  };
}

describe('Business Metrics API Types', () => {
  describe('parseQueryParams', () => {
    it('uses defaults when no params provided', () => {
      const request = createMockRequest();
      const params = parseQueryParams(request);

      expect(params.start_date).toBeDefined();
      expect(params.end_date).toBeDefined();
      expect(params.group_by).toBe('daily');
      expect(params.status).toBe('approved');
    });

    it('parses provided date range', () => {
      const request = createMockRequest({
        start_date: '2026-06-01',
        end_date: '2026-06-30',
      });
      const params = parseQueryParams(request);

      expect(params.start_date).toBe('2026-06-01');
      expect(params.end_date).toBe('2026-06-30');
    });

    it('throws on invalid date format', () => {
      const request = createMockRequest({
        start_date: 'invalid-date',
      });

      expect(() => parseQueryParams(request)).toThrow('Invalid date format');
    });

    it('throws when start_date is after end_date', () => {
      const request = createMockRequest({
        start_date: '2026-07-01',
        end_date: '2026-06-01',
      });

      expect(() => parseQueryParams(request)).toThrow('start_date must be before end_date');
    });

    it('parses optional filters', () => {
      const request = createMockRequest({
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        group_by: 'weekly',
        deal_type: 'product',
        exchange: 'binance',
        status: 'approved',
      });
      const params = parseQueryParams(request);

      expect(params.group_by).toBe('weekly');
      expect(params.deal_type).toBe('product');
      expect(params.exchange).toBe('binance');
      expect(params.status).toBe('approved');
    });

    it('validates group_by enum values', () => {
      const validValues = ['daily', 'weekly', 'monthly', 'all'];

      validValues.forEach(value => {
        const request = createMockRequest({ group_by: value });
        const params = parseQueryParams(request);
        expect(params.group_by).toBe(value);
      });
    });

    it('validates status enum values', () => {
      const validValues = ['approved', 'pending', 'all'];

      validValues.forEach(value => {
        const request = createMockRequest({ status: value });
        const params = parseQueryParams(request);
        expect(params.status).toBe(value);
      });
    });
  });

  describe('buildSummary', () => {
    const mockParams = {
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      startDateObj: new Date('2026-06-01'),
      endDateObj: new Date('2026-06-30'),
    };

    const mockDailyRevenue: BusinessMetricsResponse['daily_revenue'] = [
      {
        date: '2026-06-30',
        revenue: 10000,
        conversions: 100,
        unique_customers: 80,
        average_order_value: 100,
        commission_paid: 3000,
        commission_rate_percent: 30,
      },
      {
        date: '2026-06-29',
        revenue: 8000,
        conversions: 80,
        unique_customers: 65,
        average_order_value: 100,
        commission_paid: 2400,
        commission_rate_percent: 30,
      },
    ];

    const mockActiveAffiliates: BusinessMetricsResponse['active_affiliates'] = {
      total_affiliates: 25,
      affiliates_with_conversions: 15,
      new_affiliates: 3,
      avg_lifetime_earnings: 5000,
      top_performers: [],
      distribution_by_level: { level_1: 15, level_2: 7, level_3: 3 },
    };

    const mockTopDeals: BusinessMetricsResponse['top_deals'] = {
      period: { start_date: '2026-06-01', end_date: '2026-06-30' },
      limit: 10,
      deals: [],
      summary: { total_clicks: 5000, total_conversions: 200, total_revenue: 50000, avg_conversion_rate: 4 },
    };

    it('calculates total revenue correctly', () => {
      const summary = buildSummary(mockParams, mockDailyRevenue, mockActiveAffiliates, mockTopDeals);

      expect(summary.total_revenue).toBe(18000);
    });

    it('calculates total conversions correctly', () => {
      const summary = buildSummary(mockParams, mockDailyRevenue, mockActiveAffiliates, mockTopDeals);

      expect(summary.total_conversions).toBe(180);
    });

    it('sets period dates correctly', () => {
      const summary = buildSummary(mockParams, mockDailyRevenue, mockActiveAffiliates, mockTopDeals);

      expect(summary.period_start).toBe('2026-06-01');
      expect(summary.period_end).toBe('2026-06-30');
    });

    it('sets affiliate count correctly', () => {
      const summary = buildSummary(mockParams, mockDailyRevenue, mockActiveAffiliates, mockTopDeals);

      expect(summary.active_affiliates_count).toBe(25);
    });

    it('returns N/A for top names when no data', () => {
      const emptyDeals: BusinessMetricsResponse['top_deals'] = {
        period: { start_date: '2026-06-01', end_date: '2026-06-30' },
        limit: 10,
        deals: [],
        summary: { total_clicks: 0, total_conversions: 0, total_revenue: 0, avg_conversion_rate: 0 },
      };

      const emptyAffiliates: BusinessMetricsResponse['active_affiliates'] = {
        total_affiliates: 0,
        affiliates_with_conversions: 0,
        new_affiliates: 0,
        avg_lifetime_earnings: 0,
        top_performers: [],
        distribution_by_level: { level_1: 0, level_2: 0, level_3: 0 },
      };

      const summary = buildSummary(mockParams, [], emptyAffiliates, emptyDeals);

      expect(summary.top_deal_name).toBe('N/A');
      expect(summary.top_affiliate_name).toBe('N/A');
    });
  });

  describe('Response Shape', () => {
    it('daily revenue has correct structure', () => {
      const dailyRevenue: BusinessMetricsResponse['daily_revenue'] = [
        {
          date: '2026-06-22',
          revenue: 1000,
          conversions: 10,
          unique_customers: 8,
          average_order_value: 100,
          commission_paid: 300,
          commission_rate_percent: 30,
        },
      ];

      expect(dailyRevenue[0]).toHaveProperty('date');
      expect(dailyRevenue[0]).toHaveProperty('revenue');
      expect(dailyRevenue[0]).toHaveProperty('conversions');
      expect(dailyRevenue[0]).toHaveProperty('unique_customers');
      expect(dailyRevenue[0]).toHaveProperty('average_order_value');
      expect(dailyRevenue[0]).toHaveProperty('commission_paid');
      expect(dailyRevenue[0]).toHaveProperty('commission_rate_percent');
    });

    it('affiliate metrics has correct structure', () => {
      const affiliate: BusinessMetricsResponse['active_affiliates'] = {
        total_affiliates: 10,
        affiliates_with_conversions: 8,
        new_affiliates: 2,
        avg_lifetime_earnings: 5000,
        top_performers: [],
        distribution_by_level: { level_1: 6, level_2: 3, level_3: 1 },
      };

      expect(affiliate).toHaveProperty('total_affiliates');
      expect(affiliate).toHaveProperty('affiliates_with_conversions');
      expect(affiliate).toHaveProperty('new_affiliates');
      expect(affiliate).toHaveProperty('avg_lifetime_earnings');
      expect(affiliate).toHaveProperty('top_performers');
      expect(affiliate).toHaveProperty('distribution_by_level');
    });

    it('top deals response has correct structure', () => {
      const topDeals: BusinessMetricsResponse['top_deals'] = {
        period: { start_date: '2026-06-01', end_date: '2026-06-30' },
        limit: 10,
        deals: [],
        summary: { total_clicks: 100, total_conversions: 10, total_revenue: 5000, avg_conversion_rate: 10 },
      };

      expect(topDeals).toHaveProperty('period');
      expect(topDeals).toHaveProperty('limit');
      expect(topDeals).toHaveProperty('deals');
      expect(topDeals).toHaveProperty('summary');
    });

    it('summary has all required fields', () => {
      const summary: BusinessMetricsResponse['summary'] = {
        period_start: '2026-06-01',
        period_end: '2026-06-30',
        total_revenue: 10000,
        total_conversions: 100,
        overall_conversion_rate: 5.0,
        active_affiliates_count: 10,
        total_commission_liability: 3000,
        top_deal_name: 'Test Deal',
        top_affiliate_name: 'Test Affiliate',
      };

      expect(summary).toHaveProperty('period_start');
      expect(summary).toHaveProperty('period_end');
      expect(summary).toHaveProperty('total_revenue');
      expect(summary).toHaveProperty('total_conversions');
      expect(summary).toHaveProperty('overall_conversion_rate');
      expect(summary).toHaveProperty('active_affiliates_count');
      expect(summary).toHaveProperty('total_commission_liability');
      expect(summary).toHaveProperty('top_deal_name');
      expect(summary).toHaveProperty('top_affiliate_name');
    });
  });
});
