'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { useTranslations } from 'next-intl';
import { DollarSign, Users, MousePointerClick, TrendingUp, AlertTriangle } from 'lucide-react';
import { useRateLimitStatus } from '@/lib/api/hooks';
import { RateLimitAlert, RateLimitProgress } from '@/components/rate-limit/RateLimitAlert';
import { useToast } from '@/components/toast/ToastProvider';
import ExchangeKeysManager from '@/components/profile/ExchangeKeysManager';
import { error as logError } from '@/lib/logger';
import type { AffiliateStats } from '@/types/affiliate';

interface DashboardOverviewProps {
  locale: string;
}

export default function DashboardOverview({ locale }: DashboardOverviewProps) {
  const { user } = useAuth();
  const t = useTranslations('dashboard');
  const toast = useToast();
  const { isRateLimited, remaining, limit } = useRateLimitStatus();

  const [stats, setStats] = useState<AffiliateStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) {
      setLoading(false);
      return;
    }

    const fetchStats = async () => {
      try {
        const response = await fetch('/api/affiliate/dashboard', {
          credentials: 'include' // Send session cookie
        });

        // Check rate limit headers
        const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
        const retryAfter = response.headers.get('Retry-After');

        if (response.status === 429) {
          const data = await response.json();
          toast.addToast({
            type: 'warning',
            title: 'Rate Limit Exceeded',
            message: data.message || 'Too many requests. Please try again later.',
            persistent: true,
            countdown: data.retryAfter || 60
          });
          setError('Rate limited');
          setLoading(false);
          return;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        setStats(data.stats);
      } catch (err) {
        logError('Failed to fetch dashboard stats', { error: err instanceof Error ? err.message : String(err) });
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [user?.id, toast]);

  // Show rate limit alert if rate limited
  if (error === 'Rate limited' && isRateLimited) {
    return (
      <div className="space-y-6">
        <RateLimitAlert
          retryAfter={60}
          onRetry={() => {
            setLoading(true);
            setError(null);
            // Re-trigger fetch by toggling state
            window.location.reload();
          }}
          message="You've made too many requests to the dashboard API. Please wait before trying again."
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="bg-stitch-surface border border-stitch-border rounded-2xl p-6 animate-pulse">
              <div className="h-4 bg-stitch-well rounded w-1/2 mb-4"></div>
              <div className="h-8 bg-stitch-well rounded w-3/4"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-12 text-center">
        <h3 className="text-lg font-medium text-stitch-primary mb-2">{t('notAuthenticated.title')}</h3>
        <p className="text-stitch-muted mb-6">{t('notAuthenticated.description')}</p>
        <a
          href={`/${locale}/login`}
          className="inline-flex items-center justify-center bg-stitch-indigo text-white px-6 py-3 rounded-lg font-medium hover:bg-stitch-violet transition-colors"
        >
          {t('notAuthenticated.loginLink')}
        </a>
      </div>
    );
  }

  // User is logged in but not an affiliate yet
  if (user && (!stats || stats.total_clicks === 0 && stats.lifetime_earnings === 0)) {
    return (
      <div className="space-y-6">
        <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-8">
          <div className="text-center max-w-md mx-auto">
            <div className="w-16 h-16 bg-stitch-indigo/15 rounded-full flex items-center justify-center mx-auto mb-4">
              <TrendingUp className="w-8 h-8 text-stitch-indigo" />
            </div>
            <h3 className="text-xl font-bold text-stitch-primary mb-2">{t('welcome.title')}</h3>
            <p className="text-stitch-muted mb-6">{t('welcome.description')}</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <a
                href={`/${locale}/dashboard/affiliates`}
                className="inline-flex items-center justify-center bg-stitch-indigo text-white px-6 py-3 rounded-lg font-medium hover:bg-stitch-violet transition-colors"
              >
                {t('welcome.becomeAffiliate')}
              </a>
              <a
                href={`/${locale}/deals`}
                className="inline-flex items-center justify-center border border-stitch-border text-stitch-primary px-6 py-3 rounded-lg font-medium hover:bg-stitch-well transition-colors"
              >
                {t('welcome.browseDeals')}
              </a>
            </div>
          </div>
        </div>
        <ExchangeKeysManager locale={locale} />
      </div>
    );
  }

  // Affiliate user with stats
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const statCards = [
    {
      title: t('stats.lifetimeEarnings'),
      value: formatCurrency(stats?.lifetime_earnings || 0),
      change: stats?.pending_earnings ? `+${formatCurrency(stats.pending_earnings)} pending` : undefined,
      icon: DollarSign,
      color: 'bg-stitch-emerald/15 text-stitch-emerald',
    },
    {
      title: t('stats.pendingEarnings'),
      value: formatCurrency(stats?.pending_earnings || 0),
      change: stats?.total_conversions ? `${stats.total_conversions} conversions` : undefined,
      icon: TrendingUp,
      color: 'bg-stitch-cyan/15 text-stitch-cyan',
    },
    {
      title: t('stats.totalClicks'),
      value: (stats?.total_clicks || 0).toLocaleString(),
      change: stats?.conversion_rate ? `${(stats.conversion_rate * 100).toFixed(1)}% conversion` : undefined,
      icon: MousePointerClick,
      color: 'bg-stitch-violet/15 text-stitch-violet',
    },
    {
      title: t('stats.referrals'),
      value: (stats?.total_referrals || 0).toLocaleString(),
      change: `${stats?.direct_referrals || 0} direct, ${stats?.indirect_referrals || 0} indirect`,
      icon: Users,
      color: 'bg-stitch-amber/15 text-stitch-amber',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Rate Limit Status */}
      {limit > 0 && (
        <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-stitch-muted">
              <span>API Rate Limit:</span>
              {isRateLimited && (
                <span className="flex items-center gap-1 text-stitch-amber">
                  <AlertTriangle className="w-4 h-4" />
                  Limited
                </span>
              )}
            </div>
            <RateLimitProgress remaining={remaining} limit={limit} className="w-64" />
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((stat, index) => (
          <div key={index} className="bg-stitch-surface border border-stitch-border rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className={`p-2 rounded-lg ${stat.color}`}>
                <stat.icon className="w-5 h-5" />
              </div>
            </div>
            <div className="text-sm text-stitch-muted mb-1">{stat.title}</div>
            <div className="text-2xl font-bold font-mono text-stitch-primary">{stat.value}</div>
            {stat.change && (
              <div className="text-xs font-mono text-stitch-muted mt-2">{stat.change}</div>
            )}
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Share Link Card */}
        <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-stitch-primary mb-4">{t('quickActions.shareTitle')}</h3>
          <p className="text-sm text-stitch-muted mb-4">{t('quickActions.shareDescription')}</p>
          <a
            href={`/${locale}/dashboard/affiliates`}
            className="text-stitch-indigo hover:text-stitch-violet font-medium text-sm"
          >
            {t('quickActions.viewAffiliateDashboard')} →
          </a>
        </div>

        {/* Recent Conversions Preview */}
        <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-6 lg:col-span-2">
          <h3 className="text-lg font-semibold text-stitch-primary mb-4">{t('quickActions.recentActivity')}</h3>
          {stats && stats.total_conversions > 0 ? (
            <a
              href={`/${locale}/dashboard/conversions`}
              className="block text-stitch-indigo hover:text-stitch-violet"
            >
              {t('quickActions.viewAllConversions')} →
            </a>
          ) : (
            <p className="text-sm text-stitch-muted">{t('quickActions.noConversions')}</p>
          )}
        </div>
      </div>

      {/* Exchange API Keys Self-Service Linking */}
      <ExchangeKeysManager locale={locale} />
    </div>
  );
}
