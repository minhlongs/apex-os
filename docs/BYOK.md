# BYOK (Bring Your Own Key) — Hệ thống Quản lý API Keys Theo User

## Tổng quan

BYOK cho phép mỗi user (affiliate) tự quản lý API keys của họ (Binance, Bybit, Resend) thay vì dùng chung global secrets. Keys được mã hóa AES-GCM-256 và lưu trữ trong D1 database.

**Pattern reference:** sophia-ai-factory `src/tree/byok/`

## Kiến trúc

```
┌─────────────────────────────────────────────────────────────┐
│  User đăng ký API key → encrypt với BYOK_MASTER_KEY       │
│  → store trong D1: user_api_keys (user_id, provider, key) │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  resolveApiKey(userId, provider) →                         │
│  1. Check BYOK_ENABLED flag                                │
│  2. Lookup encrypted key trong D1                          │
│  3. Decrypt với BYOK_MASTER_KEY                            │
│  4. Return key || fallbackToGlobal(provider)               │
└─────────────────────────────────────────────────────────────┘
```

## Environment Variables

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `BYOK_MASTER_KEY` | 64-char hex string (32 bytes) dùng để encrypt/decrypt user keys | Production | `openssl rand -hex 32` |
| `BYOK_ENABLED` | Toggle BYOK resolution (`true`/`false`) | No (default: false) | `false` |
| `BINANCE_WEBHOOK_SECRET` | Global fallback secret | Yes | `...` |
| `BYBIT_WEBHOOK_SECRET` | Global fallback secret | Yes | `...` |
| `RESEND_API_KEY` | Global fallback secret | Yes | `re_...` |

**Generate BYOK_MASTER_KEY:**
```bash
openssl rand -hex 32
# Output: 64-character hex string
```

**Lưu ý:** `BYOK_MASTER_KEY` phải được lưu trong Cloudflare Secrets (không commit vào .env).

## Database Schema

Migration: `017_user_api_keys.sql`

```sql
CREATE TABLE user_api_keys (
  user_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,  -- 'binance' | 'bybit' | 'resend'
  encrypted_key BLOB NOT NULL,   -- [IV(12)][ciphertext+authTag]
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);

CREATE INDEX idx_user_api_keys_user ON user_api_keys(user_id);

CREATE TRIGGER trg_user_api_keys_updated
  AFTER UPDATE ON user_api_keys
  FOR EACH ROW BEGIN
    UPDATE user_api_keys SET updated_at = datetime('now') WHERE id = old.id;
  END;
```

## API

### `setUserApiKey(userId, provider, plainKey)`

Lưu API key của user, tự động encrypt.

```typescript
import { setUserApiKey } from '@/lib/byok';

await setUserApiKey('user_123', 'binance', 'my-secret-key');
// → Encrypt và INSERT OR REPLACE vào DB
```

### `getUserApiKey(userId, provider)`

Lấy API key đã decrypt.

```typescript
import { getUserApiKey } from '@/lib/byok';

const key = await getUserApiKey('user_123', 'binance');
// → Returns: string | null
```

### `deleteUserApiKey(userId, provider?)`

Xóa một hoặc tất cả keys của user.

```typescript
await deleteUserApiKey('user_123', 'binance'); // xóa một provider
await deleteUserApiKey('user_123');             // xóa tất cả
```

### `listUserApiKeys(userId)`

Liệt kê metadata của tất cả keys (không bao gồm encrypted value).

```typescript
import { listUserApiKeys } from '@/lib/byok';

const keys = await listUserApiKeys('user_123');
// → [{ provider: 'binance', created_at: '...', updated_at: '...' }]
```

### `resolveApiKey(userId, provider, options?)`

**Core resolution function.** Tìm user key, fallback global nếu cần.

```typescript
import { resolveApiKey } from '@/lib/byok';

// Use user key if exists, else fallback to global secret
const key = await resolveApiKey('user_123', 'binance', {
  fallbackToGlobal: true,  // default
  requireUserKey: false    // default
});

// Strict: throw nếu không có user key
const strictKey = await resolveApiKey('user_123', 'binance', {
  fallbackToGlobal: false,
  requireUserKey: true
});
```

**Behavior:**

| BYOK_ENABLED | userId | user key exists | fallbackToGlobal | Kết quả |
|--------------|--------|-----------------|------------------|---------|
| false | any | any | any | Global secret |
| true | null/undefined | - | true | Global secret |
| true | null/undefined | - | false | Throw Error |
| true | có | có | any | User key |
| true | có | không | true | Global secret |
| true | có | không | false | Throw Error |

## Integration Points

### Webhook Handler

File: `src/app/api/webhooks/exchange/route.ts`

**Before (global):**
```typescript
const EXCHANGE_SECRETS: Record<Exchange, string> = {
  binance: process.env.BINANCE_WEBHOOK_SECRET,
  bybit: process.env.BYBIT_WEBHOOK_SECRET,
};
const secret = EXCHANGE_SECRETS[exchange];
```

**After (BYOK):**
```typescript
import { resolveApiKey, ByokProvider } from '@/lib/byok';

// Trước khi verify signature
const identifier = trade.walletAddress || trade.email || trade.userId;
const profile = identifier ? await findProfileByIdentifier(db, identifier) : null;
const userId = profile?.id || null;

const secret = await resolveApiKey(userId, exchange as ByokProvider, {
  fallbackToGlobal: true
});

// Dùng secret để verify
const verification = await verifyWebhookSignature(exchange, rawBody, headers, secret);
```

### Email Notifier

File: `src/lib/emails/notifier.ts`

**Before:**
```typescript
const apiKey = process.env.RESEND_API_KEY;
```

**After:**
```typescript
import { resolveApiKey } from '@/lib/byok';

async send(options: { to: string; userId?: string }) {
  const apiKey = await resolveApiKey(options.userId || null, 'resend', {
    fallbackToGlobal: true
  });
  // ... send với apiKey
}
```

## Admin UI

Route: `/admin/settings/api-keys`

**Chức năng:**
- Xem danh sách API keys đã lưu (provider, created_at, updated_at)
- Thêm key mới (form: provider dropdown + password input)
- Xóa key
- Hiển thị trạng thái: "Using global fallback" nếu user chưa có key

**Server Actions:** `src/app/[locale]/admin/settings/api-keys/actions.ts`

```typescript
'use server'

import { setUserApiKey, deleteUserApiKey, listUserApiKeys } from '@/lib/byok';
import { getServerSession } from '@/lib/auth/auth-factory';

export async function addApiKey(formData: FormData) {
  const session = await getServerSession();
  if (!session?.user?.id || session.user.role !== 'admin') {
    throw new Error('Unauthorized');
  }
  const provider = formData.get('provider') as ByokProvider;
  const apiKey = formData.get('apiKey') as string;
  await setUserApiKey(session.user.id, provider, apiKey);
}

export async function deleteApiKey(provider: ByokProvider) {
  const session = await getServerSession();
  if (!session?.user?.id) throw new Error('Unauthorized');
  await deleteUserApiKey(session.user.id, provider);
}
```

## Migration: Global → Per-User

Script: `scripts/migrate-global-secrets-to-byok.ts`

Chuyển global secrets sang admin user's BYOK keys.

```bash
# Dry-run (không thực sự insert)
tsx scripts/migrate-global-secrets-to-byok.ts --env staging --dry-run

# Thực thi
tsx scripts/migrate-global-secrets-to-byok.ts --env staging
tsx scripts/migrate-global-secrets-to-byok.ts --env production
```

**Logic:**
1. Load global secrets từ `.env.{env}` hoặc Cloudflare Secrets
2. Tìm admin user (`SELECT id FROM profiles WHERE role = 'admin' LIMIT 1`)
3. Insert admin's keys với encrypted global secrets
4. Log kết quả

## Testing

### Unit Tests

```typescript
// crypto.test.ts
import { encryptApiKey, decryptApiKey } from '@/lib/byok/crypto';

test('encrypt/decrypt round-trip', async () => {
  const plain = 'test-api-key-123';
  const encrypted = await encryptApiKey(plain);
  const decrypted = await decryptApiKey(encrypted);
  expect(decrypted).toBe(plain);
});
```

```typescript
// resolve-api-key.test.ts
import { resolveApiKey } from '@/lib/byok';
import { setUserApiKey } from '@/lib/byok/user-api-key-store';

// Mock DB và crypto
beforeEach(async () => {
  await setUserApiKey('user_123', 'binance', 'user-specific-key');
});

test('resolves user key when exists', async () => {
  const key = await resolveApiKey('user_123', 'binance', {
    fallbackToGlobal: false,
    requireUserKey: true
  });
  expect(key).toBe('user-specific-key');
});

test('falls back to global when user key missing', async () => {
  process.env.BINANCE_WEBHOOK_SECRET = 'global-secret';
  const key = await resolveApiKey('user_456', 'binance', {
    fallbackToGlobal: true
  });
  expect(key).toBe('global-secret');
});
```

### Integration Tests

```typescript
// byok-webhook.test.ts
import { setupServer } from 'msw/node';
import { rest } from 'msw';

// Mock webhook payload với user wallet address
const webhookPayload = {
  walletAddress: '0x123...',
  // ... other fields
};

const response = await request(app).post('/api/webhooks/exchange').send(webhookPayload);
expect(response.status).toBe(200);
```

## Monitoring & Alerting

### Metrics

| Metric | Labels | Description |
|--------|--------|-------------|
| `byok_resolution_total` | `source=user\|global\|fallback`, `provider` | Counter của resolution successes |
| `byok_decryption_errors_total` | `reason` | Decryption failures (corrupt key, wrong master key) |
| `byok_missing_key_total` | `provider` | User key not found (expected when fallback) |
| `byok_latency_seconds` | `source`, `provider` | Resolution latency histogram |

### Alert Rules

```sql
-- High decryption error rate
alert byok_decryption_error_rate > 0.05 {
  for: 5m
  annotations {
    summary: "BYOK decryption error rate high"
    description: "{{ $value }}% of BYOK resolutions failed to decrypt"
  }
}

-- Many users missing keys (potential onboarding issue)
alert byok_missing_key_rate_high {
  when sum(byok_missing_key_total[5m]) > 100
  annotations {
    summary: "Many users missing BYOK keys"
    description: "Consider email campaign to educate users"
  }
}
```

## Troubleshooting

### "BYOK_MASTER_KEY not set"
- **Fix:** Set `BYOK_MASTER_KEY` trong Cloudflare Secrets: `wrangler secret put BYOK_MASTER_KEY`

### "Giải mã thất bại" / Decryption fails
- **Possible causes:**
  1. BYOK_MASTER_KEY thay đổi (keys cần migrate)
  2. Encrypted data corrupt
- **Fix:**
  1. Verify `BYOK_MASTER_KEY` không đổi
  2. Nếu master key rotate cần thiết, dùng dual-key approach (old + new)
  3. User cần re-add key

### Webhook signature verification fails với user key
- **Check:** User key có khớp với what Binance/Bybit expects không
- **Debug:** Log secret used (masked) và compare với exchange config
- **Rollback:** Tắt BYOK (`BYOK_ENABLED=false`) để dùng global fallback

### Performance: Latency cao
- **Expectation:** AES-GCM decrypt ~1-2ms
- **Check:** Database query latency (`user_api_keys` index)
- **Optimization:** Cache resolved keys trong KV (TTL 5m)

## Security Considerations

1. **BYOK_MASTER_KEY rotation** — Cần procedure để rotate master key mà không mất data:
   - Add new key: `BYOK_MASTER_KEY_V2`
   - Dual-decrypt: try v1, nếu fail try v2
   - Re-encrypt tất cả keys với v2 (background job)
   - Remove v1 sau khi complete

2. **Audit logging** — Log ai đã thêm/sửa/xóa keys:
   ```typescript
   await auditLog({
     userId: session.user.id,
     action: 'api_key.add',
     provider,
     ip: request.ip
   });
   ```

3. **Rate limiting** — Giới hạn add/delete key operations (10/phút/user)

4. **Key leakage prevention** — Không bao giờ log plaintext keys, chỉ log metadata

5. **Least privilege** — Admin role only truy cập `/admin/settings/api-keys`

## Rollback Plan

Nếu BYOK gây vấn đề production:

```bash
# 1. Tắt BYOK flag
wrangler secret put BYOK_ENABLED --false

# 2. Verification: webhook sẽ dùng global secrets
curl https://your-app.pages.dev/api/webhooks/exchange | jq .exchanges

# 3. Nếu cần xóa user keys (không recommended, giữ để audit):
wrangler d1 execute apex-os-db --command "
  DELETE FROM user_api_keys;
"
```

**Note:** Xóa user keys không ảnh hưởng đến global fallback. Có thể re-enable BYOK bất kỳ lúc nào.

## Future Enhancements

- [ ] User-facing API key management page (dashboard)
- [ ] Key rotation (expiry dates, auto-remind)
- [ ] Usage tracking per key (last used, rate limits)
- [ ] Per-key permissions (read-only vs full access)
- [ ] Key sharing across user's devices
- [ ] Backup codes (one-time use)
- [ ] Webhook signature algorithm selection (HMAC-SHA256, SHA512)

## References

- **sophia-ai-factory:** `apps/sophia-ai-factory/src/tree/byok/`
- **Migration:** `017_user_api_keys.sql`
- **Modules:** `src/lib/byok/{crypto,user-api-key-store,resolve-api-key}.ts`
- **Integration:** `src/app/api/webhooks/exchange/route.ts`
- **Env:** `.env.staging.example`, `.env.production.example`
