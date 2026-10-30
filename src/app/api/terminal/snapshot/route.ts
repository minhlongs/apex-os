import { NextResponse } from 'next/server';
import {
  AI_ARBITRAGE_AGENTS,
  ARBITRAGE_OPPORTUNITIES,
  BYOK_VAULT_KEYS,
  CHAIN_TREASURY_RAILS,
  CRON_WORKER_JOBS,
  D1_IMMUTABLE_AUDIT_LOGS,
  EXCHANGE_REBATES,
  KYC_ROLLING_TIERS,
  NOWPAYMENTS_PLAN_TIERS,
  PRIME_API_GATEWAY_ROUTES,
  R2_MERKLE_SNAPSHOTS,
  REFERRAL_TIERS,
  SEPAY_VIETQR_RAILS,
  STITCH_PROJECT_METADATA,
  VIP_WHALE_HEDGING_PAIRS,
  WEBHOOK_SANDBOX_PRESETS,
} from '@/data/stitch-terminal-data';
import {
  calculateArbitrageMetrics,
  calculateVolumeSavings,
} from '@/lib/arbitrage/math';
import { sanctionsScreeningService } from '@/lib/compliance/sanctions-service';
import {
  DEFAULT_ALERT_CONFIGS,
  SLOW_QUERY_THRESHOLD_MS,
} from '@/lib/monitoring/d1-monitor';
import { WebhookCrypto, sha256Hash } from '@/lib/webhooks/crypto';

export async function GET() {
  // Execute real domain services from src/lib/*
  const liveArbitrage = calculateArbitrageMetrics(0.00065, 0, 0.0004, 50);
  const benchmark150k = calculateVolumeSavings(liveArbitrage.spreadBps, 150000);
  const sampleSanctionCheck = await sanctionsScreeningService.checkAddress(
    '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b',
    'ethereum'
  );
  const hmacSecret = process.env.TERMINAL_HMAC_SECRET || 'paper_sandbox_secret';
  const sampleHmacDigest = await WebhookCrypto.computeSignature(
    WEBHOOK_SANDBOX_PRESETS[0].samplePayload,
    hmacSecret
  );
  const r2RootProofDigest = await sha256Hash(
    R2_MERKLE_SNAPSHOTS[0].r2ObjectKey + ':' + R2_MERKLE_SNAPSHOTS[0].merkleRootHash
  );

  return NextResponse.json(
    {
      status: 'PAPER_SANDBOX_ONLINE',
      mode: 'DEMO_SANDBOX',
      syncedAt: new Date().toISOString(),
      project: STITCH_PROJECT_METADATA,
      liveEngineVerification: {
        arbitrageEngineSpreadBps: liveArbitrage.spreadBps,
        benchmark150kAnnualSavingsUsd: benchmark150k.annual,
        ofacWatchlistActive: sampleSanctionCheck.isSanctioned,
        webCryptoHmacSampleDigest: sampleHmacDigest,
        d1SlowQueryThresholdMs: SLOW_QUERY_THRESHOLD_MS,
        d1DefaultAlertConfigCount: DEFAULT_ALERT_CONFIGS.length,
        r2LatestSnapshotDigest: r2RootProofDigest,
        aiSwarmArmedCount: AI_ARBITRAGE_AGENTS.length,
        primeGatewayRouteCount: PRIME_API_GATEWAY_ROUTES.length,
      },
      summary: {
        totalSettledUsdc: 28450.8,
        annualArbitrageSavingsUsd: benchmark150k.annual,
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
      vaultKeys: BYOK_VAULT_KEYS,
      hedgingPairs: VIP_WHALE_HEDGING_PAIRS,
      cronJobs: CRON_WORKER_JOBS,
      d1AlertConfigs: DEFAULT_ALERT_CONFIGS,
      sepayBankRails: SEPAY_VIETQR_RAILS,
      nowPaymentsPlans: NOWPAYMENTS_PLAN_TIERS,
      r2Snapshots: R2_MERKLE_SNAPSHOTS,
      aiAgents: AI_ARBITRAGE_AGENTS,
      primeGatewayRoutes: PRIME_API_GATEWAY_ROUTES,
    },
    { status: 200 }
  );
}
