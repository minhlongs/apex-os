import { MetadataRoute } from 'next';

// Danh sách các trang cần thêm vào sitemap
const staticPages = [
  { path: '/', priority: 1.0, changefreq: 'daily' },
  { path: '/landing', priority: 1.0, changefreq: 'daily' },
  { path: '/login', priority: 0.8, changefreq: 'weekly' },
  { path: '/signup', priority: 0.9, changefreq: 'weekly' },
  { path: '/deals', priority: 0.8, changefreq: 'daily' },
  { path: '/dashboard', priority: 0.7, changefreq: 'daily', authRequired: true },
  { path: '/dashboard/affiliates', priority: 0.6, changefreq: 'weekly', authRequired: true },
  { path: '/dashboard/conversions', priority: 0.6, changefreq: 'weekly', authRequired: true },
  { path: '/dashboard/payouts', priority: 0.6, changefreq: 'weekly', authRequired: true },
  { path: '/dashboard/settings', priority: 0.5, changefreq: 'monthly', authRequired: true },
];

// Admin pages
const adminPages = [
  { path: '/admin/metrics', priority: 0.7, changefreq: 'daily', adminOnly: true },
  { path: '/admin/alerts', priority: 0.7, changefreq: 'daily', adminOnly: true },
  { path: '/admin/analytics', priority: 0.6, changefreq: 'daily', adminOnly: true },
  { path: '/admin/deals', priority: 0.6, changefreq: 'daily', adminOnly: true },
  { path: '/admin/health', priority: 0.5, changefreq: 'hourly', adminOnly: true },
  { path: '/admin/affiliates', priority: 0.6, changefreq: 'daily', adminOnly: true },
];

const locales = ['vi', 'en'] as const;
const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://apex-os.com';

function getUrl(path: string, locale: string): string {
  const normalizedPath = path === '/' ? '' : path;
  return `${baseUrl}/${locale}${normalizedPath}`;
}

function generateStaticPages(): string[] {
  const urls: string[] = [];

  for (const locale of locales) {
    for (const page of staticPages) {
      urls.push(getUrl(page.path, locale));
    }
    for (const page of adminPages) {
      urls.push(getUrl(page.path, locale));
    }
  }

  return urls;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const urls = generateStaticPages();

  return urls.map((url) => ({
    url,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: 0.8,
  }));
}
