# Security Audit Report — ApexOS

**Audit Date:** 2026-06-21  
**Auditor:** Claude Code Security Review  
**Scope:** HMAC verification, rate limiting, admin protection, and general security posture  
**Codebase:** /Users/macbook/apex-os (Next.js 16 + Cloudflare D1)

---

## Executive Summary

| Category | Status | Risk Level |
|----------|--------|------------|
| HMAC Implementation | ✅ Good | Low |
| Rate Limiting | ❌ Missing | **Critical** |
| Admin Protection | ⚠️ Partial | Medium |
| Authentication | ⚠️ Needs Review | Medium |
| Input Validation | ⚠️ Partial | Medium |
| SQL Injection | ✅ Safe | Low |
| Information Disclosure | ⚠️ Moderate | Low |
| Webhook Security | ⚠️ Moderate | Medium |

**Critical Issues:** 2  
**Medium Issues:** 4  
**Low Issues:** 3

---

## 1. HMAC Verification

### ✅ Strengths

1. **Proper Implementation** (`/src/lib/webhooks/crypto.ts`)
   - Uses Web Crypto API (`crypto.subtle`) for constant-time HMAC verification
   - Supports both Binance (body HMAC) and Bybit (timestamp+method+path+body)
   - Correct key import and verification pattern

2. **Signature Verification Flow** (`/src/app/api/webhooks/exchange/route.ts:454-616`)
   - All webhooks require valid HMAC signature before processing
   - Invalid signatures return 401 Unauthorized
   - Secrets loaded from environment variables
   - Idempotency check prevents duplicate processing

3. **Secure Key Handling**
   ```typescript
   const key = await subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
   const isValid = await subtle.verify('HMAC', key, signatureBuffer, payloadData);
   ```

### ⚠️ Concerns

1. **No Timestamp Validation for Binance**
   - Binance webhooks don't include replay attack protection
   - An attacker could capture and replay a valid webhook
   - **Recommendation:** Store processed `order_id` + `execution_time` to detect replays

2. **Bybit Timestamp Validation Present But Not Enforced**
   - Code checks for timestamp header but doesn't validate freshness
   - **Recommendation:** Reject webhooks older than 5 minutes

3. **Secret Configuration**
   - `.env.local.example` lists webhook secrets but they must be set in production
   - No warning if secrets are missing (silent failure: returns `configured: false` on GET)

### Recommendations

- [ ] Add replay protection: track processed order IDs with timestamps
- [ ] Implement timestamp window validation (reject >5 min old)
- [ ] Add webhook processing metrics/logging for anomaly detection
- [ ] Rotate webhook secrets periodically

---

## 2. Rate Limiting

### ❌ CRITICAL: No Rate Limiting Found

**All endpoints are unprotected against abuse:**

| Endpoint | Risk | Impact |
|----------|------|--------|
| `GET /api/tracking/click` | Click fraud, DoS | Unlimited clicks can spam database |
| `POST /api/auth/signin/email` | Brute force | No login attempt limiting |
| `POST /api/auth/signup/email` | Account creation spam | Unlimited fake accounts |
| `POST /api/webhooks/exchange` | DoS | No protection against flooding |
| `GET/POST /api/deals/*` | API abuse | Admin endpoints fully exposed |
| `GET /api/affiliate/*` | Data scraping | No limits on affiliate data access |

### Evidence

Search confirmed: **No rate limiting packages installed** (no `rate-limiter-flexible`, `express-rate-limit`, etc.)

```bash
$ grep -r "rate.?limit" src/  # No results
```

### Recommendations

**Priority 1 (Immediate):**

1. **Auth endpoints** - Prevent brute force:
   ```typescript
   // Add to auth routes
   - Rate limit: 5 attempts per 15 minutes per IP
   - Progressive delay after failures
   - Account lockout after 10 failed attempts
   ```

2. **Tracking click** - Prevent click fraud:
   ```typescript
   - Rate limit: 100 clicks per hour per IP/cookie
   - Per-deal rate limit: 1000 clicks/day
   - Burst protection: max 10 clicks/minute
   ```

3. **Webhook endpoint** - DoS protection:
   ```typescript
   - Rate limit: 100 requests/minute per source IP
   - Body size limit: 10KB (already implicitly limited by parsing)
   ```

4. **Admin API** - Prevent API abuse:
   ```typescript
   - Rate limit: 1000 requests/hour per admin user
   - Stricter limits for write operations (POST/PATCH/DELETE)
   ```

**Implementation Options:**

- Use Cloudflare Workers rate limiting (if deployed there)
- Add `upstash/ratelimit` for serverless (compatible with D1)
- Implement token bucket in Redis/Upstash

---

## 3. Admin Protection

### ⚠️ Partial Protection — Inconsistent Enforcement

#### ✅ Properly Protected

1. **Admin Server Actions** (`/src/app/[locale]/admin/deals/actions.ts:18-57`)
   ```typescript
   export async function requireAdmin(): Promise<{ userId: string; role: string } | null> {
     const sessionResult = await auth.api.getSession({...});
     if (!sessionResult?.user) return null;
     const profile = await getDB().prepare('SELECT role FROM profiles WHERE id = ?')
       .bind(userId).first<{ role: string }>();
     if (!profile || profile.role !== 'admin') return null;
     return { userId, role: profile.role };
   }
   ```
   - All admin CRUD operations check `requireAdmin()`
   - Returns 401/403 appropriately

2. **Admin Page Route** (`/src/app/[locale]/admin/deals/page.tsx:39-42`)
   ```typescript
   const admin = await requireAdmin()
   if (!admin) {
     redirect(`/${locale}/login?redirect=/${locale}/admin/deals`)
   }
   ```

3. **Admin-only POST** (`/src/app/api/deals/route.ts:166-168`)
   ```typescript
   if (!admin) {
     return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
   }
   ```

#### ⚠️ Issues

1. **Inconsistent Access Model for Deal Endpoints**
   - `GET /api/deals` (list): Non-admin can see active deals ✅
   - `POST /api/deals` (create): Admin only ✅
   - `GET /api/deals/[id]` (read): **Creator OR admin** ⚠️
   - `PATCH /api/deals/[id]` (update): **Creator OR admin** ⚠️
   - `DELETE /api/deals/[id]` (delete): **Creator OR admin** ⚠️

   **Concern:** Allowing creators to modify their own deals bypasses admin oversight. A compromised non-admin account could:
   - Modify deal URLs to redirect to malicious sites
   - Increase commission rates arbitrarily
   - Deactivate legitimate deals

   **Recommendation:**
   - Either require admin for all write operations
   - Or implement a separate "deal manager" role between affiliate and admin

2. **No Centralized Authorization Middleware**
   - Each endpoint reimplements `requireAdmin()` or `isAdmin()`
   - Easy to forget protection on new endpoints
   - **Recommendation:** Create middleware wrapper:
     ```typescript
     // lib/auth/guards.ts
     export function withAuth(handler: Handler) {
       return async (req: Request) => {
         const session = await auth.api.getSession(...);
         if (!session?.user) return json({ error: 'Unauthorized' }, { status: 401 });
         return handler(req, session.user);
       };
     }
     export function withAdmin(handler: Handler) {
       return withAuth(async (req, user) => {
         const isAdmin = await checkAdmin(user.id);
         if (!isAdmin) return json({ error: 'Forbidden' }, { status: 403 });
         return handler(req, user);
       });
     }
     ```

3. **Role Enum in Database vs Code**
   - DB: `CHECK (role IN ('shopper', 'affiliate', 'admin', 'master_trader'))`
   - Code: Only checks for `'admin'`
   - **Concern:** `master_trader` role exists but has no defined privileges
   - **Recommendation:** Document all roles or remove unused ones

### Recommendations

- [ ] Create centralized auth guards middleware
- [ ] Review creator-modify-own policy (likely should be admin-only)
- [ ] Add role hierarchy documentation
- [ ] Audit all API routes for consistent protection
- [ ] Consider implementing RBAC system for granular permissions

---

## 4. Authentication Security

### ⚠️ Mixed Configuration

#### ✅ Good Practices

1. **Better Auth Integration**
   - Uses Better Auth library (battle-tested)
   - Custom D1 adapter well-implemented (`/src/lib/auth/adapters/d1-adapter.ts`)
   - Sessions stored in database with expiration
   - Password hashing handled by Better Auth

2. **Session Management**
   ```typescript
   session: {
     expiresIn: 60 * 60 * 24 * 7,  // 7 days
     updateAge: 60 * 60 * 24,       // Refresh after 1 day
   }
   ```

#### ❌ Critical Issues

1. **Development Secret in Production Code**
   ```typescript
   // /src/lib/auth/auth-factory.ts:24
   secret: process.env.BETTER_AUTH_SECRET || 'dev-secret-change-in-production',
   ```
   - **CRITICAL:** If `BETTER_AUTH_SECRET` is not set, falls back to hardcoded dev secret
   - **Impact:** Session tokens can be forged in production if env var missing
   - **Fix:** Remove fallback, fail on missing secret:
     ```typescript
     const secret = process.env.BETTER_AUTH_SECRET;
     if (!secret && process.env.NODE_ENV !== 'development') {
       throw new Error('BETTER_AUTH_SECRET must be set in production');
     }
     ```

2. **No Multi-Factor Authentication**
   - Password-only authentication
   - No OTP, WebAuthn, or OAuth providers configured
   - **Risk:** Single factor of failure

3. **No Password Strength Enforcement**
   - Zod validation exists but no complexity requirements visible
   - **Recommendation:** Enforce min 8 chars, mixed case, numbers

4. **Session Cookie Configuration**
   - `httpOnly: true` ✅
   - `secure: process.env.NODE_ENV !== 'development'` ✅
   - Missing: `sameSite` attribute (should be `'lax'` or `'strict'`)
   - Missing: explicit `maxAge` on session cookies

5. **Password Reset Flow**
   - Uses standard Better Auth forgot-password
   - No evidence of rate limiting on reset endpoint
   - **Recommendation:** Add IP-based rate limiting and captcha

#### ⚠️ Observations

1. **No OAuth Providers**
   - `emailAndPassword: { enabled: true }` only
   - No social login options
   - Could be intentional but reduces user convenience

2. **Email Verification**
   - `emailVerified` field exists but not enforced for login
   - **Recommendation:** Block login until email verified for sensitive operations

### Recommendations

- [ ] **CRITICAL:** Remove dev secret fallback, require env var
- [ ] Add `sameSite: 'lax'` to session cookies
- [ ] Implement password strength requirements (min 8 chars, complexity)
- [ ] Add rate limiting to all auth endpoints
- [ ] Consider OAuth providers (Google, GitHub) for better UX
- [ ] Add optional MFA for admin accounts
- [ ] Implement email verification requirement toggle

---

## 5. Input Validation

### ⚠️ Basic Validation Only

#### ✅ Safe Patterns

1. **SQL Injection Prevention**
   - All database queries use parameterized `bind()`:
   ```typescript
   db.prepare('SELECT * FROM profiles WHERE id = ?').bind(userId).first()
   ```
   - ✅ Safe from SQL injection

2. **TypeScript Types**
   - Strong typing on API inputs
   - Zod schemas used for DTOs (`CreateDealDto`, `UpdateDealDto`)

#### ⚠️ Gaps

1. **Webhook Payload Validation**
   - Parsers (`/src/lib/webhooks/parsers.ts`) do minimal validation:
   ```typescript
   if (!symbol || !side || !quantity || !price) { return null; }
   ```
   - No schema validation (Zod/JSON Schema) on webhook payloads
   - Malformed payloads could cause unexpected behavior
   - **Recommendation:** Add Zod schemas for Binance/Bybit payloads

2. **API Input Sanitization**
   - `search` parameter uses `LIKE %...%` without escaping `%` or `_`
   - Could cause false matches but not exploitable
   - **Recommendation:** Escape user-provided wildcards

3. **Email Handling**
   - Emails stored and compared case-sensitively in some places
   - Should normalize to lowercase:
   ```sql
   INSERT INTO profiles (email) VALUES (LOWER(?))
   ```

4. **URL Field Validation**
   - `deals.url` accepts any string, no URL validation
   - Could store `javascript:` or malicious URLs
   - **Recommendation:** Validate URLs with `new URL()` and allow only http/https

5. **JSON.parse on User Input**
   - `body.metadata ? JSON.stringify(body.metadata) : '{}'`
   - Assumes `body.metadata` is already parsed JSON object
   - If client sends string, could fail
   - **Recommendation:** Use `safeParse` with Zod

### Recommendations

- [ ] Add Zod schemas for all webhook payloads
- [ ] Validate deal URLs are valid http/https URLs
- [ ] Escape SQL LIKE wildcards in search queries
- [ ] Normalize emails to lowercase on signup
- [ ] Add input validation middleware

---

## 6. Information Disclosure

### ⚠️ Excessive Error Details

**Issue:** Error responses include stack traces in development:

```typescript
// Multiple endpoints
return NextResponse.json(
  { error: 'Internal server error', details: String(error) },
  { status: 500 }
);
```

**Risk:**
- Stack traces reveal file paths, library versions, internal logic
- Should only happen in development

**Fix:** Add error masking in production:
```typescript
const isDev = process.env.NODE_ENV !== 'production';
return NextResponse.json({
  error: 'Internal server error',
  ...(isDev && { details: String(error) })  // Only in dev
}, { status: 500 });
```

### ⚠️ Database Schema Exposure

- Public deals API returns all columns from `deals` table
- Includes `created_by`, `metadata`, internal fields
- **Recommendation:** Use explicit column selection instead of `SELECT *`

### ⚠️ Logging Sensitive Data

Webhook endpoint logs trade details:
```typescript
console.log(`[Webhook] ${exchange} trade processed:`, {
  conversionId,
  orderId: trade.orderId,
  symbol: trade.symbol,
  amount: trade.totalValue,  // Financial data in logs
  earningsCount: earningsIds.length,
  durationMs: duration,
});
```

**Recommendation:** Redact sensitive fields or use structured logging with levels

---

## 7. Webhook Security

### ⚠️ Good But Could Be Stronger

#### ✅ Strengths

1. **HMAC Verification** (covered above)
2. **Idempotency** - Checks for duplicate order_id + deal_id
3. **Exchange Detection** - Auto-detects Binance vs Bybit

#### ⚠️ Concerns

1. **IP Whitelisting Missing**
   - Webhooks accept requests from any IP
   - Exchanges have known webhook IP ranges
   - **Recommendation:** Add IP allowlist for Binance/Bybit

2. **No Request Size Limit**
   - Next.js has default limits but not explicitly configured
   - **Recommendation:** Set `bodySize: '10kb'` in route config

3. **Blind User Matching**
   ```typescript
   // Matches by wallet address or email from trade data
   const identifier = trade.walletAddress || trade.email || trade.userId;
   const profile = identifier ? await findProfileByIdentifier(db, identifier) : null;
   ```
   - If attacker can control webhook (compromised exchange account), they could:
     - Match to any user by guessing email/wallet
     - Generate fake conversions
   - **Mitigation:** HMAC already protects against unauthorized webhooks
   - **Additional:** Require pre-linked exchange accounts (not implicit matching)

4. **No Webhook Retry Handling**
   - Returns 200 even when `skipped: true` (no matching deal/user)
   - Exchanges may retry indefinitely on non-2xx
   - Current behavior is correct for idempotency
   - **But:** Should track retry count to detect broken integrations

---

## 8. Additional Security Findings

### Database Security

✅ **All queries use parameterized binding** - No SQL injection risk  
✅ **Foreign key constraints enabled** (`PRAGMA foreign_keys = ON`)  
✅ **Indexes on foreign keys** for performance  
⚠️ **No row-level security** - Application enforces access, not DB  
⚠️ **Soft deletes only** - Good for audit trail but data still accessible

### Session Security

✅ **Sessions stored server-side** (D1)  
✅ **Token rotation** via `updateAge`  
⚠️ **No session revocation UI** - Users cannot logout other sessions  
⚠️ **No concurrent session limit** - User could have unlimited active sessions

### File Upload/Media

✅ **No file upload functionality found** - No related vulnerabilities

### Third-Party Dependencies

```json
"better-auth": "0.8.7-beta.5"  // Beta version - monitor for security updates
"stellar-sdk": "^12.3.0"       // Keep updated
"resend": "^6.14.0"            // Keep updated
```

**Recommendation:** Enable Dependabot or similar for automated updates

---

## 9. Security Headers & HTTPS

### ❌ Missing Security Headers

Next.js defaults provide some but not all:

| Header | Status | Recommendation |
|--------|--------|----------------|
| X-Frame-Options | ❌ Missing | Set `DENY` or `SAMEORIGIN` |
| X-Content-Type-Options | ⚠️ Next.js default | Verify `nosniff` is set |
| Strict-Transport-Security | ❌ Missing | Add `max-age=31536000; includeSubDomains` |
| Content-Security-Policy | ❌ Missing | Define strict CSP, especially for admin pages |
| Permissions-Policy | ❌ Missing | Restrict camera/mic/geolocation |
| Referrer-Policy | ❌ Missing | Set `strict-origin-when-cross-origin` |

**Implementation (Next.js):**
```typescript
// middleware.ts (new file)
import { NextResponse } from 'next/server';

export function middleware(request: Request) {
  const response = NextResponse.next();
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return response;
}
export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
```

---

## 10. Environment & Secrets

### ⚠️ Configuration Issues

1. **`.env.local.example` Exposes Secret Names**
   - Example file is fine for documentation
   - Ensure `.env.local` is in `.gitignore` (verify)

2. **Missing Required Env Vars Not Validated**
   - No startup check for required env vars
   - App could run with missing secrets and fail at runtime
   - **Recommendation:** Add env validation at boot:
   ```typescript
   // lib/validate-env.ts
   const required = ['BETTER_AUTH_SECRET', 'D1_DATABASE', ...];
   for (const key of required) {
     if (!process.env[key]) throw new Error(`Missing ${key}`);
   }
   ```

3. **Secret in Code**
   - Already noted: dev secret fallback in `auth-factory.ts`

---

## 11. Cloudflare Workers Specific

### ✅ Good Practices

- Uses D1 database with parameterized queries
- `globalThis.DB` pattern for D1 binding access
- Compatible with Cloudflare's edge runtime

### ⚠️ Concerns

1. **No KV Store Usage** - Could use KV for rate limiting
2. **No R2 Bucket** - No file storage concerns
3. **Edge Runtime Limits** - 10ms CPU time, 128MB memory - webhook processing could exceed

---

## Risk Matrix

| Finding | Severity | Likelihood | Impact | Priority |
|---------|----------|------------|--------|----------|
| No rate limiting on auth/tracking | **Critical** | High | Account takeover, fraud | P0 |
| Dev secret fallback in auth | **Critical** | Medium | Complete auth bypass | P0 |
| Admin write access for creators | High | Medium | Data integrity | P1 |
| No IP whitelist on webhooks | High | Low | Webhook abuse if secret leaked | P2 |
| Missing security headers | Medium | High | XSS, clickjacking | P2 |
| Exposed error details | Medium | Medium | Information disclosure | P2 |
| No replay protection on webhooks | Medium | Low | Duplicate processing | P3 |
| Unvalidated webhook payloads | Medium | Low | Unexpected behavior | P3 |
| No email normalization | Low | Medium | Account duplication | P4 |
| No concurrent session limit | Low | Low | Session sprawl | P4 |

---

## Remediation Plan

### Immediate (P0 - This Week)

1. **Remove dev secret fallback**
   - File: `/src/lib/auth/auth-factory.ts:24`
   - Change: `secret: process.env.BETTER_AUTH_SECRET` (no fallback)
   - Add startup validation for required env vars

2. **Add basic rate limiting**
   - Install: `npm install upstash/ratelimit`
   - Protect: `/api/auth/*` (5/15min), `/api/tracking/click` (100/hour)
   - Use Upstash Redis or in-memory for dev

### Short-term (P1 - Next 2 Weeks)

3. **Fix admin protection**
   - Review if creators should modify deals
   - Create centralized auth guards
   - Document role hierarchy

4. **Add security headers**
   - Create `middleware.ts` with CSP, HSTS, X-Frame-Options

5. **Webhook improvements**
   - Add timestamp validation (<5min window)
   - Track processed order IDs for replay protection

### Medium-term (P2 - Next Month)

6. **Input validation**
   - Add Zod schemas for webhook payloads
   - Validate deal URLs
   - Escape search wildcards

7. **Error handling**
   - Mask errors in production
   - Use structured logging

8. **Monitoring**
   - Add audit logs for admin actions
   - Track failed auth attempts
   - Alert on webhook signature failures

### Long-term (P3+)

9. **MFA support** for admin accounts
10. **OAuth providers** (Google, GitHub)
11. **Rate limiting dashboard** for admin
12. **Penetration testing** after major fixes
13. **Security policy** and bug bounty program

---

## Compliance Considerations

| Standard | Status | Gaps |
|----------|--------|------|
| GDPR | ⚠️ Partial | No consent management, data export/delete not implemented |
| PCI DSS | N/A | No card data storage (using Stellar USDC) |
| SOC2 | ❌ Not ready | Need audit logs, access controls, encryption at rest |

**Note:** This is a financial affiliate platform handling commissions. Consider:
- KYC/AML for payouts above threshold
- Transaction monitoring for suspicious patterns
- Data retention policies

---

## Testing Gaps

**Current Coverage:** Minimal auth tests only (`auth-context.test.tsx`)

**Missing Tests:**
- ❌ Rate limiting behavior
- ❌ Admin authorization edge cases
- ❌ HMAC verification with various payloads
- ❌ Replay attack prevention
- ❌ Input validation boundaries
- ❌ Security header presence

**Recommendation:** Add security-focused test suite in `__tests__/security/`

---

## Conclusion

ApexOS has a **solid foundation** with parameterized queries preventing SQL injection and proper HMAC verification for webhooks. However, **critical gaps** in rate limiting and authentication configuration create significant risk for a financial platform.

**Priority Actions:**
1. Fix auth secret fallback (5 minutes)
2. Add rate limiting (2-3 days)
3. Review admin/creator access model (1 day)
4. Add security headers (1 day)

**Overall Risk Rating: HIGH** (due to lack of rate limiting and auth misconfiguration)

---

## Appendix: Files Reviewed

### Security-Critical
- `/src/lib/webhooks/crypto.ts` — HMAC implementation
- `/src/app/api/webhooks/exchange/route.ts` — Webhook handler
- `/src/lib/auth/auth-factory.ts` — Auth configuration
- `/src/contexts/auth-context.tsx` — Client auth
- `/src/app/api/auth/[...all]/route.ts` — Auth API routes
- `/src/lib/auth/adapters/d1-adapter.ts` — Database adapter

### Admin Protection
- `/src/app/[locale]/admin/deals/page.tsx` — Admin page
- `/src/app/[locale]/admin/deals/actions.ts` — Admin server actions
- `/src/app/api/deals/route.ts` — Deals API
- `/src/app/api/deals/[id]/route.ts` — Deal detail API

### Other Endpoints
- `/src/app/api/tracking/click/route.ts` — Click tracking (no rate limit)
- `/src/app/api/affiliate/dashboard/route.ts` — Affiliate data
- `/src/app/api/affiliate/payouts/route.ts` — Payout history
- `/src/app/api/affiliate/conversions/route.ts` — Conversion history
- `/src/app/api/public/deals/route.ts` — Public deals

### Configuration
- `/package.json` — Dependencies
- `/next.config.js` — Next.js config
- `/.env.local.example` — Environment template
- `/src/database/migrations/003_affiliate_schema.sql` — DB schema

---

**Audit completed:** 2026-06-21  
**Next review:** After P0/P1 remediations implemented
