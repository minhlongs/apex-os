import { NextRequest, NextResponse } from 'next/server'
import { error as logError } from '@/lib/logger';
import { createAuth } from '@/lib/auth/auth-factory'
import { getDB } from '@/lib/db';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const { userId } = body

    const DB = getDB()
    if (!DB) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 })
    }

    // Get the deal to verify it exists and get URL
    const deal = await DB.prepare(
      'SELECT id, url, is_active FROM deals WHERE id = ?'
    ).bind(id).first<{ id: string; url: string; is_active: number }>()

    if (!deal) {
      return NextResponse.json({ error: 'Deal not found' }, { status: 404 })
    }

    if (deal.is_active !== 1) {
      return NextResponse.json({ error: 'Deal is not active' }, { status: 410 })
    }

    // Get authenticated user if available (for affiliate attribution)
    let authenticatedUserId: string | null = null
    try {
      const auth = createAuth({ DB })
      const sessionResult = await auth.api.getSession({
        headers: request.headers,
        cookies: request.cookies as unknown as Record<string, string>,
      })
      if (sessionResult?.user) {
        authenticatedUserId = (sessionResult.user as { id: string }).id
      }
    } catch {
      // Auth not configured or session invalid - continue without it
    }

    // Generate tracking cookie ID
    let cookieId = request.cookies.get('apex_tracking_id')?.value
    if (!cookieId) {
      cookieId = crypto.randomUUID()
    }

    // Collect tracking data
    const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
                     request.headers.get('cf-connecting-ip') ||
                     request.headers.get('x-real-ip') ||
                     null

    const userAgent = request.headers.get('user-agent') || null

    // Record click in deal_clicks table
    const clickId = crypto.randomUUID().replace(/-/g, '').slice(0, 32)
    const insertQuery = `
      INSERT INTO deal_clicks (
        id, deal_id, affiliate_code, affiliate_id, session_id,
        ip_address, user_agent, click_type, is_unique
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    // The userId from body is the affiliate ID (the user claiming the deal)
    const affiliateCode = authenticatedUserId || null

    await DB.prepare(insertQuery)
      .bind(
        clickId,
        deal.id,
        affiliateCode, // affiliate_code: the affiliate who is claiming/sharing
        authenticatedUserId, // affiliate_id: the user who clicked (same as affiliate for self-claim)
        cookieId,
        ipAddress,
        userAgent,
        'link',
        1
      )
      .run()

    // Set tracking cookie
    const cookieMaxAge = 30 * 24 * 60 * 60 // 30 days
    const response = NextResponse.json({
      success: true,
      redirectUrl: deal.url,
    })
    response.cookies.set('apex_tracking_id', cookieId, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      maxAge: cookieMaxAge,
    })

    return response
  } catch (error) {
    logError('Affiliate click tracking error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const DB = getDB()
    if (!DB) {
      return NextResponse.redirect(new URL('/deals', request.url), 302)
    }

    // Get the deal
    const deal = await DB.prepare(
      'SELECT id, url, is_active FROM deals WHERE id = ?'
    ).bind(id).first<{ id: string; url: string; is_active: number }>()

    if (!deal) {
      return NextResponse.redirect(new URL('/deals', request.url), 302)
    }

    if (deal.is_active !== 1) {
      return NextResponse.redirect(new URL('/deals', request.url), 302)
    }

    // Get or create tracking cookie
    let cookieId = request.cookies.get('apex_tracking_id')?.value
    if (!cookieId) {
      cookieId = crypto.randomUUID()
    }

    // Get authenticated user if available
    let authenticatedUserId: string | null = null
    try {
      const auth = createAuth({ DB })
      const sessionResult = await auth.api.getSession({
        headers: request.headers,
        cookies: request.cookies as unknown as Record<string, string>,
      })
      if (sessionResult?.user) {
        authenticatedUserId = (sessionResult.user as { id: string }).id
      }
    } catch {
      // Continue without auth
    }

    // Record anonymous click (for tracking before login/signup)
    const clickId = crypto.randomUUID().replace(/-/g, '').slice(0, 32)
    const insertQuery = `
      INSERT INTO deal_clicks (
        id, deal_id, affiliate_code, affiliate_id, session_id,
        ip_address, user_agent, click_type, is_unique
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    await DB.prepare(insertQuery)
      .bind(
        clickId,
        deal.id,
        authenticatedUserId, // affiliate_code: track who referred (if logged in)
        authenticatedUserId, // affiliate_id: the user who clicked
        cookieId,
        request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
        request.headers.get('user-agent') || null,
        'link',
        1
      )
      .run()

    // Set tracking cookie and redirect
    const cookieMaxAge = 30 * 24 * 60 * 60
    const response = NextResponse.redirect(deal.url, 302)
    response.cookies.set('apex_tracking_id', cookieId, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      maxAge: cookieMaxAge,
    })

    return response
  } catch (error) {
    logError('Affiliate redirect error:', error)
    return NextResponse.redirect(new URL('/deals', request.url), 302)
  }
}
