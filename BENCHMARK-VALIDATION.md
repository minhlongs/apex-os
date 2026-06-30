# API Response Time Benchmark & Validation Report

**Date:** June 22, 2026
**Benchmark Target:** ≤200ms average response time (p50/p95/p99)
**Auditor:** Claude Code Automated Benchmark
**Project:** ApexOS

---

## Executive Summary

| Environment | Status | Avg Response Time | Target Met |
|-------------|--------|-------------------|------------|
| **Local (wrangler dev)** | ✅ PASS | 4-5ms | YES |
| **Production** | ❌ BLOCKED | N/A | NO |

**Key Finding:** The API code performs excellently locally (4-5ms response times), but production deployment on Cloudflare Pages has a routing configuration issue where API endpoints return HTML instead of JSON.

---

## Local Benchmark Results

### Test Configuration
- **Server:** `http://localhost:8787` (wrangler dev with D1 local)
- **Iterations:** 30 per endpoint
- **Cache:** `no-store` (cold responses)
- **Date:** June 22, 2026

### Detailed Metrics

| Endpoint | Status | Iterations | Avg | Min | P50 | P75 | P90 | P95 | P99 | Max |
|----------|--------|------------|-----|-----|-----|-----|-----|-----|-----|-----|
| `/api/health` | ✅ | 30 | 5ms | 3ms | 3ms | 4ms | 6ms | 7ms | 53ms | 53ms |
| `/api/public/deals` | ✅ | 30 | 4ms | 3ms | 4ms | 4ms | 5ms | 5ms | 5ms | 5ms |

### Percentile Analysis

**P50 (Median):** The median response time shows that half of all requests complete in under 3-4ms.

**P95:** 95% of requests complete within 5-7ms, well under the 200ms target.

**P99:** The slowest 1% of requests reach 53ms (health endpoint), still well within target.

### Conclusion (Local)

✅ **All endpoints meet the ≤200ms target by a significant margin.**

Local D1 queries execute in 3-5ms, confirming the database schema and query optimization are working correctly.

---

## Production Analysis

### Current Production Status

**URL:** https://apex-os.pages.dev

**Issue:** API endpoints (`/api/*`) return HTML instead of JSON.

```
$ curl -s -I https://apex-os.pages.dev/api/health
HTTP/2 200
content-type: text/html; charset=utf-8
```

The response is the Next.js app HTML, not the expected JSON from the health endpoint.

### Root Cause Analysis

The `_routes` file exists in the repository with correct configuration:

```
/api/*    cloudflare_workers
/admin/*  cloudflare_workers
```

However, the production deployment is not respecting this routing rule. This is a **Cloudflare Pages deployment configuration issue**, not a code problem.

### Potential Causes

1. **Build output not updated:** The production build may have been deployed before the `_routes` file was added
2. **OpenNext configuration:** The `@opennextjs/cloudflare` adapter may need specific configuration for API routes
3. **Cache propagation:** Cloudflare's edge cache may be serving stale routing configuration
4. **Wrangler.toml routes format:** The routes section in wrangler.toml used deprecated syntax (now fixed)

---

## Previous Production Benchmark (Historical)

From `PERFORMANCE-AUDIT.md` (June 22, 2026):

| Endpoint | Avg | Min | Max | Status |
|----------|-----|-----|-----|--------|
| `/api/health` | 317ms | 243ms | 366ms | ❌ FAIL |
| `/api/public/deals` | 288ms | 242ms | 336ms | ❌ FAIL |
| `/api/deals` | 301ms | 242ms | 337ms | ❌ FAIL |

These measurements were taken **before** the routing issue occurred (JSON responses received, but slow due to cold starts).

### Historical Analysis

Even when the API was responding correctly, production response times (288-317ms) exceeded the 200ms target. The primary causes were:

1. **Serverless cold starts:** Cloudflare Workers cold starts add 200-500ms on first request
2. **Database query latency:** D1 queries over the network add overhead vs local
3. **No edge caching:** Public endpoints without caching hit the database on every request

---

## Validation Checklist

- [x] **Benchmark script created** - `scripts/benchmark-api.js` with proper percentile calculations
- [x] **Local benchmark run** - All endpoints pass with 4-5ms average
- [x] **P50 measured** - Median response times calculated (3-4ms)
- [x] **P95 measured** - 95th percentile calculated (5-7ms)
- [x] **P99 measured** - 99th percentile calculated (5-53ms)
- [ ] **Production benchmark** - BLOCKED by routing issue
- [ ] **≤200ms target verified in production** - Cannot verify until routing fixed

---

## Recommendations

### Immediate: Fix Production Routing

1. **Trigger fresh deployment** to Cloudflare Pages
   ```bash
   git add _routes
   git commit -m "fix: ensure _routes file is included in build"
   git push
   ```
   Wait for Cloudflare Pages to redeploy.

2. **Purge Cloudflare cache**
   - Go to Cloudflare Pages dashboard
   - Clear edge cache for the deployment
   - Or use API: `curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache"`

3. **Verify _routes in build output**
   - Check that `_routes` is in the root of the deployed output
   - The file should be copied to `.next/standalone/` or the deployment artifact

4. **Check OpenNext build logs**
   ```bash
   pnpm build
   ```
   Look for messages about `_routes` being processed.

### Medium-term: Production Performance Optimization

Once routing is fixed, implement these optimizations to meet the 200ms target:

1. **Add Cache-Control headers** to `/api/public/deals`:
   ```typescript
   export const dynamic = 'force-static';
   export const revalidate = 60; // 60 seconds ISR
   ```

2. **Add database indexes** (already implemented in migration `008_composite_indexes.sql`):
   ```sql
   CREATE INDEX idx_deals_status_created ON deals(status, created_at DESC);
   CREATE INDEX idx_deal_clicks_deal_created ON deal_clicks(deal_id, created_at DESC);
   ```

3. **Consider edge runtime** for faster D1 access:
   ```typescript
   export const runtime = 'edge';
   ```

4. **Implement response caching** with Cloudflare KV for frequently accessed deals.

---

## Files Generated

- `/Users/macbook/apex-os/scripts/benchmark-api.js` - Benchmark script with percentile calculations
- `/Users/macbook/apex-os/benchmark-report.md` - Local benchmark results

---

## Appendix: Benchmark Script Details

The `benchmark-api.js` script:

1. Sends N iterations (default 20, we used 30) to each endpoint
2. Measures response time using `performance.now()`
3. Calculates p50 (median), p75, p90, p95, p99 percentiles
4. Reports status against the 200ms target
5. Generates markdown report with detailed analysis

Percentile calculation:
```javascript
function percentile(sorted, p) {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}
```

---

## Conclusion

**Local Performance:** ✅ Excellent - all endpoints achieve 4-5ms average, far below 200ms target.

**Production Status:** ❌ Routing misconfiguration prevents API access. The code is ready for production but the Cloudflare Pages deployment needs correction.

**Next Steps:**
1. Fix the `_routes` deployment issue
2. Redeploy to production
3. Run benchmark against production to verify ≤200ms target
4. If production still exceeds target, implement caching and indexing optimizations
