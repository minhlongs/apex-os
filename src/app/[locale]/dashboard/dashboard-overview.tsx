'use client';

import { useCallback, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { useRateLimitStatus } from '@/lib/api/hooks';
import { RateLimitAlert, RateLimitProgress } from '@/components/rate-limit/RateLimitAlert';
import NonCustodialUidPanel from '@/components/dashboard/non-custodial-uid-panel';
import ShortLinksGeneratorPanel from '@/components/dashboard/short-links-generator-panel';
import RebateLedgerWaterfallPanel from '@/components/dashboard/rebate-ledger-waterfall-panel';
import PayoutWalletTimelockPanel from '@/components/dashboard/payout-wallet-timelock-panel';
import type { AffiliateShortLinkItem } from '@/app/api/affiliate/short-links/route';

interface DashboardOverviewProps {
  locale: string;
}

export default function DashboardOverview({ locale }: DashboardOverviewProps) {
  const { user, loading: authLoading } = useAuth();
  const isVi = locale === 'vi';
  const { isRateLimited, remaining, limit } = useRateLimitStatus();

  const [shortLinks, setShortLinks] = useState<AffiliateShortLinkItem[]>([]);
  const [ledgerRefreshCounter, setLedgerRefreshCounter] = useState<number>(0);

  const triggerLedgerRefresh = useCallback(() => {
    setLedgerRefreshCounter((prev) => prev + 1);
  }, []);

  if (isRateLimited) {
    return (
      <div className="space-y-6">
        <RateLimitAlert
          retryAfter={60}
          onRetry={() => window.location.reload()}
          message="Too many requests to the Trader & Partner Portal API. Please wait before retrying."
        />
      </div>
    );
  }

  if (authLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map((idx) => (
            <div
              key={idx}
              className="bg-stitch-surface border border-stitch-border rounded-2xl p-6 animate-pulse"
            >
              <div className="h-4 bg-stitch-well rounded w-1/2 mb-4" />
              <div className="h-8 bg-stitch-well rounded w-3/4" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-12 text-center">
        <h3 className="text-lg font-medium text-stitch-primary mb-2">
          {isVi ? 'Yêu cầu đăng nhập' : 'Authentication Required'}
        </h3>
        <p className="text-stitch-muted mb-6">
          {isVi
            ? 'Vui lòng đăng nhập để truy cập Cổng Hoàn Phí Trader & Đối Tác B2B.'
            : 'Please sign in to access the Non-Custodial Trader & B2B Partner Rebate Portal.'}
        </p>
        <a
          href={`/${locale}/login`}
          className="inline-flex items-center justify-center bg-stitch-indigo text-white px-6 py-3 rounded-lg font-medium hover:bg-stitch-violet transition-colors"
        >
          {isVi ? 'Đăng nhập' : 'Sign In'}
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="ascendancy-trader-partner-portal">
      {/* Rate Limit Progress Indicator */}
      {remaining !== null && limit !== null && (
        <RateLimitProgress remaining={remaining} limit={limit} showLabel />
      )}

      {/* Non-Custodial Institutional Header */}
      <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-6 w-6 text-stitch-emerald shrink-0 mt-0.5" />
          <div>
            <h1 className="text-base sm:text-lg font-semibold text-stitch-primary">
              ApexOS Non-Custodial Trader &amp; B2B Partner Rebate Portal
            </h1>
            <p className="text-xs text-stitch-muted mt-0.5">
              Cash-basis double-entry USDC rebates across Bybit, OKX, Bitget, KuCoin, and Gate.io —
              powered by R2 Evidence Vault proofs and Turnkey MPC payouts on Stellar, Arbitrum, and Base.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center self-start sm:self-center rounded-full border border-stitch-emerald/30 bg-stitch-emerald/10 px-3 py-1 text-xs font-mono text-stitch-emerald">
          NON-CUSTODIAL • ZERO API KEYS
        </span>
      </div>

      {/* 1. 4-Bucket Atomic Ledger, T+7 Countdown, Proof-of-Rebate & 2-Level Partner Tree */}
      <RebateLedgerWaterfallPanel
        locale={locale}
        refreshTrigger={ledgerRefreshCounter}
      />

      {/* 2. Clean-Room /r/:code Partner Short-Links Generator */}
      <ShortLinksGeneratorPanel
        locale={locale}
        onShortLinksChanged={setShortLinks}
      />

      {/* 3. Read-Only Partner Exchange UID Binding */}
      <NonCustodialUidPanel
        locale={locale}
        shortLinks={shortLinks}
        onUidMutated={triggerLedgerRefresh}
      />

      {/* 4. 48-Hour Timelocked USDC Payout Wallet */}
      <PayoutWalletTimelockPanel
        locale={locale}
        onWalletMutated={triggerLedgerRefresh}
      />
    </div>
  );
}
