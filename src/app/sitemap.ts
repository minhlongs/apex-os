import { MetadataRoute } from 'next';
import { QUANT_INSIGHT_ARTICLES } from '@/data/quant-insights';

const locales = ['vi', 'en'] as const;
const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://apex-os.com';

const publicPages = [
  { path: '', priority: 1.0, changefreq: 'daily' as const },
  { path: '/landing', priority: 1.0, changefreq: 'daily' as const },
  { path: '/deals', priority: 0.9, changefreq: 'daily' as const },
  { path: '/terminal', priority: 0.9, changefreq: 'daily' as const },
  { path: '/insights', priority: 0.9, changefreq: 'weekly' as const },
  { path: '/login', priority: 0.5, changefreq: 'monthly' as const },
  { path: '/signup', priority: 0.7, changefreq: 'monthly' as const },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];
  const now = new Date();

  for (const page of publicPages) {
    for (const locale of locales) {
      entries.push({
        url: `${baseUrl}/${locale}${page.path}`,
        lastModified: now,
        changeFrequency: page.changefreq,
        priority: page.priority,
        alternates: {
          languages: {
            vi: `${baseUrl}/vi${page.path}`,
            en: `${baseUrl}/en${page.path}`,
          },
        },
      });
    }
  }

  for (const article of QUANT_INSIGHT_ARTICLES) {
    for (const locale of locales) {
      entries.push({
        url: `${baseUrl}/${locale}/insights/${article.slug}`,
        lastModified: new Date(article.publishedAt),
        changeFrequency: 'weekly',
        priority: 0.85,
        alternates: {
          languages: {
            vi: `${baseUrl}/vi/insights/${article.slug}`,
            en: `${baseUrl}/en/insights/${article.slug}`,
          },
        },
      });
    }
  }

  return entries;
}
