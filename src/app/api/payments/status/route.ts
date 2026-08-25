import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const paymentId = request.nextUrl.searchParams.get('id');
  if (!paymentId) {
    return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
  }

  const db = getDB();
  if (!db) return NextResponse.json({ error: 'Database not configured' }, { status: 503 });

  const row = await db
    .prepare('SELECT status, plan, amount, currency, txn_id, confirmed_at, created_at FROM payments WHERE payment_id = ? LIMIT 1')
    .bind(paymentId)
    .first<{ status: string; plan: string; amount: number; currency: string; txn_id: string | null; confirmed_at: string | null; created_at: string }>();

  if (!row) {
    return NextResponse.json({ success: false, error: 'Payment not found' }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    status: mapStatus(row.status),
    txnId: row.txn_id,
    amount: row.amount,
    currency: row.currency,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
  });
}

function mapStatus(s: string): string { return s; }
function getDB() { return typeof DB !== 'undefined' ? DB : null; }
