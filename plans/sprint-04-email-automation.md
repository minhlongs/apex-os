---
title: "Sprint 4: Email Automation & Lifecycle Campaigns"
description: "Build email automation system with Resend, templates, and lifecycle triggers"
status: pending
priority: P1
effort: 40h
branch: main
tags: [apex-os, q3-2026, email, automation, resend]
created: 2026-06-22
depends:
  - "sprint-03-analytics-engine"
---

# Sprint 4: Email Automation System

**Goal:** Implement automated email campaigns to improve user engagement and retention

**Timeline:** Week 7 of Q3 (August 12-18, 2026)
**Capacity:** 40 hours

---

## Phase Overview

| Phase | Task | Priority | Effort | Status |
|-------|------|----------|--------|--------|
| 1 | Email Infrastructure Setup | P0 | 6h | pending |
| 2 | Email Template Development | P0 | 16h | pending |
| 3 | Email Queue & Scheduler | P0 | 10h | pending |
| 4 | Event Triggers & Testing | P1 | 8h | pending |

---

## Phase 1: Infrastructure Setup (6h)

### Tasks

1. **Resend Configuration** (2h)
   - Verify `RESEND_API_KEY` in production exists and has credit
   - Create sender domain: `noreply@apex-os.com`
     - Add DNS TXT records for SPF, DKIM, DMARC
     - Verify domain in Resend dashboard
   - Test email deliverability to Gmail, Outlook, Yahoo
   - Set up Resend webhook for bounce/event tracking: `POST /api/webhooks/resend`

2. **Email Queue Database** (2h)
   - Migration `007_email_queue.sql`:
     ```sql
     CREATE TABLE email_queue (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       recipient_email TEXT NOT NULL,
       template_name TEXT NOT NULL,
       template_vars JSON NOT NULL,
       priority INTEGER DEFAULT 0,
       status TEXT CHECK(status IN ('pending', 'sent', 'failed', 'bounced')) DEFAULT 'pending',
       scheduled_at TIMESTAMP NOT NULL,
       sent_at TIMESTAMP,
       attempt_count INTEGER DEFAULT 0,
       last_error TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     );
     CREATE INDEX idx_email_queue_status ON email_queue(status, scheduled_at);
     CREATE INDEX idx_email_queue_recipient ON email_queue(recipient_email);
     ```
   - `email_events` table for tracking opens/clicks:
     ```sql
     CREATE TABLE email_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       email_queue_id INTEGER REFERENCES email_queue(id),
       event_type TEXT CHECK(event_type IN ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained')),
       event_timestamp TIMESTAMP NOT NULL,
       metadata JSON
     );
     ```

3. **Resend API Client** (2h)
   - `src/lib/emails/resend-client.ts`
   - Functions:
     - `sendEmail(templateName, to, variables): Promise<EmailResult>`
     - `bulkSend(emails: EmailRequest[]): Promise<BatchResult>`
   - Error handling: rate limits (1 req/sec free, 100/min paid)
   - Retry logic: exponential backoff on 429/5xx

**Acceptance Criteria:**
- [ ] Resend domain verified and sending test email succeeds
- [ ] Email queue tables created in D1
- [ ] Resend client can send email to test address
- [ ] Webhook endpoint ready to receive Resend events

---

## Phase 2: Email Templates (16h)

### Objective
Create React Email components for all automated emails

### Tasks

1. **Email Base Components** (4h)
   - `src/emails/components/EmailLayout.tsx`
     - Header: ApexOS logo (SVG), brand color (#1a1a2e)
     - Footer: unsubscribe link, support email, address
     - Dark mode variant (media query or inline styles)
     - Mobile-responsive (max-width 600px, fluid layout)
   - `src/emails/components/Button.tsx` (primary/secondary variants)
   - `src/emails/components/Heading.tsx`, `Text.tsx`, `Spacer.tsx`
   - Use `@react-email/components` package for base primitives

2. **Transactional Templates** (12h)

   **Welcome Email** (`WelcomeEmail.tsx`) - sent on signup
   - Subject: `Welcome to ApexOS - Your Affiliate Code Inside`
   - Content:
     - Personalized greeting
     - Reveal affiliate code with "Copy" button (pre-formatted)
     - CTA: "Browse Deals" / "Share Your Link"
     - Brief explainer: how commissions work (3-tier)
   - Variables: `{ name, affiliate_code, referral_link }`

   **Conversion Earned Email** (`ConversionEarnedEmail.tsx`)
   - Subject: `You earned $X.XX from a trade on {exchange}!`
   - Content:
     - Amount earned (prominent)
     - Trade details: exchange, volume, deal title
     - CTA: "View Dashboard" (link to conversions page)
     - "Your affiliate: {affiliate_email} earned too" (encourage sharing)
   - Variables: `{ amount, exchange, trade_volume_usd, deal_title, affiliate_email }`

   **Payout Sent Email** (`PayoutSentEmail.tsx`)
   - Subject: `Payout Sent: ${amount} USDC to your wallet`
   - Content:
     - Payout amount + transaction hash (linked to Stellar explorer)
     - Date + estimated arrival (Stellar: ~5-10 minutes)
     - CTA: "View Payout History"
     - Support contact for issues
   - Variables: `{ amount_usdc, tx_hash, explorer_url, payout_date }`

   **Weekly Summary Email** (`WeeklySummaryEmail.tsx`)
   - Subject: `Your Week in Review - ApexOS`
   - Content:
     - Earnings this week (card)
     - Clicks received (card)
     - Active referrals (card)
     - Top performing deal (recommendation)
     - Team growth chart (text summary)
     - CTA: "View Full Dashboard"
   - Variables: `{ week_start, week_end, earnings, clicks, active_referrals, top_deal }`

   **Deal Expiring Email** (`DealExpiringEmail.tsx`) - sent to affiliates
   - Subject: `Your deal "{title}" expires in 3 days`
   - Content:
     - Deal title + current stats (clicks, conversions)
     - Expiry date (countdown: "3 days remaining")
     - CTA: "Extend Deal" (links to admin deal edit)
   - Variables: `{ deal_title, clicks, conversions, expiry_date, deal_id }`

3. **Preview & Testing** (4h)
   - Create email preview page: `src/app/[locale]/admin/emails/preview/[template]`
   - Render each template with sample data
   - "Send Test" button to send to admin email
   - Use Resend email sandbox for development (no actual delivery)

**Acceptance Criteria:**
- [ ] All 5 templates render correctly (desktop + mobile)
- [ ] Templates pass email client testing (Litmus/Email on Acid style)
- [ ] Preview page works for all templates
- [ ] Test emails deliver to inbox (not spam folder)

---

## Phase 3: Email Queue & Scheduler (10h)

### Tasks

1. **Email Queue Service** (6h)
   - `src/lib/emails/queue.ts`
   - Function `queueEmail(request: EmailQueueRequest): Promise<void>`
     - Inserts into `email_queue` with `scheduled_at` (now or future)
     - Deduplication: check for existing pending with same recipient + template within 1h
   - Function `processQueue(batchSize = 50): Promise<ProcessResult>`
     - Pull up to `batchSize` pending emails where `scheduled_at <= NOW()`
     - Call Resend API for each
     - Update status: `sent` on success, `failed` on error
     - Increment `attempt_count`, store `last_error` on failure
   - Idempotency: dedupe by `(recipient_email, template_name, template_vars_hash)` within 24h

2. **Cron Job** (4h)
   - `POST /api/cron/process-email-queue`
   - Run every 15 minutes: `*/15 * * * *`
   - Protected by `CRON_SECRET` header check
   - Process batch of 100 emails per run
   - Log execution: `cron_execution_logs` table
   - Alert if queue size > 1000 (Slack webhook)

3. **Email Preferences** (Optional stretch)
   - Add `email_preferences` JSON column to `profiles`:
     ```json
     {
       "conversion_alerts": true,
       "payout_notifications": true,
       "weekly_digest": true,
       "marketing": false
     }
     ```
   - Queue service checks preferences before sending
   - UI: settings page with toggles

**Acceptance Criteria:**
- [ ] Queue processes emails in batches without errors
- [ ] Failed emails retry up to 3 times then mark dead
- [ ] Cron job runs every 15min automatically
- [ ] Queue size monitoring alert works
- [ ] Email preferences respected (if implemented)

---

## Phase 4: Event Triggers & Testing (8h)

### Tasks

1. **Event Hook Integration** (4h)
   - Wire events to email queue:
     - `conversion.created` → `queueEmail('conversion-earned', { conversion })`
     - `payout.sent` → `queueEmail('payout-sent', { payout })`
     - `user.signup` → `queueEmail('welcome', { user })`
     - `cron.weekly` → bulk query active users → `queueEmail('weekly-summary')`
   - Modify existing code:
     - `src/lib/earnings/calculator.ts` after commission saved
     - `src/lib/payouts/stellar-service.ts` after tx confirmed
     - `src/app/api/auth/signup/route.ts` after user created
   - Weekly cron: `0 8 * * 1` (Monday 8am UTC)

2. **Testing** (4h)
   - Unit tests for queue service:
     - `src/__tests__/emails/queue.test.ts`
     - Test deduplication, retry logic, batching
   - Integration tests:
     - Trigger conversion → verify email queued
     - Simulate Resend webhook → verify event logged
   - Manual end-to-end:
     - Create test conversion → check email received
     - Trigger manual payout → check payout email
     - Wait for weekly summary (or trigger cron manually)

3. **Resend Webhook Handler** (Optional, 2h stretch)
   - `POST /api/webhooks/resend`
   - Verify webhook signature (Resend signs with API key)
   - Events: `email.sent`, `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`
   - Update `email_queue.status` and `email_events`
   - Bounce handling: disable sending to bounced addresses

**Acceptance Criteria:**
- [ ] Conversion event triggers email within 5 minutes
- [ ] Payout sent email includes correct tx hash
- [ ] Welcome email received immediately after signup
- [ ] Weekly summary sent Monday mornings (can test manually)
- [ ] Unit tests pass for queue logic

---

## Testing Checklist

- [ ] Email renders correctly in:
  - Gmail (desktop + mobile)
  - Outlook
  - Apple Mail
  - Samsung Mail
- [ ] Unsubscribe link works (leads to settings page)
- [ ] Emails not marked as spam (check spam score)
- [ ] All dynamic variables populate correctly
- [ ] Fallback values for null variables (use `{{var || 'N/A'}}`)
- [ ] Queue processes 100 emails in <2 minutes
- [ ] Failed emails retry with backoff

---

## Environment Variables

```bash
RESEND_API_KEY=re_xxxxx  # Already present
RESEND_SENDER_DOMAIN=noreply@apex-os.com
CRON_SECRET=random-secret-for-cron-auth
```

---

## Files to Create/Modify

**New:**
- `src/database/migrations/007_email_queue.sql`
- `src/lib/emails/resend-client.ts`
- `src/lib/emails/queue.ts`
- `src/emails/templates/` (all 5 templates + components)
- `src/app/api/cron/process-email-queue/route.ts`
- `src/app/api/webhooks/resend/route.ts` (optional)
- `src/app/[locale]/admin/emails/preview/page.tsx`
- `src/__tests__/emails/queue.test.ts`

**Modified:**
- `src/lib/earnings/calculator.ts` (queue email on conversion)
- `src/lib/payouts/stellar-service.ts` (queue email on payout)
- `src/app/api/auth/signup/route.ts` (queue welcome)
- `src/app/api/cron/route.ts` (add weekly summary)
- `wrangler.toml` (add cron schedules)
- `CLAUDE.md` (email setup docs)

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Emails landing in spam | Medium | High | Set up SPF/DKIM/DMARC. Warm up domain (gradual volume). Monitor reputation |
| Resend rate limits exceeded | Low | Medium | Batch processing. Queue backpressure. Upgrade Resend plan if needed |
| Email preferences ignored | Low | Medium | Add integration test verifying preference check before queue |
| Bounce rate >2% → domain reputation damage | Medium | High | Implement bounce handler. Suppress hard bounces immediately. Monitor bounce rate daily |

---

## Success Metrics

- Email deliverability >95%
- Open rate >40% (transactional benchmark)
- Click rate >20%
- Weekly summary open rate >30%
- Zero spam complaints
- Queue processes all emails within SLA (instant for transactional, 15min for bulk)

---

## Post-Sprint Actions

1. Monitor email metrics for first 2 weeks
2. Add A/B testing for subject lines (stretch)
3. Create email preference UI if not done
4. Plan Sprint 5: Mobile App Foundation

---

**Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT

Summary: Complete email automation with Resend

Concerns/Blockers:
