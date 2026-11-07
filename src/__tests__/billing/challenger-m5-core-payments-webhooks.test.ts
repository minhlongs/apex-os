/**
 * Empirical Challenger M5 Adversarial Test Suite
 * Target Files:
 * - src/app/api/payments/route.ts
 * - src/app/api/payments/history/route.ts
 * - src/app/api/webhooks/ipn/route.ts
 * - src/lib/auth/session-helper.ts
 *
 * Authored by: teamwork_preview_challenger_m5_1
 * Role: EMPIRICAL CHALLENGER
 *
 * Scope:
 * 1. Cryptographic Edge Cases & Canonical Key Sorting Oracles
 * 2. High-Concurrency Burst Storms & Replay Deadlock Resistance
 * 3. Database Outage & Fail-Closed Robustness
 * 4. SQL Injection Parameterization Defense
 * 5. Universal Auth Session Helper Boundaries
 * 6. Payment Upstream Fault Injection & Prototype Pollution Defense
 */

import * as crypto from 'crypto';
import { NextRequest } from 'next/server';
import {
  mockBillingDB,
  setupBillingTestEnvironment,
  createTestRequest,
  dispatchRoute,
  generateIpnSignature,
  configureMockNowPayments,
  resetMockNowPayments,
  DEFAULT_USER,
  SECOND_USER,
  sortObjectKeys,
} from './billing-test-harness';
import {
  extractBearerToken,
  parseCookies,
  extractCookieToken,
  validateSessionInD1,
  getAuthenticatedUser,
} from '@/lib/auth/session-helper';
import { D1Database } from '@/lib/db';

const IPN_SECRET = 'apexos-m5-ipn-secret-stress-key-2026';
const PAYMENTS_ROUTE = 'src/app/api/payments/route.ts';
const HISTORY_ROUTE = 'src/app/api/payments/history/route.ts';
const IPN_ROUTE = 'src/app/api/webhooks/ipn/route.ts';

function verifyIpnSignature(
  rawBody: string,
  sigHeader: string | null | undefined,
  secret: string
): { valid: boolean; error?: string } {
  if (!sigHeader) {
    return { valid: false, error: 'Missing signature header' };
  }
  const cleanedSig = sigHeader.trim().toLowerCase();
  if (!cleanedSig) {
    return { valid: false, error: 'Empty signature header' };
  }
  if (!/^[0-9a-f]{128}$/.test(cleanedSig)) {
    return { valid: false, error: 'Invalid signature format' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { valid: false, error: 'Malformed JSON body' };
  }
  const canonicalSorted = sortObjectKeys(parsed);
  const canonicalString = JSON.stringify(canonicalSorted);
  const expectedHex = crypto
    .createHmac('sha512', secret)
    .update(canonicalString)
    .digest('hex')
    .toLowerCase();
  const bufIncoming = Buffer.from(cleanedSig);
  const bufExpected = Buffer.from(expectedHex);
  if (bufIncoming.length !== bufExpected.length) {
    return { valid: false, error: 'Signature length mismatch' };
  }
  const isEqual = crypto.timingSafeEqual(bufIncoming, bufExpected);
  return isEqual ? { valid: true } : { valid: false, error: 'Signature mismatch' };
}

function seedPayment(opts: {
  payment_id: string;
  status: 'pending' | 'confirming' | 'confirmed' | 'failed' | 'expired' | 'refunded';
  plan: string;
  user_id: string;
  amount?: number;
}) {
  mockBillingDB.payments.set(opts.payment_id, {
    id: `pay-row-${opts.payment_id}`,
    payment_id: opts.payment_id,
    status: opts.status,
    plan: opts.plan,
    user_id: opts.user_id,
    amount: opts.amount ?? 99,
    currency: 'USDT',
    txn_id: null,
    confirmed_at: opts.status === 'confirmed' ? new Date().toISOString() : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

beforeAll(() => {
  setupBillingTestEnvironment();
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
  process.env.NOWPAYMENTS_API_KEY = 'test-m5-challenger-key';
});

beforeEach(() => {
  mockBillingDB.reset();
  resetMockNowPayments();
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
  process.env.NOWPAYMENTS_API_KEY = 'test-m5-challenger-key';
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Tier 5 Adversarial Coverage Hardening: Core Payments & Webhooks', () => {

  // =========================================================================
  // Section 1: Cryptographic Edge Cases & Canonical Key Sorting Oracles
  // =========================================================================
  describe('1. Cryptographic Edge Cases & Canonical Key Sorting Oracles', () => {
    it('CRYPTO-01: Key permutation oracle - produces identical HMAC regardless of key insertion order across deep nested objects', () => {
      const baseObj = {
        payment_id: 'crypto-perm-01',
        payment_status: 'confirmed',
        price_amount: 99,
        price_currency: 'usd',
        pay_amount: 99,
        pay_currency: 'usdt',
        order_id: 'order-perm-123',
        plan: 'ENTERPRISE',
        meta: {
          zeta: 'last',
          alpha: 'first',
          nested: {
            delta: 4,
            beta: 2,
            gamma: 3,
            alpha: 1,
          },
        },
      };

      const permutedObj = {
        plan: 'ENTERPRISE',
        order_id: 'order-perm-123',
        meta: {
          nested: {
            gamma: 3,
            alpha: 1,
            delta: 4,
            beta: 2,
          },
          alpha: 'first',
          zeta: 'last',
        },
        pay_currency: 'usdt',
        pay_amount: 99,
        price_currency: 'usd',
        payment_status: 'confirmed',
        price_amount: 99,
        payment_id: 'crypto-perm-01',
      };

      const sortedBase = sortObjectKeys(baseObj);
      const sortedPermuted = sortObjectKeys(permutedObj);

      const strBase = JSON.stringify(sortedBase);
      const strPermuted = JSON.stringify(sortedPermuted);

      expect(strBase).toEqual(strPermuted);

      const sigBase = crypto.createHmac('sha512', IPN_SECRET).update(strBase).digest('hex').toLowerCase();
      const sigPermuted = crypto.createHmac('sha512', IPN_SECRET).update(strPermuted).digest('hex').toLowerCase();

      expect(sigBase).toEqual(sigPermuted);

      const verify1 = verifyIpnSignature(JSON.stringify(baseObj), sigBase, IPN_SECRET);
      const verify2 = verifyIpnSignature(JSON.stringify(permutedObj), sigPermuted, IPN_SECRET);

      expect(verify1.valid).toBe(true);
      expect(verify2.valid).toBe(true);
    });

    it('CRYPTO-02: Case sensitivity oracle - accepts lowercase, uppercase, and mixed-case hex signatures', () => {
      const payload = { payment_id: 'crypto-case-01', payment_status: 'confirmed' };
      const rawBody = JSON.stringify(payload);
      const validSig = generateIpnSignature(payload, IPN_SECRET);

      const lowerSig = validSig.toLowerCase();
      const upperSig = validSig.toUpperCase();
      const mixedSig = validSig
        .split('')
        .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
        .join('');

      expect(verifyIpnSignature(rawBody, lowerSig, IPN_SECRET).valid).toBe(true);
      expect(verifyIpnSignature(rawBody, upperSig, IPN_SECRET).valid).toBe(true);
      expect(verifyIpnSignature(rawBody, mixedSig, IPN_SECRET).valid).toBe(true);
    });

    it('CRYPTO-03: Length boundary oracle - rejects truncated (127 char) and extended (129 char) signatures with 401', async () => {
      const payload = { payment_id: 'crypto-len-01', payment_status: 'confirmed' };
      const validSig = generateIpnSignature(payload, IPN_SECRET);

      const truncatedSig = validSig.slice(0, 127);
      const extendedSig = validSig + 'a';

      const reqTrunc = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': truncatedSig },
      });
      const resTrunc = await dispatchRoute(IPN_ROUTE, 'POST', reqTrunc);
      expect(resTrunc.status).toBe(401);
      expect(resTrunc.data.error).toBe('Invalid signature');

      const reqExt = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': extendedSig },
      });
      const resExt = await dispatchRoute(IPN_ROUTE, 'POST', reqExt);
      expect(resExt.status).toBe(401);
      expect(resExt.data.error).toBe('Invalid signature');
    });

    it('CRYPTO-04: Non-hex character oracle - rejects signature containing non-hex characters (g-z, symbols)', async () => {
      const payload = { payment_id: 'crypto-nonhex-01', payment_status: 'confirmed' };
      const validSig = generateIpnSignature(payload, IPN_SECRET);

      const corruptedSig = validSig.slice(0, 60) + 'z' + validSig.slice(61);

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': corruptedSig },
      });
      const res = await dispatchRoute(IPN_ROUTE, 'POST', req);
      expect(res.status).toBe(401);
      expect(res.data.error).toBe('Invalid signature');
    });

    it('CRYPTO-05: Constant-time comparison resilience - handles mismatched lengths without throwing unhandled exceptions', () => {
      const payload = JSON.stringify({ payment_id: 'crypto-timing-01' });
      expect(verifyIpnSignature(payload, '', IPN_SECRET).valid).toBe(false);
      expect(verifyIpnSignature(payload, 'short', IPN_SECRET).valid).toBe(false);
      expect(verifyIpnSignature(payload, null, IPN_SECRET).valid).toBe(false);
      expect(verifyIpnSignature(payload, undefined, IPN_SECRET).valid).toBe(false);
    });

    it('CRYPTO-06: Malformed JSON body in signed IPN callback returns 401 on invalid JSON parse during sig check', async () => {
      const malformedBody = '{"payment_id": "test", bad_json...';
      const validSig = 'a'.repeat(128);

      const req = new NextRequest('http://localhost/api/webhooks/ipn', {
        method: 'POST',
        body: malformedBody,
        headers: {
          'Content-Type': 'application/json',
          'x-nowpayments-sig': validSig,
        },
      });

      const res = await dispatchRoute(IPN_ROUTE, 'POST', req);
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Section 2: High-Concurrency Burst Storms & Replay Deadlock Resistance
  // =========================================================================
  describe('2. High-Concurrency Burst Storms & Replay Deadlock Resistance', () => {
    it('STORM-01: 20x concurrent burst storm for single payment ID executes exactly 1 update, 19 dedupes, and 1 audit log', async () => {
      const paymentId = 'burst-storm-20x';
      seedPayment({
        payment_id: paymentId,
        status: 'pending',
        plan: 'ENTERPRISE',
        user_id: DEFAULT_USER.id,
        amount: 99,
      });

      const payload = {
        payment_id: paymentId,
        payment_status: 'confirmed',
        price_amount: 99,
        plan: 'ENTERPRISE',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);

      const requests = Array.from({ length: 20 }, () => {
        const req = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': sig },
        });
        return dispatchRoute(IPN_ROUTE, 'POST', req);
      });

      const responses = await Promise.all(requests);

      responses.forEach((res) => {
        expect(res.status).toBe(200);
      });

      const processedCount = responses.filter((r) => r.data.processed === true).length;
      const dedupedCount = responses.filter((r) => r.data.deduped === true).length;

      expect(processedCount).toBe(1);
      expect(dedupedCount).toBe(19);

      const payment = mockBillingDB.payments.get(paymentId);
      expect(payment?.status).toBe('confirmed');

      const profile = mockBillingDB.profiles.get(DEFAULT_USER.id);
      expect(profile?.tier).toBe('ENTERPRISE');

      const auditLogs = mockBillingDB.tierActivations.filter(
        (a) => a.payment_id === paymentId
      );
      expect(auditLogs.length).toBe(1);

      const receipts = mockBillingDB.emailQueue.filter(
        (e) => e.user_id === DEFAULT_USER.id && e.metadata?.includes(paymentId)
      );
      expect(receipts.length).toBe(1);
    });

    it('STORM-02: Interleaved concurrent bursts for Payment A and Payment B do not deadlock or cross-contaminate', async () => {
      const payA = 'storm-pay-a';
      const payB = 'storm-pay-b';

      seedPayment({
        payment_id: payA,
        status: 'pending',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
      });

      seedPayment({
        payment_id: payB,
        status: 'pending',
        plan: 'MASTER',
        user_id: SECOND_USER.id,
        amount: 299,
      });

      const payloadA = { payment_id: payA, payment_status: 'confirmed', plan: 'PREMIUM' };
      const sigA = generateIpnSignature(payloadA, IPN_SECRET);

      const payloadB = { payment_id: payB, payment_status: 'confirmed', plan: 'MASTER' };
      const sigB = generateIpnSignature(payloadB, IPN_SECRET);

      const mixedRequests = Array.from({ length: 20 }, (_, idx) => {
        const isA = idx % 2 === 0;
        const payload = isA ? payloadA : payloadB;
        const sig = isA ? sigA : sigB;
        const req = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': sig },
        });
        return dispatchRoute(IPN_ROUTE, 'POST', req);
      });

      const responses = await Promise.all(mixedRequests);

      responses.forEach((res) => {
        expect(res.status).toBe(200);
      });

      expect(mockBillingDB.payments.get(payA)?.status).toBe('confirmed');
      expect(mockBillingDB.payments.get(payB)?.status).toBe('confirmed');

      expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('PREMIUM');
      expect(mockBillingDB.profiles.get(SECOND_USER.id)?.tier).toBe('MASTER');

      expect(mockBillingDB.tierActivations.filter((a) => a.payment_id === payA).length).toBe(1);
      expect(mockBillingDB.tierActivations.filter((a) => a.payment_id === payB).length).toBe(1);
    });

    it('STORM-03: Terminal state monotonicity - confirmed payment ignores out-of-order non-terminal callbacks', async () => {
      const paymentId = 'storm-mono-01';
      seedPayment({
        payment_id: paymentId,
        status: 'pending',
        plan: 'ENTERPRISE',
        user_id: DEFAULT_USER.id,
        amount: 99,
      });

      // 1. First callback confirms payment
      const confirmedPayload = { payment_id: paymentId, payment_status: 'confirmed', plan: 'ENTERPRISE' };
      const sigConf = generateIpnSignature(confirmedPayload, IPN_SECRET);
      const reqConf = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: confirmedPayload,
        headers: { 'x-nowpayments-sig': sigConf },
      });
      const resConf = await dispatchRoute(IPN_ROUTE, 'POST', reqConf);
      expect(resConf.status).toBe(200);
      expect(resConf.data.processed).toBe(true);

      // 2. Out-of-order 'waiting' callback arrives
      const waitingPayload = { payment_id: paymentId, payment_status: 'waiting', plan: 'ENTERPRISE' };
      const sigWait = generateIpnSignature(waitingPayload, IPN_SECRET);
      const reqWait = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: waitingPayload,
        headers: { 'x-nowpayments-sig': sigWait },
      });
      const resWait = await dispatchRoute(IPN_ROUTE, 'POST', reqWait);
      expect(resWait.status).toBe(200);
      expect(resWait.data.deduped).toBe(true);

      expect(mockBillingDB.payments.get(paymentId)?.status).toBe('confirmed');
      expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('ENTERPRISE');

      // 3. Out-of-order 'failed' callback arrives
      const failedPayload = { payment_id: paymentId, payment_status: 'failed', plan: 'ENTERPRISE' };
      const sigFail = generateIpnSignature(failedPayload, IPN_SECRET);
      const reqFail = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: failedPayload,
        headers: { 'x-nowpayments-sig': sigFail },
      });
      const resFail = await dispatchRoute(IPN_ROUTE, 'POST', reqFail);
      expect(resFail.status).toBe(200);
      expect(resFail.data.deduped).toBe(true);

      expect(mockBillingDB.payments.get(paymentId)?.status).toBe('confirmed');
      expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('ENTERPRISE');
    });
  });

  // =========================================================================
  // Section 3: Database Outage & Fail-Closed Robustness
  // =========================================================================
  describe('3. Database Outage & Fail-Closed Robustness', () => {
    it('DB-FAIL-01: Payment creation fails closed with 500 when database run() throws', async () => {
      const originalPrepare = mockBillingDB.prepare.bind(mockBillingDB);
      jest.spyOn(mockBillingDB, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO payments')) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error('D1 storage engine read-only or unreachable');
              },
            }),
          } as any;
        }
        return originalPrepare(sql);
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'BASIC' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute(PAYMENTS_ROUTE, 'POST', req);
      expect(res.status).toBe(500);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toBe('Failed to record payment');
    });

    it('DB-FAIL-02: Payment history returns 500 cleanly when database query throws', async () => {
      const originalPrepare = mockBillingDB.prepare.bind(mockBillingDB);
      jest.spyOn(mockBillingDB, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('FROM payments')) {
          return {
            bind: () => ({
              first: async () => {
                throw new Error('D1 query timeout');
              },
              all: async () => {
                throw new Error('D1 query timeout');
              },
            }),
          } as any;
        }
        return originalPrepare(sql);
      });

      const req = createTestRequest('/api/payments/history', {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute(HISTORY_ROUTE, 'GET', req);
      expect(res.status).toBe(500);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/D1 query timeout/i);
    });

    it('DB-FAIL-03: IPN webhook bubbles error or rejects when atomic batch execution fails', async () => {
      seedPayment({
        payment_id: 'db-fail-ipn',
        status: 'pending',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
      });

      jest.spyOn(mockBillingDB, 'batch').mockImplementation(async () => {
        throw new Error('D1 batch commit transaction rollback');
      });

      const payload = { payment_id: 'db-fail-ipn', payment_status: 'confirmed', plan: 'PREMIUM' };
      const sig = generateIpnSignature(payload, IPN_SECRET);

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(IPN_ROUTE, 'POST', req);
      expect(res.status).toBe(500);
      expect(res.error).toMatch(/D1 batch commit transaction rollback/i);

      expect(mockBillingDB.payments.get('db-fail-ipn')?.status).toBe('pending');
    });
  });

  // =========================================================================
  // Section 4: SQL Injection Parameterization Defense
  // =========================================================================
  describe('4. SQL Injection Parameterization Defense', () => {
    it('SQLI-01: Payment history status parameter containing SQL injection is neutralized by prepared statement', async () => {
      seedPayment({
        payment_id: 'sqli-pay-01',
        status: 'confirmed',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
      });

      const injectionPayload = "confirmed' OR '1'='1' --";
      const req = createTestRequest(`/api/payments/history?status=${encodeURIComponent(injectionPayload)}`, {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute(HISTORY_ROUTE, 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.payments.length).toBe(0);
      expect(res.data.pagination.total).toBe(0);
    });

    it('SQLI-02: Payment history page and limit SQL injection strings are safely parsed and normalized', async () => {
      seedPayment({
        payment_id: 'sqli-pay-02',
        status: 'pending',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
      });

      const req = createTestRequest(
        `/api/payments/history?page=1%20UNION%20SELECT%201&limit=10%3B%20DROP%20TABLE%20payments`,
        {
          method: 'GET',
          user: DEFAULT_USER,
        }
      );

      const res = await dispatchRoute(HISTORY_ROUTE, 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.pagination.page).toBe(1);
      expect(res.data.pagination.limit).toBe(10);
    });

    it('SQLI-03: IPN payment_id with SQL injection is bound as literal parameter and does not alter query logic', async () => {
      const maliciousPaymentId = "pay-01' OR '1'='1";
      const payload = { payment_id: maliciousPaymentId, payment_status: 'confirmed', plan: 'BASIC' };
      const sig = generateIpnSignature(payload, IPN_SECRET);

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(IPN_ROUTE, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.skipped).toBe(true);
      expect(res.data.reason).toBe('payment_not_found');
    });
  });

  // =========================================================================
  // Section 5: Universal Auth Session Helper Boundaries
  // =========================================================================
  describe('5. Universal Auth Session Helper Boundaries', () => {
    it('AUTH-01: extractBearerToken handles variations in whitespace and case', () => {
      const h1 = new Headers({ authorization: 'Bearer token-abc-123' });
      expect(extractBearerToken(h1)).toBe('token-abc-123');

      const h2 = new Headers({ Authorization: 'bearer token-lower-case' });
      expect(extractBearerToken(h2)).toBe('token-lower-case');

      const h3 = new Headers({ Authorization: 'Bearer    multi-space-token' });
      expect(extractBearerToken(h3)).toBe('multi-space-token');

      const h4 = new Headers({ Authorization: 'Basic dXNlcjpwYXNz' });
      expect(extractBearerToken(h4)).toBeNull();

      const h5 = new Headers({});
      expect(extractBearerToken(h5)).toBeNull();
    });

    it('AUTH-02: parseCookies and extractCookieToken handle complex, malformed, and signed cookie formats', () => {
      const c1 = new Headers({ cookie: 'session_token=valid-tok-1; foo=bar' });
      expect(extractCookieToken(c1)).toBe('valid-tok-1');

      const c2 = new Headers({
        cookie: 'better-auth.session_token=signed-tok-part.sha256sigvalue12345; path=/',
      });
      expect(extractCookieToken(c2)).toBe('signed-tok-part');

      const c3 = ';;;foo=bar;invalidcookie;session_token=fallback-tok;;;';
      const parsed = parseCookies(c3);
      expect(parsed['foo']).toBe('bar');
      expect(parsed['session_token']).toBe('fallback-tok');
    });

    it('AUTH-03: Session expiration boundary - handles seconds, ms, and ISO string representations', async () => {
      const makeMockDb = (row: { user_id: string; expires_at: string | number; email: string | null } | null) =>
        ({
          prepare: () => ({
            bind: () => ({
              first: async () => row,
            }),
          }),
        } as unknown as D1Database);

      // 1. Valid session with future Unix timestamp in seconds
      const db1 = makeMockDb({
        user_id: 'usr-sess-1',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        email: 'u1@apex.os',
      });
      const validSec = await validateSessionInD1(db1, 'tok-1');
      expect(validSec?.id).toBe('usr-sess-1');

      // 2. Expired session in seconds
      const db2 = makeMockDb({
        user_id: 'usr-sess-2',
        expires_at: Math.floor(Date.now() / 1000) - 60,
        email: 'u2@apex.os',
      });
      const expiredSec = await validateSessionInD1(db2, 'tok-2');
      expect(expiredSec).toBeNull();

      // 3. Valid session with ISO date string
      const db3 = makeMockDb({
        user_id: 'usr-sess-3',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        email: 'u3@apex.os',
      });
      const validIso = await validateSessionInD1(db3, 'tok-3');
      expect(validIso?.id).toBe('usr-sess-3');

      // 4. Invalid date format string
      const db4 = makeMockDb({
        user_id: 'usr-sess-4',
        expires_at: 'not-a-date',
        email: 'u4@apex.os',
      });
      const corruptDate = await validateSessionInD1(db4, 'tok-4');
      expect(corruptDate).toBeNull();
    });

    it('AUTH-04: getAuthenticatedUser fast exit when no authorization or cookie headers exist', async () => {
      const emptyReq = new Request('http://localhost/api/payments');
      const user = await getAuthenticatedUser(emptyReq, mockBillingDB as any);
      expect(user).toBeNull();
    });
  });

  // =========================================================================
  // Section 6: Payment Upstream Fault Injection & Prototype Pollution Defense
  // =========================================================================
  describe('6. Payment Upstream Fault Injection & Prototype Pollution Defense', () => {
    it('FAULT-01: Upstream NOWPayments returns HTTP 504 Gateway Timeout mapped to 502 Bad Gateway', async () => {
      configureMockNowPayments({
        status: 504,
        response: { message: 'Upstream gateway timed out contacting payment ledger' },
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'MASTER' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute(PAYMENTS_ROUTE, 'POST', req);
      expect(res.status).toBe(502);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/gateway timed out/i);
    });

    it('FAULT-02: Upstream NOWPayments returns string literal "undefined" for payment_id or payment_url rejected with 502', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          payment_id: 'undefined',
          payment_url: 'https://checkout.nowpayments.io/pay/valid',
        },
      });

      const req1 = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'PREMIUM' },
        user: DEFAULT_USER,
      });
      const res1 = await dispatchRoute(PAYMENTS_ROUTE, 'POST', req1);
      expect(res1.status).toBe(502);
      expect(res1.data.error).toBe('Invalid response from payment provider');

      configureMockNowPayments({
        status: 200,
        response: {
          payment_id: 'np-valid-123',
          payment_url: 'undefined',
        },
      });

      const req2 = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'PREMIUM' },
        user: DEFAULT_USER,
      });
      const res2 = await dispatchRoute(PAYMENTS_ROUTE, 'POST', req2);
      expect(res2.status).toBe(502);
      expect(res2.data.error).toBe('Invalid response from payment provider');
    });

    it('FAULT-03: Prototype pollution attempt in POST /api/payments body is stripped by Zod schema and does not pollute Object prototype', async () => {
      const pollutedBody = JSON.parse('{"__proto__": {"isAdmin": true}, "plan": "ENTERPRISE"}');

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: pollutedBody,
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute(PAYMENTS_ROUTE, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      expect((Object.prototype as any).isAdmin).toBeUndefined();
    });
  });
});
