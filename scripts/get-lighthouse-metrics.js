const report = require('./lighthouse-prod-report.json');
const c = report.categories;
const a = report.audits;

console.log('=== Lighthouse Production Audit Results ===\n');
console.log('OVERALL SCORES:');
console.log('  Performance:', Math.round(c.performance.score * 100) + '/100');
console.log('  Accessibility:', Math.round(c.accessibility.score * 100) + '/100');
console.log('  Best Practices:', Math.round(c['best-practices'].score * 100) + '/100');
console.log('  SEO:', Math.round(c.seo.score * 100) + '/100');

console.log('\nCORE WEB VITALS:');
console.log('  LCP (Largest Contentful Paint):', Math.round(a['largest-contentful-paint'].numericValue) + 'ms');
console.log('  FID (First Input Delay):', Math.round(a['max-potential-fid'].numericValue) + 'ms');
console.log('  CLS (Cumulative Layout Shift):', a['cumulative-layout-shift'].numericValue.toFixed(4));
console.log('  TTFB (Time to First Byte):', Math.round(a['time-to-first-byte'].numericValue) + 'ms');
console.log('  TTI (Time to Interactive):', Math.round(a.interactive.numericValue) + 'ms');
console.log('  Speed Index:', Math.round(a['speed-index'].numericValue) + 'ms');
console.log('  Total Blocking Time:', Math.round(a['total-blocking-time'].numericValue) + 'ms');

console.log('\nTARGET STATUS:');
const perfTarget = Math.round(c.performance.score * 100) >= 90;
const lcpTarget = a['largest-contentful-paint'].numericValue <= 2500;
const fidTarget = a['max-potential-fid'].numericValue <= 100;
const clsTarget = a['cumulative-layout-shift'].numericValue <= 0.1;

console.log('  Lighthouse >90:', perfTarget ? '✓ PASS' : '✗ FAIL');
console.log('  LCP ≤2500ms:', lcpTarget ? '✓ PASS' : '✗ FAIL');
console.log('  FID ≤100ms:', fidTarget ? '✓ PASS' : '✗ FAIL');
console.log('  CLS ≤0.1:', clsTarget ? '✓ PASS' : '✗ FAIL');
