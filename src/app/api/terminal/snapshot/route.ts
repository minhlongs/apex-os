import { NextResponse } from 'next/server';
import {
  ARBITRAGE_OPPORTUNITIES,
  CHAIN_TREASURY_RAILS,
  D1_IMMUTABLE_AUDIT_LOGS,
  EXCHANGE_REBATES,
  KYC_ROLLING_TIERS,
  REFERRAL_TIERS,
  STITCH_PROJECT_METADATA,
  WEBHOOK_SANDBOX_PRESETS,
} from '@/data/stitch-terminal-data';

export async function GET() {
  return NextResponse.json(
    {
      status: 'LIVE_EDGE_SYNCED',
      syncedAt: new Date().toISOString(),
      project: STITCH_PROJECT_METADATA,
      summary: {
        totalSettledUsdc: 28450.8,
        annualArbitrageSavingsUsd: 4120.5,
        activeAffiliateTraders: 1284,
        nextBatchReadyUsdc: 1840.0,
        circuitBreakerState: 'CLOSED_HEALTHY',
        d1AuditTriggerState: 'ARMED_IMMUTABLE',
      },
      exchanges: EXCHANGE_REBATES,
      referralTiers: REFERRAL_TIERS,
      opportunities: ARBITRAGE_OPPORTUNITIES,
      rails: CHAIN_TREASURY_RAILS,
      kycTiers: KYC_ROLLING_TIERS,
      webhookPresets: WEBHOOK_SANDBOX_PRESETS,
      auditLogs: D1_IMMUTABLE_AUDIT_LOGS,
    },
    { status: 200 }
  );
}
