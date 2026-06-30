/**
 * Admin Affiliates Server Actions
 * Provides operations for managing and viewing affiliate data
 */

'use server'

import { createAuth } from '@/lib/auth/auth-factory'
import type { TopAffiliate } from '@/app/api/admin/affiliates/route'
import { getDB } from '@/lib/db';

// Helper to check if user is admin
export async function requireAdmin(): Promise<{ userId: string; role: string } | null> {
  const db = getDB();
  const auth = createAuth({ DB: db })

  // In Server Actions, get session from headers and cookies
  const { headers: getHeaders, cookies } = await import('next/headers')
  const readonlyHeaders = await getHeaders()
  const cookieStore = await cookies()

  // Convert ReadonlyHeaders to mutable Headers for auth API
  const headers = new Headers()
  readonlyHeaders.forEach((value, key) => headers.append(key, value))

  // Build cookies object for auth
  const cookiesObj: Record<string, string> = {}
  const allCookies = cookieStore.getAll()
  for (const cookie of allCookies) {
    cookiesObj[cookie.name] = cookie.value
  }

  const sessionResult = await auth.api.getSession({
    headers,
    cookies: cookiesObj,
  })

  if (!sessionResult?.user) {
    return null
  }

  // Get user profile to check role
  const userId = (sessionResult.user as { id: string }).id
  const profile = await db.prepare('SELECT role FROM profiles WHERE id = ?')
    .bind(userId)
    .first<{ role: string }>()

  if (!profile || profile.role !== 'admin') {
    return null
  }

  return { userId, role: profile.role }
}

export interface TopAffiliatesResponse {
  affiliates: TopAffiliate[]
  total: number
  page: number
  limit: number
  totalPages: number
}

/**
 * GET top affiliates with sorting and filtering (Admin)
 */
export async function getTopAffiliates(
  page: number = 1,
  limit: number = 20,
  sortBy: string = 'lifetime_earnings',
  sortOrder: 'asc' | 'desc' = 'desc',
  timeRange: string = 'all'
): Promise<TopAffiliatesResponse> {
  try {
    const admin = await requireAdmin()
    if (!admin) {
      return { affiliates: [], total: 0, page, limit, totalPages: 0 }
    }

    const db = getDB()

    // Validate sort parameters
    const validSortColumns = [
      'lifetime_earnings',
      'total_conversions',
      'conversion_rate',
      'total_referrals',
      'total_revenue',
      'pending_earnings',
      'created_at'
    ]
    const validSortOrders = ['asc', 'desc']

    const safeSortBy = validSortColumns.includes(sortBy) ? sortBy : 'lifetime_earnings'
    const safeSortOrder = validSortOrders.includes(sortOrder) ? sortOrder : 'desc'

    // Build time range filter
    let dateCondition = ''
    if (timeRange !== 'all') {
      const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90
      dateCondition = `AND p.created_at >= datetime('now', '-${days} days')`
    }

    // Map sort columns to actual SQL expressions
    const sortColumnMap: Record<string, string> = {
      lifetime_earnings: 'COALESCE(rt.total_earnings, 0)',
      total_conversions: 'COALESCE(ap.total_conversions, 0)',
      conversion_rate: 'COALESCE(ap.conversion_rate, 0)',
      total_referrals: 'COALESCE(rt.total_direct_referrals, 0) + COALESCE(rt.total_indirect_referrals, 0)',
      total_revenue: 'COALESCE(ap.total_revenue, 0)',
      pending_earnings: 'COALESCE(pending.pending_earnings, 0)',
      created_at: 'p.created_at',
    }

    const sortExpression = sortColumnMap[safeSortBy] || sortColumnMap.lifetime_earnings
    const offset = (page - 1) * limit

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM profiles p
      WHERE p.role IN ('affiliate', 'admin')
      ${dateCondition}
    `

    const countRow = await db.prepare(countQuery)
      .first<{ total: number }>()
    const total = countRow?.total || 0

    // Get top affiliates
    const affiliatesQuery = `
      SELECT
        p.id,
        p.email,
        p.full_name,
        COALESCE(p.referral_code, '') as referral_code,
        COALESCE(rt.total_earnings, 0) as lifetime_earnings,
        COALESCE(rt.total_payouts, 0) as lifetime_payouts,
        COALESCE(pending.pending_earnings, 0) as pending_earnings,
        COALESCE(ap.total_conversions, 0) as total_conversions,
        COALESCE(ap.total_clicks, 0) as total_clicks,
        COALESCE(ap.conversion_rate, 0) as conversion_rate,
        COALESCE(rt.total_direct_referrals, 0) + COALESCE(rt.total_indirect_referrals, 0) as total_referrals,
        COALESCE(ap.total_revenue, 0) as total_revenue,
        p.created_at
      FROM profiles p
      LEFT JOIN referral_tree rt ON p.id = rt.affiliate_id
      LEFT JOIN v_affiliate_performance ap ON ap.affiliate_id = p.id
      LEFT JOIN (
        SELECT affiliate_id, COALESCE(SUM(amount), 0) as pending_earnings
        FROM earnings
        WHERE is_paid = 0
        GROUP BY affiliate_id
      ) pending ON pending.affiliate_id = p.id
      WHERE p.role IN ('affiliate', 'admin')
      ${dateCondition}
      ORDER BY ${sortExpression} ${safeSortOrder.toUpperCase()}, p.created_at DESC
      LIMIT ? OFFSET ?
    `

    const result = await db.prepare(affiliatesQuery)
      .bind(limit, offset)
      .all<TopAffiliate>()

    return {
      affiliates: result.results,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    }
  } catch (error) {
    console.error('Error fetching top affiliates:', error)
    return { affiliates: [], total: 0, page, limit, totalPages: 0 }
  }
}

/**
 * GET affiliate details by ID (Admin)
 */
export async function getAffiliateById(id: string): Promise<{ data: TopAffiliate | null; error?: string }> {
  try {
    const admin = await requireAdmin()
    if (!admin) {
      return { data: null, error: 'Unauthorized' }
    }

    const db = getDB()

    const query = `
      SELECT
        p.id,
        p.email,
        p.full_name,
        COALESCE(p.referral_code, '') as referral_code,
        COALESCE(rt.total_earnings, 0) as lifetime_earnings,
        COALESCE(rt.total_payouts, 0) as lifetime_payouts,
        COALESCE(pending.pending_earnings, 0) as pending_earnings,
        COALESCE(ap.total_conversions, 0) as total_conversions,
        COALESCE(ap.total_clicks, 0) as total_clicks,
        COALESCE(ap.conversion_rate, 0) as conversion_rate,
        COALESCE(rt.total_direct_referrals, 0) + COALESCE(rt.total_indirect_referrals, 0) as total_referrals,
        COALESCE(ap.total_revenue, 0) as total_revenue,
        p.created_at
      FROM profiles p
      LEFT JOIN referral_tree rt ON p.id = rt.affiliate_id
      LEFT JOIN v_affiliate_performance ap ON ap.affiliate_id = p.id
      LEFT JOIN (
        SELECT affiliate_id, COALESCE(SUM(amount), 0) as pending_earnings
        FROM earnings
        WHERE is_paid = 0
        GROUP BY affiliate_id
      ) pending ON pending.affiliate_id = p.id
      WHERE p.id = ? AND p.role IN ('affiliate', 'admin')
    `

    const affiliate = await db.prepare(query)
      .bind(id)
      .first<TopAffiliate>()

    return { data: affiliate || null }
  } catch (error) {
    console.error('Error fetching affiliate:', error)
    return { data: null, error: 'Failed to fetch affiliate' }
  }
}
