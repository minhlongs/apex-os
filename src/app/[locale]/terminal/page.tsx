import React from 'react';
import {
  ARBITRAGE_OPPORTUNITIES,
  CHAIN_TREASURY_RAILS,
  D1_IMMUTABLE_AUDIT_LOGS,
  EXCHANGE_REBATES,
  KYC_ROLLING_TIERS,
  REFERRAL_TIERS,
  STITCH_NAV_TABS,
  WEBHOOK_SANDBOX_PRESETS,
  resolveTerminalTab,
} from '@/data/stitch-terminal-data';
import { StitchTerminalShell } from '@/components/stitch/StitchTerminalShell';

export interface TerminalPageProps {
  readonly params?: Promise<{
    readonly locale?: string;
  }>;
  readonly searchParams?: Promise<{
    readonly tab?: string | readonly string[];
  }>;
}

export default async function StitchTerminalPage({
  params,
  searchParams,
}: Readonly<TerminalPageProps>) {
  const resolvedParams = params ? await params : undefined;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const initialLocale = resolvedParams?.locale === 'vi' ? 'vi' : 'en';
  const initialTab = resolveTerminalTab(resolvedSearchParams?.tab);

  return (
    <StitchTerminalShell
      initialLocale={initialLocale}
      initialTab={initialTab}
      navTabs={STITCH_NAV_TABS}
      exchanges={EXCHANGE_REBATES}
      referralTiers={REFERRAL_TIERS}
      opportunities={ARBITRAGE_OPPORTUNITIES}
      rails={CHAIN_TREASURY_RAILS}
      kycTiers={KYC_ROLLING_TIERS}
      webhookPresets={WEBHOOK_SANDBOX_PRESETS}
      auditLogs={D1_IMMUTABLE_AUDIT_LOGS}
    />
  );
}
