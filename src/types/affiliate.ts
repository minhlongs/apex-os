/**
 * Affiliate Dashboard Types
 * Types for the affiliate dashboard including stats, referral tree, and payouts
 */

export interface AffiliateProfile {
  id: string
  email: string
  full_name: string | null
  role: string
  referral_code: string
  is_affiliate: boolean
}

export interface AffiliateStats {
  lifetime_earnings: number
  pending_earnings: number
  lifetime_payouts: number
  total_conversions: number
  total_clicks: number
  conversion_rate: number
  direct_referrals: number
  indirect_referrals: number
  total_referrals: number
  total_revenue: number
}

export interface ReferralChild {
  affiliate_id: string
  email: string
  full_name: string | null
  level: number
  display_level: number
  total_earnings: number
  total_conversions: number
  conversion_rate: number
  children: ReferralChild[]
}

export interface ReferralTree {
  root: {
    affiliate_id: string
    email: string
    full_name: string | null
    level: number
    children: ReferralChild[]
  } | null
  total_nodes: number
  /** Materialized path for internal use (not exposed in API) */
  path?: string | null
}

export interface PayoutRecord {
  id: string
  amount: number
  net_amount: number
  status: string
  scheduled_at: string | null
  paid_at: string | null
  transaction_id: string | null
}

export interface AffiliateDashboardData {
  profile: AffiliateProfile
  stats: AffiliateStats
  share_link: string
  referral_tree: ReferralTree
  recent_payouts: PayoutRecord[]
}

export type PayoutStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const PAYOUT_STATUS_LABELS: Record<PayoutStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}
