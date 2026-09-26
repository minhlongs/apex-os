/**
 * Click Tracking API
 * Records deal clicks for affiliate attribution and redirects
 *
 * M2 Route Protection:
 * - Strict Cloudflare IP extraction precedence (cf-connecting-ip -> x-forwarded-for -> x-real-ip)
 * - Real-time IP blocklist check (403 Forbidden without logging clicks)
 * - Dual-window D1 rate limiting (100/hr, 1,000/day) returning 429 Too Many Requests
 * - Safe absolute redirect constructing via new URL(target, request.url) to prevent 500 errors
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { getDB } from '@/lib/db';
import { track } from '@/lib/analytics-http';
import { error as logError } from '@/lib/logger';
import {
  isIpBlocked,
  checkIpRateLimit,
  extractClientIp,
  createBlockedIp403Response,
  createRateLimit429Response,
  evaluateClickVelocity,
} from '@/lib/fraud/fraud-engine';
import type { VelocityCheckResult } from '@/types/fraud';

/**
 * GET /api/tracking/click
 * Records a click on a deal/signal and redirects
 *
 * Query params:
 * - deal_id: (required) The signal/deal ID being clicked
 * - ref: (optional) Referral code to pass through
 * - redirect: (optional) Redirect URL override (default: /[locale]/deals/[deal_id])
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const url = new URL(request.url);
    const dealId = url.searchParams.get('deal_id');
    const refCode = url.searchParams.get('ref');
    const redirectUrl = url.searchParams.get('redirect');

    // 1. Get database instance
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

    // 3. Step 1 Defense: Check IP Blocklist before validating params or creating click records
    const blocked = await isIpBlocked(DB, ipAddress);
    if (blocked) {
      return createBlockedIp403Response();
    }

    // 4. Validate required parameter: deal_id
    if (!dealId) {
      return NextResponse.json(
        { error: 'Missing required parameter: deal_id' },
        { status: 400 }
      );
    }

    // 5. Step 2 Defense: Check Dual-Window IP Rate Limit before logging valid click
    const rateLimit = await checkIpRateLimit(DB, ipAddress);
    if (!rateLimit.allowed) {
      return createRateLimit429Response(rateLimit);
    }

    // 6. Get authenticated user if available
    let userId: string | null = null;
    try {
      const auth = createAuth({ DB });
      const sessionResult = await auth.api.getSession({
        headers: request.headers,
        cookies: request.cookies as unknown as Record<string, string>,
      });
      if (sessionResult?.user) {
        userId = (sessionResult.user as { id: string }).id;
      }
    } catch {
      // Continue without auth
    }

    // 7. Generate or retrieve cookie ID for anonymous tracking
    let cookieId = request.cookies.get('apex_tracking_id')?.value;
    if (!cookieId) {
      cookieId = crypto.randomUUID();
    }

    // 8. Collect tracking metadata
    const userAgent = request.headers.get('user-agent') || '';
    const referrer = request.headers.get('referer') || request.headers.get('referrer') || '';

    // Detect device type from user agent
    const ua = userAgent.toLowerCase();
    let deviceType: string;
    if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone') || ua.includes('ipad')) {
      deviceType = 'mobile';
    } else if (ua.includes('tablet')) {
      deviceType = 'tablet';
    } else {
      deviceType = 'desktop';
    }

    // Get country from Cloudflare header
    const countryCode = request.headers.get('cf-ipcountry') || null;

    // 9. Stage 3 Defense: Anomaly Velocity Engine evaluation (<2s burst, >10:1 ratio)
    const clickId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const affiliateCode = refCode || null;
    const nowIso = new Date().toISOString();

    let velocityResult: VelocityCheckResult;
    try {
      velocityResult = await evaluateClickVelocity(DB, {
        dealId: dealId,
        affiliateCode: affiliateCode,
        affiliateId: userId,
        sessionId: cookieId,
        ipAddress: ipAddress,
        userAgent: userAgent,
        referrerUrl: referrer,
        countryCode: countryCode,
        deviceType: deviceType,
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
    const insertQuery = `
      INSERT INTO deal_clicks (
        id, deal_id, affiliate_code, affiliate_id, session_id,
        ip_address, user_agent, referrer_url, country_code, device_type,
        click_type, is_unique,
        is_suspicious, flag_reasons, anomaly_score, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await DB.prepare(insertQuery)
      .bind(
        clickId,
        dealId,
        affiliateCode,
        userId,
        cookieId,
        ipAddress,
        userAgent.substring(0, 500),
        referrer.substring(0, 500),
        countryCode,
        deviceType,
        'link',
        1,
        isSuspicious,
        flagReasons,
        anomalyScore,
        nowIso
      )
      .run();

    // 11. Construct Absolute Redirect URL (FIX: eliminates relative redirect 500 error)
    let targetPath: string;
    if (redirectUrl) {
      targetPath = redirectUrl;
    } else {
      const locale = url.pathname.split('/')[1] || 'en';
      targetPath = `/${locale}/deals/${dealId}`;
    }

    // Append referral code if provided and not already present in destination
    if (refCode && !targetPath.includes('ref=')) {
      const separator = targetPath.includes('?') ? '&' : '?';
      targetPath = `${targetPath}${separator}ref=${encodeURIComponent(refCode)}`;
    }

    // Construct absolute URL safely using request.url as base
    const absoluteTargetUrl = new URL(targetPath, request.url);
    const response = NextResponse.redirect(absoluteTargetUrl, { status: 302 });

    // Set tracking cookie (30-day expiry)
    const cookieMaxAge = 30 * 24 * 60 * 60;
    response.cookies.set('apex_tracking_id', cookieId, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      maxAge: cookieMaxAge,
    });

    // 11. Track analytics asynchronously (fire-and-forget)
    const analyticsUserId = userId || `anonymous:${cookieId}`;
    track('deal_click', analyticsUserId, {
      deal_id: dealId,
      affiliate_code: affiliateCode,
      ip_address: ipAddress,
      user_agent: userAgent.substring(0, 200),
      referrer_url: referrer,
      country_code: countryCode,
      device_type: deviceType,
      session_id: cookieId,
    }, ipAddress).catch(() => {});

    return response;
  } catch (error) {
    logError('Error tracking click:', error);
    const url = new URL(request.url);
    const dealId = url.searchParams.get('deal_id');
    const locale = url.pathname.split('/')[1] || 'en';
    const fallbackPath = `/${locale}/deals/${dealId || ''}`;
    // Construct absolute fallback redirect URL safely
    const fallbackUrl = new URL(fallbackPath, request.url);
    return NextResponse.redirect(fallbackUrl, { status: 302 });
  }
}
