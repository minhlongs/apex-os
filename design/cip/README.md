# ApexOS CIP (Corporate Identity Program)

Corporate identity assets for ApexOS — business cards, letterhead, email signatures, and social media profile kit.

---

## 📦 CIP Assets

| Asset | Size | Format | Status |
|-------|------|--------|--------|
| Business Card | 1050×600px (3.5×2" @ 300dpi) | HTML | ✓ Ready |
| Letterhead | 2480×3508px (A4 @ 300dpi) | HTML | ✓ Ready |
| Email Signature | 600×200px (responsive) | HTML | ✓ Ready |
| Social Profile Kit | Various | HTML templates | ✓ Ready |

---

## 🎨 Design Specifications

### Color Scheme
- **Primary:** `#6366F1` (Indigo 500)
- **Secondary:** `#8B5CF6` (Violet 500)
- **Accent:** `#06B6D4` (Cyan 500)
- **Dark BG:** `#0F172A` (Slate 900)
- **Light Text:** `#F8FAFC` (Slate 50)

### Typography
- **Display:** Space Grotesk (brand name, headings)
- **Body:** Inter (contact info, body text)

### Style
- Modern fintech aesthetic
- Dark theme with gradient accents
- Clean, minimal layout
- Premium, trustworthy appearance

---

## 📋 Usage Instructions

### Business Card

1. **Edit Information**
   - Open `business-card.html` in a code editor
   - Update name, title, contact details in the HTML
   - QR code area — replace placeholder with actual QR

2. **Export to PNG**
   ```bash
   npx playwright screenshot --width=1050 --height=600 business-card.html business-card.png
   ```

3. **Print Production**
   - Export at 300 DPI minimum
   - Use CMYK color profile
   - Include 3-5mm bleed for professional printing
   - Recommended: matte or soft-touch finish

### Letterhead

1. **Customize**
   - Update header contact info
   - Add company registration details in footer
   - Replace placeholder text with your content

2. **Export**
   ```bash
   npx playwright screenshot --width=2480 --height=3508 letterhead.html letterhead.png
   ```

3. **Print**
   - Use A4 paper (210×297mm)
   - Export at 300 DPI
   - Send to professional printer or use as digital letterhead PDF

### Email Signature

1. **Choose Theme**
   - Light version for standard emails
   - Dark version for dark-themed clients

2. **Edit Details**
   - Update name, title, contact info
   - Add social media links
   - Replace placeholder logo

3. **Implementation**
   - Copy HTML into email client signature settings
   - For Gmail: Settings → General → Signature
   - For Outlook: File → Options → Mail → Signatures
   - Test in multiple email clients

### Social Profile Kit

Templates included:
- **Profile Picture:** 400×400px (centered logo)
- **Cover Photo:** 1500×500px (with logo placement)
- **Brand Colors:** Reference swatches
- **Usage Guidelines:** Placement and safe zones

---

## 🖼️ Preview

Open each HTML file in a browser to preview the design.

```bash
# Open in default browser
open business-card.html
open letterhead.html
open email-signature.html
open social-profile-kit.html
```

---

## 📐 Print Specifications

### Color Mode
- **Digital:** RGB (sRGB color space)
- **Print:** Convert to CMYK before sending to printer
- Recommended conversion: Use Adobe Acrobat Pro or ask printer

### Bleed Settings
- **Business Card:** Add 3mm bleed on all sides (final cut: 3.5"×2")
- **Letterhead:** No bleed needed (full sheet)

### Safe Zones
Keep critical content (logo, text) within inner 80% of the canvas.

---

## 🔄 Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-06-23 | Initial CIP release |

---

## 📞 Support

For questions about these assets:
- Refer to main `design/README.md`
- Check design tokens in `design/tokens/`
- Review logo guidelines in `design/logo/`

---

**ApexOS** — Global Crypto Cashback + Affiliate Hub
