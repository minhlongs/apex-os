jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

import * as crypto from 'crypto';
import * as sessionHelper from '@/lib/auth/session-helper';
import {
  mockBillingDB,
  setupBillingTestEnvironment,
  createTestRequest,
  dispatchRoute,
  generateIpnSignature,
  DEFAULT_USER,
  SECOND_USER,
} from './billing-test-harness';

const IPN_SECRET = 'apexos-challenger-m3-2-secret-key-32b';
const ROUTE_PATH = 'src/app/api/webhooks/ipn/route.ts';

beforeAll(() => {
  setupBillingTestEnvironment();
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
});

beforeEach(() => {
  mockBillingDB.reset();
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
});

describe('Challenger M3-2: Tier Lifecycle, Audit Trail & Database Edge Cases', () => {

  // =========================================================================
  // Dimension 1: Out-of-Order & Status State Machine Transitions
  // =========================================================================
  describe('1. Out-of-Order Callbacks & State Machine Transitions', () => {
    it('OOO-01: waiting callback arriving AFTER confirmed does NOT downgrade payment status or tier', async () => {
      mockBillingDB.payments.set('pay-ooo-01', {
        id: 'db-pay-ooo-01',
        payment_id: 'pay-ooo-01',
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

      // 1. Deliver confirmed callback
      const confPayload = {
        payment_id: 'pay-ooo-01',
        payment_status: 'confirmed',
        plan: 'PREMIUM',
        txn_id: '0xconf01',
      };
      const confSig = generateIpnSignature(confPayload, IPN_SECRET);
      const confRes = await dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: confPayload,
        headers: { 'x-nowpayments-sig': confSig },
      }));

      expect(confRes.status).toBe(200);
      expect(confRes.data.processed).toBe(true);
      expect(mockBillingDB.payments.get('pay-ooo-01')?.status).toBe('confirmed');
      expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('PREMIUM');

      // 2. Out-of-order late arrival: 'waiting'
      const latePayload = {
        payment_id: 'pay-ooo-01',
        payment_status: 'waiting',
        plan: 'PREMIUM',
      };
      const lateSig = generateIpnSignature(latePayload, IPN_SECRET);
      const lateRes = await dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: latePayload,
        headers: { 'x-nowpayments-sig': lateSig },
      }));

      expect(lateRes.status).toBe(200);
      expect(lateRes.data.deduped).toBe(true);

      // Verify invariant: status remains 'confirmed' and tier remains 'PREMIUM'
      const payment = mockBillingDB.payments.get('pay-ooo-01');
      expect(payment?.status).toBe('confirmed');
      expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('PREMIUM');
      expect(mockBillingDB.tierActivations.filter(a => a.payment_id === 'pay-ooo-01').length).toBe(1);
    });

    it('OOO-02: failed/expired callbacks arriving AFTER confirmed do NOT cancel or downgrade tier', async () => {
      mockBillingDB.payments.set('pay-ooo-02', {
        id: 'db-pay-ooo-02',
        payment_id: 'pay-ooo-02',
        status: 'confirmed',
        plan: 'ENTERPRISE',
        user_id: DEFAULT_USER.id,
        amount: 99,
        currency: 'USDT',
        txn_id: '0xent02',
        confirmed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      mockBillingDB.profiles.get(DEFAULT_USER.id)!.tier = 'ENTERPRISE';

      for (const badStatus of ['failed', 'expired', 'partially_paid']) {
        const payload = {
          payment_id: 'pay-ooo-02',
          payment_status: badStatus,
          plan: 'ENTERPRISE',
        };
        const sig = generateIpnSignature(payload, IPN_SECRET);
        const res = await dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': sig },
        }));

        expect(res.status).toBe(200);
        expect(res.data.deduped).toBe(true);
        expect(mockBillingDB.payments.get('pay-ooo-02')?.status).toBe('confirmed');
        expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('ENTERPRISE');
      }
    });

    it('OOO-03: late confirmed callback on an initially failed/expired payment safely recovers to confirmed', async () => {
      // Scenario: Blockchain congestion caused payment expiration, but transaction eventually mined
      mockBillingDB.payments.set('pay-ooo-03', {
        id: 'db-pay-ooo-03',
        payment_id: 'pay-ooo-03',
        status: 'failed',
        plan: 'MASTER',
        user_id: DEFAULT_USER.id,
        amount: 299,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const confPayload = {
        payment_id: 'pay-ooo-03',
        payment_status: 'confirmed',
        plan: 'MASTER',
        txn_id: '0xlatemined3',
      };
      const sig = generateIpnSignature(confPayload, IPN_SECRET);
      const res = await dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: confPayload,
        headers: { 'x-nowpayments-sig': sig },
      }));

      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(true);

      const p = mockBillingDB.payments.get('pay-ooo-03');
      expect(p?.status).toBe('confirmed');
      expect(p?.txn_id).toBe('0xlatemined3');
      expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('MASTER');
      expect(mockBillingDB.tierActivations.filter(a => a.payment_id === 'pay-ooo-03').length).toBe(1);
    });

    it('OOO-04: multi-state oscillation storm converges strictly to single confirmed state', async () => {
      mockBillingDB.payments.set('pay-ooo-04', {
        id: 'db-pay-ooo-04',
        payment_id: 'pay-ooo-04',
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

      const sequence = [
        'waiting',
        'confirming',
        'confirmed',
        'waiting',
        'partially_paid',
        'confirmed',
        'failed',
        'expired',
        'confirming',
        'finished',
      ];

      for (const st of sequence) {
        const payload = {
          payment_id: 'pay-ooo-04',
          payment_status: st,
          plan: 'PREMIUM',
          txn_id: `0xseq_${st}`,
        };
        const sig = generateIpnSignature(payload, IPN_SECRET);
        const res = await dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': sig },
        }));
        expect(res.status).toBe(200);
      }

      // Final status must be 'confirmed', never overwritten by later 'failed' or 'expired'
      const finalPayment = mockBillingDB.payments.get('pay-ooo-04');
      expect(finalPayment?.status).toBe('confirmed');
      expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('PREMIUM');

      // Exactly 1 tier activation and 1 receipt email
      const activations = mockBillingDB.tierActivations.filter(a => a.payment_id === 'pay-ooo-04');
      expect(activations.length).toBe(1);
      const emails = mockBillingDB.emailQueue.filter(e => e.metadata?.includes('pay-ooo-04'));
      expect(emails.length).toBe(1);
    });
  });

  // =========================================================================
  // Dimension 2: Missing Profile Records & Integrity
  // =========================================================================
  describe('2. Missing Profile Records & Unknown User Edge Cases', () => {
    it('PRF-01: confirmed payment for user NOT present in profiles updates payment safely without throwing', async () => {
      const nonExistentUserId = 'usr-ghost-' + crypto.randomUUID();
      mockBillingDB.payments.set('pay-prf-01', {
        id: 'db-pay-prf-01',
        payment_id: 'pay-prf-01',
        status: 'pending',
        plan: 'ENTERPRISE',
        user_id: nonExistentUserId,
        amount: 99,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: 'pay-prf-01',
        payment_status: 'confirmed',
        plan: 'ENTERPRISE',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const res = await dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      }));

      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(true);

      const p = mockBillingDB.payments.get('pay-prf-01');
      expect(p?.status).toBe('confirmed');

      // Tier activation inserted with fallback old_tier = BASIC
      const audit = mockBillingDB.tierActivations.find(a => a.payment_id === 'pay-prf-01');
      expect(audit).toBeTruthy();
      expect(audit?.user_id).toBe(nonExistentUserId);
      expect(audit?.old_tier).toBe('BASIC');
      expect(audit?.new_tier).toBe('ENTERPRISE');

      // No email should be enqueued for ghost user
      const ghostEmails = mockBillingDB.emailQueue.filter(e => e.user_id === nonExistentUserId);
      expect(ghostEmails.length).toBe(0);
    });

    it('PRF-02: profile with null email does not fail webhook and skips email queue', async () => {
      mockBillingDB.profiles.set('usr-noemail', {
        id: 'usr-noemail',
        email: '',
        full_name: 'No Email User',
        role: 'user',
        plan: 'free',
        tier: 'BASIC',
        wallet_address: null,
        preferred_chain: 'solana',
        notification_settings: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      mockBillingDB.payments.set('pay-prf-02', {
        id: 'db-pay-prf-02',
        payment_id: 'pay-prf-02',
        status: 'pending',
        plan: 'PREMIUM',
        user_id: 'usr-noemail',
        amount: 29,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: 'pay-prf-02',
        payment_status: 'confirmed',
        plan: 'PREMIUM',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const res = await dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      }));

      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(true);

      expect(mockBillingDB.profiles.get('usr-noemail')?.tier).toBe('PREMIUM');
      const queued = mockBillingDB.emailQueue.filter(e => e.user_id === 'usr-noemail');
      expect(queued.length).toBe(0);
    });

    it('PRF-03: handles successive sequential upgrades with accurate old_tier and new_tier chain', async () => {
      const user = mockBillingDB.profiles.get(DEFAULT_USER.id)!;
      user.tier = 'BASIC';
      user.plan = 'free';

      const plans = ['PREMIUM', 'ENTERPRISE', 'MASTER'];
      let expectedOld = 'BASIC';

      for (let i = 0; i < plans.length; i++) {
        const nextPlan = plans[i];
        const payId = `pay-seq-${i}`;

        mockBillingDB.payments.set(payId, {
          id: `db-${payId}`,
          payment_id: payId,
          status: 'pending',
          plan: nextPlan,
          user_id: DEFAULT_USER.id,
          amount: (i + 1) * 50,
          currency: 'USDT',
          txn_id: null,
          confirmed_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        const payload = {
          payment_id: payId,
          payment_status: 'confirmed',
          plan: nextPlan,
        };
        const sig = generateIpnSignature(payload, IPN_SECRET);
        const res = await dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': sig },
        }));

        expect(res.status).toBe(200);

        const audit = mockBillingDB.tierActivations.find(a => a.payment_id === payId);
        expect(audit).toBeTruthy();
        expect(audit?.old_tier).toBe(expectedOld);
        expect(audit?.new_tier).toBe(nextPlan);

        expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe(nextPlan);
        expectedOld = nextPlan;
      }

      // Check total audit count for user
      const userAudits = mockBillingDB.tierActivations.filter(a => a.user_id === DEFAULT_USER.id);
      expect(userAudits.length).toBe(3);
    });
  });

  // =========================================================================
  // Dimension 3: Database Error Recovery & Mutex Safety
  // =========================================================================
  describe('3. Database Error Recovery & Mutex Concurrency Safety', () => {
    it('DB-01: transient db.batch failure returns 500 and releases mutex lock, allowing subsequent retry to succeed', async () => {
      mockBillingDB.payments.set('pay-db-fail-01', {
        id: 'db-pay-db-fail-01',
        payment_id: 'pay-db-fail-01',
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
        payment_id: 'pay-db-fail-01',
        payment_status: 'confirmed',
        plan: 'MASTER',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);

      // Force db.batch to throw transient exception
      const originalBatch = mockBillingDB.batch.bind(mockBillingDB);
      let batchAttempts = 0;
      mockBillingDB.batch = async (stmts: any[]) => {
        batchAttempts++;
        if (batchAttempts === 1) {
          throw new Error('D1_SQLITE_BUSY: database is locked');
        }
        return originalBatch(stmts);
      };

      try {
        // Attempt 1: Should fail due to DB error
        const req1 = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': sig },
        });
        const res1 = await dispatchRoute(ROUTE_PATH, 'POST', req1);
        expect(res1.status).toBe(500);

        // Crucial invariant: The payment status must still be 'pending' (no partial commit)
        expect(mockBillingDB.payments.get('pay-db-fail-01')?.status).toBe('pending');
        expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('BASIC');
        expect(mockBillingDB.tierActivations.filter(a => a.payment_id === 'pay-db-fail-01').length).toBe(0);

        // Attempt 2: Webhook delivery retry from NOWPayments
        const req2 = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': sig },
        });
        const res2 = await dispatchRoute(ROUTE_PATH, 'POST', req2);

        // Mutex lock must have been released in finally block, so attempt 2 proceeds without deadlock!
        expect(res2.status).toBe(200);
        expect(res2.data.processed).toBe(true);

        // Verify full state committed on retry
        expect(mockBillingDB.payments.get('pay-db-fail-01')?.status).toBe('confirmed');
        expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('MASTER');
        expect(mockBillingDB.tierActivations.filter(a => a.payment_id === 'pay-db-fail-01').length).toBe(1);
      } finally {
        mockBillingDB.batch = originalBatch;
      }
    });

    it('DB-02: failure during email queue insertion does NOT abort payment confirmation (graceful degradation)', async () => {
      mockBillingDB.payments.set('pay-db-email-fail', {
        id: 'db-pay-db-email-fail',
        payment_id: 'pay-db-email-fail',
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
        payment_id: 'pay-db-email-fail',
        payment_status: 'confirmed',
        plan: 'PREMIUM',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);

      // Force email_queue insert to fail
      const originalPrepare = mockBillingDB.prepare.bind(mockBillingDB);
      mockBillingDB.prepare = (sql: string) => {
        if (sql.toUpperCase().includes('INSERT INTO EMAIL_QUEUE')) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error('D1_QUEUE_TABLE_CORRUPT: email queue write error');
              },
            }),
          } as any;
        }
        return originalPrepare(sql);
      };

      try {
        const req = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': sig },
        });
        const res = await dispatchRoute(ROUTE_PATH, 'POST', req);

        // Response must still be HTTP 200 because tier upgrade already succeeded
        expect(res.status).toBe(200);
        expect(res.data.processed).toBe(true);

        // Core business state is saved
        expect(mockBillingDB.payments.get('pay-db-email-fail')?.status).toBe('confirmed');
        expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('PREMIUM');
        expect(mockBillingDB.tierActivations.filter(a => a.payment_id === 'pay-db-email-fail').length).toBe(1);
      } finally {
        mockBillingDB.prepare = originalPrepare;
      }
    });
  });

  // =========================================================================
  // Dimension 4: Email Queue Priority & Content Integrity
  // =========================================================================
  describe('4. Email Queue Priority, Metadata & Content Integrity', () => {
    it('EML-01: enqueues receipt with priority = 1, type = payment_confirmation, and complete metadata', async () => {
      mockBillingDB.payments.set('pay-eml-01', {
        id: 'db-pay-eml-01',
        payment_id: 'pay-eml-01',
        status: 'pending',
        plan: 'ENTERPRISE',
        user_id: DEFAULT_USER.id,
        amount: 99.5,
        currency: 'USDC',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: 'pay-eml-01',
        payment_status: 'confirmed',
        plan: 'ENTERPRISE',
        txn_id: '0x0987654321fedcba',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);

      const emails = mockBillingDB.emailQueue.filter(e => e.user_id === DEFAULT_USER.id);
      expect(emails.length).toBe(1);

      const email = emails[0];
      expect(email.priority).toBe(1); // Explicit requirement: priority 1
      expect(email.type).toBe('payment_confirmation');
      expect(email.email).toBe(DEFAULT_USER.email);
      expect(email.subject).toBe('ApexOS ENTERPRISE Plan Confirmation');
      expect(email.html).toContain('ENTERPRISE');
      expect(email.html).toContain('pay-eml-01');
      expect(email.html).toContain('99.5');
      expect(email.html).toContain('USDC');
      expect(email.text).toContain('pay-eml-01');

      // Validate parsed metadata
      expect(email.metadata).toBeTruthy();
      let meta = JSON.parse(email.metadata!);
      if (typeof meta === 'string') meta = JSON.parse(meta);
      expect(meta.dedupeKey).toBe('payment-receipt-pay-eml-01');
      expect(meta.paymentId).toBe('pay-eml-01');
      expect(meta.plan).toBe('ENTERPRISE');
      expect(meta.amount).toBe(99.5);
      expect(meta.currency).toBe('USDC');
      expect(meta.txnId).toBe('0x0987654321fedcba');
    });

    it('EML-02: handles special characters and high-value payments without payload corruption', async () => {
      mockBillingDB.payments.set('pay-special-!@#$', {
        id: 'db-pay-special',
        payment_id: 'pay-special-!@#$',
        status: 'pending',
        plan: 'MASTER',
        user_id: DEFAULT_USER.id,
        amount: 1000000.99,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const payload = {
        payment_id: 'pay-special-!@#$',
        payment_status: 'confirmed',
        plan: 'MASTER',
        txn_id: '0xspecial<tag>"quotes"&amp;',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);
      const req = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: payload,
        headers: { 'x-nowpayments-sig': sig },
      });

      const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
      expect(res.status).toBe(200);

      const email = mockBillingDB.emailQueue.find(e => e.metadata?.includes('pay-special-!@#$'));
      expect(email).toBeTruthy();
      expect(email?.priority).toBe(1);
      let meta = JSON.parse(email!.metadata!);
      if (typeof meta === 'string') meta = JSON.parse(meta);
      expect(meta.amount).toBe(1000000.99);
      expect(meta.txnId).toBe('0xspecial<tag>"quotes"&amp;');
    });
  });

  // =========================================================================
  // Dimension 5: Deep Payload Edge Cases & Infrastructure Resilience
  // =========================================================================
  describe('5. Deep Payload Edge Cases & Infrastructure Resilience', () => {
    it('EDGE-01: extracts transaction ID from alternative fields (purchase_id, parent_payment_id, payin_extra_id)', async () => {
      const cases = [
        { payload: { purchase_id: 888123 }, expectedTxn: '888123' },
        { payload: { parent_payment_id: 999456 }, expectedTxn: '999456' },
        { payload: { payin_extra_id: 'extra_memo_xyz' }, expectedTxn: 'extra_memo_xyz' },
      ];

      for (let i = 0; i < cases.length; i++) {
        const { payload, expectedTxn } = cases[i];
        const payId = `pay-alt-tx-${i}`;

        mockBillingDB.payments.set(payId, {
          id: `db-${payId}`,
          payment_id: payId,
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

        const body = {
          payment_id: payId,
          payment_status: 'confirmed',
          plan: 'PREMIUM',
          ...payload,
        };
        const sig = generateIpnSignature(body, IPN_SECRET);
        const res = await dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body,
          headers: { 'x-nowpayments-sig': sig },
        }));

        expect(res.status).toBe(200);
        expect(mockBillingDB.payments.get(payId)?.txn_id).toBe(expectedTxn);
      }
    });

    it('EDGE-02: supports uppercase payment_status "FINISHED" as equivalent to confirmed', async () => {
      mockBillingDB.payments.set('pay-finished-upper', {
        id: 'db-pay-finished-upper',
        payment_id: 'pay-finished-upper',
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

      const body = {
        payment_id: 'pay-finished-upper',
        payment_status: 'FINISHED',
        plan: 'ENTERPRISE',
      };
      const sig = generateIpnSignature(body, IPN_SECRET);
      const res = await dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body,
        headers: { 'x-nowpayments-sig': sig },
      }));

      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(true);
      expect(mockBillingDB.payments.get('pay-finished-upper')?.status).toBe('confirmed');
    });

    it('EDGE-03: returns 503 Service Unavailable when resolveDatabase() fails or returns null', async () => {
      const payload = {
        payment_id: 'pay-db-null',
        payment_status: 'confirmed',
        plan: 'BASIC',
      };
      const sig = generateIpnSignature(payload, IPN_SECRET);

      const spy = jest.spyOn(sessionHelper, 'resolveDatabase').mockReturnValueOnce(null);

      try {
        const req = createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: payload,
          headers: { 'x-nowpayments-sig': sig },
        });
        const res = await dispatchRoute(ROUTE_PATH, 'POST', req);
        expect(res.status).toBe(503);
        expect(res.error).toMatch(/database unavailable/i);
      } finally {
        spy.mockRestore();
      }
    });

    it('EDGE-04: concurrent payments across separate users execute in parallel without cross-talk', async () => {
      mockBillingDB.payments.set('pay-user1', {
        id: 'db-pay-u1',
        payment_id: 'pay-user1',
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

      mockBillingDB.payments.set('pay-user2', {
        id: 'db-pay-u2',
        payment_id: 'pay-user2',
        status: 'pending',
        plan: 'MASTER',
        user_id: SECOND_USER.id,
        amount: 299,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const body1 = { payment_id: 'pay-user1', payment_status: 'confirmed', plan: 'PREMIUM' };
      const body2 = { payment_id: 'pay-user2', payment_status: 'confirmed', plan: 'MASTER' };

      const [res1, res2] = await Promise.all([
        dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: body1,
          headers: { 'x-nowpayments-sig': generateIpnSignature(body1, IPN_SECRET) },
        })),
        dispatchRoute(ROUTE_PATH, 'POST', createTestRequest('/api/webhooks/ipn', {
          method: 'POST',
          body: body2,
          headers: { 'x-nowpayments-sig': generateIpnSignature(body2, IPN_SECRET) },
        })),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.tier).toBe('PREMIUM');
      expect(mockBillingDB.profiles.get(SECOND_USER.id)?.tier).toBe('MASTER');

      const auditU1 = mockBillingDB.tierActivations.find(a => a.payment_id === 'pay-user1');
      const auditU2 = mockBillingDB.tierActivations.find(a => a.payment_id === 'pay-user2');
      expect(auditU1?.user_id).toBe(DEFAULT_USER.id);
      expect(auditU2?.user_id).toBe(SECOND_USER.id);
    });
  });
});
