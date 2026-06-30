# SEO Setup Guide - ApexOS

## Tổng quan

Dự án ApexOS đã được cấu hình SEO đầy đủ với:

- Meta tags động theo locale (vi/en)
- OpenGraph cho Facebook/LinkedIn
- Twitter Card cho X (Twitter)
- Sitemap động với hỗ trợ đa ngôn ngữ hreflang
- robots.txt với các quy tắc an toàn
- PWA manifest.json

## Các file đã tạo/sửa

### 1. Metadata SEO (`src/app/[locale]/layout.tsx`)

Sử dụng Next.js 16 `generateMetadata` API để tạo metadata động:

- **Title & Description:** Đa ngôn ngữ, có template
- **Keywords:** SEO keywords cho cả tiếng Việt và Anh
- **OpenGraph:** og:type, og:locale, og:url, og:title, og:description, og:image, og:site_name
- **Twitter Card:** summary_large_image với hình ảnh, creator và site handle
- **Canonical URLs:** Hỗ trợ hreflang cho vi-VN và en-US
- **Robots meta:** index, follow, googleBot directives
- **Icons & Manifest:** Favicon, Apple touch icon, PWA manifest
- **Theme & Viewport:** theme-color, viewport settings
- **Verification:** Google Search Console verification

### 2. Sitemap (`src/app/sitemap.ts`)

Tạo sitemap.xml tự động với:

- Tất cả các trang public (landing, deals, login, signup)
- Các trang dashboard (đánh dấu authRequired)
- Các trang admin (đánh dấu adminOnly)
- Hỗ trợ đa ngôn ngữ (/vi, /en)
- priority và changefreq theo từng loại trang

**Access:** `https://apex-os.com/sitemap.xml`

### 3. Robots.txt (`public/robots.txt`)

Quy tắc cho crawlers:

- Cho phép crawl trang public
- Chặn các trang private: /admin/, /dashboard/, /api/, /auth/
- Cho phép Googlebot truy cập /admin/health cho monitoring
- Chặn AI training bots (GPTBot, Claude, ChatGPT-User, etc.)
- Sitemap location

**Access:** `https://apex-os.com/robots.txt`

### 4. PWA Manifest (`public/manifest.json`)

Web app manifest cho mobile/PWA:

- name, short_name, description
- theme_color, background_color
- icons với sizes 192x192 và 512x512
- display: standalone
- categories: finance, productivity

**Access:** `https://apex-os.com/manifest.json`

## Các bước cần thiết để hoàn thiện SEO

### 1. Tạo OpenGraph Image

Tạo file `public/assets/og-image.png` với kích thước 1200x630px:
- Logo ApexOS
- Tagline: "Crypto Cashback & Affiliate Hub"
- Có thể thêm tiếng Việt và tiếng Anh riêng biệt

Để hỗ trợ Twitter, có thể tạo thêm `public/assets/og-image-square.png` (1200x1200px).

### 2. Tạo Favicon/Icon

Tạo các icon với kích thước:
- `public/assets/icons/icon-192.png` (192x192px)
- `public/assets/icons/icon-512.png` (512x512px)

### 3. Thêm biến môi trường (nếu cần)

Trong `.env.local`:

```bash
# Google Search Console verification
GOOGLE_SITE_VERIFICATION=your_verification_code

# Site URL (nếu deploy khác domain)
NEXT_PUBLIC_SITE_URL=https://apex-os.com
```

### 4. Submit lên Google Search Console

1. Thêm property `https://apex-os.com`
2. Verify bằng DNS record hoặc HTML file (dùng biến GOOGLE_SITE_VERIFICATION)
3. Submit sitemap: `https://apex-os.com/sitemap.xml`
4. Test robots.txt và sitemap trong URL Inspection tool

### 5. Test SEO

Chạy Lighthouse trong Chrome DevTools:
- SEO section: đảm bảo score 100
- Check OpenGraph tags trong Social tab
- Check Twitter Card trong Card validator: https://cards-dev.twitter.com/validator

### 6. Structured Data (Optional)

Để thêm structured data (JSON-LD), tạo file `src/lib/seo/structured-data.ts`:

```typescript
export function generateOrganizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'ApexOS',
    url: 'https://apex-os.com',
    logo: 'https://apex-os.com/assets/logo.png',
    sameAs: [
      'https://twitter.com/apexos_app',
      'https://github.com/apex-os',
    ],
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer service',
    },
  };
}

export function generateWebSiteSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'ApexOS',
    url: 'https://apex-os.com',
    potentialAction: {
      '@type': 'SearchAction',
      target: 'https://apex-os.com/deals?q={search_term_string}',
      'query-input': 'required name=search_term_string',
    },
  };
}
```

## Kiểm tra

Sau khi deploy, kiểm tra:

1. `https://apex-os.com/robots.txt` - access được
2. `https://apex-os.com/sitemap.xml` - XML hợp lệ
3. `https://apex-os.com/manifest.json` - JSON hợp lệ
4. View source bất kỳ trang nào, kiểm tra meta tags:
   - title, description
   - og:* tags
   - twitter:* tags
   - link rel="canonical"
   - link rel="alternate" hreflang

## Tools

- **OpenGraph test:** https://opengraph.xyz/
- **Twitter Card validator:** https://cards-dev.twitter.com/validator
- **Google Rich Results:** https://search.google.com/test/rich-results
- **Sitemap validator:** https://www.xml-sitemaps.com/validate-xml-sitemap.html
- **Robots.txt validator:** https://www.robots-txt.com/validator

## Lưu ý

- Metadata được generate động theo locale
- Sitemap tự động update khi thêm page mới
- Các trang admin/dashboard được đánh dấu để không index
- AI training bots bị chặn để tránh scrapping
