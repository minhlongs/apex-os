# Phase 02: Fix Notification Tests + Console Cleanup

## Context
~45 test failures from notification channel refactor drift and console.log noise in production code.

## Files to Modify
- `src/lib/notifications/email-notifier.ts` — remove console.log debug statements
- `src/lib/notifications/notification-channels.ts` — remove console.log
- `src/app/api/cron/route.ts` — remove console.log
- `src/app/api/affiliate/conversions/route.ts` — remove console.log
- `__tests__/lib/notifications/notification-channels.test.ts` — update mocks, fix call counts
- `__tests__/lib/notifications/email-notifier.test.ts` — update mock setup for Resend SDK
- `src/lib/webhooks/kucoin-signature.ts` — fix base64 edge case

## Steps
1. Remove all console.log from production API routes (grep for console.log in src/app/api/)
2. Remove console.log from lib/notifications/
3. Fix notification test mocks: Resend SDK initialization, expected call counts
4. Fix email template expectations: add severity prefix, action URLs
5. Fix Slack payload: ensure 3+ fields
6. Fix KuCoin signature: handle base64 encoding edge cases
7. Run tests: `pnpm test -- __tests__/lib/notifications/`

## Acceptance
- notification-channels suite: 0 failures
- email-notifier suite: 0 failures
- kucoin-verification suite: 0 failures
- Zero console.log in src/app/api/ and src/lib/notifications/
