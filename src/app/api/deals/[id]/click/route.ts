import { NextRequest, NextResponse } from 'next/server';
import { error as logError } from '@/lib/logger';
import { createAuth } from '@/lib/auth/auth-factory';
import { getDB } from '@/lib/db';
import {
  isIpBlocked,
  checkIpRateLimit,
  extractClientIp,
  createBlockedIp403Response,
  createRateLimit429Response,
  evaluateClickVelocity,
} from '@/lib/fraud/fraud-engine';
import type { VelocityCheckResult } from '@/types/fraud';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // 1. Database connection check
    let DB: any;
    try {
      DB = getDB();
    } catch {
      DB = (globalThis as any).DB;
    }
    if (!DB) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    // 2. Extract client IP with strict Cloudflare precedence
    const ipAddress = extractClientIp(request.headers);

    // 3. Stage 1 Defense: Check IP blocklist before querying deals or creating clicks
    const blocked = await isIpBlocked(DB, ipAddress);
    if (blocked) {
      return createBlockedIp403Response();
    }

    // 4. Verify deal exists and is active
    const deal = (await DB.prepare(
      'SELECT id, url, is_active FROM deals WHERE id = ?'
    ).bind(id).first()) as { id: string; url: string; is_active: number } | undefined;

    if (!deal) {
      return NextResponse.json({ error: 'Deal not found' }, { status: 404 });
    }

    if (deal.is_active !== 1) {
      return NextResponse.json({ error: 'Deal is not active' }, { status: 410 });
    }

    // 5. Stage 2 Defense: Check IP rate limit (100/hr, 1,000/day) before logging valid click
    const rateLimit = await checkIpRateLimit(DB, ipAddress);
    if (!rateLimit.allowed) {
      return createRateLimit429Response(rateLimit);
    }

    // 6. Safe request body parsing
    let userId: string | null = null;
    try {
      const body = await request.json();
      if (body && typeof body === 'object') {
        userId = body.userId || null;
      }
    } catch {
      // Body may be empty or invalid JSON
    }

    // 7. Get authenticated user if available
    let authenticatedUserId: string | null = null;
    try {
      const auth = createAuth({ DB });
      const sessionResult = await auth.api.getSession({
        headers: request.headers,
        cookies: request.cookies as unknown as Record<string, string>,
      });
      if (sessionResult?.user) {
        authenticatedUserId = (sessionResult.user as { id: string }).id;
      }
    } catch {
      // Continue without auth
    }

    // 8. Generate tracking cookie ID
    let cookieId = request.cookies.get('apex_tracking_id')?.value;
    if (!cookieId) {
      cookieId = crypto.randomUUID();
    }

    const userAgent = request.headers.get('user-agent') || null;
    const affiliateCode = authenticatedUserId || userId || null;
    const nowIso = new Date().toISOString();

    // 9. Stage 3 Defense: Anomaly Velocity Engine evaluation (<2s burst, >10:1 ratio)
    let velocityResult: VelocityCheckResult;
    try {
      velocityResult = await evaluateClickVelocity(DB, {
        dealId: deal.id,
        affiliateCode: affiliateCode,
        affiliateId: authenticatedUserId || userId,
        sessionId: cookieId,
        ipAddress: ipAddress,
        userAgent: userAgent,
        timestamp: nowIso,
      });
    } catch (velError) {
      logError('Click velocity evaluation error (failing open):', velError);
      velocityResult = {
        isSuspicious: false,
        anomalyScore: 0.0,
        flagReasons: [],
        burstDetected: false,
        ratioAnomalyDetected: false,
        rateLimitViolated: false,
        isIpBlocked: false,
      };
    }

    const isSuspicious = velocityResult.isSuspicious ? 1 : 0;
    const flagReasons = velocityResult.isSuspicious && velocityResult.flagReasons.length > 0
      ? JSON.stringify(velocityResult.flagReasons)
      : null;
    const anomalyScore = velocityResult.isSuspicious ? velocityResult.anomalyScore : 0.0;

    // 10. Record click in deal_clicks table with detection flags and anomaly score
    const clickId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const insertQuery = `
      INSERT INTO deal_clicks (
        id, deal_id, affiliate_code, affiliate_id, session_id,
        ip_address, user_agent, click_type, is_unique,
        is_suspicious, flag_reasons, anomaly_score, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await DB.prepare(insertQuery)
      .bind(
        clickId,
        deal.id,
        affiliateCode,
        authenticatedUserId || userId,
        cookieId,
        ipAddress,
        userAgent,
        'link',
        1,
        isSuspicious,
        flagReasons,
        anomalyScore,
        nowIso
      )
      .run();

    // 11. Set tracking cookie and return response
    const cookieMaxAge = 30 * 24 * 60 * 60; // 30 days
    const response = NextResponse.json({
      success: true,
      redirectUrl: deal.url,
    });
    response.cookies.set('apex_tracking_id', cookieId, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      maxAge: cookieMaxAge,
    });

    return response;
  } catch (error) {
    logError('Affiliate click tracking error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // 1. Database connection check
    let DB: any;
    try {
      DB = getDB();
    } catch {
      DB = (globalThis as any).DB;
    }
    if (!DB) {
      return NextResponse.redirect(new URL('/deals', request.url), 302);
    }

    // 2. Extract client IP with strict Cloudflare precedence
    const ipAddress = extractClientIp(request.headers);

    // 3. Stage 1 Defense: Check IP blocklist before querying deals or creating click records
    const blocked = await isIpBlocked(DB, ipAddress);
    if (blocked) {
      return createBlockedIp403Response();
    }

    // 4. Verify deal exists and is active
    const deal = (await DB.prepare(
      'SELECT id, url, is_active FROM deals WHERE id = ?'
    ).bind(id).first()) as { id: string; url: string; is_active: number } | undefined;

    if (!deal || deal.is_active !== 1) {
      return NextResponse.redirect(new URL('/deals', request.url), 302);
    }

    // 5. Stage 2 Defense: Check IP rate limit before logging valid click
    const rateLimit = await checkIpRateLimit(DB, ipAddress);
    if (!rateLimit.allowed) {
      return createRateLimit429Response(rateLimit);
    }

    // 6. Generate tracking cookie ID
    let cookieId = request.cookies.get('apex_tracking_id')?.value;
    if (!cookieId) {
      cookieId = crypto.randomUUID();
    }

    // 7. Get authenticated user if available
    let authenticatedUserId: string | null = null;
    try {
      const auth = createAuth({ DB });
      const sessionResult = await auth.api.getSession({
        headers: request.headers,
        cookies: request.cookies as unknown as Record<string, string>,
      });
      if (sessionResult?.user) {
        authenticatedUserId = (sessionResult.user as { id: string }).id;
      }
    } catch {
      // Continue without auth
    }

    const userAgent = request.headers.get('user-agent') || null;
    const nowIso = new Date().toISOString();

    // 8. Stage 3 Defense: Anomaly Velocity Engine evaluation (<2s burst, >10:1 ratio)
    let velocityResult: VelocityCheckResult;
    try {
      velocityResult = await evaluateClickVelocity(DB, {
        dealId: deal.id,
        affiliateCode: authenticatedUserId,
        affiliateId: authenticatedUserId,
        sessionId: cookieId,
        ipAddress: ipAddress,
        userAgent: userAgent,
        timestamp: nowIso,
      });
    } catch (velError) {
      logError('Click velocity evaluation error (failing open):', velError);
      velocityResult = {
        isSuspicious: false,
        anomalyScore: 0.0,
        flagReasons: [],
        burstDetected: false,
        ratioAnomalyDetected: false,
        rateLimitViolated: false,
        isIpBlocked: false,
      };
    }

    const isSuspicious = velocityResult.isSuspicious ? 1 : 0;
    const flagReasons = velocityResult.isSuspicious && velocityResult.flagReasons.length > 0
      ? JSON.stringify(velocityResult.flagReasons)
      : null;
    const anomalyScore = velocityResult.isSuspicious ? velocityResult.anomalyScore : 0.0;

    // 9. Record anonymous/authenticated click with detection flags and anomaly score
    const clickId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const insertQuery = `
      INSERT INTO deal_clicks (
        id, deal_id, affiliate_code, affiliate_id, session_id,
        ip_address, user_agent, click_type, is_unique,
        is_suspicious, flag_reasons, anomaly_score, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await DB.prepare(insertQuery)
      .bind(
        clickId,
        deal.id,
        authenticatedUserId,
        authenticatedUserId,
        cookieId,
        ipAddress,
        userAgent,
        'link',
        1,
        isSuspicious,
        flagReasons,
        anomalyScore,
        nowIso
      )
      .run();

    // 10. Construct safe absolute destination URL
    const destinationUrl = new URL(deal.url, request.url);
    const cookieMaxAge = 30 * 24 * 60 * 60;
    const response = NextResponse.redirect(destinationUrl, 302);
    response.cookies.set('apex_tracking_id', cookieId, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      maxAge: cookieMaxAge,
    });

    return response;
  } catch (error) {
    logError('Affiliate redirect error:', error);
    return NextResponse.redirect(new URL('/deals', request.url), 302);
  }
}
