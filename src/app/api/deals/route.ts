/**
 * Deals API Routes
 * Handles listing and creating affiliate deals
 *
 * Rate Limiting:
 * - GET (list): api_general - 500 req/hour per IP, 2000 req/hour per authenticated user
 * - POST (create): admin endpoint - 100 req/hour per IP, 500 req/hour per admin
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { withRateLimit, extractIpAddress, getUserIdFromSession } from '@/lib/ratelimit/middleware';
import { getDB } from '@/lib/db';
import type { AffiliateDeal, CreateDealDto, UpdateDealDto, PaginatedResponse } from '@/types/deal';
import type { D1Database } from '@/lib/db';

/**
 * Check if user is admin
 */
async function isAdmin(DB: D1Database, userId: string): Promise<boolean> {
  const profile = await DB.prepare('SELECT role FROM profiles WHERE id = ?')
    .bind(userId)
    .first<{ role: string }>();
  return profile?.role === 'admin';
}

/**
 * GET /api/deals
 * List deals with optional filters
 * Query params: ?page=1&limit=20&deal_type=product&is_active=true&exchange=binance&category=spot&search=xxx
 */
export const GET = withRateLimit(async (request: NextRequest): Promise<Response> => {
  try {
    const db = getDB();
    const auth = createAuth({ DB: db });

    const sessionResult = await auth.api.getSession({
      headers: request.headers,
      cookies: request.cookies as unknown as Record<string, string>,
    });

    if (!sessionResult?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (sessionResult.user as { id: string }).id;
    const isUserAdmin = await isAdmin(db, userId);

    // Parse query parameters
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
    const dealType = url.searchParams.get('deal_type');
    const isActiveFilter = url.searchParams.get('is_active');
    const exchange = url.searchParams.get('exchange');
    const category = url.searchParams.get('category');
    const riskLevel = url.searchParams.get('risk_level');
    const search = url.searchParams.get('search');

    const offset = (page - 1) * limit;

    // Build query with filters
    const conditions: string[] = [];
    const values: unknown[] = [];

    // Non-admin users only see active deals
    if (!isUserAdmin) {
      conditions.push('is_active = 1');
    }

    if (dealType) {
      conditions.push('deal_type = ?');
      values.push(dealType);
    }

    if (isActiveFilter !== null && isActiveFilter !== undefined) {
      const isActive = isActiveFilter === 'true' || isActiveFilter === '1';
      conditions.push('is_active = ?');
      values.push(isActive ? 1 : 0);
    }

    if (exchange) {
      conditions.push('exchange = ?');
      values.push(exchange);
    }

    if (category) {
      conditions.push('category = ?');
      values.push(category);
    }

    if (riskLevel) {
      conditions.push('risk_level = ?');
      values.push(riskLevel);
    }

    if (search) {
      conditions.push('(name LIKE ? OR description LIKE ?)');
      const searchPattern = `%${search}%`;
      values.push(searchPattern, searchPattern);
    }

    // For admin, also check created_by if provided
    const createdBy = url.searchParams.get('created_by');
    if (createdBy) {
      conditions.push('created_by = ?');
      values.push(createdBy);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM deals ${whereClause}`;
    let countStmt = getDB().prepare(countQuery);
    for (const val of values) {
      countStmt = countStmt.bind(val);
    }
    const countRow = await countStmt.first<{ total: number }>();
    const total = countRow?.total || 0;

    // Get paginated deals
    const dataQuery = `
      SELECT * FROM deals
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    const allValues = [...values, limit, offset];
    let dataStmt = getDB().prepare(dataQuery);
    for (const val of allValues) {
      dataStmt = dataStmt.bind(val);
    }
    const dataResult = await dataStmt.all<AffiliateDeal>();

    const response: PaginatedResponse<AffiliateDeal> = {
      data: dataResult.results,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error listing deals:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}, {
  endpointType: 'api_general',
  getUserId: getUserIdFromSession,
  getIdentifier: (request, userId) => ({
    ip: extractIpAddress(request.headers),
    userId
  }),
  getTier: (request) => {
    // Could extract user tier from session if available
    return undefined;
  }
});

/**
 * POST /api/deals
 * Create a new deal (admin only)
 */
export const POST = withRateLimit(async (request: NextRequest): Promise<Response> => {
  try {
    const db = getDB();
    const auth = createAuth({ DB: db });

    const sessionResult = await auth.api.getSession({
      headers: request.headers,
      cookies: request.cookies as unknown as Record<string, string>,
    });

    if (!sessionResult?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (sessionResult.user as { id: string }).id;
    const admin = await isAdmin(db, userId);

    if (!admin) {
      return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Parse and validate request body
    const body: CreateDealDto = await request.json();

    if (!body.name || !body.url) {
      return NextResponse.json(
        { error: 'Missing required fields: name, url' },
        { status: 400 }
      );
    }

    // Generate deal ID
    const dealId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);

    // Parse metadata JSON if provided
    const metadata = body.metadata ? JSON.stringify(body.metadata) : '{}';

    // Set defaults
    const dealType = body.deal_type || 'product';
    const commissionRate = body.default_commission_rate ?? 0.10;
    const commissionType = body.default_commission_type || 'percentage';
    const fixedAmount = body.fixed_commission_amount || 0;
    const cookieDuration = body.cookie_duration_days || 30;
    const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : 1;
    const description = body.description || null;
    const productId = body.product_id || null;
    const startsAt = body.starts_at || null;
    const endsAt = body.ends_at || null;
    const exchange = body.exchange || null;
    const category = body.category || null;
    const cashbackPercent = body.cashback_percent ?? null;
    const riskLevel = body.risk_level || null;

    // Insert deal with all fields including 004 additions
    const insertQuery = `
      INSERT INTO deals (
        id, name, description, deal_type, product_id, url,
        default_commission_rate, default_commission_type, fixed_commission_amount,
        cookie_duration_days, is_active, starts_at, ends_at, metadata,
        created_by, created_at, updated_at,
        exchange, category, cashback_percent, risk_level
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?)
    `;

    await getDB().prepare(insertQuery)
      .bind(
        dealId,
        body.name,
        description,
        dealType,
        productId,
        body.url,
        commissionRate,
        commissionType,
        fixedAmount,
        cookieDuration,
        isActive,
        startsAt,
        endsAt,
        metadata,
        userId,
        exchange,
        category,
        cashbackPercent,
        riskLevel
      )
      .run();

    // Fetch the created deal
    const selectQuery = 'SELECT * FROM deals WHERE id = ?';
    const newDeal = await getDB().prepare(selectQuery)
      .bind(dealId)
      .first<AffiliateDeal>();

    return NextResponse.json(newDeal, { status: 201 });
  } catch (error) {
    console.error('Error creating deal:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}, {
  endpointType: 'admin',
  getUserId: getUserIdFromSession,
  getIdentifier: (request, userId) => ({
    ip: extractIpAddress(request.headers),
    userId
  }),
  getRole: async (request) => {
    const db = getDB();
    const auth = createAuth({ DB: db });
    const sessionResult = await auth.api.getSession({
      headers: request.headers,
      cookies: request.cookies as unknown as Record<string, string>,
    });
    if (sessionResult?.user) {
      const userId = (sessionResult.user as { id: string }).id;
      return (await isAdmin(db, userId)) ? 'admin' : 'shopper';
    }
    return 'shopper';
  }
});
