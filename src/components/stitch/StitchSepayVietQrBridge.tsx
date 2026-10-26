'use client';

import React, { useState } from 'react';
import type {
  NowPaymentsPlanTier,
  SepayBankRailEntry,
} from '@/data/stitch-terminal-data';

export interface StitchSepayVietQrBridgeProps {
  readonly bankRails: readonly SepayBankRailEntry[];
  readonly planTiers: readonly NowPaymentsPlanTier[];
  readonly locale: 'en' | 'vi';
}

const FX_RATE_VND_PER_USDC = 25400;
const SEPAY_SETTLEMENT_FEE_RATE = 0.01; // Matches FEE_RATE = 0.01 in src/app/api/cron/route.ts

export function StitchSepayVietQrBridge({
  bankRails,
  planTiers,
  locale,
}: Readonly<StitchSepayVietQrBridgeProps>) {
  const isVi = locale === 'vi';

  const [usdcOfframpAmount, setUsdcOfframpAmount] = useState<number>(1000);
  const [selectedBankCode, setSelectedBankCode] = useState<'VCB' | 'TCB' | 'MB' | 'ACB'>('VCB');
  const [selectedPlan, setSelectedPlan] = useState<'BASIC' | 'PREMIUM' | 'ENTERPRISE' | 'MASTER'>('MASTER');

  const netUsdcAfterFee = usdcOfframpAmount * (1 - SEPAY_SETTLEMENT_FEE_RATE);
  const netVndPayout = Math.round(netUsdcAfterFee * FX_RATE_VND_PER_USDC);
  const activeBank = bankRails.find((b) => b.bankCode === selectedBankCode) ?? bankRails[0];
  const activePlan = planTiers.find((p) => p.planId === selectedPlan) ?? planTiers[3];

  return (
    <section
      aria-labelledby="sepay-vietqr-heading"
      className="space-y-6 animate-fade-in"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {isVi
              ? 'MÀN HÌNH 13 · CẦU NỐI THANH TOÁN SEPAY VIETQR 24/7 & NOWPAYMENTS IPN'
              : 'SCREEN 13 · SEPAY & VIETQR INSTANT VND ↔ USDC BRIDGE & NOWPAYMENTS BILLING'}
          </p>
          <h2
            id="sepay-vietqr-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {isVi
              ? 'Thanh Toán Tự Động SePay VietQR (NAPAS 247) & Nâng Cấp Gói VIP'
              : 'SePay VietQR Instant VND Off-Ramp & NOWPayments IPN Billing'}
          </h2>
        </div>
        <span className="rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-emerald">
          NAPAS 247 ONLINE · 25,400 VND/USDC · 1.0% FEE (`FEE_RATE = 0.01`)
        </span>
      </header>

      {/* 4 Hero Fiat-to-Crypto KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            30d SePay VietQR Volume
          </p>
          <p className="mt-2 text-2xl font-display font-bold text-stitch-primary stitch-tabular-nums">
            1.84B VND
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-cyan">
            $72,637.80 USDC Equivalent
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Selected NAPAS 247 Rail
          </p>
          <p className="mt-2 text-2xl font-display font-bold text-stitch-emerald stitch-tabular-nums">
            {activeBank.bankCode} · {activeBank.napasBin}
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-muted">
            Avg Webhook Reconciliation: {activeBank.avgSettlementSec}s
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Net VND Off-Ramp Payout
          </p>
          <p
            aria-live="polite"
            className="mt-2 text-2xl font-display font-bold text-stitch-emerald stitch-tabular-nums"
          >
            {netVndPayout.toLocaleString('en-US')} VND
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-cyan">
            Net ${netUsdcAfterFee.toFixed(2)} USDC (After 1% Fee)
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            NOWPayments Active Tier
          </p>
          <p
            aria-live="polite"
            className="mt-2 text-2xl font-display font-bold text-stitch-violet stitch-tabular-nums"
          >
            {activePlan.planId} (${activePlan.priceUsd}/mo)
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-emerald">
            IPN HMAC-SHA512 Verified
          </p>
        </article>
      </div>

      {/* Interactive SePay VietQR Off-Ramp Workbench */}
      <article className="stitch-obsidian-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stitch-border pb-4">
          <div>
            <h3 className="text-lg font-display font-bold text-stitch-primary">
              SePay VietQR &amp; NAPAS 247 Instant Bank Settlement (`payout_method = sepay`)
            </h3>
            <p className="text-xs text-stitch-muted">
              Select a Vietnamese NAPAS 247 bank rail and simulate instant USDC → VND affiliate payout conversion
            </p>
          </div>
          <div className="flex gap-2" role="group" aria-label="Select NAPAS 247 bank">
            {bankRails.map((bank) => (
              <button
                key={bank.bankCode}
                type="button"
                aria-pressed={selectedBankCode === bank.bankCode}
                onClick={() => setSelectedBankCode(bank.bankCode)}
                className={`rounded-lg px-3 py-1.5 font-mono text-xs transition-colors ${
                  selectedBankCode === bank.bankCode
                    ? 'bg-gradient-primary font-bold text-stitch-primary'
                    : 'border border-stitch-divider bg-stitch-well text-stitch-muted hover:text-stitch-primary'
                }`}
              >
                {bank.bankCode}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <div className="flex justify-between font-mono text-xs">
            <label htmlFor="sepay-usdc-slider" className="text-stitch-muted">
              Affiliate Earned Cashback to Convert (USDC):
            </label>
            <span className="font-bold text-stitch-cyan">
              ${usdcOfframpAmount.toLocaleString('en-US')} USDC
            </span>
          </div>
          <input
            id="sepay-usdc-slider"
            type="range"
            min={100}
            max={10000}
            step={100}
            value={usdcOfframpAmount}
            onChange={(e) => setUsdcOfframpAmount(Number(e.target.value))}
            className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-lg bg-stitch-well accent-primary-500"
          />
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stitch-border font-mono text-xs uppercase text-stitch-muted">
                <th className="py-3 pr-4">Bank Code</th>
                <th className="px-3 py-3">Institution Name</th>
                <th className="px-3 py-3">NAPAS BIN</th>
                <th className="px-3 py-3">Treasury Settlement Account</th>
                <th className="px-3 py-3">Avg Latency</th>
                <th className="px-3 py-3">Daily Limit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stitch-border font-mono text-xs">
              {bankRails.map((rail) => (
                <tr key={rail.bankCode} className="hover:bg-stitch-well/50">
                  <td className="py-3.5 pr-4 font-bold text-stitch-primary">{rail.bankCode}</td>
                  <td className="px-3 py-3.5 text-stitch-cyan">{rail.bankName}</td>
                  <td className="px-3 py-3.5 text-stitch-violet">{rail.napasBin}</td>
                  <td className="px-3 py-3.5 text-stitch-muted">{rail.accountMask}</td>
                  <td className="px-3 py-3.5 text-stitch-emerald">{rail.avgSettlementSec}s</td>
                  <td className="px-3 py-3.5 text-stitch-primary">{rail.dailyCapVnd}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      {/* NOWPayments IPN Tier Subscription Selector (/api/payments) */}
      <article className="stitch-obsidian-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stitch-border pb-4">
          <div>
            <h3 className="text-lg font-display font-bold text-stitch-primary">
              NOWPayments Tier Billing &amp; IPN Callback Matrix (`/api/payments` &amp; `/api/webhooks/ipn`)
            </h3>
            <p className="text-xs text-stitch-muted">
              Matches `PLAN_AMOUNTS` (`$9` / `$29` / `$99` / `$299`) and `x-nowpayments-sig` HMAC-SHA512 sorted-JSON verification
            </p>
          </div>
          <span className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-emerald">
            CALLBACK: /api/webhooks/ipn · PAY_CURRENCY: USDTERC20
          </span>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {planTiers.map((tier) => {
            const isSelected = selectedPlan === tier.planId;
            return (
              <button
                key={tier.planId}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelectedPlan(tier.planId)}
                className={`rounded-xl border p-4 text-left transition-all ${
                  isSelected
                    ? 'border-stitch-cyan bg-stitch-well shadow-md'
                    : 'border-stitch-border bg-stitch-surface hover:border-stitch-divider'
                }`}
              >
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className="font-bold text-stitch-primary">{tier.planId}</span>
                  <span className="text-stitch-cyan">${tier.priceUsd}/mo</span>
                </div>
                <p className="mt-2 font-mono text-[11px] text-stitch-muted">
                  {tier.rebateBoostLabel}
                </p>
              </button>
            );
          })}
        </div>
      </article>
    </section>
  );
}
