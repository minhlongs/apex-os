# ApexOS Design Tokens

Hệ thống design token chính thức cho ApexOS — Fintech / Crypto Cashback Platform. Tokens được định nghĩa dưới dạng CSS custom properties, tương thích với Next.js 16 + Tailwind CSS 3.4 + next-intl.

## Cấu trúc thư mục

```
design/tokens/
├── index.css          # Entry point — import tất cả tokens + @theme block
├── colors.css         # Brand palette, semantic colors, gradients, glows
├── typography.css     # Font families, type scale, semantic text tokens
├── spacing.css        # Spacing scale (4px base), border radius
├── shadows.css        # Elevation shadows, glow effects, dark mode
└── README.md          # Tài liệu này
```

## Cài đặt

### Bước 1: Import tokens vào global CSS

Thêm dòng này vào file CSS gốc của ứng dụng (ví dụ: `src/styles/globals.css` hoặc `src/app/globals.css`):

```css
@import '../design/tokens/index.css';
```

### Bước 2: Cấu hình Tailwind CSS 3.4

Mở `tailwind.config.js` và thêm các paths vào `content` array nếu chưa có:

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{ts,tsx}',
    './design/**/*.css',  // thêm dòng này để Tailwind quét design tokens
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Brand colors — map trực tiếp từ CSS variables
        primary: {
          50:  'var(--color-primary-50)',
          100: 'var(--color-primary-100)',
          200: 'var(--color-primary-200)',
          300: 'var(--color-primary-300)',
          400: 'var(--color-primary-400)',
          500: 'var(--color-primary-500)',
          600: 'var(--color-primary-600)',
          700: 'var(--color-primary-700)',
          800: 'var(--color-primary-800)',
          900: 'var(--color-primary-900)',
          950: 'var(--color-primary-950)',
        },
        secondary: {
          50:  'var(--color-secondary-50)',
          100: 'var(--color-secondary-100)',
          200: 'var(--color-secondary-200)',
          300: 'var(--color-secondary-300)',
          400: 'var(--color-secondary-400)',
          500: 'var(--color-secondary-500)',
          600: 'var(--color-secondary-600)',
          700: 'var(--color-secondary-700)',
          800: 'var(--color-secondary-800)',
          900: 'var(--color-secondary-900)',
          950: 'var(--color-secondary-950)',
        },
        accent: {
          50:  'var(--color-accent-50)',
          100: 'var(--color-accent-100)',
          200: 'var(--color-accent-200)',
          300: 'var(--color-accent-300)',
          400: 'var(--color-accent-400)',
          500: 'var(--color-accent-500)',
          600: 'var(--color-accent-600)',
          700: 'var(--color-accent-700)',
          800: 'var(--color-accent-800)',
          900: 'var(--color-accent-900)',
          950: 'var(--color-accent-950)',
        },
        // Semantic colors
        success: {
          50:  'var(--color-success-50)',
          100: 'var(--color-success-100)',
          200: 'var(--color-success-200)',
          300: 'var(--color-success-300)',
          400: 'var(--color-success-400)',
          500: 'var(--color-success-500)',
          600: 'var(--color-success-600)',
          700: 'var(--color-success-700)',
          800: 'var(--color-success-800)',
          900: 'var(--color-success-900)',
          950: 'var(--color-success-950)',
        },
        warning: {
          50:  'var(--color-warning-50)',
          100: 'var(--color-warning-100)',
          200: 'var(--color-warning-200)',
          300: 'var(--color-warning-300)',
          400: 'var(--color-warning-400)',
          500: 'var(--color-warning-500)',
          600: 'var(--color-warning-600)',
          700: 'var(--color-warning-700)',
          800: 'var(--color-warning-800)',
          900: 'var(--color-warning-900)',
          950: 'var(--color-warning-950)',
        },
        error: {
          50:  'var(--color-error-50)',
          100: 'var(--color-error-100)',
          200: 'var(--color-error-200)',
          300: 'var(--color-error-300)',
          400: 'var(--color-error-400)',
          500: 'var(--color-error-500)',
          600: 'var(--color-error-600)',
          700: 'var(--color-error-700)',
          800: 'var(--color-error-800)',
          900: 'var(--color-error-900)',
          950: 'var(--color-error-950)',
        },
        info: {
          50:  'var(--color-info-50)',
          100: 'var(--color-info-100)',
          200: 'var(--color-info-200)',
          300: 'var(--color-info-300)',
          400: 'var(--color-info-400)',
          500: 'var(--color-info-500)',
          600: 'var(--color-info-600)',
          700: 'var(--color-info-700)',
          800: 'var(--color-info-800)',
          900: 'var(--color-info-900)',
          950: 'var(--color-info-950)',
        },
        neutral: {
          50:  'var(--color-neutral-50)',
          100: 'var(--color-neutral-100)',
          200: 'var(--color-neutral-200)',
          300: 'var(--color-neutral-300)',
          400: 'var(--color-neutral-400)',
          500: 'var(--color-neutral-500)',
          600: 'var(--color-neutral-600)',
          700: 'var(--color-neutral-700)',
          800: 'var(--color-neutral-800)',
          900: 'var(--color-neutral-900)',
          950: 'var(--color-neutral-950)',
        },
        // Semantic surface tokens
        bg: {
          primary:   'var(--color-bg-primary)',
          secondary: 'var(--color-bg-secondary)',
          tertiary:  'var(--color-bg-tertiary)',
          inverse:   'var(--color-bg-inverse)',
          elevated:  'var(--color-bg-elevated)',
        },
        text: {
          primary:   'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          tertiary:  'var(--color-text-tertiary)',
          inverse:   'var(--color-text-inverse)',
        },
        border: {
          default: 'var(--color-border-default)',
          subtle:  'var(--color-border-subtle)',
          strong:  'var(--color-border-strong)',
          focus:   'var(--color-border-focus)',
        },
        // Fintech-specific
        earnings: {
          positive: 'var(--color-earnings-positive)',
          negative: 'var(--color-earnings-negative)',
          pending:  'var(--color-earnings-pending)',
        },
        cashback: {
          DEFAULT: 'var(--color-cashback-highlight)',
        },
        commission: {
          tier1: 'var(--color-commission-tier1)',
          tier2: 'var(--color-commission-tier2)',
          tier3: 'var(--color-commission-tier3)',
        },
      },
      fontFamily: {
        sans:      'var(--font-family-sans)',
        display:   'var(--font-family-display)',
        mono:      'var(--font-family-mono)',
        numeric:   'var(--font-family-numeric)',
      },
      fontSize: {
        xs:   'var(--font-size-xs)',
        sm:   'var(--font-size-sm)',
        base: 'var(--font-size-base)',
        lg:   'var(--font-size-lg)',
        xl:   'var(--font-size-xl)',
        '2xl': 'var(--font-size-2xl)',
        '3xl': 'var(--font-size-3xl)',
        '4xl': 'var(--font-size-4xl)',
        '5xl': 'var(--font-size-5xl)',
        '6xl': 'var(--font-size-6xl)',
      },
      fontWeight: {
        normal:   'var(--font-weight-normal)',
        medium:   'var(--font-weight-medium)',
        semibold: 'var(--font-weight-semibold)',
        bold:     'var(--font-weight-bold)',
        extrabold: 'var(--font-weight-extrabold)',
      },
      lineHeight: {
        none:    'var(--line-height-none)',
        tight:   'var(--line-height-tight)',
        snug:    'var(--line-height-snug)',
        normal:  'var(--line-height-normal)',
        relaxed: 'var(--line-height-relaxed)',
        loose:   'var(--line-height-loose)',
      },
      letterSpacing: {
        tighter: 'var(--letter-spacing-tighter)',
        tight:   'var(--letter-spacing-tight)',
        normal:  'var(--letter-spacing-normal)',
        wide:    'var(--letter-spacing-wide)',
        wider:   'var(--letter-spacing-wider)',
        widest:  'var(--letter-spacing-widest)',
      },
      spacing: {
        0:  'var(--spacing-0)',
        1:  'var(--spacing-1)',
        2:  'var(--spacing-2)',
        3:  'var(--spacing-3)',
        4:  'var(--spacing-4)',
        5:  'var(--spacing-5)',
        6:  'var(--spacing-6)',
        8:  'var(--spacing-8)',
        10: 'var(--spacing-10)',
        12: 'var(--spacing-12)',
        16: 'var(--spacing-16)',
        20: 'var(--spacing-20)',
        24: 'var(--spacing-24)',
        32: 'var(--spacing-32)',
      },
      borderRadius: {
        none: 'var(--radius-none)',
        sm:   'var(--radius-sm)',
        md:   'var(--radius-md)',
        lg:   'var(--radius-lg)',
        xl:   'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        full: 'var(--radius-full)',
      },
      boxShadow: {
        xs:    'var(--shadow-xs)',
        sm:    'var(--shadow-sm)',
        md:    'var(--shadow-md)',
        lg:    'var(--shadow-lg)',
        xl:    'var(--shadow-xl)',
        '2xl': 'var(--shadow-2xl)',
        inner: 'var(--shadow-inner)',
        primary: 'var(--shadow-primary)',
        accent:  'var(--shadow-accent)',
        success: 'var(--shadow-success)',
        warning: 'var(--shadow-warning)',
        error:   'var(--shadow-error)',
      },
    },
  },
  plugins: [],
}
```

### Bước 3: Cấu hình dark mode

ApexOS dùng `class` strategy cho dark mode. Trong root layout, toggle class `.dark` trên `<html>` element:

```tsx
// src/app/[locale]/layout.tsx
<html lang={locale} className={isDark ? 'dark' : ''}>
```

## Brand Colors

| Token | Value | Usage |
|-------|-------|-------|
| Primary 500 | `#6366F1` | Brand identity, CTAs, navigation active |
| Primary 600 | `#4F46E5` | Primary hover states |
| Secondary 500 | `#8B5CF6` | Supporting actions, badges |
| Accent 500 | `#06B6D4` | Highlights, links, interactive elements |

## Semantic Colors

| Token | Value | Usage |
|-------|-------|-------|
| Success 500 | `#10B981` | Positive earnings, completed tx |
| Warning 500 | `#F59E0B` | Pending status, alerts |
| Error 500 | `#EF4444` | Failed transactions, errors |
| Info 500 | `#3B82F6` | Informational messages |

## Fintech-Specific Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--color-earnings-positive` | `#10B981` | Profit indicators |
| `--color-earnings-negative` | `#EF4444` | Loss indicators |
| `--color-earnings-pending` | `#F59E0B` | Pending earnings |
| `--color-cashback-highlight` | `#06B6D4` | Cashback amounts |
| `--color-commission-tier1` | `#6366F1` | Tier 1 commission |
| `--color-commission-tier2` | `#8B5CF6` | Tier 2 commission |
| `--color-commission-tier3` | `#A5B4FC` | Tier 3 commission |
| `--color-stellar-theme` | `#14B8A6` | Stellar branding |
| `--color-usdc` | `#2775CA` | USDC token |
| `--color-xlm` | `#14B8A6` | XLM token |

## Typography

| Token | Value | Usage |
|-------|-------|-------|
| `--font-family-sans` | Inter | Body text, UI elements |
| `--font-family-display` | Space Grotesk | Headings, hero, brand |
| `--font-family-mono` | JetBrains Mono | Addresses, hashes, code |
| `--font-size-xs` | 12px | Labels, captions |
| `--font-size-base` | 16px | Body text |
| `--font-size-2xl` | 24px | Card titles |
| `--font-size-4xl` | 36px | Page headings |
| `--font-size-5xl` | 48px | Marketing hero |

## Spacing

Base unit: 4px. Scale: 0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128px.

## Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 4px | Tags, badges |
| `--radius-md` | 6px | Inputs |
| `--radius-lg` | 8px | Buttons, dropdowns |
| `--radius-xl` | 12px | Cards, modals |
| `--radius-2xl` | 16px | Large modals |
| `--radius-full` | 9999px | Pills, avatars |

## Shadows

| Token | Elevation | Usage |
|-------|-----------|-------|
| `--shadow-xs` | Level 0 | Flat elements |
| `--shadow-sm` | Level 1 | Inputs, small cards |
| `--shadow-md` | Level 2 | Cards, dropdowns |
| `--shadow-lg` | Level 3 | Modals, popovers |
| `--shadow-xl` | Level 4 | Floating panels |
| `--shadow-2xl` | Level 5 | Sticky headers |

## Ví dụ sử dụng

### Trong React Component (Tailwind classes)

```tsx
// Card với primary border và shadow
<div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-xl shadow-sm p-6">
  <h2 className="font-display text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
    Earnings Overview
  </h2>
  <p className="text-success-500 font-numeric text-lg">
    +$1,234.56
  </p>
</div>
```

### Trong CSS trực tiếp

```css
.custom-button {
  background: var(--gradient-primary);
  color: var(--color-text-on-primary);
  border-radius: var(--radius-lg);
  padding: var(--space-2) var(--space-4);
  font-family: var(--font-family-sans);
  font-weight: var(--font-weight-semibold);
  box-shadow: var(--shadow-primary);
  transition: box-shadow var(--duration-fast) var(--ease-default);
}

.custom-button:hover {
  box-shadow: var(--shadow-primary-lg);
}

/* Dark mode glow effect */
.dark .custom-button:focus-visible {
  box-shadow: var(--glow-primary);
}
```

### Trong React Component (CSS variables)

```tsx
<div style={{
  background: 'var(--gradient-hero)',
  borderRadius: 'var(--radius-2xl)',
  padding: 'var(--space-12)',
  boxShadow: 'var(--shadow-xl)',
}}>
  <h1 style={{
    fontFamily: 'var(--font-family-display)',
    fontSize: 'var(--font-size-5xl)',
    fontWeight: 'var(--font-weight-extrabold)',
    color: 'var(--color-text-primary)',
  }}>
    ApexOS
  </h1>
</div>
```

### Dark mode toggle

```tsx
'use client';
import { useEffect } from 'react';

export function useDarkMode() {
  useEffect(() => {
    const root = document.documentElement;
    const isDark = localStorage.getItem('theme') === 'dark';
    if (isDark) root.classList.add('dark');
  }, []);
}
```

## Nâng cấp lên Tailwind CSS v4

Khi nâng cấp lên Tailwind v4, file `index.css` đã chứa `@theme` block hoàn chỉnh. Chỉ cần:

1. Cài `tailwindcss@^4.0`
2. Xóa `tailwind.config.js` (v4 dùng CSS-first config)
3. Đảm bảo `@import '../design/tokens/index.css'` được load trước các utility classes
4. Tất cả token đã được map sẵn — không cần config thêm

## Tương thích

- **Next.js 16.2.6** — hoàn toàn tương thích
- **Tailwind CSS 3.4.19** — dùng `tailwind.config.js` extend
- **next-intl 4.12** — tokens không xung đột với i18n (CSS-only, không phụ thuộc locale)
- **Dark mode** — dùng `class` strategy, tokens tự động switch qua `.dark` selector
- **TypeScript** — tokens là CSS custom properties, dùng `as const` để type-safe

## Lưu ý

- Tokens dùng chữ thường với dấu gạch nối (kebab-case) theo convention CSS
- Semantic tokens (`--color-bg-primary`, `--color-text-secondary`) là abstractions — thay đổi giá trị ở `.dark` block để switch theme
- Gradients được định nghĩa như CSS variables — dùng trực tiếp trong `background` property
- Glow effects chỉ hiệu quả trong dark mode; trong light mode có thể dùng colored shadows thay thế
