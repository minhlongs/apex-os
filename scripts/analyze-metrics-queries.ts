#!/usr/bin/env tsx
/**
 * ApexOS Metrics Query Performance Analyzer
 *
 * Analyzes the performance of business and timeseries metrics queries.
 * Runs EXPLAIN QUERY PLAN to identify missing indexes and slow queries.
 *
 * Usage: tsx scripts/analyze-metrics-queries.ts
 */

import { DB } from '@/lib/db/d1-adapter';

interface QueryInfo {
  name: string;
  sql: string;
  params?: unknown[];
}

interface AnalysisResult {
  queryName: string;
  sql: string;
  estimatedRows: number;
  hasIndexUsage: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  recommendations: string[];
}

async function analyzeQueryPlan(DB: DB, query: QueryInfo): Promise<AnalysisResult> {
  const recommendations: string[] = [];
  let estimatedRows = 0;
  let hasIndexUsage = false;

  try {
    const explainResult = await DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .bind(...(query.params || []))
      .all<{
        id: number;
        parent: number;
        detail: string;
      }>();

    const plan = explainResult.results;

    // Analyze each step
    for (const row of plan) {
      const detail = row.detail.toLowerCase();

      // Check for index usage
      if (detail.includes('using index') || detail.includes('search')) {
        hasIndexUsage = true;
      }

      // Extract estimated row count
      const match = row.detail.match(/\((\d+)(?:\+(\d+))?\s*rows?\)/i);
      if (match) {
        estimatedRows += parseInt(match[1], 10);
      }
    }

    // Determine risk level based on estimated rows and index usage
    let riskLevel: AnalysisResult['riskLevel'] = 'low';
    if (estimatedRows > 100000) {
      riskLevel = 'high';
      recommendations.push('Query scans very large number of rows - needs optimization');
    } else if (estimatedRows > 10000) {
      riskLevel = 'medium';
      recommendations.push('Query scans moderate number of rows - review indexes');
    }

    if (!hasIndexUsage && estimatedRows > 1000) {
      riskLevel = Math.max(riskLevel, 'high');
      recommendations.push('No index usage detected - full table scan likely');
    }

    // Check for specific patterns in metrics queries
    if (query.sql.includes('DATE(converted_at)') || query.sql.includes('DATE(created_at)')) {
      recommendations.push('Consider functional index on DATE(column) if query is slow');
    }

    if (query.sql.includes('JOIN') && query.sql.includes('LEFT JOIN')) {
      recommendations.push('Ensure join columns have appropriate indexes');
    }

    if (query.sql.includes('GROUP BY') && !query.sql.includes('COUNT(DISTINCT')) {
      recommendations.push('Consider covering index for GROUP BY queries');
    }

    return { queryName: query.name, sql: query.sql, estimatedRows, hasIndexUsage, riskLevel, recommendations };
  } catch (error) {
    return {
      queryName: query.name,
      sql: query.sql,
      estimatedRows: 0,
      hasIndexUsage: false,
      riskLevel: 'high',
      recommendations: [`Error analyzing query: ${error}`],
    };
  }
}

function getBusinessMetricsQueries(): QueryInfo[] {
  return [
    // From fetchDailyRevenue
    {
      name: 'v_daily_revenue view query',
      sql: `
        SELECT
          date as date,
          total_revenue as revenue,
          total_conversions as conversions,
          unique_customers as unique_customers,
          avg_order_value as average_order_value,
          total_commission as commission_paid,
          conversion_rate_percent as commission_rate_percent
        FROM v_daily_revenue
        WHERE date >= ? AND date <= ?
      `,
      params: ['2025-06-01', '2025-06-22'],
    },
    {
      name: 'v_daily_revenue with filters (join)',
      sql: `
        SELECT
          dr.date,
          dr.revenue,
          dr.conversions,
          dr.unique_customers,
          dr.average_order_value,
          dr.commission_paid,
          dr.commission_rate_percent
        FROM v_daily_revenue dr
        JOIN conversions c ON DATE(c.converted_at) = dr.date
        JOIN deals d ON d.id = c.deal_id
        WHERE dr.date >= ? AND dr.date <= ?
          AND d.deal_type = ?
          AND d.exchange = ?
      `,
      params: ['2025-06-01', '2025-06-22', 'product', 'binance'],
    },
    // From fetchConversionRates
    {
      name: 'v_conversion_rates view query',
      sql: `
        SELECT
          date as period,
          unique_visitors,
          total_clicks,
          total_conversions,
          conversion_rate_percent as conversion_rate,
          avg_seconds_to_conversion as avg_time_to_conversion
        FROM v_conversion_rates
        WHERE date >= ? AND date <= ?
      `,
      params: ['2025-06-01', '2025-06-22'],
    },
    // From fetchActiveAffiliates
    {
      name: 'v_active_affiliates view query',
      sql: `
        SELECT * FROM v_active_affiliates
        WHERE 1=1
      `,
    },
    // From fetchTopDeals
    {
      name: 'v_deal_performance with date filter',
      sql: `
        SELECT
          dp.id,
          dp.name,
          dp.exchange,
          dp.category,
          dp.deal_type,
          dp.total_clicks,
          dp.unique_clicks,
          dp.total_conversions,
          dp.unique_customers,
          dp.total_revenue,
          dp.total_commission,
          dp.conversion_rate_percent as conversion_rate,
          dp.avg_order_value,
          dp.avg_commission_rate,
          dp.top_affiliate_email,
          dp.affiliate_count,
          dp.is_active
        FROM v_deal_performance dp
        WHERE dp.total_clicks > 0
          AND dp.id IN (
            SELECT DISTINCT deal_id FROM conversions
            WHERE converted_at >= ? AND converted_at <= ?
          )
      `,
      params: ['2025-06-01T00:00:00.000Z', '2025-06-22T23:59:59.999Z'],
    },
  ];
}

function getTimeSeriesQueries(): QueryInfo[] {
  return [
    // Simple time-series query
    {
      name: 'Time-series: conversions by day',
      sql: `
        SELECT
          DATE(converted_at) as date,
          COUNT(*) as value
        FROM conversions
        WHERE converted_at >= ? AND converted_at < ?
        GROUP BY DATE(converted_at)
        ORDER BY date ASC
      `,
      params: ['2025-06-01', '2025-06-23'],
    },
    {
      name: 'Time-series: revenue with deal filter',
      sql: `
        SELECT
          DATE(converted_at) as date,
          SUM(revenue) as value
        FROM conversions
        WHERE converted_at >= ? AND converted_at < ?
          AND deal_id = ?
        GROUP BY DATE(converted_at)
        ORDER BY date ASC
      `,
      params: ['2025-06-01', '2025-06-23', 'deal-123'],
    },
    {
      name: 'Time-series: conversion rate (complex join)',
      sql: `
        SELECT
          DATE(c.converted_at) as date,
          COUNT(DISTINCT c.id) as conversions,
          COUNT(DISTINCT dc.id) as clicks,
          CASE WHEN COUNT(DISTINCT dc.id) > 0
            THEN (COUNT(DISTINCT c.id) * 100.0) / COUNT(DISTINCT dc.id)
            ELSE 0
          END as value
        FROM conversions c
        LEFT JOIN deal_clicks dc ON
          dc.deal_id = c.deal_id
          AND dc.created_at >= datetime(c.converted_at, '-30 days')
          AND dc.created_at <= c.converted_at
        WHERE c.converted_at >= ? AND c.converted_at < ?
        GROUP BY DATE(c.converted_at)
        ORDER BY date ASC
      `,
      params: ['2025-06-01', '2025-06-23'],
    },
  ];
}

async function main() {
  console.log('\n' + '═'.repeat(80));
  console.log('  📈 METRICS QUERY PERFORMANCE ANALYZER');
  console.log('═'.repeat(80));
  console.log('\nAnalyzing business and time-series metrics queries');
  console.log('Target: All queries should use indexes, estimate <10K rows for typical date ranges\n');

  const DB = (globalThis as unknown as { DB: any }).DB;
  if (!DB) {
    console.error('✗ Database not available. Start with: wrangler dev');
    process.exit(1);
  }

  // Show existing indexes first
  console.log('═'.repeat(80));
  console.log('  EXISTING INDEXES');
  console.log('═'.repeat(80));

  try {
    const indexes = await DB.prepare(`
      SELECT name, tbl_name as table, sql as definition
      FROM sqlite_master
      WHERE type = 'index'
        AND name LIKE 'idx_%'
      ORDER BY tbl_name, name
    `).all<{ name: string; table: string; definition: string }>();

    const byTable = new Map<string, typeof indexes.results>();
    for (const idx of indexes.results) {
      const existing = byTable.get(idx.table) || [];
      byTable.set(idx.table, [...existing, idx]);
    }

    for (const [table, tableIndexes] of byTable.entries()) {
      console.log(`\n${table}:`);
      for (const idx of tableIndexes) {
        // Parse columns from definition
        const match = idx.definition.match(/ON\s+\w+\s*\(([^)]+)\)/);
        const columns = match ? match[1].split(',').map(c => c.trim()).join(', ') : 'unknown';
        console.log(`  ✓ ${idx.name}: (${columns})`);
      }
    }
  } catch (error) {
    console.error('Error fetching indexes:', error);
  }

  // Analyze business metrics queries
  console.log('\n' + '═'.repeat(80));
  console.log('  BUSINESS METRICS QUERIES ANALYSIS');
  console.log('═'.repeat(80));

  const businessQueries = getBusinessMetricsQueries();
  const businessResults: AnalysisResult[] = [];

  for (const query of businessQueries) {
    const result = await analyzeQueryPlan(DB, query);
    businessResults.push(result);

    const riskColor = result.riskLevel === 'high' ? 'red' : result.riskLevel === 'medium' ? 'yellow' : 'green';
    console.log(`\n${colors[riskColor]}▶ ${result.queryName}${colors.reset}`);
    console.log(`  Risk Level: ${result.riskLevel.toUpperCase()}`);
    console.log(`  Estimated rows: ${result.estimatedRows.toLocaleString()}`);
    console.log(`  Index usage: ${result.hasIndexUsage ? '✓ YES' : '✗ NO'}`);
    if (result.recommendations.length > 0) {
      console.log(`  Recommendations:`);
      result.recommendations.forEach(rec => console.log(`    - ${rec}`));
    }
  }

  // Analyze time-series queries
  console.log('\n' + '═'.repeat(80));
  console.log('  TIME-SERIES QUERIES ANALYSIS');
  console.log('═'.repeat(80));

  const timeSeriesQueries = getTimeSeriesQueries();
  const tsResults: AnalysisResult[] = [];

  for (const query of timeSeriesQueries) {
    const result = await analyzeQueryPlan(DB, query);
    tsResults.push(result);

    const riskColor = result.riskLevel === 'high' ? 'red' : result.riskLevel === 'medium' ? 'yellow' : 'green';
    console.log(`\n${colors[riskColor]}▶ ${result.queryName}${colors.reset}`);
    console.log(`  Risk Level: ${result.riskLevel.toUpperCase()}`);
    console.log(`  Estimated rows: ${result.estimatedRows.toLocaleString()}`);
    console.log(`  Index usage: ${result.hasIndexUsage ? '✓ YES' : '✗ NO'}`);
    if (result.recommendations.length > 0) {
      console.log(`  Recommendations:`);
      result.recommendations.forEach(rec => console.log(`    - ${rec}`));
    }
  }

  // Summary and recommendations
  console.log('\n' + '═'.repeat(80));
  console.log('  SUMMARY & RECOMMENDATIONS');
  console.log('═'.repeat(80));

  const allResults = [...businessResults, ...tsResults];
  const highRisk = allResults.filter(r => r.riskLevel === 'high');
  const mediumRisk = allResults.filter(r => r.riskLevel === 'medium');
  const lowRisk = allResults.filter(r => r.riskLevel === 'low');

  console.log(`\nRisk Distribution:`);
  console.log(`  🔴 High:   ${highRisk.length} queries`);
  console.log(`  🟡 Medium: ${mediumRisk.length} queries`);
  console.log(`  🟢 Low:    ${lowRisk.length} queries`);

  if (highRisk.length > 0) {
    console.log('\n⚠️  HIGH RISK QUERIES (Requires immediate attention):');
    highRisk.forEach(r => console.log(`  - ${r.queryName}`));
  }

  console.log('\n' + '─'.repeat(80));
  console.log('Required Indexes for Metrics Queries:');
  console.log('─'.repeat(80));

  const requiredIndexes = [
    // For v_daily_revenue (aggregations on conversions)
    'idx_conversions_status_converted (status, converted_at)',
    'idx_conversions_deal_date_revenue (deal_id, date(converted_at), revenue)',

    // For v_conversion_rates (joins with deal_clicks)
    'idx_deal_clicks_created_at (created_at)',
    'idx_deal_clicks_deal_created (deal_id, created_at)',

    // For v_active_affiliates (joins with multiple tables)
    'idx_profiles_activity (role, created_at)',
    'idx_earnings_affiliate_agg (affiliate_id, is_paid, amount, conversion_id)',

    // For v_deal_performance
    'idx_deals_performance (is_active, exchange, category, deal_type)',

    // For time-series queries
    'idx_conversions_converted_at (converted_at)',
    'idx_conversions_affiliate_converted_status (affiliate_id, converted_at, status)',

    // Covering indexes for common aggregations
    'idx_clicks_agg (deal_id, affiliate_id, created_at, session_id)',
  ];

  console.log('\nVerify these indexes exist:');
  requiredIndexes.forEach(idx => console.log(`  ✓ ${idx}`));

  console.log('\nTo apply missing indexes:');
  console.log('  wrangler d1 execute apex-os-db --file src/database/migrations/010_timeseries_indexes.sql');
  console.log('  wrangler d1 execute apex-os-db --file src/database/migrations/010_business_metrics_views.sql');

  console.log('\n' + '═'.repeat(80) + '\n');

  process.exit(highRisk.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
