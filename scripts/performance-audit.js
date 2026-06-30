#!/usr/bin/env node
/**
 * ApexOS Performance Audit
 * Run: node scripts/performance-audit.js --server-url=http://localhost:8787
 */

const { writeFile } = require('fs/promises');
const { performance } = require('perf_hooks');

const args = process.argv.slice(2);
const serverUrl = args.find(a => a.startsWith('--server-url='))?.split('=')[1] || 'http://localhost:8787';

const TARGETS = {
  lighthouse: 90,
  apiResponseTime: 200,
  lcp: 2500,
  fid: 100,
  cls: 0.1,
};

const PAGES = ['/', '/vi', '/vi/deals', '/vi/dashboard', '/en'];
const API_ENDPOINTS = ['/api/health', '/api/public/deals'];

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

async function checkServerHealth() {
  log('Checking server health...', 'blue');
  try {
    const response = await fetch(serverUrl + '/api/health');
    if (response.ok) {
      const data = await response.json();
      log(`✓ Server healthy - response time: ${data.responseTime}ms`, 'green');
      return true;
    }
    log('✗ Server health check failed', 'red');
    return false;
  } catch (error) {
    log(`✗ Cannot reach server at ${serverUrl}: ${error.message}`, 'red');
    return false;
  }
}

async function runLighthouseAudits() {
  log('\n🔍 Running Lighthouse Audits', 'bold');
  const results = [];

  const { default: lighthouse } = require('lighthouse');
  const puppeteer = require('puppeteer');

  const chromePath = '/Users/macbook/.cache/puppeteer/chrome-headless-shell/mac_arm-149.0.7827.22/chrome-headless-shell-mac-arm64/chrome-headless-shell';

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  for (const page of PAGES) {
    const url = serverUrl + page;
    log(`  Auditing: ${page}`, 'blue');

    try {
      const lhResult = await lighthouse(url, {
        output: 'json',
        logLevel: 'error',
      }, browser);

      const lhr = lhResult.lhr;
      const metrics = lhr.audits['metrics'].numericValue;
      const score = Math.round(lhr.categories.performance.score * 100);

      results.push({
        page,
        score,
        metrics: {
          lcp: metrics['largest-contentful-paint'] || 0,
          fid: metrics['max-potential-fid'] || 0,
          cls: metrics['cumulative-layout-shift'] || 0,
          ttfb: metrics['time-to-first-byte'] || 0,
          tti: metrics['interactive'] || 0,
        },
      });

      const status = score >= TARGETS.lighthouse ? '✓' : '✗';
      log(`    ${status} Score: ${score} (LCP: ${Math.round(metrics['largest-contentful-paint'] || 0)}ms, FID: ${Math.round(metrics['max-potential-fid'] || 0)}ms, CLS: ${(metrics['cumulative-layout-shift'] || 0).toFixed(3)})`, score >= 90 ? 'green' : 'yellow');

    } catch (error) {
      log(`    ✗ Failed: ${error.message || error}`, 'red');
      results.push({ page, score: 0, metrics: { lcp: 0, fid: 0, cls: 0, ttfb: 0, tti: 0 } });
    }
  }

  await browser.close();
  return results;
}

async function testApiEndpoints() {
  log('\n⚡ Testing API Response Times', 'bold');
  const results = [];

  for (const endpoint of API_ENDPOINTS) {
    const url = serverUrl + endpoint;
    log(`  Testing: ${endpoint}`, 'blue');
    const times = [];
    const iterations = 10;

    for (let i = 0; i < iterations; i++) {
      try {
        const start = performance.now();
        const response = await fetch(url, { cache: 'no-store' });
        await response.text();
        const duration = performance.now() - start;
        times.push(duration);
      } catch (error) {
        log(`    ✗ Request ${i + 1} failed: ${error.message}`, 'red');
      }
    }

    if (times.length > 0) {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const min = Math.min(...times);
      const max = Math.max(...times);
      const p95 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)];

      results.push({
        endpoint,
        avg: Math.round(avg),
        min: Math.round(min),
        max: Math.round(max),
        p95: Math.round(p95),
      });

      const status = avg <= TARGETS.apiResponseTime ? '✓' : '✗';
      log(`    ${status} Avg: ${Math.round(avg)}ms | Min: ${Math.round(min)}ms | Max: ${Math.round(max)}ms | P95: ${Math.round(p95)}ms`, avg <= TARGETS.apiResponseTime ? 'green' : 'red');
    }
  }

  return results;
}

async function generateReport(auditResults, apiResults) {
  const avgScore = Math.round(auditResults.reduce((s, r) => s + r.score, 0) / auditResults.length) || 0;
  const avgLcp = Math.round(auditResults.reduce((s, r) => s + r.metrics.lcp, 0) / auditResults.length) || 0;
  const avgFid = Math.round(auditResults.reduce((s, r) => s + r.metrics.fid, 0) / auditResults.length) || 0;
  const avgCls = (auditResults.reduce((s, r) => s + r.metrics.cls, 0) / auditResults.length) || 0;
  const avgApi = Math.round(apiResults.reduce((s, r) => s + r.avg, 0) / apiResults.length) || 0;

  const passedPages = auditResults.filter(r => r.score >= TARGETS.lighthouse).length;
  const passedApis = apiResults.filter(r => r.avg <= TARGETS.apiResponseTime).length;

  const reportPath = './performance-report.html';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ApexOS Performance Report</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 p-8">
  <div class="max-w-5xl mx-auto">
    <h1 class="text-3xl font-bold mb-2">🚀 ApexOS Performance Audit</h1>
    <p class="text-gray-600 mb-2">Server: ${serverUrl}</p>
    <p class="text-gray-600 mb-8">Generated: ${new Date().toLocaleString()}</p>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      <div class="bg-white rounded-lg shadow p-6 border-l-4 ${avgScore >= 90 ? 'border-green-500' : avgScore >= 70 ? 'border-yellow-500' : 'border-red-500'}">
        <p class="text-gray-500 text-sm">Lighthouse Avg</p>
        <p class="text-3xl font-bold">${avgScore}</p>
        <p class="text-sm ${avgScore >= 90 ? 'text-green-600' : avgScore >= 70 ? 'text-yellow-600' : 'text-red-600'}">Target: ≥90</p>
      </div>
      <div class="bg-white rounded-lg shadow p-6 border-l-4 ${avgLcp <= 2500 ? 'border-green-500' : avgLcp <= 4000 ? 'border-yellow-500' : 'border-red-500'}">
        <p class="text-gray-500 text-sm">LCP Avg</p>
        <p class="text-3xl font-bold">${avgLcp}ms</p>
        <p class="text-sm ${avgLcp <= 2500 ? 'text-green-600' : avgLcp <= 4000 ? 'text-yellow-600' : 'text-red-600'}">Target: ≤2500ms</p>
      </div>
      <div class="bg-white rounded-lg shadow p-6 border-l-4 ${avgFid <= 100 ? 'border-green-500' : avgFid <= 300 ? 'border-yellow-500' : 'border-red-500'}">
        <p class="text-gray-500 text-sm">FID Avg</p>
        <p class="text-3xl font-bold">${avgFid}ms</p>
        <p class="text-sm ${avgFid <= 100 ? 'text-green-600' : avgFid <= 300 ? 'text-yellow-600' : 'text-red-600'}">Target: ≤100ms</p>
      </div>
      <div class="bg-white rounded-lg shadow p-6 border-l-4 ${avgCls <= 0.1 ? 'border-green-500' : avgCls <= 0.25 ? 'border-yellow-500' : 'border-red-500'}">
        <p class="text-gray-500 text-sm">CLS Avg</p>
        <p class="text-3xl font-bold">${avgCls.toFixed(3)}</p>
        <p class="text-sm ${avgCls <= 0.1 ? 'text-green-600' : avgCls <= 0.25 ? 'text-yellow-600' : 'text-red-600'}">Target: ≤0.1</p>
      </div>
    </div>

    <div class="bg-white rounded-lg shadow mb-8 overflow-hidden">
      <div class="bg-gray-800 text-white px-6 py-4">
        <h2 class="text-xl font-semibold">API Response Times (${TARGETS.apiResponseTime}ms target)</h2>
      </div>
      <table class="w-full">
        <thead class="bg-gray-100">
          <tr>
            <th class="px-6 py-3 text-left text-sm font-semibold text-gray-600">Endpoint</th>
            <th class="px-6 py-3 text-left text-sm font-semibold text-gray-600">Average</th>
            <th class="px-6 py-3 text-left text-sm font-semibold text-gray-600">Min</th>
            <th class="px-6 py-3 text-left text-sm font-semibold text-gray-600">Max</th>
            <th class="px-6 py-3 text-left text-sm font-semibold text-gray-600">P95</th>
            <th class="px-6 py-3 text-left text-sm font-semibold text-gray-600">Status</th>
          </tr>
        </thead>
        <tbody>
          ${apiResults.map(r => `
            <tr class="border-t">
              <td class="px-6 py-4 font-mono text-sm">${r.endpoint}</td>
              <td class="px-6 py-4 font-bold">${r.avg}ms</td>
              <td class="px-6 py-4">${r.min}ms</td>
              <td class="px-6 py-4">${r.max}ms</td>
              <td class="px-6 py-4">${r.p95}ms</td>
              <td class="px-6 py-4">
                <span class="px-3 py-1 rounded-full text-sm font-semibold ${r.avg <= TARGETS.apiResponseTime ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                  ${r.avg <= TARGETS.apiResponseTime ? 'PASS' : 'FAIL'}
                </span>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="bg-white rounded-lg shadow mb-8 overflow-hidden">
      <div class="bg-gray-800 text-white px-6 py-4">
        <h2 class="text-xl font-semibold">Page Performance Details</h2>
      </div>
      <table class="w-full">
        <thead class="bg-gray-100">
          <tr>
            <th class="px-6 py-3 text-left text-sm font-semibold text-gray-600">Page</th>
            <th class="px-6 py-3 text-center text-sm font-semibold text-gray-600">Score</th>
            <th class="px-6 py-3 text-center text-sm font-semibold text-gray-600">LCP</th>
            <th class="px-6 py-3 text-center text-sm font-semibold text-gray-600">FID</th>
            <th class="px-6 py-3 text-center text-sm font-semibold text-gray-600">CLS</th>
            <th class="px-6 py-3 text-center text-sm font-semibold text-gray-600">TTI</th>
          </tr>
        </thead>
        <tbody>
          ${auditResults.map(r => `
            <tr class="border-t">
              <td class="px-6 py-4 font-medium">${r.page}</td>
              <td class="px-6 py-4 text-center font-bold ${r.score >= 90 ? 'text-green-600' : r.score >= 70 ? 'text-yellow-600' : 'text-red-600'}">${r.score}</td>
              <td class="px-6 py-4 text-center">${Math.round(r.metrics.lcp)}ms</td>
              <td class="px-6 py-4 text-center">${Math.round(r.metrics.fid)}ms</td>
              <td class="px-6 py-4 text-center">${r.metrics.cls.toFixed(3)}</td>
              <td class="px-6 py-4 text-center">${Math.round(r.metrics.tti)}ms</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-6 mb-8">
      <h3 class="font-semibold text-yellow-800 mb-2">⚠ Key Findings</h3>
      <ul class="space-y-2 text-yellow-700 text-sm">
        ${avgScore < 90 ? `<li>Lighthouse score is ${avgScore}, target is 90. Focus on performance category improvements.</li>` : `<li class="text-green-600">✓ Lighthouse score meets target</li>`}
        ${avgLcp > 2500 ? `<li>LCP (${avgLcp}ms) exceeds 2500ms target. Optimize above-the-fold content.</li>` : `<li class="text-green-600">✓ LCP meets target</li>`}
        ${avgFid > 100 ? `<li>FID (${avgFid}ms) exceeds 100ms target. Reduce JavaScript execution time.</li>` : `<li class="text-green-600">✓ FID meets target</li>`}
        ${avgCls > 0.1 ? `<li>CLS (${avgCls.toFixed(3)}) exceeds 0.1 target. Fix layout shifts.</li>` : `<li class="text-green-600">✓ CLS meets target</li>`}
        ${avgApi > 200 ? `<li>API avg (${avgApi}ms) exceeds 200ms. Optimize database queries, add caching.</li>` : `<li class="text-green-600">✓ API response times meet target</li>`}
      </ul>
    </div>

    <div class="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-8">
      <h3 class="font-semibold text-blue-800 mb-2">📋 Recommendations</h3>
      <ul class="space-y-3 text-blue-700 text-sm">
        <li><strong>Images:</strong> Next.js image optimization disabled for Cloudflare Pages. Convert images to WebP, use srcset, implement lazy loading.</li>
        <li><strong>Fonts:</strong> Ensure font-display: swap. Preload critical fonts. Consider system fonts.</li>
        <li><strong>JavaScript:</strong> Use dynamic imports for non-critical components. Audit bundle size with pnpm build --profile.</li>
        <li><strong>Database:</strong> Add composite indexes on (wallet_address, created_at) in earnings, (deal_id, created_at) in conversions.</li>
        <li><strong>Caching:</strong> Implement Cloudflare KV for deal listings (TTL 5min).</li>
        <li><strong>Edge Runtime:</strong> Move API routes to edge runtime: export const runtime = 'edge' in route.ts files.</li>
        <li><strong>Compression:</strong> Ensure Brotli compression enabled (Cloudflare handles this).</li>
        <li><strong>Prefetch:</strong> Add prefetch hints for likely navigation paths.</li>
      </ul>
    </div>

    <div class="bg-gray-100 rounded-lg p-6">
      <h3 class="font-semibold mb-4">📈 Score Distribution</h3>
      <div class="space-y-2">
        ${auditResults.map(r => `
          <div class="flex items-center gap-4">
            <span class="w-32 font-mono text-sm">${r.page}</span>
            <div class="flex-1 bg-gray-200 rounded-full h-4 overflow-hidden">
              <div class="h-full ${r.score >= 90 ? 'bg-green-500' : r.score >= 70 ? 'bg-yellow-500' : 'bg-red-500'}" style="width: ${r.score}%"></div>
            </div>
            <span class="w-12 text-right font-bold">${r.score}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="mt-8 p-4 bg-gray-100 rounded">
      <h3 class="font-semibold mb-2">Summary</h3>
      <p>Pages tested: ${auditResults.length} | Passing: ${passedPages}/${auditResults.length}</p>
      <p>API endpoints tested: ${apiResults.length} | Passing: ${passedApis}/${apiResults.length}</p>
    </div>
  </div>
</body>
</html>`;

  await writeFile(reportPath, html);
  log(`\n📊 Report saved: ${reportPath}`, 'green');
}

async function main() {
  console.log('\n' + '='.repeat(60));
  log('  🚀 ApexOS Performance Audit', 'bold');
  console.log('='.repeat(60));
  log(`  Target: Lighthouse ≥90, API ≤${TARGETS.apiResponseTime}ms`);
  log(`  Server: ${serverUrl}`);
  console.log('='.repeat(60) + '\n');

  if (!await checkServerHealth()) {
    log('\n❌ Server not responding.', 'red');
    log('Start with: wrangler dev', 'yellow');
    process.exit(1);
  }

  const auditResults = await runLighthouseAudits();
  const apiResults = await testApiEndpoints();
  await generateReport(auditResults, apiResults);

  const avgScore = Math.round(auditResults.reduce((s, r) => s + r.score, 0) / auditResults.length) || 0;
  const avgApi = Math.round(apiResults.reduce((s, r) => s + r.avg, 0) / apiResults.length) || 0;
  const passedPages = auditResults.filter(r => r.score >= TARGETS.lighthouse).length;
  const passedApis = apiResults.filter(r => r.avg <= TARGETS.apiResponseTime).length;

  console.log('\n' + '='.repeat(60));
  log('  📋 Summary', 'bold');
  console.log('='.repeat(60));
  log(`  Lighthouse Average: ${avgScore}/100`, avgScore >= 90 ? 'green' : 'red');
  log(`  API Average: ${avgApi}ms`, avgApi <= TARGETS.apiResponseTime ? 'green' : 'red');
  log(`  Pages passing: ${passedPages}/${auditResults.length}`);
  log(`  APIs passing: ${passedApis}/${apiResults.length}`);
  console.log('='.repeat(60) + '\n');
}

main().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
