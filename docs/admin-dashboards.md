# Admin Dashboards User Guide

**Last Updated:** 2026-06-22
**Version:** v1.0.0
**Audience:** Admin users, Affiliate managers, Operations team

---

## Table of Contents

1. [Overview](#overview)
2. [Accessing Admin Dashboards](#accessing-admin-dashboards)
3. [Metrics Dashboard](#metrics-dashboard)
4. [Alerts Dashboard](#alerts-dashboard)
5. [Analytics Dashboard](#analytics-dashboard)
6. [Deals Management](#deals-management)
7. [Affiliates Management](#affiliates-management)
8. [Health Dashboard](#health-dashboard)
9. [User Dashboard](#user-dashboard)
10. [Common Operations](#common-operations)
11. [Keyboard Shortcuts](#keyboard-shortcuts)
12. [Troubleshooting](#troubleshooting)

---

## Overview

ApexOS provides a comprehensive set of admin dashboards for managing the affiliate cashback platform. All admin pages require the `admin` role and are accessible at `/admin/*` routes.

### Dashboard Pages

| Page | Route | Purpose |
|------|-------|---------|
| Metrics | `/admin/metrics` | Business KPIs, revenue, conversions, funnel analysis |
| Alerts | `/admin/alerts` | System alerts, notification management |
| Analytics | `/admin/analytics` | Traffic sources, user behavior, device analytics |
| Deals | `/admin/deals` | CRUD management of affiliate offers |
| Affiliates | `/admin/affiliates` | Affiliate user management, performance review |
| Health | `/admin/health` | System health, database status, performance metrics |

### User Dashboards

| Page | Route | Audience |
|------|-------|----------|
| Dashboard | `/dashboard` | Shopper earnings and conversion history |
| Affiliates | `/dashboard/affiliates` | Affiliate stats and referral tree |
| Conversions | `/dashboard/conversions` | Detailed conversion history |
| Payouts | `/dashboard/payouts` | Payout history and status |

---

## Accessing Admin Dashboards

### Prerequisites

1. **Admin Role:** Your user account must have `role: 'admin'` in the `profiles` table
2. **Authentication:** Log in via Better Auth at `/[locale]/login`
3. **Locale:** Admin pages support both Vietnamese (`/vi`) and English (`/en`)

### Login Flow

```bash
# Navigate to login page
https://your-app.pages.dev/vi/login

# Enter credentials
Email: admin@yourdomain.com
Password: [your password]

# After login, redirect to admin dashboard:
https://your-app.pages.dev/vi/admin/metrics
```

### Role Assignment (First-time Setup)

If you need to assign admin role to a user:

```sql
-- Connect to D1 database
wrangler d1 execute apex-os-db --command "
  UPDATE profiles
  SET role = 'admin'
  WHERE email = 'admin@yourdomain.com';
"
```

Or via API (with existing admin session):

```bash
curl -X POST https://your-app.pages.dev/api/admin/users/[user-id]/role \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}' \
  --cookie "__session=YOUR_SESSION_COOKIE"
```

---

## Metrics Dashboard

**Route:** `/admin/metrics`  
**API:** `GET /api/metrics/business`  
**Documentation:** [../api/metrics-api.md](../api/metrics-api.md)

### Purpose

The Metrics Dashboard provides a comprehensive view of business performance, including revenue, conversions, affiliate activity, and deal performance.

### Features

#### 1. Date Range Selection

- **Default:** Last 30 days
- **Range:** 1 day to 365 days maximum
- **Controls:** Start date picker, End date picker, Apply button, Reset button

**Usage:**
- Select dates to filter all metrics
- Click "Apply" to refresh data
- Click "Reset" to restore 30-day default

#### 2. Key Performance Indicators (KPIs)

| KPI | Description | Data Source |
|-----|-------------|-------------|
| Total Revenue | Sum of all conversion revenue | `daily_revenue` |
| Total Conversions | Number of completed conversions | `conversion_rates` |
| Conversion Rate | Visitors → conversions percentage | `conversion_rates` |
| Active Affiliates | Affiliates with ≥1 conversion | `active_affiliates` |
| Total Commission | Commission liability amount | `daily_revenue` |
| Top Deal | Highest revenue deal in period | `top_deals` |
| Top Affiliate | Highest earning affiliate | `active_affiliates.top_performers` |

**Note:** KPIs reflect the selected date range and update automatically when the range changes.

#### 3. Revenue Trend Chart

Line chart showing daily trends for:
- Revenue (green line)
- Conversions (blue line)
- Commission paid (amber line)

**Interactions:**
- Hover over data points to see exact values
- Legend allows toggling series on/off
- Zoom: Mouse wheel or touch pinch (if chart library supports)

#### 4. Conversion Funnel

Visual funnel showing visitor journey:

```
Visitors → Clicks → Conversions
```

- Displays absolute counts for each stage
- Shows CTR (Click-Through Rate) and Conversion Rate percentages
- Funnel shape with color-coded stages

**Interpretation:**
- Wide drop-off between stages indicates friction points
- Compare CTR across deals to identify high-performing offers

#### 5. Top Deals Table

Ranked list of highest revenue deals:

| Column | Description |
|--------|-------------|
| Deal Name | Full deal title (truncated in chart) |
| Total Revenue | Revenue generated |
| Conversions | Number of conversions |
| Conversion Rate | Percentage |

**Table shows top 5 deals** from the chart data.

#### 6. Cache Status

At the bottom of the page:
- **Last Updated:** Timestamp of data generation
- `(cached)` indicator means response served from 5-minute cache

**Cache TTL:** 5 minutes. To force refresh:
- Wait for cache expiry, or
- Modify date range parameters

### Data Refresh

- **Automatic:** Manual only (no auto-refresh)
- **Manual:** Click the refresh icon button
- **Trigger:** Changing date range automatically fetches new data

---

## Alerts Dashboard

**Route:** `/admin/alerts`  
**API:** `GET /api/monitoring/d1` (alerts), `POST /api/monitoring/d1/snoozes`  
**Documentation:** [alert-response-procedures.md](../alert-response-procedures.md)

### Purpose

Monitor and manage system alerts, configure notification channels, and acknowledge/resolve issues.

### Features

#### 1. Filter Panel

Filter alerts by:
- **Status:** Active, Acknowledged, Resolved, Snoozed
- **Severity:** Critical, Warning, Info
- **Type:** Database, API, Business, System
- **Read Status:** Read, Unread
- **Silenced:** Yes/No
- **Search:** Text search across alert messages

**Filters are URL-persistent** - share URLs with pre-applied filters.

#### 2. Alert Table

Columns:
| Column | Description |
|--------|-------------|
| Severity | Color-coded icon (🔴 Critical, 🟡 Warning, 🔵 Info) |
| Type | Alert category (D1, API, Business) |
| Message | Brief description of the issue |
| Triggered At | When alert fired |
| Status | Current status with action buttons |
| Actions | Acknowledge, Resolve, Snooze |

**Row Actions:**
- **Acknowledge:** Mark as being investigated
- **Resolve:** Mark issue as fixed (archives alert)
- **Snooze:** Temporarily silence (1h/6h/24h)

#### 3. Summary Cards

Quick counts at top of page:
- Total Active Alerts
- Critical Alerts
- Acknowledged
- Snoozed

#### 4. Alert Lifecycle

```
Triggered → Active → (Acknowledged) → Resolved
         ↓
     (Snoozed) → Re-activates after duration
```

**Best Practices:**
- Acknowledge Critical alerts immediately
- Snooze only with documented reason
- Resolve only after confirming fix

### Managing Alerts

#### Acknowledge an Alert

1. Find the alert in the table
2. Click "Acknowledge" button
3. Status changes to "Acknowledged"
4. Other admins see it's being handled

#### Resolve an Alert

1. Verify the underlying issue is fixed
2. Click "Resolve" button
3. Alert moves to resolved state (archived)
4. Record resolution notes if prompted

#### Snooze an Alert

1. Click "Snooze" button
2. Select duration: 1 hour, 6 hours, or 24 hours
3. Enter reason (required for audit)
4. Confirm

**Snooze Best Practices:**
- Use for planned maintenance (with advance notice)
- Document ticket link or ETA in reason
- Don't snooze recurring issues - fix root cause

#### Bulk Actions

Select multiple alerts with checkboxes:
- Acknowledge selected
- Resolve selected
- Snooze selected (same duration for all)

---

## Notification Configuration

**Route:** `/admin/notifications` (or part of Alerts page)  
**API:** `GET/PATCH /api/admin/notifications`

### Purpose

Configure alert notification channels (email, Slack, Telegram) and set preferences for how and where alerts are delivered.

### Features

#### 1. Channel Configuration

##### Email Notifications

| Setting | Description | Required |
|---------|-------------|----------|
| **Resend API Key** | Resend.com API key | Yes |
| **From Email** | Sender email address | Yes |
| **From Name** | Display name for sender | Yes |
| **Recipients** | Comma-separated admin emails | Yes |
| **Enabled** | Toggle email notifications | Yes |

**Setup Steps:**
1. Get API key from [Resend](https://resend.com)
2. Verify sender domain (or use sandbox domain for testing)
3. Enter API key in configuration form
4. Add recipient email addresses
5. Click "Send Test Email" to verify

##### Slack Notifications

| Setting | Description | Required |
|---------|-------------|----------|
| **Webhook URL** | Slack incoming webhook URL | Yes |
| **Channel** | Slack channel name (e.g., #alerts) | Yes |
| **Username** | Bot display name | No (default: ApexOS Bot) |
| **Icon Emoji** | Bot icon | No |
| **Enabled** | Toggle Slack notifications | Yes |

**Setup Steps:**
1. Create Slack app at [api.slack.com](https://api.slack.com)
2. Enable "Incoming Webhooks"
3. Create webhook for target channel
4. Copy webhook URL (starts with `https://hooks.slack.com/`)
5. Paste into configuration form
6. Test with "Send Test Message" button

##### Telegram Notifications

| Setting | Description | Required |
|---------|-------------|----------|
| **Bot Token** | Telegram bot API token | Yes |
| **Chat IDs** | Comma-separated chat IDs | Yes |
| **Parse Mode** | HTML or Markdown formatting | No (default: HTML) |
| **Enabled** | Toggle Telegram notifications | Yes |

**Setup Steps:**
1. Create bot via [@BotFather](https://t.me/botfather) on Telegram
2. Copy bot token (format: `123456:ABC-DEF...`)
3. Add bot to target chat/group
4. Get chat ID (use bot like @getidsbot or send message and check `getUpdates` API)
5. Enter bot token and chat IDs
6. Toggle enabled and save

#### 2. Notification Preferences

**Global Settings:**
- **Default Priority:** normal (critical alerts always high priority)
- **Rate Limit:** Minimum seconds between notifications (default: 60)
- **Max Retries:** Number of retry attempts on failure (default: 3)
- **Retry Backoff:** Milliseconds between retries (default: 1000)

**Severity Routing:**
| Severity | Email | Slack | Telegram |
|----------|-------|-------|----------|
| Critical | ✅ | ✅ | ✅ |
| Warning | ✅ | ✅ | Optional |
| Info | Digest only | Optional | Optional |

#### 3. Test Notifications

Use the test panel to verify each channel:

1. Select channel from dropdown
2. Click "Send Test"
3. Verify message received
4. Check for errors in response

**Test Message Content:**
```
Test Alert from ApexOS

This is a test notification to verify your alert configuration.
Channel: [slack|email|telegram]
Timestamp: [current time]

If you received this, your configuration is working correctly.
```

#### 4. Notification History

View recent notification deliveries:

| Column | Description |
|--------|-------------|
| Timestamp | When notification was sent |
| Alert | Alert name that triggered notification |
| Channel | Email/Slack/Telegram |
| Status | sent / failed / retrying |
| Recipient | Email address, channel, or chat ID |
| Error | Failure message if applicable |

**Actions:**
- Filter by channel or status
- Search by alert name or recipient
- Export to CSV for audit

#### 5. Alert Suppression (Snooze)

Temporarily silence specific alerts:

| Duration | Use Case |
|----------|----------|
| 1 hour | Quick fixes, testing |
| 6 hours | Maintenance window |
| 24 hours | Extended incident with ETA |
| Custom | Specific duration in minutes |

**Creating a Snooze:**
1. Click snooze button on alert row
2. Select duration
3. Enter reason (required for audit)
4. Confirm

**Viewing Active Snoozes:**
- See "Silenced Alerts" section at bottom of page
- Shows alert name, expires at, reason
- Click "Cancel" to end snooze early

#### 6. Bulk Operations

Select multiple alerts with checkboxes:

- **Acknowledge Selected:** Mark all as being investigated
- **Resolve Selected:** Mark all as fixed (archived)
- **Snooze Selected:** Apply same snooze duration to all

---

## Analytics Dashboard

**Route:** `/admin/analytics`  
**API:** `GET /api/admin/analytics/*`

### Purpose

Deep-dive analytics into traffic sources, user behavior, device breakdown, and geographic distribution.

### Sections

#### 1. Overview

High-level metrics:
- Total visitors (unique)
- Page views
- Bounce rate
- Average session duration
- New vs returning users

#### 2. Traffic Sources

Breakdown by referrer:
- Direct traffic
- Organic search
- Social media
- Email campaigns
- Affiliate links
- Other

Visual: Pie chart or bar chart with percentages.

#### 3. Top Pages

Most visited pages:
| Page | Views | Unique Visitors | Bounce Rate |
|------|-------|-----------------|-------------|
| /deals | 12,500 | 8,300 | 45% |
| /dashboard | 5,200 | 4,100 | 32% |
| ... | ... | ... | ... |

#### 4. Device Analytics

Device breakdown:
- Desktop: X%
- Mobile: Y%
- Tablet: Z%

Additional metrics:
- Screen resolution stats
- Browser distribution
- OS breakdown

#### 5. Geographic Distribution

Map view or table showing:
- Countries with most traffic
- Cities with highest engagement
- Regional conversion rates

#### 6. Time Series

Trend data over selected period:
- Visitors over time
- Page views trend
- Conversion rate trend

**Interactions:**
- Date range selector (same as Metrics dashboard)
- Export to CSV (button on each section)

---

## Deals Management

**Route:** `/admin/deals`  
**API:** `GET/POST/PATCH/DELETE /api/deals`  
**Documentation:** See API docs in `docs/api/`

### Purpose

Create, edit, and manage affiliate offer listings (deals). Deals define the cashback terms and affiliate commission rates.

### Deal Structure

```typescript
interface Deal {
  id: string;
  name: string;           // Display name
  slug: string;           // URL-friendly identifier
  description: string;    // Detailed description
  exchange: string;       // 'binance' | 'bybit' | 'okx' | 'kucoin'
  category: string;       // 'trading' | 'spot' | 'futures' | etc.
  commission_rate: number; // Percentage (e.g., 30 for 30%)
  cashback_rate: number;   // Percentage paid to shopper
  is_active: boolean;      // Published or draft
  start_date?: string;     // When deal becomes active
  end_date?: string;       // When deal expires
  terms?: string;          // Additional terms/conditions
  created_at: string;
  updated_at: string;
}
```

### Features

#### 1. Deal Listing

Table view of all deals with:
- Search by name or description
- Filter by exchange, category, status (active/inactive)
- Sort by name, commission, created date
- Pagination (25/50/100 per page)

#### 2. Create New Deal

Click "New Deal" button → opens form:

**Required Fields:**
- Name
- Slug (auto-generated from name, editable)
- Exchange (dropdown)
- Category
- Commission Rate (%)
- Cashback Rate (%)

**Optional Fields:**
- Description
- Start/End dates
- Terms
- Active toggle

**Validation:**
- Commission + Cashback ≤ 100% (ensures margin)
- End date must be after start date
- Slug must be unique and URL-safe

#### 3. Edit Deal

Click on a deal row → opens edit form:
- All fields editable except `created_at`
- Save changes → updates DB and invalidates cache
- Deactivate instead of delete to preserve historical data

#### 4. View Deal Details

Click "View" button → dedicated page showing:
- Full deal information
- Associated clicks count
- Conversion statistics
- Top performing affiliates
- Revenue over time

#### 5. Click Tracking

Each deal has a unique tracking URL:
```
https://your-app.com/vi/deals/[slug]?ref=[affiliate_code]
```

Click metrics are tracked via:
- IP address hashing (privacy)
- User agent fingerprinting
- 30-day cookie window

### Best Practices

- **Deactivate** old deals instead of deleting (preserves historical data)
- **Commission rates:** Standard 30% affiliate, adjust based on volume
- **Cashback rates:** Competitive with market, typically 10-20%
- **Expiration dates:** Set reasonable timeframes, review quarterly

---

## Affiliates Management

**Route:** `/admin/affiliates`  
**API:** `GET /api/admin/affiliates`

### Purpose

View and manage affiliate users, review performance, and monitor referral trees.

### Features

#### 1. Affiliate List

Table showing all users with `role: 'affiliate'` or users with referrals:

| Column | Description |
|--------|-------------|
| Email | User email (linked to profile) |
| Name | Full name (if provided) |
| Referral Code | Unique code for tracking |
| Level | Position in referral tree (1=direct, 2-3=indirect) |
| Total Earnings | Lifetime earnings |
| Pending Earnings | Unpaid amount |
| Conversions | Number of successful referrals |
| Join Date | Account creation date |
| Status | Active/Inactive |

#### 2. Performance Metrics

Quick filters:
- **Top Earners:** Sort by total earnings
- **Most Active:** Sort by conversions
- **New Affiliates:** Joined in last 30 days
- **Inactive:** No conversions in 90 days

#### 3. Affiliate Details

Click on an affiliate row → detailed view:

**Tabs:**
- **Overview:** Stats, earnings summary, commission rate
- **Referral Tree:** Visual tree showing up to 3 levels of referrals
- **Conversions:** List of conversions attributed to this affiliate
- **Payouts:** Payout history and pending amounts

#### 4. Referral Tree Visualization

```
Level 1: John Doe (referrer)
  ├─ Level 2: Jane Smith → $500 earnings
  │   └─ Level 3: Bob Wilson → $200 earnings
  └─ Level 2: Alice Brown → $350 earnings
```

**Commission Structure:**
- Level 1: 30% of direct conversions
- Level 2: 10% of Level 2 conversions
- Level 3: 5% of Level 3 conversions

#### 5. Bulk Actions

- Export affiliate list to CSV
- Send email campaigns (if email integration enabled)
- Adjust commission rates (per affiliate override)

---

## Health Dashboard

**Route:** `/admin/health`  
**API:** `GET /api/health` (aggregated system health)

### Purpose

Monitor system health, database status, and performance metrics in real-time.

### Sections

#### 1. System Overview

Status indicators:
- **Application Status:** ok / degraded / error
- **Database:** Connected / Disconnected
- **KV Cache:** Connected / Disconnected
- **Uptime:** Days/Hours/Minutes

#### 2. Database Metrics

| Metric | Display | Alert Threshold |
|--------|---------|-----------------|
| Storage Used | X MB / Y MB (Z%) | >80% |
| Active Connections | Count | >50 |
| Query Latency P95 | ms | >1000ms |
| Slow Queries (1h) | Count | >10 |
| Row Scans (1h) | Count | High |

#### 3. Performance Metrics

- **Response Time:** Current, P50, P95, P99
- **Error Rate:** 4xx/5xx percentage over time
- **Request Rate:** Requests per minute
- **Cold Starts:** Count (affects first request latency)

#### 4. Resource Usage

- **Memory:** RSS, Heap Used, Heap Total
- **CPU Load:** Average over period
- **Network:** In/Out bytes

#### 5. Recent Logs

Live tail of recent log entries:
- Timestamp
- Level (INFO, WARN, ERROR)
- Message
- Request ID (for tracing)

**Auto-refresh:** Every 10 seconds

---

## User Dashboard

**Route:** `/dashboard` (shopper earnings)  
**Sub-pages:**
- `/dashboard/affiliates` (affiliate program)
- `/dashboard/conversions` (history)
- `/dashboard/payouts` (payout records)

### Purpose

End-user facing dashboard for shoppers and affiliates to track earnings and performance.

### Access

- Requires authentication
- Redirects to login if not authenticated
- Shows user-specific data only

### Dashboard Home (`/dashboard`)

#### Shopper View

- **Total Earnings:** Lifetime cashback earned
- **Pending Earnings:** Awaiting conversion/payout
- **Available Balance:** Ready for withdrawal
- **Recent Conversions:** Last 5-10 conversions with status

#### Affiliate View

If user has affiliate code or referrals:
- **Referral Code:** Display and copy button
- **Affiliate Link:** Generated tracking URL
- **Downline Stats:**
  - Direct referrals (Level 1)
  - Indirect referrals (Level 2, 3)
  - Total commission from referrals
- **Top Referrals:** List of top performing downline

### Conversions Page (`/dashboard/conversions`)

Table of all conversion records:

| Column | Description |
|--------|-------------|
| Date | When conversion recorded |
| Deal | Affiliate offer name |
| Exchange | Trading exchange |
| User | (Masked) wallet or email |
| Amount | Trade volume |
| Commission | Earned amount |
| Status | pending / approved / rejected |
| Payout Status | included / paid / excluded |

**Filters:**
- Date range
- Deal
- Exchange
- Status

### Payouts Page (`/dashboard/payouts`)

Payout history using Stellar USDC:

| Column | Description |
|--------|-------------|
| Payout ID | Transaction reference |
| Date | When payout was processed |
| Amount | USDC amount |
| Status | processing / sent / failed |
| Transaction ID | Stellar blockchain TX hash |
| Destination | Wallet address |

**Actions:**
- View transaction on Stellar Explorer
- Request payout (if eligible and manual trigger enabled)

---

## Common Operations

### Export Data

Most tables support CSV export:

1. Click "Export" button (usually top-right of table)
2. File downloads with current filtered data
3. Filename format: `apex-os-[page]-[YYYY-MM-DD].csv`

**CSV includes:**
- All visible columns
- Raw timestamps (not formatted)
- Full text (no truncation)

### Date Range Selection

All date pickers:
- Support calendar popup
- Accept manual YYYY-MM-DD input
- Validate start ≤ end
- Maximum 365 days

**Shortcuts:** (if available)
- Last 7 days
- Last 30 days
- Last 90 days
- This month
- Last quarter
- Year to date

### Search and Filter

**Global search:** (if available)
- Searches across multiple fields
- Case-insensitive
- Partial match

**Column filters:**
- Click filter icon on column header
- Type to filter that column only
- Multiple column filters combine with AND

### Pagination

- Default: 25 items per page
- Options: 10, 25, 50, 100
- Navigate with page numbers or Previous/Next
- URL updates with `?page=N&limit=M`

---

## Keyboard Shortcuts

Available globally on admin pages:

| Key | Action |
|-----|--------|
| `R` | Refresh current page data |
| `A` | Acknowledge selected alert (Alerts page) |
| `S` | Snooze selected alert (Alerts page) |
| `ESC` | Deselect / close modal |
| `/` | Focus search input |
| `Ctrl` + `K` | Open command palette (if implemented) |

---

## Troubleshooting

### Page Loads Slowly

**Cause:** Large date range or cache miss.

**Solution:**
- Reduce date range (e.g., 7 days instead of 365)
- Wait for cache to populate (first load is slowest)
- Check database performance (`/admin/health`)

### Data Missing or Incomplete

**Cause:** Date range has no data, or filters too restrictive.

**Solution:**
- Verify date range covers activity period
- Clear all filters and search terms
- Check API response directly:
  ```bash
  curl -H "Cookie: __session=..." https://your-app.com/api/metrics/business?start_date=2026-06-01&end_date=2026-06-22
  ```

### 403 Forbidden

**Cause:** User lacks admin role.

**Solution:**
- Verify your user has `role = 'admin'` in `profiles` table
- Log out and log back in (session refresh needed)

### Charts Not Rendering

**Cause:** Missing data or client-side JavaScript error.

**Solution:**
- Check browser console for errors
- Verify API response contains expected data structure
- Clear browser cache and reload

### Alerts Not Updating

**Cause:** Stale data or caching.

**Solution:**
- Click refresh button
- Check if polling is enabled (should auto-refresh every 60s)
- Verify API endpoint is accessible

---

## Support

- **API Documentation:** See `docs/api/metrics-api.md`
- **Alert Response Procedures:** See `docs/alert-response-procedures.md`
- **Alerting Runbook:** See `docs/alerting-runbook.md`
- **Alerting Quick Reference:** See `docs/alerting-quick-reference.md`
- **Operational Runbook:** See `docs/operational-runbook.md`
- **Deployment Guide:** See `docs/deployment-runbook.md`

For issues or feature requests, contact the engineering team.

---

**Related Documentation:**
- [Metrics API Reference](./api/metrics-api.md)
- [Alert Response Procedures](./alert-response-procedures.md)
- [Operational Runbook](./operational-runbook.md)
