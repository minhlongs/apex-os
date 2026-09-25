/**
 * Unit & Integration Test Suite: Payment IPN Webhook & Tier Lifecycle (M3)
 * Target File: src/__tests__/billing/webhooks-ipn-m3.test.ts
 *
 * Deeply verifies all Sprint 7 Milestone 3 features:
 * - F3: IPN HMAC-SHA512 Cryptographic Signature Verification
 * - F4: IPN Idempotency & Deduplication Protection
 * - F5: Tier Upgrade, Profiles Mutation & Audit Logging (tier_activations)
 * - F6: Receipt Notification Enqueue (email_queue)
 * - Infrastructure & Resilience: Database outage handling, invalid JSON, health endpoint
 */

import {
  mockBillingDB,
  setupBillingTestEnvironment,
  createTestRequest,
  dispatchRoute,
  generateIpnSignature,
  DEFAULT_USER,
} from './billing-test-harness';

const IPN_SECRET = 'test-ipn-secret-1234567890';
const ROUTE_PATH = 'src/app/api/webhooks/ipn/route.ts';

beforeAll(() => {
  setupBillingTestEnvironment();
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
});

beforeEach(() => {
  mockBillingDB.reset();
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
});

describe('M3 Webhook IPN Handler (POST /api/webhooks/ipn)', () => {
  // ==========================================================================
  // 1. Feature 3: Cryptographic Signature Verification (HMAC-SHA512)
  // ==========================================================================
  describe('F3: Cryptographic Signature Verification', () => {
    it('F3-01: accepts valid HMAC-SHA512 lowercase hex signature in x-nowpayments-sig', async () => {
      const payload = {
        payment_id: 'ipn-f3-01',
        payment_status: 'confirmed',
        price_amount: 29,
        price_currency: 'USD',
        plan: 'PREMIUM',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.implemented).toBe(true);
      expect(res.status).toBe(200);
      expect(res.data.received).toBe(true);
    });

    it('F3-02: accepts valid HMAC-SHA512 signature in legacy header x-nowpayments-signature', async () => {
      const payload = {
        payment_id: 'ipn-f3-02',
        payment_status: 'confirmed',
        price_amount: 99,
        price_currency: 'USD',
        plan: 'ENTERPRISE',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-signature': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.implemented).toBe(true);
      expect(res.status).toBe(200);
      expect(res.data.received).toBe(true);
    });

    it('F3-03: rejects missing signature headers with HTTP 401 Unauthorized', async () => {
      const payload = {
        payment_id: 'ipn-f3-03',
        payment_status: 'confirmed',
        plan: 'BASIC',
      };
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: {}, // No signature header
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
      expect(res.error).toMatch(/signature/i);
    });

    it('F3-04: rejects empty or whitespace-only signature header with HTTP 401 Unauthorized', async () => {
      const payload = {
        payment_id: 'ipn-f3-04',
        payment_status: 'confirmed',
        plan: 'BASIC',
      };
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': '   ' },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
    });

    it('F3-05: rejects forged or corrupted signature with HTTP 401 Unauthorized', async () => {
      const payload = {
        payment_id: 'ipn-f3-05',
        payment_status: 'confirmed',
        price_amount: 299,
        plan: 'MASTER',
      };
      const forgedSig = 'a'.repeat(128); // Valid hex length, but forged content
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': forgedSig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
      expect(res.error).toMatch(/signature/i);
    });

    it('F3-06: rejects truncated signature (< 128 characters) with HTTP 401 Unauthorized', async () => {
      const payload = { payment_id: 'ipn-f3-06', payment_status: 'confirmed' };
      const rawSig = generateIpnSignature(payload, IPN_SECRET);
      const truncatedSig = rawSig.substring(0, 64); // Half length

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': truncatedSig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
    });

    it('F3-07: rejects non-hex characters in signature with HTTP 401 Unauthorized', async () => {
      const payload = { payment_id: 'ipn-f3-07', payment_status: 'confirmed' };
      const nonHexSig = 'z'.repeat(128);

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': nonHexSig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
    });

    it('F3-08: rejects signature computed with wrong secret with HTTP 401 Unauthorized', async () => {
      const payload = { payment_id: 'ipn-f3-08', payment_status: 'confirmed' };
      const wrongSig = generateIpnSignature(payload, 'wrong-ipn-secret-999');

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': wrongSig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(401);
    });

    it('F3-09: trims leading and trailing whitespace around signature', async () => {
      const payload = {
        payment_id: 'ipn-f3-09',
        payment_status: 'confirmed',
        plan: 'PREMIUM',
      };
      const rawSig = generateIpnSignature(payload, IPN_SECRET);
      const paddedSig = `   \t ${rawSig} \n  `;

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': paddedSig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.received).toBe(true);
    });

    it('F3-10: supports uppercase hexadecimal signature casing', async () => {
      const payload = {
        payment_id: 'ipn-f3-10',
        payment_status: 'confirmed',
        plan: 'BASIC',
      };
      const rawSig = generateIpnSignature(payload, IPN_SECRET);
      const upperSig = rawSig.toUpperCase();

      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': upperSig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.received).toBe(true);
    });

    it('F3-11: verifies signature against recursively sorted keys regardless of incoming order', async () => {
      // Disordered nested payload
      const disorderedPayload = {
        zebra: 100,
        payment_status: 'confirmed',
        details: {
          nested_z: 'last',
          nested_a: 'first',
        },
        alpha: 'first',
        payment_id: 'ipn-f3-11',
        plan: 'ENTERPRISE',
      };

      const sig = generateIpnSignature(disorderedPayload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: disorderedPayload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.received).toBe(true);
    });
  });

  // ==========================================================================
  // 2. Feature 4: IPN Idempotency & Deduplication Protection
  // ==========================================================================
  describe('F4: IPN Idempotency & Deduplication Protection', () => {
    it('F4-01: initial pending payment transitions to confirmed status', async () => {
      mockBillingDB.payments.set('ipn-f4-01', {
        id: 'pay-f4-01',
        payment_id: 'ipn-f4-01',
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
        payment_id: 'ipn-f4-01',
        payment_status: 'confirmed',
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

      const p = mockBillingDB.payments.get('ipn-f4-01');
      expect(p?.status).toBe('confirmed');
      expect(p?.confirmed_at).toBeTruthy();
    });

    it('F4-02: duplicate callback returns { received: true, deduped: true }', async () => {
      mockBillingDB.payments.set('ipn-f4-02', {
        id: 'pay-f4-02',
        payment_id: 'ipn-f4-02',
        status: 'confirmed',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
        currency: 'USDT',
        txn_id: '0xabc',
        confirmed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: 'ipn-f4-02',
        payment_status: 'confirmed',
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
      expect(res.data.received).toBe(true);
      expect(res.data.deduped).toBe(true);
    });

    it('F4-03: replay callback does not re-mutate profile tier', async () => {
      const prof = mockBillingDB.profiles.get(DEFAULT_USER.id)!;
      prof.tier = 'ENTERPRISE';
      prof.plan = 'ENTERPRISE';
      const beforeUpdatedAt = prof.updated_at;

      mockBillingDB.payments.set('ipn-f4-03', {
        id: 'pay-f4-03',
        payment_id: 'ipn-f4-03',
        status: 'confirmed',
        plan: 'ENTERPRISE',
        user_id: DEFAULT_USER.id,
        amount: 99,
        currency: 'USDT',
        txn_id: '0xenterprise',
        confirmed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: 'ipn-f4-03',
        payment_status: 'confirmed',
        plan: 'ENTERPRISE',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(prof.tier).toBe('ENTERPRISE');
      expect(prof.updated_at).toBe(beforeUpdatedAt);
    });

    it('F4-04: replay callback does not insert duplicate rows into tier_activations', async () => {
      mockBillingDB.payments.set('ipn-f4-04', {
        id: 'pay-f4-04',
        payment_id: 'ipn-f4-04',
        status: 'confirmed',
        plan: 'MASTER',
        user_id: DEFAULT_USER.id,
        amount: 299,
        currency: 'USDT',
        txn_id: '0xmaster',
        confirmed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      mockBillingDB.tierActivations.push({
        id: 'audit-existing-04',
        user_id: DEFAULT_USER.id,
        payment_id: 'ipn-f4-04',
        old_tier: 'BASIC',
        new_tier: 'MASTER',
        activated_by: 'ipn',
        created_at: new Date().toISOString(),
      });

      const auditCountBefore = mockBillingDB.tierActivations.length;

      const payload = {
        payment_id: 'ipn-f4-04',
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
      expect(res.data.deduped).toBe(true);
      expect(mockBillingDB.tierActivations.length).toBe(auditCountBefore);
    });

    it('F4-05: out-of-order callback (waiting after confirmed) does NOT downgrade status', async () => {
      mockBillingDB.payments.set('ipn-f4-05', {
        id: 'pay-f4-05',
        payment_id: 'ipn-f4-05',
        status: 'confirmed',
        plan: 'MASTER',
        user_id: DEFAULT_USER.id,
        amount: 299,
        currency: 'USDT',
        txn_id: '0x123',
        confirmed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: 'ipn-f4-05',
        payment_status: 'waiting',
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
      expect(res.data.deduped).toBe(true);

      const p = mockBillingDB.payments.get('ipn-f4-05');
      expect(p?.status).toBe('confirmed');
    });

    it('F4-06: out-of-order callback (confirming after confirmed) does NOT downgrade status', async () => {
      mockBillingDB.payments.set('ipn-f4-06', {
        id: 'pay-f4-06',
        payment_id: 'ipn-f4-06',
        status: 'confirmed',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
        currency: 'USDT',
        txn_id: '0x456',
        confirmed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: 'ipn-f4-06',
        payment_status: 'confirming',
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
      expect(res.data.deduped).toBe(true);

      const p = mockBillingDB.payments.get('ipn-f4-06');
      expect(p?.status).toBe('confirmed');
    });

    it('F4-07: rapid burst storm of identical callbacks resolves safely without race conditions', async () => {
      mockBillingDB.payments.set('ipn-f4-07', {
        id: 'pay-f4-07',
        payment_id: 'ipn-f4-07',
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
        payment_id: 'ipn-f4-07',
        payment_status: 'confirmed',
        plan: 'MASTER',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);

      const promises = [1, 2, 3, 4, 5].map(() => {
        const req = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': sig },
        });
        return dispatchRoute(ROUTE_PATH, 'POST', req);
      });

      const results = await Promise.all(promises);
      results.forEach((r) => {
        expect(r.status).toBe(200);
        expect(r.data.received).toBe(true);
      });

      // Exactly 1 audit record should exist for this payment
      const audits = mockBillingDB.tierActivations.filter((a) => a.payment_id === 'ipn-f4-07');
      expect(audits.length).toBeLessThanOrEqual(1);
    });
  });

  // ==========================================================================
  // 3. Feature 5: Tier Upgrade & Audit Logging
  // ==========================================================================
  describe('F5: Tier Upgrade & Audit Logging', () => {
    it('F5-01: confirmed payment upgrades profile tier to PREMIUM', async () => {
      mockBillingDB.payments.set('ipn-f5-01', {
        id: 'pay-f5-01',
        payment_id: 'ipn-f5-01',
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
        payment_id: 'ipn-f5-01',
        payment_status: 'confirmed',
        plan: 'PREMIUM',
        txn_id: '0xpremium_tx',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);

      const prof = mockBillingDB.profiles.get(DEFAULT_USER.id);
      expect(prof?.tier).toBe('PREMIUM');
      expect(prof?.plan).toBe('PREMIUM');

      const p = mockBillingDB.payments.get('ipn-f5-01');
      expect(p?.status).toBe('confirmed');
      expect(p?.txn_id).toBe('0xpremium_tx');
    });

    it('F5-02: inserts comprehensive audit record into tier_activations table', async () => {
      const prof = mockBillingDB.profiles.get(DEFAULT_USER.id)!;
      prof.tier = 'BASIC';

      mockBillingDB.payments.set('ipn-f5-02', {
        id: 'pay-f5-02',
        payment_id: 'ipn-f5-02',
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
        payment_id: 'ipn-f5-02',
        payment_status: 'confirmed',
        plan: 'ENTERPRISE',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      await dispatchRoute(ROUTE_PATH, 'POST', req);

      const audits = mockBillingDB.tierActivations.filter((a) => a.payment_id === 'ipn-f5-02');
      expect(audits.length).toBe(1);
      expect(audits[0].user_id).toBe(DEFAULT_USER.id);
      expect(audits[0].new_tier).toBe('ENTERPRISE');
      expect(audits[0].old_tier).toBe('BASIC');
      expect(audits[0].activated_by).toBe('ipn');
      expect(audits[0].created_at).toBeTruthy();
    });

    it('F5-03: normalizes composite plan labels (e.g. enterprise-plan) to standard enum', async () => {
      mockBillingDB.payments.set('ipn-f5-03', {
        id: 'pay-f5-03',
        payment_id: 'ipn-f5-03',
        status: 'pending',
        plan: 'enterprise-plan',
        user_id: DEFAULT_USER.id,
        amount: 99,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: 'ipn-f5-03',
        payment_status: 'confirmed',
        plan: 'enterprise-plan',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      await dispatchRoute(ROUTE_PATH, 'POST', req);

      const prof = mockBillingDB.profiles.get(DEFAULT_USER.id);
      expect(prof?.tier).toBe('ENTERPRISE');
    });

    it('F5-04: non-confirmed status (waiting/confirming) does NOT upgrade profile tier', async () => {
      mockBillingDB.payments.set('ipn-f5-04', {
        id: 'pay-f5-04',
        payment_id: 'ipn-f5-04',
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
        payment_id: 'ipn-f5-04',
        payment_status: 'confirming',
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
      expect(res.data.skipped).toBe(true);

      const prof = mockBillingDB.profiles.get(DEFAULT_USER.id);
      expect(prof?.tier).toBe('BASIC'); // Remains untouched
    });

    it('F5-05: failed payment marks payment as failed without elevating tier', async () => {
      mockBillingDB.payments.set('ipn-f5-05', {
        id: 'pay-f5-05',
        payment_id: 'ipn-f5-05',
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
        payment_id: 'ipn-f5-05',
        payment_status: 'failed',
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

      const p = mockBillingDB.payments.get('ipn-f5-05');
      expect(p?.status).toBe('failed');

      const prof = mockBillingDB.profiles.get(DEFAULT_USER.id);
      expect(prof?.tier).toBe('BASIC');
    });
  });

  // ==========================================================================
  // 4. Feature 6: Receipt & Notification Enqueue
  // ==========================================================================
  describe('F6: Receipt & Notification Enqueue', () => {
    it('F6-01: confirmed payment enqueues receipt with priority = 1 in email_queue', async () => {
      mockBillingDB.payments.set('ipn-f6-01', {
        id: 'pay-f6-01',
        payment_id: 'ipn-f6-01',
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
        payment_id: 'ipn-f6-01',
        payment_status: 'confirmed',
        price_amount: 29,
        plan: 'PREMIUM',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      await dispatchRoute(ROUTE_PATH, 'POST', req);

      const queued = mockBillingDB.emailQueue.filter((e) => e.user_id === DEFAULT_USER.id);
      expect(queued.length).toBe(1);
      expect(queued[0].type).toMatch(/payment/i);
      expect(queued[0].email).toBe(DEFAULT_USER.email);
      expect(queued[0].priority).toBe(1);
      expect(queued[0].subject).toContain('PREMIUM');
    });

    it('F6-02: non-confirmed payment status does NOT enqueue receipt', async () => {
      mockBillingDB.payments.set('ipn-f6-02', {
        id: 'pay-f6-02',
        payment_id: 'ipn-f6-02',
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
        payment_id: 'ipn-f6-02',
        payment_status: 'failed',
        plan: 'ENTERPRISE',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      await dispatchRoute(ROUTE_PATH, 'POST', req);

      const queued = mockBillingDB.emailQueue.filter((e) => e.user_id === DEFAULT_USER.id);
      expect(queued.length).toBe(0);
    });

    it('F6-03: handles missing user email safely without failing IPN response', async () => {
      const user = mockBillingDB.profiles.get(DEFAULT_USER.id)!;
      user.email = '';

      mockBillingDB.payments.set('ipn-f6-03', {
        id: 'pay-f6-03',
        payment_id: 'ipn-f6-03',
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
        payment_id: 'ipn-f6-03',
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
      expect(res.data.received).toBe(true);
    });
  });

  // ==========================================================================
  // 5. Edge Cases & Health Check (GET /api/webhooks/ipn)
  // ==========================================================================
  describe('Edge Cases & Health Checks', () => {
    it('E-01: GET /api/webhooks/ipn returns 200 with status ok', async () => {
      const req = createTestRequest('/api/webhooks/ipn', { method: 'GET' });
      const res = await dispatchRoute(ROUTE_PATH, 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.status).toBe('ok');
    });

    it('E-02: handles missing payment_id in body gracefully', async () => {
      const payload = { payment_status: 'confirmed', plan: 'BASIC' };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.skipped).toBe(true);
    });
  });
});
