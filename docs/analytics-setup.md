# Analytics Setup Guide

## Tổng quan

ApexOS sử dụng dịch vụ analytics đa nền tảng, hỗ trợ cả **Mixpanel** và **Amplitude**. Bạn có thể cấu hình một hoặc cả hai providers đồng thời.

## Cấu hình Environment Variables

Thêm các biến môi trường vào `.env.local`:

### Mixpanel

```bash
# Mixpanel project token (required để sử dụng Mixpanel)
NEXT_PUBLIC_MIXPANEL_TOKEN=your_mixpanel_token_here

# Optional: Mixpanel API server (mặc định: api.mixpanel.com)
NEXT_PUBLIC_MIXPANEL_API_SERVER=https://api.mixpanel.com
```

### Amplitude

```bash
# Amplitude API key (required để sử dụng Amplitude)
NEXT_PUBLIC_AMPLITUDE_API_KEY=your_amplitude_api_key_here

# Optional: Amplitude endpoint (mặc định: https://api2.amplitude.com)
NEXT_PUBLIC_AMPLITUDE_ENDPOINT=https://api2.amplitude.com
```

### Global Settings

```bash
# Bật/tắt analytics toàn cục (mặc định: true)
NEXT_PUBLIC_ANALYTICS_ENABLED=true

# Log events trong console (chỉ development)
NODE_ENV=development
```

## Installation

```bash
pnpm add mixpanel-browser @amplitude/analytics-browser
```

## Cách sử dụng

### Import và sử dụng track()

```typescript
import { track, identify, analytics, AnalyticsEvents } from '@/lib/analytics';

// Track event với properties
track('custom_event', {
  userId: 'user_123',
  property1: 'value1',
  property2: 100,
});

// Hoặc dùng pre-defined events
track(AnalyticsEvents.SIGNUP, {
  userId: 'user_123',
  email: 'user@example.com',
  walletAddress: '0x...',
});

// Identify user
identify('user_123', {
  email: 'user@example.com',
  walletAddress: '0x...',
  affiliateCode: 'ABC123',
});

// Reset (logout)
resetAnalytics();
```

### Pre-defined Events

#### 1. `signup`

User đăng ký tài khoản mới.

```typescript
import { track, AnalyticsEvents } from '@/lib/analytics';

track(AnalyticsEvents.SIGNUP, {
  userId: 'user_123',
  email: 'user@example.com',
  walletAddress: '0x...',
  affiliateCode: 'ABC123', // nếu có referral
});
```

#### 2. `deal_click`

User click vào affiliate deal link.

```typescript
track(AnalyticsEvents.DEAL_CLICK, {
  userId: 'user_123',
  dealId: 'deal_456',
  dealName: 'Binance 20% fee discount',
  exchange: 'binance',
  referrer: 'affiliate_789', // optional
});
```

#### 3. `conversion`

Trade được xác nhận (commission được tính).

```typescript
track(AnalyticsEvents.CONVERSION, {
  userId: 'user_123',
  conversionId: 'conv_001',
  dealId: 'deal_456',
  exchange: 'binance',
  volume: 1000, // USD
  commission: 30, // USDC
  currency: 'USDC',
});
```

#### 4. `payout`

Payout được gửi đến user.

```typescript
track(AnalyticsEvents.PAYOUT, {
  userId: 'user_123',
  payoutId: 'payout_001',
  payoutAmount: 150,
  currency: 'USDC',
  walletAddress: '0x...',
});
```

## Integration với Auth

Trong `src/contexts/auth-context.tsx` hoặc `src/lib/auth/auth-factory.ts`:

```typescript
import { identify } from '@/lib/analytics';

// Khi user đăng nhập
const handleSignIn = async (user) => {
  identify(user.id, {
    email: user.email,
    walletAddress: user.walletAddress,
    affiliateCode: user.affiliateCode,
  });
};

// Khi user đăng ký
const handleSignUp = async (user) => {
  track('signup', {
    userId: user.id,
    email: user.email,
    walletAddress: user.walletAddress,
  });
};
```

## Integration với Tracking Click

Trong `src/app/api/tracking/click/route.ts`:

```typescript
import { track, AnalyticsEvents } from '@/lib/analytics';

export async function POST(request: Request) {
  const { dealId, userId } = await request.json();

  // Track deal click
  track(AnalyticsEvents.DEAL_CLICK, {
    userId,
    dealId,
    exchange: deal.exchange,
  });

  // ... rest của logic
}
```

## Integration với Webhook Conversions

Trong `src/app/api/webhooks/exchange/route.ts`:

```typescript
import { track, AnalyticsEvents } from '@/lib/analytics';

// Khi conversion được tạo
const conversion = await createConversion(...);

track(AnalyticsEvents.CONVERSION, {
  userId: conversion.userId,
  conversionId: conversion.id,
  dealId: conversion.dealId,
  exchange: conversion.exchange,
  volume: conversion.volume,
  commission: conversion.commission,
});
```

## Integration với Payouts

Trong `src/lib/payouts/stellar-service.ts`:

```typescript
import { track, AnalyticsEvents } from '@/lib/analytics';

// Khi payout thành công
await sendPayout(...);

track(AnalyticsEvents.PAYOUT, {
  userId: payout.userId,
  payoutId: payout.id,
  payoutAmount: payout.amount,
  walletAddress: payout.walletAddress,
});
```

## Testing

### Local Development

Analytics tự động disable trong development nếu không có tokens. Để test:

1. Thêm tokens vào `.env.local`:
```bash
NEXT_PUBLIC_MIXPANEL_TOKEN=test_token
NODE_ENV=development
```

2. Mixpanel sẽ dùng `mixpanel-browser` debug mode, logs ra console.

### Production

1. Lấy tokens từ Mixpanel/Amplitude dashboard:
   - **Mixpanel:** Settings → Projects → Access Tokens
   - **Amplitude:** Settings → Projects → API Keys

2. Thêm vào Cloudflare Pages / Vercel environment variables:
   - `NEXT_PUBLIC_MIXPANEL_TOKEN`
   - `NEXT_PUBLIC_AMPLITUDE_API_KEY`
   - `NEXT_PUBLIC_ANALYTICS_ENABLED=true`

## Data Retention & Privacy

### Mixpanel
- Retention mặc định: 24 months
- Có thể điều chỉnh trong Mixpanel → Settings → Data Management

### Amplitude
- Retention mặc định: 24 months (free tier: 12 months)
- Có thể điều chỉnh trong Amplitude → Settings → Data Retention

### GDPR Compliance

Thêm opt-out mechanism:

```typescript
// Trong component hoặc hook
import { analytics } from '@/lib/analytics';

// Disable analytics nếu user reject cookies
if (userConsent === false) {
  analytics['enabled'] = false; // private field - cần thêm public method
}
```

**Lưu ý:** Hiện tại analytics service tự động skip nếu `NEXT_PUBLIC_ANALYTICS_ENABLED=false`.

## Debugging

### Mixpanel Debug Mode

```bash
# Trong development
NODE_ENV=development pnpm dev
# Mixpanel sẽ log tất cả events ra console
```

### Amplitude Debug Mode

```typescript
// Thêm vào code khi cần debug
import * as amplitude from '@amplitude/analytics-browser';
amplitude.setLogLevel('VERBOSE');
```

### Verify Events

- **Mixpanel:** Live View → Events
- **Amplitude:** Dev Tools → Debugger

## Best Practices

1. **Identify users consistently:**
   - Dùng `userId` ổn định qua platforms (ví dụ: database ID)
   - Avoid using email as userId (privacy)

2. **Event naming:**
   - Dùng `snake_case` cho event names
   - Prefix với app name nếu cần: `apexos_signup`

3. **Properties:**
   - Giữ properties đơn giản, primitive types
   - Avoid sending PII (email, wallet) nếu không cần thiết
   - Dùng consistent naming conventions

4. **Performance:**
   - Analytics được send async, không block UI
   - Mixpanel/Amplitude tự động batch requests

5. **Type Safety:**
   - Dùng `AnalyticsProperties` interface
   - Extend với custom properties khi cần

## Troubleshooting

### Events không track

1. Kiểm tra env vars đã set đúng chưa:
```bash
echo $NEXT_PUBLIC_MIXPANEL_TOKEN
echo $NEXT_PUBLIC_AMPLITUDE_API_KEY
```

2. Kiểm tra console cho errors:
```
[Analytics] Failed to initialize Mixpanel: ...
```

3. Kiểm tra `analytics.isReady()` trước khi track:
```typescript
if (analytics.isReady()) {
  track('event', { ... });
}
```

### SSR issues

Analytics tự động disable trong SSR. Chỉ track trong client components hoặc `useEffect`:

```typescript
'use client';
import { track } from '@/lib/analytics';

useEffect(() => {
  track('page_view', { page: window.location.pathname });
}, []);
```

## Next Steps

- [ ] Cấu hình Mixpanel/Amplitude projects
- [ ] Thêm tracking vào auth flows
- [ ] Thêm tracking vào deal clicks
- [ ] Thêm tracking vào conversion webhook
- [ ] Thêm tracking vào payout flow
- [ ] Verify events trong dashboard
- [ ] Set up custom dashboards và reports

## References

- [Mixpanel Docs](https://developer.mixpanel.com/docs)
- [Amplitude Docs](https://amplitude.com/docs)
- [Next.js Environment Variables](https://nextjs.org/docs/app/building-your-application/configuring/environment-variables)
