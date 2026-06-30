---
title: "Sprint 3: Analytics Engine & Admin Dashboard"
description: "Build analytics data pipeline and admin dashboard for performance insights"
status: pending
priority: P0
effort: 80h
branch: main
tags: [apex-os, q3-2026, analytics, dashboard, admin]
created: 2026-06-22
depends:
  - "sprint-02-kucoin-integration"
---

# Sprint 3: Advanced Analytics Engine

**Goal:** Provide deep insights into affiliate performance, conversion funnels, and exchange-specific metrics

**Timeline:** Week 5-6 of Q3 (July 29 - August 11, 2026)
**Capacity:** 80 hours

---

## Phase Overview

| Phase | Task | Priority | Effort | Status |
|-------|------|----------|--------|--------|
| 1 | Analytics Data Pipeline (DB Views + Materialization) | P0 | 20h | pending |
| 2 | Analytics API Layer | P0 | 20h | pending |
| 3 | Admin Analytics Dashboard | P0 | 25h | pending |
| 4 | Performance Optimization | P1 | 15h | pending |

---

## Phase 1: Analytics Data Pipeline (20h)

### Objective
Create D1 materialized views and scheduled refresh jobs for fast query performance

### Tasks

1. **Design Analytics Schema** (4h)
   - Identify key metrics:
     - Daily deal performance: impressions, clicks, conversions, revenue, payout
     - Daily affiliate performance: new signups, active affiliates, tier distribution
     - Exchange breakdown: volume per exchange, top pairs
     - Funnel metrics: click-to-conversion rate, activation rate
   - Define dimensions: date, deal_id, affiliate_id, exchange, category
   - Define measures: count, sum, avg, percentile

2. **Create Materialized Views** (8h)
   - `analytics_daily_deals` view:
     ```sql
     SELECT
       DATE(dc.clicked_at) as date,
       d.id as deal_id,
       d.exchange,
       d.title,
       COUNT(DISTINCT dc.id) as impressions,
       COUNT(DISTINCT CASE WHEN dc.user_id IS NOT NULL THEN dc.id END) as registered_clicks,
       COUNT(DISTINCT cv.id) as conversions,
       SUM(cv.commission_amount) as commission_usd,
       SUM(cv.trade_volume_usd) as trade_volume_usd
     FROM deals d
     LEFT JOIN deal_clicks dc ON dc.deal_id = d.id AND dc.clicked_at >= DATE('now', '-90 days')
     LEFT JOIN conversions cv ON cv.deal_id = d.id AND cv.created_at >= DATE('now', '-90 days')
     WHERE d.is_active = true OR d.created_at >= DATE('now', '-30 days')
     GROUP BY date, d.id
     ```
   - `analytics_daily_affiliates` view:
     ```sql
     SELECT
       DATE(cv.created_at) as date,
       a.id as affiliate_id,
       p.email,
       COUNT(DISTINCT cv.id) as conversions,
       SUM(cv.commission_amount) as earnings_usd,
       COUNT(DISTINCT dc.id) as referred_clicks,
       COUNT(DISTINCT u2.id) as new_signups
     FROM profiles a
     JOIN referral_tree rt ON rt.affiliate_id = a.id
     JOIN profiles u1 ON u1.id = rt.user_id
     LEFT JOIN deal_clicks dc ON dc.user_id = u1.id AND dc.clicked_at >= DATE('now', '-30 days')
     LEFT JOIN conversions cv ON cv.user_id = u1.id AND cv.created_at >= DATE('now', '-30 days')
     LEFT JOIN profiles u2 ON u2.referred_by = a.id AND u2.created_at >= DATE('now', '-30 days')
     WHERE a.role = 'affiliate'
     GROUP BY date, a.id
     ```
   - `analytics_exchange_breakdown` view
   - `analytics_funnel_metrics` view

3. **Migration for Views** (4h)
   - Create `src/database/migrations/006_analytics_views.sql`
   - Use `CREATE VIEW IF NOT EXISTS` for idempotency
   - Add comments explaining each view
   - Test on staging with sample data

4. **Scheduled Refresh Job** (4h)
   - D1 does not have native materialized view refresh
   - Create `refresh_analytics_views` function in SQL that drops/recreates views
   - Configure Wrangler Scheduler: `0 2 * * *` (daily 2am UTC)
   - Cron endpoint: `POST /api/cron/refresh-analytics`
   - Protected by secret token: `ANALYTICS_REFRESH_SECRET`
   - Log refresh results to `cron_execution_logs`

**Acceptance Criteria:**
- [ ] All 4 analytics views created successfully
- [ ] Views return accurate counts matching raw tables
- [ ] Daily cron job executes without errors
- [ ] Refresh logs show success/failure history

---

## Phase 2: Analytics API Layer (20h)

### Objective
Build RESTful API endpoints with caching for admin dashboard queries

### Tasks

1. **Analytics Query Builder** (6h)
   - `src/lib/analytics/query-builder.ts`
   - Class `AnalyticsQuery` with methods:
     - `dateRange(start: string, end: string): this`
     - `exchange(exchange: Exchange): this`
     - `deal(dealId?: string): this`
     - `affiliate(affiliateId?: string): this`
     - `execute(): Promise<QueryResult>`
   - Generates parameterized SQL safely (prevent injection)
   - Supports pagination: `LIMIT ? OFFSET ?`
   - Support aggregations: `sum()`, `avg()`, `count()`

2. **Analytics API Routes** (8h)
   - `src/app/api/analytics/deals/route.ts`
     - GET with query params: `?date_from=...&date_to=...&exchange=...&page=1&limit=50`
     - Response: `{ data: [], total: number, page: number, page_size: number }`
   - `src/app/api/analytics/affiliates/route.ts`
     - GET with ranking: `?metric=earnings&top=10&date_range=30d`
   - `src/app/api/analytics/funnel/route.ts`
     - GET: `?date_range=7d` → returns funnel stages
     ```json
     {
       "period": "7d",
       "stages": [
         {"name": "visitors", "count": 1000},
         {"name": "deal_clicks", "count": 200},
         {"name": "conversions", "count": 20},
         {"name": "payouts", "count": 15}
       ]
     }
     ```
   - `src/app/api/analytics/exchanges/route.ts`
     - GET: exchange comparison metrics

3. **Caching Layer** (4h)
   - Use Cloudflare KV for caching
   - Cache key: `analytics:{path}:{hash(queryParams)}`
   - TTL: 5 minutes for most endpoints
   - Bypass cache for `?refresh=true` (admin only)
   - Cache hit/miss metrics for monitoring

4. **API Documentation** (2h)
   - `docs/api/analytics.md` with examples
   - OpenAPI/Swagger annotations (optional)
   - Sample curl commands

**Acceptance Criteria:**
- [ ] All 4 API endpoints return correct data
- [ ] Query builder generates valid SQL with parameters
- [ ] Caching reduces DB load (measure cache hit rate)
- [ ] Pagination works on large datasets
- [ ] API documentation complete with examples

---

## Phase 3: Admin Analytics Dashboard (25h)

### Objective
Build comprehensive admin UI with charts, tables, and export functionality

### Tasks

1. **Dashboard Layout & Navigation** (4h)
   - `src/app/[locale]/admin/analytics/page.tsx`
   - Sidebar navigation: Overview, Deals, Affiliates, Funnel, Exchanges
   - Date range picker component (reusable)
   - Export buttons (CSV) on each section
   - Loading states + skeleton screens
   - Dark mode support (use existing Tailwind config)

2. **Chart Components** (8h)
   - Choose library: Recharts (recommended) or Chart.js
   - Install: `pnpm add recharts`
   - Create reusable components:
     - `LineChart.tsx`: time series (earnings over time)
     - `BarChart.tsx`: top deals/affiliates ranking
     - `PieChart.tsx`: exchange breakdown, commission distribution
     - `FunnelChart.tsx`: conversion funnel visualization
   - All charts:
     - Responsive (use `ResponsiveContainer` from Recharts)
     - Tooltips with formatted values
     - Legend with click-to-hide
     - Date axis formatting

3. **Overview Section** (5h)
   - KPI cards (4):
     - Total Volume (30d): `$X,XXX`
     - Total Commissions: `$X,XXX`
     - Active Deals: count
     - Active Affiliates: count
   - Mini charts:
     - Volume trend (7d line chart)
     - Top 5 deals by conversions (bar)
     - Exchange share (pie)
   - All data from `/api/analytics/deals` aggregated

4. **Deals Performance Table** (4h)
   - `components/admin/analytics/DealsTable.tsx`
   - Columns: Deal title, Exchange, Impressions, Clicks, Conversions, CTR, Volume, Commission
   - Sortable: click column headers
   - Pagination (server-side, 50 per page)
   - Filter: by exchange, date range
   - Export CSV: all columns, filtered results

5. **Affiliates Leaderboard** (4h)
   - `components/admin/analytics/AffiliatesTable.tsx`
   - Columns: Affiliate (email), Signups, Clicks, Conversions, Earnings, Avg Commission
   - Sortable, paginated
   - "View Detail" link → affiliate profile page (future)
   - Export CSV

**Acceptance Criteria:**
- [ ] Admin analytics page loads with all sections
- [ ] Charts render correctly with sample data
- [ ] Date range picker updates all charts
- [ ] Tables sort and paginate
- [ ] CSV export works for all tables
- [ ] Page load time <3s with 90 days of data

---

## Phase 4: Performance Optimization (15h)

### Tasks

1. **Database Query Optimization** (6h)
   - Analyze slow queries: `EXPLAIN` on analytics views
   - Add indexes:
     ```sql
     CREATE INDEX IF NOT EXISTS idx_deals_active ON deals(is_active, exchange, created_at);
     CREATE INDEX IF NOT EXISTS idx_deal_cllicks_date ON deal_clicks(clicked_at);
     CREATE INDEX IF NOT EXISTS idx_conversions_date ON conversions(created_at);
     CREATE INDEX IF NOT EXISTS idx_earnings_date ON earnings(created_at);
     ```
   - Partition large tables by month (if needed)
   - Document indexes in `docs/database-performance.md`

2. **API Response Caching** (4h)
   - Implement KV caching (already planned in Phase 2)
   - Cache analytics queries by hash of query params
   - Invalidate cache on data refresh (after daily view refresh)
   - Add `Cache-Control` headers for client-side caching

3. **Dashboard Performance** (5h)
   - Lazy load chart components with `next/dynamic`
   - Virtual scrolling for tables >100 rows (react-window)
   - Debounce date range changes (wait 500ms before API call)
   - Parallel API calls for independent chart data
   - Measure and target: FCP <1s, LCP <2.5s

**Acceptance Criteria:**
- [ ] All analytics queries <500ms (p95)
- [ ] Dashboard FCP <1s on 3G simulation (Chrome DevTools)
- [ ] API cache hit rate >80%
- [ ] No React waterfall rendering issues (parallel data fetching)

---

## Testing Strategy

1. **Unit Tests** (20% of effort)
   - `src/__tests__/analytics/query-builder.test.ts`: SQL generation
   - `src/__tests__/analytics/views.test.ts`: view data accuracy
   - Mock D1 database with `@signalwire/d1-mock`

2. **Integration Tests** (15% of effort)
   - Test API endpoints with sample data
   - Test cron job: refresh views → verify data updated
   - Test caching: same query hits KV

3. **Manual QA** (Post-sprint)
   - Compare admin dashboard charts to raw SQL queries
   - Verify CSV exports match UI tables
   - Test date range edge cases (leap years, month boundaries)

---

## Environment Variables

None new (reuses existing D1, KV)

---

## Files to Create/Modify

**New:**
- `src/database/migrations/006_analytics_views.sql`
- `src/lib/analytics/query-builder.ts`
- `src/lib/analytics/views/` (individual view definitions)
- `src/app/api/analytics/deals/route.ts`
- `src/app/api/analytics/affiliates/route.ts`
- `src/app/api/analytics/funnel/route.ts`
- `src/app/api/analytics/exchanges/route.ts`
- `src/app/api/cron/refresh-analytics/route.ts`
- `src/app/[locale]/admin/analytics/page.tsx`
- `src/components/admin/analytics/` (charts, tables)
- `docs/api/analytics.md`
- `docs/database-performance.md`
- `src/__tests__/analytics/` (tests)

**Modified:**
- `wrangler.toml` (add cron job)
- `CLAUDE.md` (analytics section)
- `package.json` (add recharts dependency)

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| D1 views too slow on 90-day queries | Medium | High | Materialize to temporary tables, add indexes, consider summary tables |
| KV cache invalidation complexity | Medium | Medium | Simple TTL-based invalidation. Manual purge via admin button if needed |
| Chart library bundle size | Low | Medium | Tree-shake Recharts, lazy load dashboard route |
| Admin dashboard overwhelming UX | Medium | Low | Progressive disclosure: summary → drill down. User testing |

---

## Success Criteria

- Admin can view 30-day performance metrics in <3s
- CSV export contains all filtered data correctly
- Daily analytics refresh completes by 3am UTC
- API cache hit rate >80%
- Zero data discrepancies between raw tables and dashboard

---

## Post-Sprint Actions

1. Schedule Sprint 4: Email Automation (P1)
2. Review analytics metrics with product team
3. Add alerts for data freshness (views not refreshed)
4. Document dashboard usage guide for admins

---

**Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT

Summary: Complete analytics engine and admin dashboard

Concerns/Blockers:
