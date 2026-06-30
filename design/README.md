# ApexOS Design Package — Tổng quan

Gói thiết kế toàn diện cho ApexOS, bao gồm design tokens, icon system, banner assets, và Corporate Identity Program (CIP).

**Version:** 1.0.0
**Release Date:** 2026-06-23
**Brand:** ApexOS — Global Crypto Cashback + Affiliate Hub

---

## 📦 Package Structure

```
design/
├── README.md                    # Tài liệu này — Comprehensive design package summary
├── package.json                 # Metadata và asset inventory
│
├── tokens/                      # Design Tokens (CSS custom properties)
│   ├── colors.css               # Bảng màu toàn diện (primary, semantic, neutral)
│   ├── typography.css           # Typography scale, font families, weights
│   ├── spacing.css              # Spacing scale và semantic tokens
│   ├── shadows.css              # Elevation shadows, glows, effects
│   ├── index.css                # Import tất cả tokens (main entry point)
│   └── README.md                # Token documentation
│
├── icons/                       # SVG Icon System
│   ├── navigation.svg           # 9 icons: dashboard, deals, affiliates, payouts...
│   ├── actions.svg              # 14 icons: add, edit, delete, save, etc.
│   ├── status.svg               # 8 icons: success, warning, error, info...
│   ├── crypto.svg               # 8 icons: wallet, coin, stellar, usdc...
│   ├── communication.svg        # 7 icons: email, slack, telegram, webhook...
│   ├── affiliate.svg            # 8 icons: users, link, referral, commission...
│   ├── icon-font.css            # CSS classes cho SVG icons
│   ├── icon-types.ts            # TypeScript definitions và metadata
│   └── README.md                # Icon usage guide
│
├── banners/                     # Banner Assets (HTML templates)
│   ├── hero-banner.html         # 1920×600px — Landing page hero
│   ├── og-image.html            # 1200×630px — Open Graph sharing
│   ├── twitter-header.html      # 1500×500px — Twitter/X header
│   ├── email-header.html        # 600×200px — Email newsletter header
│   └── README.md                # Export instructions và usage
│
├── cip/                         # Corporate Identity Program
│   ├── business-card.html       # 1050×600px (3.5×2" @ 300dpi)
│   ├── letterhead.html          # 2480×3508px (A4 @ 300dpi)
│   ├── email-signature.html     # 600×200px (responsive)
│   ├── social-profile-kit.html  # Social media templates
│   └── README.md                # CIP usage và print specs
│
├── logo-brief.md                # Logo design brief — concepts, colors, guidelines
└── logo-specs.md                # Logo specifications — usage, clear space, sizes
```

---

## 📋 File Inventory & Sizes

| File | Size (bytes) | Category |
|------|--------------|----------|
| cip-brand-identity-program.md | 27,807 | Documentation |
| logo-brief.md | 16,534 | Brand Guidelines |
| design/README.md | 15,280 | Documentation |
| hero-banner.html | 14,015 | Banners |
| design/tokens/index.css | 10,727 | Tokens |
| og-image.html | 8,479 | Banners |
| tokens/colors.css | 8,441 | Tokens |
| twitter-header.html | 8,083 | Banners |
| icons/icon-font.css | 7,946 | Icons |
| icons/navigation.svg | 7,742 | Icons |
| email-signature.html | 7,723 | Banners |
| cip/social-profile-kit.html | 7,395 | Banners |
| icons/icon-types.ts | 7,301 | Icons |
| tokens/typography.css | 7,139 | Tokens |
| email-header.html | 6,749 | Banners |
| banners/README.md | 6,235 | Documentation |
| tokens/shadows.css | 6,054 | Tokens |
| cip/letterhead.html | 5,344 | Banners |
| tokens/spacing.css | 4,485 | Tokens |
| logo-specs.md | 4,432 | Brand Guidelines |
| icons/actions.svg | 3,412 | Icons |
| cip/business-card.html | 3,335 | Banners |
| icons/README.md | 2,833 | Documentation |
| icons/communication.svg | 2,747 | Icons |
| icons/crypto.svg | 2,343 | Icons |
| icons/affiliate.svg | 1,832 | Icons |
| icons/status.svg | 1,698 | Icons |

**Total Package Size:** ~155KB (tr compressed)

---

## 🎨 Color Palette Reference

### Primary Brand Colors

**Indigo (Primary)** — `#6366F1`
- Brand identity, CTAs, navigation
- Scale: 50–950 (11 shades: #eef2ff → #1e1b4b)

**Violet (Secondary)** — `#8B5CF6`
- Supporting actions, badges, emphasis
- Scale: 50–950 (11 shades: #f5f3ff → #2e1065)

**Cyan (Accent)** — `#06B6D4`
- Highlights, links, interactive elements
- Scale: 50–950 (11 shades: #ecfeff → #083344)

### Semantic Colors

| Name | Hex | Usage |
|------|-----|-------|
| **Success (Emerald)** | `#10B981` | Positive earnings, completed transactions, success states |
| **Warning (Amber)** | `#F59E0B` | Pending status, alerts, caution |
| **Error (Red)** | `#EF4444` | Failed transactions, errors, destructive actions |
| **Info (Blue)** | `#3B82F6` | Informational messages, hints |

### Neutral Scale (Slate)

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-neutral-50` | `#F8FAFC` | Lightest background |
| `--color-neutral-100` | `#F1F5F9` | Card backgrounds (light) |
| `--color-neutral-200` | `#E2E8F0` | Borders, dividers |
| `--color-neutral-300` | `#CBD5E1` | Subtle borders |
| `--color-neutral-400` | `#94A3B8` | Disabled text, secondary borders |
| `--color-neutral-500` | `#64748B` | Secondary text |
| `--color-neutral-600` | `#475569` | Text labels |
| `--color-neutral-700` | `#334155` | Headings |
| `--color-neutral-800` | `#1E293B` | Dark backgrounds |
| `--color-neutral-900` | `#0F172A` | Darkest text, primary dark bg |
| `--color-neutral-950` | `#020617` | Deepest dark (night sky) |

### Fintech-Specific Colors

- `--color-earnings-positive`: `#10B981` (USDC earnings)
- `--color-earnings-negative`: `#EF4444` (losses)
- `--color-earnings-pending`: `#F59E0B` (pending)
- `--color-cashback-highlight`: `#06B6D4` (cashback highlights)
- `--color-commission-tier1`: `#6366F1` (30% tier)
- `--color-commission-tier2`: `#8B5CF6` (10% tier)
- `--color-commission-tier3`: `#A5B4FC` (5% tier)
- `--color-stellar-theme`: `#14B8A6` (Stellar network)
- `--color-usdc`: `#2775CA` (USDC stablecoin)
- `--color-xlm`: `#14B8A6` (XLM native)

### Gradients

```css
--gradient-primary: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%);
--gradient-primary-hover: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
--gradient-accent: linear-gradient(135deg, #06B6D4 0%, #8B5CF6 100%);
--gradient-hero: linear-gradient(135deg, #6366F1 0%, #06B6D4 50%, #10B981 100%);
--gradient-earnings: linear-gradient(135deg, #06B6D4 0%, #6366F1 100%);
--gradient-gold: linear-gradient(135deg, #F59E0B 0%, #FBBF24 100%);
--gradient-success: linear-gradient(135deg, #10B981 0%, #34D399 100%);
```

---

## ✍️ Typography Reference

### Font Families

| Role | Font Family | Source | Usage |
|------|-------------|--------|-------|
| **Headings** | `Space Grotesk` | Google Fonts | Page titles, section headings, hero text |
| **Body/UI** | `Inter` | Google Fonts | Body text, UI elements, forms |
| **Mono** | `JetBrains Mono` | Google Fonts | Financial figures, wallet addresses, hashes |

### Type Scale

| Token | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| `--text-xs` | 12px | 400 | 1.33 (loose) | Captions, badges, tiny labels |
| `--text-sm` | 14px | 400 | 1.5 (normal) | Helper text, secondary info |
| `--text-base` | 16px | 400 | 1.5 (normal) | Body text, paragraphs |
| `--text-lg` | 18px | 400 | 1.625 (relaxed) | Lead text, card descriptions |
| `--text-xl` | 20px | 500 | 1.4 (snug) | Small headings, card titles |
| `--text-2xl` | 24px | 600 | 1.33 (snug) | Section headings, subsection titles |
| `--text-3xl` | 30px | 600 | 1.2 (tight) | Page headings, major sections |
| `--text-4xl` | 36px | 700 | 1.11 (tight) | Hero headings, marketing banners |
| `--text-5xl` | 48px | 700 | 1.17 (tight) | Display hero text |
| `--text-6xl` | 60px | 800 | 1.1 (tight) | Billboard hero, marketing pages |

### Letter Spacing

| Token | Value | Usage |
|-------|-------|-------|
| `--letter-spacing-tighter` | -0.04em | Display headings |
| `--letter-spacing-tight` | -0.02em | Headings |
| `--letter-spacing-normal` | 0 | Body text (default) |
| `--letter-spacing-wide` | 0.025em | Uppercase labels |
| `--letter-spacing-widest` | 0.1em | Tracking-wide utilities |

---

## 📐 Spacing & Layout

### Spacing Scale (4px base unit)

| Token | rem | px | Usage |
|-------|-----|----|-------|
| `--space-0` | 0 | 0 | Reset |
| `--space-1` | 0.25rem | 4px | Tight inline, icon gaps |
| `--space-2` | 0.5rem | 8px | Compact padding, input padding |
| `--space-3` | 0.75rem | 12px | Card inline padding |
| `--space-4` | 1rem | 16px | Default gap, section padding |
| `--space-5` | 1.25rem | 20px | Relaxed padding |
| `--space-6` | 1.5rem | 24px | Card padding, section gap |
| `--space-8` | 2rem | 32px | Section spacing |
| `--space-10` | 2.5rem | 40px | Large section gap |
| `--space-12` | 3rem | 48px | Page section spacing |
| `--space-16` | 4rem | 64px | Major section dividers |
| `--space-20` | 5rem | 80px | Hero spacing, page margins |
| `--space-24` | 6rem | 96px | Large vertical rhythm |
| `--space-32` | 8rem | 128px | Full-page sections |

### Semantic Spacing

```css
--spacing-nav-height: 4rem;           /* 64px navbar */
--spacing-card-padding: var(--space-4);  /* 16px */
--spacing-modal-padding: var(--space-6); /* 24px */
--spacing-form-gap: var(--space-4);      /* 16px */
--spacing-table-cell-padding-x: var(--space-4); /* 16px */
--spacing-table-cell-padding-y: var(--space-3); /* 12px */
```

---

## 🔄 Border Radius

### Radius Scale

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-none` | 0 | Sharp edges |
| `--radius-sm` | 4px | Small elements, tags |
| `--radius-md` | 6px | Inputs, small buttons |
| `--radius-lg` | 8px | Buttons, dropdowns |
| `--radius-xl` | 12px | Cards, modals |
| `--radius-2xl` | 16px | Large modals, hero cards |
| `--radius-full` | 9999px | Pills, avatars, badges |

### Semantic Radius

```css
--radius-button: var(--radius-lg);    /* 8px */
--radius-card: var(--radius-xl);      /* 12px */
--radius-input: var(--radius-md);     /* 6px */
--radius-modal: var(--radius-2xl);    /* 16px */
--radius-badge: var(--radius-full);   /* pill */
--radius-avatar: var(--radius-full);  /* circle */
```

---

## 🌓 Shadows & Elevation

### Elevation Scale (Light Mode)

| Token | Shadow |
|-------|--------|
| `--shadow-xs` | `0 1px 2px rgba(15, 23, 42, 0.04)` |
| `--shadow-sm` | `0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04)` |
| `--shadow-md` | `0 4px 6px -1px rgba(15, 23, 42, 0.07), 0 2px 4px -2px rgba(15, 23, 42, 0.05)` |
| `--shadow-lg` | `0 10px 15px -3px rgba(15, 23, 42, 0.08), 0 4px 6px -4px rgba(15, 23, 42, 0.04)` |
| `--shadow-xl` | `0 20px 25px -5px rgba(15, 23, 42, 0.08), 0 8px 10px -6px rgba(15, 23, 42, 0.04)` |
| `--shadow-2xl` | `0 25px 50px -12px rgba(15, 23, 42, 0.15)` |

### Semantic Shadows

```css
--shadow-navbar: var(--shadow-sm);
--shadow-sidebar: var(--shadow-md);
--shadow-card: var(--shadow-sm);
--shadow-card-hover: var(--shadow-md);
--shadow-dropdown: var(--shadow-lg);
--shadow-modal-backdrop: 0 0 0 1px rgba(15, 23, 42, 0.05), 0 20px 50px -12px rgba(15, 23, 42, 0.2);
--shadow-input-focus: 0 0 0 3px rgba(99, 102, 241, 0.2);
```

### Dark Mode Shadows

Dark mode automatically increases shadow opacity by 1.5x for visibility.

```css
.dark {
  --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.3);
  /* ... scaled versions */
}
```

### Glow Effects (Dark Mode)

```css
.dark {
  --glow-primary: 0 0 30px rgba(99, 102, 241, 0.5);
  --glow-accent: 0 0 30px rgba(6, 182, 212, 0.5);
  --glow-brand: 0 0 60px rgba(99, 102, 241, 0.3), 0 0 120px rgba(139, 92, 246, 0.2);
}
```

---

## 🔣 Icon System

### Total Icons: 54 across 6 categories

| Category | Count | Icons |
|----------|-------|-------|
| **Navigation** | 9 | `dashboard`, `deals`, `affiliates`, `payouts`, `profile`, `settings`, `analytics`, `health`, `alerts` |
| **Actions** | 14 | `add`, `edit`, `delete`, `save`, `cancel`, `confirm`, `refresh`, `download`, `upload`, `share`, `copy`, `search`, `filter`, `sort` |
| **Status** | 8 | `success`, `warning`, `error`, `info`, `loading`, `pending`, `active`, `inactive` |
| **Crypto** | 8 | `wallet`, `coin`, `chart`, `transaction`, `exchange`, `stellar`, `usdc`, `blockchain` |
| **Communication** | 7 | `email`, `slack`, `telegram`, `webhook`, `notification`, `bell`, `message` |
| **Affiliate** | 8 | `users`, `user-plus`, `link`, `referral`, `tree`, `commission`, `earnings`, `payout` |

### Icon Specifications

- **Style:** Outlined (stroke-based)
- **ViewBox:** 24×24
- **Stroke width:** 2px
- **Stroke linecap:** round
- **Stroke linejoin:** round
- **Default color:** `#6366F1` (Indigo 500)

### Usage

**CSS Classes:**
```html
<i class="icon icon-dashboard icon-lg"></i>
<i class="icon icon-success icon-md icon-primary"></i>
<i class="icon icon-stellar icon-xl text-accent-500"></i>
```

**React Component (Recommended):**
```tsx
import { Icon, IconName } from '@/design/icons/icon-types';

<Icon name="dashboard" size="lg" />
<Icon name="stellar" size="xl" className="text-accent-500" />
<Icon name="success" ariaLabel="Success" />
```

**Sizes:**
- `sm`: 16×16px
- `md`: 24×24px (default)
- `lg`: 32×32px
- `xl`: 48×48px

**TypeScript Support:**
Full type safety with `IconName` union type and `IconProps` interface. See `design/icons/icon-types.ts` for complete definitions.

---

## 🖼️ Banner Assets

### Available Banners

| File | Dimensions | Format | Use Case |
|------|------------|--------|----------|
| `hero-banner.html` | 1920×600px | HTML (self-contained) | Landing page hero section |
| `og-image.html` | 1200×630px | HTML | Open Graph / Facebook / LinkedIn sharing |
| `twitter-header.html` | 1500×500px | HTML | Twitter/X header / banner |
| `email-header.html` | 600×200px | HTML | Email newsletter header |

### Export Instructions

Banners are HTML files with inline CSS and Google Fonts. Export to PNG:

```bash
# Using Playwright (recommended)
npx playwright screenshot --width=1920 --height=600 design/banners/hero-banner.html public/banners/hero-banner.png

# Using Puppeteer
npx puppeteer screenshot --file=hero-banner.png --width=1920 --height=600 design/banners/hero-banner.html

# For retina displays (@2x)
npx playwright screenshot --width=3840 --height=1200 design/banners/hero-banner.html public/banners/hero-banner@2x.png
```

### Design Specifications

- **Color palette:** Primary indigo (#6366F1), cyan accent (#06B6D4), dark slate bg (#0F172A)
- **Typography:** Space Grotesk (headings), Inter (body)
- **Animations:** CSS animations included (pulse, glow breathing) — auto-pause for screenshots
- **Export notes:** Fonts load from Google Fonts CDN; ensure internet connection during export

---

## 💼 Corporate Identity Program (CIP)

### Assets Included

| Asset | Dimensions | Format | DPI | Use |
|-------|------------|--------|-----|-----|
| Business Card | 1050×600px (3.5×2") | HTML | 300 | Print / digital |
| Letterhead | 2480×3508px (A4) | HTML | 300 | Print / PDF |
| Email Signature | 600×200px | HTML | N/A | Email clients |
| Social Profile Kit | Various | HTML templates | N/A | Social media |

### Color Scheme

- **Primary:** `#6366F1` (Indigo 500)
- **Secondary:** `#8B5CF6` (Violet 500)
- **Accent:** `#06B6D4` (Cyan 500)
- **Dark BG:** `#0F172A` (Slate 900)
- **Light Text:** `#F8FAFC` (Slate 50)

### Typography

- **Display:** Space Grotesk
- **Body:** Inter

### Print Specifications

- **Digital:** RGB (sRGB color space)
- **Print:** Convert to CMYK before sending to printer (use Adobe Acrobat Pro or request from printer)
- **Bleed:** 3mm on all sides for business cards; none for letterhead (full sheet)
- **Safe zones:** Keep critical content (logo, text) within inner 80% of canvas
- **Minimum DPI:** 300 for professional printing
- **Recommended finishes:** Matte or soft-touch for business cards

---

## 🎯 Logo Guidelines

See `design/logo-brief.md` for complete concepts and `design/logo-specs.md` for usage specifications.

### Logo Concepts

1. **The Ascending Apex** (Recommended) — Stylized "A" shaped like mountain peak with blockchain connection lines
2. **The Cashback Orbit** — Circular orbit with arc arrow representing cashback flow
3. **The Block Tower** — Stacked blocks with increasing size
4. **The Stellar Apex** — Triangle apex with stellar node dots
5. **The Growth Bar** — Bar chart style with apex angle

### Clear Space

Maintain minimum clear space equal to **x-height of the "A"** in the wordmark.

### Minimum Sizes

| Application | Minimum Height |
|-------------|----------------|
| Screen/Web | 32px (24px for mobile) |
| Print | 0.5" (0.375" for small items) |
| Favicon | 16px (use icon-only version) |

---

## 🚀 Quick Start

### 1. Import Design Tokens

```css
/* In your global CSS (e.g., src/styles/globals.css) */
@import '@apex-os/design-system/tokens/index.css';

/* Tokens are now available as CSS custom properties */
```

### 2. Configure Tailwind CSS

Extend your `tailwind.config.js`:

```javascript
export default {
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe',
          300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1',
          600: '#4f46e5', 700: '#4338ca', 800: '#3730a3',
          900: '#312e81', 950: '#1e1b4b'
        },
        secondary: { /* ... */ },
        accent: { /* ... */ },
        neutral: { /* ... */ }
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Space Grotesk', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace']
      },
      boxShadow: {
        xs: '0 1px 2px rgba(15, 23, 42, 0.04)',
        sm: '0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04)',
        md: '0 4px 6px -1px rgba(15, 23, 42, 0.07), 0 2px 4px -2px rgba(15, 23, 42, 0.05)',
        lg: '0 10px 15px -3px rgba(15, 23, 42, 0.08), 0 4px 6px -4px rgba(15, 23, 42, 0.04)',
        xl: '0 20px 25px -5px rgba(15, 23, 42, 0.08), 0 8px 10px -6px rgba(15, 23, 42, 0.04)',
        '2xl': '0 25px 50px -12px rgba(15, 23, 42, 0.15)'
      }
    }
  }
}
```

### 3. Use Icons

```tsx
import { Icon } from '@/components/Icon'; // To be created

export const DashboardNav = () => (
  <nav className="flex items-center gap-4">
    <Icon name="dashboard" size="lg" />
    <Icon name="deals" className="text-primary-500" />
    <Icon name="stellar" size="xl" ariaLabel="Stellar USDC" />
  </nav>
);
```

### 4. Enable Dark Mode

```tsx
// In your root layout or theme provider
<html lang="en" className="dark">
  {/* App content */}
</html>
```

All CSS custom properties automatically switch to dark mode values when `.dark` class is present.

---

## ✅ Verification Checklist

### All Assets Verified ✓

- [x] Design token CSS files valid and complete
  - `tokens/colors.css`
  - `tokens/typography.css`
  - `tokens/spacing.css`
  - `tokens/shadows.css`
  - `tokens/index.css`

- [x] Icon system complete
  - 6 SVG sprite files (navigation, actions, status, crypto, communication, affiliate)
  - `icon-font.css` with CSS classes
  - `icon-types.ts` with TypeScript definitions

- [x] Banner assets ready
  - 4 HTML banner files (hero, og-image, twitter-header, email-header)

- [x] CIP assets ready
  - 4 HTML templates (business-card, letterhead, email-signature, social-profile-kit)

- [x] Brand guidelines documented
  - `logo-brief.md` — 5 logo concepts with specifications
  - `logo-specs.md` — Usage, clear space, minimum sizes

- [x] Dark mode support built into tokens
- [x] Semantic tokens for fintech use cases defined
- [x] Gradients for hero sections and CTAs

---

## 📦 Asset Export Status

| Asset Type | Status | Notes |
|------------|--------|-------|
| Logo SVG files | ⏳ Pending | Design concepts in `logo-brief.md` — needs final SVG generation |
| Banner PNG exports | ⏳ Pending | HTML templates ready — export using Playwright/Puppeteer |
| Icon sprite optimization | ✅ Ready | SVG files complete — can compress with SVGO if needed |
| Favicon set | ⏳ Pending | Generate from icon-only logo (16, 32, 48, 180px) |
| Print-ready PDFs | ⏳ Pending | Convert CIP HTML to PDF with CMYK profile |

---

## 🔗 Related Documentation

- **[CLAUDE.md](../CLAUDE.md)** — Project overview, tech stack, architecture
- **[Deployment Runbook](../docs/deployment-runbook.md)** — Cloudflare Pages setup
- **[Operational Runbook](../docs/operational-runbook.md)** — Day-to-day operations
- **[Admin Dashboards Guide](../docs/admin-dashboards.md)** — Using admin interfaces
- **[Alerting Runbook](../docs/alerting-runbook.md)** — Alert response procedures

---

**ApexOS Design System** — Version 1.0.0 (2026-06-23)
Global Crypto Cashback + Affiliate Hub
