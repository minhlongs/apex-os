import { MetadataRoute } from 'next';
import { CANONICAL_PRODUCTION_ORIGIN, resolveCanonicalAppOrigin } from '@/config/canonical-origin';
import { QUANT_INSIGHT_ARTICLES } from '@/data/quant-insights';

const LOCALES = ['vi', 'en'] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = resolveCanonicalAppOrigin({ appEnv: 'production' }) || CANONICAL_PRODUCTION_ORIGIN;
  const staticRoutes = [
    '',
    '/landing',
    '/terminal',
    '/insights',
    '/deals',
    '/pricing',
    '/b2b/proof-of-rebate',
    '/legal/terms',
    '/legal/non-custodial-disclosure',
    '/legal/geo-restriction',
  ];

  const entries: MetadataRoute.Sitemap = [];

  for (const locale of LOCALES) {
    for (const route of staticRoutes) {
      entries.push({
        url: `${baseUrl}/${locale}${route}`,
        lastModified: new Date('2026-11-15'),
        changeFrequency: route === '/insights' ? 'weekly' : 'monthly',
        priority: route === '/landing' || route === '' ? 1.0 : 0.8,
      });
    }

    for (const article of QUANT_INSIGHT_ARTICLES) {
      entries.push({
        url: `${baseUrl}/${locale}/insights/${article.slug}`,
        lastModified: new Date(article.publishedAt),
        changeFrequency: 'monthly',
        priority: 0.9,
      });
    }
  }

  return entries;
}
