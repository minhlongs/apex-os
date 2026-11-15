/**
 * Gate G2: Trust Boundary, R2 SHA-256 Evidence Vault, CASH_COLLECTED Gate,
 * Formance-Style Idempotency (422 Conflict) & PII-Redacted B2B Proof-of-Rebate
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextRequest } from 'next/server';
import {
  DoubleEntryLedgerService,
  EvidenceIntegrityError,
  IdempotencyConflictError,
  InMemoryR2Bucket,
  SqliteD1Adapter,
  UnreconciledCashError,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  verifyEvidenceIntegrity,
} from '@/lib/ledger';
import { GET as getProofOfRebateRoute } from '@/app/api/b2b/proof-of-rebate/route';

function createMigratedSandboxDb(): {
  sqlite: Database.Database;
  db: SqliteD1Adapter;
} {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const migrationsDir = path.resolve(process.cwd(), 'src/database/migrations');
  for (const file of [
    '001_initial_schema_d1.sql',
    '003_affiliate_schema.sql',
    '028_ascendancy_audit_core.sql',
  ]) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    sqlite.exec(sql);
  }
  return { sqlite, db: new SqliteD1Adapter(sqlite) };
}

describe('Gate G2: Trust Boundary, R2 Evidence Integrity & Idempotency Fingerprints', () => {
  let db: SqliteD1Adapter;
  let r2: InMemoryR2Bucket;
  let ledger: DoubleEntryLedgerService;

  beforeEach(() => {
    const setup = createMigratedSandboxDb();
    db = setup.db;
    r2 = new InMemoryR2Bucket();
    ledger = new DoubleEntryLedgerService(db);
  });

  afterEach(async () => {
    delete (globalThis as unknown as { DB?: unknown }).DB;
    delete (globalThis as unknown as { STORAGE?: unknown }).STORAGE;
    await db.close();
  });

  it('rejects any ledger commission credit that attempts to bypass CASH_COLLECTED reconciliation', async () => {
    const uidStatement = JSON.stringify({
      exchange: 'bybit',
      rows: [{ uid: '98761234', commissionUsd: '100.00' }],
    });
    const ev = await storeEvidenceObject(db, r2, {
      exchange: 'bybit',
      sourceKind: 'rest_poll',
      rawBytes: uidStatement,
      statementPeriodStart: '2026-11-01T00:00:00.000Z',
      statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      createdAt: '2026-11-02T00:05:00.000Z',
    });

    await expect(
      ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'idem-bypass-recon-1',
        exchange: 'bybit',
        traderUid: '98761234',
        traderId: 'trader_alpha',
        l1AffiliateId: 'aff_partner_1',
        reconciliationId: 'recon_non_existent',
        evidenceId: ev.id,
        grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
        r2,
      })
    ).rejects.toThrow(UnreconciledCashError);
  });

  it('rejects commission minting when reconciliation is DISCREPANCY_HALTED or cap is exceeded', async () => {
    const uidEv = await storeEvidenceObject(db, r2, {
      exchange: 'okx',
      sourceKind: 'csv_statement',
      rawBytes: 'uid,commission_usdc\n55551111,250.00\n',
      statementPeriodStart: '2026-11-01T00:00:00.000Z',
      statementPeriodEnd: '2026-11-01T23:59:59.000Z',
    });
    const haltedWalletEv = await storeEvidenceObject(db, r2, {
      exchange: 'okx',
      sourceKind: 'wallet_statement',
      rawBytes: JSON.stringify({ creditedUsdc: '249.99' }),
      statementPeriodStart: '2026-11-01T00:00:00.000Z',
      statementPeriodEnd: '2026-11-01T23:59:59.000Z',
    });

    const haltedRecon = await reconcilePartnerCashBatch(db, {
      exchange: 'okx',
      evidenceId: uidEv.id,
      walletEvidenceId: haltedWalletEv.id,
      uidAllocatedUnits: parseUsdToLedgerUnits('250.00'),
      walletCashCollectedUnits: parseUsdToLedgerUnits('249.99'),
      r2,
    });
    expect(haltedRecon.status).toBe('DISCREPANCY_HALTED');

    await expect(
      ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'idem-halted-recon',
        exchange: 'okx',
        traderUid: '55551111',
        traderId: 'trader_okx_1',
        l1AffiliateId: 'aff_okx_1',
        reconciliationId: haltedRecon.id,
        evidenceId: uidEv.id,
        grossCommissionUnits: parseUsdToLedgerUnits('250.00'),
        r2,
      })
    ).rejects.toThrow(UnreconciledCashError);

    // Matched reconciliation capped at $250.00 rejects over-minting $250.01
    const matchedWalletEv = await storeEvidenceObject(db, r2, {
      exchange: 'okx',
      sourceKind: 'wallet_statement',
      rawBytes: JSON.stringify({ creditedUsdc: '250.00' }),
      statementPeriodStart: '2026-11-01T00:00:00.000Z',
      statementPeriodEnd: '2026-11-01T23:59:59.000Z',
    });
    const matchedRecon = await reconcilePartnerCashBatch(db, {
      exchange: 'okx',
      evidenceId: uidEv.id,
      walletEvidenceId: matchedWalletEv.id,
      uidAllocatedUnits: parseUsdToLedgerUnits('250.00'),
      walletCashCollectedUnits: parseUsdToLedgerUnits('250.00'),
      r2,
    });
    expect(matchedRecon.status).toBe('MATCHED');

    await expect(
      ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'idem-over-cap',
        exchange: 'okx',
        traderUid: '55551111',
        traderId: 'trader_okx_1',
        l1AffiliateId: 'aff_okx_1',
        reconciliationId: matchedRecon.id,
        evidenceId: uidEv.id,
        grossCommissionUnits: parseUsdToLedgerUnits('250.01'),
        r2,
      })
    ).rejects.toThrow(UnreconciledCashError);
  });

  it('anchors 5-year (+1826d) retention and blocks minting if R2 object bytes are tampered', async () => {
    const createdAt = '2026-11-10T00:00:00.000Z';
    const uidEv = await storeEvidenceObject(db, r2, {
      exchange: 'bitget',
      sourceKind: 'rest_poll',
      rawBytes: JSON.stringify({ uid: '12349999', commission: '80.00' }),
      statementPeriodStart: '2026-11-09T00:00:00.000Z',
      statementPeriodEnd: '2026-11-09T23:59:59.000Z',
      createdAt,
    });
    const walletEv = await storeEvidenceObject(db, r2, {
      exchange: 'bitget',
      sourceKind: 'wallet_statement',
      rawBytes: JSON.stringify({ walletCredit: '80.00' }),
      statementPeriodStart: '2026-11-09T00:00:00.000Z',
      statementPeriodEnd: '2026-11-09T23:59:59.000Z',
      createdAt,
    });

    const retentionDeltaDays =
      (Date.parse(uidEv.retentionUntil) - Date.parse(createdAt)) / (24 * 60 * 60 * 1000);
    expect(retentionDeltaDays).toBe(1826);

    const recon = await reconcilePartnerCashBatch(db, {
      exchange: 'bitget',
      evidenceId: uidEv.id,
      walletEvidenceId: walletEv.id,
      uidAllocatedUnits: parseUsdToLedgerUnits('80.00'),
      walletCashCollectedUnits: parseUsdToLedgerUnits('80.00'),
      r2,
    });

    // Tamper raw bytes in R2 with same length -> SHA-256 mismatch
    r2.tamperStoredBytes(
      uidEv.r2ObjectKey,
      JSON.stringify({ uid: '12349999', commission: '90.00' })
    );

    const check = await verifyEvidenceIntegrity(db, r2, uidEv.id);
    expect(check.valid).toBe(false);
    expect(check.reason).toBe('SHA256_MISMATCH');

    await expect(
      ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'idem-tampered-r2',
        exchange: 'bitget',
        traderUid: '12349999',
        traderId: 'trader_bitget_1',
        reconciliationId: recon.id,
        evidenceId: uidEv.id,
        grossCommissionUnits: parseUsdToLedgerUnits('80.00'),
        r2,
      })
    ).rejects.toThrow(EvidenceIntegrityError);
  });

  it('replays identical idempotency key safely and throws 422 IdempotencyConflictError on payload mismatch', async () => {
    const uidEv = await storeEvidenceObject(db, r2, {
      exchange: 'bybit',
      sourceKind: 'rest_poll',
      rawBytes: JSON.stringify({ total: '200.00' }),
      statementPeriodStart: '2026-11-01T00:00:00.000Z',
      statementPeriodEnd: '2026-11-01T23:59:59.000Z',
    });
    const walletEv = await storeEvidenceObject(db, r2, {
      exchange: 'bybit',
      sourceKind: 'wallet_statement',
      rawBytes: JSON.stringify({ credit: '200.00' }),
      statementPeriodStart: '2026-11-01T00:00:00.000Z',
      statementPeriodEnd: '2026-11-01T23:59:59.000Z',
    });
    const recon = await reconcilePartnerCashBatch(db, {
      exchange: 'bybit',
      evidenceId: uidEv.id,
      walletEvidenceId: walletEv.id,
      uidAllocatedUnits: parseUsdToLedgerUnits('200.00'),
      walletCashCollectedUnits: parseUsdToLedgerUnits('200.00'),
      r2,
    });

    const first = await ledger.recordVerifiedCommissionInflight({
      idempotencyKey: 'idem-formance-key-001',
      exchange: 'bybit',
      traderUid: 'bybit_user_7788',
      traderId: 'trader_7788',
      l1AffiliateId: 'aff_kol_1',
      reconciliationId: recon.id,
      evidenceId: uidEv.id,
      grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
      r2,
    });
    expect(first.isReplay).toBe(false);

    // Exact replay returns identical batch idempotently without double-minting
    const replay = await ledger.recordVerifiedCommissionInflight({
      idempotencyKey: 'idem-formance-key-001',
      exchange: 'bybit',
      traderUid: 'bybit_user_7788',
      traderId: 'trader_7788',
      l1AffiliateId: 'aff_kol_1',
      reconciliationId: recon.id,
      evidenceId: uidEv.id,
      grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
      r2,
    });
    expect(replay.isReplay).toBe(true);
    expect(replay.batch.id).toBe(first.batch.id);

    const traderAcct = await ledger.getAccountByOwner('trader', 'trader_7788');
    expect(traderAcct?.inflightBalanceUnits).toBe(parseUsdToLedgerUnits('47.50'));

    // Payload mismatch with same idempotencyKey MUST throw 422 IdempotencyConflictError
    let caughtError: unknown;
    try {
      await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'idem-formance-key-001',
        exchange: 'bybit',
        traderUid: 'bybit_user_7788',
        traderId: 'trader_7788',
        l1AffiliateId: 'aff_kol_1',
        reconciliationId: recon.id,
        evidenceId: uidEv.id,
        grossCommissionUnits: parseUsdToLedgerUnits('50.00'),
        r2,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(IdempotencyConflictError);
    expect((caughtError as IdempotencyConflictError).statusCode).toBe(422);
  });

  it('serves PII-redacted Proof-of-Rebate via GET /api/b2b/proof-of-rebate without leaking raw UID or email and enforces caller auth', async () => {
    (globalThis as unknown as { DB?: unknown }).DB = db;
    (globalThis as unknown as { STORAGE?: unknown }).STORAGE = r2;
    process.env.B2B_PROOF_API_KEY = 'b2b-sandbox-test-key-999';

    const uidEv = await storeEvidenceObject(db, r2, {
      exchange: 'kucoin',
      sourceKind: 'rest_poll',
      rawBytes: JSON.stringify({ uid: 'vip.trader.secret9876@gmail.com', comm: '100.00' }),
      statementPeriodStart: '2026-11-01T00:00:00.000Z',
      statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    const walletEv = await storeEvidenceObject(db, r2, {
      exchange: 'kucoin',
      sourceKind: 'wallet_statement',
      rawBytes: JSON.stringify({ cashCollected: '100.00' }),
      statementPeriodStart: '2026-11-01T00:00:00.000Z',
      statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    const recon = await reconcilePartnerCashBatch(db, {
      exchange: 'kucoin',
      evidenceId: uidEv.id,
      walletEvidenceId: walletEv.id,
      uidAllocatedUnits: parseUsdToLedgerUnits('100.00'),
      walletCashCollectedUnits: parseUsdToLedgerUnits('100.00'),
      r2,
    });

    const recorded = await ledger.recordVerifiedCommissionInflight({
      idempotencyKey: 'idem-proof-b2b-1',
      exchange: 'kucoin',
      traderUid: 'vip.trader.secret9876@gmail.com',
      traderId: 'internal_profile_abc',
      l1AffiliateId: 'b2b_partner_desk',
      reconciliationId: recon.id,
      evidenceId: uidEv.id,
      grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
      createdAt: '2026-11-01T01:00:00.000Z',
      r2,
    });

    await ledger.releaseMaturedInflightBatch(
      recorded.batch.id,
      '2026-11-09T00:00:00.000Z'
    );
    const lock = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'idem-proof-wd-lock',
      ownerType: 'affiliate',
      ownerId: 'b2b_partner_desk',
      amountUnits: parseUsdToLedgerUnits('14.25'),
      payoutId: 'payout_001',
      nowIso: '2026-11-09T01:00:00.000Z',
    });
    await ledger.finalizeWithdrawal({
      idempotencyKey: 'idem-proof-wd-fin',
      lockBatchId: lock.batch.id,
      txHash: '0xabc123def456settledhash',
      nowIso: '2026-11-09T01:05:00.000Z',
    });

    // Unauthenticated request must be rejected with 401
    const unauthRes = await getProofOfRebateRoute(
      new NextRequest(`https://apex.exchange/api/b2b/proof-of-rebate?batchId=${recorded.batch.id}`)
    );
    expect(unauthRes.status).toBe(401);

    const reqByBatch = new NextRequest(
      `https://apex.exchange/api/b2b/proof-of-rebate?batchId=${recorded.batch.id}&verifyR2=true`,
      { headers: { 'x-b2b-api-key': 'b2b-sandbox-test-key-999' } }
    );
    const resByBatch = await getProofOfRebateRoute(reqByBatch);
    expect(resByBatch.status).toBe(200);
    const bodyByBatch = (await resByBatch.json()) as {
      success: boolean;
      proof: {
        batchId: string;
        maskedTraderUid: string;
        waterfallUnits: {
          clawbackReserveUnits: string;
          traderCashbackUnits: string;
          l1AffiliateCommissionUnits: string;
          platformNetUnits: string;
          doubleEntryBalanced: boolean;
        };
        evidence: { payloadSha256: string; r2IntegrityVerified: boolean };
        reconciliation: { status: string };
        settlement: { settledTxHash: string | null };
      };
    };

    expect(bodyByBatch.success).toBe(true);
    expect(bodyByBatch.proof.maskedTraderUid).toBe('***9876');
    expect(JSON.stringify(bodyByBatch)).not.toContain('gmail.com');
    expect(JSON.stringify(bodyByBatch)).not.toContain('secret9876');
    expect(JSON.stringify(bodyByBatch)).not.toContain('internal_profile_abc');
    expect(bodyByBatch.proof.waterfallUnits).toEqual({
      clawbackReserveUnits: '500000000',
      traderCashbackUnits: '4750000000',
      l1AffiliateCommissionUnits: '1425000000',
      b2bAgencyOverrideUnits: '0',
      platformNetUnits: '3325000000',
      doubleEntryBalanced: true,
    });
    expect(bodyByBatch.proof.evidence.payloadSha256).toBe(uidEv.payloadSha256);
    expect(bodyByBatch.proof.evidence.r2IntegrityVerified).toBe(true);
    expect(bodyByBatch.proof.reconciliation.status).toBe('MATCHED');
    expect(bodyByBatch.proof.settlement.settledTxHash).toBe('0xabc123def456settledhash');

    const reqByAffiliate = new NextRequest(
      'https://apex.exchange/api/b2b/proof-of-rebate?affiliateId=b2b_partner_desk&limit=10',
      { headers: { 'x-b2b-api-key': 'b2b-sandbox-test-key-999' } }
    );
    const resByAffiliate = await getProofOfRebateRoute(reqByAffiliate);
    expect(resByAffiliate.status).toBe(200);
    const bodyByAff = (await resByAffiliate.json()) as {
      success: boolean;
      count: number;
    };
    expect(bodyByAff.success).toBe(true);
    expect(bodyByAff.count).toBe(1);
    delete process.env.B2B_PROOF_API_KEY;
  });
});
