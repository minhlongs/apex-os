/**
 * src/app/[locale]/admin/compliance/page.tsx
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Admin Compliance Review Dashboard Page
 *
 * Server component guarded by requireAdmin() with NextIntl support.
 */

import { redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ComplianceDashboard } from '@/components/admin/compliance/ComplianceDashboard';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const messages = await getMessages({ locale });

  return {
    title:
      (messages as any)?.admin?.compliance?.title ||
      'Compliance & Regulatory Review — ApexOS Admin',
    description:
      (messages as any)?.admin?.compliance?.subtitle ||
      'Inspect compliance-held payouts, manage AML sanctions watchlists, and review KYC verification.',
  };
}

export default async function AdminCompliancePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { locale } = await params;
  await searchParams;

  // Guard: require admin authentication
  const admin = await requireAdmin();
  if (!admin) {
    redirect(`/${locale}/login?redirect=/${locale}/admin/compliance`);
  }

  // Fetch localization messages
  const messages = await getMessages({ locale });

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <ComplianceDashboard locale={locale} />
    </NextIntlClientProvider>
  );
}
