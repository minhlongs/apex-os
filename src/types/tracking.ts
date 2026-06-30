/**
 * Click tracking types for affiliate attribution
 */

/**
 * Record of a deal click for analytics/attribution
 */
export interface DealClick {
  id: string;
  deal_id: string;
  affiliate_code: string | null; // Referral code that initiated the click
  affiliate_id: string | null; // User ID of the person who clicked (may be null for anonymous)
  session_id: string; // Tracking cookie/session identifier
  ip_address: string | null;
  user_agent: string | null;
  referrer_url: string | null;
  country_code: string | null;
  device_type: string | null;
  click_type: 'link' | 'banner' | 'email' | 'social' | 'qr';
  is_unique: number; // 1 for unique click, 0 for repeat
  created_at: string;
}

/**
 * Click tracking query parameters
 */
export interface ClickTrackingParams {
  deal_id: string;
  ref?: string;
  redirect?: string;
}

/**
 * Click aggregation for analytics
 */
export interface ClickStats {
  total_clicks: number;
  unique_visitors: number;
  conversion_rate?: number;
  last_clicked: string | null;
}
