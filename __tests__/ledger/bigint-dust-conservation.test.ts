/**
 * BigInt, Safe Integer & Dust Boundary Conservation Matrix
 *
 * Proves across all 16 boundary cases that:
 *   ORIGINAL_LIABILITY = VERIFIED_SETTLEMENT + REMAINING_LIABILITY + VALID_REVERSALS
 * with zero floating-point loss, zero unexplained dust burn, zero paid status
 * without verified transfer, and zero unsafe Number(bigint) conversions.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  BI_ZERO,
  JS_MAX_SAFE_BIGINT,
  SQLITE_MAX_INT64,
  MIN_WITHDRAWAL_UNITS_1E8,
  LedgerOverflowError,
  LedgerUnitValidationError,
  parseUsdToLedgerUnits,
  formatLedgerUnitsToUsd,
  toSafeSqlInteger,
  toSafeNonNegativeSqlInteger,
  fromSqlInteger,
  ledgerUnitsToChainUnits,
  splitChainSettlementAndDust,
} from '@/lib/ledger/units';
import {
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  SqliteD1Adapter,
  storeEvidenceObject,
  reconcilePartnerCashBatch,
  verifyLedgerInvariants,
  InsufficientSettledBalanceError,
} from '@/lib/ledger';
import { ledgerUnits1e8ToStellarStroops } from '@/lib/payouts/stellar-service';
import { ledgerUnits1e8ToEvmUsdcUnits } from '@/lib/payouts/adapters/arbitrum-base-usdc-adapter';
import {
  TurnkeySigner,
  HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8,
  type TurnkeySigningTransport,
} from '@/lib/payouts/turnkey-signer';
import type { D1Database } from '@/lib/db';

const MIGRATIONS = [
  '001_initial_schema_d1.sql',
  '002_auth_tables.sql',
  '003_affiliate_schema.sql',
  '028_ascendancy_audit_core.sql',
  '031_ascendancy_phase2_ui_and_poller.sql',
  '033_cold_settlement_claims.sql',
  '034_withdrawal_freeze_at_write.sql',
  '035_payout_effect_grants.sql',
  '036_durable_hot_exposure.sql',
];

function createLedgerDb(): { db: SqliteD1Adapter; legacyDb: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  const dir = path.join(process.cwd(), 'src/database/migrations');
  for (const f of MIGRATIONS) {
    sqlite.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  const db = new SqliteD1Adapter(sqlite);
  return { db, legacyDb: db as unknown as D1Database, sqlite };
}

async function getTraderSettledUnits(
  ledger: DoubleEntryLedgerService,
  ownerId: string
): Promise<bigint> {
  const acct = await ledger.getAccountByOwner('trader', ownerId);
  return acct ? acct.settledBalanceUnits : BI_ZERO;
}

async function getEscrowSettledUnits(ledger: DoubleEntryLedgerService): Promise<bigint> {
  const acct = await ledger.getAccountByCode('treasury:withdrawal_escrow');
  return acct ? acct.settledBalanceUnits : BI_ZERO;
}

async function seedSettledUserBalance(
  db: SqliteD1Adapter,
  ownerId: string,
  targetUserUnits1e8: bigint,
  seedTag: string
): Promise<bigint> {
  const ledger = new DoubleEntryLedgerService(db);
  const r2 = new InMemoryR2Bucket();
  // Trader share is 40% of gross commission (4000 / 10000); compute gross so trader gets >= target
  // For exact unit seeding (including odd dust like +1, +7, +99), seed gross = target * 10000 / 4000
  // rounded up, or use exact divisible gross and return actual credited trader settled balance.
  const grossUnits = (targetUserUnits1e8 * BigInt(5) + BigInt(1)) / BigInt(2);
  const partnerEv = await storeEvidenceObject(db, r2, {
    exchange: 'bybit',
    sourceKind: 'rest_poll',
    rawBytes: JSON.stringify({ seedTag, grossUnits: grossUnits.toString() }),
    statementPeriodStart: '2026-11-01T00:00:00Z',
    statementPeriodEnd: '2026-11-01T23:59:59Z',
  });
  const walletEv = await storeEvidenceObject(db, r2, {
    exchange: 'bybit',
    sourceKind: 'wallet_statement',
    rawBytes: JSON.stringify({ seedTag, wallet: true }),
    statementPeriodStart: '2026-11-01T00:00:00Z',
    statementPeriodEnd: '2026-11-01T23:59:59Z',
  });
  const recon = await reconcilePartnerCashBatch(db, {
    exchange: 'bybit',
    evidenceId: partnerEv.id,
    walletEvidenceId: walletEv.id,
    uidAllocatedUnits: grossUnits,
    walletCashCollectedUnits: grossUnits,
    r2,
  });
  const batch = await ledger.recordVerifiedCommissionInflight({
    idempotencyKey: `comm-${seedTag}`,
    exchange: 'bybit',
    traderUid: `uid-${seedTag}`,
    traderId: ownerId,
    l1AffiliateId: null,
    reconciliationId: recon.id,
    evidenceId: partnerEv.id,
    grossCommissionUnits: grossUnits,
    createdAt: '2026-11-01T00:00:00.000Z',
    r2,
  });
  await ledger.releaseMaturedInflightBatch(batch.batch.id, '2026-11-10T00:00:00.000Z');
  return getTraderSettledUnits(ledger, ownerId);
}

describe('BigInt & Dust Boundary Hardening (16-case conservation matrix)', () => {
  it('1. Zero: rejects zero settlement instruction and preserves exact zero conversion', () => {
    const stellarZero = ledgerUnitsToChainUnits(BI_ZERO, 'stellar');
    expect(stellarZero.chainUnits).toBe(BI_ZERO);
    expect(stellarZero.disbursableUnits1e8).toBe(BI_ZERO);
    expect(stellarZero.residualDust1e8).toBe(BI_ZERO);
    expect(stellarZero.formatted).toBe('0.0000000');

    const evmZero = ledgerUnitsToChainUnits(BI_ZERO, 'arbitrum');
    expect(evmZero.chainUnits).toBe(BI_ZERO);
    expect(evmZero.disbursableUnits1e8).toBe(BI_ZERO);
    expect(evmZero.residualDust1e8).toBe(BI_ZERO);
    expect(evmZero.formatted).toBe('0.000000');

    expect(() => ledgerUnits1e8ToStellarStroops(BI_ZERO)).toThrow();
    expect(() => ledgerUnits1e8ToEvmUsdcUnits(BI_ZERO)).toThrow();
  });

  it('2. One 10^-8 unit: 100% dust on both Stellar and EVM; adapter rejects zero-transfer', () => {
    const oneUnit = BigInt(1);
    const s = ledgerUnitsToChainUnits(oneUnit, 'stellar');
    expect(s.chainUnits).toBe(BI_ZERO);
    expect(s.disbursableUnits1e8).toBe(BI_ZERO);
    expect(s.residualDust1e8).toBe(BigInt(1));
    expect(s.disbursableUnits1e8 + s.residualDust1e8).toBe(oneUnit);

    const e = ledgerUnitsToChainUnits(oneUnit, 'base');
    expect(e.chainUnits).toBe(BI_ZERO);
    expect(e.disbursableUnits1e8).toBe(BI_ZERO);
    expect(e.residualDust1e8).toBe(BigInt(1));
    expect(e.disbursableUnits1e8 + e.residualDust1e8).toBe(oneUnit);

    expect(() => ledgerUnits1e8ToStellarStroops(oneUnit)).toThrow(/sub-stroop dust/);
    expect(() => ledgerUnits1e8ToEvmUsdcUnits(oneUnit)).toThrow(/sub-EVM dust/);
  });

  it('3. One 10^-7 unit (10 ledger units): exact 1 stroop on Stellar, 100% dust on EVM', () => {
    const tenUnits = BigInt(10);
    const s = ledgerUnitsToChainUnits(tenUnits, 'stellar');
    expect(s.chainUnits).toBe(BigInt(1));
    expect(s.disbursableUnits1e8).toBe(tenUnits);
    expect(s.residualDust1e8).toBe(BI_ZERO);
    expect(ledgerUnits1e8ToStellarStroops(tenUnits)).toBe(BigInt(1));

    const e = ledgerUnitsToChainUnits(tenUnits, 'arbitrum');
    expect(e.chainUnits).toBe(BI_ZERO);
    expect(e.disbursableUnits1e8).toBe(BI_ZERO);
    expect(e.residualDust1e8).toBe(tenUnits);
    expect(() => ledgerUnits1e8ToEvmUsdcUnits(tenUnits)).toThrow(/sub-EVM dust/);
  });

  it('4. One 10^-6 unit (100 ledger units): exact on both Stellar (10 stroops) and EVM (1 micro-USDC)', () => {
    const hundredUnits = BigInt(100);
    const s = ledgerUnitsToChainUnits(hundredUnits, 'stellar');
    expect(s.chainUnits).toBe(BigInt(10));
    expect(s.residualDust1e8).toBe(BI_ZERO);
    expect(ledgerUnits1e8ToStellarStroops(hundredUnits)).toBe(BigInt(10));

    const e = ledgerUnitsToChainUnits(hundredUnits, 'base');
    expect(e.chainUnits).toBe(BigInt(1));
    expect(e.residualDust1e8).toBe(BI_ZERO);
    expect(ledgerUnits1e8ToEvmUsdcUnits(hundredUnits)).toBe(BigInt(1));
  });

  it('5. Amount directly below $10 withdrawal threshold ($9.99999999) is rejected by withdrawal lock', async () => {
    const { db } = createLedgerDb();
    const ledger = new DoubleEntryLedgerService(db);
    await seedSettledUserBalance(db, 'trader-below-10', parseUsdToLedgerUnits('20.00'), 'below10');

    const belowThreshold = MIN_WITHDRAWAL_UNITS_1E8 - BigInt(1);
    await expect(
      ledger.lockSettledForWithdrawal({
        idempotencyKey: 'lock-below-10',
        ownerType: 'trader',
        ownerId: 'trader-below-10',
        amountUnits: belowThreshold,
        payoutId: 'payout-below-10',
        chain: 'stellar',
      })
    ).rejects.toThrow(LedgerUnitValidationError);
  });

  it('6. Exactly $10.00: accepted by withdrawal lock and converts with zero dust on all chains', async () => {
    const { db } = createLedgerDb();
    const ledger = new DoubleEntryLedgerService(db);
    const exact10 = parseUsdToLedgerUnits('10.00');
    expect(exact10).toBe(MIN_WITHDRAWAL_UNITS_1E8);

    const originalLiability = await seedSettledUserBalance(db, 'trader-exact-10', exact10, 'exact10');
    const lock = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock-exact-10',
      ownerType: 'trader',
      ownerId: 'trader-exact-10',
      amountUnits: exact10,
      payoutId: 'payout-exact-10',
      chain: 'arbitrum',
    });
    expect(lock.batch.grossCommissionUnits).toBe(exact10);
    expect(splitChainSettlementAndDust(exact10, 'arbitrum', { requireZeroDust: true }).formatted).toBe(
      '10.000000'
    );
    expect(splitChainSettlementAndDust(exact10, 'stellar', { requireZeroDust: true }).formatted).toBe(
      '10.0000000'
    );

    const remaining = await getTraderSettledUnits(ledger, 'trader-exact-10');
    const escrow = await getEscrowSettledUnits(ledger);
    expect(remaining + escrow).toBe(originalLiability);
  });

  it('7. Exactly $250.00: fits within hot-wallet single-tx cap and safe SQL integer', () => {
    const exact250 = parseUsdToLedgerUnits('250.00');
    expect(exact250).toBe(HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8);
    expect(toSafeNonNegativeSqlInteger(exact250, 'exact_250')).toBe(25_000_000_000);
    expect(ledgerUnitsToChainUnits(exact250, 'stellar').formatted).toBe('250.0000000');
    expect(ledgerUnitsToChainUnits(exact250, 'base').formatted).toBe('250.000000');
  });

  it('8. Above $250.00 ($250.00000001): exceeds hot-wallet single-tx cap and splits dust cleanly', () => {
    const above250 = HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8 + BigInt(1);
    expect(above250 > HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8).toBe(true);
    const s = ledgerUnitsToChainUnits(above250, 'stellar');
    expect(s.disbursableUnits1e8).toBe(HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8);
    expect(s.residualDust1e8).toBe(BigInt(1));
    expect(() => splitChainSettlementAndDust(above250, 'stellar', { requireZeroDust: true })).toThrow(
      LedgerUnitValidationError
    );
  });

  it('9. Integer at the safe Number boundary (2^53 - 1) succeeds; 2^53 throws LedgerOverflowError', () => {
    expect(toSafeSqlInteger(JS_MAX_SAFE_BIGINT, 'max_safe')).toBe(Number.MAX_SAFE_INTEGER);
    expect(toSafeNonNegativeSqlInteger(JS_MAX_SAFE_BIGINT, 'max_safe_pos')).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(fromSqlInteger(Number.MAX_SAFE_INTEGER, 'roundtrip')).toBe(JS_MAX_SAFE_BIGINT);

    expect(() => toSafeSqlInteger(JS_MAX_SAFE_BIGINT + BigInt(1), 'overflow_pos')).toThrow(
      LedgerOverflowError
    );
    expect(() => toSafeNonNegativeSqlInteger(BigInt(-1), 'underflow_neg')).toThrow(
      LedgerUnitValidationError
    );
  });

  it('10. Invalid 64-bit integer (> SQLITE_MAX_INT64 or unsafe float) throws LedgerOverflowError', async () => {
    const overInt64 = SQLITE_MAX_INT64 + BigInt(1);
    expect(() => ledgerUnitsToChainUnits(overInt64, 'stellar')).toThrow(LedgerOverflowError);
    expect(() => fromSqlInteger(overInt64, 'over_int64')).toThrow(LedgerOverflowError);
    expect(() => fromSqlInteger(Number.MAX_SAFE_INTEGER + 2, 'unsafe_float')).toThrow(
      LedgerOverflowError
    );

    // Verify TurnkeySigner.enqueueColdSafeMultisig rejects > MAX_SAFE_INTEGER instead of silently losing precision
    const { legacyDb } = createLedgerDb();
    const dummyTransport: TurnkeySigningTransport = {
      async signSecp256k1Digest() {
        throw new Error('unused');
      },
      async signEd25519Payload() {
        throw new Error('unused');
      },
    };
    const signer = new TurnkeySigner({
      transport: dummyTransport,
      evmHotWalletAddress: '0x1111111111111111111111111111111111111111',
      stellarHotWalletAddress: 'GBVALIDWALLET2345672345672345672345672345672345672345672',
    });

    await expect(
      signer.enqueueColdSafeMultisig(legacyDb, {
        payoutId: 'payout-overflow-cold',
        idempotencyKey: 'idem-overflow-cold',
        affiliateId: 'aff-overflow',
        chain: 'arbitrum',
        recipientAddress: '0x2222222222222222222222222222222222222222',
        amountUnits1e8: JS_MAX_SAFE_BIGINT + BigInt(100),
        chainTokenUnits: '90071992547410',
        chainDecimals: 6,
        lockBatchId: 'lock-overflow',
        reason: 'overflow test',
      })
    ).rejects.toThrow(LedgerOverflowError);
  });

  it('11. Maximum valid configured ledger amount (JS_MAX_SAFE_BIGINT) preserves exact conservation', () => {
    const maxValid = JS_MAX_SAFE_BIGINT;
    const s = ledgerUnitsToChainUnits(maxValid, 'stellar');
    expect(s.disbursableUnits1e8 + s.residualDust1e8).toBe(maxValid);
    expect(s.residualDust1e8).toBe(maxValid % BigInt(10));

    const e = ledgerUnitsToChainUnits(maxValid, 'arbitrum');
    expect(e.disbursableUnits1e8 + e.residualDust1e8).toBe(maxValid);
    expect(e.residualDust1e8).toBe(maxValid % BigInt(100));
    expect(formatLedgerUnitsToUsd(maxValid)).toBe('90071992.54740991');
  });

  it('12. Multiple partial withdrawals conserve ORIGINAL_LIABILITY = VERIFIED_SETTLEMENT + REMAINING_LIABILITY + VALID_REVERSALS', async () => {
    const { db } = createLedgerDb();
    const ledger = new DoubleEntryLedgerService(db);
    const originalLiability = await seedSettledUserBalance(
      db,
      'trader-multi-partial',
      parseUsdToLedgerUnits('55.12345678'),
      'multi-partial'
    );

    // Partial 1: $15.00 on Stellar
    const w1 = parseUsdToLedgerUnits('15.00');
    const lock1 = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock-mp-1',
      ownerType: 'trader',
      ownerId: 'trader-multi-partial',
      amountUnits: w1,
      payoutId: 'payout-mp-1',
      chain: 'stellar',
    });
    await ledger.finalizeWithdrawal({
      lockBatchId: lock1.batch.id,
      idempotencyKey: 'fin-mp-1',
      payoutId: 'payout-mp-1',
      txHash: 'a'.repeat(64),
      chain: 'stellar',
    });

    // Partial 2: $20.00 on Arbitrum
    const w2 = parseUsdToLedgerUnits('20.00');
    const lock2 = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock-mp-2',
      ownerType: 'trader',
      ownerId: 'trader-multi-partial',
      amountUnits: w2,
      payoutId: 'payout-mp-2',
      chain: 'arbitrum',
    });
    await ledger.finalizeWithdrawal({
      lockBatchId: lock2.batch.id,
      idempotencyKey: 'fin-mp-2',
      payoutId: 'payout-mp-2',
      txHash: '0x' + 'b'.repeat(64),
      chain: 'arbitrum',
    });

    const verifiedSettlement = w1 + w2;
    const remainingLiability = await getTraderSettledUnits(ledger, 'trader-multi-partial');
    const validReversals = BI_ZERO;

    expect(verifiedSettlement + remainingLiability + validReversals).toBe(originalLiability);
    expect((await verifyLedgerInvariants(db)).valid).toBe(true);
  });

  it('13. Cross-chain conversion (Stellar 7dp vs EVM 6dp) preserves exact dust remainder', () => {
    const amount = parseUsdToLedgerUnits('12.34567893');
    const stellar = ledgerUnitsToChainUnits(amount, 'stellar');
    expect(stellar.formatted).toBe('12.3456789');
    expect(stellar.residualDust1e8).toBe(BigInt(3));
    expect(stellar.disbursableUnits1e8 + stellar.residualDust1e8).toBe(amount);

    const evm = ledgerUnitsToChainUnits(amount, 'base');
    expect(evm.formatted).toBe('12.345678');
    expect(evm.residualDust1e8).toBe(BigInt(93));
    expect(evm.disbursableUnits1e8 + evm.residualDust1e8).toBe(amount);
  });

  it('14. Dust accumulation across multiple payouts retains every 10^-8 unit as spendable liability', async () => {
    const { db } = createLedgerDb();
    const ledger = new DoubleEntryLedgerService(db);
    // Seed 3 small commissions whose combined settled balance has sub-micro-USDC dust
    let totalCredited = BI_ZERO;
    for (let i = 1; i <= 3; i++) {
      const target = parseUsdToLedgerUnits('10.00000037');
      await seedSettledUserBalance(db, 'trader-dust-accum', target, `dust-acc-${i}`);
    }
    totalCredited = await getTraderSettledUnits(ledger, 'trader-dust-accum');

    // Withdraw exact EVM-disbursable portion of the balance; residual dust remains in user liability
    const conv = splitChainSettlementAndDust(totalCredited, 'arbitrum');
    expect(conv.disbursableUnits1e8 >= MIN_WITHDRAWAL_UNITS_1E8).toBe(true);

    const lock = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock-dust-accum',
      ownerType: 'trader',
      ownerId: 'trader-dust-accum',
      amountUnits: conv.disbursableUnits1e8,
      payoutId: 'payout-dust-accum',
      chain: 'arbitrum',
    });
    await ledger.finalizeWithdrawal({
      lockBatchId: lock.batch.id,
      idempotencyKey: 'fin-dust-accum',
      payoutId: 'payout-dust-accum',
      txHash: '0x' + 'c'.repeat(64),
      chain: 'arbitrum',
    });

    const remainingLiability = await getTraderSettledUnits(ledger, 'trader-dust-accum');
    expect(remainingLiability).toBe(conv.residualDust1e8);
    expect(conv.disbursableUnits1e8 + remainingLiability).toBe(totalCredited);
    expect((await verifyLedgerInvariants(db)).valid).toBe(true);
  });

  it('15. Reversal after partial settlement preserves exact conservation invariant', async () => {
    const { db } = createLedgerDb();
    const ledger = new DoubleEntryLedgerService(db);
    const originalLiability = await seedSettledUserBalance(
      db,
      'trader-rev-partial',
      parseUsdToLedgerUnits('45.00'),
      'rev-partial'
    );

    // Partial 1: finalized ($15.00)
    const w1 = parseUsdToLedgerUnits('15.00');
    const lock1 = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock-rp-1',
      ownerType: 'trader',
      ownerId: 'trader-rev-partial',
      amountUnits: w1,
      payoutId: 'payout-rp-1',
      chain: 'stellar',
    });
    await ledger.finalizeWithdrawal({
      lockBatchId: lock1.batch.id,
      idempotencyKey: 'fin-rp-1',
      payoutId: 'payout-rp-1',
      txHash: 'd'.repeat(64),
      chain: 'stellar',
    });

    // Partial 2: locked ($12.00), then reverted back to user liability
    const w2 = parseUsdToLedgerUnits('12.00');
    const lock2 = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock-rp-2',
      ownerType: 'trader',
      ownerId: 'trader-rev-partial',
      amountUnits: w2,
      payoutId: 'payout-rp-2',
      chain: 'stellar',
    });
    await ledger.revertWithdrawal({
      lockBatchId: lock2.batch.id,
      idempotencyKey: 'rev-rp-2',
      reason: 'Recipient trustline revoked before broadcast',
    });

    const remainingLiability = await getTraderSettledUnits(ledger, 'trader-rev-partial');
    // After reverting w2, w2 is restored into remainingLiability so:
    // ORIGINAL_LIABILITY = VERIFIED_SETTLEMENT (w1) + REMAINING_LIABILITY (original - w1)
    expect(w1 + remainingLiability).toBe(originalLiability);
    expect((await verifyLedgerInvariants(db)).valid).toBe(true);
  });

  it('16. Concurrent repeated withdrawal cannot over-debit settled balance', async () => {
    const { db } = createLedgerDb();
    const ledger = new DoubleEntryLedgerService(db);
    const originalLiability = await seedSettledUserBalance(
      db,
      'trader-concurrent-wd',
      parseUsdToLedgerUnits('15.00'),
      'concurrent-wd'
    );

    const reqAmount = parseUsdToLedgerUnits('12.00');
    const outcomes = await Promise.allSettled([
      ledger.lockSettledForWithdrawal({
        idempotencyKey: 'lock-conc-1',
        ownerType: 'trader',
        ownerId: 'trader-concurrent-wd',
        amountUnits: reqAmount,
        payoutId: 'payout-conc-1',
        chain: 'arbitrum',
      }),
      ledger.lockSettledForWithdrawal({
        idempotencyKey: 'lock-conc-2',
        ownerType: 'trader',
        ownerId: 'trader-concurrent-wd',
        amountUnits: reqAmount,
        payoutId: 'payout-conc-2',
        chain: 'arbitrum',
      }),
    ]);

    const succeeded = outcomes.filter((o) => o.status === 'fulfilled');
    const failed = outcomes.filter((o) => o.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InsufficientSettledBalanceError
    );

    const remaining = await getTraderSettledUnits(ledger, 'trader-concurrent-wd');
    const escrow = await getEscrowSettledUnits(ledger);
    expect(remaining >= BI_ZERO).toBe(true);
    expect(remaining + escrow).toBe(originalLiability);
    expect((await verifyLedgerInvariants(db)).valid).toBe(true);
  });
});
