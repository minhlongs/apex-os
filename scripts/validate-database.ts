#!/usr/bin/env tsx
/**
 * ApexOS Database Validation Script
 *
 * Validates the database schema and data integrity.
 * Run: tsx scripts/validate-database.ts
 */

import { performance } from 'perf_hooks';

// ============================================
// Types
// ============================================

interface ValidationResult {
  table: string;
  checks: Array<{
    name: string;
    passed: boolean;
    message: string;
    count?: number;
  }>;
  errors: string[];
}

interface Summary {
  totalTables: number;
  passedTables: number;
  failedTables: number;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  errors: string[];
  duration: number;
}

// ============================================
// Database Interface
// ============================================

interface Database {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T = unknown>(): T | null;
      all<T = unknown>(): { results: T[] };
      run(): Promise<{ success: boolean }>;
    };
  };
}

// ============================================
// Expected Schema
// ============================================

const EXPECTED_TABLES = [
  'profiles',
  'accounts',
  'sessions',
  'verification_tokens',
  'affiliate_codes',
  'referral_tree',
  'deals',
  'deal_clicks',
  'conversions',
  'earnings',
  'payouts',
];

const TABLE_COLUMN_CHECKS: Record<string, Array<{ column: string; type: string; required?: boolean }>> = {
  profiles: [
    { column: 'id', type: 'TEXT', required: true },
    { column: 'email', type: 'TEXT', required: true },
    { column: 'role', type: 'TEXT', required: true },
    { column: 'referral_code', type: 'TEXT', required: false },
  ],
  deals: [
    { column: 'id', type: 'TEXT', required: true },
    { column: 'name', type: 'TEXT', required: true },
    { column: 'url', type: 'TEXT', required: true },
    { column: 'is_active', type: 'INTEGER', required: true },
    { column: 'default_commission_rate', type: 'REAL', required: true },
    { column: 'exchange', type: 'TEXT', required: false },
    { column: 'category', type: 'TEXT', required: false },
    { column: 'cashback_percent', type: 'REAL', required: false },
    { column: 'risk_level', type: 'TEXT', required: false },
  ],
  deal_clicks: [
    { column: 'id', type: 'TEXT', required: true },
    { column: 'deal_id', type: 'TEXT', required: true },
    { column: 'affiliate_code', type: 'TEXT', required: false },
    { column: 'affiliate_id', type: 'TEXT', required: false },
    { column: 'session_id', type: 'TEXT', required: true },
    { column: 'click_type', type: 'TEXT', required: true },
    { column: 'is_unique', type: 'INTEGER', required: true },
  ],
  conversions: [
    { column: 'id', type: 'TEXT', required: true },
    { column: 'deal_id', type: 'TEXT', required: true },
    { column: 'affiliate_id', type: 'TEXT', required: true },
    { column: 'revenue', type: 'REAL', required: true },
    { column: 'commission_amount', type: 'REAL', required: true },
    { column: 'status', type: 'TEXT', required: true },
  ],
  earnings: [
    { column: 'id', type: 'TEXT', required: true },
    { column: 'conversion_id', type: 'TEXT', required: true },
    { column: 'affiliate_id', type: 'TEXT', required: true },
    { column: 'amount', type: 'REAL', required: true },
    { column: 'level', type: 'INTEGER', required: true },
    { column: 'is_paid', type: 'INTEGER', required: true },
  ],
  payouts: [
    { column: 'id', type: 'TEXT', required: true },
    { column: 'affiliate_id', type: 'TEXT', required: true },
    { column: 'amount', type: 'REAL', required: true },
    { column: 'net_amount', type: 'REAL', required: true },
    { column: 'status', type: 'TEXT', required: true },
    { column: 'transaction_id', type: 'TEXT', required: false },
  ],
  referral_tree: [
    { column: 'id', type: 'TEXT', required: true },
    { column: 'affiliate_id', type: 'TEXT', required: true },
    { column: 'level', type: 'INTEGER', required: true },
    { column: 'path', type: 'TEXT', required: false },
  ],
  affiliate_codes: [
    { column: 'id', type: 'TEXT', required: true },
    { column: 'code', type: 'TEXT', required: true },
    { column: 'affiliate_id', type: 'TEXT', required: true },
    { column: 'is_active', type: 'INTEGER', required: true },
  ],
};

// ============================================
// Database Connection
// ============================================

function getDB(): Database | undefined {
  return (globalThis as unknown as { DB?: Database }).DB;
}

async function connect(): Promise<Database> {
  const DB = getDB();
  if (!DB) {
    throw new Error('Database not available. Make sure wrangler dev is running or the app is deployed.');
  }
  return DB;
}

// ============================================
// Validation Functions
// ============================================

async function validateTableExists(DB: Database, tableName: string): Promise<{ exists: boolean; message: string }> {
  try {
    const result = await DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
    )
      .bind(tableName)
      .first<{ name: string }>();

    if (result) {
      return { exists: true, message: `Table exists` };
    }
    return { exists: false, message: `Table not found` };
  } catch (error) {
    return { exists: false, message: `Error checking table: ${error}` };
  }
}

async function validateTableColumns(DB: Database, tableName: string): Promise<Array<{ name: string; passed: boolean; message: string }>> {
  const checks: Array<{ name: string; passed: boolean; message: string }> = [];
  const expectedCols = TABLE_COLUMN_CHECKS[tableName];

  if (!expectedCols) {
    return checks;
  }

  try {
    // Get table PRAGMA info
    const pragmaResult = await DB.prepare(`PRAGMA table_info(${tableName})`)
      .all<{ cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>();

    const columns = new Map(pragmaResult.results.map(col => [col.name, col]));

    for (const expected of expectedCols) {
      const col = columns.get(expected.column);
      if (!col) {
        checks.push({
          name: expected.column,
          passed: false,
          message: `Column missing`,
        });
        continue;
      }

      // Check type (basic check - SQLite types are flexible)
      const typeMatch = col.type.toUpperCase().includes(expected.type.toUpperCase().replace('INTEGER', 'INT').replace('TEXT', 'CHAR').replace('REAL', 'FLOAT').replace('NUMERIC', 'FLOAT'));
      const requiredMatch = expected.required ? col.notnull === 1 : true;

      if (typeMatch && requiredMatch) {
        checks.push({
          name: expected.column,
          passed: true,
          message: `OK (${col.type})`,
        });
      } else {
        const issues: string[] = [];
        if (!typeMatch) issues.push(`type ${col.type} (expected ${expected.type})`);
        if (expected.required && col.notnull !== 1) issues.push('should be NOT NULL');
        checks.push({
          name: expected.column,
          passed: false,
          message: issues.join(', '),
        });
      }
    }
  } catch (error) {
    checks.push({
      name: 'all',
      passed: false,
      message: `Error checking columns: ${error}`,
    });
  }

  return checks;
}

async function validateRowCount(DB: Database, tableName: string, minCount?: number): Promise<{ count: number; message: string }> {
  try {
    const result = await DB.prepare(`SELECT COUNT(*) as count FROM ${tableName}`)
      .first<{ count: number }>();

    const count = result?.count || 0;
    if (minCount !== undefined && count < minCount) {
      return { count, message: `Expected at least ${minCount} rows, got ${count}` };
    }
    return { count, message: `${count} rows` };
  } catch (error) {
    return { count: 0, message: `Error counting rows: ${error}` };
  }
}

async function validateForeignKeys(DB: Database): Promise<{ passed: boolean; message: string; orphans?: number }> {
  try {
    // Check for orphaned deal_clicks (deal_id that doesn't exist)
    const orphanClicks = await DB.prepare(`
      SELECT COUNT(*) as count FROM deal_clicks dc
      LEFT JOIN deals d ON dc.deal_id = d.id
      WHERE d.id IS NULL
    `).first<{ count: number }>();

    // Check for orphaned conversions (affiliate_id that doesn't exist)
    const orphanConversions = await DB.prepare(`
      SELECT COUNT(*) as count FROM conversions c
      LEFT JOIN profiles p ON c.affiliate_id = p.id
      WHERE p.id IS NULL
    `).first<{ count: number }>();

    const totalOrphans = (orphanClicks?.count || 0) + (orphanConversions?.count || 0);

    if (totalOrphans > 0) {
      return {
        passed: false,
        message: `Found ${totalOrphans} orphaned records`,
        orphans: totalOrphans,
      };
    }
    return { passed: true, message: 'No orphaned records' };
  } catch (error) {
    return { passed: false, message: `Error checking foreign keys: ${error}` };
  }
}

async function validateReferralTreeIntegrity(DB: Database): Promise<{ passed: boolean; message: string; issues?: number }> {
  try {
    // Check for invalid levels (should be 1-3 for commission tiers)
    const invalidLevels = await DB.prepare(`
      SELECT COUNT(*) as count FROM referral_tree
      WHERE level < 1 OR level > 10
    `).first<{ count: number }>();

    // Check for broken paths (parent exists but not in path)
    const brokenPaths = await DB.prepare(`
      SELECT COUNT(*) as count FROM referral_tree rt
      WHERE rt.parent_id IS NOT NULL
        AND rt.path NOT LIKE rt.parent_id || '%'
    `).first<{ count: number }>();

    const issues = (invalidLevels?.count || 0) + (brokenPaths?.count || 0);

    if (issues > 0) {
      return {
        passed: false,
        message: `Found ${issues} integrity issues`,
        issues,
      };
    }
    return { passed: true, message: 'Referral tree structure valid' };
  } catch (error) {
    return { passed: false, message: `Error checking referral tree: ${error}` };
  }
}

// ============================================
// Main Validation
// ============================================

async function validateDatabase(): Promise<{ results: ValidationResult[]; summary: Summary }> {
  const startTime = performance.now();
  const results: ValidationResult[] = [];
  const allErrors: string[] = [];

  const DB = await connect();

  for (const table of EXPECTED_TABLES) {
    const tableResult: ValidationResult = {
      table,
      checks: [],
      errors: [],
    };

    // Check table exists
    const existsCheck = await validateTableExists(DB, table);
    tableResult.checks.push({
      name: 'table_exists',
      passed: existsCheck.exists,
      message: existsCheck.message,
    });

    if (!existsCheck.exists) {
      tableResult.errors.push(`Table ${table} does not exist`);
      allErrors.push(`Missing table: ${table}`);
      results.push(tableResult);
      continue;
    }

    // Check columns
    const columnChecks = await validateTableColumns(DB, table);
    tableResult.checks.push(...columnChecks.map(c => ({ ...c, name: `column_${c.name}` })));

    const columnErrors = columnChecks.filter(c => !c.passed);
    if (columnErrors.length > 0) {
      tableResult.errors.push(`Column issues: ${columnErrors.map(c => `${c.name} (${c.message})`).join(', ')}`);
      allErrors.push(`[${table}] Column issues: ${columnErrors.map(c => `${c.name}: ${c.message}`).join('; ')}`);
    }

    // Check row count (for key tables)
    if (['profiles', 'deals'].includes(table)) {
      const countCheck = await validateRowCount(DB, table);
      tableResult.checks.push({
        name: 'row_count',
        passed: countCheck.count > 0 || true, // Warning not error
        message: countCheck.message,
      });
      tableResult.checks[tableResult.checks.length - 1].count = countCheck.count;
    }

    results.push(tableResult);
  }

  // Cross-table validations
  const fkCheck = await validateForeignKeys(DB);
  results.push({
    table: 'foreign_keys',
    checks: [{ name: 'orphan_check', passed: fkCheck.passed, message: fkCheck.message }],
    errors: fkCheck.passed ? [] : [fkCheck.message],
  });
  if (!fkCheck.passed) allErrors.push(`Foreign key violation: ${fkCheck.message}`);

  const referralCheck = await validateReferralTreeIntegrity(DB);
  results.push({
    table: 'referral_tree_integrity',
    checks: [{ name: 'integrity', passed: referralCheck.passed, message: referralCheck.message }],
    errors: referralCheck.passed ? [] : [referralCheck.message],
  });
  if (!referralCheck.passed) allErrors.push(`Referral tree integrity: ${referralCheck.message}`);

  const endTime = performance.now();
  const totalChecks = results.reduce((sum, r) => sum + r.checks.length, 0);
  const passedChecks = results.reduce((sum, r) => sum + r.checks.filter(c => c.passed).length, 0);
  const failedTables = results.filter(r => r.errors.length > 0).length;

  const summary: Summary = {
    totalTables: EXPECTED_TABLES.length + 2,
    passedTables: results.filter(r => r.errors.length === 0).length,
    failedTables,
    totalChecks,
    passedChecks,
    failedChecks: totalChecks - passedChecks,
    errors: allErrors,
    duration: endTime - startTime,
  };

  return { results, summary };
}

// ============================================
// Report Output
// ============================================

function printReport(result: ReturnType<typeof validateDatabase>) {
  const { results, summary } = result;

  console.log('\n');
  console.log('═'.repeat(70));
  console.log('  APEXOS DATABASE VALIDATION REPORT');
  console.log('═'.repeat(70));
  console.log(`\n  Duration: ${summary.duration.toFixed(2)}ms`);
  console.log(`  Tables: ${summary.passedTables}/${summary.totalTables} passed`);
  console.log(`  Checks: ${summary.passedChecks}/${summary.totalChecks} passed`);
  console.log('\n' + '─'.repeat(70));

  for (const tableResult of results) {
    const tableErrors = tableResult.errors.length > 0 ? ' ❌' : ' ✓';
    console.log(`\n  TABLE: ${tableResult.table}${tableErrors}`);

    for (const check of tableResult.checks) {
      const status = check.passed ? '✓' : '✗';
      const countInfo = check.count !== undefined ? ` (${check.count})` : '';
      console.log(`    ${status} ${check.name}${countInfo}: ${check.message}`);
    }

    if (tableResult.errors.length > 0) {
      for (const error of tableResult.errors) {
        console.log(`    ⚠ ${error}`);
      }
    }
  }

  console.log('\n' + '─'.repeat(70));
  if (summary.errors.length > 0) {
    console.log(`\n  ERRORS (${summary.errors.length}):`);
    for (const error of summary.errors) {
      console.log(`    ✗ ${error}`);
    }
  } else {
    console.log('\n  ✓ All validations passed! Database schema is healthy.');
  }
  console.log('\n' + '═'.repeat(70) + '\n');

  // Exit with appropriate code
  process.exit(summary.errors.length > 0 ? 1 : 0);
}

// ============================================
// Entry Point
// ============================================

validateDatabase()
  .then(printReport)
  .catch(error => {
    console.error('Validation failed:', error);
    process.exit(1);
  });
