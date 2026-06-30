import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import DealDetailClient from './DealDetailClient'
import { getDB } from '@/lib/db';
import type { D1Database } from '@/lib/db';
import type { AffiliateDeal } from '@/types/deal'

const locales = ['vi', 'en'] as const

// Transform deal name to slug
function nameToSlug(name: string): string {
  return name.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>
}): Promise<Metadata> {
  const { locale, slug } = await params

  // Skip DB access during build if no D1 binding available
  if (typeof globalThis.DB === 'undefined') {
    return {
      title: 'Deal - ApexOS',
      description: 'View exclusive cashback deals on ApexOS',
    }
  }

  const DB = getDB()
  if (!DB) {
    return {
      title: 'Deal Not Found - ApexOS',
    }
  }

  try {
    // Find deal by slug matching (simple approach)
    const deals = await DB.prepare(
      'SELECT name, description FROM deals WHERE is_active = 1'
    )
      .all<{ name: string; description: string | null }>()

    const deal = deals.results.find(d =>
      nameToSlug(d.name) === slug
    )

    if (!deal) {
      return {
        title: 'Deal Not Found - ApexOS',
      }
    }

    return {
      title: `${deal.name} - ApexOS`,
      description: deal.description?.slice(0, 160) || 'View this exclusive deal on ApexOS',
      keywords: ['cashback', 'affiliate', 'crypto', 'deal'],
      openGraph: {
        title: deal.name,
        description: deal.description?.slice(0, 160) || 'Exclusive cashback deal',
        type: 'website',
      },
    }
  } catch (error) {
    console.error('Error fetching deal for metadata:', error)
    return {
      title: 'Deal - ApexOS',
    }
  }
}

export async function generateStaticParams() {
  // Skip DB access during build if no D1 binding available
  if (typeof globalThis.DB === 'undefined') {
    return []
  }

  const DB = getDB()
  if (!DB) {
    return []
  }

  try {
    const deals = await DB.prepare(
      'SELECT name FROM deals WHERE is_active = 1'
    )
      .all<{ name: string }>()

    return deals.results.map((deal) => ({
      slug: nameToSlug(deal.name),
    }))
  } catch (error) {
    console.error('Error generating static params for deals:', error)
    return []
  }
}

// Force dynamic rendering since deals data can change
export const dynamic = 'force-dynamic'

export default async function DealDetailPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>
}) {
  const { locale, slug } = await params

  if (!locales.includes(locale as typeof locales[number])) {
    notFound()
  }

  const messages = await getMessages({ locale })

  // Fetch deal data
  const DB = getDB()
  if (!DB) {
    notFound()
  }

  // Find deal by slug (derived from name)
  const deals = await DB.prepare(
    `SELECT * FROM deals WHERE is_active = 1`
  )
    .all<AffiliateDeal>()

  const deal = deals.results.find(d => nameToSlug(d.name) === slug)

  if (!deal) {
    notFound()
  }

  // Transform to client format with sensible defaults
  const dealData: AffiliateDeal = {
    ...deal,
    slug,
    exchange: deal.exchange || 'General',
    category: deal.category || 'general',
    cashback_percent: deal.cashback_percent || deal.default_commission_rate * 100,
    risk_level: (deal.risk_level as 'low' | 'medium' | 'high') || 'medium',
  }

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <DealDetailClient deal={dealData} locale={locale} />
    </NextIntlClientProvider>
  )
}
