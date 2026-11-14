import * as nodeCrypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import type {
  D1Database,
  D1ExecResult,
  D1PreparedStatement,
  D1QueryResult,
  D1Result,
} from '@/lib/auth/adapters/d1-adapter';
import {
  BinanceStandardBlockedAdapter,
  BitgetBrokerAdapter,
  buildBitgetPartnerSignedHeaders,
  buildBybitAffiliateSignedHeaders,
  buildOkxPartnerSignedHeaders,
  BybitAffiliateAdapter,
  ForbiddenPartnerEndpointError,
  getPartnerAdapter,
  listAllPartnerAdapters,
  OkxAffiliateAdapter,
  parseOkxStatementCsv,
  PartnerIntegrationBlockedError,
  PartnerPayloadValidationError,
} from '@/lib/partners';
import { GET as shortLinkRedirectGET } from '@/app/r/[code]/route';
import {
  AnalyticsEngineDataset,
  ShortLinkKVNamespace,
  validatePartnerDestinationUrl,
} from '@/lib/shortener/short-link-service';

function sha256Node(raw: string): string {
  return nodeCrypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function createSqliteD1Adapter(sqlite: Database.Database): D1Database {
  const makeStatement = (sql: string, boundValues: unknown[] = []): D1PreparedStatement => ({
    bind(...values: unknown[]): D1PreparedStatement {
      return makeStatement(sql, values);
    },
    async first<T = unknown>(): Promise<T | undefined> {
      const stmt = sqlite.prepare(sql);
      return stmt.get(...boundValues) as T | undefined;
    },
    async all<T = unknown>(): Promise<D1QueryResult<T>> {
      const stmt = sqlite.prepare(sql);
      const results = stmt.all(...boundValues) as T[];
      return {
        results,
        meta: { last_row_id: 0, rows_written: 0, changes: 0, duration: 0 },
      };
    },
    async run(): Promise<D1ExecResult> {
      const stmt = sqlite.prepare(sql);
      const info = stmt.run(...boundValues);
      return {
        success: true,
        meta: {
          last_row_id: Number(info.lastInsertRowid ?? 0),
          rows_written: info.changes,
          changes: info.changes,
          duration: 0,
        },
      };
    },
    async *raw<T = unknown>(): AsyncIterable<T> {
      const stmt = sqlite.prepare(sql).raw(true);
      const rows = stmt.all(...boundValues) as T[];
      for (const row of rows) {
        yield row;
      }
    },
  });

  return {
    prepare(query: string): D1PreparedStatement {
      return makeStatement(query);
    },
    async exec(sql: string): Promise<D1ExecResult> {
      sqlite.exec(sql);
      return {
        success: true,
        meta: { last_row_id: 0, rows_written: 0, changes: 0, duration: 0 },
      };
    },
    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      const out: D1Result[] = [];
      for (const stmt of statements) {
        const res = await stmt.run();
        out.push({ success: res.success, meta: res.meta, changes: res.meta.changes });
      }
      return out;
    },
    async dump(): Promise<string> {
      return '';
    },
  };
}

class MemoryShortLinkKV implements ShortLinkKVNamespace {
  public readonly store = new Map<string, { value: string; expirationTtl?: number }>();
  public getCalls = 0;
  public putCalls = 0;

  public async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    return this.store.get(key)?.value ?? null;
  }

  public async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void> {
    this.putCalls += 1;
    this.store.set(key, { value, expirationTtl: options?.expirationTtl });
  }
}

describe('Gate G1: Official Partner Ingestion Contracts, Binance Block & Clean-Room /r/[code]', () => {
  describe('1. Capability-Aware Boundary Invariants', () => {
    it('asserts requiresUserTradeApiKey === false and usesWebScraping === false across all partner adapters', () => {
      const adapters = listAllPartnerAdapters();
      expect(adapters.length).toBe(4);

      for (const adapter of adapters) {
        expect(adapter.capabilities.requiresUserTradeApiKey).toBe(false);
        expect(adapter.capabilities.usesWebScraping).toBe(false);
      }

      expect(getPartnerAdapter('bybit').status).toBe('ACTIVE');
      expect(getPartnerAdapter('okx').status).toBe('ACTIVE');
      expect(getPartnerAdapter('bitget').status).toBe('ACTIVE');
      expect(getPartnerAdapter('binance_referral_pro').status).toBe('BLOCKED');
      expect(getPartnerAdapter('binance').status).toBe('BLOCKED');
    });

    it('hard-blocks Binance Standard Referral Pro on pollCommissions() and parsePayload()', async () => {
      const binance = new BinanceStandardBlockedAdapter();
      expect(binance.exchange).toBe('binance_referral_pro');
      expect(binance.status).toBe('BLOCKED');
      expect(binance.capabilities.supportsRestPolling).toBe(false);
      expect(binance.capabilities.supportsCsvImport).toBe(false);

      await expect(
        binance.pollCommissions({
          credentials: { apiKey: 'test-key', apiSecret: 'test-secret' },
        })
      ).rejects.toThrow(PartnerIntegrationBlockedError);

      try {
        await binance.pollCommissions({
          credentials: { apiKey: 'test-key', apiSecret: 'test-secret' },
        });
      } catch (err) {
        expect(err).toBeInstanceOf(PartnerIntegrationBlockedError);
        const typed = err as PartnerIntegrationBlockedError;
        expect(typed.code).toBe('BINANCE_REFERRAL_PRO_UID_UNAVAILABLE');
        expect(typed.message).toContain('/sapi/v1/rebate/taxQuery');
        expect(typed.message).toContain('12000');
        expect(typed.message).toContain('/sapi/v1/broker/*');
      }

      await expect(binance.parsePayload('{"data":[]}')).rejects.toMatchObject({
        code: 'BINANCE_REFERRAL_PRO_UID_UNAVAILABLE',
      });
    });
  });

  describe('2. Bybit Affiliate API v5 Adapter (/v5/affiliate/aff-user-list)', () => {
    const bybitFixture = JSON.stringify({
      retCode: 0,
      retMsg: 'OK',
      time: 1794691200000,
      result: {
        nextPageCursor: 'cursor_page_2',
        list: [
          {
            userId: '88192011',
            subAffiliateCode: 'APEXVIP',
            coin: 'USDT',
            netCommission: '42.12500000',
            takerVol365Day: '125000.50',
            recordId: 'byb-rec-9001',
            timestamp: '1794691100000',
          },
          {
            userId: '88192012',
            subAffiliateCode: null,
            coin: 'USDC',
            commissions: '-3.50000000',
            tradeVol: '15000.00',
            recordId: 'byb-rec-9002',
            timestamp: '1794691150000',
          },
        ],
      },
    });

    it('signs /v5/affiliate/aff-user-list with HMAC-SHA256 BAPI headers and parses net commissions + clawbacks + SHA-256 digest', async () => {
      const adapter = new BybitAffiliateAdapter();
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};

      const fakeFetch: typeof fetch = async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(bybitFixture, { status: 200 });
      };

      const fixedNow = 1794691200000;
      const result = await adapter.pollCommissions({
        credentials: {
          apiKey: 'bybit_aff_key_01',
          apiSecret: 'bybit_aff_secret_01',
          recvWindowMs: 5000,
        },
        limit: 50,
        cursor: 'cursor_page_1',
        nowMs: fixedNow,
        fetchImpl: fakeFetch,
      });

      expect(capturedUrl).toBe(
        'https://api.bybit.com/v5/affiliate/aff-user-list?size=50&cursor=cursor_page_1'
      );

      const expectedHeaders = await buildBybitAffiliateSignedHeaders({
        apiKey: 'bybit_aff_key_01',
        apiSecret: 'bybit_aff_secret_01',
        queryString: 'size=50&cursor=cursor_page_1',
        timestampMs: fixedNow,
        recvWindowMs: 5000,
      });
      expect(capturedHeaders['X-BAPI-API-KEY']).toBe('bybit_aff_key_01');
      expect(capturedHeaders['X-BAPI-SIGN']).toBe(expectedHeaders['X-BAPI-SIGN']);
      expect(capturedHeaders['X-BAPI-TIMESTAMP']).toBe(String(fixedNow));
      expect(capturedHeaders['X-BAPI-RECV-WINDOW']).toBe('5000');

      expect(result.evidence.payloadSha256).toBe(sha256Node(bybitFixture));
      expect(result.evidence.byteLength).toBe(Buffer.byteLength(bybitFixture, 'utf8'));
      expect(result.evidence.sourceKind).toBe('rest_poll');
      expect(result.nextCursor).toBe('cursor_page_2');
      expect(result.rows).toHaveLength(2);

      expect(result.rows[0]).toEqual({
        exchange: 'bybit',
        traderUid: '88192011',
        subAffiliateCode: 'APEXVIP',
        commissionAsset: 'USDT',
        netCommissionDecimal: '42.125',
        isClawbackOrAdjustment: false,
        signedUnits1e8: BigInt(4212500000),
        tradeVolumeDecimal: '125000.5',
        eventTimestampIso: new Date(1794691100000).toISOString(),
        externalRecordId: 'bybit:byb-rec-9001',
      });

      expect(result.rows[1].isClawbackOrAdjustment).toBe(true);
      expect(result.rows[1].signedUnits1e8).toBe(BigInt(-350000000));
      expect(result.rows[1].commissionAsset).toBe('USDC');
    });

    it('forbids personal trade endpoint /v5/execution/list on Bybit adapter', async () => {
      const adapter = new BybitAffiliateAdapter();
      await expect(
        adapter.pollCommissions({
          credentials: { apiKey: 'k', apiSecret: 's' },
          endpointPath: '/v5/execution/list',
        })
      ).rejects.toThrow(ForbiddenPartnerEndpointError);
    });
  });

  describe('3. OKX Affiliate / FD Broker v5 Adapter & Deterministic CSV Parser', () => {
    const okxJsonFixture = JSON.stringify({
      code: '0',
      msg: '',
      data: [
        {
          page: '1',
          totalPage: '3',
          details: [
            {
              uid: '55100991',
              inviterCode: 'OKXPRO',
              ccy: 'USDT',
              rebate: '18.75000000',
              vol: '54000.25',
              billId: 'okx-bill-101',
              ts: '1794690000000',
            },
          ],
        },
      ],
    });

    const okxCsvFixture = [
      'uid,subAffiliateCode,ccy,rebate,vol,billId,ts',
      '"55100991","OKXPRO","USDT","19.25000000","61000.00","csv-bill-1","1794690100000"',
      '"55100992","OKX_SUB,TEAM","USDT","-4.12500000","12000.00","csv-bill-2","1794690200000"',
      '"55100993","","USDC","0.00000000","500.00","csv-bill-3","1794690300000"',
    ].join('\r\n');

    it('signs /api/v5/affiliate/invitee/detail with Base64 OK-ACCESS-SIGN and parses invitee details', async () => {
      const adapter = new OkxAffiliateAdapter();
      let capturedHeaders: Record<string, string> = {};

      const fakeFetch: typeof fetch = async (_input, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(okxJsonFixture, { status: 200 });
      };

      const fixedNow = 1794691200000;
      const fixedIso = new Date(fixedNow).toISOString();
      const result = await adapter.pollCommissions({
        credentials: {
          apiKey: 'okx_partner_key',
          apiSecret: 'okx_partner_secret',
          passphrase: 'okx_partner_passphrase',
        },
        limit: 20,
        nowMs: fixedNow,
        fetchImpl: fakeFetch,
      });

      const expectedHeaders = await buildOkxPartnerSignedHeaders({
        apiKey: 'okx_partner_key',
        apiSecret: 'okx_partner_secret',
        passphrase: 'okx_partner_passphrase',
        method: 'GET',
        requestPathWithQuery: '/api/v5/affiliate/invitee/detail?limit=20',
        timestampIso: fixedIso,
      });

      expect(capturedHeaders['OK-ACCESS-KEY']).toBe('okx_partner_key');
      expect(capturedHeaders['OK-ACCESS-SIGN']).toBe(expectedHeaders['OK-ACCESS-SIGN']);
      expect(capturedHeaders['OK-ACCESS-TIMESTAMP']).toBe(fixedIso);
      expect(capturedHeaders['OK-ACCESS-PASSPHRASE']).toBe('okx_partner_passphrase');

      expect(result.evidence.payloadSha256).toBe(sha256Node(okxJsonFixture));
      expect(result.nextCursor).toBe('2');
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].signedUnits1e8).toBe(BigInt(1875000000));
      expect(result.rows[0].externalRecordId).toBe('okx:okx-bill-101');
    });

    it('parses OKX FD Broker CSV statements with quoted fields, negative maker clawbacks, and SHA-256 hash', async () => {
      const csvBatch = await parseOkxStatementCsv(okxCsvFixture);

      expect(csvBatch.evidence.sourceKind).toBe('csv_statement');
      expect(csvBatch.evidence.payloadSha256).toBe(sha256Node(okxCsvFixture));
      expect(csvBatch.rows).toHaveLength(3);

      expect(csvBatch.rows[0]).toMatchObject({
        exchange: 'okx',
        traderUid: '55100991',
        subAffiliateCode: 'OKXPRO',
        commissionAsset: 'USDT',
        netCommissionDecimal: '19.25',
        isClawbackOrAdjustment: false,
        signedUnits1e8: BigInt(1925000000),
        externalRecordId: 'okx:csv:csv-bill-1',
      });

      expect(csvBatch.rows[1]).toMatchObject({
        traderUid: '55100992',
        subAffiliateCode: 'OKX_SUB,TEAM',
        netCommissionDecimal: '-4.125',
        isClawbackOrAdjustment: true,
        signedUnits1e8: BigInt(-412500000),
        externalRecordId: 'okx:csv:csv-bill-2',
      });

      expect(csvBatch.rows[2]).toMatchObject({
        traderUid: '55100993',
        subAffiliateCode: null,
        commissionAsset: 'USDC',
        netCommissionDecimal: '0',
        isClawbackOrAdjustment: true,
        signedUnits1e8: BigInt(0),
        externalRecordId: 'okx:csv:csv-bill-3',
      });
    });

    it('rejects malformed OKX CSV headers missing uid or rebate columns', async () => {
      await expect(parseOkxStatementCsv('foo,bar,baz\n1,2,3')).rejects.toThrow(
        PartnerPayloadValidationError
      );
    });
  });

  describe('4. Bitget Broker/Agent API v2 Adapter (/api/v2/broker/customer-commissions)', () => {
    const bitgetFixture = JSON.stringify({
      code: '00000',
      msg: 'success',
      requestTime: 1794691200000,
      data: {
        endId: 'bg_cursor_99',
        list: [
          {
            uid: '77001122',
            channelCode: 'BG_APEX',
            coin: 'USDT',
            commission: '11.00000005',
            tradeVol: '30000',
            tradeId: 'bg-tr-501',
            cTime: '1794691000000',
          },
        ],
      },
    });

    it('signs /api/v2/broker/customer-commissions with ACCESS-* headers and parses commission rows', async () => {
      const adapter = new BitgetBrokerAdapter();
      let capturedHeaders: Record<string, string> = {};

      const fakeFetch: typeof fetch = async (_input, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(bitgetFixture, { status: 200 });
      };

      const fixedNow = 1794691200000;
      const result = await adapter.pollCommissions({
        credentials: {
          apiKey: 'bg_key',
          apiSecret: 'bg_secret',
          passphrase: 'bg_pass',
        },
        limit: 100,
        nowMs: fixedNow,
        fetchImpl: fakeFetch,
      });

      const expectedHeaders = await buildBitgetPartnerSignedHeaders({
        apiKey: 'bg_key',
        apiSecret: 'bg_secret',
        passphrase: 'bg_pass',
        method: 'GET',
        endpointPath: '/api/v2/broker/customer-commissions',
        queryString: 'limit=100',
        timestampMs: fixedNow,
      });

      expect(capturedHeaders['ACCESS-KEY']).toBe('bg_key');
      expect(capturedHeaders['ACCESS-SIGN']).toBe(expectedHeaders['ACCESS-SIGN']);
      expect(result.evidence.payloadSha256).toBe(sha256Node(bitgetFixture));
      expect(result.nextCursor).toBe('bg_cursor_99');
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        exchange: 'bitget',
        traderUid: '77001122',
        subAffiliateCode: 'BG_APEX',
        commissionAsset: 'USDT',
        netCommissionDecimal: '11.00000005',
        isClawbackOrAdjustment: false,
        signedUnits1e8: BigInt(1100000005),
        externalRecordId: 'bitget:bg-tr-501',
      });
    });

    it('forbids personal trade endpoints on Bitget adapter', async () => {
      const adapter = new BitgetBrokerAdapter();
      await expect(
        adapter.pollCommissions({
          credentials: { apiKey: 'bg_key', apiSecret: 'bg_secret', passphrase: 'p' },
          endpointPath: '/api/v2/spot/trade/fills',
        })
      ).rejects.toThrow(ForbiddenPartnerEndpointError);
    });
  });

  describe('5. Clean-Room /r/[code] Shortener, KV Cache, Cookie Security & Open-Redirect Defense', () => {
    let sqlite: Database.Database;
    let d1: D1Database;
    let kv: MemoryShortLinkKV;
    let analyticsPoints: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }>;

    const migration001Path = path.resolve(
      process.cwd(),
      'src/database/migrations/001_initial_schema_d1.sql'
    );
    const migration003Path = path.resolve(
      process.cwd(),
      'src/database/migrations/003_affiliate_schema.sql'
    );
    const migration028Path = path.resolve(
      process.cwd(),
      'src/database/migrations/028_ascendancy_audit_core.sql'
    );

    beforeEach(() => {
      sqlite = new Database(':memory:');
      sqlite.pragma('foreign_keys = ON');
      sqlite.exec(fs.readFileSync(migration001Path, 'utf8'));
      sqlite.exec(fs.readFileSync(migration003Path, 'utf8'));
      sqlite.exec(fs.readFileSync(migration028Path, 'utf8'));

      sqlite
        .prepare(`INSERT INTO profiles (id, email, role) VALUES (?, ?, ?)`)
        .run('aff-user-1', 'affiliate@apex.test', 'affiliate');
      sqlite
        .prepare(`INSERT INTO deals (id, name, url, created_by) VALUES (?, ?, ?, ?)`)
        .run('deal-bybit-1', 'Bybit VIP Rebate', 'https://partner.bybit.com/b/apex', 'aff-user-1');

      d1 = createSqliteD1Adapter(sqlite);
      kv = new MemoryShortLinkKV();
      analyticsPoints = [];

      const analyticsEngine: AnalyticsEngineDataset = {
        writeDataPoint(event) {
          analyticsPoints.push(event);
        },
      };

      const globals = globalThis as unknown as {
        DB?: D1Database;
        SHORT_LINKS_KV?: ShortLinkKVNamespace;
        ANALYTICS_ENGINE?: AnalyticsEngineDataset;
      };
      globals.DB = d1;
      globals.SHORT_LINKS_KV = kv;
      globals.ANALYTICS_ENGINE = analyticsEngine;
    });

    afterEach(() => {
      const globals = globalThis as unknown as {
        DB?: D1Database;
        SHORT_LINKS_KV?: ShortLinkKVNamespace;
        ANALYTICS_ENGINE?: AnalyticsEngineDataset;
      };
      delete globals.DB;
      delete globals.SHORT_LINKS_KV;
      delete globals.ANALYTICS_ENGINE;
      sqlite.close();
    });

    it('redirects valid /r/[code] with 302, strict cookie flags, KV caching (300s TTL), SHA-256 IP/UA anonymization, and R2 evidence table compatibility', async () => {
      sqlite
        .prepare(
          `INSERT INTO short_links (code, affiliate_id, deal_id, exchange, destination_url, campaign_tag, is_active)
           VALUES (?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          'bybit_vip1',
          'aff-user-1',
          'deal-bybit-1',
          'bybit',
          'https://partner.bybit.com/b/apex_vip1',
          'q4-launch'
        );

      const rawIp = '203.0.113.42';
      const rawUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)';
      const req1 = new Request('https://apex-os.test/r/bybit_vip1', {
        method: 'GET',
        headers: {
          'cf-connecting-ip': rawIp,
          'user-agent': rawUa,
          'cf-ipcountry': 'SG',
        },
      }) as unknown as NextRequest;

      const res1 = await shortLinkRedirectGET(req1, {
        params: Promise.resolve({ code: 'bybit_vip1' }),
      });

      expect(res1.status).toBe(302);
      expect(res1.headers.get('location')).toBe('https://partner.bybit.com/b/apex_vip1');
      expect(res1.headers.get('cache-control')).toBe('private, no-store');

      const setCookie = res1.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('apex_ref=bybit_vip1');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Max-Age=2592000');

      const cachedEntry = kv.store.get('shortlink:bybit_vip1');
      expect(cachedEntry).toBeDefined();
      expect(cachedEntry?.expirationTtl).toBe(300);
      expect(kv.putCalls).toBe(1);

      // Second request hits KV cache without re-putting into KV
      const req2 = new Request('https://apex-os.test/r/bybit_vip1', {
        method: 'GET',
        headers: {
          'cf-connecting-ip': rawIp,
          'user-agent': rawUa,
          'cf-ipcountry': 'SG',
        },
      }) as unknown as NextRequest;
      const res2 = await shortLinkRedirectGET(req2, {
        params: Promise.resolve({ code: 'bybit_vip1' }),
      });
      expect(res2.status).toBe(302);
      expect(kv.putCalls).toBe(1);
      expect(kv.getCalls).toBe(2);

      const linkRow = sqlite
        .prepare('SELECT click_count FROM short_links WHERE code = ?')
        .get('bybit_vip1') as { click_count: number };
      expect(linkRow.click_count).toBe(2);

      const clickRows = sqlite
        .prepare('SELECT ip_hash, ua_hash, country_code FROM short_link_clicks WHERE code = ?')
        .all('bybit_vip1') as Array<{ ip_hash: string; ua_hash: string; country_code: string }>;
      expect(clickRows).toHaveLength(2);
      expect(clickRows[0].ip_hash).toBe(sha256Node(rawIp));
      expect(clickRows[0].ip_hash).not.toBe(rawIp);
      expect(clickRows[0].ua_hash).toBe(sha256Node(rawUa));
      expect(clickRows[0].country_code).toBe('SG');

      expect(analyticsPoints).toHaveLength(2);
      expect(analyticsPoints[0].blobs).toContain(sha256Node(rawIp));
      expect(JSON.stringify(analyticsPoints[0])).not.toContain(rawIp);
    });

    it('strictly blocks open redirects, non-HTTPS schemes, credentialed URLs, and invalid short codes', async () => {
      expect(validatePartnerDestinationUrl('https://www.okx.com/join/APEX')).not.toBeNull();
      expect(validatePartnerDestinationUrl('https://partner.bitget.com/bg/APEX')).not.toBeNull();
      expect(validatePartnerDestinationUrl('https://www.kucoin.com/r/APEX')).not.toBeNull();
      expect(validatePartnerDestinationUrl('https://www.gate.io/signup/APEX')).not.toBeNull();

      expect(validatePartnerDestinationUrl('http://www.bybit.com/invite')).toBeNull();
      expect(validatePartnerDestinationUrl('https://evil.attacker.com/phish')).toBeNull();
      expect(validatePartnerDestinationUrl('https://bybit.com.attacker.com/phish')).toBeNull();
      expect(validatePartnerDestinationUrl('https://evilbybit.com/phish')).toBeNull();
      expect(validatePartnerDestinationUrl('https://bybit.com@attacker.com/phish')).toBeNull();
      expect(validatePartnerDestinationUrl('javascript:alert(1)')).toBeNull();

      // Seed a tampered row pointing to an unallowlisted domain
      sqlite
        .prepare(
          `INSERT INTO short_links (code, affiliate_id, deal_id, exchange, destination_url, is_active)
           VALUES (?, ?, ?, ?, ?, 1)`
        )
        .run('evil_link', 'aff-user-1', 'deal-bybit-1', 'bybit', 'https://phishing.evil.example/steal');

      const evilReq = new Request('https://apex-os.test/r/evil_link', {
        method: 'GET',
      }) as unknown as NextRequest;
      const evilRes = await shortLinkRedirectGET(evilReq, {
        params: Promise.resolve({ code: 'evil_link' }),
      });
      expect(evilRes.status).toBe(403);
      expect(evilRes.headers.get('location')).toBeNull();

      // Invalid short code (<4 chars or illegal characters)
      const badCodeReq = new Request('https://apex-os.test/r/ab', {
        method: 'GET',
      }) as unknown as NextRequest;
      const badCodeRes = await shortLinkRedirectGET(badCodeReq, {
        params: Promise.resolve({ code: 'ab' }),
      });
      expect(badCodeRes.status).toBe(400);

      // Unknown valid code -> 404
      const missingReq = new Request('https://apex-os.test/r/missing_code1', {
        method: 'GET',
      }) as unknown as NextRequest;
      const missingRes = await shortLinkRedirectGET(missingReq, {
        params: Promise.resolve({ code: 'missing_code1' }),
      });
      expect(missingRes.status).toBe(404);
    });
  });
});
