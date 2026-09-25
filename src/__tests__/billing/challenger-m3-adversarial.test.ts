/**
 * Empirical Challenger M3 Adversarial Test Suite
 * Target: src/app/api/webhooks/ipn/route.ts
 *
 * Authored by: teamwork_preview_challenger_m3_1
 * Role: EMPIRICAL CHALLENGER
 *
 * Scope:
 * 1. Cryptographic Forgery & Header Defense (bit flips, length attacks, non-hex, missing/empty headers)
 * 2. Payload Tampering Defense (altered fields, injected properties, malformed JSON, canonical key ordering)
 * 3. High-Concurrency Burst Storms & Status Race Isolation (10x, 25x bursts, mixed statuses, terminal state protection)
 * 4. Audit Log Integrity, State Machine Guarantees & Resilience
 */

import * as crypto from 'crypto';
import {
  mockBillingDB,
  setupBillingTestEnvironment,
  createTestRequest,
  dispatchRoute,
  generateIpnSignature,
  DEFAULT_USER,
  SECOND_USER,
} from './billing-test-harness';

const IPN_SECRET = 'apexos-ipn-secret-empiric-challenge-2026';
const ROUTE_PATH = 'src/app/api/webhooks/ipn/route.ts';

beforeAll(() => {
  setupBillingTestEnvironment();
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
});

beforeEach(() => {
  mockBillingDB.reset();
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
});

describe('Challenger M3 Adversarial IPN Verification & Concurrency Suite', () => {

  // =========================================================================
  // Section 1: Forged Signatures, Header Mutations & Cryptographic Attacks
  // =========================================================================
  describe('1. Cryptographic Signature Forgery & Header Mutation Attacks', () => {
    it('ADV-SIG-01: rejects single-bit flipped signature (1-character alteration) with 401', async () => {
      const payload = {
        payment_id: 'adv-sig-01',
        payment_status: 'confirmed',
        price_amount: 99,
        plan: 'ENTERPRISE',
      };
      const validSig = generateIpnSignature(payload, IPN_SECRET);
      // Flip the first character of the 128-char hex digest
      const flippedChar = validSig[0] === 'a' ? 'b' : 'a';
      const forgedSig = flippedChar + validSig.slice(1);

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': forgedSig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
      expect(res.error).toMatch(/signature/i);
    });

    it('ADV-SIG-02: rejects arbitrary 128-char hex signatures (attacker-guessed or all-zeros)', async () => {
      const payload = { payment_id: 'adv-sig-02', payment_status: 'confirmed', plan: 'MASTER' };
      const allZerosSig = '0'.repeat(128);
      const allFsSig = 'f'.repeat(128);

      for (const fakeSig of [allZerosSig, allFsSig]) {
        const req = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': fakeSig },
        });
        const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
        expect(res.status).toBe(401);
      }
    });

    it('ADV-SIG-03: rejects signature computed using an attacker-controlled secret', async () => {
      const payload = { payment_id: 'adv-sig-03', payment_status: 'confirmed', plan: 'PREMIUM' };
      const attackerSecret = 'attacker-private-key-compromised-999';
      const fakeSig = generateIpnSignature(payload, attackerSecret);

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': fakeSig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
    });

    it('ADV-SIG-04: rejects off-by-one signature lengths (127 chars and 129 chars)', async () => {
      const payload = { payment_id: 'adv-sig-04', payment_status: 'confirmed' };
      const validSig = generateIpnSignature(payload, IPN_SECRET);
      const tooShort = validSig.slice(0, 127);
      const tooLong = validSig + '0';

      for (const badSig of [tooShort, tooLong]) {
        const req = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': badSig },
        });
        const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
        expect(res.status).toBe(401);
      }
    });

    it('ADV-SIG-05: rejects SHA-256 (64-character) signature format (algorithm downgrade attempt)', async () => {
      const payload = { payment_id: 'adv-sig-05', payment_status: 'confirmed' };
      const sha256Sig = crypto.createHmac('sha256', IPN_SECRET).update(JSON.stringify(payload)).digest('hex');

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sha256Sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
    });

    it('ADV-SIG-06: rejects signatures containing non-hex characters or null bytes', async () => {
      const payload = { payment_id: 'adv-sig-06', payment_status: 'confirmed' };
      const validSig = generateIpnSignature(payload, IPN_SECRET);
      const withNullByte = validSig.slice(0, 63) + '\0' + validSig.slice(64);
      const withNonHexChar = validSig.slice(0, 63) + 'Z' + validSig.slice(64);
      const withPunctuation = validSig.slice(0, 63) + '!' + validSig.slice(64);

      for (const invalidSig of [withNullByte, withNonHexChar, withPunctuation]) {
        const req = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': invalidSig },
        });
        const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
        expect(res.status).toBe(401);
      }
    });

    it('ADV-SIG-07: rejects missing signature header or whitespace/newline headers', async () => {
      const payload = { payment_id: 'adv-sig-07', payment_status: 'confirmed' };

      // Case A: Missing header
      const reqMissing = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: {},
      });
      const resMissing = await dispatchRoute(ROUTE_PATH, 'POST', reqMissing);
      expect(resMissing.status).toBe(401);

      // Case B: Pure whitespace headers
      const whitespaceHeaders = ['   ', '\t', '\n', ' \t \n\r '];
      for (const ws of whitespaceHeaders) {
        const reqWs = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': ws },
        });
        const resWs = await dispatchRoute(ROUTE_PATH, 'POST', reqWs);
        expect(resWs.status).toBe(401);
      }
    });

    it('ADV-SIG-08: successfully verifies valid signature with mixed-case uppercase hex and edge whitespace', async () => {
      const payload = { payment_id: 'adv-sig-08', payment_status: 'confirmed', plan: 'PREMIUM' };
      const rawSig = generateIpnSignature(payload, IPN_SECRET);
      const mixedCasePaddedSig = `  \t ${rawSig.slice(0, 64).toUpperCase()}${rawSig.slice(64).toLowerCase()} \n `;

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': mixedCasePaddedSig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.received).toBe(true);
    });

    it('ADV-SIG-09: supports both primary (x-nowpayments-sig) and fallback (x-nowpayments-signature) headers', async () => {
      const payload = { payment_id: 'adv-sig-09', payment_status: 'confirmed', plan: 'BASIC' };
      const sig = generateIpnSignature(payload, IPN_SECRET);

      // Test fallback header
      const reqLegacy = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-signature': sig },
      });
      const resLegacy = await dispatchRoute(ROUTE_PATH, 'POST', reqLegacy);
      expect(resLegacy.status).toBe(200);
      expect(resLegacy.data.received).toBe(true);
    });
  });

  // =========================================================================
  // Section 2: Altered Payload Fields & Tampering Attacks
  // =========================================================================
  describe('2. Payload Tampering Defense & Canonical Sorting Invariants', () => {
    it('ADV-TAMPER-01: detects altered payment_status (waiting -> confirmed) and rejects with 401', async () => {
      const originalPayload = {
        payment_id: 'adv-tamper-01',
        payment_status: 'waiting',
        price_amount: 99,
        plan: 'ENTERPRISE',
      };
      // Sign with original status "waiting"
      const sig = generateIpnSignature(originalPayload, IPN_SECRET);

      // Tamper: attacker changes status to "confirmed" without valid HMAC
      const tamperedPayload = { ...originalPayload, payment_status: 'confirmed' };
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: tamperedPayload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
      expect(res.error).toMatch(/signature/i);
    });

    it('ADV-TAMPER-02: detects altered plan tier (BASIC -> MASTER) and rejects with 401', async () => {
      const originalPayload = {
        payment_id: 'adv-tamper-02',
        payment_status: 'confirmed',
        price_amount: 9,
        plan: 'BASIC',
      };
      const sig = generateIpnSignature(originalPayload, IPN_SECRET);

      const tamperedPayload = { ...originalPayload, plan: 'MASTER' };
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: tamperedPayload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
    });

    it('ADV-TAMPER-03: detects altered price_amount and rejects with 401', async () => {
      const originalPayload = {
        payment_id: 'adv-tamper-03',
        payment_status: 'confirmed',
        price_amount: 9,
        plan: 'BASIC',
      };
      const sig = generateIpnSignature(originalPayload, IPN_SECRET);

      const tamperedPayload = { ...originalPayload, price_amount: 999 };
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: tamperedPayload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
    });

    it('ADV-TAMPER-04: detects attacker-injected fields and rejects with 401', async () => {
      const originalPayload = {
        payment_id: 'adv-tamper-04',
        payment_status: 'confirmed',
        plan: 'PREMIUM',
      };
      const sig = generateIpnSignature(originalPayload, IPN_SECRET);

      const injectedPayload = {
        ...originalPayload,
        admin_grant: true,
        extra_credit: 1000,
      };
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: injectedPayload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
    });

    it('ADV-TAMPER-05: correctly verifies recursively shuffled JSON keys through canonical sorting', async () => {
      const payloadShuffled = {
        z_extra: 'value-z',
        payment_status: 'confirmed',
        nested: {
          beta: 2,
          alpha: 1,
          inner: {
            deep_z: 99,
            deep_a: 11,
          },
        },
        plan: 'ENTERPRISE',
        payment_id: 'adv-tamper-05',
        amount: 99,
      };

      const sig = generateIpnSignature(payloadShuffled, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payloadShuffled,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.received).toBe(true);
    });

    it('ADV-TAMPER-06: rejects malformed JSON or non-JSON payloads with 401 (signature failure)', async () => {
      const brokenBody = '{ "payment_id": "broken", "payment_status": ';
      const fakeSig = 'a'.repeat(128);

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: brokenBody,
        headers: { 'x-nowpayments-sig': fakeSig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
    });

    it('ADV-TAMPER-07: SQL injection strings in payload are safely escaped via prepared statements', async () => {
      mockBillingDB.payments.set('adv-sqli-01', {
        id: 'pay-sqli-01',
        payment_id: 'adv-sqli-01',
        status: 'pending',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const sqliPayload = {
        payment_id: 'adv-sqli-01',
        payment_status: 'confirmed',
        plan: "PREMIUM'; DROP TABLE payments; --",
        txn_id: "' OR '1'='1",
      };
      const sig = generateIpnSignature(sqliPayload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: sqliPayload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);

      // Verify payments table is NOT dropped and record is preserved
      const paymentRow = mockBillingDB.payments.get('adv-sqli-01');
      expect(paymentRow).toBeDefined();
      expect(paymentRow?.status).toBe('confirmed');
    });
  });

  // =========================================================================
  // Section 3: High-Concurrency Burst Replay Storms & Race Conditions
  // =========================================================================
  describe('3. Concurrency Stress & Burst Replay Storm Protection', () => {
    it('ADV-BURST-01: 10x concurrent burst storm on pending payment produces exactly 1 activation & 1 email', async () => {
      const paymentId = 'adv-burst-01';
      mockBillingDB.payments.set(paymentId, {
        id: `pay-${paymentId}`,
        payment_id: paymentId,
        status: 'pending',
        plan: 'MASTER',
        user_id: DEFAULT_USER.id,
        amount: 299,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: paymentId,
        payment_status: 'confirmed',
        plan: 'MASTER',
        txn_id: '0xburst_tx_10x',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);

      // Launch 10 simultaneous webhook callbacks
      const burstRequests = Array.from({ length: 10 }, () => {
        const req = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': sig },
        });
        return dispatchRoute(ROUTE_PATH, 'POST', req);
      });

      const responses = await Promise.all(burstRequests);

      // All requests must return HTTP 200
      responses.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.data.received).toBe(true);
      });

      // Exactly 1 request should have processed the activation, others deduplicated
      const processedCount = responses.filter((r) => r.data.processed === true).length;
      const dedupedCount = responses.filter((r) => r.data.deduped === true).length;
      expect(processedCount).toBe(1);
      expect(dedupedCount).toBe(9);

      // Invariants check in database:
      // Exactly 1 tier_activations record
      const activations = mockBillingDB.tierActivations.filter((a) => a.payment_id === paymentId);
      expect(activations.length).toBe(1);
      expect(activations[0].new_tier).toBe('MASTER');

      // Exactly 1 email_queue record
      const emails = mockBillingDB.emailQueue.filter((e) => e.user_id === DEFAULT_USER.id);
      expect(emails.length).toBe(1);
      expect(emails[0].subject).toContain('MASTER');
    });

    it('ADV-BURST-02: 25x concurrent callbacks across 5 distinct payments are properly isolated', async () => {
      const paymentIds = ['adv-multi-01', 'adv-multi-02', 'adv-multi-03', 'adv-multi-04', 'adv-multi-05'];

      paymentIds.forEach((pid, idx) => {
        mockBillingDB.payments.set(pid, {
          id: `pay-${pid}`,
          payment_id: pid,
          status: 'pending',
          plan: 'PREMIUM',
          user_id: DEFAULT_USER.id,
          amount: 29,
          currency: 'USDT',
          txn_id: null,
          confirmed_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      });

      // For each payment, create 5 concurrent calls (total 25)
      const allCalls = paymentIds.flatMap((pid) => {
        const payload = {
          payment_id: pid,
          payment_status: 'confirmed',
          plan: 'PREMIUM',
          txn_id: `0x${pid}`,
        };
        const sig = generateIpnSignature(payload, IPN_SECRET);
        return Array.from({ length: 5 }, () => {
          const req = createTestRequest('/api/webhooks/ipn', {
            method: 'POST',
            body: payload,
            headers: { 'x-nowpayments-sig': sig },
          });
          return dispatchRoute(ROUTE_PATH, 'POST', req);
        });
      });

      const responses = await Promise.all(allCalls);

      expect(responses.length).toBe(25);
      responses.forEach((res) => {
        expect(res.status).toBe(200);
      });

      // Exactly 5 activations in total (1 per payment ID)
      expect(mockBillingDB.tierActivations.length).toBe(5);
      for (const pid of paymentIds) {
        const pActs = mockBillingDB.tierActivations.filter((a) => a.payment_id === pid);
        expect(pActs.length).toBe(1);
      }
    });

    it('ADV-BURST-03: terminal status lock: confirmed payment can NEVER be overwritten by failed/waiting replay', async () => {
      const paymentId = 'adv-lock-03';
      mockBillingDB.payments.set(paymentId, {
        id: `pay-${paymentId}`,
        payment_id: paymentId,
        status: 'confirmed',
        plan: 'ENTERPRISE',
        user_id: DEFAULT_USER.id,
        amount: 99,
        currency: 'USDT',
        txn_id: '0xlocked_tx',
        confirmed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const userProfile = mockBillingDB.profiles.get(DEFAULT_USER.id)!;
      userProfile.tier = 'ENTERPRISE';
      userProfile.plan = 'ENTERPRISE';

      // 1. Replay with "failed" status
      const failedPayload = { payment_id: paymentId, payment_status: 'failed', plan: 'ENTERPRISE' };
      const failedSig = generateIpnSignature(failedPayload, IPN_SECRET);
      const reqFailed = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: failedPayload,
        headers: { 'x-nowpayments-sig': failedSig },
      });
      const resFailed = await dispatchRoute(ROUTE_PATH, 'POST', reqFailed);
      expect(resFailed.status).toBe(200);
      expect(resFailed.data.deduped).toBe(true);

      // Verify payment remains confirmed
      const pAfterFailed = mockBillingDB.payments.get(paymentId);
      expect(pAfterFailed?.status).toBe('confirmed');
      expect(userProfile.tier).toBe('ENTERPRISE');

      // 2. Replay with "expired" status
      const expiredPayload = { payment_id: paymentId, payment_status: 'expired', plan: 'ENTERPRISE' };
      const expiredSig = generateIpnSignature(expiredPayload, IPN_SECRET);
      const reqExpired = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: expiredPayload,
        headers: { 'x-nowpayments-sig': expiredSig },
      });
      const resExpired = await dispatchRoute(ROUTE_PATH, 'POST', reqExpired);
      expect(resExpired.status).toBe(200);
      expect(resExpired.data.deduped).toBe(true);

      // 3. Replay with "waiting" status
      const waitingPayload = { payment_id: paymentId, payment_status: 'waiting', plan: 'ENTERPRISE' };
      const waitingSig = generateIpnSignature(waitingPayload, IPN_SECRET);
      const reqWaiting = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: waitingPayload,
        headers: { 'x-nowpayments-sig': waitingSig },
      });
      const resWaiting = await dispatchRoute(ROUTE_PATH, 'POST', reqWaiting);
      expect(resWaiting.status).toBe(200);
      expect(resWaiting.data.deduped).toBe(true);

      // Status must STILL be confirmed
      expect(mockBillingDB.payments.get(paymentId)?.status).toBe('confirmed');
    });

    it('ADV-BURST-04: mixed-status race condition resolves safely to confirmed state', async () => {
      const paymentId = 'adv-mixed-04';
      mockBillingDB.payments.set(paymentId, {
        id: `pay-${paymentId}`,
        payment_id: paymentId,
        status: 'pending',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const makeReq = (status: string) => {
        const p = { payment_id: paymentId, payment_status: status, plan: 'PREMIUM' };
        const sig = generateIpnSignature(p, IPN_SECRET);
        return createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: p,
          headers: { 'x-nowpayments-sig': sig },
        });
      };

      // Concurrent barrage: waiting, confirming, confirmed, waiting, confirming, confirmed
      const promises = [
        dispatchRoute(ROUTE_PATH, 'POST', makeReq('waiting')),
        dispatchRoute(ROUTE_PATH, 'POST', makeReq('confirming')),
        dispatchRoute(ROUTE_PATH, 'POST', makeReq('confirmed')),
        dispatchRoute(ROUTE_PATH, 'POST', makeReq('waiting')),
        dispatchRoute(ROUTE_PATH, 'POST', makeReq('confirmed')),
      ];

      const results = await Promise.all(promises);
      results.forEach((r) => expect(r.status).toBe(200));

      // Final payment status MUST be confirmed
      const payment = mockBillingDB.payments.get(paymentId);
      expect(payment?.status).toBe('confirmed');

      // Maximum 1 activation record created
      const activations = mockBillingDB.tierActivations.filter((a) => a.payment_id === paymentId);
      expect(activations.length).toBe(1);
    });
  });

  // =========================================================================
  // Section 4: Lifecycle Edge Cases, Missing Fields & Untracked Payments
  // =========================================================================
  describe('4. Lifecycle Edge Cases & Audit Correctness', () => {
    it('ADV-EDGE-01: confirmed payment for untracked payment_id returns skipped: true without throwing', async () => {
      const payload = {
        payment_id: 'unknown-payment-99999',
        payment_status: 'confirmed',
        plan: 'MASTER',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.received).toBe(true);
      expect(res.data.skipped).toBe(true);
      expect(res.data.reason).toBe('payment_not_found');
      expect(mockBillingDB.tierActivations.length).toBe(0);
    });

    it('ADV-EDGE-02: numeric payment_id in payload is normalized and matches string payment_id in DB', async () => {
      const numPaymentId = 987654321;
      mockBillingDB.payments.set(String(numPaymentId), {
        id: 'pay-num-01',
        payment_id: String(numPaymentId),
        status: 'pending',
        plan: 'ENTERPRISE',
        user_id: DEFAULT_USER.id,
        amount: 99,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: numPaymentId, // Numeric instead of string
        payment_status: 'confirmed',
        plan: 'ENTERPRISE',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(true);

      const p = mockBillingDB.payments.get(String(numPaymentId));
      expect(p?.status).toBe('confirmed');
    });

    it('ADV-EDGE-03: alternate confirmed status "finished" behaves identically to "confirmed"', async () => {
      const paymentId = 'adv-finished-01';
      mockBillingDB.payments.set(paymentId, {
        id: `pay-${paymentId}`,
        payment_id: paymentId,
        status: 'pending',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: paymentId,
        payment_status: 'finished', // NOWPayments sometimes reports 'finished'
        plan: 'PREMIUM',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(true);

      const p = mockBillingDB.payments.get(paymentId);
      expect(p?.status).toBe('confirmed');
      const userProfile = mockBillingDB.profiles.get(DEFAULT_USER.id);
      expect(userProfile?.tier).toBe('PREMIUM');
    });

    it('ADV-EDGE-04: handles missing email on user profile without crashing or failing webhook', async () => {
      const user = mockBillingDB.profiles.get(DEFAULT_USER.id)!;
      user.email = ''; // Empty email

      const paymentId = 'adv-noemail-01';
      mockBillingDB.payments.set(paymentId, {
        id: `pay-${paymentId}`,
        payment_id: paymentId,
        status: 'pending',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: paymentId,
        payment_status: 'confirmed',
        plan: 'BASIC',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(true);

      // DB state is updated
      const p = mockBillingDB.payments.get(paymentId);
      expect(p?.status).toBe('confirmed');

      // Email queue is skipped gracefully without crashing
      const emails = mockBillingDB.emailQueue.filter((e) => e.user_id === DEFAULT_USER.id);
      expect(emails.length).toBe(0);
    });

    it('ADV-EDGE-05: audit log accurately records old_tier and new_tier on successive upgrades', async () => {
      // First upgrade: BASIC -> PREMIUM
      const prof = mockBillingDB.profiles.get(DEFAULT_USER.id)!;
      prof.tier = 'BASIC';
      prof.plan = 'BASIC';

      const pid1 = 'upgrade-step-1';
      mockBillingDB.payments.set(pid1, {
        id: `pay-${pid1}`,
        payment_id: pid1,
        status: 'pending',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const p1 = { payment_id: pid1, payment_status: 'confirmed', plan: 'PREMIUM' };
      const req1 = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: p1,
        headers: { 'x-nowpayments-sig': generateIpnSignature(p1, IPN_SECRET) },
      });
      await dispatchRoute(ROUTE_PATH, 'POST', req1);

      expect(prof.tier).toBe('PREMIUM');
      const act1 = mockBillingDB.tierActivations.find((a) => a.payment_id === pid1);
      expect(act1?.old_tier).toBe('BASIC');
      expect(act1?.new_tier).toBe('PREMIUM');

      // Second upgrade: PREMIUM -> MASTER
      const pid2 = 'upgrade-step-2';
      mockBillingDB.payments.set(pid2, {
        id: `pay-${pid2}`,
        payment_id: pid2,
        status: 'pending',
        plan: 'MASTER',
        user_id: DEFAULT_USER.id,
        amount: 299,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const p2 = { payment_id: pid2, payment_status: 'confirmed', plan: 'MASTER' };
      const req2 = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: p2,
        headers: { 'x-nowpayments-sig': generateIpnSignature(p2, IPN_SECRET) },
      });
      await dispatchRoute(ROUTE_PATH, 'POST', req2);

      expect(prof.tier).toBe('MASTER');
      const act2 = mockBillingDB.tierActivations.find((a) => a.payment_id === pid2);
      expect(act2?.old_tier).toBe('PREMIUM');
      expect(act2?.new_tier).toBe('MASTER');
    });
  });
});
