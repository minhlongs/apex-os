import { NextRequest, NextResponse } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import { error as logError } from '@/lib/logger';

export interface PaymentRecordRow {
  id: string;
  payment_id: string;
  status: string;
  plan: string | null;
  user_id: string | null;
  amount: number | null;
  currency: string | null;
  txn_id: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FormattedPayment {
  id: string;
  paymentId: string;
  payment_id: string;
  orderId: string;
  status: string;
  plan: string;
  userId?: string;
  user_id?: string;
  amount: number;
  currency: string;
  txnId: string | null;
  txn_id: string | null;
  confirmedAt: string | null;
  confirmed_at: string | null;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaymentHistoryResponse {
  success: boolean;
  payments: FormattedPayment[];
  data: FormattedPayment[];
  pagination: PaginationMeta;
  error?: string;
}

function getDatabase(): D1Database | null {
  try {
    return getDB();
  } catch {
    return resolveDatabase();
  }
}

/**
 * Normalizes payment record from D1 to satisfy both camelCase and snake_case consumers
 */
function formatPaymentRow(row: PaymentRecordRow): FormattedPayment {
  return {
    id: row.id,
    paymentId: row.payment_id,
    payment_id: row.payment_id,
    orderId: row.payment_id,
    status: row.status,
    plan: row.plan ?? '',
    userId: row.user_id ?? undefined,
    user_id: row.user_id ?? undefined,
    amount: Number(row.amount ?? 0),
    currency: row.currency ?? 'USDT',
    txnId: row.txn_id ?? null,
    txn_id: row.txn_id ?? null,
    confirmedAt: row.confirmed_at ?? null,
    confirmed_at: row.confirmed_at ?? null,
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    updated_at: row.updated_at,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. Authentication check
    const user = await getAuthenticatedUser(request);
    if (!user || !user.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 2. Parse and normalize query parameters
    const searchParams = request.nextUrl.searchParams;

    const rawPage = parseInt(searchParams.get('page') ?? '1', 10);
    const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;

    const rawLimit = parseInt(searchParams.get('limit') ?? '10', 10);
    let limit = isNaN(rawLimit) || rawLimit < 1 ? 10 : rawLimit;
    if (limit > 100) {
      limit = 100; // Cap excessive page limit
    }

    const offset = (page - 1) * limit;

    const statusParam = searchParams.get('status')?.trim().toLowerCase();
    const hasStatusFilter = Boolean(statusParam);

    // 3. Acquire database connection
    const db = getDatabase();
    if (!db) {
      logError('[Payments:History] Database service unavailable');
      return NextResponse.json(
        { success: false, error: 'Database service unavailable' },
        { status: 503 }
      );
    }

    // 4. Query total count
    let countSql = 'SELECT COUNT(*) as total FROM payments WHERE user_id = ?';
    const countBindings: (string | number)[] = [user.id];

    if (hasStatusFilter && statusParam) {
      countSql += ' AND status = ?';
      countBindings.push(statusParam);
    }

    const countResult = await db
      .prepare(countSql)
      .bind(...countBindings)
      .first<{ total?: number; count?: number }>();
    const total = Number(countResult?.total ?? countResult?.count ?? 0);

    // 5. Query paginated records
    let dataSql = `
      SELECT id, payment_id, status, plan, user_id, amount, currency, txn_id, confirmed_at, created_at, updated_at
      FROM payments
      WHERE user_id = ?
    `;
    const dataBindings: (string | number)[] = [user.id];

    if (hasStatusFilter && statusParam) {
      dataSql += ' AND status = ?';
      dataBindings.push(statusParam);
    }

    dataSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    dataBindings.push(limit, offset);

    const { results } = await db
      .prepare(dataSql)
      .bind(...dataBindings)
      .all<PaymentRecordRow>();

    const formattedPayments = (results ?? []).map(formatPaymentRow);
    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;

    // 6. Return response satisfying both REST and Mobile contracts
    const responseBody: PaymentHistoryResponse = {
      success: true,
      payments: formattedPayments,
      data: formattedPayments,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };

    return NextResponse.json(responseBody, { status: 200 });
  } catch (error) {
    logError('[Payments:History] Unhandled error querying payment history:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal Server Error',
      },
      { status: 500 }
    );
  }
}
