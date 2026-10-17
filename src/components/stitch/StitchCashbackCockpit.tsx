import React from 'react';
import type { ExchangeRebateItem, ReferralTierNode } from '@/data/stitch-terminal-data';

export interface StitchCashbackCockpitProps {
  readonly exchanges: readonly ExchangeRebateItem[];
  readonly referralTiers: readonly ReferralTierNode[];
  readonly locale: 'en' | 'vi';
}

export function StitchCashbackCockpit({
  exchanges,
  referralTiers,
  locale,
}: Readonly<StitchCashbackCockpitProps>) {
  const isVi = locale === 'vi';

  const totalSettled = exchanges.reduce((sum, item) => sum + item.settledUsdc, 0);
  const totalPending = exchanges.reduce((sum, item) => sum + item.pendingUsdc, 0);
  const totalAffiliateEarned = referralTiers.reduce((sum, t) => sum + t.earnedUsdc, 0);
  const totalTraders = referralTiers.reduce((sum, t) => sum + t.activeTraders, 0);

  return (
    <section
      aria-labelledby="cockpit-heading"
      className="space-y-6 animate-fade-in"
    >
      {/* Top Section Header */}
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {isVi
              ? 'MÀN HÌNH 1 · BUỒNG LÁI HOÀN PHÍ & HOA HỒNG 3 TUYẾN'
              : 'SCREEN 1 · MULTI-EXCHANGE REBATE & 3-TIER AFFILIATE COCKPIT'}
          </p>
          <h2
            id="cockpit-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {isVi
              ? 'Tổng Quan Hoàn Phí & Thanh Toán Tự Động'
              : 'Executive Cashback & Multi-Exchange Settlement'}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 text-xs font-mono text-stitch-emerald">
            <span className="h-2 w-2 rounded-full bg-stitch-emerald" aria-hidden="true" />
            HMAC-SHA256 STREAM ACTIVE
          </span>
        </div>
      </header>

      {/* 4 Hero KPI Bento Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-stitch-muted">
            {isVi ? 'Tổng Hoàn Phí Đã Thanh Toán' : 'Total Settled Cashback'}
          </p>
          <p className="mt-2 text-3xl font-display font-bold stitch-tabular-nums text-stitch-primary">
            ${totalSettled.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            <span className="ml-1.5 text-xs font-mono text-stitch-emerald">USDC</span>
          </p>
          <p className="mt-2 text-xs text-stitch-emerald font-mono">
            +18.4% vs 30d · D1 Atomic Verified
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-stitch-muted">
            {isVi ? 'Tiết Kiệm Chênh Lệch Phí Năm' : 'Annualized Arbitrage Savings'}
          </p>
          <p className="mt-2 text-3xl font-display font-bold stitch-tabular-nums text-stitch-cyan">
            $4,120.50
            <span className="ml-1.5 text-xs font-mono text-stitch-primary">/ yr</span>
          </p>
          <p className="mt-2 text-xs text-stitch-muted font-mono">
            +34.2% Net Fee Reduction (bps)
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-stitch-muted">
            {isVi ? 'Mạng Lưới Affiliate 3 Tuyến' : '3-Tier Affiliate Network'}
          </p>
          <p className="mt-2 text-3xl font-display font-bold stitch-tabular-nums text-stitch-primary">
            {totalTraders.toLocaleString('en-US')}
            <span className="ml-1.5 text-xs font-mono text-stitch-violet">Traders</span>
          </p>
          <p className="mt-2 text-xs text-stitch-violet font-mono">
            30% L1 · 10% L2 · 5% L3 (${totalAffiliateEarned.toLocaleString('en-US')} USDC)
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-stitch-muted">
            {isVi ? 'Lô Thanh Toán Tự Động Kế Tiếp' : 'Next Automated Batch Payout'}
          </p>
          <p className="mt-2 text-3xl font-display font-bold stitch-tabular-nums text-stitch-emerald">
            ${totalPending.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            <span className="ml-1.5 text-xs font-mono text-stitch-muted">Ready</span>
          </p>
          <p className="mt-2 text-xs text-stitch-amber font-mono">
            Threshold $50.00 Met · Stellar / Solana
          </p>
        </article>
      </div>

      {/* Main Split Grid: Multi-Exchange Rebate Matrix + 3-Tier Referral Tree */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Multi-Exchange Rebate Matrix (2 cols) */}
        <article
          aria-labelledby="exchange-matrix-title"
          className="stitch-obsidian-card p-6 lg:col-span-2"
        >
          <div className="flex items-center justify-between border-b border-stitch-border pb-4">
            <div>
              <h3
                id="exchange-matrix-title"
                className="text-lg font-display font-bold text-stitch-primary"
              >
                {isVi
                  ? 'Ma Trận Hoàn Phí Đa Sàn (Binance · Bybit · OKX · KuCoin)'
                  : 'Multi-Exchange Rebate & Webhook Verification Matrix'}
              </h3>
              <p className="text-xs text-stitch-muted">
                {isVi
                  ? 'Đồng bộ thời gian thực qua Web Crypto HMAC-SHA256'
                  : 'Real-time trade fee ingestion verified via Web Crypto HMAC-SHA256'}
              </p>
            </div>
            <span className="rounded-md bg-stitch-well px-2.5 py-1 text-xs font-mono text-stitch-cyan">
              4/4 Exchanges Connected
            </span>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-stitch-border text-xs font-mono uppercase text-stitch-muted">
                  <th className="py-3 pr-4">{isVi ? 'Sàn Giao Dịch' : 'Exchange'}</th>
                  <th className="px-3 py-3">{isVi ? 'Phí Maker/Taker' : 'Maker / Taker'}</th>
                  <th className="px-3 py-3">{isVi ? 'Tỷ Lệ Hoàn' : 'Rebate %'}</th>
                  <th className="px-3 py-3">{isVi ? 'Đã Nhận (USDC)' : 'Settled (USDC)'}</th>
                  <th className="px-3 py-3">{isVi ? 'Chữ Ký Webhook' : 'Webhook Auth'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stitch-border">
                {exchanges.map((ex) => (
                  <tr
                    key={ex.exchangeId}
                    className="transition-colors hover:bg-stitch-well/50"
                  >
                    <td className="py-3.5 pr-4">
                      <div className="font-semibold text-stitch-primary">{ex.name}</div>
                      <div className="text-xs text-stitch-muted">{ex.tierLabel}</div>
                    </td>
                    <td className="px-3 py-3.5 font-mono text-xs stitch-tabular-nums text-stitch-primary">
                      {ex.makerFeeBps.toFixed(1)} / {ex.takerFeeBps.toFixed(1)} bps
                    </td>
                    <td className="px-3 py-3.5">
                      <span className="inline-flex items-center rounded-full bg-stitch-well px-2.5 py-0.5 font-mono text-xs font-semibold text-stitch-cyan">
                        {ex.cashbackPct}% Rebate
                      </span>
                    </td>
                    <td className="px-3 py-3.5 font-mono text-sm font-semibold stitch-tabular-nums text-stitch-emerald">
                      ${ex.settledUsdc.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-3 py-3.5">
                      <div className="font-mono text-xs text-stitch-muted">
                        {ex.webhookAuthHeader}
                      </div>
                      <div className="text-xs font-mono text-stitch-emerald">
                        {ex.status} · {ex.latencyMs}ms
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        {/* 3-Tier Affiliate Commission Tree (1 col) */}
        <article
          aria-labelledby="referral-tree-title"
          className="stitch-obsidian-card p-6"
        >
          <div className="border-b border-stitch-border pb-4">
            <h3
              id="referral-tree-title"
              className="text-lg font-display font-bold text-stitch-primary"
            >
              {isVi
                ? 'Cây Hoa Hồng 3 Tuyến (30% / 10% / 5%)'
                : '3-Tier Referral Tree (30% / 10% / 5%)'}
            </h3>
            <p className="text-xs text-stitch-muted">
              {isVi
                ? 'Chống vòng lặp giới thiệu tự động (Max Depth = 3)'
                : 'Circular-referral guarded graph (Max Depth = 3)'}
            </p>
          </div>

          <div className="mt-4 space-y-4">
            {referralTiers.map((tier) => (
              <div
                key={tier.level}
                className="rounded-lg border border-stitch-divider bg-stitch-well/60 p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-stitch-primary">
                    {isVi ? tier.labelVi : tier.labelEn}
                  </span>
                  <span className="rounded-full bg-gradient-primary px-2.5 py-0.5 font-mono text-xs font-bold text-stitch-primary">
                    {tier.commissionRatePct}% Split
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-mono">
                  <div>
                    <span className="text-stitch-muted">
                      {isVi ? 'Nhà Giao Dịch:' : 'Active Traders:'}
                    </span>{' '}
                    <span className="text-stitch-primary font-semibold">
                      {tier.activeTraders}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-stitch-muted">30d Vol:</span>{' '}
                    <span className="text-stitch-cyan">
                      ${(tier.volume30dUsd / 1_000_000).toFixed(1)}M
                    </span>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-stitch-border pt-2 text-xs font-mono">
                  <span className="text-stitch-muted">
                    {isVi ? 'Hoa Hồng Đã Chia' : 'Settled Commission'}
                  </span>
                  <span className="font-bold text-stitch-emerald">
                    +${tier.earnedUsdc.toLocaleString('en-US', { minimumFractionDigits: 2 })} USDC
                  </span>
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}
