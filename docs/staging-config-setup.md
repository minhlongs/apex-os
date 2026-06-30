# Staging Configuration Setup Guide

## Tổng quan

File `.env.staging.example` cung cấp template đầy đủ cho môi trường staging/development với tất cả credentials test/mock. File này an toàn để commit vào git và làm mẫu cho việc tạo `.env.staging` thực tế.

## Cấu trúc File

File được chia thành 13 phần:

### 1. Authentication & Application
- `BETTER_AUTH_SECRET` - MOCK (tạo với `openssl rand -base64 32`)
- `BETTER_AUTH_ENCRYPTION_KEY` - MOCK
- `NEXT_PUBLIC_APP_URL` - Staging URL (mặc định: `http://localhost:3000`)
- `NEXT_PUBLIC_SITE_URL` - Site URL cho SEO

### 2. Monitoring & Error Tracking
- `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT` - MOCK
- `NEXT_PUBLIC_SENTRY_ENABLED=false` - Tắt Sentry trong staging

### 3. Cloudflare Infrastructure
- `CLOUDFLARE_API_TOKEN` - MOCK
- `CLOUDFLARE_ACCOUNT_ID` - MOCK
- `D1_DATABASE` - Tên database (mặc định: `apex-os-staging-db`)

### 4. Email (Resend)
- `RESEND_API_KEY` - MOCK (test mode key)
- `NEXT_PUBLIC_SENDER_EMAIL` - Email người gửi
- `NEXT_PUBLIC_SUPPORT_EMAIL` - Email hỗ trợ

### 5. Stellar Payouts (USDC)
- `STELLAR_SECRET_KEY` - MOCK testnet secret key
- `STELLAR_NETWORK=testnet` - Testnet cho staging
- `STELLAR_USDC_ISSUER` - Testnet USDC issuer address
- `STELLAR_USDC_CODE=USDC`

### 6. Exchange Webhooks
- `BINANCE_WEBHOOK_SECRET` - MOCK
- `BYBIT_WEBHOOK_SECRET` - MOCK

### 7. Payment Gateways
- **Polar:** `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_ORGANIZATION_ID` - MOCK
- **SePay:** `SEPAY_MERCHANT_ID`, `SEPAY_SECRET_KEY`, `SEPAY_API_URL` - MOCK

### 8. AI Services
- `ANTHROPIC_API_KEY` - MOCK (real cần lấy từ Anthropic)
- `OPENAI_API_KEY` - MOCK (optional)

### 9. Admin & Security
- `ADMIN_API_TOKEN` - MOCK (tạo với `openssl rand -base64 32`)

### 10. Notification Channels
- Global settings (`NOTIFICATIONS_ENABLED`, rate limits, etc.)
- **Slack:** `SLACK_WEBHOOK_URL`, `SLACK_CHANNEL` - MOCK
- **Email:** `NOTIFICATION_EMAIL_RECIPIENTS`, `RESEND_REPLY_TO`
- **Telegram:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` - MOCK

### 11. Third-Party Integrations (NEW)
Các integrations mới được thêm:

#### Notion API
```
NOTION_API_TOKEN=mock_notion_integration_token_secret_here
NOTION_DATABASE_ID=mock_notion_database_id_32_chars
NOTION_PAGE_ID=mock_notion_page_id_here
```
- **Real:** Lấy từ https://www.notion.so/my-integrations
- **Use case:** Content management, documentation sync, task tracking

#### Trello API
```
TRELLO_API_KEY=mock_trello_api_key_32_chars
TRELLO_API_TOKEN=mock_trello_api_token_here
TRELLO_BOARD_ID=mock_trello_board_id_here
TRELLO_LIST_ID=mock_trello_list_id_here
```
- **Real:** Lấy từ https://trello.com/app-key
- **Use case:** Project management, Kanban boards, sprint tracking

#### Zalo OA (Official Account)
```
ZALO_OA_ID=mock_zalo_oa_id_here
ZALO_OA_SECRET=mock_zalo_oa_secret_key_here
ZALO_ACCESS_TOKEN=mock_zalo_access_token_here
ZALO_REFRESH_TOKEN=mock_zalo_refresh_token_here
```
- **Real:** Lấy từ Zalo OA Admin: https://oa.zalo.me
- **Use case:** Vietnamese customer support, notifications, marketing

#### Google Sheets
```
GOOGLE_SHEETS_CREDENTIALS=mock_google_service_account_credentials_base64_here
GOOGLE_SHEETS_SPREADSHEET_ID=mock_google_sheets_spreadsheet_id_here
GOOGLE_SHEETS_WORKSHEET_NAME=Staging_Data
```
- **Real:** Tạo service account tại Google Cloud Console
- **Use case:** Data export, reports, analytics integration

#### Claude API (Alternative)
```
CLAUDE_API_KEY=mock_claude_api_key_sk-ant_claude_mock_for_staging
```
- **Real:** Lấy từ https://console.anthropic.com
- **Note:** `ANTHROPIC_API_KEY` là chính; `CLAUDE_API_KEY` là alias

### 12. Development Tools
- Debug flags: `NEXT_PUBLIC_DEBUG=true`, `DEBUG=apex-os:*`
- Feature flags: `FEATURE_*` variables
- Useful để toggle features trong staging

### 13. Database (Local Development)
- `DATABASE_URL=file:./dev.db` - Optional SQLite local dev

## Hướng dẫn Sử dụng

### Bước 1: Copy template
```bash
cp .env.staging.example .env.staging
```

### Bước 2: Tạo auth secrets
```bash
# Tạo BETTER_AUTH_SECRET
openssl rand -base64 32

# Tạo ADMIN_API_TOKEN
openssl rand -base64 32
```

### Bước 3: Cập nhật file `.env.staging`
```bash
# Mở file và thay giá trị mock bằng giá trị thực nếu cần
# Hoặc giữ nguyên mock values cho pure local dev
```

### Bước 4: Verify setup
```bash
# Check biến môi trường đã load
pnpm dev

# Hoặc test với script
node -e "console.log(process.env.BETTER_AUTH_SECRET ? 'OK' : 'MISSING')"
```

## Làm việc với Different Environments

### Local Development
```bash
# Sử dụng .env.staging (hoặc .env.local)
export NODE_ENV=development
pnpm dev
```

### Staging Deployment (Cloudflare Pages)
1. Trên Cloudflare Pages Dashboard:
   - Project → Settings → Environment Variables
   - Add tất cả biến từ `.env.staging`
   - Set environment = `staging`

2. Deploy với staging branch:
```bash
git push origin staging
# Cloudflare Pages sẽ tự động deploy
```

### Production
- Tạo file `.env.local` từ `.env.production.example`
- Điền REAL credentials (không dùng mock!)
- Deploy lên Cloudflare Pages với production environment variables

## Credentials Status Summary

### REAL Credentials (Production only)
- ❌ `ANTHROPIC_API_KEY` - Lấy từ Anthropic Console
- ❌ `RESEND_API_KEY` - Lấy từ Resend
- ❌ `STELLAR_SECRET_KEY` - Từ Stellar wallet (mainnet)
- ❌ `BINANCE_WEBHOOK_SECRET` / `BYBIT_WEBHOOK_SECRET` - Từ exchange dashboard
- ❌ `POLAR_*` - Từ Polar.sh org settings
- ❌ `SEPAY_SECRET_KEY` - Từ SePay merchant dashboard
- ❌ `CLOUDFLARE_API_TOKEN` - Từ Cloudflare API tokens
- ❌ `NOTION_API_TOKEN` - Từ Notion integration (khi tích hợp)
- ❌ `TRELLO_API_KEY` + `TRELLO_API_TOKEN` - Từ Trello (khi tích hợp)
- ❌ `ZALO_OA_SECRET` + `ZALO_ACCESS_TOKEN` - Từ Zalo OA (khi tích hợp)
- ❌ `GOOGLE_SHEETS_CREDENTIALS` - Service account JSON từ GCP

### MOCK/Staging Credentials (This file)
- ✅ TẤT CẢ giá trị trong `.env.staging.example` đều là MOCK/TEST
- ✅ Safe để commit, dùng cho development
- ✅ Không cần API rate limit concerns
- ✅ Testnet networks cho Stellar

## Integration Setup Guides

### Quick Reference

| Integration | Real URL | Staging Mode | Notes |
|-------------|----------|--------------|-------|
| Anthropic | console.anthropic.com | Test API keys | Unlimited free tier |
| Resend | resend.com | Test mode | 100 emails/day free |
| Stellar | horizon.stellar.org | Testnet | Free test USDC faucet |
| Binance | binance.com | Webhook test | Sandbox available |
| Bybit | bybit.com | Webhook test | Testnet available |
| Polar | polar.sh | Test mode | Sandbox available |
| SePay | sepay.vn | Test mode | QR test available |
| Notion | notion.so/my-integrations | Integration test | Free for personal |
| Trello | trello.com/app-key | API test | Free tier available |
| Zalo OA | oa.zalo.me | Sandbox | Requires approval |
| Google Sheets | console.cloud.google.com | Service account | Free tier available |

### Detailed Setup

Xem các file trong `docs/`:
- `docs/stellar-setup.md` - Stellar USDC payout configuration
- `docs/monitoring-setup.md` - Alerting & monitoring setup
- `docs/deployment-runbook.md` - Full deployment checklist
- `docs/operational-runbook.md` - Day-to-day operations

## Security Best Practices

1. **Never commit `.env` files** - Đã trong `.gitignore`
2. **Separate credentials** - Dùng khác nhau cho staging vs production
3. **Rotate regularly** - Đổi API keys mỗi 3-6 tháng
4. **Use read-only** - Dùng read-only keys khi có thể
5. **Audit logs** - Theo dõi access logs cho tất cả integrations
6. **Secret manager** - Production credentials nên lưu trong Cloudflare Secrets, 1Password, HashiCorp Vault

## Troubleshooting

### "Missing environment variable" error
```bash
# Check file tồn tại
ls -la .env.staging

# Verify loaded
echo $BETTER_AUTH_SECRET

# Restart dev server sau khi thêm biến mới
pnpm dev
```

### Webhook signature mismatch
- Verify `BINANCE_WEBHOOK_SECRET` khớp với exchange config
- Check HMAC-SHA256 signature verification code

### Stellar payout failing
- Confirm `STELLAR_NETWORK=testnet` cho staging
- Check testnet balance: https://testnet.kinzodaily.com
- Verify `STELLAR_USDC_ISSUER` là testnet issuer

### Email not sending
- Verify `RESEND_API_KEY` hợp lệ
- Check `NEXT_PUBLIC_SENDER_EMAIL` đã verify trong Resend
- View logs: Resend dashboard → Emails

## Support

Nếu gặp vấn đề:
1. Check logs: `tail -f .hermes/logs/errors.log`
2. Verify credentials against official docs
3. Test với cURL/Postman trước khi integrate
4. Consult `docs/operational-runbook.md`

---

**Last Updated:** 2026-06-23
**Version:** 1.0
**Maintainer:** ApexOS Team
