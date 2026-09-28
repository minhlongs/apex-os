/**
 * Unified Domain Types for Cross-Exchange Arbitrage & High-Yield Deal Crawler
 * Module: ApexOS Arbitrage Engine & Rate Card Crawler
 */

export type ExchangeId = 'binance' | 'bybit' | 'okx' | 'kucoin';
export type ExchangeName = ExchangeId;

export type MarketType = 'spot' | 'futures';

export type OpportunityType = 'FEE_SPREAD' | 'CASHBACK_MAX' | 'VIP_PROMOTION';

export type CrawlerRunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'partial'
  | 'failed'
  | 'fallback_used';

/**
 * Normalized Exchange Rate Card representing fee structures for an exchange, market, and pair
 */
export interface RateCard {
  id?: string;
  exchange: ExchangeId;
  marketType: MarketType;
  pair: string;                      // Canonical, e.g. "BTC/USDT"
  rawSymbol?: string;                // Native exchange symbol, e.g. "BTCUSDT", "BTC-USDT-SWAP"
  makerFee: number;                  // Decimal fee, e.g. 0.0010 (0.10%)
  takerFee: number;                  // Decimal fee, e.g. 0.0010 (0.10%)
  defaultCashbackPct: number;        // Cashback % negotiated for ApexOS (e.g. 20.0 = 20%)
  vipTier: string;                   // "VIP0", "VIP1", "VIP2", etc.
  promotionalDiscountPct?: number;   // E.g., 25% BNB discount or 0% promo
  volume30dUsd?: number;             // 30d volume requirement in USD for tier
  isActive?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Database representation of exchange_rate_cards row (Cloudflare D1)
 */
export interface ExchangeRateCard {
  id?: string;
  exchange: ExchangeId;
  market_type: MarketType;
  pair: string;
  raw_symbol?: string | null;
  maker_fee: number;
  taker_fee: number;
  default_cashback_pct: number;
  vip_tier: string;
  volume_30d_usd?: number;
  is_active?: number;
  metadata?: Record<string, unknown> | string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Volume benchmark monthly & annual fee savings calculation
 */
export interface VolumeBenchmarkSavings {
  monthly: number;
  annual: number;
}

/**
 * Computed metrics comparing two exchanges
 */
export interface ArbitrageMetrics {
  netBaseFee: number;
  netTargetFee: number;
  spreadBps: number;
  savingsPct: number;
  cashbackAdvantage: number;
  savings10k: VolumeBenchmarkSavings;
  savings50k: VolumeBenchmarkSavings;
  savings250k: VolumeBenchmarkSavings;
}

/**
 * Database and API model for pre-computed arbitrage opportunities
 */
export interface ArbitrageOpportunity {
  id?: string;
  pair: string;
  market_type: MarketType;
  base_exchange: ExchangeId;
  target_exchange: ExchangeId;
  base_taker_fee: number;
  target_taker_fee: number;
  base_maker_fee: number;
  target_maker_fee: number;
  base_cashback_pct: number;
  target_cashback_pct: number;
  net_base_fee: number;
  net_target_fee: number;
  spread_bps: number;
  savings_pct: number;
  opportunity_type: OpportunityType;
  recommendation: string;
  deal_id?: string | null;
  monthly_savings_10k: number;
  monthly_savings_50k: number;
  monthly_savings_250k: number;
  annual_savings_10k: number;
  annual_savings_50k: number;
  annual_savings_250k: number;
  is_active: number;
  detected_at: string;
  expires_at: string;
  metadata?: Record<string, unknown> | string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Crawler execution audit log record
 */
export interface CrawlerSyncRun {
  run_id: string;
  exchange: ExchangeId;
  status: CrawlerRunStatus;
  items_count: number;
  duration_ms: number;
  error_message?: string | null;
  metadata?: Record<string, unknown> | string;
  created_at?: string;
}

/**
 * Filters for querying active arbitrage opportunities
 */
export interface ArbitrageQueryFilter {
  pair?: string;
  market_type?: MarketType;
  min_spread_bps?: number;
  opportunity_type?: OpportunityType;
  target_exchange?: ExchangeId;
  is_active?: boolean | number;
  limit?: number;
  page?: number;
}

/**
 * Paginated opportunities response
 */
export interface PaginatedArbitrageOpportunities {
  data: ArbitrageOpportunity[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Single cell in 2D cross-exchange comparison matrix
 */
export interface ArbitrageMatrixCell {
  baseExchange: ExchangeId;
  targetExchange: ExchangeId;
  spreadBps: number;
  savingsPct: number;
  annualSavings250k: number;
  opportunityType: OpportunityType;
  dealId?: string | null;
}

/**
 * Complete 2D matrix comparing all supported exchanges for a given pair
 */
export interface ArbitrageMatrixResponse {
  pair: string;
  marketType: MarketType;
  exchanges: ExchangeId[];
  matrix: Record<ExchangeId, Record<ExchangeId, ArbitrageMatrixCell | null>>;
  updatedAt: string;
}

/**
 * Filter options for querying stored rate cards
 */
export interface RateCardFilter {
  exchange?: ExchangeId;
  marketType?: MarketType;
  pair?: string;
  vipTier?: string;
  isActive?: boolean | number;
}
