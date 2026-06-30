import { ErrorBoundary } from '@/components/error-boundary';
import { NextIntlClientProvider } from 'next-intl';
import { ToastProvider } from '@/components/toast/ToastProvider';
import WebVitalsInitializer from '@/components/WebVitalsInitializer';
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
      ? 'ApexOS - Nền tảng crypto cashback toàn cầu và affiliate hub. Kiếm tiền mặt từ giao dịch crypto, hoa hồng đa cấp 30/10/5%.'
      : 'ApexOS - Global crypto cashback platform and affiliate hub. Earn cashback on crypto trades, multi-tier commissions 30/10/5%.';
  const keywords =
    locale === 'vi'
      ? 'crypto cashback, affiliate marketing, hoa hồng crypto, copy trading, Binance, Bybit, USDC, Stellar, earn crypto, referral program'
      : 'crypto cashback, affiliate marketing, crypto commissions, copy trading, Binance, Bybit, USDC, Stellar, earn crypto, referral program';

  return {
    title: {
      default: 'ApexOS — Crypto Cashback & Affiliate Hub',
      template: '%s | ApexOS',
    },
    description,
    keywords,
    authors: [{ name: 'ApexOS' }],
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
    themeColor: '#000000',
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
      title: 'ApexOS — Crypto Cashback & Affiliate Hub',
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
      title: 'ApexOS — Crypto Cashback & Affiliate Hub',
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
      'msapplication-TileColor': '#000000',
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
  if (!locales.includes(locale as typeof locales[number])) {
    // Return 404 not found for invalid locale
    const notFound = (await import('next/navigation')).notFound;
    notFound();
  }
  const messages = (await import(`../../i18n/messages/${locale}.json`)).default;

  return (
    <ErrorBoundary>
      <ToastProvider>
        <html lang={locale}>
          <body className={`${inter.variable} font-sans antialiased`}>
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
