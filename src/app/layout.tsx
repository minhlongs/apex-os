import type { Metadata } from 'next';
import { ErrorBoundary } from '@/components/error-boundary';
import { CANONICAL_PRODUCTION_ORIGIN, resolveCanonicalAppOrigin } from '@/config/canonical-origin';
import { AuthProvider } from '@/contexts/auth-context';
import './globals.css';

const canonicalOrigin =
  resolveCanonicalAppOrigin({ appEnv: 'production' }) || CANONICAL_PRODUCTION_ORIGIN;

export const metadata: Metadata = {
  metadataBase: new URL(canonicalOrigin),
  title: {
    default: 'ApexOS — Non-Custodial Crypto Fee Rebate & B2B Proof-of-Rebate Infrastructure',
    template: '%s | ApexOS',
  },
  description:
    'UID-only non-custodial crypto trading fee rebates, 10^-8 USD double-entry accounting, SHA-256 Cloudflare R2 Proof-of-Rebate verification, and self-custody USDC settlement across Stellar, Arbitrum, and Base.',
  keywords: [
    'crypto fee rebate',
    'non-custodial cashback',
    'UID-only attribution',
    'Proof-of-Rebate',
    'Safe-Spread Waterfall',
    'Bybit rebate',
    'OKX rebate',
    'Bitget rebate',
    'Stellar USDC',
    'Arbitrum USDC',
    'Base USDC',
  ],
  openGraph: {
    title: 'ApexOS — Non-Custodial Crypto Fee Rebate & B2B Proof-of-Rebate Infrastructure',
    description:
      'Recover execution fees with UID-only partner attribution, Safe-Spread 2-tier waterfall accounting (10^-8 USD), and self-custody multi-chain USDC payouts.',
    url: canonicalOrigin,
    siteName: 'ApexOS',
    type: 'website',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ErrorBoundary>
      <AuthProvider>{children}</AuthProvider>
    </ErrorBoundary>
  );
}
