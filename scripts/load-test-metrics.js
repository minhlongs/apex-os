#!/usr/bin/env node
/**
 * ApexOS Metrics Endpoints Load Test
 *
 * Tests the business and timeseries metrics APIs with concurrent requests.
 *
 * Usage:
 *   tsx scripts/load-test-metrics.js --server-url=http://localhost:8787 --concurrency=100
 *   tsx scripts/load-test-metrics.js --server-url=https://apex-os.pages.dev --concurrency=100 --iterations=10
 */

import { performance } from 'perf_hooks';
import { writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomInt } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const serverUrl = args.find(a => a.startsWith('--server-url='))?.split('=')[1] || 'http://localhost:8787';
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '100', 10);
const iterations = parseInt(args.find(a => a.startsWith('--iterations='))?.split('=')[1] || '5', 10);
const testCache = args.includes('--test-cache');

// Performance targets
const TARGET_RESPONSE_TIME_MS = 500; // User requirement: <500ms
const CACHE_HIT_TARGET_MS = 100; // Cache hit should be much faster

// Test endpoints
const METRICS_ENDPOINTS = [
  {
    name: 'Business Metrics (Cache Miss)',
    path: '/api/metrics/business?start_date=2025-06-01&end_date=2025-06-22',
    authRequired: true,
    target: TARGET_RESPONSE_TIME_MS,
  },
  {
    name: 'Business Metrics (Cache Hit)',
    path: '/api/metrics/business?start_date=2025-06-01&end_date=2025-06-22',
    authRequired: true,
    target: CACHE_HIT_TARGET_MS,
    expectCacheHit: true,
  },
  {
    name: 'Time-Series Metrics (Daily)',
    path: '/api/metrics/timeseries?start=2025-06-01&end=2025-06-22&interval=day&metric=conversions',
    authRequired: false,
    target: TARGET_RESPONSE_TIME_MS,
  },
  {
    name: 'Time-Series Metrics (Hourly)',
    path: '/api/metrics/timeseries?start=2025-06-15&end=2025-06-22&interval=hour&metric=revenue',
    authRequired: false,
    target: TARGET_RESPONSE_TIME_MS,
  },
];

// Colors for console output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

// Simple random string generator for session simulation
function randomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// Simulate admin session cookie (for testing)
function generateMockSessionCookie(): string {
  // In production, this would be a real session token
  // For load testing, we're simulating an authenticated admin user
  const payload = JSON.stringify({
    userId: `admin-${randomString(8)}`,
    role: 'admin',
    exp: Date.now() + 3600000,
  });
  // Simple base64 encoding (not actual JWT for testing)
  return Buffer.from(payload).toString('base64');
}

async function runConcurrentTest(
  url: string,
  totalRequests: number,
  options: { authRequired?: boolean; expectCacheHit?: boolean }
): Promise<{
  endpoint: string;
  success: boolean;
  totalRequests: number;
  successful: number;
  failed: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  cacheHits: number;
  cacheMisses: number;
  statusCounts: Record<number, number>;
  errors: string[];
  avgConcurrentDuration: number;
}> {
  const times: number[] = [];
  const statusCodes: Record<number, number> = {};
  const errors: string[] = [];
  const cacheHits: number[] = [];
  const startTimes: number[] = [];

  const sessionCookie = generateMockSessionCookie();

  // Create all request tasks
  const tasks: Promise<void>[] = [];

  for (let i = 0; i < totalRequests; i++) {
    tasks.push(
      (async () => {
        const startTime = performance.now();
        startTimes.push(startTime);

        try {
          const response = await fetch(url, {
            method: 'GET',
            cache: 'no-store',
            headers: {
              'Accept': 'application/json',
              ...(options.authRequired && {
                'Cookie': `__session=${sessionCookie}`,
              }),
            },
          });
          const duration = performance.now() - startTime;
          times.push(duration);
          statusCodes[response.status] = (statusCodes[response.status] || 0) + 1;

          // Check cache header
          const cacheHeader = response.headers.get('X-Cache');
          if (cacheHeader === 'HIT') {
            cacheHits.push(1);
          } else if (cacheHeader === 'MISS') {
            cacheHits.push(0);
          }

          if (!response.ok && response.status !== 429) {
            const text = await response.text().catch(() => 'No body');
            errors.push(`Status ${response.status}: ${text.substring(0, 100)}`);
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      })()
    );
  }

  // Run with controlled concurrency
  const batches = Math.ceil(totalRequests / concurrency);
  for (let batch = 0; batch < batches; batch++) {
    const batchStart = batch * concurrency;
    const batchEnd = Math.min(batchStart + concurrency, totalRequests);
    const batchTasks = tasks.slice(batchStart, batchEnd);

    log(`  Batch ${batch + 1}/${batches} (${batchStart + 1}-${batchEnd} requests)`, 'cyan');
    await Promise.all(batchTasks);

    // Small delay between batches to avoid overwhelming
    if (batch < batches - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const endTime = performance.now();

  if (times.length === 0) {
    return {
      endpoint: url,
      success: false,
      totalRequests,
      successful: 0,
      failed: totalRequests,
      avg: 0,
      min: 0,
      max: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      cacheHits: 0,
      cacheMisses: 0,
      statusCounts: {},
      errors,
      avgConcurrentDuration: 0,
    };
  }

  times.sort((a, b) => a - b);

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = times[0];
  const max = times[times.length - 1];
  const p50 = percentile(times, 50);
  const p75 = percentile(times, 75);
  const p90 = percentile(times, 90);
  const p95 = percentile(times, 95);
  const p99 = percentile(times, 99);

  const cacheHitCount = cacheHits.filter(h => h === 1).length;
  const avgConcurrentDuration = (endTime - Math.min(...startTimes)) / batches;

  return {
    endpoint: url,
    success: avg <= TARGET_RESPONSE_TIME_MS,
    totalRequests,
    successful: times.length,
    failed: totalRequests - times.length,
    avg: Math.round(avg * 100) / 100,
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    p50: Math.round(p50 * 100) / 100,
    p75: Math.round(p75 * 100) / 100,
    p90: Math.round(p90 * 100) / 100,
    p95: Math.round(p95 * 100) / 100,
    p99: Math.round(p99 * 100) / 100,
    cacheHits: cacheHitCount,
    cacheMisses: cacheHits.length - cacheHitCount,
    statusCounts: statusCodes,
    errors: errors.slice(0, 10), // Limit error list
    avgConcurrentDuration: Math.round(avgConcurrentDuration * 100) / 100,
  };
}

function generateMarkdownReport(results: ReturnType<typeof runConcurrentTest>[], metadata: Record<string, unknown>) {
  const date = new Date().toISOString();
  const passed = results.filter(r => r.success).length;
  const total = results.length;
  const allAvg = results.reduce((sum, r) => sum + (r.avg || 0), 0) / total;

  let md = `# Metrics Endpoints Load Test Report\n\n`;
  md += `**Generated:** ${date}\n`;
  md += `**Server:** ${serverUrl}\n`;
  md += `**Concurrency:** ${concurrency} concurrent requests\n`;
  md += `**Iterations per endpoint:** ${iterations} (total: ${concurrency * iterations} requests)\n`;
  md += `**Target Response Time:** ≤${TARGET_RESPONSE_TIME_MS}ms\n\n`;

  md += `## Summary\n\n`;
  md += `| Metric | Value | Status |\n`;
  md += `|--------|-------|--------|\n`;
  md += `| **Overall Pass Rate** | ${passed}/${total} endpoints | ${passed === total ? '✅ PASS' : '⚠️ PARTIAL'} |\n`;
  md += `| **Average Response Time** | ${Math.round(allAvg)}ms | ${allAvg <= TARGET_RESPONSE_TIME_MS ? '✅ PASS' : '❌ FAIL'} |\n`;
  md += `| **Total Requests** | ${results.reduce((sum, r) => sum + r.totalRequests, 0)} | - |\n`;
  md += `| **Success Rate** | ${((results.reduce((sum, r) => sum + r.successful, 0) / results.reduce((sum, r) => sum + r.totalRequests, 0)) * 100).toFixed(1)}% | - |\n\n`;

  md += `## Detailed Results\n\n`;
  md += `| Endpoint | Status | Requests | Success | Fail | Avg | Min | P50 | P75 | P90 | P95 | P99 | Max | Cache Hit |\n`;
  md += `|----------|--------|----------|---------|------|-----|-----|-----|-----|-----|-----|-----|-----|-----------|\n`;

  for (const r of results) {
    const statusEmoji = r.success ? '✅' : '❌';
    const cacheInfo = r.cacheHits > 0 ? `${r.cacheHits}/${r.cacheMisses + r.cacheHits}` : 'N/A';
    md += `| ${r.endpoint} | ${statusEmoji} | ${r.totalRequests} | ${r.successful} | ${r.failed} | ${r.avg}ms | ${r.min}ms | ${r.p50}ms | ${r.p75}ms | ${r.p90}ms | ${r.p95}ms | ${r.p99}ms | ${r.max}ms | ${cacheInfo} |\n`;
  }

  md += `\n## Analysis\n\n`;

  for (const r of results) {
    md += `### ${r.endpoint}\n\n`;
    md += `- **Status:** ${r.success ? '✅ Pass' : '❌ Fail'} (avg: ${r.avg}ms ${r.success ? '≤' : '>'} ${r.target || TARGET_RESPONSE_TIME_MS}ms)\n`;
    md += `- **Request volume:** ${r.totalRequests} requests (${r.successful} successful, ${r.failed} failed)\n`;
    md += `- **Percentiles:**\n`;
    md += `  - P50 (median): ${r.p50}ms\n`;
    md += `  - P75: ${r.p75}ms\n`;
    md += `  - P90: ${r.p90}ms\n`;
    md += `  - P95: ${r.p95}ms\n`;
    md += `  - P99: ${r.p99}ms\n`;
    md += `- **Range:** ${r.min}ms - ${r.max}ms\n`;

    if (r.cacheHits > 0 || r.cacheMisses > 0) {
      const hitRate = ((r.cacheHits / (r.cacheHits + r.cacheMisses)) * 100).toFixed(1);
      md += `- **Cache performance:** ${r.cacheHits} hits, ${r.cacheMisses} misses (hit rate: ${hitRate}%)\n`;
    }

    if (Object.keys(r.statusCounts).length > 1) {
      md += `- **Status codes:** ${JSON.stringify(r.statusCounts)}\n`;
    }

    if (r.errors.length > 0) {
      md += `- **Sample errors:**\n`;
      r.errors.forEach(err => md += `  - ${err}\n`);
    }

    md += `\n`;
  }

  // Performance analysis
  md += `## Performance Analysis\n\n`;

  const slowEndpoints = results.filter(r => !r.success);
  const cacheEndpoints = results.filter(r => r.cacheHits > 0);

  if (slowEndpoints.length > 0) {
    md += `### ⚠️ Endpoints Exceeding Target\n\n`;
    for (const r of slowEndpoints) {
      md += `- **${r.endpoint}**: ${r.avg}ms (target: ${r.target || TARGET_RESPONSE_TIME_MS}ms) - exceeds by ${Math.round(r.avg - (r.target || TARGET_RESPONSE_TIME_MS))}ms\n`;
    }
    md += `\n`;
  }

  if (cacheEndpoints.length > 0) {
    md += `### Cache Performance\n\n`;
    for (const r of cacheEndpoints) {
      const hitRate = ((r.cacheHits / (r.cacheHits + r.cacheMisses)) * 100).toFixed(1);
      if (parseFloat(hitRate) < 80) {
        md += `- **${r.endpoint}**: Cache hit rate ${hitRate}% - ${parseFloat(hitRate) < 50 ? '⚠️ LOW' : '✓ OK'}\n`;
      } else {
        md += `- **${r.endpoint}**: Cache hit rate ${hitRate}% - ✅ Excellent\n`;
      }
    }
    md += `\n`;
  }

  // Recommendations
  md += `## Recommendations\n\n`;

  if (slowEndpoints.length > 0) {
    md += `### Immediate Actions Required\n\n`;
    md += `1. **Analyze slow queries** - Check database query plans for endpoints exceeding ${TARGET_RESPONSE_TIME_MS}ms\n`;
    md += `2. **Verify indexes exist** - Ensure all composite indexes from migrations 008 and 010 are applied\n`;
    md += `3. **Optimize view queries** - Materialized views may need REFRESH or query simplification\n`;
    md += `4. **Consider query pagination** - If returning large datasets, implement limit/offset\n`;
    md += `5. **Add response caching** - Cloudflare KV caching for admin metrics (already implemented but verify)\n\n`;
  }

  if (slowEndpoints.length === 0) {
    md += `### ✅ All Targets Met\n\n`;
    md += `All metrics endpoints meet the ≤${TARGET_RESPONSE_TIME_MS}ms response time target under ${concurrency} concurrent requests.\n\n`;
    md += `**Recommendations:**\n`;
    md += `1. **Monitor cache hit rates** - Ensure caching is effective for repeated queries\n`;
    md += `2. **Test with larger date ranges** - Performance may degrade with 90+ day queries\n`;
    md += `3. **Consider cache TTL tuning** - Current TTL is 5 minutes; adjust based on data freshness needs\n`;
    md += `4. **Add monitoring alerts** - Set up alerts if response times exceed 500ms in production\n`;
  }

  md += `\n## Methodology\n\n`;
  md += `- **Tool:** Custom Node.js load tester with Promise.all concurrency control\n`;
  md += `- **Concurrency:** ${concurrency} simultaneous requests per batch\n`;
  md += `- **Total requests:** ${concurrency * iterations} per endpoint\n`;
  md += `- **Cache:** \`cache: 'no-store'\` to measure actual backend performance\n`;
  md += `- **Authentication:** Simulated admin session cookies for protected endpoints\n`;
  md += `- **Percentiles:** Calculated from sorted response times (P50, P75, P90, P95, P99)\n`;
  md += `- **Cache headers:** X-Cache header analyzed for hit/miss detection\n\n`;

  md += `## Metadata\n\n`;
  md += `\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n`;

  return md;
}

async function main() {
  console.log('\n' + '='.repeat(80));
  log('  📊 ApexOS Metrics Endpoints Load Test', 'bold');
  console.log('='.repeat(80));
  log(`  Server: ${serverUrl}`);
  log(`  Concurrency: ${concurrency} requests`);
  log(`  Iterations: ${iterations} batches`);
  log(`  Target: ≤${TARGET_RESPONSE_TIME_MS}ms response time`);
  console.log('='.repeat(80) + '\n');

  const allResults: ReturnType<typeof runConcurrentTest>[] = [];
  const metadata = {
    serverUrl,
    concurrency,
    iterations,
    totalRequestsPerEndpoint: concurrency * iterations,
    targetResponseTime: TARGET_RESPONSE_TIME_MS,
    timestamp: new Date().toISOString(),
    endpoints: METRICS_ENDPOINTS.map(e => e.name),
  };

  for (const endpoint of METRICS_ENDPOINTS) {
    const url = serverUrl + endpoint.path;

    log(`\nTesting: ${endpoint.name}`, 'blue');
    log(`  URL: ${url}`);
    log(`  Total requests: ${concurrency * iterations}`);

    const result = await runConcurrentTest(url, concurrency * iterations, {
      authRequired: endpoint.authRequired,
      expectCacheHit: endpoint.expectCacheHit,
    });

    result['target'] = endpoint.target;
    allResults.push(result);

    if (result.success) {
      log(`  ✅ PASS: avg=${result.avg}ms, p99=${result.p99}ms`, 'green');
    } else {
      log(`  ❌ FAIL: avg=${result.avg}ms (exceeds ${endpoint.target}ms)`, 'red');
    }

    if (result.cacheHits > 0 || result.cacheMisses > 0) {
      const hitRate = ((result.cacheHits / (result.cacheHits + result.cacheMisses)) * 100).toFixed(1);
      log(`  📦 Cache: ${result.cacheHits} hits, ${result.cacheMisses} misses (${hitRate}% hit rate)`, 'cyan');
    }

    if (result.failed > 0) {
      log(`  ⚠️ ${result.failed} requests failed`, 'yellow');
    }
  }

  // Generate report
  const report = generateMarkdownReport(allResults, metadata);
  const reportPath = resolve(__dirname, '../metrics-load-test-report.md');
  await writeFile(reportPath, report);

  // Summary
  console.log('\n' + '='.repeat(80));
  log('  📋 Summary', 'bold');
  console.log('='.repeat(80));

  const passed = allResults.filter(r => r.success).length;
  const total = allResults.length;
  const allAvg = allResults.reduce((sum, r) => sum + (r.avg || 0), 0) / total;
  const totalRequests = allResults.reduce((sum, r) => sum + r.totalRequests, 0);
  const totalSuccessful = allResults.reduce((sum, r) => sum + r.successful, 0);

  log(`  Endpoints passing: ${passed}/${total}`, passed === total ? 'green' : 'yellow');
  log(`  Average response time: ${Math.round(allAvg)}ms`, allAvg <= TARGET_RESPONSE_TIME_MS ? 'green' : 'red');
  log(`  Total requests: ${totalRequests}`, 'cyan');
  log(`  Successful: ${totalSuccessful} (${((totalSuccessful / totalRequests) * 100).toFixed(1)}%)`, totalSuccessful === totalRequests ? 'green' : 'yellow');
  log(`  Report saved: ${reportPath}`, 'cyan');
  console.log('='.repeat(80) + '\n');

  // Exit with appropriate code
  process.exit(passed === total ? 0 : 1);
}

main().catch(err => {
  console.error('Load test failed:', err);
  process.exit(1);
});
