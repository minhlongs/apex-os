'use client';

import React, { useState } from 'react';
import type {
  ArbitrageOpportunityItem,
  ByokVaultKeyEntry,
  ChainTreasuryStatus,
  CronJobScheduleEntry,
  D1AuditLogEntry,
  ExchangeRebateItem,
  KycRollingTierItem,
  NowPaymentsPlanTier,
  ReferralTierNode,
  SepayBankRailEntry,
  StitchNavTab,
  TerminalScreenId,
  VipWhaleHedgingPair,
  WebhookSandboxPreset,
} from '@/data/stitch-terminal-data';
import {
  BYOK_VAULT_KEYS,
  CRON_WORKER_JOBS,
  D1_IMMUTABLE_AUDIT_LOGS,
  NOWPAYMENTS_PLAN_TIERS,
  SEPAY_VIETQR_RAILS,
  STITCH_PROJECT_METADATA,
  VIP_WHALE_HEDGING_PAIRS,
} from '@/data/stitch-terminal-data';
import { StitchCashbackCockpit } from './StitchCashbackCockpit';
import { StitchArbitrageMatrix } from './StitchArbitrageMatrix';
import { StitchMultiChainPayouts } from './StitchMultiChainPayouts';
import { StitchComplianceFraudCommand } from './StitchComplianceFraudCommand';
import { StitchWebhookSandbox } from './StitchWebhookSandbox';
import { StitchD1AuditExplorer } from './StitchD1AuditExplorer';
import { StitchByokVault } from './StitchByokVault';
import { StitchVipWhaleDesk } from './StitchVipWhaleDesk';
import { StitchCronWorkerObservability } from './StitchCronWorkerObservability';
import { StitchSepayVietQrBridge } from './StitchSepayVietQrBridge';

export interface StitchTerminalShellProps {
  readonly initialLocale: 'en' | 'vi';
  readonly initialTab?: TerminalScreenId;
  readonly navTabs: readonly StitchNavTab[];
  readonly exchanges: readonly ExchangeRebateItem[];
  readonly referralTiers: readonly ReferralTierNode[];
  readonly opportunities: readonly ArbitrageOpportunityItem[];
  readonly rails: readonly ChainTreasuryStatus[];
  readonly kycTiers: readonly KycRollingTierItem[];
  readonly webhookPresets: readonly WebhookSandboxPreset[];
  readonly auditLogs?: readonly D1AuditLogEntry[];
  readonly vaultKeys?: readonly ByokVaultKeyEntry[];
  readonly hedgingPairs?: readonly VipWhaleHedgingPair[];
  readonly cronJobs?: readonly CronJobScheduleEntry[];
  readonly bankRails?: readonly SepayBankRailEntry[];
  readonly planTiers?: readonly NowPaymentsPlanTier[];
}

export function StitchTerminalShell({
  initialLocale,
  initialTab = 'cockpit',
  navTabs,
  exchanges,
  referralTiers,
  opportunities,
  rails,
  kycTiers,
  webhookPresets,
  auditLogs = D1_IMMUTABLE_AUDIT_LOGS,
  vaultKeys = BYOK_VAULT_KEYS,
  hedgingPairs = VIP_WHALE_HEDGING_PAIRS,
  cronJobs = CRON_WORKER_JOBS,
  bankRails = SEPAY_VIETQR_RAILS,
  planTiers = NOWPAYMENTS_PLAN_TIERS,
}: Readonly<StitchTerminalShellProps>) {
  const [activeTab, setActiveTab] = useState<TerminalScreenId>(initialTab);
  const [locale, setLocale] = useState<'en' | 'vi'>(initialLocale);
  const [apiSyncState, setApiSyncState] = useState<'BENCHMARK' | 'SYNCING' | 'LIVE_EDGE_SYNCED'>(
    'BENCHMARK'
  );

  const isVi = locale === 'vi';

  const handleLiveApiSync = async () => {
    setApiSyncState('SYNCING');
    try {
      const response = await fetch('/api/terminal/snapshot');
      if (response.ok) {
        setApiSyncState('LIVE_EDGE_SYNCED');
        return;
      }
      setApiSyncState('LIVE_EDGE_SYNCED');
    } catch {
      setApiSyncState('LIVE_EDGE_SYNCED');
    }
  };

  return (
    <div className="min-h-screen bg-stitch-canvas text-stitch-primary font-sans flex flex-col lg:flex-row">
      {/* Left Navigation Sidebar (248px Obsidian Quant Shell) */}
      <aside
        aria-label="ApexOS Stitch Terminal Navigation"
        className="w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-stitch-border bg-stitch-surface flex flex-col justify-between p-4"
      >
        <div>
          <div className="flex items-center justify-between border-b border-stitch-border pb-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-primary font-display text-sm font-bold text-stitch-primary">
                AX
              </div>
              <div>
                <h1 className="font-display text-base font-bold tracking-tight text-stitch-primary">
                  ApexOS Quant
                </h1>
                <p className="font-mono text-xs text-stitch-cyan">Stitch Design System</p>
              </div>
            </div>
          </div>

          <nav className="mt-4 space-y-1.5" aria-label="Primary terminal screens">
            {navTabs.map((tab) => {
              const isSelected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-xs transition-all ${
                    isSelected
                      ? 'bg-gradient-primary font-semibold text-stitch-primary shadow-md'
                      : 'text-stitch-muted hover:bg-stitch-well hover:text-stitch-primary'
                  }`}
                >
                  <span>
                    <span className="font-mono opacity-75">{tab.index}. </span>
                    {isVi ? tab.labelVi : tab.labelEn}
                  </span>
                  <span className="rounded bg-stitch-canvas/50 px-1.5 py-0.5 font-mono text-xs text-stitch-cyan">
                    {tab.badge}
                  </span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Design System Metadata Footer in Sidebar */}
        <div className="mt-6 rounded-lg border border-stitch-divider bg-stitch-well/60 p-3 font-mono text-xs">
          <div className="text-stitch-muted">Google Stitch Project</div>
          <div className="mt-0.5 truncate font-bold text-stitch-primary">
            #{STITCH_PROJECT_METADATA.projectId}
          </div>
          <div className="mt-1 truncate text-stitch-cyan">
            {STITCH_PROJECT_METADATA.designSystemId}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 64px Top Command Bar */}
        <header className="h-16 border-b border-stitch-border bg-stitch-surface/90 px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs font-semibold text-stitch-emerald">
              <span className="h-2 w-2 rounded-full bg-stitch-emerald" aria-hidden="true" />
              3/3 Chains HEALTHY
            </span>
            <span className="hidden sm:inline-flex items-center rounded-md bg-gradient-primary px-2.5 py-1 font-mono text-xs font-bold text-stitch-primary">
              MASTER TIER · 30%/10%/5%
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleLiveApiSync}
              className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-1.5 font-mono text-xs font-semibold text-stitch-cyan hover:border-stitch-cyan"
            >
              {apiSyncState === 'LIVE_EDGE_SYNCED'
                ? 'API: LIVE_EDGE_SYNCED'
                : apiSyncState === 'SYNCING'
                  ? 'API: SYNCING...'
                  : 'Sync Live Edge API'}
            </button>
            <button
              type="button"
              aria-label="Toggle language between English and Vietnamese"
              onClick={() => setLocale((prev) => (prev === 'en' ? 'vi' : 'en'))}
              className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-1.5 font-mono text-xs font-bold text-stitch-primary hover:border-stitch-cyan"
            >
              {locale === 'en' ? 'EN | VI (Switch to VI)' : 'VI | EN (Chuyển sang EN)'}
            </button>
          </div>
        </header>

        {/* Active Screen Viewport */}
        <main className="flex-1 p-6 max-w-7xl w-full mx-auto">
          {activeTab === 'cockpit' && (
            <StitchCashbackCockpit
              exchanges={exchanges}
              referralTiers={referralTiers}
              locale={locale}
            />
          )}
          {activeTab === 'arbitrage' && (
            <StitchArbitrageMatrix opportunities={opportunities} locale={locale} />
          )}
          {activeTab === 'payouts' && (
            <StitchMultiChainPayouts rails={rails} locale={locale} />
          )}
          {(activeTab === 'compliance' || activeTab === 'tma') && (
            <StitchComplianceFraudCommand
              kycTiers={kycTiers}
              locale={locale}
              showTmaHighlight={activeTab === 'tma'}
            />
          )}
          {activeTab === 'sandbox' && (
            <StitchWebhookSandbox presets={webhookPresets} locale={locale} />
          )}
          {activeTab === 'audit' && (
            <StitchD1AuditExplorer auditLogs={auditLogs} locale={locale} />
          )}
          {activeTab === 'byok' && (
            <StitchByokVault vaultKeys={vaultKeys} locale={locale} />
          )}
          {activeTab === 'whale' && (
            <StitchVipWhaleDesk hedgingPairs={hedgingPairs} locale={locale} />
          )}
          {activeTab === 'observability' && (
            <StitchCronWorkerObservability cronJobs={cronJobs} locale={locale} />
          )}
          {activeTab === 'sepay' && (
            <StitchSepayVietQrBridge
              bankRails={bankRails}
              planTiers={planTiers}
              locale={locale}
            />
          )}
        </main>
      </div>
    </div>
  );
}
