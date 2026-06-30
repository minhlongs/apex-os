/**
 * Smoke Test: Deal Detail
 * Tests the core logic for retrieving deal details
 */

type AffiliateDeal = {
  id: string;
  name: string;
  description: string | null;
  deal_type: string;
  product_id: string | null;
  url: string;
  default_commission_rate: number;
  default_commission_type: 'percentage' | 'fixed';
  fixed_commission_amount: number;
  cookie_duration_days: number;
  is_active: number;
  starts_at: string | null;
  ends_at: string | null;
  metadata: string;
  created_by: string | null;
  exchange: string | null;
  category: string | null;
  cashback_percent: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  created_at: string;
  updated_at: string;
};

type Profile = {
  id: string;
  email: string;
  role: 'shopper' | 'affiliate' | 'admin' | 'master_trader';
};

// Mock Database
let mockDeals: AffiliateDeal[];
let mockProfiles: Profile[];

function createMockDb() {
  mockDeals = [
    {
      id: 'deal-123',
      name: 'Test Deal',
      description: 'A test deal',
      deal_type: 'service',
      product_id: null,
      url: 'https://example.com',
      default_commission_rate: 0.10,
      default_commission_type: 'percentage',
      fixed_commission_amount: 0,
      cookie_duration_days: 30,
      is_active: 1,
      starts_at: '2025-01-01T00:00:00Z',
      ends_at: null,
      metadata: '{}',
      created_by: 'user-123',
      exchange: 'binance',
      category: 'spot',
      cashback_percent: 10,
      risk_level: 'low',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    },
  ];

  mockProfiles = [
    { id: 'user-123', email: 'creator@example.com', role: 'affiliate' },
    { id: 'admin-456', email: 'admin@apex-os.com', role: 'admin' },
    { id: 'user-789', email: 'other@example.com', role: 'affiliate' },
  ];

  return {
    prepare: jest.fn().mockImplementation((sql: string) => {
      const trimmed = sql.trim().replace(/\s+/g, ' ');

      return {
        bind: (...params: any[]) => ({
          first: async () => {
            // Profile lookup by ID
            if (trimmed.includes('SELECT role FROM profiles WHERE id')) {
              return mockProfiles.find(p => p.id === params[0]) || null;
            }
            // Deal lookup by ID
            if (trimmed.includes('SELECT * FROM deals WHERE id')) {
              return mockDeals.find(d => d.id === params[0]) || null;
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ success: true }),
        }),
      };
    }),
    _clear: () => {
      mockDeals = [{ ...mockDeals[0] }];
      mockProfiles = [{ ...mockProfiles[0] }, { ...mockProfiles[1] }, { ...mockProfiles[2] }];
    },
    _addDeal: (deal: AffiliateDeal) => { mockDeals.push(deal); },
  } as unknown as { DB: ReturnType<typeof createMockDb> };
}

// Core logic functions
async function getUserRole(userId: string): Promise<string | null> {
  const DB = (globalThis as any).DB;
  if (!DB) return null;

  const result = await DB.prepare('SELECT role FROM profiles WHERE id = ?')
    .bind(userId)
    .first<{ role: string }>();
  return result?.role || null;
}

async function canAccessDeal(userId: string, dealId: string): Promise<{ allowed: boolean; deal?: AffiliateDeal; error?: string }> {
  const DB = (globalThis as any).DB;
  if (!DB) return { allowed: false, error: 'Database not available' };

  const deal = await DB.prepare('SELECT * FROM deals WHERE id = ?')
    .bind(dealId)
    .first<AffiliateDeal>();

  if (!deal) {
    return { allowed: false, error: 'Deal not found' };
  }

  if (deal.created_by === userId) {
    return { allowed: true, deal };
  }

  const role = await getUserRole(userId);
  if (role === 'admin') {
    return { allowed: true, deal };
  }

  return { allowed: false, error: 'Forbidden' };
}

beforeAll(() => {
  (globalThis as any).DB = createMockDb();
});

afterEach(() => {
  (globalThis as any).DB?._clear?.();
});

describe('Deal Detail - Smoke Tests', () => {

  describe('Access Control', () => {
    it('should allow creator to access their deal', async () => {
      const result = await canAccessDeal('user-123', 'deal-123');

      expect(result.allowed).toBe(true);
      expect(result.deal).toBeDefined();
      expect(result.deal?.id).toBe('deal-123');
    });

    it('should allow admin to access any deal', async () => {
      const result = await canAccessDeal('admin-456', 'deal-123');

      expect(result.allowed).toBe(true);
      expect(result.deal).toBeDefined();
    });

    it('should deny non-creator non-admin access', async () => {
      const result = await canAccessDeal('user-789', 'deal-123');

      expect(result.allowed).toBe(false);
      expect(result.error).toBe('Forbidden');
    });

    it('should return 404 for non-existent deal', async () => {
      const result = await canAccessDeal('admin-456', 'non-existent');

      expect(result.allowed).toBe(false);
      expect(result.error).toBe('Deal not found');
    });

    it('should handle unknown user', async () => {
      const result = await canAccessDeal('unknown-user', 'deal-123');

      expect(result.allowed).toBe(false);
      expect(result.error).toBe('Forbidden');
    });
  });

  describe('Role Checking', () => {
    it('should identify admin user', async () => {
      const role = await getUserRole('admin-456');
      expect(role).toBe('admin');
    });

    it('should identify affiliate user', async () => {
      const role = await getUserRole('user-123');
      expect(role).toBe('affiliate');
    });

    it('should return null for unknown user', async () => {
      const role = await getUserRole('unknown');
      expect(role).toBeNull();
    });
  });

  describe('Deal Data Integrity', () => {
    it('should return complete deal data', async () => {
      const result = await canAccessDeal('admin-456', 'deal-123');

      expect(result.deal).toHaveProperty('id');
      expect(result.deal).toHaveProperty('name');
      expect(result.deal).toHaveProperty('description');
      expect(result.deal).toHaveProperty('url');
      expect(result.deal).toHaveProperty('exchange');
      expect(result.deal).toHaveProperty('cashback_percent');
    });

    it('should preserve all deal fields', async () => {
      const result = await canAccessDeal('admin-456', 'deal-123');

      expect(result.deal?.default_commission_rate).toBe(0.10);
      expect(result.deal?.cookie_duration_days).toBe(30);
      expect(result.deal?.is_active).toBe(1);
    });
  });
});
