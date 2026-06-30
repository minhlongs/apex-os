# Webhook Security & Replay Protection

This document covers the security measures implemented for exchange webhook handling and documents edge cases, attack vectors, and operational considerations.

## Security Architecture

### Defense-in-Depth Layers

```
Incoming Webhook
      ↓
1. HMAC Signature Verification (Binance/Bybit)
2. Replay Protection (Cloudflare KV, 24h TTL)
3. Idempotency Check (Database: deal_id + order_id)
4. Input Validation & Parsing
5. Deal Matching (active deals only)
6. User Attribution & Click Matching
```

### Replay Protection Mechanism

**Storage:** Cloudflare KV namespace (same as rate limiter)
**Key Format:** `webhook:replay:{exchange}:{symbol}:{orderId}`
**TTL:** 24 hours (86,400 seconds)
**Operation:** Atomic `kv.add()` - fails if key already exists

```typescript
// From src/app/api/webhooks/exchange/route.ts
const key = `webhook:replay:${exchange}:${symbol}:${orderId}`;
const added = await kv.add(key, 'processed', { expirationTtl: 24 * 60 * 60 });
```

### Dual Idempotency

- **KV Layer:** Fast replay check (24h window) - prevents replay attacks
- **DB Layer:** Persistent unique constraint on `(deal_id, order_id)` - prevents duplicates indefinitely

---

## Edge Cases & Attack Vectors

### 1. KV Namespace Unavailable

**Scenario:** Cloudflare KV is down or not configured in local dev.

**Current Behavior:** Fail-open with warning log.
```typescript
if (!kv) {
  console.warn('[ReplayProtection] KV not available, skipping replay check');
  return false; // Allow webhook
}
```

**Risk:** Duplicate webhooks could create multiple conversions.

**Mitigation:**
- DB idempotency check catches duplicates at the `(deal_id, order_id)` level
- Monitor KV availability through health endpoints
- Consider fail-closed for high-value transactions

**Recommendation:** Ensure KV is properly configured in production. Add alerting for KV errors.

---

### 2. Race Condition on KV Write

**Scenario:** Two identical webhooks arrive simultaneously.

**Current Behavior:** `kv.add()` is atomic. Only first write succeeds; second returns `false`.
```typescript
const added = await kv.add(key, 'processed', { expirationTtl: REPLAY_PROTECTION_TTL });
if (added) {
  console.log('[ReplayProtection] Marked webhook as processed');
} else {
  console.warn('[ReplayProtection] Key already exists during mark (race)');
}
```

**DB Protection:** Both webhooks proceed to DB check. The first transaction commits; second hits unique constraint violation or idempotency check.

**Missing Protection:** The schema does NOT have a UNIQUE constraint on `(deal_id, order_id)`. The `conversionExists` check is vulnerable to TOCTOU race condition.

**Vulnerability:**
```
Time  Webhook A              Webhook B
----- ---------------------  ---------------------
t0    check exists → false   check exists → false
t1                          check exists → false
t2    INSERT conversion
t3                          INSERT conversion ← DUPLICATE!
```

**Recommendation:** Add UNIQUE constraint to database:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversions_deal_order
ON conversions(deal_id, order_id) WHERE order_id IS NOT NULL;
```

---

### 3. Order ID Format Differences

| Exchange | Order ID Format | Example |
|----------|----------------|---------|
| Binance  | Integer (up to 9 digits) | `123456789` |
| Bybit    | UUID string | `"a1b2c3d4-e5f6-7890-abcd-ef1234567890"` |

**Key Format:** `webhook:replay:{exchange}:{symbol}:{orderId}`

**Collision Risk:** Low but possible:
- Binance order `"123"` for BTCUSDT vs Bybit order `"123"` for BTCUSDT
- Different exchange prefix provides isolation: `webhook:replay:binance:BTCUSDT:123` vs `webhook:replay:bybit:BTCUSDT:123`

**Edge Case:** Same exchange, same orderId but different symbols?
- Current key includes symbol: `{exchange}:{symbol}:{orderId}`
- If an exchange uses the same orderId for different symbols (unlikely), both would be tracked separately.

---

### 4. Time-Based Window vs Permanent Tracking

**Replay Protection:** 24-hour sliding window.
**Idempotency:** Permanent (DB constraint).

**Gap:** A duplicate webhook arriving after 24 hours would:
1. Pass KV check (key expired)
2. Be caught by DB idempotency (if unique constraint exists)
3. If no DB constraint → duplicate conversion created

**Recommendation:** Keep both layers. KV prevents immediate replay; DB prevents long-term duplicates.

---

### 5. Symbol Changes After 24 Hours

**Scenario:** Same orderId, but different symbol in the webhook (malicious or exchange bug).

**Current KV Key:** `webhook:replay:binance:BTCUSDT:12345`

If the same orderId arrives with `ETHUSDT`, it creates a different key and bypasses replay protection.

**DB Protection:** The `conversionExists` check uses `deal_id` (matched by exchange + symbol). Different symbol → different deal → different `deal_id` → duplicate allowed.

**Risk:** Low - order IDs are typically unique per exchange. But for robustness:
- Consider using only `{exchange}:{orderId}` for KV key if orderId is globally unique per exchange
- Add UNIQUE constraint on `order_id` alone if exchange guarantees uniqueness

---

### 6. Clock Skew & TTL Expiration

**Issue:** KV TTL is absolute from `kv.add()` time. If replay happens within 24h of first webhook, it's rejected. If after exactly 24h + epsilon, it may be accepted.

**Clock Skew:** Not applicable - TTL is relative to write time, not absolute timestamp.

**Edge Case:** Webhook received at `T+23:59:59` still rejected. At `T+24:00:01` accepted.

**Mitigation:** 24h is reasonable. For stricter requirements, increase to 48h or 7d.

---

### 7. KV Storage Limits & Eviction

Cloudflare KV has storage limits based on plan. Unlimited writes but finite storage.

**Eviction Policy:** LRU eviction when full. Old replay keys could be evicted before TTL.

**Impact:** A webhook that should be rejected (key evicted) could be processed again.

**Mitigation:**
- Monitor KV storage usage
- Set alerts at 80%, 90%, 95% capacity
- Consider longer TTL only if storage allows
- Rely on DB idempotency as ultimate protection

---

### 8. Signature Verification Timing

**Order of Operations:**
1. ✅ Verify HMAC signature (before replay check)
2. ✅ Check replay protection (KV)
3. ✅ Check conversion idempotency (DB)

**Rationale:** Signature verification is cheap and must pass first. Replay check is fast (KV). DB check is expensive - run last.

**Edge Case:** Invalid signature → 401 (no logging to replay KV)
**Edge Case:** Valid signature but replay → 200 with `skipped: true`

---

### 9. Malformed Payloads

**Binance Parser Issues:**

1. **Currency Extraction Bug:**
   ```typescript
   currency: symbol.replace(/USDT|USDC|BUSD|BTC|ETH/g, '')
   ```
   - `BTCUSDT` → `""` (empty string) - removes both BTC and USDT
   - `ETHUSDT` → `""` (empty string) - removes both ETH and USDT
   - `SOLUSDT` → `"SOL"` - correct

   **Impact:** Currency may be empty for 2-char base currencies. Earnings still calculated correctly (uses `totalValue`).

2. **Order ID Selection:**
   ```typescript
   orderId: String(order.i ?? order.c ?? '')
   ```
   - Uses `order.i` (numeric order ID, 6 digits) not `order.c` (UUID client order ID)
   - This matches the actual webhook data structure where `i` is the exchange order ID

**Bybit Parser:** Correctly extracts currency (only removes USDT suffix).

---

### 10. Webhook Secret Configuration

**Environment Variables:**
- `BINANCE_WEBHOOK_SECRET`
- `BYBIT_WEBHOOK_SECRET`

**Missing Secret Behavior:**
```typescript
if (!secret) {
  return { valid: false, error: `Webhook secret not configured for exchange: ${exchange}` };
}
```
→ Returns 401 Unauthorized.

**Dev vs Prod:** Use `.env.local` for dev, Cloudflare environment variables for production.

**Rotation:** Changing secret invalidates all existing webhooks. Coordinate with exchange side.

---

### 11. Timestamp Attacks (Bybit)

Bybit requires `X-Bybit-Signature-Timestamp` header. Signature is computed over:
```
timestamp + METHOD + PATH + BODY
```

**Attack Vectors:**
- **Replay with old timestamp:** Bybit server-side validates timestamp freshness (typically 5min window). Our webhook doesn't check timestamp - relies on Bybit's validation.
- **Timestamp manipulation:** Attacker could try different timestamps, but signature would be invalid without secret.

**Recommendation:** Consider adding our own timestamp validation as defense-in-depth (reject if timestamp > 5min old).

---

### 12. Database Transaction Atomicity

**Current Flow:**
1. Check `conversionExists` (SELECT)
2. Insert conversion
3. Insert earnings (multiple)

**No Transaction:** If step 2 succeeds but step 3 fails, conversion exists without earnings.

**Impact:** Partial data, manual intervention needed.

**Recommendation:** Wrap in transaction:
```typescript
await db.prepare('BEGIN TRANSACTION').run();
try {
  // ... all inserts
  await db.prepare('COMMIT').run();
} catch (e) {
  await db.prepare('ROLLBACK').run();
  throw e;
}
```

---

### 13. Rate Limiting Integration

**Separate System:** Rate limiting uses the same KV namespace but different key pattern:
- Rate limit: `rate-limit:{ip}:{route}`
- Replay: `webhook:replay:{exchange}:{symbol}:{orderId}`

**No Interference:** Different key prefixes prevent collision.

**KV Pressure:** High-volume webhooks (thousands/day) use KV for replay. Monitor KV operation count.

---

### 14. Multiple Deals for Same Symbol

**Scenario:** Two active deals for `BTCUSDT` on Binance (e.g., different commission rates for different affiliate codes).

**Current Logic:** `findDeal()` returns first matching active deal:
```sql
WHERE exchange = ? AND is_active = 1 ...
LIMIT 1
```

**Issue:** The `conversionExists` check uses the `deal_id` from the matched deal. If different deals match, same `order_id` could create multiple conversions (each with different `deal_id`).

**This is intentional:** Different deals may want to track the same order separately (e.g., promotional vs standard).

**Clarify Business Rule:** Should the same exchange order be eligible for multiple deals? If not, add constraint on `(exchange, order_id)` at the application level.

---

### 15. Webhook Retry Behavior

**Exchange Side:** Binance/Bybit retry failed webhooks (non-2xx response).

**Our Response Codes:**
- `200` - Success (including duplicates with `skipped: true`)
- `401` - Invalid signature (triggers retry → permanent failure)
- `400` - Invalid payload (triggers retry → may succeed later if payload fixed)
- `500` - Server error (triggers retry)

**Idempotency Requirement:** Retries must be safe. Our replay protection ensures idempotency.

**Best Practice:** Always return `200` for processed webhooks, even if skipped. This stops exchange retries.

---

### 16. Testing Without KV

**Local Development:** KV not available in `wrangler dev` by default.

**Current Behavior:** Replay protection skipped (fail-open).

**Testing Duplicates Locally:**
1. Run `wrangler dev` with KV binding
2. Use `--duplicate` flag on script
3. Check response for `skipped: true` on second send

**Simulating KV:** Not easily mockable without real KV. Consider adding in-memory KV mock for tests.

---

### 17. Signature Mismatch Edge Cases

**Binance:** Signature is HMAC-SHA256 of raw body. Body must be exactly as received (no whitespace changes).

**Bybit:** Signature over `timestamp + METHOD + PATH + body`. Case-sensitive.

**Common Pitfalls:**
- Frameworks that re-serialize JSON (key order changes, whitespace)
- Proxies that modify request body
- Using `request.json()` then `JSON.stringify()` must produce identical bytes

**Our Code:** Uses `await request.text()` to get raw body before parsing. This is correct.

---

### 18. Concurrent Webhooks for Same Order

**Scenario:** Exchange sends webhooks for same order due to partial fills, cancellations, etc.

**Our Filter:** Only `execType='Trade'` (Binance) or `execType='Fill'` (Bybit) are processed.

**Multiple Fill Webhooks:** Could have multiple fills for same order. Each fill has unique `tradeId` but same `orderId`.

**Current Logic:** Uses `orderId` for replay/idempotency. Second fill for same order would be rejected as duplicate.

**Business Decision:** Should we process multiple fills from same order?
- If yes: Use `tradeId` instead of `orderId` for deduplication
- If no: Current behavior is correct (one conversion per order)

**Recommendation:** Clarify with business. Most affiliate programs pay on order completion, not per fill.

---

### 19. Webhook Payload Size Limits

**Cloudflare Limits:** 100KB for POST body.

**Exchange Webhooks:** Typically < 2KB.

**Risk:** Low. But malicious large payloads could impact KV storage (key length affects storage).

**KV Key Length:** `webhook:replay:binance:BTCUSDT:123456` ≈ 50 bytes max.

---

### 20. Key Namespace Pollution

**Malicious Prefix:** If `orderId` contains `:` characters, could create key collisions:
```
Key: webhook:replay:binance:BTCUSDT:123:extra
```
But `orderId` from exchanges is numeric (Binance) or UUID (Bybit) - no colons.

**Sanitization:** Not currently needed but consider sanitizing `orderId` if future exchanges use different formats.

---

## Testing Checklist

### Unit Tests
- [x] Signature verification for Binance and Bybit
- [x] Payload parsing and standardization
- [x] Duplicate detection (conversionExists)
- [ ] KV replay check (mocked)

### Integration Tests
- [ ] Send webhook, verify 200 and conversion created
- [ ] Send duplicate, verify 200 with `skipped: true`
- [ ] Send with invalid signature, verify 401
- [ ] Send after KV TTL expired, verify 200 with `skipped: true` (DB protection)
- [ ] Concurrent sends, verify only one conversion created

### Manual Testing
```bash
# Start local server
pnpm dev

# In another terminal, send duplicate webhook
npx tsx scripts/send-mock-webhook.ts --duplicate --delay 1000

# Expected: First 200 with conversionId, second 200 with skipped:true
```

---

## Monitoring & Alerting

### Key Metrics
- `webhook_requests_total` (labels: exchange, outcome)
- `webhook_duplicate_total` (replay protection triggered)
- `webhook_errors_total` (signature_failed, parse_failed, db_error)
- `replay_kv_misses` (KV unavailable count)
- `replay_race_conditions` (kv.add() collision count)

### Log Events
```
[Webhook] Binance trade processed: {conversionId, orderId, durationMs}
[ReplayProtection] Marked webhook as processed: {exchange} {symbol} {orderId}
[ReplayProtection] KV not available, skipping replay check
[ReplayProtection] Key already exists during mark (race)
```

### Alerts
- KV error rate > 1% → investigate KV binding
- Duplicate webhook rate spike → potential attack or exchange misconfiguration
- Signature failures > 5% → secret rotation needed or attack

---

## Recommendations

### High Priority
1. **Add UNIQUE constraint** on `(deal_id, order_id)` in migrations
2. **Add transaction wrapper** around conversion + earnings creation
3. **Add timestamp validation** for Bybit (reject if >5min old)
4. **Implement retry logic** for transient KV/DB errors with exponential backoff

### Medium Priority
5. **Fix currency extraction** in Binance parser
6. **Add metrics collection** (Prometheus/OpenTelemetry)
7. **Create integration test suite** for webhook flow
8. **Document expected webhook format** for each exchange in API docs

### Low Priority
9. **Consider using tradeId** for deduplication if multiple fills per order should be tracked
10. **Add webhook signature timestamp** verification for Binance as defense-in-depth
11. **Implement webhook replay window** configuration (currently hardcoded 24h)

---

## Reference

### Exchange Documentation
- [Binance: Payload Hashing](https://binance-docs.github.io/apidocs/spot/en/#payload-hashing)
- [Bybit: Account Transaction](https://bybit-exchange.github.io/docs/v5/account/transaction)

### Code References
- `src/app/api/webhooks/exchange/route.ts` - Main handler with replay protection
- `src/lib/webhooks/crypto.ts` - Signature verification utilities
- `src/lib/webhooks/parsers.ts` - Payload parsing and standardization
- `scripts/send-mock-webhook.ts` - Testing utility with `--duplicate` flag

---

**Last Updated:** 2026-06-22
**Owner:** ApexOS Engineering Team
