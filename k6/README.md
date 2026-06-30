# k6 Load Testing for ApexOS

This directory contains k6 load testing scripts for performance validation of ApexOS API endpoints.

## Prerequisites

- [k6](https://k6.io/docs/getting-started/installation/) installed
- ApexOS server running (locally or in staging/production)

## Quick Start

### 1. Start the server

```bash
# Development server (Next.js)
pnpm dev

# Or production server
pnpm build
pnpm start

# Or Cloudflare Pages dev (port 8787)
npx wrangler dev
```

### 2. Generate admin session token

```bash
node k6/generate-admin-token.js
```

This outputs a mock admin session token. Copy it.

### 3. Set environment and run test

```bash
# Set the target URL and admin token
export K6_TARGET_URL=http://localhost:3000  # or 8787 for Cloudflare dev
export ADMIN_SESSION_TOKEN=<paste-token-from-step-2>

# Run the load test
node k6/run-load-test.js normal
```

## Test Configurations

| Config | VUs | Duration | Use Case |
|--------|-----|----------|----------|
| `quick` | 25 | 15s | Smoke test - fast validation |
| `normal` | 50 | 30s | Standard load test |
| `stress` | 100 | 60s | Stress the system |
| `endurance` | 50 | 5m | Check for memory leaks |

```bash
# Examples
node k6/run-load-test.js quick    # Quick smoke test
node k6/run-load-test.js stress   # Stress test
```

## Direct k6 Usage

For more control, run k6 directly:

```bash
# Basic test
k6 run k6/load-test.js

# With custom VUs and duration
k6 run --vus 100 --duration 60s k6/load-test.js

# Export results to JSON for analysis
k6 run --out json=results.json k6/load-test.js

# With custom target URL
K6_TARGET_URL=https://staging.apex-os.com k6 run k6/load-test.js

# With admin token for business metrics endpoint
ADMIN_SESSION_TOKEN=<token> k6 run k6/load-test.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `K6_TARGET_URL` | `http://localhost:8787` | Target server URL |
| `K6_VUS` | `50` | Number of virtual users |
| `K6_DURATION` | `30s` | Test duration (e.g., 30s, 5m, 10m) |
| `K6_ITERATIONS` | unlimited | Max iterations per VU |
| `ADMIN_SESSION_TOKEN` | (none) | Admin session token for `/api/metrics/business` |

**Note:** Without `ADMIN_SESSION_TOKEN`, the business metrics endpoint tests will fail with 401 errors.

## Performance Targets

| Metric | Target |
|--------|--------|
| **P95 Latency** | < 500ms |
| **P99 Latency** | < 1000ms |
| **Error Rate** | < 1% |
| **Success Rate** | > 99% |

## Endpoints Tested

| Endpoint | Auth | Cache | Description |
|----------|------|-------|-------------|
| `/api/metrics/business` | Admin | KV (5m TTL) | Business metrics dashboard |
| `/api/public/deals` | None | KV (60s TTL) | Public deals listing |

## Understanding Results

### Sample Output

```
LOAD TEST RESULTS
================================================================================
Target URL: http://localhost:8787
Test Duration: 30s
Virtual Users: 50

Overall Result: ✅ PASS

Performance Targets:
| Metric       | Target | Actual | Status |
|--------------|--------|--------|--------|
| P95 Latency  | ≤500ms | 245ms  | ✅ PASS |
| P99 Latency  | ≤1000ms| 412ms  | ✅ PASS |
| Error Rate   | <1%    | 0.00%  | ✅ PASS |

Latency Distribution:
| Percentile | Latency (ms) |
|------------|--------------|
| P50 (median)| 156         |
| P75         | 198         |
| P90         | 289         |
| P95         | 245         |
| P99         | 412         |
| Max         | 567         |

Summary:
| Metric           | Value  |
|------------------|--------|
| Total Requests   | 2,847  |
| Successful       | 2,847  |
| Failed           | 0      |
| Avg Response Time| 178ms  |
| Cache Hits       | 1,234  |
| Cache Misses     | 1,613  |
| Cache Hit Rate   | 43.3%  |
================================================================================
```

### Key Metrics Explained

- **P95 (95th percentile)**: 95% of requests complete within this time. Our primary target.
- **P99 (99th percentile)**: 99% of requests complete within this time. Worst-case tail latency.
- **Cache Hit Rate**: Percentage of requests served from KV cache. Higher is better.
- **Error Rate**: Failed requests / total requests. Should be < 1%.

## Troubleshooting

### Business metrics endpoint failing (401/403)
Ensure `ADMIN_SESSION_TOKEN` is set. Generate a token with `node k6/generate-admin-token.js`.

### Server connection refused
Make sure the server is running on the expected port. Default is `http://localhost:8787` (Cloudflare Pages dev). For Next.js dev, use `http://localhost:3000`.

### All requests timing out
Check:
1. Server is running and responsive
2. Firewall/network allows k6 to connect
3. Target URL is correct
4. Database is available (check server logs)

### Low cache hit rate on first run
First runs will have cache misses as the cache warms up. Run the test multiple times to see cache hit rates stabilize.

## Advanced: Custom Test Scenarios

Edit `k6/load-test.js` to:

- Add more endpoints
- Adjust VU patterns (ramp-up, step, etc.)
- Add authentication methods
- Custom thresholds
- Additional metrics

Example: Change to ramp-up pattern

```javascript
export const options = {
  scenarios: {
    ramp_up: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 25 },
        { duration: '60s', target: 50 },
        { duration: '30s', target: 0 },
      ],
      exec: 'testPublicDeals',
    },
  },
  // ...rest of config
};
```

## CI/CD Integration

Add to your CI pipeline:

```yaml
# Example GitHub Actions workflow
- name: Run Load Tests
  run: |
    pnpm build
    pnpm start &
    SERVER_PID=$!
    sleep 5  # Wait for server to start

    # Run load test
    k6 run k6/load-test.js

    # Capture exit code
    TEST_RESULT=$?
    kill $SERVER_PID
    exit $TEST_RESULT
```

## Interpreting Results

### ✅ Pass
All thresholds met:
- P95 < 500ms
- Error rate < 1%
- P99 < 1000ms

### ⚠️ Review
- P95 > 500ms but < 750ms: Investigate slow queries, check cache hit rate
- Error rate 1-5%: Check rate limiting, database connections

### ❌ Fail
- P95 > 750ms: Serious performance issue
- Error rate > 5%: System instability
- P99 > 2000ms: Unacceptable tail latency

## Next Steps After Performance Issues

1. **Check database query performance**
   - Run `EXPLAIN` on slow queries
   - Verify indexes exist (`src/database/migrations/008_composite_indexes.sql`)

2. **Verify cache effectiveness**
   - Check `X-Cache` headers in responses
   - Ensure KV namespace is bound in wrangler.toml

3. **Review server logs**
   - Look for slow query warnings
   - Check for database connection pool exhaustion

4. **Optimize queries**
   - Reduce N+1 queries
   - Use pagination effectively
   - Consider materialized views for complex aggregations

## References

- [k6 Documentation](https://k6.io/docs/)
- [ApexOS Performance Audit](./PERFORMANCE-AUDIT.md)
- [ApexOS Operational Runbook](./docs/operational-runbook.md)
