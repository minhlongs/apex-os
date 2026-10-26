'use client';

import React, { useState } from 'react';
import type { KycRollingTierItem } from '@/data/stitch-terminal-data';

export interface StitchComplianceFraudCommandProps {
  readonly kycTiers: readonly KycRollingTierItem[];
  readonly locale: 'en' | 'vi';
  readonly showTmaHighlight?: boolean;
}

export function StitchComplianceFraudCommand({
  kycTiers,
  locale,
  showTmaHighlight = false,
}: Readonly<StitchComplianceFraudCommandProps>) {
  const isVi = locale === 'vi';
  const [screenedWallet, setScreenedWallet] = useState<string>(
    '0x71C7656EC7ab88b098defB751B7401B5f6d8976F'
  );
  const [simulateSanctioned, setSimulateSanctioned] = useState<boolean>(false);

  return (
    <section
      aria-labelledby="compliance-heading"
      className="space-y-6 animate-fade-in"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {showTmaHighlight
              ? isVi
                ? 'MÀN HÌNH 5 · TELEGRAM MINI APP (@ApexOSBot) & BẢO MẬT HMAC'
                : 'SCREEN 5 · TELEGRAM MINI APP (@ApexOSBot) & VIRAL REFERRAL BOT'
              : isVi
                ? 'MÀN HÌNH 4 · TUÂN THỦ KYC 30 NGÀY, SÀNG LỌC OFAC & CHỐNG GIAN LẬN'
                : 'SCREEN 4 · KYC ROLLING CEILINGS, OFAC SANCTIONS & FRAUD SHIELD'}
          </p>
          <h2
            id="compliance-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {showTmaHighlight
              ? isVi
                ? 'Ứng Dụng Telegram Mini App (@ApexOSBot) & Ví Web3'
                : 'Telegram Mini App (@ApexOSBot) Touch Client & Viral Loop'
              : isVi
                ? 'Trung Tâm Kiểm Soát Tuân Thủ KYC, OFAC SDN & Chống Click Ảo'
                : 'KYC Compliance, OFAC Sanctions & Click Anomaly Command'}
          </h2>
        </div>
        <span className="rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-emerald">
          OFAC SDN LIST: SYNCED · 0 LEAKS
        </span>
      </header>

      {/* 30-Day Rolling KYC Ceiling Cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {kycTiers.map((tier) => (
          <article key={tier.tier} className="stitch-obsidian-card p-5">
            <div className="flex items-center justify-between">
              <span className="font-display text-base font-bold text-stitch-primary">
                KYC: {tier.tier}
              </span>
              <span className="rounded-md bg-stitch-well px-2.5 py-1 font-mono text-xs text-stitch-cyan">
                {tier.ceiling30dUsd}
              </span>
            </div>
            <p className="mt-2 text-xs text-stitch-muted">{tier.requiredDocs}</p>
            <div className="mt-4 flex items-center justify-between font-mono text-xs">
              <span className="text-stitch-muted">30d Rolling Usage:</span>
              <span className="font-bold text-stitch-primary stitch-tabular-nums">
                ${tier.currentUsageUsd.toLocaleString('en-US')} ({tier.utilizationPct}%)
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between font-mono text-xs">
              <span className="text-stitch-muted">AutoReleaseService:</span>
              <span
                className={
                  tier.autoReleaseEnabled ? 'text-stitch-emerald' : 'text-stitch-amber'
                }
              >
                {tier.autoReleaseEnabled ? 'AUTO_RELEASE_ON' : 'MANUAL_REVIEW'}
              </span>
            </div>
          </article>
        ))}
      </div>

      {/* OFAC SDN Sanctions Pre-Flight Screener + Click Velocity Fraud Defense */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <article className="stitch-obsidian-card p-6">
          <h3 className="text-lg font-display font-bold text-stitch-primary">
            {isVi
              ? 'SanctionsScreeningService · Sàng Lọc Danh Sách Cấm Vận OFAC SDN'
              : 'SanctionsScreeningService · OFAC SDN Pre-Flight Screener'}
          </h3>
          <p className="mt-1 text-xs text-stitch-muted">
            {isVi
              ? 'Tự động chuyển trạng thái sang compliance_blocked nếu trùng khớp danh sách trừng phạt'
              : 'Automatically transitions payout to compliance_blocked on SDN match'}
          </p>

          <div className="mt-4">
            <label
              htmlFor="ofac-wallet-input"
              className="block font-mono text-xs text-stitch-muted"
            >
              Screen Wallet Address
            </label>
            <input
              id="ofac-wallet-input"
              type="text"
              value={screenedWallet}
              onChange={(e) => setScreenedWallet(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-stitch-divider bg-stitch-well px-3 py-2 font-mono text-xs text-stitch-primary"
            />
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSimulateSanctioned(false)}
              className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-1.5 font-mono text-xs text-stitch-emerald"
            >
              Test Clean Wallet
            </button>
            <button
              type="button"
              onClick={() => {
                setSimulateSanctioned(true);
                setScreenedWallet('0x8576aCC5C05D6Ce88f4e49bf65BdF0C62F91353C');
              }}
              className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-1.5 font-mono text-xs text-stitch-crimson"
            >
              Simulate OFAC SDN Match
            </button>
          </div>

          <div
            aria-live="polite"
            className="mt-4 rounded-lg border border-stitch-border bg-stitch-canvas/70 p-3 font-mono text-xs"
          >
            {simulateSanctioned ? (
              <p className="font-bold text-stitch-crimson">
                BLOCKED (status = compliance_blocked) · Match: OFAC SDN Lazarus Cluster · Alert
                Dispatched
              </p>
            ) : (
              <p className="font-bold text-stitch-emerald">
                CLEAR (0 SDN / UN / EU Sanctions Hits) · Approved for BatchSettlementService
              </p>
            )}
          </div>
        </article>

        {/* Click Velocity Fraud Anomaly & Telegram Mini App Card */}
        <article className="stitch-obsidian-card p-6">
          <h3 className="text-lg font-display font-bold text-stitch-primary">
            {isVi
              ? 'Chống Gian Lận Click Ảo & Telegram Mini App (@ApexOSBot)'
              : 'Click Velocity Fraud Shield & Telegram Mini App (@ApexOSBot)'}
          </h3>
          <div className="mt-4 space-y-3 font-mono text-xs">
            <div className="flex items-center justify-between rounded-lg bg-stitch-well p-3">
              <span className="text-stitch-muted">Click Velocity Ceiling:</span>
              <span className="font-bold text-stitch-cyan">
                150 clicks/hr · &lt;2s Burst Guard
              </span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-stitch-well p-3">
              <span className="text-stitch-muted">Conversion Skew Detector:</span>
              <span className="font-bold text-stitch-emerald">
                &gt;10:1 Skew Auto-Hold Active
              </span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-stitch-well p-3">
              <span className="text-stitch-muted">Telegram Mini App HMAC Auth:</span>
              <span className="font-bold text-stitch-violet">
                WebAppData HMAC-SHA256 + $5.00 Viral Bonus
              </span>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
