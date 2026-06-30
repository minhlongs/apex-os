#!/usr/bin/env tsx
/**
 * ApexOS Database Seed Script
 * Populate database with demo data for development/testing
 *
 * Usage: tsx scripts/seed-db.ts
 * Make sure wrangler dev is running first.
 */

import { DB } from '@/lib/db/d1-types';

function now(): string {
  return new Date().toISOString();
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

async function exec(DB: DB, sql: string, params?: unknown[]): Promise<{ success: boolean; changes: number }> {
  const stmt = DB.prepare(sql);
  if (params?.length) {
    return stmt.bind(...params).run();
  }
  return stmt.run();
}

function log(message: string, data?: Record<string, unknown>): void {
  console.log(`[seed] ${message}`, data ? JSON.stringify(data) : '');
}

// ============================================
// SEED DATA
// ============================================

const AFFILIATES = [
  { name: 'Crypto King', email: 'king@test.com', code: 'KING001' },
  { name: 'Trading Pro', email: 'pro@test.com', code: 'PRO002' },
  { name: 'HODL Master', email: 'hodl@test.com', code: 'HODL003' },
  { name: 'Satoshi Fan', email: 'satoshi@test.com', code: 'SAT004' },
  { name: 'DeFi Wizard', email: 'wizard@test.com', code: 'WIZ005' },
];

const DEALS = [
  {
    name: 'Binance Spot Trading',
    description: 'Earn 30% cashback on Binance spot trading fees',
    dealType: 'service',
    productId: 'binance-spot',
    url: 'https://binance.com/en/register?ref=SEED001',
    exchange: 'binance',
    category: 'spot',
    cashbackPct: 30,
  },
  {
    name: 'Bybit Futures Elite',
    description: 'Premium futures trading - 40% commission',
    dealType: 'service',
    productId: 'bybit-futures',
    url: 'https://bybit.com/en/register?ref=SEED001',
    exchange: 'bybit',
    category: 'futures',
    cashbackPct: 40,
  },
  {
    name: 'OKX Exchange Pro',
    description: 'Full-featured exchange with 25% commission',
    dealType: 'service',
    productId: 'okx-signup',
    url: 'https://okx.com/affiliate?ref=SEED001',
    exchange: 'okx',
    category: 'spot',
    cashbackPct: 25,
  },
];

// ============================================
// MAIN
// ============================================

async function seed(): Promise<void> {
  log('Starting seed...');

  const DB = (globalThis as unknown as { DB: DB })?.DB;
  if (!DB) {
    console.error('❌ Database not available! Start wrangler dev first.');
    process.exit(1);
  }

  const nowStr = now();
  const adminId = 'seed-admin-001';

  try {
    // Clear existing seed data (safe cleanup)
    log('Cleaning up existing seed data...');
    await exec(DB, 'DELETE FROM earnings WHERE conversion_id IN (SELECT id FROM conversions WHERE customer_id LIKE "seed-%")');
    await exec(DB, 'DELETE FROM conversions WHERE customer_id LIKE "seed-%"');
    await exec(DB, 'DELETE FROM deal_clicks WHERE session_id LIKE "seed-%"');
    await exec(DB, 'DELETE FROM payouts WHERE affiliate_id IN (SELECT id FROM profiles WHERE email LIKE "%@test.com")');
    await exec(DB, 'DELETE FROM affiliate_codes WHERE affiliate_id IN (SELECT id FROM profiles WHERE email LIKE "%@test.com")');
    await exec(DB, 'DELETE FROM referral_tree WHERE affiliate_id IN (SELECT id FROM profiles WHERE email LIKE "%@test.com")');
    await exec(DB, 'DELETE FROM profiles WHERE email LIKE "%@test.com"');
    await exec(DB, 'DELETE FROM users WHERE email LIKE "%@test.com"');
    await exec(DB, 'DELETE FROM deals WHERE created_by = ?', [adminId]);

    // 1. Create seed admin
    log('Creating admin...');
    await exec(DB,
      `INSERT INTO users (id, email, email_verified, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [adminId, 'admin@seed.local', 1, 'Seed Admin', nowStr, nowStr]
    );

    await exec(DB,
      `INSERT INTO profiles (id, email, full_name, role, plan, referral_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [adminId, 'admin@seed.local', 'Seed Admin', 'admin', 'master', 'SEEDADMIN', nowStr, nowStr]
    );

    // 2. Create affiliates (5 users)
    log('Creating 5 affiliates...');
    const affiliateIds: string[] = [];

    for (let i = 0; i < AFFILIATES.length; i++) {
      const aff = AFFILIATES[i];
      const id = `aff-${i + 1}`;

      await exec(DB,
        `INSERT INTO users (id, email, email_verified, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, aff.email, 1, aff.name, nowStr, nowStr]
      );

      const referredBy = i === 0 ? null : affiliateIds[0]; // First is root, others refer to first
      await exec(DB,
        `INSERT INTO profiles (id, email, full_name, avatar_url, role, plan, referral_code, referred_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, aff.email, aff.name, `https://api.dicebear.com/7.x/avataaars/svg?seed=${aff.code}`, 'affiliate', 'growth', aff.code, referredBy, nowStr, nowStr]
      );

      affiliateIds.push(id);
    }

    // Create referral tree
    for (let i = 0; i < affiliateIds.length; i++) {
      const affiliateId = affiliateIds[i];
      const parentId = i === 0 ? null : affiliateIds[0];
      const rootId = i === 0 ? affiliateId : affiliateIds[0];
      const level = i === 0 ? 1 : 2;
      const path = i === 0 ? affiliateId : `${affiliateIds[0]}/${affiliateId}`;

      await exec(DB,
        `INSERT INTO referral_tree (id, affiliate_id, parent_id, root_id, level, path, total_direct_referrals, total_indirect_referrals, total_earnings, total_payouts, is_active, joined_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0.00, 0.00, 1, ?, ?)`,
        [affiliateId, affiliateId, parentId, rootId, level, path, nowStr, nowStr]
      );
    }

    // Create affiliate codes
    for (let i = 0; i < AFFILIATES.length; i++) {
      await exec(DB,
        `INSERT INTO affiliate_codes (id, code, affiliate_id, commission_rate, commission_type, max_uses, used_count, is_active, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`code-${i + 1}`, AFFILIATES[i].code, affiliateIds[i], 0.30, 'percentage', -1, 0, 1, '{}', nowStr, nowStr]
      );
    }

    log('Affiliates created', { count: AFFILIATES.length });

    // 3. Create deals (3 deals)
    log('Creating 3 deals...');
    const dealIds: string[] = [];

    for (let i = 0; i < DEALS.length; i++) {
      const deal = DEALS[i];
      const id = `deal-${i + 1}`;

      await exec(DB,
        `INSERT INTO deals (
          id, name, description, deal_type, product_id, url,
          exchange, category, cashback_pct, is_active,
          starts_at, ends_at, metadata, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, deal.name, deal.description, deal.dealType, deal.productId, deal.url,
         deal.exchange, deal.category, deal.cashbackPct, 1,
         nowStr, null, '{}', adminId, nowStr, nowStr]
      );

      dealIds.push(id);
      log(`Created deal`, { name: deal.name, exchange: deal.exchange });
    }

    // 4. Create clicks and conversions
    log('Creating clicks and conversions...');

    const clicks = [
      { dealIdx: 0, affIdx: 2, sessionId: 'seed-sess-001', hoursAgo: 2 },
      { dealIdx: 0, affIdx: 2, sessionId: 'seed-sess-002', hoursAgo: 24 },
      { dealIdx: 1, affIdx: 3, sessionId: 'seed-sess-003', hoursAgo: 6 },
      { dealIdx: 2, affIdx: 4, sessionId: 'seed-sess-004', hoursAgo: 3 },
    ];

    const clickIds: string[] = [];

    for (const click of clicks) {
      const id = `click-${clickIds.length + 1}`;
      const dealId = dealIds[click.dealIdx];
      const affiliateId = affiliateIds[click.affIdx];

      await exec(DB,
        `INSERT INTO deal_clicks (id, deal_id, affiliate_id, session_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, dealId, affiliateId, click.sessionId, daysAgo(click.hoursAgo / 24)]
      );

      clickIds.push(id);
    }

    // Create conversions
    const conversions = [
      { clickIdx: 0, customerId: 'seed-cust-001', orderId: 'seed-ORD-001', revenue: 1250.00 },
      { clickIdx: 1, customerId: 'seed-cust-002', orderId: 'seed-ORD-002', revenue: 800.00 },
      { clickIdx: 2, customerId: 'seed-cust-003', orderId: 'seed-ORD-003', revenue: 2100.00 },
      { clickIdx: 3, customerId: 'seed-cust-004', orderId: 'seed-ORD-004', revenue: 450.00 },
    ];

    for (const conv of conversions) {
      const id = `conv-${conversions.indexOf(conv) + 1}`;
      const click = clicks[conv.clickIdx];
      const dealId = dealIds[click.dealIdx];
      const affiliateId = affiliateIds[click.affIdx];
      const affiliateCode = AFFILIATES[click.affIdx].code;
      const commissionAmount = conv.revenue * 0.30;

      await exec(DB,
        `INSERT INTO conversions (
          id, deal_id, deal_click_id, affiliate_code, affiliate_id,
          customer_id, order_id, revenue, currency, commission_amount,
          commission_type, conversion_type, status, conversion_data, converted_at, approved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, dealId, clickIds[conv.clickIdx], affiliateCode, affiliateId,
         conv.customerId, conv.orderId, conv.revenue, 'USD', commissionAmount,
         'percentage', 'sale', 'approved', `{"volume_usd": ${conv.revenue}}`,
         daysAgo(click.hoursAgo / 24), daysAgo(click.hoursAgo / 24)]
      );

      log('Created conversion', { orderId: conv.orderId, revenue: conv.revenue });

      // Create earnings (direct only for simplicity)
      const earnId = `earn-${conversions.indexOf(conv) + 1}`;
      await exec(DB,
        `INSERT INTO earnings (id, conversion_id, affiliate_id, amount, commission_rate, level, is_paid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [earnId, id, affiliateId, commissionAmount, 0.30, 1, 0, nowStr, nowStr]
      );
    }

    log('✅ Seed completed!');
    log('Summary:', {
      affiliates: AFFILIATES.length,
      deals: DEALS.length,
      clicks: clicks.length,
      conversions: conversions.length,
    });

  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  }
}

seed();
