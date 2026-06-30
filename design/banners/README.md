# ApexOS Banner Assets

Banner designs for ApexOS landing page, social media, and Open Graph sharing.

## Files

| File | Dimensions | Use Case |
|------|------------|----------|
| `hero-banner.html` | 1920×600px | Landing page hero section |
| `og-image.html` | 1200×630px | Open Graph / Facebook / LinkedIn |
| `twitter-header.html` | 1500×500px | Twitter/X header / banner |
| `email-header.html` | 600×200px | Email newsletter header |

## Export Instructions

### Using Chrome DevTools

1. Open the HTML file in Chrome
2. Open DevTools (F12)
3. Press `Ctrl+Shift+P` (Cmd+Shift+P on Mac)
4. Type "screenshot" and select "Capture node screenshot"
5. Save the generated PNG

### Using Command Line (puppeteer)

```bash
npx puppeteer screenshot \
  --file=hero-banner.png \
  --width=1920 \
  --height=600 \
  hero-banner.html
```

### Using Playwright

```bash
npx playwright screenshot \
  --width=1920 \
  --height=600 \
  hero-banner.html \
  hero-banner.png
```

### Export at 2x Resolution (Retina)

Multiply dimensions by 2 for crisp displays:

```bash
npx playwright screenshot \
  --width=3840 \
  --height=1200 \
  hero-banner.html \
  hero-banner@2x.png
```

## Design Specifications

### Color Palette
- **Primary gradient:** `linear-gradient(135deg, #6366F1, #8B5CF6)`
- **Accent:** `#06B6D4` (cyan)
- **Dark bg:** `#0F172A` (Slate 900)
- **Light bg:** `#F8FAFC` (Slate 50)

### Typography
- **Headings:** Space Grotesk (Google Fonts)
- **Body:** Inter (Google Fonts)

### Animations
Banners include CSS animations:
- Pulse effect on accent elements
- Gradient glow breathing
- Smooth transitions on hover

To export static version, animations pause automatically in screenshot.

## Usage

### Next.js Image Component

```tsx
import Image from 'next/image'
import heroBanner from '@/design/banners/hero-banner.png'

export const Hero = () => (
  <section>
    <Image
      src={heroBanner}
      alt="ApexOS Hero"
      width={1920}
      height={600}
      priority
    />
  </section>
)
```

### Open Graph Meta Tags

```tsx
export default function Head() {
  return (
    <Helmet>
      <meta property="og:image" content="/design/banners/og-image.png" />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content="ApexOS - Global Crypto Cashback + Affiliate Hub" />
    </Helmet>
  )
}
```

## Notes

- All banners are **self-contained** HTML files with inline CSS
- Fonts load from Google Fonts CDN
- For email headers, inline CSS is minimal for compatibility
- Dark theme consistent across all banners

## Updates

When updating banners:
1. Edit the HTML file
2. Re-export PNG at specified dimensions
3. Replace in `/public/assets/banners/`
4. Test on actual platform (Facebook debugger, Twitter card validator)
