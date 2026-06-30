import { redirect } from 'next/navigation'

export async function generateStaticParams() {
  return [{ locale: 'vi' }, { locale: 'en' }]
}

export default async function LocaleRootPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  redirect(`/${locale}/landing`, 'replace')
}
