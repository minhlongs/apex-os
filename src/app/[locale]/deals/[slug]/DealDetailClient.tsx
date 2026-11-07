'use client';

import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/auth-context';
import type { AffiliateDeal } from '@/types/deal';
import {
  ArrowLeft,
  ExternalLink,
  Copy,
  Check,
  Shield,
} from 'lucide-react';

export default function DealDetailClient({
  deal,
  locale,
}: {
  deal: AffiliateDeal;
  locale: string;
}) {
  const { user } = useAuth();
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const t = useTranslations('deals');

  useEffect(() => {
    if (user?.id) {
      fetch('/api/affiliate/dashboard')
        .then((res) => res.json())
        .then((data) => {
          if (data.profile?.referral_code) {
            setReferralCode(data.profile.referral_code);
          }
        })
        .catch(() => {
          // Silently ignore unauthenticated or offline state
        });
    }
  }, [user?.id]);

  const handleAffiliateClick = useCallback(async () => {
    if (isRedirecting) return;
    setIsRedirecting(true);

    try {
      const response = await fetch(`/api/deals/${deal.id}/click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (response.ok) {
        const data = await response.json();
        window.location.href = data.redirectUrl || deal.url;
      } else {
        window.location.href = deal.url;
      }
    } catch {
      window.location.href = deal.url;
    }
  }, [deal.id, deal.url, isRedirecting]);

  const handleCopyReferralLink = useCallback(async () => {
    const trackingUrl = `${window.location.origin}/api/tracking/click?deal_id=${deal.id}${referralCode ? `&ref=${referralCode}` : ''}`;
    try {
      await navigator.clipboard.writeText(trackingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  }, [deal.id, referralCode]);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const getExchangeIcon = (exchange: string | null) => {
    return exchange ? exchange.charAt(0).toUpperCase() : '?';
  };

  return (
    <div className="min-h-screen bg-stitch-canvas text-stitch-primary">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-6">
          <Link
            href={`/${locale}/deals`}
            className="inline-flex items-center text-stitch-emerald hover:underline font-medium text-sm"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t('backToDeals')}
          </Link>
        </div>

        <div className="stitch-obsidian-card p-6 md:p-8 mb-6">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-stitch-well border border-stitch-divider flex items-center justify-center text-stitch-emerald font-bold text-lg font-mono">
                {getExchangeIcon(deal.exchange)}
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1 text-xs font-mono">
                  <span className="text-stitch-emerald uppercase">{deal.exchange}</span>
                  <span className="text-stitch-muted">•</span>
                  <span className="text-stitch-muted uppercase">{deal.category}</span>
                  {deal.deal_type && (
                    <>
                      <span className="text-stitch-muted">•</span>
                      <span className="text-stitch-muted capitalize">{deal.deal_type}</span>
                    </>
                  )}
                </div>
                <h1 className="text-2xl md:text-3xl font-bold text-stitch-primary">{deal.name}</h1>
              </div>
            </div>
          </div>

          {deal.description && (
            <p className="text-stitch-muted text-base mb-6 leading-relaxed">{deal.description}</p>
          )}

          <div className="bg-stitch-well border border-stitch-divider rounded-xl p-6 mb-8">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-mono uppercase tracking-wider text-stitch-muted mb-1">
                  {t('cashback.title')}
                </div>
                <div className="text-4xl font-bold font-mono text-stitch-emerald stitch-tabular-nums">
                  {deal.cashback_percent}%
                </div>
                <div className="text-xs text-stitch-muted mt-1">{t('cashback.subtitle')}</div>
              </div>
              <div className="text-right">
                <div className="text-xs font-mono uppercase tracking-wider text-stitch-muted mb-1">
                  {t('cookieDuration.title')}
                </div>
                <div className="text-2xl font-bold font-mono text-stitch-primary stitch-tabular-nums">
                  {deal.cookie_duration_days} {t('cookieDuration.days')}
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-stitch-divider pt-6">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div>
                <div className="text-xs font-mono uppercase tracking-wider text-stitch-emerald mb-1 flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5" />
                  {t('cta.subtitle')}
                </div>
                <div className="text-sm text-stitch-muted">{t('cta.description')}</div>
              </div>
              <button
                onClick={handleAffiliateClick}
                disabled={isRedirecting}
                className="inline-flex items-center gap-2 bg-stitch-emerald hover:opacity-90 disabled:opacity-50 text-slate-950 px-6 py-3 rounded-xl font-semibold transition-opacity text-sm"
              >
                {isRedirecting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                    {t('cta.redirecting')}
                  </>
                ) : (
                  <>
                    {t('cta.claimDeal')}
                    <ExternalLink className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="stitch-obsidian-card p-6 md:p-8">
          <h2 className="text-xl font-bold text-stitch-primary mb-2">{t('share.title')}</h2>
          <p className="text-stitch-muted text-sm mb-4">{t('share.description')}</p>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 bg-stitch-well border border-stitch-divider rounded-xl p-3.5 font-mono text-xs text-stitch-primary break-all">
              {referralCode
                ? `/api/tracking/click?deal_id=${deal.id}&ref=${referralCode}`
                : `/api/tracking/click?deal_id=${deal.id}`}
            </div>
            <button
              onClick={handleCopyReferralLink}
              className="inline-flex items-center justify-center gap-2 bg-stitch-well border border-stitch-divider hover:border-stitch-emerald text-stitch-primary px-6 py-3 rounded-xl font-medium transition-colors text-sm"
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 text-stitch-emerald" />
                  {t('share.copied')}
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  {t('share.copyLink')}
                </>
              )}
            </button>
          </div>

          <div className="mt-4 p-4 bg-stitch-well/60 border border-stitch-divider rounded-xl">
            <div className="text-xs text-stitch-muted">
              <p className="font-semibold text-stitch-primary mb-1">{t('share.note.title')}</p>
              <p>{t('share.note.description')}</p>
            </div>
          </div>
        </div>

        <div className="mt-8 text-center text-stitch-muted text-xs">
          <p>{t('footer.disclaimer')}</p>
          <p className="mt-1">{t('footer.published', { date: formatDate(deal.created_at) })}</p>
        </div>
      </div>
    </div>
  );
}
