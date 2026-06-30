# ApexOS Icon System

Hệ thống icon SVG cho ứng dụng ApexOS, được thiết kế theo phong cách outlined với kích thước 24x24px.

## 📁 Cấu trúc Files

```
design/icons/
├── navigation.svg    # Icon điều hướng (9 icons)
├── actions.svg       # Icon hành động (14 icons)
├── status.svg        # Icon trạng thái (8 icons)
├── crypto.svg        # Icon crypto/blockchain (8 icons)
├── communication.svg # Icon liên lạc (7 icons)
├── affiliate.svg     # Icon affiliate system (8 icons)
├── icon-font.css     # CSS classes
└── README.md         # Tài liệu này
```

## 🎨 Style Guidelines

- **Loại**: Outlined style
- **ViewBox**: 24x24
- **Stroke width**: 2px
- **Màu chính**: `#6366F1` (Indigo)
- **Line cap**: `round`
- **Line join**: `round`
- **Reference**: [Lucide React](https://lucide.dev/)

## 📋 Danh sách Icons

### Navigation (Điều hướng)
| Icon ID | Tên | Mô tả |
|---------|-----|-------|
| `dashboard` | Dashboard | Bảng điều khiển |
| `deals` | Deals | Giao dịch |
| `affiliates` | Affiliates | Đối tác liên kết |
| `payouts` | Payouts | Thanh toán |
| `profile` | Profile | Hồ sơ người dùng |
| `settings` | Settings | Cài đặt |
| `analytics` | Analytics | Phân tích |
| `health` | Health | Sức khỏe hệ thống |
| `alerts` | Alerts | Thông báo |

### Actions (Hành động)
| Icon ID | Tên | Mô tả |
|---------|-----|-------|
| `add` | Add | Thêm mới |
| `edit` | Edit | Chỉnh sửa |
| `delete` | Delete | Xóa |
| `save` | Save | Lưu |
| `cancel` | Cancel | Hủy |
| `confirm` | Confirm | Xác nhận |
| `refresh` | Refresh | Làm mới |
| `download` | Download | Tải xuống |
| `upload` | Upload | Tải lên |
| `share` | Share | Chia sẻ |
| `copy` | Copy | Sao chép |
| `search` | Search | Tìm kiếm |
| `filter` | Filter | Lọc |
| `sort` | Sort | Sắp xếp |

### Status (Trạng thái)
| Icon ID | Tên | Mô tả |
|---------|-----|-------|
| `success` | Success | Thành công |
| `warning` | Warning | Cảnh báo |
| `error` | Error | Lỗi |
| `info` | Info | Thông tin |
| `loading` | Loading | Đang tải |
| `pending` | Pending | Chờ xử lý |
| `active` | Active | Hoạt động |
| `inactive` | Inactive | Không hoạt động |

### Crypto (Tiền điện tử)
| Icon ID | Tên | Mô tả |
|---------|-----|-------|
| `wallet` | Wallet | Ví tiền |
| `coin` | Coin | Đồng tiền |
| `chart` | Chart | Biểu đồ |
| `transaction` | Transaction | Giao dịch |
| `exchange` | Exchange | Trao đổi |
| `stellar` | Stellar | Stellar |
| `usdc` | USDC | USDC |
| `blockchain` | Blockchain | Blockchain |

### Communication (Liên lạc)
| Icon ID | Tên | Mô tả |
|---------|-----|-------|
| `email` | Email | Email |
| `slack` | Slack | Slack |
| `telegram` | Telegram | Telegram |
| `webhook` | Webhook | Webhook |
| `notification` | Notification | Thông báo |
| `bell` | Bell | Chuông |
| `message` | Message | Tin nhắn |

### Affiliate (Hệ thống liên kết)
| Icon ID | Tên | Mô tả |
|---------|-----|-------|
| `users` | Users | Người dùng |
| `user-plus` | UserPlus | Thêm người dùng |
| `link` | Link | Liên kết |
| `referral` | Referral | Giới thiệu |
| `tree` | Tree | Cây cấu trúc |
| `commission` | Commission | Hoa hồng |
| `earnings` | Earnings | Thu nhập |
| `payout` | Payout | Thanh toán |

## 🚀 Cách sử dụng

### 1. CSS Background Image

```html
<!-- Base usage -->
<i class="icon icon-dashboard"></i>

<!-- Với size variants -->
<i class="icon icon-dashboard icon-lg"></i>
<i class="icon icon-add icon-sm"></i>

<!-- Với color variants -->
<i class="icon icon-success icon-md icon-primary"></i>
```

### 2. React Component

```tsx
// Icon.tsx
import React from 'react';
import './icon-font.css';

interface IconProps {
  name: keyof typeof iconNames;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const iconNames = {
  // Navigation
  dashboard: 'icon-dashboard',
  deals: 'icon-deals',
  affiliates: 'icon-affiliates',
  payouts: 'icon-payouts',
  profile: 'icon-profile',
  settings: 'icon-settings',
  analytics: 'icon-analytics',
  health: 'icon-health',
  alerts: 'icon-alerts',
  // ... thêm các icon khác
} as const;

export const Icon: React.FC<IconProps> = ({
  name,
  size = 'md',
  className = ''
}) => {
  const iconClass = iconNames[name];
  return (
    <i
      className={`icon ${iconClass} icon-${size} ${className}`}
      aria-hidden="true"
    />
  );
};

// Cách dùng
<Icon name="dashboard" size="lg" />
<Icon name="add" />
<Icon name="success" className="text-green-500" />
```

### 3. Inline SVG (Khi cần customize)

```tsx
const CustomIcon = ({ color = '#6366F1' }) => (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* Copy từ file SVG tương ứng */}
  </svg>
);
```

## 🎯 Naming Conventions

- **CSS Class**: `icon-<tên-icon>` (kebab-case)
- **Size**: `icon-sm`, `icon-md`, `icon-lg`, `icon-xl`
- **Color**: `icon-primary`, `icon-secondary`, `icon-success`, `icon-warning`, `icon-error`
- **React prop**: PascalCase cho TypeScript type safety

## 📐 Kích thước

| Size | Class | Width | Height |
|------|-------|-------|--------|
| Small | `icon-sm` | 16px | 16px |
| Medium | `icon-md` | 24px | 24px |
| Large | `icon-lg` | 32px | 32px |
| Extra Large | `icon-xl` | 48px | 48px |

## 🔧 Tailwind Integration

```tsx
// Với Tailwind CSS
<button className="flex items-center gap-2">
  <i className="icon icon-add icon-md" />
  <span>Thêm mới</span>
</button>

// Custom color
<button className="text-red-500">
  <i className="icon icon-delete icon-md" style={{ filter: 'currentColor' }} />
</button>
```

## 📝 Notes

- Icons sử dụng `stroke` thay vì `fill` cho style outlined
- Màu mặc định là `#6366F1`, có thể override qua CSS custom properties
- SVG backgrounds được reference qua fragment identifier (`#icon-id`)
- Đảm bảo icon alignment với `vertical-align: middle`

## 📄 License

Part of ApexOS project.
