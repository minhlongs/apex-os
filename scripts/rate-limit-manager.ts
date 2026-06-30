/**
 * Rate Limit Management Script
 *
 * Run this script to:
 * - Initialize default rate limit configurations
 * - Clean up expired rate limit entries
 * - View current rate limit statistics
 *
 * Usage:
 * ```bash
 * # Initialize default configs
 * pnpm run rate-limit:init
 *
 * # Clean up expired entries
 * pnpm run rate-limit:cleanup
 *
 * # View statistics
 * pnpm run rate-limit:stats
 *
 * # Reset a specific limit
 * pnpm run rate-limit:reset -- --endpoint click_tracking --identifier 192.168.1.1
 * ```
 */

import { argv } from 'node:process';

// Simple D1 wrapper for scripts
interface ScriptDB {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T = unknown>(): T | null;
      all<T = unknown>(): { results: T[] };
      run(): { success: boolean; changes: number };
    };
  };
}

// Get database from environment (Wrangler dev sets this)
function getDB(): ScriptDB | null {
  return (globalThis as { DB?: ScriptDB }).DB;
}

async function initRateLimitConfigs(db: ScriptDB): Promise<void> {
  console.log('Initializing rate limit configurations...');

  const result = await db.prepare(`
    INSERT OR REPLACE INTO rate_limit_configs (
      endpoint_type, max_requests, window_seconds, applies_to,
      role_multiplier, tier_multiplier, description, is_active
    ) VALUES
      ('click_tracking', 100, 3600, 'ip', 1.0, 1.0, 'Click tracking - 100 req/hour per IP', 1),
      ('click_tracking', 1000, 3600, 'user', 1.0, 1.0, 'Click tracking - 1000 req/hour per user', 1),
      ('auth', 10, 900, 'ip', 1.0, 1.0, 'Auth - 10 req/15min per IP', 1),
      ('auth', 20, 900, 'user', 1.0, 1.0, 'Auth - 20 req/15min per user', 1),
      ('api_general', 500, 3600, 'ip', 1.0, 1.0, 'General API - 500 req/hour per IP', 1),
      ('api_general', 2000, 3600, 'user', 1.0, 1.0, 'General API - 2000 req/hour per user', 1),
      ('api_general', 5000, 3600, 'user', 1.0, 2.5, 'Premium tier - 2.5x multiplier', 1),
      ('webhook', 1000, 3600, 'ip', 1.0, 1.0, 'Webhook - 1000 req/hour per IP', 1),
      ('webhook', 10000, 3600, 'user', 1.0, 1.0, 'Webhook - 10000 req/hour per user', 1),
      ('admin', 100, 3600, 'ip', 1.0, 1.0, 'Admin - 100 req/hour per IP', 1),
      ('admin', 500, 3600, 'user', 1.0, 1.0, 'Admin - 500 req/hour per admin', 1)
  `).run();

  console.log(`Rate limit configs initialized: ${result.changes} rows affected`);
}

async function cleanupExpired(db: ScriptDB): Promise<void> {
  console.log('Cleaning up expired rate limit entries...');

  const result = await db.prepare(
    'DELETE FROM rate_limits WHERE reset_at < datetime("now")'
  ).run();

  console.log(`Cleaned up ${result.changes} expired rate limit entries`);
}

async function showStats(db: ScriptDB): Promise<void> {
  console.log('\n=== Rate Limit Statistics ===\n');

  // Active limits
  const active = await db.prepare(`
    SELECT endpoint_type, COUNT(*) as count,
           ROUND(AVG(current_count * 100.0 / max_count), 2) as avg_utilization
    FROM rate_limits
    WHERE reset_at > datetime('now')
    GROUP BY endpoint_type
    ORDER BY avg_utilization DESC
  `).all<{ endpoint_type: string; count: number; avg_utilization: number }>();

  if (active.results.length > 0) {
    console.log('Active Rate Limits by Type:');
    for (const row of active.results) {
      console.log(`  ${row.endpoint_type}: ${row.count} keys, avg ${row.avg_utilization}% utilized`);
    }
  } else {
    console.log('No active rate limits');
  }

  console.log('');

  // Near limit warnings
  const nearLimit = await db.prepare(`
    SELECT key, endpoint_type, identifier, current_count, max_count,
           ROUND((current_count * 100.0 / max_count), 2) as utilization
    FROM rate_limits
    WHERE reset_at > datetime('now')
      AND (current_count * 1.0 / max_count) > 0.8
    ORDER BY utilization DESC
    LIMIT 10
  `).all<{ key: string; endpoint_type: string; identifier: string; current_count: number; max_count: number; utilization: number }>();

  if (nearLimit.results.length > 0) {
    console.log('Near Limit Warnings (>80%):');
    for (const row of nearLimit.results) {
      console.log(`  ${row.endpoint_type} | ${row.identifier}: ${row.current_count}/${row.max_count} (${row.utilization}%)`);
    }
  } else {
    console.log('No limits approaching capacity');
  }

  console.log('\n=== End Stats ===\n');
}

async function resetLimit(db: ScriptDB, endpointType: string, identifier: string): Promise<void> {
  const key = `${endpointType}|${identifier}`;
  const result = await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();

  if (result.changes > 0) {
    console.log(`Reset rate limit for ${endpointType}:${identifier}`);
  } else {
    console.log(`No rate limit found for ${endpointType}:${identifier}`);
  }
}

async function main(): Promise<void> {
  const db = getDB();
  if (!db) {
    console.error('Database not available. Run with wrangler dev or set globalThis.DB');
    process.exit(1);
  }

  const command = argv[2];

  switch (command) {
    case 'init':
      await initRateLimitConfigs(db);
      break;

    case 'cleanup':
      await cleanupExpired(db);
      break;

    case 'stats':
      await showStats(db);
      break;

    case 'reset':
      const endpoint = argv.find(a => a.startsWith('--endpoint='))?.split('=')[1];
      const ident = argv.find(a => a.startsWith('--identifier='))?.split('=')[1];
      if (!endpoint || !ident) {
        console.error('Usage: rate-limit:reset --endpoint=click_tracking --identifier=192.168.1.1');
        process.exit(1);
      }
      await resetLimit(db, endpoint, ident);
      break;

    default:
      console.log(`
Rate Limit Management Script

Commands:
  init       Initialize default rate limit configurations
  cleanup    Remove expired rate limit entries
  stats      Show rate limit statistics
  reset      Reset a specific rate limit (use --endpoint and --identifier flags)

Examples:
  pnpm run rate-limit:init
  pnpm run rate-limit:stats
  pnpm run rate-limit:reset -- --endpoint=click_tracking --identifier=192.168.1.1
      `);
  }
}

main().catch(console.error);
