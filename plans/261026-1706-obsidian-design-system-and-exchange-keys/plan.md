---
title: "Full-Stack Obsidian Design System (Web + Mobile) & Self-Service Exchange API Key Linking UI"
status: in_progress
created_at: 2026-10-26
branch: feat/obsidian-design-system-and-exchange-keys
mode: official
---

# Plan: Full-Stack Obsidian Design System & Self-Service Exchange API Key Linking UI

## 1. Context & Objective
Triển khai kiến trúc **Zero-Dependency Obsidian Token Contract** đồng bộ giữa Web (`minhlongs/apex-os`) và Mobile (`minhlongs/apex-os-mobile`), đạt chuẩn độ tương phản **WCAG 2.1 AA** (`textMuted: '#94A3B8'` >= 4.5:1 trên nền tối `#020617` và `#0F172A`), nâng cấp toàn bộ giao diện User Dashboard sang Obsidian Dark Mode, và xây dựng giao diện Quản lý Khóa API Sàn Tự phục vụ (`ExchangeKeysManager` trên Web và `ExchangeKeysCard` trên Mobile) kết nối trực tiếp với `/api/profile/exchange-keys`.

## 2. Requirements & Scope Boundary
- **In Scope:**
  1. Isomorphic Obsidian Token Contract (`src/lib/theme/obsidian-tokens.ts` trên Web và `src/theme/tokens.ts` trên Mobile) + Unit Test kiểm chứng Parity & WCAG AA (`src/__tests__/theme/obsidian-tokens-parity.test.ts`).
  2. Cập nhật `tailwind.config.js` (`stitch.muted: '#94A3B8'`) và toàn bộ hệ thống User Dashboard (`dashboard-layout.tsx`, `dashboard-header.tsx`, `dashboard-sidebar.tsx`, `dashboard-overview.tsx`, `affiliates-client.tsx`, `conversions-client.tsx`, `payouts-client.tsx`, `NotificationPreferences.tsx`, `DataTable.tsx`) sang phong cách Obsidian Dark.
  3. Sửa lỗi điều hướng thiếu `locale` trong `dashboard-sidebar.tsx` và tạo route mới `/[locale]/dashboard/profile/page.tsx`.
  4. Xây dựng `ExchangeKeysManager.tsx` (Web) song ngữ VI/EN với 5 trạng thái phản hồi (Loading, Unlinked, Linked, 400 Format Error, 409 Conflict Error) + Zero-Secret Security Notice, nhúng vào cả 2 nhánh của `dashboard-overview.tsx` và trang `dashboard/profile`.
  5. Mở rộng `endpoints.profile.exchangeKeys` (`list`, `link`, `unlink`) trên Mobile, tạo `ExchangeKeysCard.tsx`, và đồng bộ `obsidianTokens` trên `ProfileScreen.tsx`, `DashboardScreen.tsx`, `AffiliateDashboardScreen.tsx`, `WalletConnect.tsx`.
- **Out of Scope (Non-Goals):**
  - Không thay đổi các trang quản trị `/admin/*`.
  - Không sửa đổi database schema D1 (`profiles.external_ids` đã hoạt động trên production).
  - Không cài đặt thêm thư viện UI bên thứ ba (Tamagui, NativeWind v4, Gluestack).
  - Không thu thập Secret Key hoặc Passphrase (chỉ thu thập `api_key_id` định danh công khai).

## 3. Phases & Tasks

### Phase 1: Isomorphic Obsidian Token Contract & Parity/WCAG Tests
- **Files:**
  - `/Users/macbook/apex-os/src/lib/theme/obsidian-tokens.ts` (New)
  - `/Users/macbook/apex-os/tailwind.config.js` (Update `stitch.muted` -> `#94A3B8`)
  - `/Users/macbook/apex-os/apex-os-mobile/src/theme/tokens.ts` (Add `obsidianTokens`, preserve `colors`)
  - `/Users/macbook/apex-os/src/__tests__/theme/obsidian-tokens-parity.test.ts` (New)
- **Validation:**
  - `obsidianTokens` khớp 100% mã màu giữa Web và Mobile.
  - Tỷ lệ tương phản WCAG 2.1 AA của `textPrimary` (`#F8FAFC`) và `textMuted` (`#94A3B8`) trên `canvas` (`#020617`) và `surface` (`#0F172A`) đều đạt `>= 4.5:1`.
  - Bài kiểm thử cũ `apex-os-mobile/__tests__/theme/tokens.test.ts` tiếp tục PASS 100%.

### Phase 2: Web ExchangeKeysManager & Profile Sub-route
- **Files:**
  - `/Users/macbook/apex-os/src/components/profile/ExchangeKeysManager.tsx` (New)
  - `/Users/macbook/apex-os/src/app/[locale]/dashboard/profile/page.tsx` (New)
  - `/Users/macbook/apex-os/src/__tests__/components/exchange-keys-manager.test.tsx` (New)
- **Validation:**
  - Hỗ trợ 4 sàn (`okx`, `kucoin`, `binance`, `bybit`), kiểm tra regex `/^[A-Za-z0-9_-]{6,128}$/` tức thì phía client.
  - Hiển thị đầy đủ 5 trạng thái phản hồi (Skeleton, Unlinked, Linked, 400 Bad Request, 409 Conflict) song ngữ VI/EN.
  - Cập nhật state trực tiếp từ response `data.external_ids` của `POST` và `DELETE`.

### Phase 3: Web Dashboard Obsidian Dark Transformation
- **Files:**
  - `/Users/macbook/apex-os/src/components/dashboard/dashboard-layout.tsx`
  - `/Users/macbook/apex-os/src/components/dashboard/dashboard-header.tsx`
  - `/Users/macbook/apex-os/src/components/dashboard/dashboard-sidebar.tsx`
  - `/Users/macbook/apex-os/src/components/dashboard/DataTable.tsx`
  - `/Users/macbook/apex-os/src/app/[locale]/dashboard/dashboard-overview.tsx`
  - `/Users/macbook/apex-os/src/app/[locale]/dashboard/affiliates/page.tsx`
  - `/Users/macbook/apex-os/src/app/[locale]/dashboard/affiliates/affiliates-client.tsx`
  - `/Users/macbook/apex-os/src/app/[locale]/dashboard/conversions/page.tsx`
  - `/Users/macbook/apex-os/src/app/[locale]/dashboard/conversions/conversions-client.tsx`
  - `/Users/macbook/apex-os/src/app/[locale]/dashboard/payouts/page.tsx`
  - `/Users/macbook/apex-os/src/app/[locale]/dashboard/payouts/payouts-client.tsx`
  - `/Users/macbook/apex-os/src/app/[locale]/dashboard/settings/notifications/page.tsx`
  - `/Users/macbook/apex-os/src/components/dashboard/NotificationPreferences.tsx`
- **Validation:**
  - Không còn `from-blue-50 to-indigo-100` hay `bg-white` lạc lõng trong User Dashboard.
  - `DashboardSidebar` tự động gắn tiền tố `/${locale}/dashboard/...`.
  - `ExchangeKeysManager` xuất hiện ở cả 2 nhánh của `dashboard-overview.tsx` (user mới `total_clicks === 0` và affiliate đang hoạt động).
  - Loại bỏ toàn bộ `:any` và `console.error`/`console.log` trong các file dashboard được chạm tới.

### Phase 4: Mobile Obsidian Sync & ExchangeKeysCard
- **Files:**
  - `/Users/macbook/apex-os/apex-os-mobile/src/api/endpoints.ts`
  - `/Users/macbook/apex-os/apex-os-mobile/src/components/ExchangeKeysCard.tsx` (New)
  - `/Users/macbook/apex-os/apex-os-mobile/src/screens/ProfileScreen.tsx`
  - `/Users/macbook/apex-os/apex-os-mobile/src/screens/DashboardScreen.tsx`
  - `/Users/macbook/apex-os/apex-os-mobile/src/screens/AffiliateDashboardScreen.tsx`
  - `/Users/macbook/apex-os/apex-os-mobile/src/components/WalletConnect.tsx`
  - `/Users/macbook/apex-os/apex-os-mobile/__tests__/exchange-keys-and-obsidian.test.ts` (New)
- **Validation:**
  - `endpoints.profile.exchangeKeys` hỗ trợ `list`, `link`, `unlink`.
  - `ExchangeKeysCard` tích hợp vào `ProfileScreen.tsx`, xử lý lỗi `400` và `409` song ngữ VI/EN.
  - Toàn bộ Vitest suite trên Mobile và Jest suite trên Web vượt qua 100%.

## 4. Acceptance Criteria
1. `obsidianTokens` đồng nhất giữa Web và Mobile; bài test `obsidian-tokens-parity.test.ts` chứng minh tỷ lệ tương phản WCAG 2.1 AA >= 4.5:1.
2. Toàn bộ trang User Dashboard trên Web chuyển sang Obsidian Dark Mode, sidebar links có `/${locale}`, trang `/[locale]/dashboard/profile` hoạt động.
3. `ExchangeKeysManager` (Web) và `ExchangeKeysCard` (Mobile) kết nối `/api/profile/exchange-keys` với đầy đủ 5 trạng thái và thông báo Zero-Secret.
4. `0 :any`, `0 console.log`, `npm test` & `npm run build` (Web Node 26) và `npx vitest run` (Mobile) PASS 100%.
