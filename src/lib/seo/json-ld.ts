import { CANONICAL_PRODUCTION_ORIGIN } from '@/config/canonical-origin';

export function generateOrganizationJsonLd(baseUrl = CANONICAL_PRODUCTION_ORIGIN) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'ApexOS',
    url: baseUrl,
    logo: `${baseUrl}/assets/icons/icon-192.png`,
    description:
      'Non-custodial crypto trading fee rebate and cryptographic B2B Proof-of-Rebate infrastructure with 2-tier partner attribution.',
    sameAs: [],
  };
}

export function generateSoftwareApplicationJsonLd(baseUrl = CANONICAL_PRODUCTION_ORIGIN) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'ApexOS Institutional Quant Terminal',
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Cloud, Web, Mobile',
    url: `${baseUrl}/landing`,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: 'UID-only non-custodial trading fee rebate attribution & 2-tier Safe-Spread partner waterfall.',
    },
  };
}

export function generateTechArticleJsonLd(opts: {
  slug: string;
  title: string;
  description: string;
  publishedAt: string;
  locale: string;
  baseUrl?: string;
}) {
  const base = opts.baseUrl || CANONICAL_PRODUCTION_ORIGIN;
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: opts.title,
    description: opts.description,
    datePublished: opts.publishedAt,
    dateModified: opts.publishedAt,
    inLanguage: opts.locale,
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `${base}/${opts.locale}/insights/${opts.slug}`,
    },
    publisher: {
      '@type': 'Organization',
      name: 'ApexOS Quant Research',
      logo: {
        '@type': 'ImageObject',
        url: `${base}/assets/icons/icon-192.png`,
      },
    },
    author: {
      '@type': 'Organization',
      name: 'ApexOS Quantitative Engineering',
    },
  };
}
