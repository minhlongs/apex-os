/**
 * Single Deal API Routes
 * Handles reading, updating, and deleting individual affiliate deals
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import type { AffiliateDeal, UpdateDealDto } from '@/types/deal';
import { error as logError } from '@/lib/logger';

/**
 * Check if user is admin
 */
async function isAdmin(userId: string): Promise<boolean> {
  const db = (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!;
  const profile = await db.prepare('SELECT role FROM profiles WHERE id = ?')
    .bind(userId)
    .first<{ role: string }>();
  return profile?.role === 'admin';
}

/**
 * Helper function to get authenticated user
 */
async function getAuthenticatedUser(request: NextRequest) {
  const auth = createAuth({ DB: (globalThis as unknown as { DB?: Parameters<typeof createAuth>[0]['DB'] }).DB! });

  const sessionResult = await auth.api.getSession({
    headers: request.headers,
    cookies: request.cookies as unknown as Record<string, string>,
  });

  if (!sessionResult?.user) {
    return { user: null, error: 'Unauthorized' };
  }

  // Cast user to known shape
  const user = sessionResult.user as { id: string };
  return { user, error: null };
}

/**
 * Helper function to fetch deal and check access
 * Admin can access any deal. Non-admin can only access if they created it.
 */
async function fetchDealWithAccessCheck(userId: string, dealId: string) {
  const db = (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!;

  const deal = await db.prepare('SELECT * FROM deals WHERE id = ?')
    .bind(dealId)
    .first<AffiliateDeal>();

  if (!deal) {
    return { allowed: false, error: 'Deal not found' };
  }

  // User can access if they created the deal or are admin
  if (deal.created_by === userId) {
    return { allowed: true, deal };
  }

  const admin = await isAdmin(userId);
  if (admin) {
    return { allowed: true, deal };
  }

  return { allowed: false, error: 'Forbidden' };
}

/**
 * GET /api/deals/[id]
 * Get a specific deal by ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: dealId } = await params;
    const { user, error: authError } = await getAuthenticatedUser(request);

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { allowed, deal, error: accessError } = await fetchDealWithAccessCheck(user.id, dealId);

    if (!allowed || !deal) {
      return NextResponse.json({ error: accessError || 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json(deal);
  } catch (error) {
    logError('Error fetching deal:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/deals/[id]
 * Update a deal (partial update)
 * Admin can update any deal. Creator can update their own deals.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: dealId } = await params;
    const { user, error: authError } = await getAuthenticatedUser(request);

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { allowed, deal, error: accessError } = await fetchDealWithAccessCheck(user.id, dealId);

    if (!allowed || !deal) {
      return NextResponse.json({ error: accessError || 'Forbidden' }, { status: 403 });
    }

    const body: UpdateDealDto = await request.json();

    // Build update query dynamically
    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(body.description);
    }
    if (body.deal_type !== undefined) {
      updates.push('deal_type = ?');
      values.push(body.deal_type);
    }
    if (body.product_id !== undefined) {
      updates.push('product_id = ?');
      values.push(body.product_id);
    }
    if (body.url !== undefined) {
      updates.push('url = ?');
      values.push(body.url);
    }
    if (body.default_commission_rate !== undefined) {
      updates.push('default_commission_rate = ?');
      values.push(body.default_commission_rate);
    }
    if (body.default_commission_type !== undefined) {
      updates.push('default_commission_type = ?');
      values.push(body.default_commission_type);
    }
    if (body.fixed_commission_amount !== undefined) {
      updates.push('fixed_commission_amount = ?');
      values.push(body.fixed_commission_amount);
    }
    if (body.cookie_duration_days !== undefined) {
      updates.push('cookie_duration_days = ?');
      values.push(body.cookie_duration_days);
    }
    if (body.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(body.is_active ? 1 : 0);
    }
    if (body.starts_at !== undefined) {
      updates.push('starts_at = ?');
      values.push(body.starts_at);
    }
    if (body.ends_at !== undefined) {
      updates.push('ends_at = ?');
      values.push(body.ends_at);
    }
    if (body.metadata !== undefined) {
      updates.push('metadata = ?');
      values.push(JSON.stringify(body.metadata));
    }
    // Extended fields from 004
    if (body.exchange !== undefined) {
      updates.push('exchange = ?');
      values.push(body.exchange);
    }
    if (body.category !== undefined) {
      updates.push('category = ?');
      values.push(body.category);
    }
    if (body.cashback_percent !== undefined) {
      updates.push('cashback_percent = ?');
      values.push(body.cashback_percent);
    }
    if (body.risk_level !== undefined) {
      updates.push('risk_level = ?');
      values.push(body.risk_level);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const updateQuery = `UPDATE deals SET ${updates.join(', ')} WHERE id = ?`;
    values.push(dealId);

    await (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!.prepare(updateQuery)
      .bind(...values)
      .run();

    // Fetch updated deal
    const updatedDeal = await (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!.prepare('SELECT * FROM deals WHERE id = ?')
      .bind(dealId)
      .first<AffiliateDeal>();

    return NextResponse.json(updatedDeal);
  } catch (error) {
    logError('Error updating deal:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/deals/[id]
 * Delete/deactivate a deal
 * Soft delete: sets is_active = 0 (for audit trail)
 * Admin can delete any deal. Creator can delete their own.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: dealId } = await params;
    const { user, error: authError } = await getAuthenticatedUser(request);

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { allowed, deal, error: accessError } = await fetchDealWithAccessCheck(user.id, dealId);

    if (!allowed || !deal) {
      return NextResponse.json({ error: accessError || 'Forbidden' }, { status: 403 });
    }

    // Soft delete: set is_active = 0
    await (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!.prepare(
      'UPDATE deals SET is_active = 0, updated_at = datetime("now") WHERE id = ?'
    )
      .bind(dealId)
      .run();

    return NextResponse.json({
      success: true,
      message: 'Deal deactivated successfully',
    });
  } catch (error) {
    logError('Error deleting deal:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
