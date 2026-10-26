# ApexOS Transactional Email & Lifecycle Automation

ApexOS incorporates a resilient transactional email pipeline powered by **Resend** and **React Email**, backed by a Cloudflare D1 queue with priority scheduling, automated deduplication, and exponential retries.

---

## 1. System Architecture

```
Application Event (Signup, Conversion, Payout, Expiring Deal)
        │
        ▼
[ EmailQueueService.enqueue() ] ──────► D1 Database: email_queue table
        │                               (priority: 1=urgent, 2=standard, 3=digest)
        ▼
[ Cron Scheduler ] ───────────────────► POST /api/cron/process-email-queue
  (Hourly Worker)                                │
                                                 ▼
                                        Batch Dequeue (50 items)
                                                 │
                                                 ▼
                                        Resend API Gateway
                                                 │
                        ┌────────────────────────┴────────────────────────┐
                        ▼                                                 ▼
                 Success (200)                                     Failure / Rate Limit
                        │                                                 │
                        ▼                                                 ▼
               markSent(queue_id)                                  Increment retry_count
             Record in email_events                                (Max 3 retries)
```

---

## 2. Configuration & Credentials

Add the following environment variables to `.env.local` or Cloudflare Pages settings:

```bash
# Resend API Key
RESEND_API_KEY=re_your_api_key_here

# Sender identities
NEXT_PUBLIC_SENDER_EMAIL=ApexOS <noreply@apexos.app>
NEXT_PUBLIC_SUPPORT_EMAIL=support@apexos.app

# Cron Worker Secret (for /api/cron/process-email-queue)
CRON_SECRET=your-secure-cron-secret-32-chars
```

---

## 3. React Email Template Portfolio

Templates are built as responsive React components in `src/emails/templates/`:

### 1. `WelcomeEmail.tsx`
- **Trigger:** Dispatched immediately upon user registration (`src/contexts/auth-context.tsx`).
- **Content:** Welcomes new member, reveals their unique referral link/code, outlines initial steps to connect exchange accounts, and details tier benefits.
- **Priority:** Level 1 (High / Transactional).

### 2. `ConversionEarnedEmail.tsx`
- **Trigger:** Dispatched when an exchange trade matches via webhook (`/api/webhooks/exchange`).
- **Content:** Real-time earnings notification showing cashback amount in USD, trading exchange (Binance, Bybit, OKX, KuCoin), transaction date, and updated account balance.
- **Priority:** Level 1 (High / Transactional).

### 3. `PayoutSentEmail.tsx`
- **Trigger:** Dispatched when the weekly Stellar USDC payout batch is confirmed on-chain.
- **Content:** Payout receipt detailing USDC amount transferred, recipient Stellar public key, and direct transaction link to Stellar Expert block explorer.
- **Priority:** Level 1 (High / Transactional).

### 4. `WeeklySummaryEmail.tsx`
- **Trigger:** Dispatched on Monday morning via scheduled cron job (`/api/cron`).
- **Content:** Performance digest highlighting weekly clicks, conversion rate, direct earnings, downline tier 2/3 commissions, and current leaderboard tier ranking.
- **Priority:** Level 3 (Bulk / Digest).

### 5. `DealExpiringEmail.tsx`
- **Trigger:** Dispatched 72 hours prior to a time-limited high-yield cashback deal closing.
- **Content:** Deal expiration notice with exchange details, remaining cashback bonus, and quick-action redirect link.
- **Priority:** Level 2 (Standard Notification).

---

## 4. D1 Queue Architecture & Schema

Defined in `020_email_automation.sql`:

```sql
CREATE TABLE IF NOT EXISTS email_queue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  sent_at TEXT,
  error TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  updated_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);

CREATE TABLE IF NOT EXISTS email_events (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  email TEXT NOT NULL,
  resend_id TEXT,
  reason TEXT,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);
```

### Queue Status States
- `pending`: Enqueued, awaiting delivery worker.
- `sending`: Claimed by worker batch.
- `sent`: Successfully delivered via Resend.
- `failed`: Errored during dispatch; eligible for retry if `retry_count < 3`.
- `bounced`: Hard bounce recorded from Resend webhook.

---

## 5. Deduplication & Retry Engine

### In-Memory & Hash Deduplication
To prevent accidental double-delivery resulting from concurrent worker invocations:
- A deterministic deduplication key is calculated: `dedupe:${userId}:${type}:${subject}:${date}`.
- If a matching item is already in `pending` or `sent` status within the deduplication window, subsequent enqueue attempts are discarded cleanly.

### Batch Processing & Retries (`src/lib/emails/email-scheduler.ts`)
- **Batch Size:** 50 emails per run to avoid hitting Resend burst rate limits.
- **Retry Mechanism:**
  ```typescript
  // Selects failed emails where retry_count < 3
  SELECT * FROM email_queue
  WHERE status = 'failed' AND json_extract(metadata, '$.retry_count') < 3
  ORDER BY priority ASC, scheduled_at ASC
  LIMIT 50;
  ```
- Increments `metadata.retry_count` on each attempt. After 3 failed attempts, status is permanently set to `failed` and logged for administrative investigation.

---

## 6. Cron Trigger & Operational Endpoints

### Worker Processing Endpoint (`POST /api/cron/process-email-queue`)
```bash
curl -X POST https://apexos.app/api/cron/process-email-queue \
  -H "Authorization: Bearer ${CRON_SECRET}"
```
**Response:**
```json
{
  "success": true,
  "processed": 14,
  "sent": 14,
  "failed": 0,
  "durationMs": 420
}
```

### Admin Email Preview Interface
Admins can visually review and test all 5 templates with mock customer data at:
- `https://apexos.app/admin/emails/preview`

---

## 7. Testing & Verification

Automated test suites verify email queuing, template generation, and retry logic:

```bash
# Run email test suites
npm test src/__tests__/emails/
# Verifies:
# - Template compilation & React Email rendering
# - Queue FIFO and priority order
# - Idempotent deduplication cache
# - Retry counter incrementation and dead-letter handling
```
