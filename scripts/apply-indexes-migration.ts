#!/usr/bin/env tsx
/**
 * ApexOS Database Migration Runner - Migration 008
 *
 * Applies the composite indexes migration and verifies completion.
 *
 * Usage: tsx scripts/apply-indexes-migration.ts
 */

import { DB } from '@/lib/db/d1-adapter';

interface IndexDefinition {
  name: string;
  table: string;
  columns: string[];
}

const EXPECTED_INDEXES: IndexDefinition[] = [
  { name: 'idx_deal_clicks_deal_created', table: 'deal_clicks', columns: ['deal_id', 'created_at'] },
  { name: 'idx_conversions_affiliate_converted', table: 'conversions', columns: ['affiliate_id', 'converted_at'] },
  { name: 'idx_conversions_affiliate_status', table: 'conversions', columns: ['affiliate_id', 'status'] },
  { name: 'idx_earnings_affiliate_is_paid', table: 'earnings', columns: ['affiliate_id', 'is_paid'] },
  { name: 'idx_earnings_is_paid_affiliate', table: 'earnings', columns: ['is_paid', 'affiliate_id'] },
  { name: 'idx_earnings_conversion_affiliate', table: 'earnings', columns: ['conversion_id', 'affiliate_id'] },
  { name: 'idx_payouts_affiliate_status', table: 'payouts', columns: ['affiliate_id', 'status'] },
  { name: 'idx_deal_clicks_affiliate_created', table: 'deal_clicks', columns: ['affiliate_id', 'created_at'] },
];

async function getExistingIndexes(DB: DB): Promise<Map<string, IndexDefinition>> {
  const result = await DB.prepare(`
    SELECT name, tbl_name as table, sql as definition
    FROM sqlite_master
    WHERE type = 'index'
      AND name LIKE 'idx_%'
  `).all<{ name: string; table: string; definition: string }>();

  const indexes = new Map<string, IndexDefinition>();
  for (const idx of result.results) {
    const match = idx.definition.match(/ON\s+\w+\s*\(([^)]+)\)/);
    const columns = match ? match[1].split(',').map(c => c.trim()) : [];
    indexes.set(idx.name, {
      name: idx.name,
      table: idx.table,
      columns,
    });
  }
  return indexes;
}

async function applyMigration(DB: DB): Promise<void> {
  console.log('Applying migration 008...');

  // Read and execute the migration SQL
  const migrationSQL = `
-- Migration 008: Composite Indexes for Profile API

CREATE INDEX IF NOT EXISTS idx_deal_clicks_deal_created
ON deal_clicks(deal_id, created_at);

CREATE INDEX IF NOT EXISTS idx_conversions_affiliate_converted
ON conversions(affiliate_id, converted_at);

CREATE INDEX IF NOT EXISTS idx_conversions_affiliate_status
ON conversions(affiliate_id, status);

CREATE INDEX IF NOT EXISTS idx_earnings_affiliate_is_paid
ON earnings(affiliate_id, is_paid);

CREATE INDEX IF NOT EXISTS idx_earnings_is_paid_affiliate
ON earnings(is_paid, affiliate_id);

CREATE INDEX IF NOT EXISTS idx_earnings_conversion_affiliate
ON earnings(conversion_id, affiliate_id);

CREATE INDEX IF NOT EXISTS idx_payouts_affiliate_status
ON payouts(affiliate_id, status);

CREATE INDEX IF NOT EXISTS idx_deal_clicks_affiliate_created
ON deal_clicks(affiliate_id, created_at);

SELECT 'Migration 008: Composite indexes added' as status;
`;

  try {
    await DB.exec(migrationSQL);
    console.log('✓ Migration applied successfully');
  } catch (error) {
    console.error('✗ Migration failed:', error);
    throw error;
  }
}

async function verifyIndexes(DB: DB): Promise<{ passed: number; total: number; missing: string[] }> {
  console.log('\nVerifying indexes...');

  const existingIndexes = await getExistingIndexes(DB);
  const missing: string[] = [];

  for (const expected of EXPECTED_INDEXES) {
    const existing = existingIndexes.get(expected.name);
    if (!existing) {
      missing.push(expected.name);
      continue;
    }

    // Verify columns match
    const columnsMatch =
      existing.columns.length === expected.columns.length &&
      existing.columns.every((col, i) => col === expected.columns[i]);

    if (!columnsMatch) {
      console.log(`  ⚠ Index ${expected.name} exists but columns differ:`);
      console.log(`    Expected: ${expected.columns.join(', ')}`);
      console.log(`    Actual: ${existing.columns.join(', ')}`);
      missing.push(expected.name + ' (column mismatch)');
    }
  }

  const passed = EXPECTED_INDEXES.length - missing.length;
  return { passed, total: EXPECTED_INDEXES.length, missing };
}

async function measureQueryPerformance(DB: DB): Promise<void> {
  console.log('\nMeasuring sample query performance...\n');

  const testQueries = [
    {
      name: 'Affiliate pending earnings',
      sql: `SELECT COALESCE(SUM(amount), 0) as pending FROM earnings WHERE affiliate_id = ? AND is_paid = 0`,
      params: ['test-affiliate-id'],
    },
    {
      name: 'Pending payouts summary',
      sql: `SELECT COUNT(DISTINCT affiliate_id) as count, SUM(amount) as total FROM earnings WHERE is_paid = 0`,
    },
    {
      name: 'Deal clicks time range',
      sql: `SELECT COUNT(*) as count FROM deal_clicks WHERE deal_id = ? AND created_at >= ?`,
      params: ['test-deal-id', '2025-01-01'],
    },
  ];

  for (const query of testQueries) {
    const start = performance.now();
    try {
      await DB.prepare(query.sql).bind(...(query.params || [])).all();
      const duration = performance.now() - start;
      const status = duration <= 200 ? '✓' : duration <= 300 ? '⚠' : '✗';
      console.log(`  ${status} ${query.name}: ${duration.toFixed(2)}ms`);
    } catch (error) {
      console.log(`  ✗ ${query.name}: ERROR - ${error}`);
    }
  }
}

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(70));
  console.log('  APEXOS INDEX MIGRATION RUNNER (Migration 008)');
  console.log('═'.repeat(70));

  const DB = (globalThis as unknown as { DB: DB }).DB;
  if (!DB) {
    console.error('\n✗ Database not available.');
    console.error('Start the app with: wrangler dev');
    process.exit(1);
  }

  try {
    // Apply migration
    await applyMigration(DB);

    // Verify indexes
    const { passed, total, missing } = await verifyIndexes(DB);
    console.log(`\nIndex verification: ${passed}/${total} indexes present`);

    if (missing.length > 0) {
      console.log('\nMissing indexes:');
      for (const name of missing) {
        console.log(`  ✗ ${name}`);
      }
    } else {
      console.log('✓ All expected indexes are present');
    }

    // Measure performance
    await measureQueryPerformance(DB);

    // Summary
    console.log('\n' + '═'.repeat(70));
    console.log('  SUMMARY');
    console.log('═'.repeat(70));

    if (missing.length === 0) {
      console.log('\n✓ Migration completed successfully!');
      console.log('\nNext steps:');
      console.log('  1. Run: tsx scripts/analyze-query-performance.ts');
      console.log('  2. Test Profile API endpoints:');
      console.log('     - GET /api/affiliate/dashboard');
      console.log('     - GET /api/payouts/run');
      console.log('  3. Verify response times are ≤200ms');
      console.log('  4. Check production metrics after deployment');
    } else {
      console.log(`\n⚠ ${missing.length} indexes still missing. Check migration logs.`);
      process.exit(1);
    }

    console.log('\n' + '═'.repeat(70) + '\n');

  } catch (error) {
    console.error('\n✗ Migration runner failed:', error);
    process.exit(1);
  }
}

// Type assertion for global DB - ensure DB is available globally
void (globalThis as unknown as { DB: typeof DB }).DB;

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
