/**
 * Admin Unpaid Earnings Export API
 * Returns unpaid earnings for manual payout processing with wallet addresses
 * Admin only endpoint
 *
 * Output format: CSV with wallet_address, amount, stellar_destination, affiliate_name, email
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getDB } from '@/lib/db';

export interface UnpaidEarning {
  earning_id: string;
  affiliate_id: string;
  affiliate_name: string | null;
  email: string;
  wallet_address: string;
  preferred_chain: string;
  amount: number;
  conversion_id: string;
  order_id: string | null;
  deal_name: string | null;
  created_at: string;
  level: number;
}

/**
 * GET /api/admin/affiliates/unpaid-earnings
 * Returns all unpaid earnings with wallet information for payout export
 * Query params:
 * - chain: filter by blockchain network (ethereum, solana, stellar, etc.)
 * - minAmount: minimum amount threshold
 * - format: 'json' (default) or 'csv' for direct CSV download
 */
export async function GET(request: NextRequest): Promise<Response> {
  const startTime = Date.now();

 try {
  const admin = await requireAdmin(request);
  if (!admin) {
   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = getDB();
  const userId = admin.userId;

    // Parse query parameters
    const url = new URL(request.url);
    const chainFilter = url.searchParams.get('chain') || undefined;
    const minAmount = parseFloat(url.searchParams.get('minAmount') || '0');
    const format = url.searchParams.get('format') || 'json';

    // Fetch unpaid earnings with wallet information
    // Query joins earnings -> profiles -> wallet_connections
    const query = `
      SELECT
        e.id as earning_id,
        e.affiliate_id,
        p.full_name,
        p.email,
        wc.wallet_address,
        wc.preferred_chain,
        e.amount,
        e.level,
        e.created_at,
        c.order_id,
        d.name as deal_name
      FROM earnings e
      JOIN profiles p ON e.affiliate_id = p.id
      JOIN wallet_connections wc ON p.id = wc.profile_id AND wc.is_primary = 1
      LEFT JOIN conversions c ON e.conversion_id = c.id
      LEFT JOIN deals d ON c.deal_id = d.id
      WHERE e.is_paid = 0
      ${chainFilter ? 'AND wc.preferred_chain = ?' : ''}
      ${minAmount > 0 ? 'AND e.amount >= ?' : ''}
      ORDER BY e.created_at DESC
    `;

    const bindings = [];
    if (chainFilter) bindings.push(chainFilter);
    if (minAmount > 0) bindings.push(minAmount);

    const results = await db.prepare(query)
      .bind(...bindings)
      .all<UnpaidEarning>();

    const unpaidEarnings = results.results;

    // If CSV format requested, return CSV directly
    if (format === 'csv') {
      const csvContent = generateCSV(unpaidEarnings);
      const timestamp = new Date().toISOString().split('T')[0];

      return new Response(csvContent, {
        headers: {
          'Content-Type': 'text/csv;charset=utf-8',
          'Content-Disposition': `attachment; filename="unpaid-earnings-${timestamp}.csv"`,
        },
      });
    }

    // Otherwise return JSON
    return NextResponse.json({
      unpaidEarnings,
      total: unpaidEarnings.length,
      totalAmount: unpaidEarnings.reduce((sum, e) => sum + e.amount, 0),
      queryTime: Date.now() - startTime,
    });
  } catch (error) {
    console.error('Error fetching unpaid earnings:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}

/**
 * Generate CSV content from unpaid earnings data
 */
function generateCSV(data: UnpaidEarning[]): string {
  if (data.length === 0) {
    return 'No unpaid earnings found';
  }

  // CSV headers
  const headers = [
    'wallet_address',
    'amount_usd',
    'stellar_destination',
    'affiliate_name',
    'email',
    'chain',
    'order_id',
    'deal_name',
    'earning_id',
    'created_at',
  ];

  // CSV rows
  const rows = data.map(earning => [
    earning.wallet_address,
    earning.amount.toFixed(2),
    earning.wallet_address, // Stellar destination = wallet address
    earning.affiliate_name || '',
    earning.email,
    earning.preferred_chain,
    earning.order_id || '',
    earning.deal_name || '',
    earning.earning_id,
    earning.created_at,
  ]);

  // Combine with BOM for Excel compatibility
  const csvBody = [headers, ...rows]
    .map(row => row.map(cell => {
      // Escape quotes and wrap in quotes if contains comma, quote, or newline
      const str = String(cell);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(','))
    .join('\n');

  return '﻿' + csvBody; // Add BOM for UTF-8 Excel compatibility
}
