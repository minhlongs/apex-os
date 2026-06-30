# Rate Limiting System

## Overview

ApexOS implements a comprehensive rate limiting system to protect API endpoints from abuse, click fraud, and DoS attacks. The system uses D1 database for persistent rate limit tracking and supports configurable limits per endpoint type and user tier.

## Features

- **Token bucket algorithm** with sliding window
- **Multi-tier limits**: Different limits by user role (admin, affiliate, shopper) and plan tier (premium, growth, starter, free)
- **Persistent storage**: D1 database ensures limits work across Cloudflare Workers instances
- **Automatic cleanup**: Expired entries cleaned up automatically
- **Standard headers**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`
- **Graceful 429 handling**: Frontend auto-retry with exponential backoff
- **User-friendly UI**: Rate limit alerts with countdown timers

## Database Schema

### rate_limits Table
```sql
CREATE TABLE rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,              -- Composite: endpoint_type|identifier
  endpoint_type TEXT NOT NULL,           -- e.g., 'click_tracking', 'auth', 'api_general'
  identifier TEXT NOT NULL,              -- IP, user ID, or composite key
  current_count INTEGER DEFAULT 0,       -- Requests in current window
  max_count INTEGER NOT NULL,            -- Effective limit (after multipliers)
  window_seconds INTEGER NOT NULL,       -- Time window in seconds
  reset_at TEXT NOT NULL,                -- When window resets (ISO 8601)
  created_at TEXT DEFAULT datetime('now'),
  updated_at TEXT DEFAULT datetime('now')
);
```

### rate_limit_configs Table
```sql
CREATE TABLE rate_limit_configs (
  endpoint_type TEXT UNIQUE NOT NULL,
  max_requests INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL,
  applies_to TEXT NOT NULL DEFAULT 'ip',  -- 'ip', 'user', 'api_key', 'combined'
  role_multiplier REAL DEFAULT 1.0,
  tier_multiplier REAL DEFAULT 1.0,
  description TEXT,
  is_active INTEGER DEFAULT 1
);
```

## Default Configurations

| Endpoint Type | Base Limit | Window | Applies To | Role Multipliers | Tier Multipliers |
|--------------|------------|--------|------------|------------------|------------------|
| `click_tracking` | 100 IP / 1000 user | 1 hour | IP + User | admin: 1.0, affiliate: 1.0, shopper: 1.0 | premium: 1.0, growth: 1.0 |
| `auth` | 10 IP / 20 user | 15 min | IP + User | admin: 1.0, affiliate: 1.0, shopper: 1.0 | premium: 1.0, growth: 1.0 |
| `api_general` | 500 IP / 2000 user | 1 hour | IP + User | admin: 2.0, affiliate: 1.2, shopper: 1.0 | premium: 2.5, growth: 1.5 |
| `webhook` | 1000 IP / 10000 user | 1 hour | IP + User | admin: 1.0, affiliate: 1.0, shopper: 1.0 | premium: 1.0, growth: 1.0 |
| `admin` | 100 IP / 500 user | 1 hour | IP + User | admin: 2.0 | premium: 2.5, growth: 1.5 |

### Role Multipliers
- `admin`: 2.0x (double limits)
- `master_trader`: 1.5x
- `affiliate`: 1.2x
- `shopper`: 1.0x (baseline)

### Tier Multipliers
- `premium`: 2.5x
- `growth`: 1.5x
- `starter`: 1.2x
- `free`: 1.0x (baseline)

## API Implementation

### Using the Rate Limiter Middleware

Wrap your API route handlers with `withRateLimit`:

```typescript
import { withRateLimit, extractIpAddress } from '@/lib/ratelimit/middleware';

export const GET = withRateLimit(async (request: NextRequest): Promise<Response> => {
  // Your handler logic
  return NextResponse.json({ data });
}, {
  endpointType: 'click_tracking',  // Required for config lookup
  getIdentifier: (request, userId) => ({
    ip: extractIpAddress(request.headers),
    userId
  }),
  getUserId: (request) => {
    // Extract user ID from session (synchronous)
    return userId;
  },
  getRole: (request) => {
    // Extract user role for tiered limits
    return user?.role;
  },
  getTier: (request) => {
    // Extract user plan tier
    return user?.plan;
  },
  onRateLimited: (result) => {
    // Custom 429 response for this endpoint
    return NextResponse.json({
      error: 'Too Many Requests',
      retryAfter: result.retryAfter
    }, { status: 429 });
  }
});
```

### Endpoint Types

| Type | Description | Protection Target |
|------|-------------|-------------------|
| `auth` | Login, signup, password reset | Brute force attacks |
| `click_tracking` | Deal click tracking | Click fraud |
| `api_general` | Standard API endpoints | General DoS protection |
| `webhook` | Incoming exchange webhooks | Webhook spam |
| `admin` | Admin-only endpoints | Admin panel protection |

## Frontend Integration

### Using the API Client

The `apiClient` automatically handles rate limits:

```typescript
import { apiClient, useApi } from '@/lib/api/hooks';

// Manual usage
const { data, error } = await apiClient.get('/api/deals', {
  withAuth: true,
  maxRetries: 2,
  onRateLimit: (retryAfter, info) => {
    toast.warning(`Rate limited. Retrying in ${retryAfter}s`);
  }
});

// Hook usage
const { data, error, loading, execute } = useApi('/api/deals', {
  withAuth: true,
  onRateLimit: (retryAfter) => {
    showToast(`Please wait ${retryAfter}s before retrying`);
  },
  onError: (error) => {
    if (error.status === 429) {
      // Show rate limit alert
    }
  }
});
```

### Rate Limit Status Display

```typescript
import { useRateLimitStatus, useRateLimitCountdown } from '@/lib/api/hooks';
import { RateLimitAlert, RateLimitProgress } from '@/components/rate-limit/RateLimitAlert';

function MyComponent() {
  const { isRateLimited, remaining, limit } = useRateLimitStatus();

  return (
    <div>
      <RateLimitProgress remaining={remaining} limit={limit} />

      {isRateLimited && (
        <RateLimitAlert
          retryAfter={60}
          onRetry={() => execute()}
        />
      )}
    </div>
  );
}
```

## Management Commands

```bash
# Initialize default rate limit configurations
pnpm run rate-limit:init

# Clean up expired rate limit entries
pnpm run rate-limit:cleanup

# Show rate limit statistics
pnpm run rate-limit:stats

# Reset a specific rate limit
pnpm run rate-limit:reset -- --endpoint=click_tracking --identifier=192.168.1.1
```

## Monitoring

### Useful Queries

```sql
-- Check active rate limits
SELECT * FROM v_active_rate_limits WHERE utilization_percent > 50;

-- See endpoint statistics
SELECT * FROM v_rate_limit_stats;

-- Find IPs approaching limits
SELECT key, current_count, max_count, reset_at
FROM rate_limits
WHERE reset_at > datetime('now')
  AND (current_count * 1.0 / max_count) > 0.8;
```

## Security Considerations

1. **IP Spoofing**: Use Cloudflare headers (`cf-connecting-ip`) which are set by the Cloudflare edge, not client-provided.
2. **Identifier Collision**: Use composite keys for `combined` applies_to to avoid conflicts.
3. **Database Indexes**: Indexes on `key`, `reset_at`, and `endpoint_type` ensure performance.
4. **Auto-cleanup**: Set up a cron job to periodically call `cleanupExpired()`.
5. **Bypass Protection**: Ensure the rate limiter runs before any expensive operations.

## Testing

Run the rate limit manager in development to test:

```bash
# Start dev server
wrangler dev

# In another terminal
pnpm run rate-limit:stats
```

## Migration

Apply the migration to create tables:

```bash
wrangler d1 execute apex-os-db --file src/database/migrations/006_rate_limiting_schema.sql
```

## Troubleshooting

### Rate limits not applying
- Check that `rate_limit_configs` has entries for your `endpointType`
- Verify DB binding is available in the route
- Check Cloudflare logs for errors

### High false positives
- Verify `extractIpAddress()` is getting the correct IP from Cloudflare headers
- Consider increasing limits for `applies_to: 'user'` if users are authenticated
- Check for proxy/VPN usage causing shared IPs

### Performance issues
- Ensure indexes exist on `rate_limits(key)`, `rate_limits(reset_at)`
- Consider shorter `window_seconds` to reduce row count
- Increase cleanup frequency

## Future Enhancements

- [ ] Redis/KV-based rate limiting for better performance
- [ ] Dynamic rate limit adjustment based on load
- [ ] Per-feature rate limits (e.g., per-deal click tracking)
- [ ] Rate limit escalation (warning → soft limit → hard limit)
- [ ] Admin dashboard for rate limit monitoring and adjustments
