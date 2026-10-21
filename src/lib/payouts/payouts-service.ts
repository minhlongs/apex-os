/**
 * Payouts Service
 * ApexOS Affiliate Cashback System
 *
 * Handles payout record creation and database operations
 */

import type { D1Database } from '@/lib/auth/adapters/d1-adapter';

export interface PayoutCreateParams {
  affiliate_id: string;
  payout_method: 'bank_transfer' | 'crypto' | 'paypal' | 'stripe' | 'momo' | 'sepay' | 'vnpay';
  payout_method_details: Record<string, unknown>;
  amount: number;
  currency: string;
  fee: number;
  net_amount: number;
  scheduled_at: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface PayoutRecord {
  id: string;
  affiliate_id: string;
  payout_method: string;
  payout_method_details: string;
  amount: number;
  currency: string;
  fee: number;
  net_amount: number;
  status: string;
  scheduled_at: string | null;
  paid_at: string | null;
  transaction_id: string | null;
  notes: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Payouts Service for managing payout records
 */
export class PayoutsService {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Create a new payout record
   */
  async createPayout(params: PayoutCreateParams): Promise<PayoutRecord> {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const now = new Date().toISOString();

    const query = `
      INSERT INTO payouts (
        id, affiliate_id, payout_method, payout_method_details,
        amount, currency, fee, net_amount, status,
        scheduled_at, paid_at, transaction_id, notes, metadata,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.db.prepare(query).bind(
      id,
      params.affiliate_id,
      params.payout_method,
      JSON.stringify(params.payout_method_details),
      params.amount,
      params.currency,
      params.fee,
      params.net_amount,
      params.status,
      params.scheduled_at,
      null, // paid_at
      null, // transaction_id
      params.notes || null,
      params.metadata ? JSON.stringify(params.metadata) : '{}',
      now,
      now
    ).run();

    // Return the created payout
    const created = await this.getPayoutById(id);
    if (!created) {
      throw new Error(`Payout ${id} was inserted but could not be read back`);
    }
    return created;
  }

  /**
   * Get payout by ID
   */
  async getPayoutById(id: string): Promise<PayoutRecord | null> {
    const result = await this.db.prepare(
      'SELECT * FROM payouts WHERE id = ?'
    )
      .bind(id)
      .first<PayoutRecord>();

    return result || null;
  }

  /**
   * Update payout status
   */
  async updatePayoutStatus(
    id: string,
    status: PayoutRecord['status'],
    transactionId?: string
  ): Promise<PayoutRecord | null> {
    const now = new Date().toISOString();

    const updates = ['status = ?', 'updated_at = ?'];
    const params: (string | number | null)[] = [status, now];

    if (transactionId) {
      updates.push('transaction_id = ?', 'paid_at = ?');
      params.push(transactionId, now);
    }

    params.push(id);

    const query = `UPDATE payouts SET ${updates.join(', ')} WHERE id = ?`;
    await this.db.prepare(query).bind(...params).run();

    return this.getPayoutById(id);
  }

  /**
   * Get payouts for an affiliate
   */
  async getPayoutsByAffiliate(
    affiliateId: string,
    options: { page?: number; limit?: number; status?: string } = {}
  ): Promise<{ data: PayoutRecord[]; total: number; totalPages: number }> {
    const { page = 1, limit = 20, status } = options;
    const offset = (page - 1) * limit;

    const conditions = ['affiliate_id = ?'];
    const params: (string | number)[] = [affiliateId];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM payouts ${whereClause}`;
    const countResult = await this.db.prepare(countQuery)
      .bind(...params)
      .first<{ total: number }>();
    const total = countResult?.total || 0;

    // Get paginated results
    const dataQuery = `
      SELECT * FROM payouts
      ${whereClause}
      ORDER BY scheduled_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `;
    const allParams = [...params, limit, offset];
    const results = await this.db.prepare(dataQuery)
      .bind(...allParams)
      .all<PayoutRecord>();

    return {
      data: results.results,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get summary stats for all payouts
   */
  async getPayoutsSummary(): Promise<{
    total_payouts: number;
    total_paid: number;
    pending_amount: number;
    total_fees: number;
  }> {
    const query = `
      SELECT
        COUNT(*) as total_payouts,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN net_amount ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(CASE WHEN status IN ('pending', 'processing') THEN net_amount ELSE 0 END), 0) as pending_amount,
        COALESCE(SUM(fee), 0) as total_fees
      FROM payouts
    `;

    const result = await this.db.prepare(query)
      .first<{
        total_payouts: number;
        total_paid: number;
        pending_amount: number;
        total_fees: number;
      }>();

    return result || { total_payouts: 0, total_paid: 0, pending_amount: 0, total_fees: 0 };
  }
}

/**
 * Factory function to create PayoutsService
 */
export function createPayoutsService(db: D1Database): PayoutsService {
  return new PayoutsService(db);
}
