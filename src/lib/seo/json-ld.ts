export function generateOrganizationJsonLd(baseUrl = 'https://apex-os.com') {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'ApexOS',
    url: baseUrl,
    logo: `${baseUrl}/assets/icons/icon-192.png`,
    description:
      'Global institutional crypto basis-point fee recovery hub & multi-tier liquidity attribution engine.',
    sameAs: ['https://twitter.com/apexos_app'],
  };
}

export function generateSoftwareApplicationJsonLd(baseUrl = 'https://apex-os.com') {
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
      description: 'Zero-Secret API Key ID fee rebate matching & 3-tier liquidity desk attribution.',
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
  const base = opts.baseUrl || 'https://apex-os.com';
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
