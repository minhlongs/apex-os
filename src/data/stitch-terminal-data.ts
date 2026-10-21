/**
 * Decoupled Domain Data & Type Contracts for ApexOS Stitch Obsidian Quant Terminal
 * Generated via stitch-nextjs-components from Google Stitch Project 11542622336933833737
 */

export type TerminalLocale = 'en' | 'vi';

export type TerminalScreenId =
  | 'cockpit'
  | 'arbitrage'
  | 'payouts'
  | 'compliance'
  | 'tma'
  | 'sandbox'
  | 'audit'
  | 'byok'
  | 'whale'
  | 'observability'
  | 'sepay'
  | 'r2'
  | 'aibot'
  | 'gateway';

export interface PrimeApiGatewayRouteEntry {
  readonly routeId: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly protocol: 'REST_EDGE' | 'FIX_4_4' | 'WS_STREAM';
  readonly tierName: string;
  readonly burstCapacityRpm: number;
  readonly refillRatePerSec: number;
  readonly p99LatencyMs: number;
  readonly status: 'KV_TOKEN_BUCKET_ACTIVE';
}

export interface R2MerkleSnapshotEntry {
  readonly snapshotId: string;
  readonly r2ObjectKey: string;
  readonly rowCount: number;
  readonly compressedSizeMb: number;
  readonly merkleRootHash: string;
  readonly retentionUntil: string;
  readonly status: 'WORM_SEALED_R2';
}

export interface AiArbitrageAgentEntry {
  readonly agentId: 'scanner-alpha' | 'hedger-beta' | 'sentinel-gamma' | 'settler-delta';
  readonly agentName: string;
  readonly roleSummary: string;
  readonly minSpreadTriggerBps: number;
  readonly maxSlippageGuardBps: number;
  readonly captured24hUsdc: number;
  readonly status: 'ARMED_RUNNING';
}

export interface SepayBankRailEntry {
  readonly bankCode: 'VCB' | 'TCB' | 'MB' | 'ACB';
  readonly bankName: string;
  readonly napasBin: string;
  readonly accountMask: string;
  readonly avgSettlementSec: number;
  readonly dailyCapVnd: string;
  readonly status: 'NAPAS_247_ONLINE';
}

export interface NowPaymentsPlanTier {
  readonly planId: 'BASIC' | 'PREMIUM' | 'ENTERPRISE' | 'MASTER';
  readonly priceUsd: number;
  readonly slug: string;
  readonly rebateBoostLabel: string;
  readonly callbackPath: string;
}

export interface CronJobScheduleEntry {
  readonly jobId: 'alerts' | 'email-queue' | 'd1-metrics' | 'email-retry' | 'analytics-refresh' | 'payouts' | 'campaigns';
  readonly cronExpression: string;
  readonly cadenceLabel: string;
  readonly endpoint: string;
  readonly handlerName: string;
  readonly lastDurationMs: number;
  readonly lastOutputSummary: string;
  readonly status: 'HEALTHY' | 'IDLE_READY';
}

export interface VipWhaleHedgingPair {
  readonly symbol: 'BTC-PERP' | 'ETH-PERP' | 'SOL-PERP';
  readonly longVenue: string;
  readonly shortVenue: string;
  readonly fundingSpread8hBps: number;
  readonly makerRebateBps: number;
  readonly combinedNetApyPct: number;
}

export interface ByokVaultKeyEntry {
  readonly exchangeId: 'binance' | 'bybit' | 'okx' | 'kucoin';
  readonly exchangeName: string;
  readonly keyFingerprint: string;
  readonly scopes: string;
  readonly rotatedAgo: string;
  readonly status: 'SEALED_AES_GCM';
}

export interface StitchNavTab {
  readonly id: TerminalScreenId;
  readonly index: number;
  readonly labelEn: string;
  readonly labelVi: string;
  readonly badge: string;
  readonly stitchScreenId: string;
  readonly staticHtmlPath: string;
}

export interface ExchangeRebateItem {
  readonly exchangeId: 'binance' | 'bybit' | 'okx' | 'kucoin';
  readonly name: string;
  readonly tierLabel: string;
  readonly makerFeeBps: number;
  readonly takerFeeBps: number;
  readonly cashbackPct: number;
  readonly settledUsdc: number;
  readonly pendingUsdc: number;
  readonly webhookAuthHeader: string;
  readonly latencyMs: number;
  readonly status: 'VERIFIED' | 'SYNCING';
}

export interface ReferralTierNode {
  readonly level: 1 | 2 | 3;
  readonly labelEn: string;
  readonly labelVi: string;
  readonly commissionRatePct: number;
  readonly activeTraders: number;
  readonly volume30dUsd: number;
  readonly earnedUsdc: number;
}

export interface ArbitrageOpportunityItem {
  readonly id: string;
  readonly pair: string;
  readonly buyExchange: string;
  readonly sellExchange: string;
  readonly grossSpreadBps: number;
  readonly netAfterRebateBps: number;
  readonly dealType: 'FEE_SPREAD' | 'CASHBACK_MAX' | 'VIP_PROMOTION';
  readonly estimatedAnnualSavingsUsd: number;
  readonly confidencePct: number;
}

export interface ChainTreasuryStatus {
  readonly chainId: 'stellar' | 'ethereum' | 'solana';
  readonly name: string;
  readonly railProtocol: string;
  readonly hotWalletAddress: string;
  readonly usdcReserve: number;
  readonly nativeGasBalance: string;
  readonly nativeGasFloor: string;
  readonly avgSettlementSec: number;
  readonly networkFeeUsd: number;
  readonly healthStatus: 'HEALTHY' | 'LOW_RESERVE' | 'CRITICAL';
}

export interface KycRollingTierItem {
  readonly tier: 'UNVERIFIED' | 'BASIC' | 'ENHANCED' | 'INSTITUTIONAL';
  readonly ceiling30dUsd: string;
  readonly currentUsageUsd: number;
  readonly utilizationPct: number;
  readonly autoReleaseEnabled: boolean;
  readonly requiredDocs: string;
}

export interface WebhookSandboxPreset {
  readonly providerId: 'binance' | 'bybit' | 'okx' | 'kucoin' | 'nowpayments';
  readonly providerName: string;
  readonly algorithm: 'HMAC-SHA256 (Hex)' | 'HMAC-SHA256 (Base64)' | 'HMAC-SHA512 (Sorted JSON)';
  readonly signatureHeader: string;
  readonly timestampHeader: string;
  readonly replayWindow: string;
  readonly samplePayload: string;
  readonly sampleSignature: string;
  readonly tradeVolumeUsd: number;
  readonly exchangeFeeUsd: number;
}

export interface D1AuditLogEntry {
  readonly logId: string;
  readonly payoutId: string;
  readonly userId: string;
  readonly chain: 'STELLAR' | 'ETHEREUM' | 'SOLANA';
  readonly amountUsdc: number;
  readonly previousStatus: 'NONE' | 'pending' | 'Reserved_D1' | 'processing';
  readonly newStatus: 'pending' | 'Reserved_D1' | 'processing' | 'completed' | 'compliance_blocked';
  readonly idempotencyHash: string;
  readonly merkleLeafHash: string;
  readonly txHashOrReason: string;
  readonly createdAtIso: string;
}

export const STITCH_PROJECT_METADATA = {
  projectId: '11542622336933833737',
  designSystemId: 'assets/16812736714591355271',
  themeName: 'ApexOS Obsidian Quant & Cyber-Cashback',
  projectUrl: 'https://stitch.withgoogle.com/projects/11542622336933833737',
} as const;

export const STITCH_NAV_TABS: readonly StitchNavTab[] = [
  {
    id: 'cockpit',
    index: 1,
    labelEn: 'Cashback Cockpit',
    labelVi: 'Buồng Lái Hoàn Phí',
    badge: '$28.4k',
    stitchScreenId: 'dba3be1aab6c47e9a70c314f39a7c877',
    staticHtmlPath: '/index.html',
  },
  {
    id: 'arbitrage',
    index: 2,
    labelEn: 'Arbitrage & Deals',
    labelVi: 'Chênh Lệch Phí & Săn Deal',
    badge: '+24.8 bps',
    stitchScreenId: '02984cc58005482e900bebb9a136929f',
    staticHtmlPath: '/arbitrage-deals.html',
  },
  {
    id: 'payouts',
    index: 3,
    labelEn: 'Multi-Chain Payouts',
    labelVi: 'Thanh Toán Đa Chuỗi',
    badge: '3/3 Rails',
    stitchScreenId: '53abd8e29f434dfcba0c956707e07b1d',
    staticHtmlPath: '/multichain-payouts.html',
  },
  {
    id: 'compliance',
    index: 4,
    labelEn: 'KYC & Fraud Shield',
    labelVi: 'Tuân Thủ KYC & Chống Gian Lận',
    badge: 'OFAC Clean',
    stitchScreenId: '5f9ae96775c14d46b812ac5126dd5916',
    staticHtmlPath: '/compliance-fraud.html',
  },
  {
    id: 'tma',
    index: 5,
    labelEn: 'Telegram Mini App',
    labelVi: 'Siêu Ứng Dụng Telegram',
    badge: '@ApexOSBot',
    stitchScreenId: '1cacd26543d84119a4455bf669605261',
    staticHtmlPath: '/telegram-mini-app.html',
  },
  {
    id: 'sandbox',
    index: 7,
    labelEn: 'Webhook & Surge Lab',
    labelVi: 'Phòng Thí Nghiệm Webhook & Gas',
    badge: 'HMAC / EIP-1559',
    stitchScreenId: '5107ac145136463bac751876243e8bc6',
    staticHtmlPath: '/webhook-replay-sandbox.html',
  },
  {
    id: 'audit',
    index: 9,
    labelEn: 'D1 Audit Explorer',
    labelVi: 'Kiểm Toán D1 Bất Biến',
    badge: 'SQLite Trigger',
    stitchScreenId: 'e0cdfaa55c544e52b96b5c5a47333c82',
    staticHtmlPath: '/immutable-d1-audit-explorer.html',
  },
  {
    id: 'byok',
    index: 10,
    labelEn: 'BYOK Key Vault',
    labelVi: 'Két Mã Hóa BYOK',
    badge: 'AES-GCM-256',
    stitchScreenId: '3db8be97403844ccba6cfb32d913cf3f',
    staticHtmlPath: '/byok-encryption-vault.html',
  },
  {
    id: 'whale',
    index: 11,
    labelEn: 'VIP Whale OTC Desk',
    labelVi: 'Bàn Cá Voi VIP & Hedging',
    badge: '+18.6% APY',
    stitchScreenId: '11d9383ced1b4d5eb014541ee446d8c3',
    staticHtmlPath: '/vip-whale-otc-desk.html',
  },
  {
    id: 'observability',
    index: 12,
    labelEn: 'Cron & D1 Observability',
    labelVi: 'Giám Sát Cron & Độ Trễ D1',
    badge: '7/7 Crons OK',
    stitchScreenId: '10070b9dbac74e5a8541046ded082ee5',
    staticHtmlPath: '/cron-worker-observability.html',
  },
  {
    id: 'sepay',
    index: 13,
    labelEn: 'SePay & VietQR Bridge',
    labelVi: 'Cầu Nối SePay & VietQR',
    badge: 'NAPAS 247',
    stitchScreenId: 'bcc8931a70524cf2bbbc639ad118dbc6',
    staticHtmlPath: '/sepay-vietqr-bank-bridge.html',
  },
  {
    id: 'r2',
    index: 14,
    labelEn: 'R2 Merkle Archiver',
    labelVi: 'Lưu Trữ R2 & Merkle Proof',
    badge: '$0 Egress',
    stitchScreenId: '69f95085b49c4c2fb0cb16faf09fd1fd',
    staticHtmlPath: '/r2-merkle-snapshot-archiver.html',
  },
  {
    id: 'aibot',
    index: 15,
    labelEn: 'AI Arbitrage Bot',
    labelVi: 'Bot Arbitrage Đa Tác Tử',
    badge: '4/4 Agents',
    stitchScreenId: '4fbb8caa49cd4706bdd8510593bdf779',
    staticHtmlPath: '/ai-agent-arbitrage-bot.html',
  },
  {
    id: 'gateway',
    index: 16,
    labelEn: 'Prime API Gateway',
    labelVi: 'Cổng API Định Chế & KV Rate Limit',
    badge: 'KV Token-Bucket',
    stitchScreenId: '2c5e0ed6396e4de7bb74d3204f2a20d2',
    staticHtmlPath: '/institutional-prime-api-gateway.html',
  },
] as const;

export function resolveTerminalTab(
  tabParam?: string | readonly string[] | null
): TerminalScreenId {
  const candidate = Array.isArray(tabParam) ? tabParam[0] : tabParam;
  if (!candidate || typeof candidate !== 'string') {
    return 'cockpit';
  }
  const normalized = candidate.trim().toLowerCase();
  const matched = STITCH_NAV_TABS.find((tab) => tab.id === normalized);
  return matched ? matched.id : 'cockpit';
}

export const PRIME_API_GATEWAY_ROUTES: readonly PrimeApiGatewayRouteEntry[] = [
  {
    routeId: 'route-fix-order-stream',
    method: 'POST',
    path: '/api/v1/prime/fix-execution',
    protocol: 'FIX_4_4',
    tierName: 'PRIME_INSTITUTIONAL',
    burstCapacityRpm: 2400,
    refillRatePerSec: 40,
    p99LatencyMs: 0.9,
    status: 'KV_TOKEN_BUCKET_ACTIVE',
  },
  {
    routeId: 'route-terminal-snapshot',
    method: 'GET',
    path: '/api/terminal/snapshot',
    protocol: 'REST_EDGE',
    tierName: 'VIP_QUANT',
    burstCapacityRpm: 1200,
    refillRatePerSec: 20,
    p99LatencyMs: 1.1,
    status: 'KV_TOKEN_BUCKET_ACTIVE',
  },
  {
    routeId: 'route-terminal-actions',
    method: 'POST',
    path: '/api/terminal/actions',
    protocol: 'REST_EDGE',
    tierName: 'VIP_QUANT',
    burstCapacityRpm: 1200,
    refillRatePerSec: 20,
    p99LatencyMs: 1.2,
    status: 'KV_TOKEN_BUCKET_ACTIVE',
  },
  {
    routeId: 'route-rebate-ws-multiplex',
    method: 'GET',
    path: '/ws/v1/prime/rebate-ticks',
    protocol: 'WS_STREAM',
    tierName: 'PRIME_INSTITUTIONAL',
    burstCapacityRpm: 3600,
    refillRatePerSec: 60,
    p99LatencyMs: 0.7,
    status: 'KV_TOKEN_BUCKET_ACTIVE',
  },
] as const;

export const R2_MERKLE_SNAPSHOTS: readonly R2MerkleSnapshotEntry[] = [
  {
    snapshotId: 'snap-2026-10-17',
    r2ObjectKey: 'r2://apex-os-audit-worm/2026/10/17/d1-payout-ledger.parquet',
    rowCount: 148920,
    compressedSizeMb: 44.8,
    merkleRootHash: '0x9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1908f7e6d5c4b3a2190876543210',
    retentionUntil: '2033-10-17 (7Y WORM)',
    status: 'WORM_SEALED_R2',
  },
  {
    snapshotId: 'snap-2026-10-16',
    r2ObjectKey: 'r2://apex-os-audit-worm/2026/10/16/d1-payout-ledger.parquet',
    rowCount: 145110,
    compressedSizeMb: 43.2,
    merkleRootHash: '0x4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b',
    retentionUntil: '2033-10-16 (7Y WORM)',
    status: 'WORM_SEALED_R2',
  },
  {
    snapshotId: 'snap-2026-10-15',
    r2ObjectKey: 'r2://apex-os-audit-worm/2026/10/15/d1-payout-ledger.parquet',
    rowCount: 141840,
    compressedSizeMb: 41.9,
    merkleRootHash: '0x7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d',
    retentionUntil: '2033-10-15 (7Y WORM)',
    status: 'WORM_SEALED_R2',
  },
] as const;

export const AI_ARBITRAGE_AGENTS: readonly AiArbitrageAgentEntry[] = [
  {
    agentId: 'scanner-alpha',
    agentName: 'Scanner-Alpha (Fee & Spread Crawler)',
    roleSummary: 'Polls Binance, Bybit, OKX, KuCoin orderbooks & VIP rebate tiers every 12ms',
    minSpreadTriggerBps: 12.0,
    maxSlippageGuardBps: 15.0,
    captured24hUsdc: 642.8,
    status: 'ARMED_RUNNING',
  },
  {
    agentId: 'hedger-beta',
    agentName: 'Hedger-Beta (Delta-Neutral Leg Executor)',
    roleSummary: 'Executes simultaneous maker-rebate long +perp short legs with zero withdraw scope',
    minSpreadTriggerBps: 15.0,
    maxSlippageGuardBps: 15.0,
    captured24hUsdc: 894.5,
    status: 'ARMED_RUNNING',
  },
  {
    agentId: 'sentinel-gamma',
    agentName: 'Sentinel-Gamma (Slippage & Drawdown Circuit Breaker)',
    roleSummary: 'Halts autonomous execution immediately if slippage exceeds 15.0 bps or gas spikes',
    minSpreadTriggerBps: 10.0,
    maxSlippageGuardBps: 15.0,
    captured24hUsdc: 0,
    status: 'ARMED_RUNNING',
  },
  {
    agentId: 'settler-delta',
    agentName: 'Settler-Delta (Multi-Chain Rebate Sweeper)',
    roleSummary: 'Sweeps verified exchange rebates into D1 atomic reservation batches ($50+ threshold)',
    minSpreadTriggerBps: 8.0,
    maxSlippageGuardBps: 15.0,
    captured24hUsdc: 412.2,
    status: 'ARMED_RUNNING',
  },
] as const;

export const SEPAY_VIETQR_RAILS: readonly SepayBankRailEntry[] = [
  {
    bankCode: 'VCB',
    bankName: 'Vietcombank Institutional',
    napasBin: '970436',
    accountMask: '007100****8821',
    avgSettlementSec: 3.4,
    dailyCapVnd: '2,500,000,000 VND',
    status: 'NAPAS_247_ONLINE',
  },
  {
    bankCode: 'TCB',
    bankName: 'Techcombank Zero-Fee Hub',
    napasBin: '970407',
    accountMask: '190368****4410',
    avgSettlementSec: 2.9,
    dailyCapVnd: '3,000,000,000 VND',
    status: 'NAPAS_247_ONLINE',
  },
  {
    bankCode: 'MB',
    bankName: 'MBBank VietQR Pro',
    napasBin: '970422',
    accountMask: '888899****1024',
    avgSettlementSec: 3.8,
    dailyCapVnd: '2,000,000,000 VND',
    status: 'NAPAS_247_ONLINE',
  },
  {
    bankCode: 'ACB',
    bankName: 'ACB Commercial Treasury',
    napasBin: '970416',
    accountMask: '168888****9012',
    avgSettlementSec: 4.1,
    dailyCapVnd: '1,500,000,000 VND',
    status: 'NAPAS_247_ONLINE',
  },
] as const;

export const NOWPAYMENTS_PLAN_TIERS: readonly NowPaymentsPlanTier[] = [
  {
    planId: 'BASIC',
    priceUsd: 9,
    slug: 'basic-plan',
    rebateBoostLabel: 'Standard 30% Tier 1 Cashback',
    callbackPath: '/api/webhooks/ipn',
  },
  {
    planId: 'PREMIUM',
    priceUsd: 29,
    slug: 'premium-plan',
    rebateBoostLabel: '+5% Cashback Boost + Instant VietQR',
    callbackPath: '/api/webhooks/ipn',
  },
  {
    planId: 'ENTERPRISE',
    priceUsd: 99,
    slug: 'enterprise-plan',
    rebateBoostLabel: '+10% Rebate Boost + Dedicated Crawler',
    callbackPath: '/api/webhooks/ipn',
  },
  {
    planId: 'MASTER',
    priceUsd: 299,
    slug: 'master-plan',
    rebateBoostLabel: 'Full 30%/10%/5% Tree + VIP Whale Desk',
    callbackPath: '/api/webhooks/ipn',
  },
] as const;

export const CRON_WORKER_JOBS: readonly CronJobScheduleEntry[] = [
  {
    jobId: 'alerts',
    cronExpression: '*/5 * * * *',
    cadenceLabel: 'Every 5m',
    endpoint: '/api/cron?job=alerts',
    handlerName: 'evaluateBusinessAlerts(db)',
    lastDurationMs: 18,
    lastOutputSummary: 'Evaluated 12 rules · 0 triggered · 12 healthy',
    status: 'HEALTHY',
  },
  {
    jobId: 'email-queue',
    cronExpression: '*/15 * * * *',
    cadenceLabel: 'Every 15m',
    endpoint: '/api/cron?job=email-queue',
    handlerName: 'processEmailQueue()',
    lastDurationMs: 142,
    lastOutputSummary: 'Processed 24 emails: 24 sent via Resend, 0 failed',
    status: 'HEALTHY',
  },
  {
    jobId: 'd1-metrics',
    cronExpression: '*/30 * * * *',
    cadenceLabel: 'Every 30m',
    endpoint: '/api/cron?job=d1-metrics',
    handlerName: 'runMonitoringCycle(db)',
    lastDurationMs: 31,
    lastOutputSummary: 'Snapshot saved (1.42 GB storage · 14.2ms avg query)',
    status: 'HEALTHY',
  },
  {
    jobId: 'email-retry',
    cronExpression: '*/30 * * * *',
    cadenceLabel: 'Every 30m',
    endpoint: '/api/cron?job=email-retry',
    handlerName: 'retryFailedEmails()',
    lastDurationMs: 11,
    lastOutputSummary: 'Retried 0 queued dead-letter items (exponential backoff)',
    status: 'HEALTHY',
  },
  {
    jobId: 'analytics-refresh',
    cronExpression: '0 */1 * * *',
    cadenceLabel: 'Hourly',
    endpoint: '/api/cron?job=analytics-refresh',
    handlerName: 'refreshAnalyticsViews(db)',
    lastDurationMs: 64,
    lastOutputSummary: 'Refreshed 5/5 materialized analytics views',
    status: 'HEALTHY',
  },
  {
    jobId: 'payouts',
    cronExpression: '0 0 * * 0',
    cadenceLabel: 'Weekly (Sun 00:00)',
    endpoint: '/api/cron?job=payouts',
    handlerName: 'handleWeeklyPayouts(db)',
    lastDurationMs: 412,
    lastOutputSummary: 'Processed 38 affiliate payouts ($14,280.50 USDC · 1% fee)',
    status: 'HEALTHY',
  },
  {
    jobId: 'campaigns',
    cronExpression: '0 0 * * 0',
    cadenceLabel: 'Weekly (Sun 00:00)',
    endpoint: '/api/cron?job=campaigns',
    handlerName: 'runLifecycleCampaigns()',
    lastDurationMs: 89,
    lastOutputSummary: 'Enqueued: 19 welcome, 8 re-engagement, 4 win-back (0 errors)',
    status: 'HEALTHY',
  },
] as const;

export const VIP_WHALE_HEDGING_PAIRS: readonly VipWhaleHedgingPair[] = [
  {
    symbol: 'BTC-PERP',
    longVenue: 'Binance VIP 9 (-0.50 bps Maker Rebate)',
    shortVenue: 'Bybit Supreme (55% Cashback + Funding)',
    fundingSpread8hBps: 4.85,
    makerRebateBps: -0.5,
    combinedNetApyPct: 18.6,
  },
  {
    symbol: 'ETH-PERP',
    longVenue: 'OKX VIP 8 (-0.40 bps Maker Rebate)',
    shortVenue: 'Binance VIP 9 (50% Cashback + Funding)',
    fundingSpread8hBps: 4.2,
    makerRebateBps: -0.4,
    combinedNetApyPct: 16.4,
  },
  {
    symbol: 'SOL-PERP',
    longVenue: 'Bybit Supreme (-0.50 bps Maker Rebate)',
    shortVenue: 'KuCoin LV12 (45% Cashback + Funding)',
    fundingSpread8hBps: 5.4,
    makerRebateBps: -0.5,
    combinedNetApyPct: 21.2,
  },
] as const;

export const BYOK_VAULT_KEYS: readonly ByokVaultKeyEntry[] = [
  {
    exchangeId: 'binance',
    exchangeName: 'Binance Institutional',
    keyFingerprint: 'sha256:4f9a8b7c...1d2e',
    scopes: 'READ_SPOT · READ_FUTURES',
    rotatedAgo: '4d ago (26d SLA left)',
    status: 'SEALED_AES_GCM',
  },
  {
    exchangeId: 'bybit',
    exchangeName: 'Bybit Unified V5',
    keyFingerprint: 'sha256:7c8d9e0f...3a4b',
    scopes: 'READ_UNIFIED · READ_REBATE',
    rotatedAgo: '9d ago (21d SLA left)',
    status: 'SEALED_AES_GCM',
  },
  {
    exchangeId: 'okx',
    exchangeName: 'OKX Broker Node',
    keyFingerprint: 'sha256:2b3c4d5e...8f9a',
    scopes: 'READ_SWAP · READ_SUBACCT',
    rotatedAgo: '2d ago (28d SLA left)',
    status: 'SEALED_AES_GCM',
  },
  {
    exchangeId: 'kucoin',
    exchangeName: 'KuCoin Partner V2',
    keyFingerprint: 'sha256:9e0f1a2b...6c7d',
    scopes: 'READ_TRADE · READ_EARNINGS',
    rotatedAgo: '11d ago (19d SLA left)',
    status: 'SEALED_AES_GCM',
  },
] as const;

export const EXCHANGE_REBATES: readonly ExchangeRebateItem[] = [
  {
    exchangeId: 'binance',
    name: 'Binance Futures & Spot',
    tierLabel: 'VIP 4 Institutional Partner',
    makerFeeBps: 1.2,
    takerFeeBps: 3.6,
    cashbackPct: 45,
    settledUsdc: 12480.5,
    pendingUsdc: 740.25,
    webhookAuthHeader: 'X-MBX-SIGNATURE (HMAC-SHA256)',
    latencyMs: 38,
    status: 'VERIFIED',
  },
  {
    exchangeId: 'bybit',
    name: 'Bybit Unified Trading',
    tierLabel: 'Pro 3 Rebate Pool',
    makerFeeBps: 1.0,
    takerFeeBps: 4.0,
    cashbackPct: 50,
    settledUsdc: 8920.1,
    pendingUsdc: 560.0,
    webhookAuthHeader: 'X-BAPI-SIGN + X-BAPI-TIMESTAMP',
    latencyMs: 42,
    status: 'VERIFIED',
  },
  {
    exchangeId: 'okx',
    name: 'OKX Derivatives Hub',
    tierLabel: 'VIP 5 Broker Node',
    makerFeeBps: 0.8,
    takerFeeBps: 3.5,
    cashbackPct: 42,
    settledUsdc: 4610.2,
    pendingUsdc: 325.5,
    webhookAuthHeader: 'OK-ACCESS-SIGN (±5m Window)',
    latencyMs: 51,
    status: 'VERIFIED',
  },
  {
    exchangeId: 'kucoin',
    name: 'KuCoin Spot & Perp',
    tierLabel: 'LV4 Rebate Syndicate',
    makerFeeBps: 1.5,
    takerFeeBps: 4.5,
    cashbackPct: 40,
    settledUsdc: 2440.0,
    pendingUsdc: 214.25,
    webhookAuthHeader: 'KC-API-SIGN (Base64 SHA256)',
    latencyMs: 64,
    status: 'VERIFIED',
  },
] as const;

export const REFERRAL_TIERS: readonly ReferralTierNode[] = [
  {
    level: 1,
    labelEn: 'Tier 1 Direct Affiliates',
    labelVi: 'Tuyến 1 Trực Tiếp',
    commissionRatePct: 30,
    activeTraders: 312,
    volume30dUsd: 18450000,
    earnedUsdc: 5535.0,
  },
  {
    level: 2,
    labelEn: 'Tier 2 Sub-Network',
    labelVi: 'Tuyến 2 Gián Tiếp',
    commissionRatePct: 10,
    activeTraders: 589,
    volume30dUsd: 24100000,
    earnedUsdc: 2410.0,
  },
  {
    level: 3,
    labelEn: 'Tier 3 Viral Syndicate',
    labelVi: 'Tuyến 3 Cộng Đồng',
    commissionRatePct: 5,
    activeTraders: 383,
    volume30dUsd: 14900000,
    earnedUsdc: 745.0,
  },
] as const;

export const ARBITRAGE_OPPORTUNITIES: readonly ArbitrageOpportunityItem[] = [
  {
    id: 'arb-btc-perp',
    pair: 'BTC/USDT PERP',
    buyExchange: 'OKX (Maker 0.8 bps)',
    sellExchange: 'Bybit (50% Cashback)',
    grossSpreadBps: 16.4,
    netAfterRebateBps: 24.8,
    dealType: 'FEE_SPREAD',
    estimatedAnnualSavingsUsd: 2976,
    confidencePct: 98,
  },
  {
    id: 'arb-eth-perp',
    pair: 'ETH/USDC PERP',
    buyExchange: 'Binance (45% Cashback)',
    sellExchange: 'OKX (VIP Maker Rebate)',
    grossSpreadBps: 12.2,
    netAfterRebateBps: 19.5,
    dealType: 'CASHBACK_MAX',
    estimatedAnnualSavingsUsd: 2340,
    confidencePct: 95,
  },
  {
    id: 'arb-sol-spot',
    pair: 'SOL/USDT SPOT',
    buyExchange: 'Bybit (Zero-Maker Promo)',
    sellExchange: 'KuCoin (40% Rebate)',
    grossSpreadBps: 14.0,
    netAfterRebateBps: 21.2,
    dealType: 'VIP_PROMOTION',
    estimatedAnnualSavingsUsd: 1690,
    confidencePct: 92,
  },
] as const;

export const CHAIN_TREASURY_RAILS: readonly ChainTreasuryStatus[] = [
  {
    chainId: 'stellar',
    name: 'Stellar Horizon Network',
    railProtocol: 'XLM / Circle USDC Asset',
    hotWalletAddress: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37',
    usdcReserve: 142500.0,
    nativeGasBalance: '4,820.00 XLM',
    nativeGasFloor: '25.00 XLM',
    avgSettlementSec: 4.2,
    networkFeeUsd: 0.0001,
    healthStatus: 'HEALTHY',
  },
  {
    chainId: 'ethereum',
    name: 'Ethereum Mainnet ERC-20',
    railProtocol: 'EIP-1559 USDC / USDT',
    hotWalletAddress: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    usdcReserve: 310800.0,
    nativeGasBalance: '1.84 ETH',
    nativeGasFloor: '0.05 ETH',
    avgSettlementSec: 14.8,
    networkFeeUsd: 1.45,
    healthStatus: 'HEALTHY',
  },
  {
    chainId: 'solana',
    name: 'Solana Mainnet-Beta SPL',
    railProtocol: 'SPL Token + Compute Budget',
    hotWalletAddress: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
    usdcReserve: 198400.0,
    nativeGasBalance: '64.50 SOL',
    nativeGasFloor: '0.50 SOL',
    avgSettlementSec: 0.8,
    networkFeeUsd: 0.00025,
    healthStatus: 'HEALTHY',
  },
] as const;

export const KYC_ROLLING_TIERS: readonly KycRollingTierItem[] = [
  {
    tier: 'UNVERIFIED',
    ceiling30dUsd: '$500 / 30d',
    currentUsageUsd: 320,
    utilizationPct: 64,
    autoReleaseEnabled: false,
    requiredDocs: 'Email + Telegram HMAC Verified',
  },
  {
    tier: 'BASIC',
    ceiling30dUsd: '$2,500 / 30d',
    currentUsageUsd: 1840,
    utilizationPct: 73.6,
    autoReleaseEnabled: true,
    requiredDocs: 'Gov ID + Liveness Check',
  },
  {
    tier: 'ENHANCED',
    ceiling30dUsd: '$50,000 / 30d',
    currentUsageUsd: 28450.8,
    utilizationPct: 56.9,
    autoReleaseEnabled: true,
    requiredDocs: 'Proof of Address + AML/PEP Clear',
  },
] as const;

export const WEBHOOK_SANDBOX_PRESETS: readonly WebhookSandboxPreset[] = [
  {
    providerId: 'binance',
    providerName: 'Binance Affiliate Webhook',
    algorithm: 'HMAC-SHA256 (Hex)',
    signatureHeader: 'X-MBX-SIGNATURE',
    timestampHeader: 'X-MBX-TIMESTAMP',
    replayWindow: '60s Skew + D1 Unique Trade ID',
    samplePayload: JSON.stringify(
      {
        event: 'COMMISSION_SETTLED',
        exchange: 'binance',
        trade_id: 'BN-99481024',
        user_id: 'usr_apex_8821',
        pair: 'BTCUSDT',
        volume_usd: 125000.0,
        fee_paid_usdc: 93.75,
        timestamp: 1760700000000,
      },
      null,
      2
    ),
    sampleSignature: '8f4e9b2c1d7a6e5f3b0c9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f',
    tradeVolumeUsd: 125000,
    exchangeFeeUsd: 93.75,
  },
  {
    providerId: 'bybit',
    providerName: 'Bybit Broker V5 Stream',
    algorithm: 'HMAC-SHA256 (Hex)',
    signatureHeader: 'X-BAPI-SIGN',
    timestampHeader: 'X-BAPI-TIMESTAMP',
    replayWindow: '5,000ms RecvWindow',
    samplePayload: JSON.stringify(
      {
        topic: 'broker.rebate.execution',
        exchange: 'bybit',
        execId: 'BYB-77319042',
        uid: 'usr_apex_8821',
        symbol: 'ETHUSDC',
        execValueUsd: 84000.0,
        execFeeUsdc: 67.2,
        ts: 1760700120000,
      },
      null,
      2
    ),
    sampleSignature: '3c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d',
    tradeVolumeUsd: 84000,
    exchangeFeeUsd: 67.2,
  },
  {
    providerId: 'okx',
    providerName: 'OKX ND Broker Callback',
    algorithm: 'HMAC-SHA256 (Base64)',
    signatureHeader: 'OK-ACCESS-SIGN',
    timestampHeader: 'OK-ACCESS-TIMESTAMP',
    replayWindow: '±300s Timestamp Guard',
    samplePayload: JSON.stringify(
      {
        instId: 'SOL-USDT-SWAP',
        exchange: 'okx',
        ordId: 'OKX-55192011',
        subAcct: 'usr_apex_8821',
        fillSzUsd: 62000.0,
        rebateUsdc: 49.6,
        ts: '2026-10-17T09:50:00.000Z',
      },
      null,
      2
    ),
    sampleSignature: 'K7x9Qm2Lp4Vn8Rt1Yw5Za3Bc6De9Fg0Hj2Kl4Mn6Pq8=',
    tradeVolumeUsd: 62000,
    exchangeFeeUsd: 49.6,
  },
  {
    providerId: 'kucoin',
    providerName: 'KuCoin Partner Rebate Push',
    algorithm: 'HMAC-SHA256 (Base64)',
    signatureHeader: 'KC-API-SIGN',
    timestampHeader: 'KC-API-TIMESTAMP',
    replayWindow: '120s Nonce Window',
    samplePayload: JSON.stringify(
      {
        type: 'partner.commission',
        exchange: 'kucoin',
        tradeId: 'KC-33019482',
        clientUid: 'usr_apex_8821',
        turnoverUsd: 45000.0,
        commissionUsdc: 36.0,
      },
      null,
      2
    ),
    sampleSignature: 'M9p2Qr5St8Uv1Wx4Yz7Ab0Cd3Ef6Gh9Ij2Kl5Mn8Op1=',
    tradeVolumeUsd: 45000,
    exchangeFeeUsd: 36.0,
  },
  {
    providerId: 'nowpayments',
    providerName: 'NOWPayments Tier Billing IPN',
    algorithm: 'HMAC-SHA512 (Sorted JSON)',
    signatureHeader: 'x-nowpayments-sig',
    timestampHeader: 'x-nowpayments-nonce',
    replayWindow: 'Cloudflare KV 24h Nonce TTL',
    samplePayload: JSON.stringify(
      {
        payment_id: 589201442,
        payment_status: 'finished',
        order_id: 'tier_master_usr_apex_8821',
        price_amount: 99.0,
        price_currency: 'usd',
        pay_currency: 'usdcsol',
        actually_paid: 99.0,
      },
      null,
      2
    ),
    sampleSignature:
      'd4e5f6a7b8c90123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123',
    tradeVolumeUsd: 99.0,
    exchangeFeeUsd: 99.0,
  },
] as const;

export const D1_IMMUTABLE_AUDIT_LOGS: readonly D1AuditLogEntry[] = [
  {
    logId: 'aud_994810',
    payoutId: 'pay_stellar_8821',
    userId: 'usr_apex_8821',
    chain: 'STELLAR',
    amountUsdc: 640.5,
    previousStatus: 'processing',
    newStatus: 'completed',
    idempotencyHash: 'sha256:9f86d081884c7d659a2feaa0c55ad015',
    merkleLeafHash: '0x4a8b9c1d2e3f4a5b6c7d8e9f0a1b2c3d',
    txHashOrReason: 'stellar:3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a',
    createdAtIso: '2026-10-17T09:58:12Z',
  },
  {
    logId: 'aud_994809',
    payoutId: 'pay_solana_7742',
    userId: 'usr_apex_4419',
    chain: 'SOLANA',
    amountUsdc: 420.0,
    previousStatus: 'Reserved_D1',
    newStatus: 'completed',
    idempotencyHash: 'sha256:7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f',
    merkleLeafHash: '0x8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b',
    txHashOrReason: 'sol:5xK9mN2pQ4rT8vW1yZ3aB6cD9eF2gH5jK8mN1pQ',
    createdAtIso: '2026-10-17T09:56:40Z',
  },
  {
    logId: 'aud_994808',
    payoutId: 'pay_eth_6610',
    userId: 'usr_flagged_9012',
    chain: 'ETHEREUM',
    amountUsdc: 1250.0,
    previousStatus: 'Reserved_D1',
    newStatus: 'compliance_blocked',
    idempotencyHash: 'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
    merkleLeafHash: '0x2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f',
    txHashOrReason: 'OFAC_SDN_MATCH:0x8576aCC5C05D6Ce88f4e49bf65BdF0C62F91353C',
    createdAtIso: '2026-10-17T09:54:05Z',
  },
] as const;
