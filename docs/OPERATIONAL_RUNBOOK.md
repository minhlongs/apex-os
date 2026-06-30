# ApexOS Operational Runbook

**Version:** 2.0
**Last Updated:** 2026-06-23
**Application:** ApexOS - Global Crypto Cashback & Affiliate Hub
**Platform:** Cloudflare Pages + D1 + Workers

---

## Mục lục

1. [Tổng quan hệ thống](#tổng-quan-hệ-thống)
2. [Kiểm tra sức khỏe](#kiểm-tra-sức-khỏe)
3. [Giám sát](#giám-sát)
4. [Hệ thống cảnh báo](#hệ-thống-cảnh-báo)
5. [Quy trình phản ứng sự cố](#quy-trình-phản-ứng-sự-cố)
6. [Vận hành hàng ngày](#vận-hành-hàng-ngày)
7. [Thủ tục bảo trì](#thủ-tục-bảo-trì)
8. [Sao lưu & Khôi phục](#sao-lưu--khôi-phục)
9. [Hướng dẫn khắc phục sự cố](#hướng-dẫn-khắc-phục-sự-cố)
10. [Thủ tục Triển khai](#thủ-tục-triển-khai)
11. [Liên hệ khẩn cấp](#liên-hệ-khẩn-cấp)

---

## Tổng quan hệ thống

### Kiến trúc

ApexOS là nền tảng SaaS full-stack được xây dựng với:

| Thành phần | Công nghệ | Mục đích |
|------------|-----------|----------|
| **Frontend** | Next.js 16 (App Router) + React 18 | Giao diện người dùng, hỗ trợ i18n |
| **Backend** | Cloudflare Workers (via OpenNext) | API endpoints serverless |
| **Database** | Cloudflare D1 (SQLite) | Dữ liệu người dùng, affiliate tracking, earnings |
| **Cache** | Cloudflare KV | Session data, rate limiting |
| **Storage** | Cloudflare R2 | File uploads (deal images, avatars) |
| **Auth** | Better Auth 0.8.7 | Authentication với custom D1 adapter |
| **Email** | Resend API | Transactional emails |
| **Payments** | Stellar USDC, Polar, SePay | Payouts và subscriptions |
| **i18n** | next-intl | Vietnamese & English localization |

### Tính năng cốt lõi

- Hệ thống affiliate đa cấp (3 tiers: 30%/10%/5%)
- Xử lý webhook exchange trade (Binance, Bybit)
- Click attribution với 30-day cookie window
- Tự động weekly Stellar USDC payouts
- Admin dashboard cho deal management
- Real-time earnings tracking

### URL quan trọng

| Môi trường | URL |
|------------|-----|
| Production | https://apex-os.pages.dev |
| Staging | (được cấu hình riêng) |
| Health Endpoint | `/api/health` (GET) |
| Admin Dashboard | `/vi/admin/*` |

---

## Kiểm tra sức khỏe

### Health Endpoint Specification

**Endpoint:** `GET /api/health`

**Expected Response (200 OK):**

```json
{
  "status": "ok",
  "timestamp": "2026-06-23T12:00:00.000Z",
  "environment": "production",
  "uptime": 86400,
  "version": "1.0.0",
  "responseTime": 45,
  "checks": {
    "database": "connected",
    "kv": "connected"
  },
  "memory": {
    "rss": "45MB",
    "heapUsed": "23MB"
  }
}
```

**Status Values:**

| Status | Ý nghĩa | Hành động |
|--------|---------|-----------|
| `ok` | Tất cả hệ thống hoạt động bình thường | Vận hành bình thường |
| `degraded` | Database hoặc KV connection issue | Điều tra, có thể ảnh hưởng functionality |
| `error` | Critical failure | Cần điều tra ngay lập tức |

**Response Codes:**

| Code | Ý nghĩa |
|------|---------|
| 200 | Healthy |
| 503 | Service Unavailable |

### Health Check Commands

```bash
# Kiểm tra nhanh
curl -f https://apex-os.pages.dev/api/health

# Kiểm tra chi tiết với timing
curl -w "\nHTTP: %{http_code}\nTime: %{time_total}s\n" \
  https://apex-os.pages.dev/api/health

# Kiểm tra local với Wrangler
wrangler dev &
curl http://localhost:8787/api/health
```

### Automated Health Monitoring

Health checks được cấu hình qua:

| Dịch vụ | Khoảng thời gian | Alert Threshold |
|---------|------------------|-----------------|
| UptimeRobot | 1 phút | 5 lần thất bại liên tiếp |
| Pingdom | 1 phút | 5 phút |
| Cloudflare Analytics | 1 phút | Error rate >5% |

---

## Giám sát

### Monitoring Stack

1. **UptimeRobot** (primary) - Miễn phí, 1-minute intervals
2. **Pingdom** (secondary) - Synthetic transactions
3. **Cloudflare Analytics** - Built-in edge metrics
4. **D1 Monitoring** - Database-specific metrics qua cron

### Key Metrics to Monitor

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Uptime | 99.9% | <99% over 24h |
| Response Time (P95) | <1000ms | >2000ms |
| Error Rate | <1% | >5% over 5min |
| Database Connection | Healthy | Bất kỳ failure nào |
| KV Connection | Healthy | Bất kỳ failure nào |
| Payout Queue Size | <100 | >500 pending |

### Setting Up Monitoring

Xem `docs/monitoring-setup.md` cho hướng dẫn setup chi tiết.

### Quick Setup

```bash
# Chạy interactive setup script
./scripts/setup-monitoring.sh --all

# Test health endpoint
./scripts/test-health.sh --iterations 10
```

### Dashboards

| Dashboard | Mục đích | Truy cập |
|-----------|---------|----------|
| Cloudflare Analytics | Request rate, errors, response time | Cloudflare Dashboard → Pages → Analytics |
| UptimeRobot | Uptime %, downtime history | UptimeRobot.com |
| D1 Metrics | Database query performance | Xem `docs/d1-monitoring.md` |
| Admin Alerts | Alert management UI | `/vi/admin/alerts` |

---

## Hệ thống cảnh báo

### Tổng quan hệ thống

ApexOS alerting system giám sát hiệu năng database, business metrics, và system health. Hệ thống hỗ trợ multi-channel notifications, snooze management, và comprehensive alert lifecycle tracking.

### Các thành phần

| Thành phần | Đường dẫn | Mục đích |
|-----------|-----------|----------|
| Alert Engine | `src/lib/monitoring/alert-engine.ts` | Đánh giá metrics, trigger alerts |
| D1 Monitor | `src/lib/monitoring/d1-monitor.ts` | Thu thập D1 database metrics |
| Notification Service | `src/lib/notifications/index.ts` | Route alerts đến các channels |
| Storage Layer | `src/lib/monitoring/alert-storage.ts` | Lưu trữ alerts và snoozes trong D1 |
| API Routes | `src/app/api/monitoring/` | REST endpoints cho alert management |
| Types | `src/types/business-alerting.ts` | TypeScript definitions |

### Alert States

| State | Mô tả | Hành động cần thiết |
|-------|-------|-------------------|
| **Active** | Alert triggered, cần attention | Acknowledge, investigate, resolve |
| **Acknowledged** | Ai đó đang xử lý | Tiếp tục investigate |
| **Resolved** | Issue resolved, monitoring tiếp tục | Document resolution |
| **Snoozed** | Tạm thời bị tắt | Sẽ re-activate sau snooze period |

### Cảnh báo Database (D1)

#### alert-slow-query
- **ID:** `alert-slow-query`
- **Tên:** Slow Query
- **Metric:** `avg_query_duration_ms`
- **Ngưỡng:** > 1000ms
- **Severity:** Warning
- **Nguyên nhân:** Missing indexes, full table scans, complex joins
- **Khắc phục:** Thêm composite indexes, optimize query

#### alert-storage
- **ID:** `alert-storage`
- **Tên:** High Storage
- **Metric:** `storage_usage_percent`
- **Ngưỡng:** ≥ 80%
- **Severity:** Critical
- **Nguyên nhân:** Data growth, log accumulation
- **Khắc phục:** Archive old data, increase D1 quota

#### alert-slow-count
- **ID:** `alert-slow-count`
- **Tên:** Excessive Slow Queries
- **Metric:** `slow_query_count`
- **Ngưỡng:** > 10
- **Severity:** Warning

#### alert-rows-scanned
- **ID:** `alert-rows-scanned`
- **Tên:** High Row Scan
- **Metric:** `avg_rows_scanned`
- **Ngưỡng:** > 10000
- **Severity:** Warning

### Business Alerts

#### biz-revenue-drop
- **ID:** `biz-revenue-drop`
- **Metric:** `daily_revenue`
- **Ngưỡng:** < $100
- **Severity:** Warning

#### biz-conversion-rate-low
- **ID:** `biz-conversion-rate-low`
- **Metric:** `conversion_rate`
- **Ngưỡng:** < 2%
- **Severity:** Warning

#### biz-zero-conversions
- **ID:** `biz-zero-conversions`
- **Metric:** `total_conversions`
- **Ngưỡng:** = 0
- **Severity:** Critical

#### biz-high-commission-liability
- **ID:** `biz-high-commission-liability`
- **Metric:** `pending_commission`
- **Ngưỡng:** ≥ $10,000
- **Severity:** Warning

#### biz-stellar-balance-low
- **ID:** `biz-stellar-balance-low`
- **Metric:** `stellar_balance`
- **Ngưỡng:** < 100 USDC
- **Severity:** Critical

### Notification Channels

**Email (Resend):**
```bash
RESEND_API_KEY=re_your_key
RESEND_FROM_EMAIL=noreply@yourdomain.com
NOTIFICATION_EMAIL_RECIPIENTS=admin@example.com,alerts@example.com
```

**Slack:**
```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_ENABLED=true
SLACK_CHANNEL=#alerts
```

**Telegram:**
```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_IDS=-1001234567890
TELEGRAM_ENABLED=true
```

### Alert Engine Cron

Cảnh báo được đánh giá mỗi 5 phút:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

### API Endpoints

```bash
# Get alert status
GET /api/monitoring/d1

# Acknowledge alert
POST /api/monitoring/d1
{ "action": "acknowledge", "alertId": "..." }

# Resolve alert
POST /api/monitoring/d1
{ "action": "resolve", "alertId": "..." }

# Manage snoozes
GET /api/monitoring/d1/snoozes
POST /api/monitoring/d1/snoozes
DELETE /api/monitoring/d1/snoozes/{id}
```

---

## Quy trình phản ứng sự cố

### Các mức độ nghiêm trọng

| Mức | Định nghĩa | Thời gian phản hồi | Thông báo |
|-----|------------|---------------------|-----------|
| **P0** | Service hoàn toàn down, tất cả users bị ảnh hưởng | Ngay lập tức (0-5 phút) | Tất cả channels, PagerDuty |
| **P1** | Core functionality degraded, ảnh hưởng lớn | 15 phút | Slack, SMS |
| **P2** | Non-critical feature down, ảnh hưởng hạn chế | 30 phút | Email, Slack |
| **P3** | Minor issues, không ảnh hưởng users | 2 giờ | Email |

### Incident Response Playbook

#### P0/P1 Incident (Service Down)

1. **Acknowledge** alert trong 5 phút
2. **Assess** impact:
   ```bash
   curl -f https://apex-os.pages.dev/api/health
   wrangler pages deployment list --project-name apex-os
   ```
3. **Check** recent deployments - rollback nếu nghi ngờ:
   ```bash
   wrangler pages deployment rollback --project-name apex-os <deployment-id>
   ```
4. **Verify** database connectivity:
   ```bash
   wrangler d1 execute apex-os-db --command "SELECT 1"
   ```
5. **Check** Cloudflare status page cho platform issues
6. **Communicate**:
   - Post to `#infra-alerts` Slack
   - Update status page nếu có
   - Thông báo stakeholders cho P0
7. **Resolve** và verify recovery
8. **Post-mortem** trong 24h cho P0

#### P2 Incident (Degraded Performance)

1. Kiểm tra health endpoint status (`degraded` vs `error`)
2. Review Cloudflare Analytics cho traffic spikes
3. Check D1 query performance (slow queries)
4. Cân nhắc scaling hoặc optimization
5. Document findings

### Scenarios phổ biến

| Scenario | Nguyên nhân có thể | Hành động đầu tiên |
|----------|-------------------|-------------------|
| Health endpoint returns HTML | Pages routing issue | Check `_routes` và middleware |
| Database connection errors | D1 outage hoặc misconfiguration | Verify D1 binding trong wrangler.toml |
| High error rate | Recent deployment bug | Rollback to previous deployment |
| Slow response times | Cold start hoặc query issues | Check logs, thêm warmup requests |
| Webhook failures | Exchange API changes | Check webhook logs, verify signature |

---

## Vận hành hàng ngày

### Daily Health Checks

**Morning Checklist (9 AM local):**

- [ ] Review overnight alerts
- [ ] Check uptime statistics (last 24h)
- [ ] Verify payout cron executed (nếu Chủ nhật)
- [ ] Review D1 storage usage
- [ ] Check error logs for patterns

```bash
# Get yesterday's uptime từ UptimeRobot API
# Check D1 size
wrangler d1 execute apex-os-db --command "PRAGMA page_count;"

# Review recent errors
wrangler pages deployment tail --project-name apex-os --since 24h
```

### Weekly Tasks

**Thứ 2:**
- Review weekly monitoring reports
- Check payout batch status (nếu đã chạy Chủ nhật)
- Review user feedback và support tickets

**Thứ 4:**
- Test alert notifications (simulate failure)
- Review database growth trends
- Check R2 storage usage

**Thứ 6:**
- Review week's deployments
- Update incident runbook với scenarios mới
- Plan weekend on-call coverage

### Monthly Tasks

- Test full incident response drill
- Review và update monitoring thresholds
- Audit environment variables cho rotation needs
- Check Cloudflare billing và usage limits
- Review và prune old KV entries
- Verify backup integrity

---

## Thủ tục bảo trì

### Database Maintenance

#### Check Database Size

```bash
# Get database stats
wrangler d1 execute apex-os-db --command "
  SELECT
    (page_count * page_size) / 1024 / 1024 as size_mb
  FROM pragma_page_count(), pragma_page_size();
"
```

#### Run VACUUM (nếu cần)

```bash
# Export, recreate, và import cho size optimization
wrangler d1 export apex-os-db --output backup-full.sql
# Manual: recreate DB và import
```

#### Check for Slow Queries

```bash
# Enable SQLite stats (requires schema changes)
# Add query log table nếu chưa có
```

### KV Maintenance

#### List and Cleanup Old Keys

```bash
# List all keys (paginated)
wrangler kv:key list --binding=KV --limit 1000

# Delete expired session keys (example pattern)
# Note: KV doesn't have TTL deletion API, phải track expiration trong app
```

#### Monitor KV Usage

```bash
# Check KV namespace details
wrangler kv namespace list
```

### R2 Maintenance

#### Check Storage Usage

```bash
# List objects với size
wrangler r2 object list apex-os-uploads --json | jq 'map(.size) | add'
```

#### Cleanup Orphaned Files

```bash
# List và delete old uploads (>90 days)
# Implement application-level cleanup job
```

### Cache Invalidation

```bash
# Clear KV cache (use cautiously)
wrangler kv:key delete --binding=KV session:*

# Clear specific cache keys
wrangler kv:key delete --binding=KV deals:list:*
```

---

## Sao lưu & Khôi phục

### Database Backups

#### Automated Daily Backup

Configure cron để chạy hàng ngày:

```bash
# Trong Cloudflare Dashboard → Pages → Cron (hoặc wrangler.toml)
# Daily at 2 AM UTC
0 2 * * * wrangler d1 export apex-os-db --output s3://backups/apex-os-$(date +\%Y\%m\%d).sql
```

#### Manual Backup

```bash
# Full export
wrangler d1 export apex-os-db --output backup-$(date +%Y%m%d-%H%M%S).sql

# Export với schema only
wrangler d1 execute apex-os-db --command ".schema" > schema-$(date +%Y%m%d).sql
```

#### Restore from Backup

```bash
# Create new database từ backup
wrangler d1 create apex-os-restore-$(date +%Y%m%d)

# Import backup
wrangler d1 execute apex-os-restore-$(date +%Y%m%d) --file backup-20260623.sql

# Verify và swap nếu good
# Update wrangler.toml database_id và redeploy
```

### KV Backups

KV sử dụng durable storage với automatic replication. Cho dữ liệu quan trọng:

```bash
# Export all keys (requires app logic vì KV không có bulk export)
# Nên lưu critical KV data trong D1 thay vì KV
```

### R2 Backups

```bash
# Sync to another bucket (cross-region)
wrangler r2 bucket create apex-os-backups-eu
wrangler r2 sync apex-os-uploads apex-os-backups-eu

# Hoặc copy specific objects
wrangler r2 object cp apex-os-uploads/path/file.jpg apex-os-backups/path/file.jpg
```

---

## Hướng dẫn khắc phục sự cố

### Health Endpoint Issues

#### Symptom: Returns HTML thay vì JSON

**Nguyên nhân:** Next.js locale middleware intercepting API routes.

**Khắc phục:**
1. Đảm bảo `src/middleware.ts` tồn tại với API bypass
2. Verify middleware config:
   ```bash
   cat src/middleware.ts
   ```
3. Redeploy:
   ```bash
   pnpm build
   wrangler pages deploy .open-next
   ```

#### Symptom: 404 Not Found

**Nguyên nhân:** API route missing hoặc Pages routing misconfiguration.

**Khắc phục:**
1. Kiểm tra route tồn tại:
   ```bash
   ls src/app/api/health/
   ```
2. Verify `_routes` file trong `.open-next/`:
   ```
   /api/*    cloudflare_workers
   ```
3. Redeploy

### Database Issues

#### Symptom: "D1 database not found"

**Khắc phục:**
```bash
# Check database exists
wrangler d1 list

# Nếu missing, recreate
wrangler d1 create apex-os-db
# Update wrangler.toml với new database_id
```

#### Symptom: "Table does not exist"

**Khắc phục:**
```bash
# Run migrations
wrangler d1 execute apex-os-db --file src/database/migrations/003_affiliate_schema.sql
```

#### Symptom: Slow queries

**Diagnosis:**
```bash
# Enable query logging (requires code change)
# Add EXPLAIN to queries trong development
```

**Khắc phục:**
- Thêm indexes cho frequently queried columns
- Review query patterns trong `src/lib/tracking/matcher.ts`

### Webhook Failures

#### Symptom: Webhook endpoint returns 404

**Khắc phục:**
1. Verify route exists: `src/app/api/webhooks/exchange/route.ts`
2. Check Pages routing không block path
3. Test locally:
   ```bash
   wrangler dev
   curl -X POST http://localhost:8787/api/webhooks/exchange/binance \
     -H "Content-Type: application/json" \
     -d '{"test": true}'
   ```

#### Symptom: HMAC verification fails

**Khắc phục:**
1. Verify webhook secret matches exchange configuration
2. Check signature header name (Binance: `X-Binance-Signature`, Bybit: `X-Bybit-Signature`)
3. Đảm bảo raw body được dùng cho HMAC (không parse JSON trước)

### Authentication Issues

#### Symptom: "BETTER_AUTH_SECRET must be 32+ characters"

**Khắc phục:**
```bash
openssl rand -base64 32
# Update .env.local và Cloudflare Pages env vars
```

#### Symptom: OAuth redirect URI mismatch

**Khắc phục:** Thêm vào OAuth provider:
```
https://apex-os.pages.dev/api/auth/callback/[provider]
```

### Build/Deployment Issues

#### Symptom: Build fails với OpenNext errors

**Khắc phục:**
```bash
# Clean và reinstall
rm -rf node_modules .next .open-next
pnpm install

# Verify Node version
node --version  # Should be 18 hoặc 20

# Build
pnpm build
```

#### Symptom: Images not loading

**Khắc phục:** Đảm bảo `next.config.js` có:
```javascript
images: {
  unoptimized: true,
}
```

---

## Thủ tục Triển khai

### Pre-Deployment Checklist

```bash
# 1. Verify environment variables
cat .env.local | grep -v '^#' | grep '='

# 2. Run linting
pnpm lint

# 3. Run tests
pnpm test

# 4. Build locally
pnpm build

# 5. Verify build output
ls -la .open-next/  # if using OpenNext
ls -la .next/       # if deploying directly
```

### Deployment Methods

#### Method 1: Wrangler CLI (Direct)

```bash
# Build first
pnpm build

# Deploy
wrangler pages deploy .open-next --project-name apex-os

# Với branch name (preview)
wrangler pages deploy .open-next --branch feature-branch
```

#### Method 2: GitHub Integration (Recommended)

1. Push to GitHub
2. Cloudflare Pages auto-deploys (nếu configured)
3. Monitor build trong Cloudflare Dashboard

### Post-Deployment Verification

```bash
# 1. Get deployment URL
wrangler pages deployment show-latest --project-name apex-os

# 2. Test health endpoint
curl https://apex-os.pages.dev/api/health

# 3. Test critical flows
# - Authentication
# - Deal listing
# - Click tracking
# - Webhook endpoint (test với mock)
```

### Rollback Procedures

```bash
# List deployments
wrangler pages deployment list --project-name apex-os

# Rollback to specific deployment
wrangler pages deployment rollback --project-name apex-os <deployment-id>

# Hoặc qua Dashboard:
# Pages → Deployments → Select previous → Promote to production
```

---

## Liên hệ khẩn cấp

### Internal

| Vai trò | Liên hệ | Escalation |
|---------|---------|------------|
| DevOps On-Call | devops@apex-os.com | P0 → SMS/Phone |
| Engineering Manager | em@apex-os.com | P1+ |
| CTO | cto@apex-os.com | P0 only |
| Founder | founder@apex-os.com | P0 only |

### External Support

| Dịch vụ | Hỗ trợ | URL |
|---------|--------|-----|
| Cloudflare | 24/7 support (enterprise) | https://support.cloudflare.com/ |
| OpenNext | GitHub Issues | https://github.com/opennextjs/opennext/issues |
| Better Auth | Discord | https://discord.gg/better-auth |

### Communication Channels

- **Primary:** `#infra-alerts` trên Slack
- **Secondary:** `#general` cho status updates
- **Incident:** `#incident-response` cho active incidents
- **Status Page:** https://status.apex-os.com (nếu configured)

---

## Tham khảo nhanh

### Essential Commands

```bash
# Development
pnpm dev                    # Start dev server
pnpm build                 # Production build
pnpm lint                  # Lint check
pnpm test                  # Run tests

# Wrangler
wrangler dev              # Local Workers dev
wrangler pages deploy     # Deploy to Pages
wrangler d1 list          # List databases
wrangler d1 execute DB --command "SQL"  # Run SQL

# Monitoring
curl https://apex-os.pages.dev/api/health
./scripts/test-health.sh
./scripts/setup-monitoring.sh --all

# Logs
wrangler pages deployment tail --project-name apex-os
```

### Important URLs

| Resource | URL |
|----------|-----|
| Production App | https://apex-os.pages.dev |
| Cloudflare Dashboard | https://dash.cloudflare.com/pages |
| UptimeRobot | https://uptimerobot.com/dashboard |
| Status Page | (to be configured) |
| Runbooks | `docs/deployment-runbook.md`, `docs/operational-runbook.md`, `docs/admin-dashboards.md`, `docs/alerting-runbook.md` |

### Environment Variables Checklist

| Biến | Bắt buộc | Mục đích |
|------|----------|----------|
| BETTER_AUTH_SECRET | Yes | Auth encryption |
| NEXT_PUBLIC_APP_URL | Yes | OAuth callbacks |
| RESEND_API_KEY | Yes | Email delivery |
| STELLAR_SECRET_KEY | Yes | Payouts |
| BINANCE_WEBHOOK_SECRET | Yes | Trade verification |
| BYBIT_WEBHOOK_SECRET | Yes | Trade verification |
| POLAR_ACCESS_TOKEN | Optional | Subscriptions |
| SEPAY_MERCHANT_ID | Optional | Vietnam payments |
| ALERT_EMAIL_ENABLED | Optional | Alert notifications |
| SLACK_WEBHOOK_URL | Optional | Alert notifications |
| TELEGRAM_BOT_TOKEN | Optional | Alert notifications |

---

## Các sửa lỗi gần đây / Recent Fixes

### 2026-06-29

- **D1Database type mismatch** — Unified `D1Database` interface between `src/lib/auth/adapters/d1-adapter.ts` and `src/types/d1.ts`. Added `exec()`, `D1ExecResult`, `D1QueryResult`, `D1Meta` to resolve type errors.
- **Analytics module imports** — Fixed imports in analytics module to use `@/lib/db` instead of `@/types/d1`.
- **Analytics types** — Added missing exports and fixed field names in `src/types/analytics.ts`.
- **Exchange metrics** — Added `total_revenue` field and fixed column name in `src/lib/analytics/exchange-metrics.ts`.
- **Dispatcher route** — Fixed `result.changes` → `result.meta.changes` to match D1 API.
- **Query monitor** — Removed invalid args from `query-monitor.ts` and replaced `firstColumnMap()` with correct method.

**Verification:** Build passes, 60/60 test suites pass (1468 tests).

---

## Recent Fixes

| Date | Issue | Resolution |
|------|-------|------------|
| 2026-06-29 | D1Database type mismatch between `d1-adapter.ts` and `d1.ts` | Unified interface — added `exec()`, `D1ExecResult`, `D1QueryResult`, `D1Meta` to shared types |
| 2026-06-29 | Analytics module importing from wrong path (`@/types/d1` instead of `@/lib/db`) | Fixed import paths across analytics module |
| 2026-06-29 | Missing exports and wrong field names in `src/types/analytics.ts` | Added missing exports, corrected field names |
| 2026-06-29 | `exchange-metrics.ts` missing `total_revenue` column | Added column and corrected column name reference |
| 2026-06-29 | Dispatcher route using `result.changes` instead of `result.meta.changes` | Fixed to use correct D1 result structure |
| 2026-06-29 | `query-monitor.ts` using invalid args and deprecated `firstColumnMap()` | Removed invalid args, replaced with supported API |
| 2026-06-29 | Missing OKX webhook integration documentation | Created `docs/exchanges/okx.md` |

**Verification:** Build passes, 60/60 test suites (1468 tests) green.

---

## Phụ lục

### Runbook Maintenance

Runbook này cần được review:

- **Hàng tuần:** Verify health endpoint accessibility và monitoring alerts
- **Hàng tháng:** Update contact information, test alert channels
- **Hàng quý:** Review và update procedures dựa trên incidents
- **Sau mỗi incident:** Document new scenarios và update playbooks

### Document Versions

| Version | Ngày | Thay đổi |
|---------|------|----------|
| 2.0 | 2026-06-23 | Cập nhật với thông tin monitoring/alerting mới |
| 1.0 | 2026-06-22 | Initial operational runbook |

---

**Lưu ý:** Khi nghi ngờ, hãy kiểm tra health endpoint trước tiên, review recent deployments, và communicate sớm.

---

## Tài liệu tham khảo

- [Deployment Runbook](./deployment-runbook.md)
- [Alerting Runbook](./alerting-runbook.md)
- [Alert Response Procedures](./alert-response-procedures.md)
- [Monitoring Setup](./monitoring-setup.md)
- [Admin Dashboards Guide](./admin-dashboards.md)
- [CLAUDE.md](../CLAUDE.md) - Project overview và development guide
