# Alerting System Quick Reference

## Commands

```bash
# Run full alerting test suite
pnpm test:alerting

# Test specific notification channel
pnpm test:channel slack
pnpm test:channel email
pnpm test:channel telegram

# Alert Engine API (via Cloudflare Pages or wrangler dev)
curl /api/monitoring/alert-engine?run=true  # Force evaluation
curl /api/monitoring/alert-engine           # Get status

# Snooze API
curl /api/monitoring/d1/snoozes              # List active
curl -X POST /api/monitoring/d1/snoozes      # Create snooze
curl -X DELETE /api/monitoring/d1/snoozes/ID # Delete snooze
```

## Environment Variables

### Required for Notifications

```bash
NOTIFICATIONS_ENABLED=true
NOTIFICATION_DEFAULT_PRIORITY=normal
NOTIFICATION_RATE_LIMIT=60
NOTIFICATION_MAX_RETRIES=3
NOTIFICATION_RETRY_BACKOFF=1000
```

### Slack

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_ENABLED=true
SLACK_CHANNEL=#alerts
SLACK_USERNAME=ApexOS Bot
SLACK_ICON_EMOJI=:rocket:
```

### Email (Resend)

```bash
RESEND_API_KEY=re_your_key
RESEND_FROM_EMAIL=noreply@apex-os.com
RESEND_FROM_NAME=ApexOS
NOTIFICATION_EMAIL_RECIPIENTS=admin@example.com,alerts@example.com
```

### Telegram

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_IDS=-1001234567890
TELEGRAM_ENABLED=true
TELEGRAM_PARSE_MODE=HTML
```

---

## Alert Rules

### D1 Database Alerts

| ID | Name | Metric | Threshold | Severity |
|-----|------|--------|-----------|----------|
| `alert-slow-query` | Slow Query | avg_query_duration_ms > 1000ms | > 1s | warning |
| `alert-storage` | High Storage | storage_usage_percent ≥ 80% | ≥ 80% | critical |
| `alert-slow-count` | Excessive Slow Queries | slow_query_count > 10 | > 10 | warning |
| `alert-rows-scanned` | High Row Scan | avg_rows_scanned > 10000 | > 10k | warning |

### Business Alerts

| ID | Name | Metric | Threshold | Severity |
|-----|------|--------|-----------|----------|
| `biz-revenue-drop` | Revenue Drop | daily_revenue < $100 | < $100 | warning |
| `biz-conversion-rate-low` | Low Conversion Rate | conversion_rate < 2% | < 2% | warning |
| `biz-zero-conversions` | No Conversions | total_conversions = 0 | = 0 | critical |
| `biz-high-commission-liability` | High Commission Liability | pending_commission ≥ $10k | ≥ $10k | warning |
| `biz-stellar-balance-low` | Low Stellar Balance | stellar_balance < 100 | < 100 USDC | critical |

---

## Snoozing Alerts

### Preset Durations
- 60 minutes (1 hour)
- 360 minutes (6 hours)
- 1440 minutes (24 hours)

### API

```bash
# Create snooze
POST /api/monitoring/d1/snoozes
{
  "alertConfigId": "alert-slow-query",
  "durationMinutes": 60,
  "reason": "Maintenance window"
}

# List active snoozes
GET /api/monitoring/d1/snoozes

# Delete snooze
DELETE /api/monitoring/d1/snoozes/{id}
```

---

## File Locations

| Component | Path |
|-----------|------|
| Alert Engine | `src/lib/monitoring/alert-engine.ts` |
| Notification Service | `src/lib/notifications/index.ts` |
| Slack Notifier | `src/lib/notifications/channels/slack.ts` |
| Email Notifier | `src/lib/notifications/channels/email.ts` |
| Telegram Notifier | `src/lib/notifications/channels/telegram.ts` |
| D1 Monitor | `src/lib/monitoring/d1-monitor.ts` |
| Types | `src/types/business-alerting.ts` |
| API Routes | `src/app/api/monitoring/alert-engine/`, `src/app/api/monitoring/d1/snoozes/` |
| Tests | `scripts/test-alerting-system.ts`, `scripts/test-notification-channel.ts` |
| Documentation | `docs/alerting-system-test-report.md` |

---

## Testing Checklist

- [ ] Configure Slack webhook URL
- [ ] Configure Resend API key and recipients
- [ ] Configure Telegram bot token and chat IDs
- [ ] Run `pnpm test:alerting` - all configuration tests pass
- [ ] Run `pnpm test:channel slack` - test notification sent
- [ ] Run `pnpm test:channel email` - test email sent
- [ ] Run `pnpm test:channel telegram` - test message sent
- [ ] Verify Cloudflare Pages cron is configured (every 5 minutes)
- [ ] Test snooze API manually
- [ ] Review alert history in admin dashboard

---

## Cron Configuration (wrangler.toml)

```toml
[[triggers]]
crons = ["*/5 * * * *"]
```

---

## Troubleshooting

| Issue | Check |
|-------|-------|
| Slack not sending | Webhook URL, channel membership, bot permissions |
| Email not sending | Resend API key, credits, domain verification |
| Telegram failing | Bot token, bot added to chat, chat ID format |
| No alerts triggered | Check `d1_alert_configs.is_enabled`, metric data exists |
| Alerts still firing after snooze | Check `alert_snoozes` table, `expires_at` datetime |
| Rate limit errors | Wait 1 minute, check `NOTIFICATION_RATE_LIMIT` |

---

## Test Results Summary

**Last Test Run:** See `docs/alerting-system-test-report.md`

**Current Status:**
- ✅ Configuration loading: 9/9 tests passed
- ⏭️ Channel tests: Skipped (no credentials configured)
- ⏭️ API tests: Skipped (not in Cloudflare Pages environment)

---

**Last Updated:** 2026-06-22
