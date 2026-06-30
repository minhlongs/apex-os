/**
 * Admin Stellar Settings Page
 * Server component with admin authentication
 */

import { redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import StellarClient from './StellarClient';
import { requireAdmin, getStellarSettings, getUSDCInfo } from '@/lib/admin/stellar-actions';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const messages = await getMessages({ locale });

  return {
    title: messages?.admin?.settings?.stellar?.title || 'Stellar Settings — ApexOS',
    description: 'Configure Stellar network and USDC payout settings',
  };
}

export default async function AdminStellarSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // Verify admin role
  const admin = await requireAdmin();
  if (!admin) {
    redirect(`/${locale}/login?redirect=/${locale}/admin/settings/stellar`);
  }

  // Fetch settings and health
  const settingsResult = await getStellarSettings();
  const usdcInfo = await getUSDCInfo(settingsResult.config.network);

  const messages = await getMessages({ locale });

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">
              {messages?.admin?.settings?.stellar?.title || 'Stellar Settings'}
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              {messages?.admin?.settings?.stellar?.subtitle || 'Configure Stellar network for USDC payouts'}
            </p>
          </div>

          {/* Stellar Configuration */}
          <StellarClient
            initialConfig={settingsResult.config}
            initialHealth={settingsResult.health}
            usdcInfo={usdcInfo}
          />
        </div>
      </div>
    </NextIntlClientProvider>
  );
}
