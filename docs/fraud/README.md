# ApexOS Fraud Detection & Anomaly Engine

The ApexOS Fraud Detection & Anomaly Engine protects affiliate deal tracking, merchant conversions, and referral commissions against synthetic traffic, rapid-click bots, and conversion skew. It operates as an inline gate in click tracking routes (`/api/deals/[id]/click` and `/api/tracking/click`) with zero disruption to legitimate shoppers.

---

## 1. Multi-Tier Defense Architecture

```
Incoming Click Request
        │
        ▼
[ 1. IP Blocklist Check ] ───────────► Blocked IP? ──► HTTP 403 Forbidden (Halt)
        │ (Clean)
        ▼
[ 2. Dual-Window Rate Limiter ] ─────► Exceeded?   ──► HTTP 429 Too Many Requests
        │ (Clean)                                       (Escalates to auto-block if >=150/hr)
        ▼
[ 3. Velocity Anomaly Engine ] ──────► Suspicious? ──► Tag is_suspicious = 1,
        │ (Calculates Anomaly Score)                    anomaly_score, flag_reasons
        ▼
[ 4. Click Attribution & Cookie ] ───► Preserved for legitimate traffic
        │
        ▼
[ 5. Admin Review & Audit Log ] ─────► Immutable audit trail in fraud_reviews
```

---

## 2. Dual-Window IP Rate Limiter

Defined in `src/lib/fraud/rate-limiter.ts`:
- **Hourly Window:** Max **100 clicks / hour** per IP (`hourlyWindowSeconds = 3600`).
- **Daily Window:** Max **1,000 clicks / 24 hours** per IP (`dailyWindowSeconds = 86400`).
- **Auto-Block Escalation:** Any IP exceeding **150 clicks within an hour** is automatically escalated and inserted into `blocked_ips` with reason `AUTO_BLOCKED_REPEAT_OFFENDER`.

### RFC 6585-Compliant Responses
When an IP exceeds rate limits, the system halts processing and responds with HTTP 429:
```json
{
  "success": false,
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Click rate limit exceeded. Please wait before retrying.",
  "retryAfter": 1800,
  "limit": 100,
  "window": "hourly"
}
```
**Headers:**
- `Retry-After: <seconds>`
- `X-RateLimit-Limit: 100`
- `X-RateLimit-Remaining: 0`
- `X-RateLimit-Reset: <epoch_seconds>`

---

## 3. Velocity Anomaly Detection Engine

Evaluated in `src/lib/fraud/fraud-engine.ts` via `evaluateClickVelocity(db, click, thresholds)`:

### A. Rapid Multi-Click Burst Detection (`BURST_CLICK`)
- **Condition:** Successive clicks originating from the same IP address or session token within **less than 2,000 milliseconds** (`deltaMs < 2000`).
- **Anomaly Scoring:**
  - `deltaMs < 1,000ms` (sub-second click spam): Score = `0.90`
  - `1,000ms <= deltaMs < 2,000ms`: Score = `0.85`
- **Flag Reason:** `BURST_CLICK`
- **Metadata Captured:** `previousClickId`, `previousClickTimestamp`, `deltaMs`, `matchedBy` (`ip` or `session`).

### B. Abnormal Click-to-Conversion Ratio (`HIGH_CLICK_CONVERSION_RATIO`)
- **Condition:** An affiliate or deal accumulates **more than 10 clicks with a click-to-conversion ratio exceeding 10:1** (e.g., 50 clicks with 0 conversions when category baseline is 5:1).
- **Anomaly Scoring:** Base score = `0.70`
- **Flag Reason:** `HIGH_CLICK_CONVERSION_RATIO`
- **Metadata Captured:** `totalClicks`, `totalConversions`, `ratio`, `thresholdRatio`.

### C. Multi-Anomaly Probabilistic Stacking
When a click triggers both burst velocity and conversion ratio anomalies, the final anomaly score combines using an independent probabilistic union formula:
$$\text{Score}_{\text{composite}} = 1 - (1 - \text{Score}_{\text{burst}}) \times (1 - \text{Score}_{\text{ratio}})$$
Example: Burst ($0.85$) + Ratio ($0.70$) yields composite score:
$$1 - (0.15 \times 0.30) = 1 - 0.045 = 0.955$$

---

## 4. IP Blocklist System

Managed in `src/lib/fraud/ip-blocker.ts`:
- **Database Schema (`blocked_ips`):**
  - `ip_address`: Normalized IPv4 or IPv6 string.
  - `reason`: Machine-readable reason code (`AUTO_BLOCKED_REPEAT_OFFENDER`, `MANUAL_ADMIN_BLOCK`, `FRAUDULENT_CONVERSIONS`).
  - `blocked_by`: User ID or `'system'`.
  - `expires_at`: ISO timestamp or `NULL` for permanent block.
  - `is_active`: `1` (active) or `0` (unblocked).
- **IP Extraction & Normalization:** Robust extraction inspecting `CF-Connecting-IP` (Cloudflare edge header), falling back to `X-Forwarded-For` and `X-Real-IP`. IPv4-mapped IPv6 addresses (`::ffff:192.0.2.1`) are normalized to standard IPv4.
- **Rejection Behavior:** Requests from active blocked IPs immediately receive HTTP 403 Forbidden without logging valid affiliate clicks or executing redirect logic.

---

## 5. Administrative Fraud Review Dashboard

Admin UI located at `/[locale]/admin/fraud` and `/admin/fraud` with modular components in `src/components/admin/fraud/`:

### UI Capabilities
1. **Flagged Clicks Table:** Filter clicks by date range, anomaly score threshold, reason code, affiliate ID, and deal.
2. **Anomaly Breakdown Drawer:** Inspect millisecond delta, previous click timestamp, IP geolocation, user agent, and conversion history.
3. **Admin Actions:**
   - **Approve Click:** Clears `is_suspicious = 0` and restores conversion attribution.
   - **Reject Click:** Confirms fraud, permanently invalidating commission claims.
   - **Block IP:** Immediately adds offending IP to `blocked_ips` with optional expiration.
   - **Bulk Resolution:** Batch-approve or batch-reject up to 100 flagged records simultaneously.

### API Endpoints
- `GET /api/admin/fraud/clicks`: Paginated list of flagged suspicious clicks.
- `GET /api/admin/fraud/stats`: Aggregate fraud metrics (total flagged, blocked IPs, review throughput).
- `GET /api/admin/fraud/blocked-ips`: Active IP blocklist directory.
- `POST /api/admin/fraud/actions`: Submit single or bulk review decisions.

---

## 6. Immutable Audit Logging

Implemented in `src/lib/fraud/audit-logger.ts` and enforced via SQLite database triggers in `021_fraud_detection_schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS fraud_reviews (
  id TEXT PRIMARY KEY,
  click_id TEXT,
  action TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reviewer_email TEXT,
  reason TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);

-- Enforce append-only immutability
CREATE TRIGGER IF NOT EXISTS prevent_fraud_reviews_update
BEFORE UPDATE ON fraud_reviews
BEGIN
  SELECT RAISE(ABORT, 'fraud_reviews audit log entries cannot be modified');
END;

CREATE TRIGGER IF NOT EXISTS prevent_fraud_reviews_delete
BEFORE DELETE ON fraud_reviews
BEGIN
  SELECT RAISE(ABORT, 'fraud_reviews audit log entries cannot be deleted');
END;
```

Every review action taken by an administrator or system daemon writes an immutable record capturing:
- `id`: Unique UUIDv4 identifier
- `click_id`: Target click ID
- `action`: `approve`, `reject`, `block_ip`, `unblock_ip`, or `bulk_resolve`
- `reviewer_id` & `reviewer_email`: Admin session identity
- `reason` & `notes`: Administrative justification
- `created_at`: UTC timestamp

---

## 7. Operations & Rate Limit Management CLI

Operational maintenance tasks can be executed via `scripts/rate-limit-manager.ts`:

```bash
# Display current rate limiting and IP blocklist statistics
npm run rate-limit:stats

# Clean up expired rate limiting buckets and expired IP blocks
npm run rate-limit:cleanup

# Reset all rate limit counters (maintenance/testnet only)
npm run rate-limit:reset
```

---

## 8. Test Verification

The fraud subsystem is backed by 20+ automated test suites in `src/__tests__/fraud/`:
```bash
npm test src/__tests__/fraud/
# Verifies:
# - Sliding window rate limits (100/hr, 1000/day)
# - Burst velocity (<2s) and ratio skew (>10:1)
# - Multi-anomaly probabilistic union scoring
# - IP normalization and Cloudflare header extraction
# - Admin action authorization and atomic dual-write
# - SQLite trigger immutability enforcement
```
