/**
 * Comprehensive Billing & Wallet Connect Test Harness
 * 
 * Provides:
 * 1. In-memory SQLite/D1 mock database tracking all tables:
 *    - payments, profiles, tier_activations, wallet_connections, device_tokens, deep_link_analytics, email_queue
 * 2. HMAC-SHA512 IPN signature generator with recursive JSON key sorting
 * 3. Mock NOWPayments HTTP API simulator
 * 4. Dual-authentication mock request builders (Bearer token & Cookie)
 * 5. Dynamic route loader and dispatcher for opaque-box E2E invocation
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { NextRequest } from 'next/server';

// Mock auth-factory to prevent ESM better-auth syntax error under Jest/CommonJS
jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

// ============================================================================
// Types
// ============================================================================

export interface PaymentRow {
  id: string;
  payment_id: string;
  status: 'pending' | 'confirming' | 'confirmed' | 'failed' | 'expired' | 'refunded';
  plan: 'BASIC' | 'PREMIUM' | 'ENTERPRISE' | 'MASTER' | string;
  user_id: string;
  amount: number;
  currency: string;
  txn_id: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  plan: string;
  tier: string;
  wallet_address: string | null;
  preferred_chain: string | null;
  notification_settings: string | null;
  created_at: string;
  updated_at: string;
}

export interface TierActivationRow {
  id: string;
  user_id: string;
  payment_id: string | null;
  old_tier: string | null;
  new_tier: string;
  activated_by: string;
  created_at: string;
}

export interface WalletConnectionRow {
  id: string;
  profile_id: string;
  wallet_address: string;
  preferred_chain: string;
  is_primary: number;
  connected_at: string;
  last_used_at: string | null;
}

export interface DeviceTokenRow {
  id: string;
  user_id: string;
  expo_token: string | null;
  platform: 'ios' | 'android' | 'web' | string;
  apns_token: string | null;
  fcm_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeepLinkAnalyticsRow {
  id: string;
  user_id: string | null;
  kind: string;
  route: string;
  source: 'notification' | 'direct' | string;
  event_timestamp: string;
  metadata: string | null;
  created_at: string;
}

export interface EmailQueueRow {
  id: string;
  user_id: string | null;
  email: string;
  type: string;
  subject: string;
  html: string;
  text: string | null;
  priority: number;
  status: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// In-Memory D1 Mock Database
// ============================================================================

export class MockBillingDatabase {
  public payments: Map<string, PaymentRow> = new Map();
  public profiles: Map<string, ProfileRow> = new Map();
  public tierActivations: TierActivationRow[] = [];
  public walletConnections: Map<string, WalletConnectionRow> = new Map();
  public deviceTokens: Map<string, DeviceTokenRow> = new Map();
  public deepLinkAnalytics: DeepLinkAnalyticsRow[] = [];
  public emailQueue: EmailQueueRow[] = [];

  constructor() {
    this.reset();
  }

  public reset() {
    this.payments.clear();
    this.profiles.clear();
    this.tierActivations = [];
    this.walletConnections.clear();
    this.deviceTokens.clear();
    this.deepLinkAnalytics = [];
    this.emailQueue = [];

    // Seed default test user profile
    this.profiles.set('usr-buyer-001', {
      id: 'usr-buyer-001',
      email: 'buyer1@apex-os.com',
      full_name: 'Apex Tester One',
      role: 'shopper',
      plan: 'free',
      tier: 'BASIC',
      wallet_address: null,
      preferred_chain: 'ethereum',
      notification_settings: null,
      created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      updated_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    });

    this.profiles.set('usr-buyer-002', {
      id: 'usr-buyer-002',
      email: 'buyer2@apex-os.com',
      full_name: 'Apex Tester Two',
      role: 'shopper',
      plan: 'free',
      tier: 'BASIC',
      wallet_address: null,
      preferred_chain: 'ethereum',
      notification_settings: null,
      created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      updated_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    });
  }

  public prepare(sql: string) {
    const cleanSql = sql.replace(/\s+/g, ' ').trim();

    return {
      bind: (...params: any[]) => ({
        first: async <T = unknown>(): Promise<T | null> => {
          return this.executeFirst(cleanSql, params) as T | null;
        },
        all: async <T = unknown>(): Promise<{ results: T[] }> => {
          const results = this.executeAll(cleanSql, params);
          return { results: results as T[] };
        },
        run: async (): Promise<{ success: boolean; meta: { changes: number } }> => {
          const changes = this.executeRun(cleanSql, params);
          return { success: true, meta: { changes } };
        },
      }),
      first: async <T = unknown>(): Promise<T | null> => {
        return this.executeFirst(cleanSql, []) as T | null;
      },
      all: async <T = unknown>(): Promise<{ results: T[] }> => {
        const results = this.executeAll(cleanSql, []);
        return { results: results as T[] };
      },
      run: async (): Promise<{ success: boolean; meta: { changes: number } }> => {
        const changes = this.executeRun(cleanSql, []);
        return { success: true, meta: { changes } };
      },
    };
  }

  public async batch(statements: any[]): Promise<any[]> {
    const results = [];
    for (const stmt of statements) {
      if (typeof stmt.run === 'function') {
        results.push(await stmt.run());
      } else {
        results.push({ success: true, meta: { changes: 1 } });
      }
    }
    return results;
  }

  private executeFirst(sql: string, params: any[]): any {
    const upper = sql.toUpperCase();

    // SELECT payments WHERE payment_id = ?
    if (upper.includes('FROM PAYMENTS') && upper.includes('PAYMENT_ID =')) {
      const pid = String(params[0] ?? '');
      for (const p of this.payments.values()) {
        if (p.payment_id === pid) return { ...p };
      }
      return null;
    }

    // SELECT profiles WHERE id = ?
    if (upper.includes('FROM PROFILES') && upper.includes('ID =')) {
      const uid = String(params[0] ?? '');
      return this.profiles.get(uid) ? { ...this.profiles.get(uid)! } : null;
    }

    // SELECT wallet_connections WHERE profile_id = ?
    if (upper.includes('FROM WALLET_CONNECTIONS') && upper.includes('PROFILE_ID =')) {
      const pid = String(params[0] ?? '');
      for (const w of this.walletConnections.values()) {
        if (w.profile_id === pid && w.is_primary === 1) return { ...w };
      }
      return null;
    }

    // SELECT device_tokens WHERE expo_token = ?
    if (upper.includes('FROM DEVICE_TOKENS') && upper.includes('EXPO_TOKEN =')) {
      const token = String(params[0] ?? '');
      return this.deviceTokens.get(token) ? { ...this.deviceTokens.get(token)! } : null;
    }

    // SELECT sessions WHERE token = ? OR id = ?
    if (upper.includes('FROM SESSIONS') || upper.includes('FROM "SESSIONS"') || upper.includes('FROM SESSION ') || upper.includes('FROM "SESSION"')) {
      const token = String(params[0] ?? '');
      if (!token) return null;
      const uid = token.startsWith('token-') ? token.replace(/^token-/, '') : token;
      const prof = this.profiles.get(uid);
      if (prof) {
        return {
          user_id: prof.id,
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          email: prof.email,
        };
      }
      if (uid && uid !== 'invalid' && uid !== 'null' && uid !== 'undefined') {
        return {
          user_id: uid,
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          email: `${uid}@apex-os.com`,
        };
      }
      return null;
    }

    // SELECT COUNT(*) FROM payments WHERE user_id = ?
    if (upper.includes('COUNT(*)') && upper.includes('FROM PAYMENTS')) {
      const uid = String(params[0] ?? '');
      const hasStatus = upper.includes('STATUS =');
      const statusFilter = hasStatus ? String(params[1] ?? '') : null;
      let count = 0;
      for (const p of this.payments.values()) {
        if (p.user_id === uid && (!statusFilter || p.status === statusFilter)) count++;
      }
      return { total: count, count };
    }

    return null;
  }

  private executeAll(sql: string, params: any[]): any[] {
    const upper = sql.toUpperCase();

    // SELECT payments WHERE user_id = ? [ORDER BY created_at DESC] [LIMIT ? OFFSET ?]
    if (upper.includes('FROM PAYMENTS') && upper.includes('USER_ID =')) {
      const uid = String(params[0] ?? '');
      const userPayments = Array.from(this.payments.values())
        .filter((p) => p.user_id === uid)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      // Check if status filter is in SQL
      let filtered = userPayments;
      let paramIdx = 1;
      if (upper.includes('STATUS =')) {
        const statusFilter = String(params[paramIdx++] ?? '');
        filtered = filtered.filter((p) => p.status === statusFilter);
      }

      // Check limit and offset
      if (upper.includes('LIMIT') && params.length >= paramIdx + 1) {
        const limit = Number(params[paramIdx] ?? 20);
        const offset = Number(params[paramIdx + 1] ?? 0);
        return filtered.slice(offset, offset + limit).map((p) => ({ ...p }));
      }

      return filtered.map((p) => ({ ...p }));
    }

    // SELECT deep_link_analytics
    if (upper.includes('FROM DEEP_LINK_ANALYTICS')) {
      return this.deepLinkAnalytics.map((a) => ({ ...a }));
    }

    // SELECT tier_activations
    if (upper.includes('FROM TIER_ACTIVATIONS')) {
      return this.tierActivations.map((t) => ({ ...t }));
    }

    // SELECT wallet_connections
    if (upper.includes('FROM WALLET_CONNECTIONS')) {
      return Array.from(this.walletConnections.values()).map((w) => ({ ...w }));
    }

    return [];
  }

  private executeRun(sql: string, params: any[]): number {
    const upper = sql.toUpperCase();

    // INSERT INTO payments
    if (upper.includes('INSERT INTO PAYMENTS') || upper.includes('INSERT OR REPLACE INTO PAYMENTS')) {
      // (id, payment_id, status, plan, user_id, amount, currency, ...)
      const id = String(params[0] ?? crypto.randomUUID());
      const paymentId = String(params[1] ?? '');
      const status = (params[2] ?? 'pending') as any;
      const plan = String(params[3] ?? 'BASIC');
      const userId = String(params[4] ?? '');
      const amount = Number(params[5] ?? 0);
      const currency = String(params[6] ?? 'USDT');
      const now = new Date().toISOString();

      const existing = this.payments.get(paymentId);
      const row: PaymentRow = {
        id: existing?.id ?? id,
        payment_id: paymentId,
        status,
        plan,
        user_id: userId,
        amount,
        currency,
        txn_id: existing?.txn_id ?? null,
        confirmed_at: status === 'confirmed' ? now : null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      this.payments.set(paymentId, row);
      return 1;
    }

    // UPDATE payments SET status = ... WHERE payment_id = ?
    if (upper.includes('UPDATE PAYMENTS')) {
      let paymentId = '';
      let newStatus: any = 'confirmed';
      let txnId: string | null = null;

      if (upper.includes("STATUS = 'CONFIRMED'")) {
        newStatus = 'confirmed';
        txnId = params[0] ?? null;
        paymentId = String(params[1] ?? '');
      } else {
        newStatus = params[0];
        paymentId = String(params[1] ?? '');
      }

      const p = this.payments.get(paymentId);
      if (p) {
        p.status = newStatus;
        if (txnId) p.txn_id = txnId;
        if (newStatus === 'confirmed') p.confirmed_at = new Date().toISOString();
        p.updated_at = new Date().toISOString();
        return 1;
      }
      return 0;
    }

    // UPDATE profiles SET plan = ?, tier = ? WHERE id = ?
    if (upper.includes('UPDATE PROFILES') && (upper.includes('TIER =') || upper.includes('PLAN ='))) {
      const planVal = String(params[0] ?? '');
      const tierVal = params.length > 2 ? String(params[1] ?? '') : planVal.toUpperCase();
      const userId = String(params[params.length - 1] ?? '');

      const prof = this.profiles.get(userId);
      if (prof) {
        prof.plan = planVal;
        prof.tier = tierVal;
        prof.updated_at = new Date().toISOString();
        return 1;
      }
      return 0;
    }

    // UPDATE profiles SET wallet_address = ?, preferred_chain = ? WHERE id = ?
    if (upper.includes('UPDATE PROFILES') && upper.includes('WALLET_ADDRESS =')) {
      const wallet = String(params[0] ?? '');
      const chain = String(params[1] ?? 'ethereum');
      const userId = String(params[2] ?? '');

      const prof = this.profiles.get(userId);
      if (prof) {
        prof.wallet_address = wallet;
        prof.preferred_chain = chain;
        prof.updated_at = new Date().toISOString();
        return 1;
      }
      return 0;
    }

    // INSERT INTO tier_activations (id, user_id, payment_id, old_tier, new_tier, activated_by, created_at)
    if (upper.includes('INSERT INTO TIER_ACTIVATIONS')) {
      const id = String(params[0] ?? crypto.randomUUID());
      const userId = String(params[1] ?? '');
      const paymentId = params[2] ? String(params[2]) : null;
      const oldTier = params[3] ? String(params[3]) : null;
      const newTier = String(params[4] ?? 'BASIC');
      const activatedBy = String(params[5] ?? 'ipn');
      const createdAt = new Date().toISOString();

      this.tierActivations.push({
        id,
        user_id: userId,
        payment_id: paymentId,
        old_tier: oldTier,
        new_tier: newTier,
        activated_by: activatedBy,
        created_at: createdAt,
      });
      return 1;
    }

    // INSERT INTO wallet_connections ...
    if (upper.includes('INSERT INTO WALLET_CONNECTIONS')) {
      const id = String(params[0] ?? crypto.randomUUID());
      const profileId = String(params[1] ?? '');
      const walletAddress = String(params[2] ?? '');
      const preferredChain = String(params[3] ?? 'ethereum');
      const isPrimary = Number(params[4] ?? 1);
      const now = new Date().toISOString();

      // Reset previous primary
      if (isPrimary === 1) {
        for (const w of this.walletConnections.values()) {
          if (w.profile_id === profileId) w.is_primary = 0;
        }
      }

      this.walletConnections.set(`${profileId}:${walletAddress}`, {
        id,
        profile_id: profileId,
        wallet_address: walletAddress,
        preferred_chain: preferredChain,
        is_primary: isPrimary,
        connected_at: now,
        last_used_at: now,
      });
      return 1;
    }

    // DELETE FROM wallet_connections WHERE profile_id = ?
    if (upper.includes('DELETE FROM WALLET_CONNECTIONS')) {
      const pid = String(params[0] ?? '');
      let deleted = 0;
      for (const [k, v] of this.walletConnections.entries()) {
        if (v.profile_id === pid) {
          this.walletConnections.delete(k);
          deleted++;
        }
      }
      return deleted;
    }

    // INSERT INTO device_tokens ...
    if (upper.includes('INSERT INTO DEVICE_TOKENS')) {
      const id = String(params[0] ?? crypto.randomUUID());
      const userId = String(params[1] ?? '');
      const expoToken = params[2] ? String(params[2]) : null;
      const platform = String(params[3] ?? 'ios');
      const apnsToken = params[4] ? String(params[4]) : null;
      const fcmToken = params[5] ? String(params[5]) : null;
      const now = new Date().toISOString();

      const key = expoToken ?? apnsToken ?? fcmToken ?? id;
      this.deviceTokens.set(key, {
        id,
        user_id: userId,
        expo_token: expoToken,
        platform,
        apns_token: apnsToken,
        fcm_token: fcmToken,
        created_at: now,
        updated_at: now,
      });
      return 1;
    }

    // DELETE FROM device_tokens WHERE expo_token = ? OR apns_token = ? OR fcm_token = ?
    if (upper.includes('DELETE FROM DEVICE_TOKENS')) {
      const token = String(params[0] ?? '');
      let count = 0;
      for (const [k, v] of this.deviceTokens.entries()) {
        if (v.expo_token === token || v.apns_token === token || v.fcm_token === token || k === token) {
          this.deviceTokens.delete(k);
          count++;
        }
      }
      return count;
    }

    // INSERT INTO deep_link_analytics ...
    if (upper.includes('INSERT INTO DEEP_LINK_ANALYTICS')) {
      const id = String(params[0] ?? crypto.randomUUID());
      const userId = params[1] ? String(params[1]) : null;
      const kind = String(params[2] ?? '');
      const route = String(params[3] ?? '');
      const source = String(params[4] ?? 'direct');
      const eventTimestamp = String(params[5] ?? new Date().toISOString());
      const now = new Date().toISOString();

      this.deepLinkAnalytics.push({
        id,
        user_id: userId,
        kind,
        route,
        source,
        event_timestamp: eventTimestamp,
        metadata: null,
        created_at: now,
      });
      return 1;
    }

    // INSERT INTO email_queue
    if (upper.includes('INSERT INTO EMAIL_QUEUE')) {
      const id = String(params[0] ?? crypto.randomUUID());
      const userId = params[1] ? String(params[1]) : null;
      const email = String(params[2] ?? '');
      const type = String(params[3] ?? '');
      const subject = String(params[4] ?? '');
      const html = String(params[5] ?? '');
      const text = params[6] ? String(params[6]) : null;
      const priority = Number(params[7] ?? 1);
      const status = 'pending';
      const metadata = params[8] ? JSON.stringify(params[8]) : null;
      const now = new Date().toISOString();

      this.emailQueue.push({
        id,
        user_id: userId,
        email,
        type,
        subject,
        html,
        text,
        priority,
        status,
        metadata,
        created_at: now,
        updated_at: now,
      });
      return 1;
    }

    return 1;
  }
}

// Global test singleton instance
export const mockBillingDB = new MockBillingDatabase();

// Injects DB into global scope for routes that access globalThis.DB
(globalThis as any).DB = mockBillingDB;

// ============================================================================
// Cryptographic Helpers (HMAC-SHA512 with recursive key sorting)
// ============================================================================

export function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }
  return Object.keys(obj)
    .sort()
    .reduce((acc: Record<string, any>, key: string) => {
      acc[key] = sortObjectKeys(obj[key]);
      return acc;
    }, {});
}

export function generateIpnSignature(payload: any, secret: string): string {
  const sorted = sortObjectKeys(payload);
  const jsonStr = JSON.stringify(sorted);
  return crypto.createHmac('sha512', secret).update(jsonStr).digest('hex').toLowerCase();
}

// ============================================================================
// Auth & Request Helpers
// ============================================================================

export const DEFAULT_USER = {
  id: 'usr-buyer-001',
  email: 'buyer1@apex-os.com',
  name: 'Apex Tester One',
  tier: 'BASIC',
  plan: 'free',
};

export const SECOND_USER = {
  id: 'usr-buyer-002',
  email: 'buyer2@apex-os.com',
  name: 'Apex Tester Two',
  tier: 'BASIC',
  plan: 'free',
};

export function createTestRequest(
  urlPath: string,
  options: {
    method?: string;
    body?: any;
    user?: { id: string; email?: string } | null;
    authMethod?: 'bearer' | 'cookie' | 'both' | 'none';
    headers?: Record<string, string>;
  } = {}
): NextRequest {
  const fullUrl = urlPath.startsWith('http') ? urlPath : `https://apex-os.com${urlPath}`;
  const method = options.method ?? 'GET';
  const user = options.user === undefined ? DEFAULT_USER : options.user;
  const authMethod = options.authMethod ?? (user ? 'both' : 'none');

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  };

  if (user && authMethod !== 'none') {
    if (authMethod === 'bearer' || authMethod === 'both') {
      headers['authorization'] = `Bearer token-${user.id}`;
    }
    if (authMethod === 'cookie' || authMethod === 'both') {
      headers['cookie'] = `better-auth.session_token=token-${user.id}; session_user_id=${user.id}`;
    }
  }

  const init: any = {
    method,
    headers,
  };

  if (options.body !== undefined) {
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  return new NextRequest(fullUrl, init);
}

// ============================================================================
// Global Mock Environment Setup
// ============================================================================

export interface MockNowPaymentsConfig {
  status?: number;
  response?: any;
  shouldThrow?: boolean;
  throwError?: Error;
}

let mockNowPaymentsConfig: MockNowPaymentsConfig = {
  status: 200,
  response: {
    id: 5000000001,
    payment_id: '5000000001',
    payment_url: 'https://nowpayments.io/payment/?iid=5000000001',
    invoice_url: 'https://nowpayments.io/payment/?iid=5000000001',
    order_id: 'apex-order-001',
    valid_until: '2026-09-25T12:00:00Z',
  },
};

export function configureMockNowPayments(config: Partial<MockNowPaymentsConfig>) {
  mockNowPaymentsConfig = { ...mockNowPaymentsConfig, ...config };
}

export function resetMockNowPayments() {
  mockNowPaymentsConfig = {
    status: 200,
    response: {
      id: 5000000001,
      payment_id: '5000000001',
      payment_url: 'https://nowpayments.io/payment/?iid=5000000001',
      invoice_url: 'https://nowpayments.io/payment/?iid=5000000001',
      order_id: 'apex-order-001',
      valid_until: '2026-09-25T12:00:00Z',
    },
  };
}

export const recordedUpstreamRequests: Array<{ url: string; method: string; headers: any; body: any }> = [];

export function setupBillingTestEnvironment() {
  // Ensure DB binding is in globalThis
  (globalThis as any).DB = mockBillingDB;

  // Intercept global fetch for /api/auth/session and NOWPayments API
  const originalFetch = globalThis.fetch;
  globalThis.fetch = jest.fn(async (input: any, init?: any) => {
    const urlStr = typeof input === 'string' ? input : input?.url ?? String(input);

    // 1. Auth session sub-request
    if (urlStr.includes('/api/auth/session')) {
      const headers = init?.headers ?? {};
      const cookieStr = headers['cookie'] ?? headers['Cookie'] ?? '';
      const authHeader = headers['authorization'] ?? headers['Authorization'] ?? '';

      let userId: string | null = null;
      let email: string = 'test@apex-os.com';

      if (cookieStr.includes('token-')) {
        const match = cookieStr.match(/token-([^;]+)/);
        userId = match ? match[1] : DEFAULT_USER.id;
      } else if (authHeader.includes('Bearer token-')) {
        const match = authHeader.match(/Bearer token-([^\s]+)/);
        userId = match ? match[1] : DEFAULT_USER.id;
      }

      if (userId) {
        const prof = mockBillingDB.profiles.get(userId);
        if (prof) email = prof.email;
        return new Response(JSON.stringify({ user: { id: userId, email } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ user: null }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 2. NOWPayments upstream API
    if (urlStr.includes('api.nowpayments.io')) {
      if (mockNowPaymentsConfig.shouldThrow) {
        throw mockNowPaymentsConfig.throwError ?? new Error('NOWPayments network timeout');
      }

      let parsedBody: any = null;
      try {
        parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      } catch {
        parsedBody = init?.body;
      }

      recordedUpstreamRequests.push({
        url: urlStr,
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
        body: parsedBody,
      });

      return new Response(JSON.stringify(mockNowPaymentsConfig.response), {
        status: mockNowPaymentsConfig.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Fallback to original fetch if needed
    if (typeof originalFetch === 'function') {
      return originalFetch(input, init);
    }

    return new Response('{}', { status: 200 });
  }) as any;
}

// ============================================================================
// Dynamic Route Dispatcher
// ============================================================================

export interface RouteInvocationResult {
  status: number;
  data?: any;
  error?: string;
  implemented: boolean;
  rawResponse?: Response;
}

export async function dispatchRoute(
  routeRelativePath: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  request: NextRequest
): Promise<RouteInvocationResult> {
  const fullPath = path.resolve(process.cwd(), routeRelativePath);

  if (!fs.existsSync(fullPath)) {
    return {
      status: 501,
      implemented: false,
      error: `Route not implemented: ${routeRelativePath}`,
    };
  }

  const moduleAlias = routeRelativePath.replace(/^src\//, '@/').replace(/\.tsx?$/, '');

  try {
    const routeModule = await import(moduleAlias);
    const handler = routeModule[method];

    if (typeof handler !== 'function') {
      return {
        status: 405,
        implemented: false,
        error: `Method ${method} not exported from ${routeRelativePath}`,
      };
    }

    const response = await handler(request);
    let data: any = null;
    try {
      data = await response.json();
    } catch {
      // Body may not be JSON
    }

    return {
      status: response.status ?? 200,
      data,
      error: data?.error,
      implemented: true,
      rawResponse: response,
    };
  } catch (err: any) {
    return {
      status: 500,
      implemented: true,
      error: err?.message ?? 'Internal Handler Exception',
    };
  }
}
