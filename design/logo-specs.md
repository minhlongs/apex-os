# ApexOS Logo — Usage Guidelines & Specifications

## Logo Architecture

The ApexOS logo system consists of three primary variations:

1. **Primary Logo** — Full wordmark with optional icon
2. **Icon/Logomark** — Standalone geometric symbol
3. **Monochrome** — Single-color versions for constrained use cases

---

## Logo Concepts

### Concept 1: Apex Peak
- **Visual**: Geometric mountain/peak shape with gradient fill
- **Meaning**: Represents reaching the top, excellence, growth
- **Typography**: Space Grotesk (bold)
- **Colors**: Indigo-to-violet gradient (#6366F1 → #8B5CF6)

### Concept 2: Crypto Link
- **Visual**: Interconnected nodes forming abstract "A" shape
- **Meaning**: Affiliate network, blockchain connections
- **Typography**: Space Grotesk (medium)
- **Colors**: Cyan accent nodes (#06B6D4) on indigo

### Concept 3: Cashback Arrow
- **Visual**: Upward arrow integrated with coin element
- **Meaning**: Earnings growth, positive momentum
- **Typography**: Space Grotesk (regular)
- **Colors**: Emerald green growth accent (#10B981)

---

## Clear Space

Maintain minimum clear space around the logo equal to **x-height of the "A"** in the wordmark.

```
┌─────────────────────────────────────┐
│                                     │
│     ┌─────────────────────┐         │
│     │  APEXOS             │         │
│     └─────────────────────┘         │
│                                     │
└─────────────────────────────────────┘
        ←── x-height ──→
```

---

## Minimum Sizes

| Application | Minimum Height | Notes |
|-------------|----------------|-------|
| Screen/Web | 32px | Do not go below 24px for mobile |
| Print | 0.5" | Minimum 0.375" for small items |
| Favicon | 16px | Use icon-only version |

---

## Color Variations

### Primary (Full Color)
- Background: White or light (#F8FAFC)
- Logo: Gradient primary (#6366F1 → #8B5CF6)
- Text: Dark (#0F172A)

### Dark Background
- Background: Dark (#0F172A or darker)
- Logo: Gradient light (#818CF8 → #A78BFA)
- Text: White (#F8FAFC)

### Monochrome Light
- Single color: #0F172A (dark) or #6366F1 (primary tint)
- For use on light backgrounds only

### Monochrome Dark
- Single color: #F8FAFC (white)
- For use on dark/colored backgrounds

---

## Incorrect Usage

❌ **DO NOT:**
- Stretch or compress the logo
- Rotate the logo
- Change the logo colors (except approved monochrome variants)
- Add effects (drop shadow, outline, glow) without approval
- Place on busy/low-contrast backgrounds
- Use old/outdated logo versions
- Separate icon from wordmark without context

---

## File Formats

| Format | Use Case | Notes |
|--------|----------|-------|
| SVG | Web, print, high-res | Preferred — scalable, small file size |
| PNG (transparent) | Screenshots, documents | Export at 2x required size |
| EPS | Print production | For professional printers only |
| ICO | Favicon | 16x16, 32x32, 48x48 sizes |

---

## Icon-Only Usage

The standalone icon may be used when:
- Space is extremely limited (favicon, app icon, small badges)
- The brand is already established in context
- As a decorative element in UI patterns

**Icon requirements:**
- Minimum 24x24px on screen
- Always include tooltip or adjacent "ApexOS" text in UI
- Never use icon-only for primary navigation without text label

---

## Implementation

### React Component

```tsx
import Image from 'next/image'
import apexosLogo from '@/design/logo/apexos-logo.svg'
import apexosIcon from '@/design/logo/apexos-icon.svg'

export const ApexOSLogo = ({ size = 'md' }) => {
  const sizes = { sm: 80, md: 120, lg: 180 }
  return <Image src={apexosLogo} width={sizes[size]} height={40} alt="ApexOS" />
}

export const ApexOSIcon = ({ size = 24 }) => (
  <Image src={apexosIcon} width={size} height={size} alt="ApexOS" />
)
```

### Tailwind Classes

```html
<!-- Light background -->
<img src="logo.svg" class="h-10 w-auto" alt="ApexOS" />

<!-- Dark background -->
<img src="logo-white.svg" class="h-10 w-auto" alt="ApexOS" />
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-06-23 | Initial logo system with 3 concepts |
