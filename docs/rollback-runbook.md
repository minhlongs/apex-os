# Rollback Runbook (Quy Trình Khôi Phục Phiên Bản Trước)

> **Mô tả / Description:**
> - **Tiếng Việt:** Quy trình khẩn cấp để đưa hệ thống ApexOS trên Cloudflare Workers về lại phiên bản hoạt động ổn định gần nhất khi phát hiện lỗi sau khi triển khai (deploy), đảm bảo không làm hỏng dữ liệu hay trả tiền nhầm.
> - **English:** Mechanical step-by-step rollback procedure for ApexOS on Cloudflare Workers (`apex-os-staging` and `apex-os`) when a post-deploy check fails or a production incident occurs.

---

## 1. Khi Nào Cần Rollback Ngay Lập Tức? (When to Rollback Immediately)

Thực hiện rollback ngay nếu xảy ra một trong các dấu hiệu sau:
1. `scripts/verify-deployment.sh` báo lỗi (`SMOKE_FAILED` hoặc lệch `sha` trên `/api/version`).
2. Bất kỳ route bảo vệ nào (`/api/cron`, `/api/webhooks/*`, `/api/terminal/*`) trả mã `5xx` hoặc trả `200` khi không có chữ ký/token hợp lệ.
3. Hệ thống cảnh báo (`AlertEngine`) báo lỗi kết nối D1 hoặc lỗi thanh toán Stellar ngoài dự kiến.

---

## 2. Cách 1: Rollback Tức Thì Qua Wrangler CLI (Khuyến Nghị — Dưới 60 Giây)

Cloudflare lưu sẵn lịch sử các phiên bản Worker đã tải lên. Bạn có thể quay về phiên bản ngay trước đó chỉ bằng 1 lệnh mà không cần build lại code:

### Bước 1: Kiểm tra danh sách phiên bản (View Recent Deployments)

**Cho môi trường Staging (`apex-os-staging`):**
```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
./node_modules/.bin/wrangler deployments list --config wrangler.staging.jsonc
```

**Cho môi trường Production (`apex-os`):**
```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
./node_modules/.bin/wrangler deployments list --config wrangler.jsonc
```

### Bước 2: Chạy lệnh Rollback (Execute Instant Rollback)

**Rollback Staging:**
```bash
./node_modules/.bin/wrangler rollback --config wrangler.staging.jsonc -y
```

**Rollback Production:**
```bash
./node_modules/.bin/wrangler rollback --config wrangler.jsonc -y
```

*(Bạn cũng có thể chỉ định một `version-id` cụ thể bằng `./node_modules/.bin/wrangler rollback <version-id> --config ... -y`)*

---

## 3. Cách 2: Rollback Qua GitHub Actions (Không Cần Máy Cá Nhân)

1. Mở tab **Actions** trên GitHub repository `apex-os`.
2. Chọn workflow **Deploy** (`.github/workflows/deploy.yml`).
3. Nhấn **Run workflow** (`workflow_dispatch`):
   - Chọn `rollback-staging` để khôi phục Staging (`apex-os-staging`).
   - Chọn `rollback-production` để khôi phục Production (`apex-os`).
4. Theo dõi job **Rollback Deployment** hoàn tất.

---

## 4. Cách 3: Redeploy Từ Một Commit SHA Cũ Đã Biết Tốt (Clean Rebuild From Known-Good SHA)

Khi cần build lại hoàn toàn từ một commit SHA cũ:

```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
git checkout <KNOWN_GOOD_COMMIT_SHA>
rm -rf .open-next
export NEXT_PUBLIC_COMMIT_SHA="$(git rev-parse HEAD)"
export NEXT_PUBLIC_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Với Staging:
npm run deploy:staging

# Với Production:
npm run deploy:production
```

---

## 5. Kiểm Tra Bắt Buộc Sau Khi Rollback (Post-Rollback Verification Checklist)

Sau khi rollback xong, **bắt buộc** chạy kiểm tra tự động để xác nhận hệ thống đã ổn định trở lại:

```bash
# Kiểm tra Staging
bash scripts/verify-deployment.sh <STAGING_WORKER_URL>

# Kiểm tra Production
bash scripts/verify-deployment.sh <PRODUCTION_WORKER_URL>
```

**Tiêu chuẩn đạt (Pass Criteria):**
- [ ] `GET /api/version` trả HTTP `200` với `sha` của bản ổn định trước đó.
- [ ] `GET /api/health` trả HTTP `200` (hoặc trạng thái không phải `5xx`).
- [ ] Toàn bộ 8 route bảo vệ trong `scripts/smoke-protected-routes.sh` từ chối truy cập trái phép (`401`/`400`/`403`) và không có lỗi `5xx`.
- [ ] Kiểm tra bảng `payouts` và `earnings` trên D1 đảm bảo không có dòng `status = 'processing'` bị treo:
  ```bash
  ./node_modules/.bin/wrangler d1 execute apex-os-db --remote \
    --command "SELECT status, COUNT(*) as count FROM payouts GROUP BY status"
  ```
