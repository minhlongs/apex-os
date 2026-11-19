import { MetadataRoute } from 'next';
import { CANONICAL_PRODUCTION_ORIGIN, resolveCanonicalAppOrigin } from '@/config/canonical-origin';

export default function robots(): MetadataRoute.Robots {
  const baseUrl = resolveCanonicalAppOrigin({ appEnv: 'production' }) || CANONICAL_PRODUCTION_ORIGIN;

  return {
    rules: [
      {
        userAgent: '*',
        allow: [
          '/',
          '/vi',
          '/en',
          '/vi/landing',
          '/en/landing',
          '/vi/deals',
          '/en/deals',
          '/vi/terminal',
          '/en/terminal',
          '/vi/insights',
          '/en/insights',
          '/vi/insights/*',
          '/en/insights/*',
          '/vi/b2b/proof-of-rebate',
          '/en/b2b/proof-of-rebate',
          '/vi/legal/*',
          '/en/legal/*',
        ],
        disallow: [
          '/api/',
          '/admin/',
          '/vi/admin/',
          '/en/admin/',
          '/vi/dashboard/',
          '/en/dashboard/',
        ],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
