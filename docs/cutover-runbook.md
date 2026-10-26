# Production Cutover Runbook (Quy Trình Chuyển Đổi Lên Production — Phase 07)

> **Mô tả / Description:**
> - **Tiếng Việt:** Quy trình từng bước từ `T-1h` đến sau đợt thanh toán đầu tiên (`T+first-payout`) cho ApexOS `v1.5.0` trên Cloudflare Workers + D1, bao gồm kiểm tra đối chiếu lịch sử thanh toán bắt buộc, cơ chế phát hành thủ công lần đầu (`AUTO_SETTLE_PAYOUTS=false`), và tiêu chí hủy/rollback.
> - **English:** Step-by-step production cutover sequence (`T-1h` to `T+first-payout`) for ApexOS `v1.5.0` on Cloudflare Workers + D1, including mandatory historical payout reconciliation, manual-first payout rollout (`AUTO_SETTLE_PAYOUTS=false`), and abort/rollback criteria.

---

## 1. Quy Tắc Thời Điểm Cutover (Cutover Timing Rule — NF1)

- **Tuyệt đối không thực hiện cutover trong vòng 48 giờ trước cửa sổ thanh toán định kỳ Chủ Nhật 00:00 UTC (`0 0 * * 0`).**
- Thời điểm khuyến nghị: Đầu tuần (Thứ Hai – Thứ Năm), đảm bảo có ít nhất 48 giờ theo dõi hệ thống trước khi lịch cron hàng tuần chạy.
- Cờ `AUTO_SETTLE_PAYOUTS=false` **bắt buộc** được giữ ở trạng thái `false` khi bắt đầu cutover để ngăn cron tự động phát lệnh chuyển tiền trước khi Admin kiểm chứng thủ công đợt đầu tiên.

---

## 2. Kiểm Tra Trước Giờ G (`T-1h` Pre-Flight & Historical Reconciliation)

### Bước 2.1: Xác nhận môi trường Node 26 và Wrangler nội bộ
```bash
export PATH=/opt/homebrew/opt/node@26/bin:$(pwd)/node_modules/.bin:$PATH
node --version                                # Phải là v26.7.0
./node_modules/.bin/wrangler --version        # Phải là 4.152.0 (pinned trong repo)
```

### Bước 2.2: Chạy cổng kiểm định Go-Live G0–G5 tại local
```bash
GATE_SHA=$(git rev-parse HEAD) npm run gate
```
- Bắt buộc đạt **21/21 PASS, 0 FAIL**.

### Bước 2.3: Đối chiếu lịch sử thanh toán (Mandatory Pre-Flight — F1)
Trước khi nâng cấp mã nguồn có khả năng gửi USDC thật, chạy script đối chiếu **chỉ đọc (read-only)** trên cơ sở dữ liệu D1 để phát hiện các dòng `payouts` giả lập từ các bản thử nghiệm cũ (`MOCK_SIGNED_TX_PAYLOAD`, giao dịch hoàn tất trên `solana`/`ethereum` khi chưa có chữ ký thật, hoặc `earnings` có `is_paid = 1` nhưng `payout_id IS NULL`):

```bash
npm run reconcile:payouts -- --remote
```

- **Quy tắc xử lý:**
  - Nếu cả 2 truy vấn trả về `0` dòng bất thường: Tiếp tục Bước 3.
  - Nếu phát hiện bất kỳ dòng nào: **Dừng cutover**, xuất danh sách gửi Founder để ký quyết định xử lý trong `plans/261020-zero-bug-go-live/go-live-signoff.md`. Tuyệt đối không tự ý xóa hoặc sửa lịch sử sổ cái.

### Bước 2.4: Kiểm tra biến môi trường Production trên Cloudflare
Đảm bảo các biến sau đã được cấu hình trên Cloudflare Worker `apex-os`:
- `STELLAR_NETWORK=mainnet`
- `AUTO_SETTLE_PAYOUTS=false` *(giữ `false` cho đợt đầu)*
- `STELLAR_SECRET_KEY`, `STELLAR_USDC_ISSUER`, `CRON_SECRET`, `BETTER_AUTH_SECRET`
- `BINANCE_WEBHOOK_SECRET`, `BYBIT_WEBHOOK_SECRET`, `OKX_WEBHOOK_SECRET`, `KUCOIN_WEBHOOK_SECRET`
- `RESEND_API_KEY`, `SLACK_WEBHOOK_URL` / `TELEGRAM_BOT_TOKEN`

---

## 3. Thực Thi Cutover (`T-0` Production Deploy)

### Bước 3.1: Triển khai và kiểm tra trên Staging trước
```bash
export NEXT_PUBLIC_COMMIT_SHA="$(git rev-parse HEAD)"
export NEXT_PUBLIC_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
npm run deploy:staging
bash scripts/verify-deployment.sh https://staging.apex-os.com "${NEXT_PUBLIC_COMMIT_SHA}"
```

### Bước 3.2: Triển khai lên Production
```bash
export NEXT_PUBLIC_COMMIT_SHA="$(git rev-parse HEAD)"
export NEXT_PUBLIC_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
npm run deploy:production
```

### Bước 3.3: Chạy cổng kiểm định ở chế độ Deploy-Mode trên Production
```bash
GATE_SHA="$(git rev-parse HEAD)" GATE_URL="https://apex-os.com" npm run gate
bash scripts/verify-deployment.sh https://apex-os.com "$(git rev-parse HEAD)"
```

---

## 4. Theo Dõi Sau Triển Khai (`T+0` đến `T+24h`)

### Cửa sổ `T+0..2h` (Giám sát tức thì)
1. Kiểm tra `/api/version` trả đúng `sha` vừa triển khai và `env: "production"`.
2. Kiểm tra `/api/health` trả HTTP `200`.
3. Xác nhận 8 route bảo vệ trong `scripts/smoke-protected-routes.sh` từ chối request không xác thực (`401`/`400`/`403`) và không phát sinh lỗi `5xx`.
4. Kích hoạt thử nghiệm 1 chu kỳ cron cảnh báo:
   ```bash
   curl -fsSL -H "Authorization: Bearer ${CRON_SECRET}" "https://apex-os.com/api/cron?job=alerts"
   ```

### Cửa sổ `T+24h` (Kiểm tra ghi nhận hoa hồng)
- Xác nhận webhook giao dịch từ sàn (`Binance`/`Bybit`/`OKX`/`KuCoin`) đi vào bảng `conversions` và `earnings` với tổng chia hoa hồng chính xác theo đơn vị nguyên (`minor units`: Tier 1 30%, Tier 2 10%, Tier 3 5%).

---

## 5. Xác Thực Đợt Chi Trả Đầu Tiên (`T+First-Payout` Manual Verification)

1. Với `AUTO_SETTLE_PAYOUTS=false`, cron hàng tuần sẽ trả về thông báo an toàn:
   `"Manual-first rollout: set AUTO_SETTLE_PAYOUTS=true to enable automatic cron payouts"`.
2. Admin thực hiện xem trước (preview) và kích hoạt thủ công đợt chi trả đầu tiên qua `POST /api/payouts`.
3. Kiểm tra đối chiếu sổ cái trên D1 (chỉ đọc):
   ```bash
   ./node_modules/.bin/wrangler d1 execute apex-os-db --remote \
     --command "SELECT COUNT(*) AS unpaid_but_paid FROM earnings WHERE is_paid=1 AND payout_id IS NULL" --json
   ```
   *(Kết quả bắt buộc: `unpaid_but_paid = 0`)*
4. Kiểm tra mã giao dịch (`transaction_id`) trên `https://stellar.expert/explorer/public/tx/<HASH>`.
5. Sau khi xác nhận đợt đầu tiên khớp 100%, chuyển `AUTO_SETTLE_PAYOUTS=true` trên Cloudflare để kích hoạt cron tự động hàng tuần.

---

## 6. Tiêu Chí Hủy & Rollback Tức Thì (Abort & Rollback Criteria)

Thực hiện rollback ngay lập tức theo `docs/rollback-runbook.md` (`./node_modules/.bin/wrangler rollback --config wrangler.jsonc -y`) nếu xảy ra bất kỳ điều kiện nào sau đây:

1. Bất kỳ webhook bảo vệ nào (`/api/webhooks/*`) trả mã `5xx`.
2. `/api/cron` trả mã `200` khi gọi không có header `Authorization: Bearer <CRON_SECRET>`.
3. Sổ cái `earnings` và `payouts` xuất hiện dòng lệch (`is_paid = 1` nhưng `payout_id IS NULL` hoặc giao dịch chưa xác nhận on-chain).
4. Chỉ số quét dòng D1 (`avg_rows_scanned`) vượt ngưỡng cảnh báo `10,000` dòng/truy vấn.
5. Cron đánh giá cảnh báo (`/api/cron?job=alerts`) báo lỗi `500`.
