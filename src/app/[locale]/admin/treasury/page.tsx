/**
 * src/app/[locale]/admin/treasury/page.tsx
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Admin Multi-Chain Treasury & Payout Preview Dashboard Page
 *
 * Server component guarded by requireAdmin() with NextIntl support.
 */

import { redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { requireAdmin } from '@/lib/admin-auth';
import { TreasuryDashboardClient } from '@/components/admin/treasury/treasury-dashboard-client';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const messages = await getMessages({ locale });

  const adminSection = (messages as Record<string, Record<string, Record<string, string>>>)?.admin?.treasury;

  return {
    title:
      adminSection?.title ||
      'Multi-Chain Treasury & Payouts — ApexOS Admin',
    description:
      adminSection?.subtitle ||
      'Real-time multi-chain hot wallet balances, circuit breaker status, and automated batch settlement execution.',
  };
}

export default async function AdminTreasuryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // Guard: require admin authentication
  const admin = await requireAdmin();
  if (!admin) {
    redirect(`/${locale}/login?redirect=/${locale}/admin/treasury`);
  }

  // Fetch localization messages
  const messages = await getMessages({ locale });

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <TreasuryDashboardClient locale={locale} />
        </div>
      </div>
    </NextIntlClientProvider>
  );
}
