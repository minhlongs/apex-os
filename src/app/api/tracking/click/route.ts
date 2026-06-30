/**
 * Click Tracking API
 * Records deal clicks for affiliate attribution and redirects
 *
 * Rate Limiting:
 * - IP-based: 100 req/hour (from rate_limit_configs)
 * - User-based: 1000 req/hour for authenticated users
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { withRateLimit, extractIpAddress, getUserIdFromSession } from '@/lib/ratelimit/middleware';
import { track } from '@/lib/analytics-http';

/**
 * GET /api/tracking/click
 * Records a click on a deal/signal and redirects
 *
 * Query params:
 * - deal_id: (required) The signal/deal ID being clicked
 * - ref: (optional) Referral code to pass through
 * - redirect: (optional) Redirect URL override (default: /[locale]/deals/[deal_id])
 */
export const GET = withRateLimit(async (request: NextRequest): Promise<Response> => {
  try {
    const url = new URL(request.url);
    const dealId = url.searchParams.get('deal_id');
    const refCode = url.searchParams.get('ref');
    const redirectUrl = url.searchParams.get('redirect');

    if (!dealId) {
      return NextResponse.json(
        { error: 'Missing required parameter: deal_id' },
        { status: 400 }
      );
    }

    // Get authenticated user if available
    const auth = createAuth({ DB: (globalThis as unknown as { DB?: Parameters<typeof createAuth>[0]['DB'] }).DB! });
    const sessionResult = await auth.api.getSession({
      headers: request.headers,
      cookies: request.cookies as unknown as Record<string, string>,
    });

    let userId: string | null = null;
    if (sessionResult?.user) {
      userId = (sessionResult.user as { id: string }).id;
    }

    // Generate or retrieve cookie ID for anonymous tracking
    let cookieId = request.cookies.get('apex_tracking_id')?.value;
    if (!cookieId) {
      cookieId = crypto.randomUUID();
    }

    // Collect tracking data
    const ipAddress = extractIpAddress(request.headers);
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

    // Get country from Cloudflare header (if available)
    const countryCode = request.headers.get('cf-ipcountry') || null;

    // Record the click
    const clickId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const affiliateCode = refCode || null;

    // Build INSERT with correct schema columns
    const insertQuery = `
      INSERT INTO deal_clicks (
        id, deal_id, affiliate_code, affiliate_id, session_id,
        ip_address, user_agent, referrer_url, country_code, device_type,
        click_type, is_unique
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!.prepare(insertQuery)
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
        1
      )
      .run();

    // Build redirect URL
    let targetUrl: string;
    if (redirectUrl) {
      targetUrl = redirectUrl;
    } else {
      const locale = url.pathname.split('/')[1] || 'en';
      targetUrl = `/${locale}/deals/${dealId}`;
    }

    // Append referral code if provided
    if (refCode && !url.searchParams.has('ref')) {
      const separator = targetUrl.includes('?') ? '&' : '?';
      targetUrl = `${targetUrl}${separator}ref=${encodeURIComponent(refCode)}`;
    }

    // Set tracking cookie (30-day expiry)
    const cookieMaxAge = 30 * 24 * 60 * 60;
    const response = NextResponse.redirect(targetUrl, { status: 302 });
    response.cookies.set('apex_tracking_id', cookieId, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      maxAge: cookieMaxAge,
    });

    // Track analytics asynchronously (fire-and-forget)
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
    }, ipAddress).catch(() => {}); // Ignore analytics errors

    return response;
  } catch (error) {
    console.error('Error tracking click:', error);
    const url = new URL(request.url);
    const dealId = url.searchParams.get('deal_id');
    const locale = url.pathname.split('/')[1] || 'en';
    const fallbackUrl = `/${locale}/deals/${dealId || ''}`;
    return NextResponse.redirect(fallbackUrl, { status: 302 });
  }
}, {
storage: 'kv',
endpointType: 'click_tracking',
getUserId: getUserIdFromSession,
getIdentifier: (request, userId) => ({
ip: extractIpAddress(request.headers),
userId
})
});
