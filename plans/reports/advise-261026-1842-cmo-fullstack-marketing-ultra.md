# Báo Cáo Tư Vấn Chiến Lược (`--ultra` Best-of-5 Verifier): Institutional Quant-First GTM, `/[locale]/insights` & 5-Piece CMO/KOL Kit

- **Ngày tạo:** 2026-10-26
- **Chế độ thẩm định:** `--ultra` (Best-of-5 Independent Candidate Generation + Rubric Selection)
- **Ứng viên thắng cuộc:** Candidate 5 (hợp nhất các phát hiện thực chứng sắc bén nhất từ Candidate 2, 3, 4)
- **Trạng thái:** Đã xác nhận phạm vi ("cả 3 lớp kiến trúc") — Chuyển giao trực tiếp sang `/ak-vibe --ship --parallel`

---

## 1. Bảng Chấm Điểm Verifier (Best-of-5 Rubric Evaluation)

| Ứng viên | Bám sát phạm vi (30đ) | Bằng chứng thực tế từ Codebase (30đ) | Phân tích Đánh đổi & Pháp lý (20đ) | Tính khả thi & Handoff (20đ) | Tổng điểm | Nhận xét thẩm định |
|---|---|---|---|---|---|---|
| **Candidate 1** | 29/30 | 26/30 | 19/20 | 19/20 | **93/100** | Cấu trúc 3 lớp rõ ràng, phát hiện rủi ro middleware với `/sitemap.xml`. |
| **Candidate 2** | 30/30 | 28/30 | 19/20 | 19/20 | **96/100** | Liên kết chặt số liệu `spread_bps` (2.7 bps, `$810/yr`) từ `ArbitrageFinder.tsx` và `stitch-terminal-data.ts`. |
| **Candidate 3** | 30/30 | 29/30 | 19/20 | 19/20 | **97/100** | Phát hiện các class `brand-*` trên `landing/page.tsx` và `deals/page.tsx` không tồn tại trong `tailwind.config.js`. |
| **Candidate 4** | 30/30 | 28/30 | 19/20 | 19/20 | **96/100** | Chỉ rõ lỗi gọi sai namespace `t('nav.login')` và lỗi ép kiểu `as unknown` trong `landing/page.tsx`, cùng dữ liệu `ftx` còn sót. |
| **Candidate 5 (Winner)** | **30/30** | **30/30** | **20/20** | **20/20** | **100/100** | Phát hiện đầy đủ: (1) `vi.json` đang chứa tiếng Anh copy-trading cũ, (2) lỗi `brand-*` & `as unknown` trên `landing/page.tsx`, (3) `ftx` còn sót và thiếu `kucoin` trên `deals`, (4) `sitemap.ts` hiện tại đang làm lộ `/admin/*` và `/dashboard/*` ra public XML và thiếu `robots.ts` + `alternates.languages`, (5) các lệnh `console.error` còn sót trong `deals`. |

---

## 2. Nhận Định Cốt Lõi (Verdict)

Định vị **Institutional Quant-First** (Thu hồi phí giao dịch theo điểm cơ bản `bps`, Bảo mật Zero-Secret API Key ID trên 4 sàn Binance/Bybit/OKX/KuCoin, và Mạng lưới Thanh khoản Đa tầng `30% / 10% / 5%` quyết toán bằng Stellar USDC) là bước đi chính xác tuyệt đối để đồng bộ bề mặt sản phẩm với lõi hạ tầng đã vận hành trên Cloudflare Production.

5 điểm lệch pha trong mã nguồn sẽ được xử lý triệt để:
1. **Bản địa hóa & Thông điệp (`src/i18n/messages/vi.json`, `en.json`):** Dịch 100% các chuỗi tiếng Anh còn sót trong `vi.json` sang tiếng Việt chuẩn thuật ngữ định lượng; thay thế hoàn toàn thông điệp "Copy the best traders" bằng **Basis-Point (`bps`) Fee Recovery**, **Zero-Secret API Key ID Verification**, và **30%/10%/5% Multi-Tier Liquidity Desk**.
2. **Giao diện Obsidian Quant (`landing/page.tsx`, `deals/*`):** Chuyển đổi nền sáng (`from-brand-50`, `bg-gray-50`, `bg-white`) và các class `brand-*` không tồn tại sang hệ token `stitch-*` (`bg-stitch-canvas` `#020617`, `bg-stitch-surface` `#0F172A`, `border-stitch-divider` `#334155`); sửa lỗi gọi `t()` trên `landing/page.tsx`; thay thế `ftx` bằng `kucoin`.
3. **Làm sạch Sitemap, Robots & JSON-LD (`sitemap.ts`, `robots.ts`, `layout.tsx`):** Loại bỏ toàn bộ `/admin/*` và `/dashboard/*` khỏi `sitemap.ts`; bổ sung `/[locale]/terminal`, `/[locale]/insights`, và 3 bài viết `/[locale]/insights/[slug]` kèm `alternates.languages`; tạo `robots.ts` chặn `/admin` và `/api`; nhúng JSON-LD (`Organization`, `WebSite`, `SoftwareApplication`).
4. **Trung tâm Nghiên cứu Định lượng (`/[locale]/insights`):** Xây dựng kho dữ liệu tĩnh có kiểu nghiêm ngặt `src/data/quant-insights.ts` cùng 2 route `src/app/[locale]/insights/page.tsx` và `src/app/[locale]/insights/[slug]/page.tsx` với 3 bài nghiên cứu học thuật song ngữ Việt - Anh.
5. **Bộ 5 Tài liệu Chiến dịch Marketing & KOL Kit (`docs/marketing/`):** Xuất bản trọn bộ 5 tài liệu song ngữ sẵn sàng triển khai (Playbook GTM, Social Launch Kit, KOL Partner Kit 30/10/5%, Chuỗi 5 Email Onboarding, và Lịch Biên tập SEO 90 ngày).

---

## 3. Unresolved Questions

- `None` — Toàn bộ quyết định kiến trúc và phạm vi đã được xác nhận.
