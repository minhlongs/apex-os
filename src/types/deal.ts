/**
 * Affiliate Deal entity - complete schema after 003 + 004 migrations
 * Fields marked optional may be null/undefined depending on query context
 */
export interface AffiliateDeal {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  deal_type: string;
  product_id: string | null;
  url: string;
  default_commission_rate: number;
  default_commission_type: 'percentage' | 'fixed';
  fixed_commission_amount: number;
  cookie_duration_days: number;
  is_active: number;
  starts_at: string | null;
  ends_at: string | null;
  metadata: string | null;
  created_by: string | null;
  exchange: string | null;
  category: string | null;
  cashback_percent: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  created_at: string;
  updated_at: string;
}

/**
 * Public Deal - limited fields for public listing
 */
export interface PublicDeal {
  id: string;
  name: string;
  description: string | null;
  deal_type: 'product' | 'service' | 'subscription' | 'course';
  url: string;
  default_commission_rate: number;
  cookie_duration_days: number;
  is_active: number;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  // Extended filter fields
  exchange: 'binance' | 'bybit' | 'okx' | 'ftx' | 'coinbase' | 'kraken' | null;
  category: 'spot' | 'futures' | 'options' | 'margin' | null;
  cashback_percent: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
}

/**
 * Deal creation payload
 */
export interface CreateDealDto {
  name: string;
  description?: string;
  deal_type?: string;  // 'product' | 'service' | 'subscription' | 'course' or any custom type
  product_id?: string;
  url: string;
  default_commission_rate?: number;
  default_commission_type?: 'percentage' | 'fixed';
  fixed_commission_amount?: number;
  cookie_duration_days?: number;
  is_active?: boolean | number;
  starts_at?: string;
  ends_at?: string;
  metadata?: Record<string, unknown>;
  // Extended fields from 004
  exchange?: 'binance' | 'bybit' | 'okx' | 'ftx' | 'coinbase' | 'kraken';
  category?: 'spot' | 'futures' | 'options' | 'margin';
  cashback_percent?: number;
  risk_level?: 'low' | 'medium' | 'high';
}

/**
 * Deal update payload (partial)
 */
export interface UpdateDealDto {
  name?: string;
  description?: string;
  deal_type?: string;  // flexible deal type
  product_id?: string;
  url?: string;
  default_commission_rate?: number;
  default_commission_type?: 'percentage' | 'fixed';
  fixed_commission_amount?: number;
  cookie_duration_days?: number;
  is_active?: boolean | number;
  starts_at?: string;
  ends_at?: string;
  metadata?: Record<string, unknown>;
  // Extended fields from 004
  exchange?: 'binance' | 'bybit' | 'okx' | 'ftx' | 'coinbase' | 'kraken';
  category?: 'spot' | 'futures' | 'options' | 'margin';
  cashback_percent?: number;
  risk_level?: 'low' | 'medium' | 'high';
}

/**
 * Query parameters for listing deals
 */
export interface DealListQuery {
  page?: string;
  limit?: string;
  deal_type?: string;
  is_active?: string;
  exchange?: string;
  category?: string;
  risk_level?: string;
  search?: string;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Simple success response
 */
export interface SuccessResponse {
  success: boolean;
  message: string;
}
