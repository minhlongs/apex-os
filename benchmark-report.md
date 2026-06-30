# API Response Time Benchmark Report

**Generated:** 2026-06-22T05:29:37.962Z
**Server:** http://localhost:8787
**Target:** ≤200ms average response time
**Iterations per endpoint:** 30

## Summary

| Metric | Value | Status |
|--------|-------|--------|
| **Overall Pass Rate** | 2/2 endpoints | ✅ PASS |
| **Average Response Time** | 5ms | ✅ PASS |
| **Target Response Time** | ≤200ms | - |

## Detailed Results

| Endpoint | Status | Iterations | Avg | Min | P50 | P75 | P90 | P95 | P99 | Max |
|----------|--------|------------|-----|-----|-----|-----|-----|-----|-----|-----|
| http://localhost:8787/api/health | ✅ | 30 | 5ms | 3ms | 3ms | 4ms | 6ms | 7ms | 53ms | 53ms |
| http://localhost:8787/api/public/deals | ✅ | 30 | 4ms | 3ms | 4ms | 4ms | 5ms | 5ms | 5ms | 5ms |

## Analysis

### http://localhost:8787/api/health

- **Status:** ✅ Pass (avg: 5ms ≤ 200ms)
- **P50 (median):** 3ms
- **P95:** 7ms (5% of requests slower than this)
- **P99:** 53ms (1% of requests slower than this)
- **Range:** 3ms - 53ms

### http://localhost:8787/api/public/deals

- **Status:** ✅ Pass (avg: 4ms ≤ 200ms)
- **P50 (median):** 4ms
- **P95:** 5ms (5% of requests slower than this)
- **P99:** 5ms (1% of requests slower than this)
- **Range:** 3ms - 5ms

## Recommendations

### ✅ All Targets Met

All API endpoints meet the ≤200ms response time target. Performance is optimal.

## Methodology

- **Tool:** Custom Node.js benchmark with `performance.now()` timing
- **Sample size:** 30 requests per endpoint
- **Cache:** `cache: 'no-store'` to measure cold responses
- **Percentiles:** Calculated from sorted response times
- **P50:** Median (50% of requests faster, 50% slower)
- **P95:** 95th percentile (95% of requests faster)
- **P99:** 99th percentile (99% of requests faster)
