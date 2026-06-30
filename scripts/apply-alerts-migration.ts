#!/usr/bin/env ts-node
/**
 * Apply the alerts table migration to D1 database
 *
 * Usage:
 *   npx tsx scripts/apply-alerts-migration.ts [--database <name>]
 *
 * Options:
 *   --database   Database binding name (default: DB)
 *   --staging    Apply to staging database instead
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..', '..');

async function main() {
  // Simple argument parsing
  const args = process.argv.slice(2);
  let databaseName = 'DB';
  let isStaging = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--database' && args[i + 1]) {
      databaseName = args[i + 1];
    }
    if (args[i] === '--staging') {
      isStaging = true;
      databaseName = 'apex_os_staging_db';
    }
  }

  console.log(`Applying alerts table migration to ${isStaging ? 'staging' : 'production'} database...`);

  try {
    // Get the database binding from globalThis (set by worker wrapper)
    // @ts-expect-error - D1 binding
    const db = globalThis[databaseName];
    if (!db) {
      throw new Error(`Database binding '${databaseName}' not found. Make sure you're running within the Worker context.`);
    }

    // Read migration file
    const migrationPath = join(__dirname, 'src', 'database', 'migrations', '014_alerts_table.sql');
    const migrationSQL = await readFile(migrationPath, 'utf-8');

    // Execute migration
    const result = await db.exec(migrationSQL);

    console.log('Migration applied successfully:');
    console.log(`  - Rows affected: ${result.meta?.changes || 'N/A'}`);
    console.log('');
    console.log('Alerts table and indexes are now ready.');
    console.log('Retention policy: 90 days for resolved alerts.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);
