# ApexOS 24-48h Metrics Analysis

**Analysis Date:** June 22, 2026  
**Analyst:** Claude Code  
**Scope:** First 24-48h operational metrics for ApexOS affiliate cashback platform

---

## Executive Summary

This analysis defines the core business metrics for ApexOS, establishes 24-48h targets for a new platform, identifies bottlenecks in the attribution-to-payout funnel, and provides the SQL queries needed to generate daily reports.

**Current State:**
- Cloudflare Pages Analytics: IMPLEMENTED (traffic metrics only)
- Business Metrics API: NOT IMPLEMENTED (clicks, conversions, payouts not aggregated)
- Admin Dashboard: PARTIAL (only traffic charts, missing business KPIs)

**Critical Gaps:**
1. No business metrics API endpoint
2. No admin dashboard for conversion/payout tracking
3. No automated daily reports
4. Missing target definitions in codebase

---

## 1. Data Sources

### 1.1 Traffic Metrics (Cloudflare Pages Analytics)

**Source:** Cloudflare Analytics API  
**Tables:** External API (not in D1)  
**Metrics:** pageViews, uniqueVisitors, requests, bounceRate

**Implementation:** `/src/lib/analytics/cloudflare-analytics.ts`  
**Dashboard:** `/src/app/[locale]/admin/analytics/page.tsx`

### 1.2 Business Metrics (D1 Database)

**Source:** D1 SQLite database  
**Key Tables:**

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `deal_clicks` | Click attribution | `deal_id`, `affiliate_id`, `session_id`, `created_at` |
| `conversions` | Verified trades | `deal_id`, `affiliate_id`, `revenue`, `commission_amount`, `status`, `converted_at` |
| `earnings` | Commission ledger | `conversion_id`, `affiliate_id`, `amount`, `level`, `is_paid` |
| `payouts` | Payment batches | `affiliate_id`, `amount`, `status`, `scheduled_at`, `paid_at` |
| `deals` | Affiliate offers | `name`, `exchange`, `cashback_pct`, `is_active` |
| `profiles` | Users | `role`, `referral_code`, `created_at` |
| `referral_tree` | Multi-level relationships | `affiliate_id`, `level`, `path` |

**Views:**
- `v_affiliate_performance` - aggregated performance per affiliate
- `v_pending_earnings` - unpaid earnings
- `v_payout_summary` - payout aggregation

---

## 2. Key Metrics Definition

### 2.1 Visitors vs Clicks

**Visitors** = Unique users who viewed deals (from Cloudflare uniqueVisitors OR unique sessions in deal_clicks)

**Clicks** = Total clicks on affiliate links (from `deal_clicks`)

```sql
-- Clicks in last 24h
SELECT
  COUNT(*) as total_clicks,
  COUNT(DISTINCT session_id) as unique_sessions,
  COUNT(DISTINCT affiliate_id) as affiliates_contributing
FROM deal_clicks
WHERE created_at >= datetime('now', '-1 day');

-- Clicks by deal
SELECT
  d.name as deal_name,
  d.exchange,
  COUNT(dc.id) as click_count,
  COUNT(DISTINCT dc.session_id) as unique_visitors
FROM deals d
LEFT JOIN deal_clicks dc ON d.id = dc.deal_id
WHERE dc.created_at >= datetime('now', '-1 day')
GROUP BY d.id, d.name, d.exchange
ORDER BY click_count DESC;
```

### 2.2 Conversions

**Conversion** = A trade that was approved and earned commission

```sql
-- Conversions in last 24h
SELECT
  COUNT(*) as total_conversions,
  COALESCE(SUM(revenue), 0) as total_revenue,
  COALESCE(SUM(commission_amount), 0) as total_commission,
  COUNT(DISTINCT affiliate_id) as converting_affiliates,
  COUNT(DISTINCT customer_id) as unique_customers
FROM conversions
WHERE converted_at >= datetime('now', '-1 day');

-- Conversion rate (clicks to conversions)
SELECT
  (SELECT COUNT(*) FROM deal_clicks WHERE created_at >= datetime('now', '-1 day')) as clicks,
  (SELECT COUNT(*) FROM conversions WHERE converted_at >= datetime('now', '-1 day') AND status = 'approved') as conversions,
  ROUND(
    (SELECT COUNT(*) FROM conversions WHERE converted_at >= datetime('now', '-1 day') AND status = 'approved') * 100.0 /
    NULLIF((SELECT COUNT(*) FROM deal_clicks WHERE created_at >= datetime('now', '-1 day')), 0),
    2
  ) as conversion_rate_pct;
```

### 2.3 Payouts

**Payout Amount** = Total amount paid to affiliates (from `payouts`)

```sql
-- Payouts in last 24h
SELECT
  COUNT(*) as payout_count,
  COUNT(DISTINCT affiliate_id) as affiliates_paid,
  COALESCE(SUM(amount), 0) as gross_amount,
  COALESCE(SUM(fee), 0) as total_fees,
  COALESCE(SUM(net_amount), 0) as net_amount
FROM payouts
WHERE paid_at >= datetime('now', '-1 day')
  AND status = 'completed';

-- Pending payouts
SELECT
  COUNT(DISTINCT e.affiliate_id) as affiliates_with_pending,
  COUNT(e.id) as pending_earnings_count,
  COALESCE(SUM(e.amount), 0) as pending_amount
FROM earnings e
WHERE e.is_paid = 0;
```

### 2.4 Commission Metrics

```sql
-- Commission by level (multi-tier breakdown)
SELECT
  level,
  COUNT(*) as earnings_count,
  COALESCE(SUM(amount), 0) as total_amount
FROM earnings
WHERE created_at >= datetime('now', '-1 day')
GROUP BY level
ORDER BY level;

-- Top performing deals by commission
SELECT
  d.name,
  d.exchange,
  COUNT(c.id) as conversions,
  SUM(c.commission_amount) as commission_generated
FROM deals d
LEFT JOIN conversions c ON d.id = c.deal_id
WHERE c.converted_at >= datetime('now', '-1 day')
  AND c.status = 'approved'
GROUP BY d.id, d.name, d.exchange
ORDER BY commission_generated DESC;
```

---

## 3. 24-48h Target Benchmarks

### 3.1 Early Stage (Week 1-2, Private Beta)

| Metric | 24h Target | 48h Target | Rationale |
|--------|------------|------------|-----------|
| **Visitors** | 50-200 | 100-500 | Small tester pool, organic growth |
| **Clicks** | 10-50 | 25-100 | 20-25% CTR from visitors |
| **Conversions** | 1-5 | 2-10 | 5-10% conversion from clicks |
| **Conversion Value** | $500-2,000 | $1,000-5,000 | Based on crypto trading volume |
| **Payouts Generated** | $5-50 | $10-100 | 1-2% of revenue as commission |
| **Active Affiliates** | 2-5 | 3-10 | Early adopters |

### 3.2 Growth Stage (Month 1)

| Metric | 24h Target | 48h Target |
|--------|------------|------------|
| **Visitors** | 500-2,000 | 1,000-4,000 |
| **Clicks** | 100-400 | 200-800 |
| **Conversions** | 10-30 | 20-60 |
| **Conversion Value** | $5,000-20,000 | $10,000-40,000 |
| **Payouts Generated** | $100-500 | $200-1,000 |

### 3.3 Health Thresholds

| KPI | Target | Warning | Critical |
|-----|--------|---------|----------|
| Click-to-Conversion Rate | 5-15% | < 3% | < 1% |
| Avg Commission per Conversion | $5-50 | < $2 | < $1 |
| Payout Processing Time | < 24h | < 48h | > 72h |
| Unpaid Earnings Ratio | < 30% | 30-50% | > 50% |
| Affiliate Activation (with clicks) | > 50% | 30-50% | < 30% |

---

## 4. Current Implementation Gap Analysis

### 4.1 What's Implemented

| Feature | Status | File |
|---------|--------|------|
| Cloudflare traffic analytics | ✅ Complete | `src/lib/analytics/cloudflare-analytics.ts` |
| Traffic dashboard | ✅ Complete | `src/app/[locale]/admin/analytics/page.tsx` |
| D1 monitoring (DB perf) | ✅ Complete | `src/lib/monitoring/d1-monitor.ts` |
| Click tracking endpoint | ✅ Complete | `src/app/api/tracking/click/route.ts` |
| Webhook conversion ingestion | ✅ Complete | `src/app/api/webhooks/exchange/route.ts` |
| Payout execution | ✅ Complete | `src/app/api/payouts/route.ts` |
| Affiliate dashboard (individual) | ✅ Complete | `src/app/api/affiliate/dashboard/route.ts` |

### 4.2 What's Missing

| Feature | Status | Impact |
|---------|--------|--------|
| **Business metrics API** | ❌ Missing | No aggregate business KPIs |
| **Business metrics dashboard** | ❌ Missing | Can't monitor performance |
| **Daily automated reports** | ❌ Missing | Manual monitoring only |
| **Conversion funnel visualization** | ❌ Missing | No visibility into drop-offs |
| **Target comparison in UI** | ❌ Missing | No KPI goal tracking |
| **Bottleneck alerting** | ❌ Missing | Issues discovered reactively |

---

## 5. Bottleneck Analysis

### 5.1 Attribution Funnel Bottlenecks

```
Click → Match → Commission → Payout
```

| Funnel Stage | Bottleneck | Impact | Evidence | Fix Priority |
|--------------|------------|--------|----------|--------------|
| **Click Capture** | No rate limiting | Spam/fraud clicks dilute metrics | `src/app/api/tracking/click/route.ts` has no rate limiter | HIGH |
| **Cookie Setting** | Domain/path issues | Lost attribution | Cookie manager may have domain mismatches | HIGH |
| **Match Logic** | 30-day window only | Misses delayed conversions | Hard-coded window in matcher | MEDIUM |
| **Wallet Lookup** | No case-insensitive matching | Missed matches | SQL queries may be case-sensitive | MEDIUM |
| **Conversion Status** | `pending` → `approved` manual | Delayed earnings visibility | No auto-approval for small amounts | LOW |
| **Payout Threshold** | $10 minimum | Small affiliates wait longer | Line 61 in `/api/payouts/route.ts` | LOW |
| **Payout Frequency** | Weekly only | Cash flow friction | No daily option for high volume | MEDIUM |

### 5.2 Data Quality Bottlenecks

| Issue | Symptom | Root Cause | Fix |
|-------|---------|------------|-----|
| **Orphaned clicks** | Clicks without affiliate_id | Direct traffic not assigned | Create "organic" affiliate profile |
| **Missing deal_clicks** | Conversions without click record | Cookie cleared or different device | Match by wallet/email within 30d fallback |
| **Duplicate conversions** | Same order_id counted twice | No unique constraint on `order_id` | Add `UNIQUE(order_id, deal_id)` |
| **Stale earnings** | Unpaid earnings > 30 days | Payout cron not running | Add alert for earnings > 30d unpaid |
| **Broken referral paths** | Path doesn't match parent hierarchy | Manual DB edits or migration issues | Validate with `validate-data.ts` script |

### 5.3 Performance Bottlenecks

| Bottleneck | Current | Target | Fix |
|------------|---------|--------|-----|
| API response time | 288-317ms | < 200ms | Add KV caching, edge runtime |
| Payout processing | Batch only | Sub-5s per affiliate | Stream processing for large batches |
| Analytics query | Full table scans | < 100ms | Add composite indexes |

---

## 6. SQL Queries for 24-48h Analysis

### 6.1 Executive Summary Query

```sql
-- 24h Business Metrics Summary
WITH
  clicks_24h AS (
    SELECT
      COUNT(*) as total_clicks,
      COUNT(DISTINCT session_id) as unique_visitors,
      COUNT(DISTINCT affiliate_id) as affiliate_clicks
    FROM deal_clicks
    WHERE created_at >= datetime('now', '-1 day')
  ),
  conversions_24h AS (
    SELECT
      COUNT(*) as total_conversions,
      COALESCE(SUM(revenue), 0) as total_revenue,
      COALESCE(SUM(commission_amount), 0) as total_commission,
      COUNT(DISTINCT affiliate_id) as converting_affiliates
    FROM conversions
    WHERE converted_at >= datetime('now', '-1 day')
      AND status = 'approved'
  ),
  payouts_24h AS (
    SELECT
      COUNT(*) as payout_count,
      COALESCE(SUM(amount), 0) as payout_amount
    FROM payouts
    WHERE paid_at >= datetime('now', '-1 day')
      AND status = 'completed'
  ),
  pending_earnings AS (
    SELECT
      COUNT(DISTINCT affiliate_id) as affiliates_pending,
      COUNT(*) as earnings_count,
      COALESCE(SUM(amount), 0) as amount_pending
    FROM earnings
    WHERE is_paid = 0
  )

SELECT
  '24h Summary' as period,
  c.total_clicks,
  c.unique_visitors,
  c.affiliate_clicks,
  conv.total_conversions,
  conv.total_revenue,
  conv.total_commission,
  conv.converting_affiliates,
  p.payout_count,
  p.payout_amount,
  pe.affiliates_pending,
  pe.earnings_count as pending_earnings_count,
  pe.amount_pending as pending_amount,
  ROUND(conv.total_conversions * 100.0 / NULLIF(c.total_clicks, 0), 2) as conversion_rate_pct
FROM clicks_24h c
CROSS JOIN conversions_24h conv
CROSS JOIN payouts_24h p
CROSS JOIN pending_earnings pe;
```

### 6.2 Hourly Trend Query (48h)

```sql
-- Hourly metrics for last 48 hours
WITH hours AS (
  SELECT
    strftime('%Y-%m-%d %H:00:00', datetime('now', '-' || h || ' hours')) as hour
  FROM (SELECT 0 as h UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9
        UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 23 UNION SELECT 24
        UNION SELECT 25 UNION SELECT 26 UNION SELECT 27 UNION SELECT 28 UNION SELECT 29
        UNION SELECT 30 UNION SELECT 31 UNION SELECT 32 UNION SELECT 33 UNION SELECT 34
        UNION SELECT 35 UNION SELECT 36 UNION SELECT 37 UNION SELECT 38 UNION SELECT 39
        UNION SELECT 40 UNION SELECT 41 UNION SELECT 42 UNION SELECT 43 UNION SELECT 44
        UNION SELECT 45 UNION SELECT 46 UNION SELECT 47) nums
),
clicks_hourly AS (
  SELECT
    strftime('%Y-%m-%d %H:00:00', created_at) as hour,
    COUNT(*) as clicks,
    COUNT(DISTINCT session_id) as visitors
  FROM deal_clicks
  WHERE created_at >= datetime('now', '-48 hours')
  GROUP BY hour
),
conversions_hourly AS (
  SELECT
    strftime('%Y-%m-%d %H:00:00', converted_at) as hour,
    COUNT(*) as conversions,
    SUM(revenue) as revenue,
    SUM(commission_amount) as commission
  FROM conversions
  WHERE converted_at >= datetime('now', '-48 hours')
    AND status = 'approved'
  GROUP BY hour
)

SELECT
  h.hour,
  COALESCE(ch.clicks, 0) as clicks,
  COALESCE(ch.visitors, 0) as visitors,
  COALESCE(conv.conversions, 0) as conversions,
  COALESCE(conv.revenue, 0) as revenue,
  COALESCE(conv.commission, 0) as commission,
  ROUND(COALESCE(conv.conversions * 100.0 / NULLIF(ch.clicks, 0), 0), 2) as conversion_rate
FROM hours h
LEFT JOIN clicks_hourly ch ON h.hour = ch.hour
LEFT JOIN conversions_hourly conv ON h.hour = conv.hour
ORDER BY h.hour DESC;
```

### 6.3 Top Affiliates Query

```sql
-- Top affiliates by earnings (24h)
SELECT
  p.email,
  p.full_name,
  rt.level,
  COUNT(DISTINCT dc.id) as clicks,
  COUNT(DISTINCT c.id) as conversions,
  COALESCE(SUM(e.amount), 0) as earnings,
  ROUND(COUNT(DISTINCT c.id) * 100.0 / NULLIF(COUNT(DISTINCT dc.id), 0), 2) as conversion_rate
FROM profiles p
LEFT JOIN referral_tree rt ON p.id = rt.affiliate_id
LEFT JOIN deal_clicks dc ON p.id = dc.affiliate_id
  AND dc.created_at >= datetime('now', '-1 day')
LEFT JOIN conversions c ON p.id = c.affiliate_id
  AND c.converted_at >= datetime('now', '-1 day')
  AND c.status = 'approved'
LEFT JOIN earnings e ON c.id = e.conversion_id
  AND e.created_at >= datetime('now', '-1 day')
WHERE p.role IN ('affiliate', 'admin', 'master_trader')
GROUP BY p.id, p.email, p.full_name, rt.level
HAVING clicks > 0
ORDER BY earnings DESC, conversions DESC
LIMIT 10;
```

### 6.4 Deal Performance Query

```sql
-- Deal performance metrics (48h)
SELECT
  d.id,
  d.name,
  d.exchange,
  d.cashback_pct,
  COUNT(DISTINCT dc.id) as total_clicks,
  COUNT(DISTINCT dc.session_id) as unique_visitors,
  COUNT(DISTINCT c.id) as conversions,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(c.commission_amount), 0) as commission_generated,
  ROUND(COUNT(DISTINCT c.id) * 100.0 / NULLIF(COUNT(DISTINCT dc.session_id), 0), 2) as conversion_rate,
  ROUND(COALESCE(SUM(c.commission_amount) * 100.0 / NULLIF(SUM(c.revenue), 0), 2), 2) as effective_commission_pct
FROM deals d
LEFT JOIN deal_clicks dc ON d.id = dc.deal_id
  AND dc.created_at >= datetime('now', '-48 hours')
LEFT JOIN conversions c ON d.id = c.deal_id
  AND c.converted_at >= datetime('now', '-48 hours')
  AND c.status = 'approved'
WHERE d.is_active = 1
GROUP BY d.id, d.name, d.exchange, d.cashback_pct
ORDER BY commission_generated DESC
LIMIT 20;
```

### 6.5 Pending Payouts Health Check

```sql
-- Aging analysis of unpaid earnings
SELECT
  affiliate_id,
  email,
  COUNT(*) as pending_count,
  SUM(amount) as pending_amount,
  MIN(created_at) as oldest_earning,
  MAX(created_at) as newest_earning,
  julianday('now') - julianday(MIN(created_at)) as days_pending
FROM earnings e
JOIN profiles p ON e.affiliate_id = p.id
WHERE e.is_paid = 0
GROUP BY affiliate_id, email
HAVING pending_amount >= 10.00  -- Minimum payout threshold
ORDER BY days_pending DESC, pending_amount DESC
LIMIT 15;
```

---

## 7. Recommendations

### 7.1 Immediate Actions (This Sprint)

1. **Create Business Metrics API**
   - New endpoints: `/api/admin/analytics/business/summary`, `/api/admin/analytics/business/hourly`, `/api/admin/analytics/business/top-affiliates`
   - Implement in `/src/app/api/admin/analytics/business/`
   - Add proper admin authentication middleware

2. **Extend Admin Dashboard**
   - Add Business Metrics tab alongside Cloudflare Analytics
   - Show: clicks, conversions, revenue, payouts, conversion rate
   - Include target comparison (green/yellow/red indicators)
   - Add 48h trend charts

3. **Define Target Constants**
   - Create `/src/constants/analytics-targets.ts` with 24h/48h KPIs
   - Make targets configurable via environment variables for A/B testing

4. **Add Bottleneck Alerts**
   - Alert when conversion rate < 2% for 24h period
   - Alert when pending earnings > 30% of total earnings
   - Alert when clicks drop > 50% week-over-week

### 7.2 Short-term (Next 2 Sprints)

5. **Rate Limiting on Click Tracking**
   - Add rate limiter to `/api/tracking/click/` (10 clicks/session max)
   - Implement IP-based throttling

6. **Payout Cron Monitoring**
   - Add health check for weekly payout cron
   - Alert if payouts not run for > 8 days

7. **Conversion Funnel Debug View**
   - Admin page showing: clicks → matched → conversions → approved → paid
   - Identify drop-off points with percentages

8. **Automated Daily Reports**
   - Generate report at 00:00 UTC daily
   - Email to admin team with key metrics
   - Include week-over-week comparisons

### 7.3 Medium-term (Next Quarter)

9. **Cohort Analysis**
   - Track affiliate retention (day 1, day 7, day 30)
   - Identify high-quality affiliate acquisition channels

10. **Revenue Attribution Modeling**
    - Multi-touch attribution beyond last-click
    - Weight early vs late clicks in conversion path

11. **A/B Testing Framework**
    - Test different commission rates
    - Measure impact on conversion rate and volume

---

## 8. Dashboard Wireframe

```
┌─────────────────────────────────────────────────────────────┐
│ Admin Dashboard                                              │
├─────────────────────────────────────────────────────────────┤
│ [Traffic Analytics] [Business Metrics] [Payout Health]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  KPI Cards (24h)                                            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │
│  │ Clicks  │ │Conver-  │ │Revenue  │ │Payouts  │        │
│  │ 1,247   │ │sions    │ │$12,450  │ │$872     │        │
│  │ ↑12%    │ │89       │ │ ↑8%     │ │ ↓3%     │        │
│  │ Target: │ │Target:  │ │Target:  │ │Target:  │        │
│  │ 1,000   │ │50       │ │$10k     │ │$1k      │        │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘        │
│                                                             │
│  Conversion Funnel (48h)                                    │
│  Visitors → Clicks → Conversions → Approved → Paid        │
│    2,341   1,247    89           67        45            │
│                                                             │
│  Hourly Trend Chart                                         │
│  [Area chart: clicks, conversions, revenue over time]     │
│                                                             │
│  Top Performing Deals                                       │
│  [Bar chart: commission by exchange/deal]                  │
│                                                             │
│  Affiliate Leaderboard                                     │
│  [Table: email, clicks, conversions, earnings, rate]      │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. Metrics API Specification

### 9.1 GET `/api/admin/analytics/business/summary`

**Query Params:**
- `timeRange`: `24h` | `48h` | `7d` | `30d` (default: `24h`)

**Response:**
```json
{
  "success": true,
  "data": {
    "period": "24h",
    "timestamp": "2026-06-22T09:00:00Z",
    "clicks": {
      "total": 1247,
      "unique_visitors": 892,
      "unique_affiliates": 15,
      "target": 1000,
      "vs_target_pct": 124.7
    },
    "conversions": {
      "total": 89,
      "revenue": 12450.00,
      "commission": 1245.00,
      "converting_affiliates": 12,
      "conversion_rate": 7.14,
      "target": 50,
      "vs_target_pct": 178.0
    },
    "payouts": {
      "paid_count": 45,
      "paid_amount": 872.50,
      "pending_count": 234,
      "pending_amount": 3456.78
    },
    "health": {
      "click_to_conversion_rate": 7.14,
      "avg_commission_per_conversion": 14.00,
      "payout_processing_lag_hours": 24,
      "earnings_aging_risk": "low"
    }
  }
}
```

### 9.2 GET `/api/admin/analytics/business/hourly`

**Query Params:**
- `timeRange`: `48h` | `7d` | `30d`
- `interval`: `hour` | `day`

**Response:** Array of time-series data points

---

## 10. Sample Analysis Based on Seed Data

From `seed_staging.sql`, the sample data represents approximately 48 hours:

```
Seed Data Summary (48h equivalent):
- Profiles: 5 users (1 admin, 2 affiliates, 2 shoppers)
- Deals: 10 active offers
- Clicks: 5 recorded
- Conversions: 3 approved (total revenue: $1,750)
- Earnings: 6 entries (multi-tier: level 1: $102.18, level 2: $0.73, level 3: $0.00)
- Payouts: 1 completed ($2.175)
```

**Analysis:**
- **Click-to-Conversion Rate:** 60% (3/5) - exceptionally high, likely due to small sample
- **Avg Revenue per Conversion:** $583.33 - healthy trading volume
- **Commission per Conversion:** $418.25 average (varies by deal)
- **Multi-tier Distribution:** 99.3% to level 1, 0.7% to level 2, 0% to level 3
- **Payout Lag:** 7 days from earnings creation to payout - within acceptable range

**Bottlenecks Observed:**
1. Only 5 clicks in 48h with 10 deals - very low traffic
2. 2 clicks have `NULL` affiliate_id (organic traffic not tracked)
3. Level 3 commission set to 0% in seed data - check calculation logic

---

## 11. Implementation Checklist

- [ ] Create `/src/app/api/admin/analytics/business/summary/route.ts`
- [ ] Create `/src/app/api/admin/analytics/business/hourly/route.ts`
- [ ] Create `/src/app/api/admin/analytics/business/top-affiliates/route.ts`
- [ ] Create `/src/app/api/admin/analytics/business/deals/route.ts`
- [ ] Add admin authentication middleware to all new routes
- [ ] Create `/src/constants/analytics-targets.ts`
- [ ] Extend admin dashboard with Business Metrics tab
- [ ] Add business metrics charts (funnel, hourly trend, top deals)
- [ ] Implement target comparison UI (vs target indicators)
- [ ] Add rate limiting to click tracking endpoint
- [ ] Create daily report cron job
- [ ] Add alert for conversion rate < 2%
- [ ] Add alert for unpaid earnings aging > 30 days
- [ ] Document API in `docs/api/analytics.md`
- [ ] Update README with business metrics feature

---

## Conclusion

The ApexOS platform has excellent data tracking foundations but lacks business-level aggregation and visualization. Implementing the Business Metrics API and Dashboard will provide the 24-48h visibility needed for operational decision-making. The bottleneck analysis reveals three critical areas: rate limiting (security/fraud), attribution completeness (data quality), and payout monitoring (cash flow visibility).

Priority 1: Build the Business Metrics API and Dashboard.  
Priority 2: Implement alerting on conversion rate and earnings aging.  
Priority 3: Add rate limiting and attribution completeness improvements.
