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
} from '@/data/stitch-terminal-data';
import { StitchTerminalShell } from '@/components/stitch/StitchTerminalShell';

export interface TerminalPageProps {
  readonly params: {
    readonly locale: string;
  };
}

export default function StitchTerminalPage({ params }: Readonly<TerminalPageProps>) {
  const initialLocale = params?.locale === 'vi' ? 'vi' : 'en';

  return (
    <StitchTerminalShell
      initialLocale={initialLocale}
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
