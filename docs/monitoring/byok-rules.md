# BYOK Monitoring & Alerting Rules

## Metrics Reference

### Counters

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `byok_resolution_total` | counter | `source=user\|global\|fallback`, `provider=binance\|bybit\|resend` | Tổng số resolution attempts |
| `byok_decryption_errors_total` | counter | `reason=invalid_key\|corrupt_data\|master_key_missing` | Lỗi decrypt user keys |
| `byok_missing_key_total` | counter | `provider`, `userId` | User key không tồn tại (khi fallback được dùng) |
| `byok_db_query_duration_seconds` | histogram | `operation=get\|set\|delete\|list`, `provider` | DB query latency |
| `byok_encryption_duration_seconds` | histogram | `operation=encrypt\|decrypt` | AES-GCM encryption/decryption latency |

### Gauges

| Metric | Labels | Description |
|--------|--------|-------------|
| `byok_user_keys_total` | `provider` | Tổng số user keys đang lưu trong DB |
| `byok_enabled` | — | BYOK feature flag (1 = enabled, 0 = disabled) |

## Prometheus Rules (Alertmanager)

```yaml
groups:
  - name: byok
    rules:
      # High decryption error rate (>5%)
      - alert: ByokDecryptionErrorRateHigh
        expr: rate(byok_decryption_errors_total[5m]) / rate(byok_resolution_total[5m]) > 0.05
        for: 2m
        labels:
          severity: critical
          component: byok
        annotations:
          summary: "BYOK decryption error rate {{ $value | humanizePercentage }}"
          description: "More than 5% of BYOK resolutions are failing to decrypt user keys. Check BYOK_MASTER_KEY validity."

      # Missing key rate spike (users may need onboarding)
      - alert: ByokMissingKeyRateHigh
        expr: rate(byok_missing_key_total[5m]) > 100
        for: 5m
        labels:
          severity: warning
          component: byok
        annotations:
          summary: "High rate of missing BYOK keys: {{ $value | humanize }} keys/5m"
          description: "Many users don't have BYOK keys configured. Consider sending onboarding email or updating docs."

      # Decryption latency SLA breach (>10ms p99)
      - alert: ByokDecryptionLatencyHigh
        expr: histogram_quantile(0.99, rate(byok_encryption_duration_seconds_bucket[5m])) > 0.01
        for: 3m
        labels:
          severity: warning
          component: byok
        annotations:
          summary: "BYOK decryption p99 latency {{ $value | humanizeDuration }} (SLA: 10ms)"
          description: "Decryption is slower than expected. Check DB performance or consider caching."

      # DB query latency high
      - alert: ByokDbQueryLatencyHigh
        expr: histogram_quantile(0.95, rate(byok_db_query_duration_seconds_bucket[5m])) > 0.05
        for: 5m
        labels:
          severity: warning
          component: byok
        annotations:
          summary: "BYOK DB query p95 latency {{ $value | humanizeDuration }}"
          description: "Database queries for BYOK are slow. Check D1 performance or add indexes."

      # Feature flag disabled unexpectedly
      - alert: ByokFeatureFlagDisabled
        expr: byok_enabled == 0
        for: 1m
        labels:
          severity: info
          component: byok
        annotations:
          summary: "BYOK feature flag is DISABLED"
          description: "System is using global secrets instead of per-user keys. Verify this is intentional."

      # Zero user keys (migration may have failed)
      - alert: ByokNoUserKeys
        expr: byok_user_keys_total == 0
        for: 10m
        labels:
          severity: warning
          component: byok
        annotations:
          summary: "No user BYOK keys found in database"
          description: "Check if migration script ran successfully or if users have added keys."
```

## Grafana Dashboard Panels

### Panel 1: Resolution Overview
- **Type:** Stat
- **Query:** `sum(rate(byok_resolution_total[5m]))`
- **Legend:** {{source}} - {{provider}}
- **Description:** Real-time resolution rate by source

### Panel 2: Resolution Distribution
- **Type:** Pie chart
- **Query:** `sum(byok_resolution_total) by (source)`
- **Description:** Proportion of user vs global resolutions

### Panel 3: Error Rate
- **Type:** Time series (stacked)
- **Query:** `rate(byok_decryption_errors_total[5m])` vs `rate(byok_resolution_total[5m])`
- **Description:** Error rate trend

### Panel 4: Latency
- **Type:** Heatmap
- **Query:** `rate(byok_encryption_duration_seconds_bucket[5m])`
- **Description:** Encryption/decryption latency distribution

### Panel 5: User Keys Count
- **Type:** Stat + trend
- **Query:** `byok_user_keys_total`
- **Description:** Total user keys stored (by provider)

## Instrumentation Code

Add to `src/app/api/webhooks/exchange/route.ts` (or better: create metrics utility):

```typescript
import { metrics } from '@/lib/metrics';

// Inside POST handler, after resolveApiKey:
const startTime = Date.now();
try {
  const secret = await resolveApiKey(userId, exchange as ByokProvider, {
    fallbackToGlobal: true
  });
  const duration = (Date.now() - startTime) / 1000;
  metrics.byok_resolution_duration_seconds.observe({ source: userId ? 'user' : 'global', provider: exchange }, duration);
  metrics.byok_resolution_total.inc({ source: userId ? 'user' : 'global', provider: exchange });
} catch (error) {
  metrics.byok_decryption_errors_total.inc({ reason: 'decrypt_failed' });
  throw error;
}
```

Metrics utility (`src/lib/metrics.ts`):

```typescript
import { Counter, Histogram, Gauge } from 'prom-client';

export const metrics = {
  byok_resolution_total: new Counter({
    name: 'byok_resolution_total',
    help: 'Total BYOK resolutions',
    labelNames: ['source', 'provider'],
  }),
  byok_decryption_errors_total: new Counter({
    name: 'byok_decryption_errors_total',
    help: 'BYOK decryption errors',
    labelNames: ['reason'],
  }),
  byok_encryption_duration_seconds: new Histogram({
    name: 'byok_encryption_duration_seconds',
    help: 'BYOK encryption/decryption duration',
    labelNames: ['operation'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  }),
  byok_db_query_duration_seconds: new Histogram({
    name: 'byok_db_query_duration_seconds',
    help: 'BYOK DB query duration',
    labelNames: ['operation', 'provider'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  }),
  byok_user_keys_total: new Gauge({
    name: 'byok_user_keys_total',
    help: 'Total user BYOK keys',
    labelNames: ['provider'],
  }),
  byok_enabled: new Gauge({
    name: 'byok_enabled',
    help: 'BYOK feature flag (1=enabled, 0=disabled)',
  }),
};

// Set static gauge on startup
metrics.byok_enabled.set(process.env.BYOK_ENABLED === 'true' ? 1 : 0);
```

## Integration with Alert Engine

Update `src/lib/monitoring/alert-engine.ts` to include BYOK rules:

```typescript
import { byokRules } from '@/lib/monitoring/byok-rules';

const ALL_RULES = [
  ...CORE_RULES,
  ...byokRules, // Add BYOK rules
];
```

## Runbook: BYOK Alerts

### Decryption Error Rate High
1. Check `BYOK_MASTER_KEY` in Cloudflare Secrets: `wrangler secret list`
2. Verify app logs for "Giải mã thất bại" errors
3. If master key rotated recently, revert or update all user keys
4. Rollback: `wrangler secret put BYOK_ENABLED false`

### Missing Key Rate High
1. Review onboarding flow — are users aware they need to add keys?
2. Check if admin keys were migrated: `SELECT * FROM user_api_keys WHERE user_id = (SELECT id FROM profiles WHERE role='admin')`
3. Consider auto-onboarding for existing users (migration script)

### Latency Issues
1. Check D1 database metrics (`/api/monitoring/d1`)
2. Verify `idx_user_api_keys_user` index exists
3. Consider caching layer (KV with 5m TTL)
