export const meta = {
  name: 'apexos-full-design-package',
  description: 'Complete design package for ApexOS: logo, design system, banner, icons, CIP mockups',
  phases: [
    { title: 'Brand & Logo', detail: 'Generate logo design brief and AI-generated logos' },
    { title: 'Design System', detail: 'Create design tokens, colors, typography for ApexOS' },
    { title: 'Banner & Social', detail: 'Hero banner, social media banners, social photos' },
    { title: 'Icons', detail: 'Generate icon set for the application' },
    { title: 'CIP Mockups', detail: 'Business card, letterhead, envelope mockups' },
    { title: 'Synthesize', detail: 'Combine all assets into final design package' },
  ],
}

// Brand context for ApexOS
const BRAND = {
  name: 'ApexOS',
  tagline: 'Global Crypto Cashback + Affiliate Hub',
  industry: 'fintech',
  style: 'modern, tech, trustworthy, premium',
  colors: {
    primary: '#6366F1', // Indigo
    secondary: '#8B5CF6', // Violet
    accent: '#06B6D4', // Cyan
    dark: '#0F172A', // Slate 900
    light: '#F8FAFC', // Slate 50
  },
  keywords: ['crypto', 'cashback', 'affiliate', 'stellar', 'USDC', 'blockchain', 'finance', 'growth'],
}

// ============================================================================
// Phase 1: Logo Design
// ============================================================================
phase('Brand & Logo')

// Agent 1: Logo design brief
const logoBrief = await agent(
  `Generate a comprehensive logo design brief for ApexOS brand.

Brand: ${BRAND.name}
Tagline: ${BRAND.tagline}
Industry: ${BRAND.industry}
Style: ${BRAND.style}
Keywords: ${BRAND.keywords.join(', ')}

Create a detailed design brief including:
1. Logo concept directions (3-5 ideas)
2. Typography recommendations
3. Color palette suggestions
4. Symbol/icon concepts
5. Usage guidelines (primary, secondary, icon-only versions)

Save the brief to: /Users/macbook/apex-os/design/logo-brief.md`,
  { label: 'logo-brief', phase: 'Brand & Logo' }
)

// Agent 2: Generate logo with AI
const logoGenerated = await agent(
  `Generate a professional logo for ApexOS using the logo generation script.

Run this command:
python3 ~/.claude/skills/design/scripts/logo/generate.py \
  --brand "ApexOS" \
  --style "modern" \
  --industry "fintech" \
  --prompt "ApexOS - Global Crypto Cashback and Affiliate Hub. Modern fintech logo combining geometric shapes suggesting growth (apex peak) with subtle crypto/blockchain elements. Clean, professional, trustworthy. Blue-indigo gradient with cyan accent. Minimalist but memorable."

Save output to: /Users/macbook/apex-os/design/logo/`,
  { label: 'logo-generate', phase: 'Brand & Logo' }
)

// ============================================================================
// Phase 2: Design System
// ============================================================================
phase('Design System')

const designSystem = await agent(
  `Create a complete design system for ApexOS web application.

Brand: ${BRAND.name}
Industry: Fintech / Crypto Cashback Platform

Create the following files:

1. /Users/macbook/apex-os/design/tokens/colors.css
   - CSS custom properties for all brand colors
   - Semantic color tokens (primary, secondary, success, warning, error, info)
   - Dark/light mode variants
   - Gradient definitions

2. /Users/macbook/apex-os/design/tokens/typography.css
   - Font families (Inter for UI, Space Grotesk for headings)
   - Type scale (xs, sm, base, lg, xl, 2xl, 3xl, 4xl)
   - Font weights and line heights

3. /Users/macbook/apex-os/design/tokens/spacing.css
   - Spacing scale (4px base: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80)
   - Border radius tokens

4. /Users/macbook/apex-os/design/tokens/shadows.css
   - Shadow scale for elevation system
   - Glow effects for dark theme

5. /Users/macbook/apex-os/design/tokens/index.css
   - Import all tokens
   - @theme block for Tailwind CSS v4

6. /Users/macbook/apex-os/design/tokens/README.md
   - Documentation for design tokens
   - Usage examples

Color palette:
- Primary: #6366F1 (Indigo 500)
- Primary hover: #4F46E5 (Indigo 600)
- Secondary: #8B5CF6 (Violet 500)
- Accent: #06B6D4 (Cyan 500)
- Success: #10B981 (Emerald 500)
- Warning: #F59E0B (Amber 500)
- Error: #EF4444 (Red 500)
- Background: #FFFFFF / #0F172A (dark)
- Surface: #F8FAFC / #1E293B (dark)
- Text: #0F172A / #F8FAFC (dark)

Make sure tokens are compatible with Next.js 16 + Tailwind CSS 3.4 + next-intl.`,
  { label: 'design-system', phase: 'Design System' }
)

// ============================================================================
// Phase 3: Banner & Social Media
// ============================================================================
phase('Banner & Social')

const bannerDesign = await agent(
  `Create HTML/CSS banner designs for ApexOS.

Brand: ${BRAND.name}
Style: Modern fintech, dark theme with gradient accents

Create these banner files:

1. /Users/macbook/apex-os/design/banners/hero-banner.html
   - Hero banner for landing page (1920x600)
   - Dark background with indigo/violet gradient
   - Headline: "Global Crypto Cashback + Affiliate Hub"
   - Subheadline: "Earn cashback on every trade. Build your affiliate network."
   - CTA buttons: "Get Started" and "Learn More"
   - Subtle grid pattern or geometric shapes in background
   - Animated gradient glow effect

2. /Users/macbook/apex-os/design/banners/og-image.html
   - Open Graph image (1200x630)
   - ApexOS logo placeholder + tagline
   - Gradient background

3. /Users/macbook/apex-os/design/banners/twitter-header.html
   - Twitter/X header (1500x500)
   - Brand name + tagline
   - Minimalist design

4. /Users/macbook/apex-os/design/banners/email-header.html
   - Email newsletter header (600x200)
   - Brand colors, logo placeholder

Use inline CSS with modern design:
- Dark theme (#0F172A background)
- Indigo (#6366F1) to Violet (#8B5CF6) gradients
- Cyan (#06B6D4) accent highlights
- Inter font family
- Glassmorphism effects for cards
- Subtle animations (CSS only)

Each HTML file should be self-contained and renderable in browser for screenshot export.`,
  { label: 'banner-design', phase: 'Banner & Social' }
)

// ============================================================================
// Phase 4: Icon Set
// ============================================================================
phase('Icons')

const iconSet = await agent(
  `Generate SVG icons for ApexOS application.

Create icon definitions for these categories:

1. /Users/macbook/apex-os/design/icons/navigation.svg
   - Dashboard, Deals, Affiliates, Payouts, Profile, Settings, Analytics, Health, Alerts

2. /Users/macbook/apex-os/design/icons/actions.svg
   - Add, Edit, Delete, Save, Cancel, Confirm, Refresh, Download, Upload, Share, Copy, Search, Filter, Sort

3. /Users/macbook/apex-os/design/icons/status.svg
   - Success, Warning, Error, Info, Loading, Pending, Active, Inactive

4. /Users/macbook/apex-os/design/icons/crypto.svg
   - Wallet, Coin, Chart, Transaction, Exchange, Stellar, USDC, Blockchain

5. /Users/macbook/apex-os/design/icons/communication.svg
   - Email, Slack, Telegram, Webhook, Notification, Bell, Message

6. /Users/macbook/apex-os/design/icons/affiliate.svg
   - Users, UserPlus, Link, Referral, Tree, Commission, Earnings, Payout

Style guidelines:
- Outlined style, 24x24 viewBox
- 2px stroke width
- Rounded line caps and joins
- Primary color: #6366F1
- Consistent visual weight across all icons
- Use lucide-react style as reference (clean, minimal)

Also create:
7. /Users/macbook/apex-os/design/icons/icon-font.css
   - CSS classes for each icon using SVG background-image
   - Size variants: sm (16px), md (24px), lg (32px), xl (48px)

8. /Users/macbook/apex-os/design/icons/README.md
   - Icon usage guide
   - Naming conventions
   - React component example`,
  { label: 'icon-set', phase: 'Icons' }
)

// ============================================================================
// Phase 5: CIP Mockups
// ============================================================================
phase('CIP Mockups')

const cipMockups = await agent(
  `Generate CIP (Corporate Identity Program) mockups for ApexOS.

Brand: ${BRAND.name}
Industry: fintech

Create HTML mockups for:

1. /Users/macbook/apex-os/design/cip/business-card.html
   - Standard business card (3.5" x 2" = 1050x600px at 300dpi)
   - Front: Logo + Name + Title
   - Back: Contact info (email, website, phone)
   - Dark theme with indigo accent

2. /Users/macbook/apex-os/design/cip/letterhead.html
   - A4 letterhead (210mm x 297mm = 2480x3508px at 300dpi)
   - Header with logo and brand colors
   - Footer with contact info
   - Subtle background pattern

3. /Users/macbook/apex-os/design/cip/envelope.html
   - Standard envelope (4.125" x 9.5" = 1237x2850px)
   - Logo top-left
   - Return address
   - Brand color accent strip

4. /Users/macbook/apex-os/design/cip/email-signature.html
   - Professional email signature
   - Logo + Name + Title
   - Contact details with icons
   - Brand colors

5. /Users/macbook/apex-os/design/cip/social-media-kit.html
   - Profile picture frame (400x400)
   - Cover photo template (1500x500)
   - Brand color swatches and logo placement guides

Style: Modern fintech, dark theme, indigo/violet gradients, clean typography.

Each HTML file should be self-contained for screenshot export.`,
  { label: 'cip-mockups', phase: 'CIP Mockups' }
)

// ============================================================================
// Phase 6: Synthesize
// ============================================================================
phase('Synthesize')

const synthesized = await agent(
  `Create a comprehensive design package summary for ApexOS.

1. Create /Users/macbook/apex-os/design/README.md with:
   - Overview of all design assets
   - File tree of the design package
   - Color palette reference
   - Typography reference
   - Usage guidelines
   - Next steps for implementation

2. Create /Users/macbook/apex-os/design/package.json with metadata:
   - Brand name, version
   - Asset inventory
   - File sizes and formats

3. Verify all design files exist and list them:
   - Logo files
   - Design tokens
   - Banner HTML files
   - Icon SVG files
   - CIP mockup HTML files

Make the README professional and comprehensive, suitable for handing off to a development team.`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return {
  status: 'DONE',
  summary: `Complete design package generated for ApexOS with ${6} design deliverables across logo, design system, banners, icons, and CIP mockups.`,
}
