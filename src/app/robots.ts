import { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://apex-os.com';

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
