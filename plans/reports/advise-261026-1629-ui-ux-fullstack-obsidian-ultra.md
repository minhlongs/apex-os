# Báo cáo Tư vấn Kiến trúc UI/UX Full-Stack Design System (Web + Mobile) — ApexOS Obsidian

---

## 1. Kết quả Đánh giá Verifier Best-of-5 (`--ultra`)

Hội đồng thẩm định Verifier đã chấm điểm độc lập 5 ứng viên dựa trên 4 tiêu chí chuẩn mực (Thang điểm 20/tiêu chí, tổng 80 điểm):
1. **Tuân thủ Yêu cầu & Giới hạn (Faithfulness):** Thấu hiểu đúng scope đã confirm, không chạm vào `/admin/*`, không phá vỡ hợp đồng cũ.
2. **Khảo sát Thực chứng (Evidence Grounding):** Trích dẫn đúng file paths, contracts, database schemas, regex, HTTP status codes (`400`, `409`).
3. **Tính Trung thực về Đánh đổi (Trade-off Honesty):** Thẳng thắn chỉ rõ nhược điểm kỹ thuật, không che giấu chi phí bảo trì.
4. **Khả năng Thực thi & Bàn giao (Actionability):** Checklist chi tiết, test suite rõ ràng, handoff brief chuyển giao được ngay cho `ak:cook`.

| Ứng viên | Trọng tâm Kiến trúc | Tiêu chí 1 | Tiêu chí 2 | Tiêu chí 3 | Tiêu chí 4 | Tổng Điểm | Xếp hạng |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Candidate 3** | WCAG 2.1 AA (#64748B -> #94A3B8), 5-State Feedback, Overview Double-Branch | 20 | 20 | 19 | 20 | **79/80** | **CHIẾN THẮNG (WINNER)** |
| **Candidate 2** | Isomorphic Contract Module, Zero Bundler Drift, Profile Sub-route | 19 | 19 | 20 | 19 | **77/80** | Hạng 2 |
| **Candidate 4** | Luồng Onboarding Tự phục vụ 3 bước, Attribution Clarity, Zero Secret Notice | 19 | 19 | 19 | 19 | **76/80** | Hạng 3 |
| **Candidate 5** | Zero Dependency Token Parity, Phân kỳ 4 bước, Featherlight Edge Bundle | 18 | 19 | 19 | 19 | **75/80** | Hạng 4 |
| **Candidate 1** | Single Canonical Contract, Dual Runtime, Parity Gate | 18 | 18 | 18 | 18 | **72/80** | Hạng 5 |

**Quyết định Verifier:** Chọn phương án của **Candidate 3** làm hạt nhân chính (đặc biệt là phát hiện quan trọng về độ tương phản WCAG 2.1 AA và hiển thị `ExchangeKeysManager` ở cả 2 nhánh của `dashboard-overview.tsx`), đồng thời tích hợp thế mạnh từ Candidate 2 (Isomorphic Contract) và Candidate 4 (Attribution Clarity).

---

## 2. Verdict (Kết luận Thẩm định)

**TRIỂN KHAI NGAY THEO KIẾN TRÚC ZERO-DEPENDENCY OBSIDIAN TOKEN CONTRACT KẾT HỢP GIAO DIỆN QUẢN LÝ KHÓA SÀN TỰ PHỤC VỤ (SELF-SERVICE ATTRIBUTION).**

Hiện trạng hai codebase tại `/Users/macbook/apex-os` và `/Users/macbook/apex-os/apex-os-mobile` cho thấy:
1. **Lệch pha thị giác nghiêm trọng:** `StitchObsidianBanner` và `/terminal` mang phong cách Obsidian tối `#020617`, trong khi `dashboard-layout.tsx` (`from-blue-50 to-indigo-100`) và các trang con trong `src/app/[locale]/dashboard/*` dùng nền sáng `bg-white` / `text-gray-900`.
2. **Lỗi vi phạm độ tương phản WCAG 2.1 AA:** Màu `textMuted` hiện tại `#64748B` trên nền tối `#020617` chỉ đạt tỷ lệ tương phản **3.0:1** (dưới ngưỡng 4.5:1 bắt buộc). Cần nâng cấp ngay lên `#94A3B8` (**5.7:1+**) để đảm bảo khả năng tiếp cận chuẩn mực tài chính định lượng.
3. **Endpoint Backend bị mồ côi (Orphaned API):** Route `/Users/macbook/apex-os/src/app/api/profile/exchange-keys/route.ts` đã hoàn thiện đầy đủ `GET`, `POST`, `DELETE` cho 4 sàn (`okx`, `kucoin`, `binance`, `bybit`), regex `/^[A-Za-z0-9_-]{6,128}$/`, và chống trùng lặp `409 Conflict`, nhưng chưa có bất kỳ giao diện nào trên Web Dashboard và Mobile App kết nối vào.

---

## 3. What to do (Những việc cần làm cụ thể)

1. **Thiết lập Isomorphic Obsidian Token Contract & Parity Unit Test:**
   - Tạo `/Users/macbook/apex-os/src/lib/theme/obsidian-tokens.ts` (Web) xuất `obsidianTokens` (`canvas: '#020617'`, `surface: '#0F172A'`, `well: '#1E293B'`, `border: '#1E293B'`, `divider: '#334155'`, `indigo: '#6366F1'`, `cyan: '#06B6D4'`, `emerald: '#10B981'`, `textPrimary: '#F8FAFC'`, `textMuted: '#94A3B8'`).
   - Cập nhật `/Users/macbook/apex-os/apex-os-mobile/src/theme/tokens.ts` xuất `obsidianTokens` đồng bộ 1:1, giữ nguyên `colors` cũ để tương thích ngược.
   - Viết bài kiểm thử tự động `/Users/macbook/apex-os/src/__tests__/theme/obsidian-tokens-parity.test.ts` kiểm tra tính đối xứng và toán học tương phản WCAG >= 4.5:1.
2. **Nâng cấp Web Dashboard sang Obsidian Theme:**
   - Cập nhật `dashboard-layout.tsx`, `dashboard-header.tsx`, `dashboard-sidebar.tsx` sang các lớp `bg-stitch-canvas`, `bg-stitch-surface`, `border-stitch-border`, `text-stitch-primary`.
   - Sửa liên kết điều hướng trong `DashboardSidebar` tự động gắn tiền tố `locale` (`/${locale}/dashboard/...`) và tạo trang `/Users/macbook/apex-os/src/app/[locale]/dashboard/profile/page.tsx` để xóa bỏ lỗi 404.
   - Nâng cấp `dashboard-overview.tsx`, `affiliates-client.tsx`, `conversions-client.tsx`, `payouts-client.tsx`, `notifications-client.tsx` sang nền tối Obsidian, dùng `font-mono` cho số liệu.
3. **Xây dựng `ExchangeKeysManager` (Web) với 5 trạng thái phản hồi:**
   - Tạo `/Users/macbook/apex-os/src/components/profile/ExchangeKeysManager.tsx` song ngữ VN/EN, kết nối `GET / POST / DELETE /api/profile/exchange-keys`.
   - Xử lý 5 trạng thái: Loading Skeleton, Trống (Unlinked), Đã liên kết (Linked), Lỗi định dạng `400 Bad Request`, và Trùng lặp `409 Conflict`.
   - Nhúng vào **cả hai nhánh** của `dashboard-overview.tsx` (nhánh user mới `total_clicks === 0` và nhánh affiliate đang hoạt động) cùng trang `dashboard/profile`.
4. **Đồng bộ Mobile App (`apex-os-mobile`):**
   - Bổ sung `endpoints.profile.exchangeKeys` vào `/Users/macbook/apex-os/apex-os-mobile/src/api/endpoints.ts`.
   - Tạo `/Users/macbook/apex-os/apex-os-mobile/src/components/ExchangeKeysCard.tsx` song ngữ VN/EN, xử lý lỗi `409` & `400`.
   - Áp dụng `obsidianTokens` cho `DashboardScreen.tsx`, `ProfileScreen.tsx`, `AffiliateDashboardScreen.tsx`, và `WalletConnect.tsx`.

---

## 4. What you shouldn't do (Những việc tuyệt đối tránh)

- **Không cài đặt framework UI nặng nề (Tamagui, NativeWind v4, Gluestack):** Giữ bundle nhẹ 0KB dependency thừa.
- **Không ghi đè hoặc xóa các thuộc tính cũ trong `colors` của Mobile `tokens.ts`:** Để không làm gãy các bài test hiện có trong `__tests__/theme/tokens.test.ts`.
- **Không thay đổi schema D1 hoặc logic webhook backend:** Giữ nguyên cấu trúc `profiles.external_ids`.
- **Không chạm vào `/admin/*`:** Giữ phạm vi nghiêm ngặt trong User Dashboard và Mobile App.
- **Không tạo ô nhập Secret Key hoặc Passphrase:** Chỉ nhập duy nhất `api_key_id` công khai.

---

## 5. What could be better / more efficient (Tối ưu hóa hiệu quả)

1. **Cập nhật trực tiếp State từ Response của `POST` và `DELETE`:** Không cần gọi lại request `GET` thứ hai vì backend đã trả về `data.external_ids` mới nhất.
2. **Kiểm tra Regex tức thì phía Client:** Dùng hằng số chung `API_KEY_ID_REGEX = /^[A-Za-z0-9_-]{6,128}$/` chặn lỗi nhập liệu trước khi tốn request mạng lên Cloudflare Workers D1.
3. **Banner giải thích Zero-Secret & Attribution:** Giúp người dùng yên tâm không sợ lộ khóa và hiểu rõ cơ chế nhận cashback 3 tầng (30%/10%/5%).

---

## 6. Work checklist & Success metrics

### Work Checklist
- [ ] Tạo `/Users/macbook/apex-os/src/lib/theme/obsidian-tokens.ts` & cập nhật `tokens.ts` trên Mobile.
- [ ] Viết test tự động đối chiếu Parity & WCAG tại `/Users/macbook/apex-os/src/__tests__/theme/obsidian-tokens-parity.test.ts`.
- [ ] Chuyển đổi Web `dashboard-layout.tsx`, `dashboard-header.tsx`, `dashboard-sidebar.tsx` sang Obsidian classes.
- [ ] Tạo trang `/Users/macbook/apex-os/src/app/[locale]/dashboard/profile/page.tsx` và xây dựng `ExchangeKeysManager.tsx`.
- [ ] Nâng cấp `dashboard-overview.tsx` (nhúng `ExchangeKeysManager` cho cả 2 nhánh user) và các trang con `affiliates`, `conversions`, `payouts`.
- [ ] Mở rộng `endpoints.profile.exchangeKeys` và xây dựng `ExchangeKeysCard.tsx` trên Mobile.
- [ ] Đồng bộ `obsidianTokens` trên `DashboardScreen.tsx`, `ProfileScreen.tsx`, `AffiliateDashboardScreen.tsx`, `WalletConnect.tsx`.
- [ ] Chạy kiểm thử tự động toàn diện: `npm test` trên Web (Node 26) và `npx vitest run` trên Mobile.

### Success Metrics
1. **100% Token Parity & WCAG AA:** Mã màu đồng nhất tuyệt đối giữa Web và Mobile; độ tương phản văn bản đạt `>= 4.5:1` (không còn `#64748B` trên nền tối).
2. **100% Phủ luồng API Key Sàn:** Người dùng tự liên kết, cập nhật, hủy liên kết thành công với OKX, KuCoin, Binance, Bybit trên cả Web và Mobile.
3. **0 Lỗi Hồi quy & Chuẩn mực Mã nguồn:** `0 :any`, `0 console.log` trong mã sản xuất; 100% test suites vượt qua xanh (PASS).

---

## 7. Handoff Brief (Chuyển giao Thực thi)

```text
Objective: Triển khai Full-Stack Obsidian Design System và Giao diện Quản lý Khóa API Sàn Tự phục vụ trên Web Dashboard và Mobile App.
Done means:
1. File src/lib/theme/obsidian-tokens.ts (Web) và src/theme/tokens.ts (Mobile) xuất obsidianTokens đồng nhất và bài test parity/WCAG pass 100%.
2. Web Dashboard (layout, header, sidebar, overview, affiliates, conversions, payouts, profile) chuyển hoàn toàn sang Obsidian Dark mode, không còn bg-white lạc lõng, sidebar link có locale.
3. Component ExchangeKeysManager (Web) và ExchangeKeysCard (Mobile) hoạt động mượt mà với /api/profile/exchange-keys, xử lý đúng lỗi 400 và 409 bằng song ngữ VN/EN.
4. Mọi bài test Jest (Web, Node 26) và Vitest (Mobile) pass 100%, 0 :any, 0 console.log.
Out of scope: Thay đổi các trang quản trị /admin/*, sửa đổi database schema D1, hoặc thêm các thư viện UI bên thứ ba.
Constraints: Giữ nguyên export colors cũ trên Mobile để tương thích ngược; dùng @/lib/logger và @/utils/logger thay vì console; chỉ nhập api_key_id không nhập secret key.
Stop and ask only if: Phát hiện API route /api/profile/exchange-keys thay đổi chữ ký trả về hoặc có xung đột không thể giải quyết trong quá trình build worker.
```
