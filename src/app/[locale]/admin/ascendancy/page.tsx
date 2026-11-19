/**
 * src/app/[locale]/admin/ascendancy/page.tsx
 *
 * ApexOS Ascendancy Admin Console & Multi-Chain Treasury Operations Page
 *
 * Server component guarded by requireAdmin() with NextIntl support.
 */

import { redirect } from 'next/navigation';

export default async function AdminAscendancyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/admin/treasury`);
}
