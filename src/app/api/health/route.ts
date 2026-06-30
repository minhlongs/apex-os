import { NextRequest, NextResponse } from 'next/server';

/**
 * Health check response type
 */

interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  environment: 'development' | 'production' | 'test';
  uptime: number;
  version: string;
  responseTime: number;
  checks: {
    database: 'connected' | 'error' | 'not_configured' | 'unknown';
    kv: 'connected' | 'error' | 'not_configured' | 'unknown';
  };
  memory?: {
    rss: string;
    heapTotal: string;
    heapUsed: string;
  };
}

/**
 * Health check endpoint for monitoring and deployment verification
 *
 * Used by:
 * - Cloudflare Pages deployment verification
 * - Uptime monitoring (UptimeRobot, Pingdom)
 * - Load balancer health checks
 * - DNS cutover verification
 *
 * Returns JSON with application status and component health
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const env = process.env.NODE_ENV || 'development';

  // Build health response with proper typing
  const health: HealthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: env as 'development' | 'production' | 'test',
    uptime: process.uptime(),
    version: process.env.npm_package_version || 'unknown',
    checks: {
      database: 'unknown',
      kv: 'unknown',
    },
    responseTime: 0,
  };

  // Check database connectivity
  try {
    // @ts-ignore - D1 binding from wrangler.toml
    if (typeof DB !== 'undefined') {
      // Quick query to test DB connection
      // @ts-ignore
      const result = await DB.prepare('SELECT 1 as health_check').first();
      health.checks.database = result?.health_check === 1 ? 'connected' : 'error';
    } else {
      health.checks.database = 'not_configured';
    }
  } catch (error) {
    health.checks.database = 'error';
    health.status = 'degraded';
  }

  // Check KV connectivity
  try {
    // @ts-ignore - KV binding from wrangler.toml (Cloudflare specific)
    if (typeof KV !== 'undefined' && KV.get) {
      // @ts-ignore - KV.get is a Cloudflare Workers binding
      await KV.get('health-check-test', 'text');
      health.checks.kv = 'connected';
    } else {
      health.checks.kv = 'not_configured';
    }
  } catch {
    health.checks.kv = 'error';
  }

  // Check memory usage (if process.memoryUsage available)
  if (typeof process !== 'undefined' && process.memoryUsage) {
    const memory = process.memoryUsage();
    health.memory = {
      rss: `${Math.round(memory.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memory.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
    };
  }

  // Response time
  health.responseTime = Date.now() - startTime;

  // Return appropriate status code
  const statusCode = health.status === 'ok' ? 200 : 503;

  return NextResponse.json(health, { status: statusCode });
}
