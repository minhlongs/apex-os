'use client'

import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/contexts/auth-context'
import type { AffiliateDeal } from '@/types/deal'
import {
  ArrowLeft,
  ExternalLink,
  Copy,
  Check,
} from 'lucide-react'

export default function DealDetailClient({
  deal,
  locale,
}: {
  deal: AffiliateDeal
  locale: string
}) {
  const { user } = useAuth()
  const [isRedirecting, setIsRedirecting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [referralCode, setReferralCode] = useState<string | null>(null)
  const t = useTranslations('deals')

  // Fetch affiliate's referral code if logged in
  useEffect(() => {
    if (user?.id) {
      fetch('/api/affiliate/dashboard')
        .then(res => res.json())
        .then(data => {
          if (data.profile?.referral_code) {
            setReferralCode(data.profile.referral_code)
          }
        })
        .catch(err => console.error('Failed to fetch referral code:', err))
    }
  }, [user?.id])

  const handleAffiliateClick = useCallback(async () => {
    if (isRedirecting) return
    setIsRedirecting(true)

    try {
      const response = await fetch(`/api/deals/${deal.id}/click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // No userId needed - auth is via session
      })

      if (response.ok) {
        const data = await response.json()
        window.location.href = data.redirectUrl || deal.url
      } else {
        window.location.href = deal.url
      }
    } catch {
      window.location.href = deal.url
    }
  }, [deal.id, deal.url, isRedirecting])

  const handleCopyReferralLink = useCallback(async () => {
    // Build affiliate share link that goes through tracking
    // Format: /api/tracking/click?deal_id={deal.id}&ref={referralCode}
    const trackingUrl = `${window.location.origin}/api/tracking/click?deal_id=${deal.id}${referralCode ? `&ref=${referralCode}` : ''}`
    try {
      await navigator.clipboard.writeText(trackingUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy link:', error)
    }
  }, [deal.id, referralCode])

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  const getExchangeIcon = (exchange: string | null) => {
    return exchange ? exchange.charAt(0).toUpperCase() : '?'
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-indigo-100">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-6">
          <Link href="/deals" className="inline-flex items-center text-brand-600 hover:text-brand-700 font-medium">
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t('backToDeals')}
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-lg p-6 md:p-8 mb-6">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-lg">
                {getExchangeIcon(deal.exchange)}
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-gray-500 uppercase">{deal.exchange}</span>
                  <span className="text-sm font-medium text-gray-500">•</span>
                  <span className="text-sm font-medium text-gray-500 uppercase">{deal.category}</span>
                  {deal.deal_type && (
                    <>
                      <span className="text-sm font-medium text-gray-500">•</span>
                      <span className="text-sm font-medium text-gray-500 capitalize">{deal.deal_type}</span>
                    </>
                  )}
                </div>
                <h1 className="text-2xl md:text-3xl font-bold text-gray-900">{deal.name}</h1>
              </div>
            </div>
          </div>

          {deal.description && (
            <p className="text-gray-600 text-lg mb-6">{deal.description}</p>
          )}

          <div className="bg-gradient-to-r from-brand-500 to-indigo-600 rounded-xl p-6 mb-8 text-white">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm opacity-80 mb-1">{t('cashback.title')}</div>
                <div className="text-4xl font-bold">{deal.cashback_percent}%</div>
                <div className="text-sm opacity-80 mt-1">{t('cashback.subtitle')}</div>
              </div>
              <div className="text-right">
                <div className="text-sm opacity-80 mb-1">{t('cookieDuration.title')}</div>
                <div className="text-2xl font-bold">{deal.cookie_duration_days} {t('cookieDuration.days')}</div>
              </div>
            </div>
          </div>

          <div className="border-t pt-6">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div>
                <div className="text-sm text-gray-500 mb-1">{t('cta.subtitle')}</div>
                <div className="font-medium text-gray-900">{t('cta.description')}</div>
              </div>
              <button
                onClick={handleAffiliateClick}
                disabled={isRedirecting}
                className="inline-flex items-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-6 py-3 rounded-xl font-medium transition-colors"
              >
                {isRedirecting ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    {t('cta.redirecting')}
                  </>
                ) : (
                  <>
                    {t('cta.claimDeal')}
                    <ExternalLink className="w-5 h-5" />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-lg p-6 md:p-8">
          <h2 className="text-xl font-bold text-gray-900 mb-4">{t('share.title')}</h2>
          <p className="text-gray-600 mb-4">{t('share.description')}</p>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 bg-gray-50 rounded-xl p-4 font-mono text-sm text-gray-700 break-all">
              {referralCode
                ? `${window.location.origin}/api/tracking/click?deal_id=${deal.id}&ref=${referralCode}`
                : `${window.location.origin}/api/tracking/click?deal_id=${deal.id}`}
            </div>
            <button
              onClick={handleCopyReferralLink}
              className="inline-flex items-center justify-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-700 px-6 py-3 rounded-xl font-medium transition-colors"
            >
              {copied ? (
                <>
                  <Check className="w-5 h-5 text-green-600" />
                  {t('share.copied')}
                </>
              ) : (
                <>
                  <Copy className="w-5 h-5" />
                  {t('share.copyLink')}
                </>
              )}
            </button>
          </div>

          <div className="mt-4 p-4 bg-amber-50 rounded-xl">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div className="text-sm text-amber-700">
                <p className="font-medium mb-1">{t('share.note.title')}</p>
                <p>{t('share.note.description')}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 text-center text-gray-500 text-sm">
          <p>{t('footer.disclaimer')}</p>
          <p className="mt-1">{t('footer.published', { date: formatDate(deal.created_at) })}</p>
        </div>
      </div>
    </div>
  )
}
