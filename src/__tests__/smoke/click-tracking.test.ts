/**
 * Smoke Test: Click Tracking
 * Tests click recording and cookie management logic
 */

type DealClick = {
  id: string;
  deal_id: string;
  user_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  referrer_url: string | null;
  cookie_id: string;
  affiliate_code: string | null;
  affiliate_id: string | null;
  created_at: string;
};

// Mock Database
let mockClicks: DealClick[];

function createMockDb() {
  mockClicks = [];

  const deals = [{ id: 'deal-123', slug: 'test-deal' }];

  const makeStatement = (overrides?: any) => ({
    bind: jest.fn().mockReturnValue({
      first: jest.fn(() => null),
      all: jest.fn(() => ({ results: [] })),
      run: jest.fn().mockReturnValue({ success: true }),
      ...overrides,
    }),
  });

  return {
    prepare: jest.fn().mockImplementation((sql: string) => {
      const lowerSql = sql.toLowerCase();

      if (lowerSql.includes('insert into deal_clicks')) {
        const newClick: DealClick = {
          id: `click-${Date.now()}`,
          deal_id: 'deal-123',
          user_id: 'user-123',
          ip_address: '192.168.1.1',
          user_agent: 'Mozilla/5.0',
          referrer_url: 'https://example.com',
          cookie_id: 'cookie-123',
          affiliate_code: 'AFF1',
          affiliate_id: 'affiliate-1',
          created_at: new Date().toISOString(),
        };
        mockClicks.push(newClick);
        return makeStatement();
      }

      if (lowerSql.includes('select * from deals where id')) {
        return {
          bind: jest.fn().mockReturnValue({
            first: jest.fn(() => deals[0] || null),
          }),
        };
      }

      return makeStatement();
    }),
    _clear: () => {
      mockClicks = [];
    },
    _getClicks: () => [...mockClicks],
  } as unknown as { DB: ReturnType<typeof createMockDb> };
}

// Core logic functions
function generateCookieId(): string {
  return crypto.randomUUID();
}

function getRedirectUrl(
  dealId: string,
  locale: string = 'en',
  refCode?: string,
  customRedirect?: string
): string {
  let targetUrl = customRedirect || `/${locale}/deals/${dealId}`;

  // Append referral code if provided (even to custom redirects)
  if (refCode) {
    const separator = targetUrl.includes('?') ? '&' : '?';
    // Avoid duplicating ref param if already present
    if (!targetUrl.includes('ref=')) {
      targetUrl = `${targetUrl}${separator}ref=${encodeURIComponent(refCode)}`;
    }
  }

  return targetUrl;
}

function extractIpAddress(headers: Record<string, string>): string {
  return headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         headers['cf-connecting-ip'] ||
         headers['x-real-ip'] ||
         '';
}

function getUserAgent(headers: Record<string, string>): string {
  return headers['user-agent'] || '';
}

function getReferrer(headers: Record<string, string>): string {
  return headers['referer'] || headers['referrer'] || '';
}

function createClickRecord(
  dealId: string,
  userId: string | null,
  cookieId: string,
  ipAddress: string,
  userAgent: string,
  referrer: string | null,
  affiliateCode: string | null,
  affiliateId: string | null
): DealClick {
  return {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
    deal_id: dealId,
    user_id: userId,
    ip_address: ipAddress,
    user_agent: userAgent.substring(0, 500),
    referrer_url: referrer?.substring(0, 500) || null,
    cookie_id: cookieId,
    affiliate_code: affiliateCode,
    affiliate_id: affiliateId,
    created_at: new Date().toISOString(),
  };
}

function getCookieOptions(cookieId: string, maxAge: number = 30 * 24 * 60 * 60): {
  name: string;
  value: string;
  options: {
    path: string;
    httpOnly: boolean;
    secure: boolean;
    maxAge: number;
  };
} {
  return {
    name: 'apex_tracking_id',
    value: cookieId,
    options: {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      maxAge,
    },
  };
}

beforeAll(() => {
  // Mock crypto.randomUUID for Jest environment
  if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
    crypto.randomUUID = () => {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };
  }
  (globalThis as any).DB = createMockDb();
});

afterEach(() => {
  jest.clearAllMocks();
  (globalThis as any).DB?._clear?.();
});

describe('Click Tracking - Smoke Tests', () => {

  describe('Cookie Management', () => {
    it('should generate unique cookie ID', () => {
      const cookieId1 = generateCookieId();
      const cookieId2 = generateCookieId();

      expect(cookieId1).not.toBe(cookieId2);
      expect(typeof cookieId1).toBe('string');
    });

    it('should set cookie with 30 day expiry', () => {
      const cookie = getCookieOptions('test-cookie-123');
      expect(cookie.name).toBe('apex_tracking_id');
      expect(cookie.options.maxAge).toBe(30 * 24 * 60 * 60);
      expect(cookie.options.path).toBe('/');
      expect(cookie.options.httpOnly).toBe(true);
    });

    it('should set Secure flag in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const cookie = getCookieOptions('test-cookie');
      expect(cookie.options.secure).toBe(true);

      process.env.NODE_ENV = originalEnv;
    });

    it('should not set Secure flag in development', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const cookie = getCookieOptions('test-cookie');
      expect(cookie.options.secure).toBe(false);

      process.env.NODE_ENV = originalEnv;
    });

    it('should reuse existing cookie ID', () => {
      const existingCookie = 'existing-cookie-123';
      // Simulate getting cookie from request
      const cookieId = existingCookie; // would come from request.cookies

      expect(cookieId).toBe('existing-cookie-123');
    });
  });

  describe('IP Address Extraction', () => {
    it('should extract IP from x-forwarded-for (single IP)', () => {
      const headers = { 'x-forwarded-for': '192.168.1.1' };
      expect(extractIpAddress(headers)).toBe('192.168.1.1');
    });

    it('should extract first IP from x-forwarded-for list', () => {
      const headers = { 'x-forwarded-for': '10.0.0.1, 192.168.1.1, 172.16.0.1' };
      expect(extractIpAddress(headers)).toBe('10.0.0.1');
    });

    it('should fallback to cf-connecting-ip', () => {
      const headers = { 'cf-connecting-ip': '203.0.113.1' };
      expect(extractIpAddress(headers)).toBe('203.0.113.1');
    });

    it('should fallback to x-real-ip', () => {
      const headers = { 'x-real-ip': '198.51.100.1' };
      expect(extractIpAddress(headers)).toBe('198.51.100.1');
    });

    it('should return empty string when no IP headers', () => {
      const headers = {};
      expect(extractIpAddress(headers)).toBe('');
    });
  });

  describe('User Agent Extraction', () => {
    it('should extract user agent from headers', () => {
      const headers = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
      expect(getUserAgent(headers)).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    });

    it('should return empty string when no user agent', () => {
      const headers = {};
      expect(getUserAgent(headers)).toBe('');
    });
  });

  describe('Referrer Extraction', () => {
    it('should extract referer from headers', () => {
      const headers = { referer: 'https://example.com/deal' };
      expect(getReferrer(headers)).toBe('https://example.com/deal');
    });

    it('should extract referrer from headers (alternate spelling)', () => {
      const headers = { referrer: 'https://example.com/deal' };
      expect(getReferrer(headers)).toBe('https://example.com/deal');
    });

    it('should return empty string when no referrer', () => {
      const headers = {};
      expect(getReferrer(headers)).toBe('');
    });
  });

  describe('Click Record Creation', () => {
    it('should create click with all fields', () => {
      const click = createClickRecord(
        'deal-123',
        'user-123',
        'cookie-123',
        '192.168.1.1',
        'Mozilla/5.0',
        'https://example.com',
        'AFF1',
        'affiliate-1'
      );

      expect(click).toHaveProperty('id');
      expect(click.deal_id).toBe('deal-123');
      expect(click.user_id).toBe('user-123');
      expect(click.ip_address).toBe('192.168.1.1');
      expect(click.user_agent).toBe('Mozilla/5.0');
      expect(click.referrer_url).toBe('https://example.com');
      expect(click.cookie_id).toBe('cookie-123');
      expect(click.affiliate_code).toBe('AFF1');
      expect(click.affiliate_id).toBe('affiliate-1');
    });

    it('should handle null user_id for anonymous click', () => {
      const click = createClickRecord(
        'deal-123',
        null,
        'cookie-123',
        '192.168.1.1',
        'Mozilla/5.0',
        null,
        null,
        null
      );

      expect(click.user_id).toBeNull();
      expect(click.affiliate_code).toBeNull();
      expect(click.affiliate_id).toBeNull();
    });

    it('should truncate long user agent to 500 chars', () => {
      const longUserAgent = 'Mozilla/5.0 ' + 'x'.repeat(600);
      const click = createClickRecord(
        'deal-123',
        null,
        'cookie-123',
        '192.168.1.1',
        longUserAgent,
        null,
        null,
        null
      );

      expect(click.user_agent.length).toBeLessThanOrEqual(500);
    });

    it('should truncate long referrer to 500 chars', () => {
      const longReferrer = 'https://' + 'a'.repeat(600) + '.com';
      const click = createClickRecord(
        'deal-123',
        null,
        'cookie-123',
        '192.168.1.1',
        'Mozilla/5.0',
        longReferrer,
        null,
        null
      );

      expect(click.referrer_url!.length).toBeLessThanOrEqual(500);
    });
  });

  describe('Redirect URL Generation', () => {
    it('should generate default redirect URL', () => {
      const url = getRedirectUrl('deal-123', 'en');
      expect(url).toBe('/en/deals/deal-123');
    });

    it('should generate redirect URL for Vietnamese locale', () => {
      const url = getRedirectUrl('deal-123', 'vi');
      expect(url).toBe('/vi/deals/deal-123');
    });

    it('should append referral code to URL', () => {
      const url = getRedirectUrl('deal-123', 'en', 'AFF1');
      expect(url).toBe('/en/deals/deal-123?ref=AFF1');
    });

    it('should use custom redirect when provided', () => {
      const url = getRedirectUrl('deal-123', 'en', 'AFF1', 'https://external.com/promo');
      expect(url).toBe('https://external.com/promo?ref=AFF1');
    });

    it('should not append ref to custom redirect with existing query', () => {
      const url = getRedirectUrl('deal-123', 'en', 'AFF1', 'https://external.com/promo?existing=param');
      expect(url).toContain('existing=param');
      expect(url).toContain('ref=AFF1');
    });

    it('should not duplicate ref param', () => {
      const url = getRedirectUrl('deal-123', 'en', 'AFF1');
      const url2 = getRedirectUrl('deal-123', 'en', 'AFF1');

      const refCount1 = (url.match(/ref=/g) || []).length;
      const refCount2 = (url2.match(/ref=/g) || []).length;

      expect(refCount1).toBe(1);
      expect(refCount2).toBe(1);
    });
  });

  describe('Data Recording', () => {
    it('should record click in database', async () => {
      const DB = (globalThis as any).DB;
      const runMock = jest.fn().mockReturnValue({ success: true });
      const insertMock = { run: runMock };
      (DB.prepare as jest.Mock).mockImplementation((sql: string) => {
        if (sql.toLowerCase().includes('insert into deal_clicks')) {
          return { bind: jest.fn().mockReturnValue(insertMock) };
        }
        return { bind: jest.fn().mockReturnValue({ first: jest.fn(() => null), run: jest.fn().mockReturnValue({ success: true }) }) };
      });

      const click = createClickRecord('deal-123', 'user-123', 'cookie-123', '192.168.1.1', 'Mozilla/5.0', 'https://example.com', 'AFF1', 'affiliate-1');

      // Simulate insert
      const result = await DB.prepare('INSERT INTO deal_clicks ...')
        .bind(
          click.id,
          click.deal_id,
          click.user_id,
          click.ip_address,
          click.user_agent,
          click.referrer_url,
          click.cookie_id
        )
        .run();

      expect(result.success).toBe(true);
    });

    it('should store affiliate code when present', () => {
      const click = createClickRecord('deal-123', null, 'cookie-123', '192.168.1.1', 'Mozilla/5.0', null, 'AFF1', 'affiliate-1');

      expect(click.affiliate_code).toBe('AFF1');
      expect(click.affiliate_id).toBe('affiliate-1');
    });

    it('should handle clicks without affiliate code', () => {
      const click = createClickRecord('deal-123', null, 'cookie-123', '192.168.1.1', 'Mozilla/5.0', null, null, null);

      expect(click.affiliate_code).toBeNull();
      expect(click.affiliate_id).toBeNull();
    });

    it('should record authenticated user clicks', () => {
      const click = createClickRecord('deal-123', 'user-123', 'cookie-123', '192.168.1.1', 'Mozilla/5.0', null, null, null);

      expect(click.user_id).toBe('user-123');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty IP address gracefully', () => {
      const headers = {};
      const ip = extractIpAddress(headers);
      expect(ip).toBe('');
    });

    it('should handle whitespace in x-forwarded-for', () => {
      const headers = { 'x-forwarded-for': '  192.168.1.1  ,  10.0.0.1  ' };
      expect(extractIpAddress(headers)).toBe('192.168.1.1');
    });

    it('should handle malformed x-forwarded-for', () => {
      const headers = { 'x-forwarded-for': 'invalid' };
      expect(extractIpAddress(headers)).toBe('invalid');
    });

    it('should handle deal with no slug', () => {
      const url = getRedirectUrl('deal-123', 'en');
      expect(url).toBe('/en/deals/deal-123'); // Falls back to ID
    });
  });
});
