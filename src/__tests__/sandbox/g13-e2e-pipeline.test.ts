/**
 * @jest-environment node
 *
 * Cross-Piece End-to-End Integration Test:
 * Passkey Step-Up -> Official Partner Ingestion (Bybit v5) -> R2 SHA-256 Vault ->
 * CASH_COLLECTED Reconciliation -> M2 Sybil Graph Check -> D1 Double-Entry Ledger
 * (Safe-Spread Waterfall I4 + T+7 Hold) -> Settlement Dispatch Route
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import {
  PASSKEY_STEPUP_HEADER,
  issuePasskeyStepUpToken,
} from '@/lib/auth/passkey-step-up';
import {
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  SqliteD1Adapter,
  verifyLedgerInvariants,
} from '@/lib/ledger';
import { POST as ingestRoutePost } from '@/app/api/admin/reconciliation/ingest/route';
import { POST as dispatchRoutePost } from '@/app/api/admin/settlement/dispatch/route';

describe('Cross-Piece E2E Pipeline: Partner Ingest -> Ledger I4 -> Passkey Settlement', () => {
  let sqlite: Database.Database;
  let db: SqliteD1Adapter;
  let r2: InMemoryR2Bucket;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const migDir = path.resolve(process.cwd(), 'src/database/migrations');
    for (const file of [
      '001_initial_schema_d1.sql',
      '002_auth_tables.sql',
      '003_affiliate_schema.sql',
      '024_kyc_compliance_schema.sql',
      '028_ascendancy_audit_core.sql',
    ]) {
      sqlite.exec(fs.readFileSync(path.join(migDir, file), 'utf8'));
    }

    // Seed admin session + consumed passkey challenge + trader & L1 affiliate profiles
    const futureExp = new Date(Date.now() + 3600_000).toISOString();
    sqlite
      .prepare(
        `INSERT INTO profiles (id, email, full_name, role, referral_code)
         VALUES
           ('admin_root', 'admin@apexos.app', 'Root Admin', 'admin', 'ADM1'),
           ('trader_u1', 'trader1@proton.me', 'Trader One', 'shopper', 'TRD1'),
           ('aff_l1', 'partner1@agency.io', 'Partner Desk', 'affiliate', 'AFF1')`
      )
      .run();

    sqlite
      .prepare(
        `INSERT INTO sessions (id, user_id, token, expires_at)
         VALUES ('sess_adm_1', 'admin_root', 'adm_bearer_tok_123', ?)`
      )
      .run(futureExp);

    sqlite
      .prepare(
        `INSERT INTO webauthn_challenges (challenge_id, user_id, challenge, purpose, expires_at, consumed)
         VALUES ('chal_adm_1', 'admin_root', 'chal_bytes', 'admin_step_up', ?, 1)`
      )
      .run(futureExp);

    db = new SqliteD1Adapter(sqlite);
    r2 = new InMemoryR2Bucket();
    (globalThis as unknown as { DB?: unknown }).DB = db;
    (globalThis as unknown as { STORAGE?: unknown }).STORAGE = r2;
  });

  afterEach(async () => {
    delete (globalThis as unknown as { DB?: unknown }).DB;
    delete (globalThis as unknown as { STORAGE?: unknown }).STORAGE;
    await db.close();
  });

  it('enforces Passkey step-up, blocks Binance Referral Pro, ingests Bybit v5 into T+7 ledger, and guards settlement', async () => {
    const stepUpToken = issuePasskeyStepUpToken({
      userId: 'admin_root',
      purpose: 'admin_step_up',
      challengeId: 'chal_adm_1',
    });

    // 1. Missing Passkey header on admin ingestion route -> 403 PASSKEY_STEP_UP_REQUIRED
    const noPasskeyRes = await ingestRoutePost(
      new NextRequest('https://apexos.app/api/admin/reconciliation/ingest', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_bearer_tok_123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ exchange: 'bybit' }),
      })
    );
    expect(noPasskeyRes.status).toBe(403);

    // 2. Binance Standard Referral Pro -> 403 BINANCE_REFERRAL_PRO_UID_UNAVAILABLE
    const binanceBlockedRes = await ingestRoutePost(
      new NextRequest('https://apexos.app/api/admin/reconciliation/ingest', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_bearer_tok_123',
          [PASSKEY_STEPUP_HEADER]: stepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ exchange: 'binance_referral_pro' }),
      })
    );
    expect(binanceBlockedRes.status).toBe(403);
    const binanceBody = (await binanceBlockedRes.json()) as { code: string };
    expect(binanceBody.code).toBe('BINANCE_REFERRAL_PRO_UID_UNAVAILABLE');

    // 3. Reconciled Bybit Affiliate v5 ingestion -> R2 SHA-256 + T+7 Inflight Waterfall I4
    const bybitPayload = JSON.stringify({
      retCode: 0,
      retMsg: 'OK',
      result: {
        list: [
          {
            userId: '99887766',
            coin: 'USDC',
            netCommission: '100.00',
            tradeVol: '250000.00',
            recordId: 'bybit_rec_001',
            timestamp: '1763078400000',
          },
        ],
      },
    });
    const walletStatement = JSON.stringify({
      exchange: 'bybit',
      walletCreditedUsd: '100.00',
    });

    const ingestRes = await ingestRoutePost(
      new NextRequest('https://apexos.app/api/admin/reconciliation/ingest', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_bearer_tok_123',
          [PASSKEY_STEPUP_HEADER]: stepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          exchange: 'bybit',
          statementPeriodStart: '2026-11-01T00:00:00.000Z',
          statementPeriodEnd: '2026-11-01T23:59:59.000Z',
          rawPartnerPayload: bybitPayload,
          rawWalletStatementPayload: walletStatement,
          walletCashCollectedUsd: '100.00',
          uidToProfileMap: {
            '99887766': {
              traderProfileId: 'trader_u1',
              l1AffiliateId: 'aff_l1',
              traderEmail: 'trader1@proton.me',
              referrerEmail: 'partner1@agency.io',
            },
          },
        }),
      })
    );
    expect(ingestRes.status).toBe(200);
    const ingestJson = (await ingestRes.json()) as {
      success: boolean;
      mintedBatches: number;
      blockedByFraud: number;
    };
    expect(ingestJson).toMatchObject({
      success: true,
      mintedBatches: 1,
      blockedByFraud: 0,
    });

    // Mature T+7 hold and verify exact Safe-Spread Waterfall I4 balances
    const batchRow = sqlite
      .prepare("SELECT id, hold_until FROM ledger_journal_batches WHERE journal_type = 'COMMISSION_INFLIGHT' LIMIT 1")
      .get() as { id: string; hold_until: string };
    const ledger = new DoubleEntryLedgerService(db);
    const afterHoldIso = new Date(new Date(batchRow.hold_until).getTime() + 60_000).toISOString();
    await ledger.releaseMaturedInflightBatch(batchRow.id, afterHoldIso);

    const affAccount = await ledger.getAccountByOwner('affiliate', 'aff_l1');
    const traderAccount = await ledger.getAccountByOwner('trader', 'trader_u1');
    expect(affAccount?.settledBalanceUnits.toString()).toBe('1425000000'); // $14.25
    expect(traderAccount?.settledBalanceUnits.toString()).toBe('4750000000'); // $47.50

    // 4. Attempting Ethereum L1 on settlement dispatch route fails closed (400)
    const ethBlockedRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_bearer_tok_123',
          [PASSKEY_STEPUP_HEADER]: stepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payoutId: 'po_eth_blocked',
          idempotencyKey: 'idem_eth_blocked',
          affiliateId: 'aff_l1',
          chain: 'ethereum',
          recipientAddress: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1',
          amountUsd: '14.25',
        }),
      })
    );
    expect(ethBlockedRes.status).toBe(400);

    const invariants = await verifyLedgerInvariants(db);
    expect(invariants.valid).toBe(true);
  });
});
