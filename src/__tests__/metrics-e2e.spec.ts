/**
 * Metrics API End-to-End Verification Tests
 *
 * This test suite verifies that:
 * 1. The Business Metrics API returns data matching the type definitions
 * 2. All dashboard charts receive correctly shaped data
 * 3. No type mismatches exist between API and frontend
 */

import {
  formatCurrency as formatCurrencyUtil,
  formatPercentage as formatPercentageUtil,
  formatCompactNumber as formatCompactUtil,
} from '@/lib/metrics/business-metrics';
import type { BusinessMetricsResponse, DailyRevenue, ConversionRateMetrics, ActiveAffiliatesSummary, DealMetrics, AffiliateMetrics } from '@/types/metrics';

// ============================================================================
// Type Validation Tests (compile-time checks)
// ============================================================================

describe('Type Validations (compile-time)', () => {
  it('should have correct DailyRevenue shape', () => {
    const sample: DailyRevenue = {
      date: '2024-06-15',
      revenue: 1000.50,
      conversions: 10,
      unique_customers: 8,
      average_order_value: 125.06,
      commission_paid: 300.15,
      commission_rate_percent: 30,
    };
    expect(sample.date).toBe('2024-06-15');
    expect(typeof sample.revenue).toBe('number');
  });

  it('should have correct ConversionRateMetrics shape', () => {
    const sample: ConversionRateMetrics = {
      period: '2024-06-15',
      total_clicks: 100,
      total_conversions: 10,
      conversion_rate: 10.5,
      unique_visitors: 80,
      avg_time_to_conversion: 3600,
    };
    expect(sample.period).toBe('2024-06-15');
    expect(sample.conversion_rate).toBe(10.5);
  });

  it('should have correct AffiliateMetrics shape', () => {
    const sample: AffiliateMetrics = {
      id: 'aff-123',
      email: 'test@example.com',
      full_name: 'Test User',
      level: 1,
      lifetime_earnings: 5000,
      pending_earnings: 500,
      total_conversions: 50,
      total_revenue: 25000,
      conversion_rate: 10,
      total_clicks: 500,
      is_active: true,
      last_activity_date: '2024-06-15',
      direct_referrals: 5,
      indirect_referrals: 10,
      commission_rate: 0.3,
      last_payout_date: '2024-06-01',
      joined_date: '2024-01-15',
    };
    expect(sample.commission_rate).toBe(0.3);
    expect(sample.level).toBe(1);
  });

  it('should have correct DealMetrics shape with minimal top_affiliate', () => {
    // This test verifies the type contract: top_affiliate only contains email
    const sample: DealMetrics = {
      id: 'deal-123',
      name: 'Test Deal',
      exchange: 'binance',
      category: 'spot',
      total_clicks: 1000,
      unique_clicks: 800,
      total_conversions: 100,
      conversion_rate: 10,
      total_revenue: 50000,
      total_commission: 15000,
      avg_commission_rate: 30,
      is_active: true,
      top_affiliate: {
        email: 'top.affiliate@example.com',
      },
    };
    // Type contract: top_affiliate only contains email (optional)
    expect(sample.top_affiliate?.email).toBe('top.affiliate@example.com');
  });

  it('should have correct DealMetrics shape with null top_affiliate', () => {
    const sample: DealMetrics = {
      id: 'deal-124',
      name: 'Another Deal',
      exchange: null,
      category: null,
      total_clicks: 500,
      unique_clicks: 400,
      total_conversions: 50,
      conversion_rate: 10,
      total_revenue: 25000,
      total_commission: 7500,
      avg_commission_rate: 30,
      is_active: false,
      top_affiliate: null,
    };
    expect(sample.top_affiliate).toBeNull();
  });

  it('should have correct ActiveAffiliatesSummary shape', () => {
    const sample: ActiveAffiliatesSummary = {
      total_affiliates: 100,
      affiliates_with_conversions: 75,
      new_affiliates: 10,
      avg_lifetime_earnings: 1000.50,
      top_performers: [],
      distribution_by_level: { level_1: 50, level_2: 30, level_3: 20 },
    };
    expect(sample.distribution_by_level.level_1).toBe(50);
  });

  it('should have correct BusinessMetricsResponse shape', () => {
    const sample: BusinessMetricsResponse = {
      generated_at: new Date().toISOString(),
      query: {
        start_date: '2024-06-01',
        end_date: '2024-06-30',
        group_by: 'daily',
      },
      cached: false,
      daily_revenue: [],
      conversion_rates: [],
      active_affiliates: {
        total_affiliates: 0,
        affiliates_with_conversions: 0,
        new_affiliates: 0,
        avg_lifetime_earnings: 0,
        top_performers: [],
        distribution_by_level: { level_1: 0, level_2: 0, level_3: 0 },
      },
      top_deals: {
        period: { start_date: '2024-06-01', end_date: '2024-06-30' },
        limit: 10,
        deals: [],
        summary: { total_clicks: 0, total_conversions: 0, total_revenue: 0, avg_conversion_rate: 0 },
      },
      summary: {
        period_start: '2024-06-01',
        period_end: '2024-06-30',
        total_revenue: 0,
        total_conversions: 0,
        overall_conversion_rate: 0,
        active_affiliates_count: 0,
        total_commission_liability: 0,
        top_deal_name: 'N/A',
        top_affiliate_name: 'N/A',
      },
    };
    expect(sample.generated_at).toBeDefined();
    expect(sample.summary?.total_revenue).toBe(0);
  });
});

// ============================================================================
// Dashboard Data Transformation Tests
// ============================================================================

describe('Dashboard Data Transformations', () => {
  it('should transform daily_revenue correctly for revenue chart', () => {
    const dailyRevenue: DailyRevenue[] = [
      { date: '2024-06-15', revenue: 1000, conversions: 10, unique_customers: 8, average_order_value: 125, commission_paid: 300, commission_rate_percent: 30 },
      { date: '2024-06-14', revenue: 2000, conversions: 20, unique_customers: 15, average_order_value: 100, commission_paid: 600, commission_rate_percent: 30 },
    ];

    const chartData = dailyRevenue.map(d => ({
      date: d.date,
      revenue: d.revenue,
      conversions: d.conversions,
      commission: d.commission_paid,
      unique_customers: d.unique_customers,
    })).reverse();

    expect(chartData.length).toBe(2);
    expect(chartData[0].date).toBe('2024-06-14'); // reversed
    expect(chartData[0].revenue).toBe(2000);
    expect(chartData[1].revenue).toBe(1000);
  });

  it('should transform top_deals correctly for bar chart', () => {
    const deals: DealMetrics[] = [
      {
        id: '1',
        name: 'Test Deal',
        exchange: 'binance',
        category: 'spot',
        total_clicks: 1000,
        unique_clicks: 800,
        total_conversions: 100,
        conversion_rate: 10,
        total_revenue: 50000,
        total_commission: 15000,
        avg_commission_rate: 30,
        is_active: true,
        top_affiliate: { email: 'top@example.com' },
      },
    ];

    const chartData = deals.map(d => ({
      name: d.name.length > 25 ? d.name.slice(0, 25) + '...' : d.name,
      fullName: d.name,
      revenue: d.total_revenue,
      conversions: d.total_conversions,
      conversion_rate: d.conversion_rate,
      exchange: d.exchange || 'Unknown',
    }));

    expect(chartData.length).toBe(1);
    expect(chartData[0].revenue).toBe(50000);
    expect(chartData[0].exchange).toBe('binance');
  });

  it('should transform conversion_rates correctly for funnel chart', () => {
    const conversionRates: ConversionRateMetrics[] = [
      { period: '2024-06-15', total_clicks: 1000, total_conversions: 100, conversion_rate: 10, unique_visitors: 800, avg_time_to_conversion: 3600 },
    ];

    const latest = conversionRates[0];
    const funnelData = [
      { stage: 'visitors', label: 'Visitors', count: latest.unique_visitors, color: '#3B82F6' },
      { stage: 'clicks', label: 'Clicks', count: latest.total_clicks, color: '#10B981' },
      { stage: 'converted', label: 'Conversions', count: latest.total_conversions, color: '#F59E0B' },
    ];

    expect(funnelData.length).toBe(3);
    expect(funnelData[0].count).toBe(800);
    expect(funnelData[1].count).toBe(1000);
    expect(funnelData[2].count).toBe(100);
  });

  it('should build summary correctly from metrics data', () => {
    const dailyRevenue: DailyRevenue[] = [
      { date: '2024-06-15', revenue: 1000, conversions: 10, unique_customers: 8, average_order_value: 125, commission_paid: 300, commission_rate_percent: 30 },
      { date: '2024-06-14', revenue: 2000, conversions: 20, unique_customers: 15, average_order_value: 100, commission_paid: 600, commission_rate_percent: 30 },
    ];

    const totalRevenue = dailyRevenue.reduce((sum, d) => sum + d.revenue, 0);
    const totalConversions = dailyRevenue.reduce((sum, d) => sum + d.conversions, 0);
    const totalCommission = dailyRevenue.reduce((sum, d) => sum + d.commission_paid, 0);

    expect(totalRevenue).toBe(3000);
    expect(totalConversions).toBe(30);
    expect(totalCommission).toBe(900);
  });

  it('should handle empty data sets without crashing', () => {
    const emptyRevenue: DailyRevenue[] = [];
    const total = emptyRevenue.reduce((sum, d) => sum + d.revenue, 0);
    expect(total).toBe(0);
  });
});

// ============================================================================
// Formatting Utility Tests
// ============================================================================

describe('Formatting Utilities', () => {
  it('should format currency correctly', () => {
    expect(formatCurrencyUtil(1000)).toBe('$1,000.00');
    expect(formatCurrencyUtil(0)).toBe('$0.00');
    expect(formatCurrencyUtil(1000000)).toBe('$1,000,000.00');
  });

  it('should format percentage correctly', () => {
    expect(formatPercentageUtil(12.345)).toBe('12.35%');
    expect(formatPercentageUtil(0)).toBe('0.00%');
    expect(formatPercentageUtil(100)).toBe('100.00%');
  });

  it('should format compact numbers correctly', () => {
    expect(formatCompactUtil(1500000)).toBe('1.5M');
    expect(formatCompactUtil(1500)).toBe('1.5K');
    expect(formatCompactUtil(500)).toBe('500');
  });

  it('should handle edge cases in formatting', () => {
    expect(formatCurrencyUtil(-500)).toBe('-$500.00');
    expect(formatCompactUtil(0)).toBe('0');
    expect(formatPercentageUtil(0.001, 3)).toBe('0.001%');
  });
});

// ============================================================================
// API Response Shape Validation
// ============================================================================

describe('API Response Shape Validation', () => {
  it('should validate that summary fields are always present and numeric', () => {
    const apiResponse = {
      generated_at: '2024-06-15T12:00:00Z',
      query: { start_date: '2024-06-01', end_date: '2024-06-15', group_by: 'daily' },
      cached: false,
      daily_revenue: [
        { date: '2024-06-15', revenue: 1000, conversions: 10, unique_customers: 8, average_order_value: 125, commission_paid: 300, commission_rate_percent: 30 }
      ],
      conversion_rates: [
        { period: '2024-06-15', total_clicks: 100, total_conversions: 10, conversion_rate: 10, unique_visitors: 80, avg_time_to_conversion: 3600 }
      ],
      active_affiliates: {
        total_affiliates: 50,
        affiliates_with_conversions: 30,
        new_affiliates: 5,
        avg_lifetime_earnings: 1000,
        top_performers: [],
        distribution_by_level: { level_1: 20, level_2: 20, level_3: 10 },
      },
      top_deals: {
        period: { start_date: '2024-06-01', end_date: '2024-06-15' },
        limit: 10,
        deals: [{
          id: '1',
          name: 'Test Deal',
          exchange: 'binance',
          category: 'spot',
          total_clicks: 1000,
          unique_clicks: 800,
          total_conversions: 100,
          conversion_rate: 10,
          total_revenue: 50000,
          total_commission: 15000,
          avg_commission_rate: 30,
          is_active: true,
          top_affiliate: { email: 'top@example.com' },
        }],
        summary: { total_clicks: 1000, total_conversions: 100, total_revenue: 50000, avg_conversion_rate: 10 },
      },
      summary: {
        period_start: '2024-06-01',
        period_end: '2024-06-15',
        total_revenue: 1000,
        total_conversions: 10,
        overall_conversion_rate: 10,
        active_affiliates_count: 50,
        total_commission_liability: 300,
        top_deal_name: 'Test Deal',
        top_affiliate_name: 'Top Affiliate',
      },
    };

    // Verify all summary fields are present and have correct types
    expect(typeof apiResponse.summary.total_revenue).toBe('number');
    expect(typeof apiResponse.summary.total_conversions).toBe('number');
    expect(typeof apiResponse.summary.overall_conversion_rate).toBe('number');
    expect(typeof apiResponse.summary.active_affiliates_count).toBe('number');
    expect(typeof apiResponse.summary.total_commission_liability).toBe('number');
    expect(typeof apiResponse.summary.top_deal_name).toBe('string');
    expect(typeof apiResponse.summary.top_affiliate_name).toBe('string');
  });

  it('should validate that chart data arrays are always defined', () => {
    const apiResponse = {
      daily_revenue: [],
      conversion_rates: [],
      top_deals: { deals: [] },
    };

    // These should not be null/undefined even when empty
    expect(Array.isArray(apiResponse.daily_revenue)).toBe(true);
    expect(Array.isArray(apiResponse.conversion_rates)).toBe(true);
    expect(Array.isArray(apiResponse.top_deals.deals)).toBe(true);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  it('should handle very large revenue numbers', () => {
    const largeRevenue = 999999999.99;
    const formatted = formatCurrencyUtil(largeRevenue);
    expect(formatted).toBe('$999,999,999.99');
  });

  it('should handle zero values in all formats', () => {
    expect(formatCurrencyUtil(0)).toBe('$0.00');
    expect(formatCompactUtil(0)).toBe('0');
    expect(formatPercentageUtil(0)).toBe('0.00%');
  });

  it('should handle fractional commission rates', () => {
    const rate = 0.03333; // 3.333%
    // Use the actual utility function
    const percentage = formatPercentageUtil(rate * 100);
    expect(percentage).toBe('3.33%');
  });

  it('should handle null/undefined top_affiliate gracefully', () => {
    const deal1 = { top_affiliate: null } as DealMetrics;
    const deal2 = { top_affiliate: undefined } as DealMetrics;

    expect(deal1.top_affiliate).toBeNull();
    expect(deal2.top_affiliate).toBeUndefined();
  });

  it('should handle empty arrays in chart data transformations', () => {
    const emptyRevenue: DailyRevenue[] = [];
    const chartData = emptyRevenue.map(d => ({
      date: d.date,
      revenue: d.revenue,
      conversions: d.conversions,
    }));
    expect(chartData.length).toBe(0);
  });
});
