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
  const baseUrl = 'https://apex-os.com';
  const siteName = 'ApexOS';
  const description =
    locale === 'vi'
      ? 'ApexOS — Hạ tầng thu hồi phí điểm cơ bản (bps) và đối soát thanh khoản định lượng 3 tầng (30/10/5%). Xác thực Zero-Secret API Key ID trên Binance, Bybit, OKX, KuCoin.'
      : 'ApexOS — Institutional crypto basis-point (bps) fee recovery hub and 3-tier liquidity attribution engine (30/10/5%). Zero-Secret API Key ID verification across Binance, Bybit, OKX, KuCoin.';
  const keywords =
    locale === 'vi'
      ? 'crypto fee rebate, basis points, bps fee drag, quant execution, zero-secret API key ID, Binance, Bybit, OKX, KuCoin, Stellar USDC, 3-tier liquidity desk'
      : 'crypto fee rebate, basis points, bps fee drag, quant execution, zero-secret API key ID, Binance, Bybit, OKX, KuCoin, Stellar USDC, 3-tier liquidity desk';

  return {
    title: {
      default: 'ApexOS — Institutional Quant Fee Recovery & Attribution Hub',
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
      title: 'ApexOS — Institutional Quant Fee Recovery & Attribution Hub',
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
      title: 'ApexOS — Institutional Quant Fee Recovery & Attribution Hub',
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
  const messages = (await import(`../../i18n/messages/${locale}.json`)).default;
  const orgJsonLd = generateOrganizationJsonLd();
  const appJsonLd = generateSoftwareApplicationJsonLd();

  return (
    <ErrorBoundary>
      <ToastProvider>
        <html lang={locale}>
          <head>
            <script
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
