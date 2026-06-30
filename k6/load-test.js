/**
 * ApexOS Load Test using k6
 *
 * Tests /api/metrics/business and /api/public/deals
 * Target: p95 latency < 500ms
 *
 * Usage:
 *   k6 run k6/load-test.js
 *   k6 run --out json=results.json k6/load-test.js
 *   k6 run --vus 50 --duration 30s k6/load-test.js
 *
 * Options (environment variables):
 *   K6_TARGET_URL: Server URL (default: http://localhost:8787)
 *   K6_VUS: Number of virtual users (default: 50)
 *   K6_DURATION: Test duration (default: 30s)
 *   K6_ITERATIONS: Max iterations per VU (default: unlimited)
 *   ADMIN_SESSION_TOKEN: Mock admin session token for business metrics endpoint
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';

// Configuration from environment variables
const TARGET_URL = __ENV.K6_TARGET_URL || 'http://localhost:3000';
const VUS = parseInt(__ENV.APEX_VUS || '50', 10);
const DURATION = __ENV.APEX_DURATION || '30s';
const ITERATIONS = __ENV.APEX_ITERATIONS ? parseInt(__ENV.APEX_ITERATIONS, 10) : undefined;
const ADMIN_TOKEN = __ENV.ADMIN_SESSION_TOKEN || '';

// Target response time thresholds (ms)
const TARGET_P95_MS = 500;
const TARGET_P99_MS = 1000;

// Rate limiting thresholds
const ERROR_RATE_THRESHOLD = 0.01; // 1% max error rate

// Custom metrics
const responseTimeTrend = new Trend('response_time');
const p95ResponseTime = new Gauge('p95_response_time_ms');
const p99ResponseTime = new Gauge('p99_response_time_ms');
const successRate = new Rate('success_rate');
const errorsCounter = new Counter('errors');
const cacheHits = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');

// Endpoints to test
const ENDPOINTS = {
  businessMetrics: {
    name: 'Business Metrics API',
    path: '/api/metrics/business?start_date=2025-06-01&end_date=2025-06-21',
    authRequired: true,
    authHeader: ADMIN_TOKEN ? `Cookie: __session=${ADMIN_TOKEN}` : undefined,
    thresholds: {
      p95: TARGET_P95_MS,
      p99: TARGET_P99_MS,
    }
  },
  publicDeals: {
    name: 'Public Deals API',
    path: '/api/public/deals?page=1&limit=20',
    authRequired: false,
    authHeader: undefined,
    thresholds: {
      p95: TARGET_P95_MS,
      p99: TARGET_P99_MS,
    }
  }
};

// Test configuration
export const options = {
  scenarios: {
    business_metrics: {
      executor: 'constant-vus',
      vus: Math.ceil(VUS / 2),
      duration: DURATION,
      exec: 'testBusinessMetrics',
      ...(ITERATIONS && { maxIterations: ITERATIONS }),
    },
    public_deals: {
      executor: 'constant-vus',
      vus: Math.ceil(VUS / 2),
      duration: DURATION,
      exec: 'testPublicDeals',
      ...(ITERATIONS && { maxIterations: ITERATIONS }),
    },
  },
  thresholds: {
    // Response time thresholds using k6 threshold syntax
    'response_time': [
      `p(95)<${TARGET_P95_MS}`,
      `p(99)<${TARGET_P99_MS}`,
    ],
    // Success rate should be > 99%
    'success_rate': [
      'rate >= 0.99',
    ],
    // Error rate should be < 1%
    'errors': [
      `rate < ${ERROR_RATE_THRESHOLD}`,
    ],
  },
  summaryTrendStats: ['avg', 'min', 'max', 'p(95)', 'p(99)', 'count'],
  noConnectionReuse: false, // Keep connections alive for realistic testing
  maxRedirects: 3,
};

function makeRequest(endpointConfig) {
  const url = `${TARGET_URL}${endpointConfig.path}`;
  const params = {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'k6-load-test/1.0',
    },
  };

  if (endpointConfig.authHeader) {
    params.headers['Cookie'] = endpointConfig.authHeader.replace('Cookie: ', '');
  }

  const startTime = Date.now();
  const response = http.get(url, params);
  const duration = Date.now() - startTime;

  // Record metrics
  responseTimeTrend.add(duration);

  // Check cache header
  const cacheHeader = response.headers['x-cache'];
  if (cacheHeader === 'HIT' || cacheHeader === 'hit') {
    cacheHits.add(1);
  } else {
    cacheMisses.add(1);
  }

  // Record success/failure
  const isSuccessful = response.status >= 200 && response.status < 300;
  successRate.add(isSuccessful ? 1 : 0);

  if (!isSuccessful) {
    errorsCounter.add(1);
    console.error(`Request failed: ${url} - Status: ${response.status} - Body: ${response.body?.substring(0, 200)}`);
  }

  // Check response
  check(response, {
    'status is 200': (r) => r.status === 200,
    'response has data': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.data !== undefined || body.daily_revenue !== undefined || body.summary !== undefined;
      } catch {
        return false;
      }
    },
    'response time under 2s': (r) => duration < 2000,
  });

  return { response, duration, isSuccessful };
}

export function testBusinessMetrics() {
  const endpoint = ENDPOINTS.businessMetrics;
  const { response, duration, isSuccessful } = makeRequest(endpoint);

  // Simulate admin reading/analyzing the data
  sleep(Math.random() * 2 + 1); // 1-3s think time
}

export function testPublicDeals() {
  const endpoint = ENDPOINTS.publicDeals;
  const { response, duration, isSuccessful } = makeRequest(endpoint);

  // Simulate user browsing deals
  sleep(Math.random() * 2 + 1); // 1-3s think time
}

// Calculate and log percentile stats at end of test
export function handleSummary(data) {
  const responseTimes = responseTimeTrend.values;
  if (responseTimes.length === 0) {
    console.log('No response times recorded');
    return {};
  }

  responseTimes.sort((a, b) => a - b);

  const p50Idx = Math.floor(responseTimes.length * 0.5);
  const p75Idx = Math.floor(responseTimes.length * 0.75);
  const p90Idx = Math.floor(responseTimes.length * 0.90);
  const p95Idx = Math.floor(responseTimes.length * 0.95);
  const p99Idx = Math.floor(responseTimes.length * 0.99);

  const p50 = responseTimes[p50Idx];
  const p75 = responseTimes[p75Idx];
  const p90 = responseTimes[p90Idx];
  const p95 = responseTimes[p95Idx];
  const p99 = responseTimes[p99Idx];
  const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
  const min = responseTimes[0];
  const max = responseTimes[responseTimes.length - 1];

  // Update gauge metrics for threshold checking
  p95ResponseTime.add(p95);
  p99ResponseTime.add(p99);

  // Generate markdown report
  const report = generateMarkdownReport({
    targetUrl: TARGET_URL,
    vus: VUS,
    duration: DURATION,
    iterations: ITERATIONS,
    totalRequests: data.metrics.response_time.count,
    successfulRequests: data.metrics.success_rate.count * data.metrics.success_rate.avg,
    failedRequests: data.metrics.errors.count,
    avg,
    min,
    max,
    p50,
    p75,
    p90,
    p95,
    p99,
    errorRate: data.metrics.errors.rate || 0,
    cacheHitCount: data.metrics.cache_hits.count,
    cacheMissCount: data.metrics.cache_misses.count,
    thresholds: {
      p95: TARGET_P95_MS,
      p99: TARGET_P99_MS,
      errorRate: ERROR_RATE_THRESHOLD,
    },
  });

  // Print report to console
  console.log('\n' + '='.repeat(80));
  console.log('LOAD TEST RESULTS');
  console.log('='.repeat(80));
  console.log(report);
  console.log('='.repeat(80) + '\n');

  // Return summary data
  return {
    'p95 (ms)': p95,
    'p99 (ms)': p99,
    'avg (ms)': avg,
    'min (ms)': min,
    'max (ms)': max,
    'total requests': data.metrics.response_time.count,
    'success rate': data.metrics.success_rate.avg?.toFixed(4),
    'error rate': data.metrics.errors.rate?.toFixed(4),
    'cache hits': data.metrics.cache_hits.count,
    'cache misses': data.metrics.cache_misses.count,
  };
}

function generateMarkdownReport(results) {
  const date = new Date().toISOString();
  const passP95 = results.p95 <= results.thresholds.p95;
  const passP99 = results.p99 <= results.thresholds.p99;
  const passErrorRate = results.errorRate <= results.thresholds.errorRate;
  const overallPass = passP95 && passErrorRate;

  let md = `# k6 Load Test Report\n\n`;
  md += `**Generated:** ${date}\n`;
  md += `**Target URL:** ${results.targetUrl}\n`;
  md += `**Test Duration:** ${results.duration}\n`;
  md += `**Virtual Users:** ${results.vus}\n`;
  md += `**Iterations per VU:** ${results.iterations || 'unlimited'}\n\n`;

  md += `## Performance Targets\n\n`;
  md += `| Metric | Target | Actual | Status |\n`;
  md += `|--------|--------|--------|--------|\n`;
  md += `| **P95 Latency** | ≤${results.thresholds.p95}ms | ${Math.round(results.p95)}ms | ${passP95 ? '✅ PASS' : '❌ FAIL'} |\n`;
  md += `| **P99 Latency** | ≤${results.thresholds.p99}ms | ${Math.round(results.p99)}ms | ${passP99 ? '✅ PASS' : '⚠️ OK'} |\n`;
  md += `| **Error Rate** | <${(results.thresholds.errorRate * 100).toFixed(1)}% | ${(results.errorRate * 100).toFixed(2)}% | ${passErrorRate ? '✅ PASS' : '❌ FAIL'} |\n\n`;

  md += `## Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| **Total Requests** | ${results.totalRequests} |\n`;
  md += `| **Successful** | ${Math.round(results.successfulRequests)} |\n`;
  md += `| **Failed** | ${results.failedRequests} |\n`;
  md += `| **Average Response Time** | ${Math.round(results.avg)}ms |\n`;
  md += `| **Min Response Time** | ${Math.round(results.min)}ms |\n`;
  md += `| **Max Response Time** | ${Math.round(results.max)}ms |\n`;
  md += `| **Cache Hits** | ${results.cacheHitCount} |\n`;
  md += `| **Cache Misses** | ${results.cacheMissCount} |\n`;
  md += `| **Cache Hit Rate** | ${((results.cacheHitCount / (results.cacheHitCount + results.cacheMissCount)) * 100).toFixed(1)}% |\n\n`;

  md += `## Latency Distribution\n\n`;
  md += `| Percentile | Latency (ms) |\n`;
  md += `|------------|--------------|\n`;
  md += `| P50 (median) | ${Math.round(results.p50)} |\n`;
  md += `| P75 | ${Math.round(results.p75)} |\n`;
  md += `| P90 | ${Math.round(results.p90)} |\n`;
  md += `| **P95** | **${Math.round(results.p95)}** |\n`;
  md += `| P99 | ${Math.round(results.p99)} |\n`;
  md += `| Max | ${Math.round(results.max)} |\n\n`;

  md += `## Overall Result\n\n`;
  if (overallPass) {
    md += `✅ **PASS** - All endpoints meet the p95 < ${results.thresholds.p95}ms target with acceptable error rate.\n\n`;
  } else {
    md += `❌ **FAIL** - Performance targets not met:\n\n`;
    if (!passP95) {
      md += `- P95 latency: ${Math.round(results.p95)}ms (exceeds ${results.thresholds.p95}ms by ${Math.round(results.p95 - results.thresholds.p95)}ms)\n`;
    }
    if (!passErrorRate) {
      md += `- Error rate: ${(results.errorRate * 100).toFixed(2)}% (exceeds ${(results.thresholds.errorRate * 100).toFixed(1)}%)\n`;
    }
  }

  md += `\n## Recommendations\n\n`;

  if (!overallPass) {
    md += `### Immediate Actions\n\n`;
    md += `1. **Analyze slow queries** - Check database query performance for metrics exceeding ${results.thresholds.p95}ms p95\n`;
    md += `2. **Verify cache effectiveness** - Ensure KV cache is working (check X-Cache headers)\n`;
    md += `3. **Optimize database indexes** - Verify composite indexes are applied\n`;
    md += `4. **Consider query pagination** - If returning large datasets, ensure limits are applied\n`;
    md += `5. **Increase KV cache TTL** - Current 5-minute TTL may be too short for cached data\n`;
  } else {
    md += `### Performance is Optimal\n\n`;
    md += `✅ All targets met. Continue monitoring:\n`;
    md += `1. **Monitor cache hit rates** - Maintain >80% cache hit rate\n`;
    md += `2. **Test with larger date ranges** - 90+ day queries may degrade performance\n`;
    md += `3. **Set up production alerts** - Alert on p95 > ${results.thresholds.p95}ms\n`;
  }

  md += `\n## Test Configuration\n\n`;
  md += `\`\`\`bash\n`;
  md += `k6 run --vus ${results.vus} --duration ${results.duration} k6/load-test.js\n`;
  md += `# With custom target URL:\n`;
  md += `K6_TARGET_URL=https://your-domain.com k6 run k6/load-test.js\n`;
  md += `\`\`\`\n\n`;

  return md;
}
