#!/usr/bin/env node
/**
 * ApexOS API Response Time Benchmark
 * Measures p50, p95, p99 response times for API endpoints
 *
 * Usage:
 *   node scripts/benchmark-api.js --server-url=https://apex-os.pages.dev
 *   node scripts/benchmark-api.js --server-url=http://localhost:8787 --iterations=50
 */

import { performance } from 'perf_hooks';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';

const args = process.argv.slice(2);
const serverUrl = args.find(a => a.startsWith('--server-url='))?.split('=')[1] || 'http://localhost:8787';
const iterations = parseInt(args.find(a => a.startsWith('--iterations='))?.split('=')[1] || '20', 10);

const TARGET_RESPONSE_TIME_MS = 200;

const API_ENDPOINTS = [
  '/api/health',
  '/api/public/deals',
];

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function measureEndpoint(url, iterations) {
  const times = [];
  const statusCodes = [];
  const errors = [];

  log(`\n⚡ Testing: ${url}`, 'blue');
  log(`   Iterations: ${iterations}`, 'blue');

  for (let i = 0; i < iterations; i++) {
    try {
      const start = performance.now();
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          'Accept': 'application/json',
        },
      });
      const duration = performance.now() - start;
      times.push(duration);
      statusCodes.push(response.status);

      if (i === 0) {
        log(`   First response: ${Math.round(duration)}ms (status: ${response.status})`, 'yellow');
      }
    } catch (error) {
      errors.push(error.message);
      log(`   ✗ Request ${i + 1} failed: ${error.message}`, 'red');
    }
  }

  if (times.length === 0) {
    return {
      endpoint: url,
      success: false,
      error: errors.join('; '),
      iterations: 0,
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

  // Count status codes
  const statusCounts = {};
  statusCodes.forEach(code => {
    statusCounts[code] = (statusCounts[code] || 0) + 1;
  });

  const success = avg <= TARGET_RESPONSE_TIME_MS;

  return {
    endpoint: url,
    success,
    iterations: times.length,
    avg: Math.round(avg),
    min: Math.round(min),
    max: Math.round(max),
    p50: Math.round(p50),
    p75: Math.round(p75),
    p90: Math.round(p90),
    p95: Math.round(p95),
    p99: Math.round(p99),
    statusCounts,
    errors: errors.length,
  };
}

function generateMarkdownReport(results) {
  const date = new Date().toISOString();
  const passed = results.filter(r => r.success).length;
  const total = results.length;
  const allAvg = results.reduce((sum, r) => sum + (r.avg || 0), 0) / total;

  let md = `# API Response Time Benchmark Report\n\n`;
  md += `**Generated:** ${date}\n`;
  md += `**Server:** ${serverUrl}\n`;
  md += `**Target:** ≤${TARGET_RESPONSE_TIME_MS}ms average response time\n`;
  md += `**Iterations per endpoint:** ${iterations}\n\n`;

  md += `## Summary\n\n`;
  md += `| Metric | Value | Status |\n`;
  md += `|--------|-------|--------|\n`;
  md += `| **Overall Pass Rate** | ${passed}/${total} endpoints | ${passed === total ? '✅ PASS' : '⚠️ PARTIAL'} |\n`;
  md += `| **Average Response Time** | ${Math.round(allAvg)}ms | ${allAvg <= TARGET_RESPONSE_TIME_MS ? '✅ PASS' : '❌ FAIL'} |\n`;
  md += `| **Target Response Time** | ≤${TARGET_RESPONSE_TIME_MS}ms | - |\n\n`;

  md += `## Detailed Results\n\n`;
  md += `| Endpoint | Status | Iterations | Avg | Min | P50 | P75 | P90 | P95 | P99 | Max |\n`;
  md += `|----------|--------|------------|-----|-----|-----|-----|-----|-----|-----|-----|\n`;

  for (const r of results) {
    if (!r.success) {
      md += `| ${r.endpoint} | ❌ FAIL | ${r.iterations} | - | - | - | - | - | - | - | - |\n`;
      continue;
    }

    const statusEmoji = r.success ? '✅' : '❌';
    md += `| ${r.endpoint} | ${statusEmoji} | ${r.iterations} | ${r.avg}ms | ${r.min}ms | ${r.p50}ms | ${r.p75}ms | ${r.p90}ms | ${r.p95}ms | ${r.p99}ms | ${r.max}ms |\n`;
  }

  md += `\n## Analysis\n\n`;

  for (const r of results) {
    if (r.success) {
      md += `### ${r.endpoint}\n\n`;
      md += `- **Status:** ✅ Pass (avg: ${r.avg}ms ≤ ${TARGET_RESPONSE_TIME_MS}ms)\n`;
      md += `- **P50 (median):** ${r.p50}ms\n`;
      md += `- **P95:** ${r.p95}ms (5% of requests slower than this)\n`;
      md += `- **P99:** ${r.p99}ms (1% of requests slower than this)\n`;
      md += `- **Range:** ${r.min}ms - ${r.max}ms\n`;
      if (Object.keys(r.statusCounts).length > 1) {
        md += `- **Status codes:** ${JSON.stringify(r.statusCounts)}\n`;
      }
      if (r.errors > 0) {
        md += `- **Errors:** ${r.errors}\n`;
      }
      md += `\n`;
    } else {
      md += `### ${r.endpoint}\n\n`;
      md += `- **Status:** ❌ Fail (avg: ${r.avg || 'N/A'}ms > ${TARGET_RESPONSE_TIME_MS}ms)\n`;
      if (r.error) {
        md += `- **Error:** ${r.error}\n`;
      }
      md += `\n`;
    }
  }

  md += `## Recommendations\n\n`;

  const hasFailures = results.some(r => !r.success);
  const slowEndpoints = results.filter(r => r.success && r.avg > 150);

  if (hasFailures) {
    md += `### Immediate Actions Required\n\n`;
    md += `1. **Investigate endpoint failures** - Some endpoints are not responding correctly\n`;
    md += `2. **Check Cloudflare Pages routing** - Ensure \`/api/*\` routes are properly configured in \`_routes\`\n`;
    md += `3. **Verify D1 database connectivity** - Health endpoint should report database status\n`;
  }

  if (slowEndpoints.length > 0) {
    md += `### Performance Optimization\n\n`;
    md += `Endpoints exceeding 150ms average:\n\n`;
    for (const r of slowEndpoints) {
      md += `- **${r.endpoint}** (${r.avg}ms)\n`;
    }
    md += `\nOptimization steps:\n`;
    md += `1. **Add database indexes** on frequently queried columns\n`;
    md += `2. **Implement Cloudflare KV caching** for static/semi-static data\n`;
    md += `3. **Enable edge runtime** for API routes: add \`export const runtime = 'edge'\`\n`;
    md += `4. **Optimize queries** - reduce N+1 queries, use JOINs appropriately\n`;
    md += `5. **Add response caching headers** - Cache-Control for appropriate TTLs\n`;
  }

  if (!hasFailures && slowEndpoints.length === 0) {
    md += `### ✅ All Targets Met\n\n`;
    md += `All API endpoints meet the ≤${TARGET_RESPONSE_TIME_MS}ms response time target. Performance is optimal.\n`;
  }

  md += `\n## Methodology\n\n`;
  md += `- **Tool:** Custom Node.js benchmark with \`performance.now()\` timing\n`;
  md += `- **Sample size:** ${iterations} requests per endpoint\n`;
  md += `- **Cache:** \`cache: 'no-store'\` to measure cold responses\n`;
  md += `- **Percentiles:** Calculated from sorted response times\n`;
  md += `- **P50:** Median (50% of requests faster, 50% slower)\n`;
  md += `- **P95:** 95th percentile (95% of requests faster)\n`;
  md += `- **P99:** 99th percentile (99% of requests faster)\n`;

  return md;
}

async function main() {
  console.log('\n' + '='.repeat(60));
  log('  🚀 ApexOS API Benchmark', 'bold');
  console.log('='.repeat(60));
  log(`  Target: ≤${TARGET_RESPONSE_TIME_MS}ms average response time`);
  log(`  Server: ${serverUrl}`);
  log(`  Iterations: ${iterations} per endpoint`);
  console.log('='.repeat(60) + '\n');

  const results = [];

  for (const endpoint of API_ENDPOINTS) {
    const url = serverUrl + endpoint;
    const result = await measureEndpoint(url, iterations);
    results.push(result);

    if (result.success) {
      log(`  ✅ ${endpoint}: avg=${result.avg}ms, p50=${result.p50}ms, p99=${result.p99}ms`, 'green');
    } else {
      log(`  ❌ ${endpoint}: ${result.error || 'Failed'}`, 'red');
    }
  }

  // Generate report
  const report = generateMarkdownReport(results);
  const reportPath = resolve(process.cwd(), 'benchmark-report.md');
  await writeFile(reportPath, report);

  console.log('\n' + '='.repeat(60));
  log('  📋 Summary', 'bold');
  console.log('='.repeat(60));

  const passed = results.filter(r => r.success).length;
  const total = results.length;
  const allAvg = results.reduce((sum, r) => sum + (r.avg || 0), 0) / total;

  log(`  Endpoints passing: ${passed}/${total}`);
  log(`  Average response time: ${Math.round(allAvg)}ms`, allAvg <= TARGET_RESPONSE_TIME_MS ? 'green' : 'red');
  log(`  Report saved: ${reportPath}`, 'yellow');
  console.log('='.repeat(60) + '\n');
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
