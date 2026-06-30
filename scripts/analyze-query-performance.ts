#!/usr/bin/env tsx
/**
 * ApexOS Query Performance Analyzer
 *
 * Runs EXPLAIN QUERY PLAN on Profile API queries to identify slow queries
 * and verify that composite indexes are being used correctly.
 *
 * Usage: tsx scripts/analyze-query-performance.ts
 */

// Import DB type from the actual location
import type { DB } from '@/lib/auth/adapters/d1-adapter';

interface QueryInfo {
  name: string;
  sql: string;
  params?: unknown[];
}

interface IndexInfo {
  name: string;
  table: string;
  columns: string[];
}

async function getExistingIndexes(DB: DB): Promise<IndexInfo[]> {
  const result = await DB.prepare(`
    SELECT name, tbl_name as table, sql as definition
    FROM sqlite_master
    WHERE type = 'index'
      AND name LIKE 'idx_%'
    ORDER BY tbl_name, name
  `).all<{ name: string; table: string; definition: string }>();

  const indexes: IndexInfo[] = result.results.map(idx => {
    // Parse columns from index definition: CREATE INDEX idx_name ON table(col1, col2)
    const match = idx.definition.match(/ON\s+\w+\s*\(([^)]+)\)/);
    const columns = match ? match[1].split(',').map(c => c.trim()) : [];
    return {
      name: idx.name,
      table: idx.table,
      columns,
    };
  });

  return indexes;
}

async function analyzeQuery(DB: DB, query: QueryInfo): Promise<void> {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`Query: ${query.name}`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`SQL: ${query.sql}`);
  console.log(`\nEXPLAIN QUERY PLAN:`);

  try {
    const explainResult = await DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .bind(...(query.params || []))
      .all<{
        id: number;
        parent: number;
        notused: string;
        detail: string;
      }>();

    const plan = explainResult.results;
    const hasIndexUsage = plan.some(row =>
      row.detail.toLowerCase().includes('using index') ||
      row.detail.toLowerCase().includes('search')
    );

    // Calculate estimated cost from plan
    const estimatedCost = plan.reduce((sum, row) => {
      const match = row.detail.match(/\((\d+)(?:\+(\d+))?\s*rows?\)/i);
      if (match) {
        return sum + parseInt(match[1], 10);
      }
      return sum;
    }, 0);

    console.log(plan.map(row =>
      `  [${row.id}/${row.parent}] ${row.detail}`
    ).join('\n'));

    console.log(`\nAnalysis:`);
    console.log(`  - Estimated rows to examine: ~${estimatedCost}`);
    console.log(`  - Index usage: ${hasIndexUsage ? '✓ YES' : '✗ NO (FULL SCAN)'}`);

    if (!hasIndexUsage) {
      console.log(`  ⚠ WARNING: Query may benefit from composite index`);
    }
  } catch (error) {
    console.log(`  ✗ Error analyzing query: ${error}`);
  }
}

function getProfileQueries(): QueryInfo[] {
  return [
    // Affiliate Dashboard Queries
    {
      name: 'Affiliate Profile Fetch',
      sql: `SELECT id, email, full_name, role, referral_code, created_at FROM profiles WHERE id = ?`,
      params: ['user-123'],
    },
    {
      name: 'Affiliate Performance Stats',
      sql: `
        SELECT
          p.id as affiliate_id,
          COALESCE(rt.level, 1) as level,
          COALESCE(rt.total_earnings, 0) as lifetime_earnings,
          COALESCE(rt.total_payouts, 0) as lifetime_payouts,
          COALESCE(ap.total_conversions, 0) as total_conversions,
          COALESCE(ap.total_clicks, 0) as total_clicks
        FROM profiles p
        LEFT JOIN referral_tree rt ON p.id = rt.affiliate_id
        LEFT JOIN v_affiliate_performance ap ON ap.affiliate_id = p.id
        WHERE p.id = ?
      `,
      params: ['user-123'],
    },
    {
      name: 'Pending Earnings (Affiliate)',
      sql: `
        SELECT COALESCE(SUM(amount), 0) as pending_earnings
        FROM earnings
        WHERE affiliate_id = ? AND is_paid = 0
      `,
      params: ['user-123'],
    },
    {
      name: 'Recent Payouts (Affiliate)',
      sql: `
        SELECT id, amount, net_amount, status, scheduled_at, paid_at
        FROM payouts
        WHERE affiliate_id = ?
        ORDER BY scheduled_at DESC
        LIMIT 5
      `,
      params: ['user-123'],
    },
    {
      name: 'Referral Tree Query (Path LIKE)',
      sql: `
        SELECT p.id, p.email, p.full_name, rt.level, rt.path,
          COALESCE(rt.total_earnings, 0) as total_earnings,
          COALESCE(ap.total_conversions, 0) as total_conversions
        FROM referral_tree rt
        JOIN profiles p ON p.id = rt.affiliate_id
        LEFT JOIN v_affiliate_performance ap ON ap.affiliate_id = p.id
        WHERE rt.path LIKE ?
      `,
      params: ['user-123,%'],
    },

    // Payouts Admin Queries
    {
      name: 'Pending Earnings Summary (Admin)',
      sql: `
        SELECT COUNT(DISTINCT e.affiliate_id) as affiliate_count,
          SUM(e.amount) as total_amount,
          COUNT(e.id) as earning_count
        FROM earnings e
        WHERE e.is_paid = 0
      `,
    },
    {
      name: 'Pending Earnings by Affiliate (Admin)',
      sql: `
        SELECT e.affiliate_id, SUM(e.amount) as total_amount, COUNT(e.id) as earning_count
        FROM earnings e
        WHERE e.is_paid = 0
        GROUP BY e.affiliate_id
        HAVING total_amount >= 10.00
      `,
    },
    {
      name: 'Top Affiliates by Pending (Admin)',
      sql: `
        SELECT p.id, p.email, p.full_name,
          SUM(e.amount) as pending_amount,
          COUNT(e.id) as pending_earnings
        FROM earnings e
        JOIN profiles p ON e.affiliate_id = p.id
        WHERE e.is_paid = 0
        GROUP BY p.id, p.email, p.full_name
        ORDER BY pending_amount DESC
        LIMIT 10
      `,
    },

    // Deal Analytics Queries
    {
      name: 'Deal Clicks by Date Range',
      sql: `
        SELECT COUNT(*) as click_count
        FROM deal_clicks
        WHERE deal_id = ? AND created_at >= ?
      `,
      params: ['deal-123', '2025-01-01'],
    },
    {
      name: 'Affiliate Clicks Time Series',
      sql: `
        SELECT DATE(created_at) as date, COUNT(*) as clicks
        FROM deal_clicks
        WHERE affiliate_id = ? AND created_at >= ?
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `,
      params: ['user-123', '2025-01-01'],
    },

    // Conversion Queries
    {
      name: 'Affiliate Approved Conversions',
      sql: `
        SELECT COUNT(*) as count, SUM(revenue) as total_revenue
        FROM conversions
        WHERE affiliate_id = ? AND status = 'approved'
      `,
      params: ['user-123'],
    },
    {
      name: 'Affiliate Conversions by Date Range',
      sql: `
        SELECT COUNT(*) as count, SUM(commission_amount) as total_commission
        FROM conversions
        WHERE affiliate_id = ? AND converted_at >= ?
      `,
      params: ['user-123', '2025-01-01'],
    },
  ];
}

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(80));
  console.log('  APEXOS QUERY PERFORMANCE ANALYZER');
  console.log('═'.repeat(80));
  console.log('\nTarget: Profile API queries ≤ 200ms');
  console.log('Current threshold: 288ms (to be optimized)');

  const DB = (globalThis as unknown as { DB: DB }).DB;
  if (!DB) {
    console.error('\n✗ Database not available. Start with: wrangler dev');
    process.exit(1);
  }

  // Show existing indexes
  console.log('\n' + '═'.repeat(80));
  console.log('  EXISTING INDEXES');
  console.log('═'.repeat(80));

  const indexes = await getExistingIndexes(DB);
  const byTable = new Map<string, IndexInfo[]>();
  for (const idx of indexes) {
    const existing = byTable.get(idx.table) || [];
    byTable.set(idx.table, [...existing, idx]);
  }

  for (const [table, tableIndexes] of byTable.entries()) {
    console.log(`\n${table}:`);
    for (const idx of tableIndexes) {
      console.log(`  - ${idx.name}: (${idx.columns.join(', ')})`);
    }
  }

  // Analyze queries
  console.log('\n' + '═'.repeat(80));
  console.log('  QUERY ANALYSIS');
  console.log('═'.repeat(80));

  const queries = getProfileQueries();
  let slowQueries = 0;

  for (const query of queries) {
    await analyzeQuery(DB, query);
    slowQueries++;
  }

  console.log(`\nAnalyzed ${queries.length} queries, ${slowQueries} flagged as slow.`);

  // Recommendations
  console.log('\n' + '═'.repeat(80));
  console.log('  RECOMMENDATIONS');
  console.log('═'.repeat(80));

  console.log(`
If queries show "FULL SCAN" or high estimated row counts:

1. Ensure migration 008 has been applied:
   wrangler d1 execute apex-os-db --file src/database/migrations/008_composite_indexes.sql

2. Critical indexes to verify:
   ✓ idx_deal_clicks_deal_created (deal_id, created_at)
   ✓ idx_conversions_affiliate_converted (affiliate_id, converted_at)
   ✓ idx_conversions_affiliate_status (affiliate_id, status)
   ✓ idx_earnings_affiliate_is_paid (affiliate_id, is_paid)
   ✓ idx_earnings_is_paid_affiliate (is_paid, affiliate_id)
   ✓ idx_payouts_affiliate_status (affiliate_id, status)
   ✓ idx_deal_clicks_affiliate_created (affiliate_id, created_at)

3. Re-run this analysis after applying indexes to verify improvement.

4. For queries with LIKE '%pattern%' (non-prefix), consider:
   - Application-level caching
   - Full-text search (FTS5) if needed for search features

5. Monitor actual query times in production:
   - Add query timing middleware
   - Use Cloudflare Analytics for D1
`);

  console.log('═'.repeat(80) + '\n');
}

main().catch(err => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
