import { headers } from 'next/headers';
import { ErrorBoundary } from '@/components/error-boundary';
import { NextIntlClientProvider } from 'next-intl';
import { ToastProvider } from '@/components/toast/ToastProvider';
import WebVitalsInitializer from '@/components/WebVitalsInitializer';
import {
  generateOrganizationJsonLd,
  generateSoftwareApplicationJsonLd,
} from '@/lib/seo/json-ld';
import '@/app/globals.css';

const inter = { variable: '--font-inter' } as const;

const locales = ['vi', 'en'] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const { CANONICAL_PRODUCTION_ORIGIN, resolveCanonicalAppOrigin } = await import(
    '@/config/canonical-origin'
  );
  const baseUrl =
    resolveCanonicalAppOrigin({ appEnv: 'production' }) || CANONICAL_PRODUCTION_ORIGIN;
  const siteName = 'ApexOS';
  const description =
    locale === 'vi'
      ? 'ApexOS — Hạ tầng hoàn phí giao dịch không lưu ký chỉ bằng UID và bằng chứng hoàn phí B2B (Proof-of-Rebate). Phân bổ Safe-Spread 2 tầng (50/20/5%), sổ cái kép 10^-8 USD và thanh toán USDC trên Stellar, Arbitrum, Base.'
      : 'ApexOS — Non-custodial UID-only crypto trading fee rebate and B2B Proof-of-Rebate infrastructure. Safe-Spread 2-tier waterfall (50/20/5%), 10^-8 USD double-entry ledger, and self-custody USDC settlement across Stellar, Arbitrum, and Base.';
  const keywords =
    locale === 'vi'
      ? 'crypto fee rebate, non-custodial cashback, UID-only attribution, Proof-of-Rebate, Safe-Spread Waterfall, Bybit, OKX, Bitget, KuCoin, Gate.io, Stellar USDC, Arbitrum USDC, Base USDC'
      : 'crypto fee rebate, non-custodial cashback, UID-only attribution, Proof-of-Rebate, Safe-Spread Waterfall, Bybit, OKX, Bitget, KuCoin, Gate.io, Stellar USDC, Arbitrum USDC, Base USDC';

  return {
    title: {
      default: 'ApexOS — Non-Custodial Crypto Fee Rebate & B2B Proof-of-Rebate Infrastructure',
      template: '%s | ApexOS',
    },
    description,
    keywords,
    authors: [{ name: 'ApexOS Quantitative Engineering' }],
    creator: 'ApexOS',
    publisher: 'ApexOS',
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-video-preview': -1,
        'max-image-preview': 'large',
        'max-snippet': -1,
      },
    },
    icons: {
      icon: '/assets/icons/icon-192.png',
      shortcut: '/assets/icons/icon-192.png',
      apple: '/assets/icons/icon-192.png',
    },
    manifest: '/manifest.json',
    viewport: {
      width: 'device-width',
      initialScale: 1,
      maximumScale: 5,
    },
    themeColor: '#020617',
    appleWebApp: {
      capable: true,
      statusBarStyle: 'default',
      title: 'ApexOS',
    },
    formatDetection: {
      telephone: false,
      email: false,
      address: false,
    },
    alternates: {
      canonical: `${baseUrl}/${locale}`,
      languages: {
        'vi-VN': '/vi',
        'en-US': '/en',
      },
    },
    openGraph: {
      type: 'website',
      locale: locale === 'vi' ? 'vi_VN' : 'en_US',
      url: `${baseUrl}/${locale}`,
      title: 'ApexOS — Non-Custodial Crypto Fee Rebate & B2B Proof-of-Rebate Infrastructure',
      description,
      siteName,
      images: [
        {
          url: `${baseUrl}/assets/og-image.png`,
          width: 1200,
          height: 630,
          alt: siteName,
          type: 'image/png',
        },
        {
          url: `${baseUrl}/assets/og-image-square.png`,
          width: 1200,
          height: 1200,
          alt: siteName,
          type: 'image/png',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'ApexOS — Non-Custodial Crypto Fee Rebate & B2B Proof-of-Rebate Infrastructure',
      description,
      images: [`${baseUrl}/assets/og-image.png`],
      creator: '@apexos_app',
      site: '@apexos_app',
    },
    verification: {
      google: process.env.GOOGLE_SITE_VERIFICATION,
    },
    other: {
      'msapplication-TileImage': '/assets/icons/icon-192.png',
      'msapplication-TileColor': '#020617',
    },
  };
}

export default async function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!locales.includes(locale as (typeof locales)[number])) {
    const notFound = (await import('next/navigation')).notFound;
    notFound();
  }
  let nonce: string | undefined;
  try {
    nonce = (await headers()).get('x-nonce') ?? undefined;
  } catch {
    nonce = undefined;
  }
  const messages = (await import(`../../i18n/messages/${locale}.json`)).default;
  const orgJsonLd = generateOrganizationJsonLd();
  const appJsonLd = generateSoftwareApplicationJsonLd();

  return (
    <ErrorBoundary>
      <ToastProvider>
        <html lang={locale}>
          <head>
            <script
              nonce={nonce}
              type="application/ld+json"
              dangerouslySetInnerHTML={{
                __html: JSON.stringify([orgJsonLd, appJsonLd]),
              }}
            />
          </head>
          <body className={`${inter.variable} font-sans antialiased bg-stitch-canvas text-stitch-primary`}>
            <NextIntlClientProvider locale={locale} messages={messages}>
              {children}
            </NextIntlClientProvider>
            <WebVitalsInitializer />
          </body>
        </html>
      </ToastProvider>
    </ErrorBoundary>
  );
}
