/**
 * Smoke Test: Deal CRUD Operations
 * Tests core deal management logic
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

// Test fixtures
let mockDeals: AffiliateDeal[];
let mockProfiles: Profile[];

function createMockDb() {
  mockDeals = [
    {
      id: 'deal-123',
      name: 'Existing Deal',
      description: 'An existing deal',
      deal_type: 'service',
      product_id: null,
      url: 'https://example.com/existing',
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
    _clear: () => {
      mockDeals = [{ ...mockDeals[0] }];
      mockProfiles = [{ ...mockProfiles[0] }, { ...mockProfiles[1] }, { ...mockProfiles[2] }];
    },
    _addDeal: (deal: AffiliateDeal) => { mockDeals.push(deal); },
    getDeals: () => mockDeals,
    getDeal: (id: string) => mockDeals.find(d => d.id === id) || null,
    getProfile: (id: string) => mockProfiles.find(p => p.id === id) || null,
  } as any;
}

// Core logic functions
function getUserRole(userId: string): string | null {
  const DB = (globalThis as any).DB;
  if (!DB) return null;
  const profile = DB.getProfile(userId);
  return profile?.role || null;
}

async function canAccessDeal(userId: string, dealId: string): Promise<{ allowed: boolean; deal?: AffiliateDeal; error?: string }> {
  const DB = (globalThis as any).DB;
  if (!DB) return { allowed: false, error: 'Database not available' };

  const deal = DB.getDeal(dealId);

  if (!deal) {
    return { allowed: false, error: 'Deal not found' };
  }

  if (deal.created_by === userId) {
    return { allowed: true, deal };
  }

  const role = getUserRole(userId);
  if (role === 'admin') {
    return { allowed: true, deal };
  }

  return { allowed: false, error: 'Forbidden' };
}

function createDeal(data: Partial<AffiliateDeal> & { created_by: string }): AffiliateDeal {
  return {
    id: `deal-${Date.now()}`,
    name: data.name || 'Untitled Deal',
    description: data.description || null,
    deal_type: data.deal_type || 'product',
    product_id: data.product_id || null,
    url: data.url || 'https://example.com',
    default_commission_rate: data.default_commission_rate ?? 0.10,
    default_commission_type: data.default_commission_type || 'percentage',
    fixed_commission_amount: data.fixed_commission_amount || 0,
    cookie_duration_days: data.cookie_duration_days || 30,
    is_active: data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1,
    starts_at: data.starts_at || null,
    ends_at: data.ends_at || null,
    metadata: data.metadata ? JSON.stringify(data.metadata) : '{}',
    created_by: data.created_by,
    exchange: data.exchange || null,
    category: data.category || null,
    cashback_percent: data.cashback_percent ?? null,
    risk_level: data.risk_level || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function updateDeal(deal: AffiliateDeal, updates: Partial<AffiliateDeal>): AffiliateDeal {
  const updated = { ...deal };
  const now = new Date().toISOString();

  const fields: (keyof AffiliateDeal)[] = [
    'name', 'description', 'deal_type', 'product_id', 'url',
    'default_commission_rate', 'default_commission_type', 'fixed_commission_amount',
    'cookie_duration_days', 'is_active', 'starts_at', 'ends_at',
    'metadata', 'exchange', 'category', 'cashback_percent', 'risk_level'
  ];

  fields.forEach(field => {
    if (updates[field] !== undefined) {
      (updated as any)[field] = updates[field];
    }
  });

  updated.updated_at = now;
  return updated;
}

function deactivateDeal(deal: AffiliateDeal): AffiliateDeal {
  return {
    ...deal,
    is_active: 0,
    updated_at: new Date().toISOString(),
  };
}

function validateDeal(data: any): string[] {
  const errors: string[] = [];
  if (!data.name) errors.push('name is required');
  if (!data.url) errors.push('url is required');
  if (data.default_commission_rate !== undefined && (data.default_commission_rate < 0 || data.default_commission_rate > 1)) {
    errors.push('default_commission_rate must be between 0 and 1');
  }
  if (data.cookie_duration_days !== undefined && data.cookie_duration_days <= 0) {
    errors.push('cookie_duration_days must be positive');
  }
  return errors;
}

const ALLOWED_EXCHANGES = ['binance', 'bybit', 'okx', 'ftx', 'coinbase', 'kraken'];
const ALLOWED_CATEGORIES = ['spot', 'futures', 'options', 'margin'];

function isValidExchange(exchange: string): boolean {
  return ALLOWED_EXCHANGES.includes(exchange as any);
}

function isValidCategory(category: string): boolean {
  return ALLOWED_CATEGORIES.includes(category as any);
}

beforeAll(() => {
  (globalThis as any).DB = createMockDb();
});

afterEach(() => {
  (globalThis as any).DB?._clear?.();
});

describe('Deal CRUD - Smoke Tests', () => {

  describe('CREATE', () => {
    it('should create deal with required fields', async () => {
      const dealData = {
        name: 'New Deal',
        url: 'https://example.com/new',
        created_by: 'admin-456',
      };

      const deal = createDeal(dealData);

      expect(deal).toHaveProperty('id');
      expect(deal.name).toBe('New Deal');
      expect(deal.url).toBe('https://example.com/new');
      expect(deal.is_active).toBe(1);
    });

    it('should create deal with all extended fields', async () => {
      const dealData = {
        name: 'Extended Deal',
        url: 'https://example.com/extended',
        exchange: 'binance',
        category: 'spot',
        cashback_percent: 15,
        risk_level: 'high',
        deal_type: 'service',
        created_by: 'admin-456',
      };

      const deal = createDeal(dealData);

      expect(deal.exchange).toBe('binance');
      expect(deal.category).toBe('spot');
      expect(deal.cashback_percent).toBe(15);
      expect(deal.risk_level).toBe('high');
    });

    it('should set default values correctly', async () => {
      const deal = createDeal({ name: 'Minimal', url: 'https://test.com', created_by: 'admin-456' });

      expect(deal.default_commission_rate).toBe(0.10);
      expect(deal.cookie_duration_days).toBe(30);
      expect(deal.default_commission_type).toBe('percentage');
      expect(deal.is_active).toBe(1);
    });

    it('should validate required fields', () => {
      expect(validateDeal({})).toContain('name is required');
      expect(validateDeal({ name: 'Test' })).toContain('url is required');
      expect(validateDeal({ name: 'Test', url: 'http://test.com' })).toHaveLength(0);
    });

    it('should validate commission rate range', () => {
      expect(validateDeal({ name: 'Test', url: 'http://test.com', default_commission_rate: 1.5 }))
        .toContain('default_commission_rate must be between 0 and 1');
      expect(validateDeal({ name: 'Test', url: 'http://test.com', default_commission_rate: -0.1 }))
        .toContain('default_commission_rate must be between 0 and 1');
      expect(validateDeal({ name: 'Test', url: 'http://test.com', default_commission_rate: 0.15 }))
        .toHaveLength(0);
    });

    it('should validate cookie duration', () => {
      expect(validateDeal({ name: 'Test', url: 'http://test.com', cookie_duration_days: 0 }))
        .toContain('cookie_duration_days must be positive');
      expect(validateDeal({ name: 'Test', url: 'http://test.com', cookie_duration_days: -5 }))
        .toContain('cookie_duration_days must be positive');
      expect(validateDeal({ name: 'Test', url: 'http://test.com', cookie_duration_days: 30 }))
        .toHaveLength(0);
    });
  });

  describe('READ', () => {
    it('should retrieve specific deal by ID', async () => {
      const result = await canAccessDeal('admin-456', 'deal-123');
      expect(result.allowed).toBe(true);
      expect(result.deal?.id).toBe('deal-123');
      expect(result.deal?.name).toBe('Existing Deal');
    });

    it('should return all deals', async () => {
      const DB = (globalThis as any).DB;
      const deals = DB.getDeals();
      expect(deals.length).toBeGreaterThan(0);
    });

    it('should return null for non-existent deal', async () => {
      const result = await canAccessDeal('admin-456', 'non-existent');
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('Deal not found');
    });
  });

  describe('UPDATE', () => {
    it('should allow creator to update their deal', async () => {
      const access = await canAccessDeal('user-123', 'deal-123');
      expect(access.allowed).toBe(true);

      const updated = updateDeal(access.deal!, {
        name: 'Updated Deal Name',
        cashback_percent: 20,
      });

      expect(updated.name).toBe('Updated Deal Name');
      expect(updated.cashback_percent).toBe(20);
      expect(updated.id).toBe('deal-123');
    });

    it('should allow admin to update any deal', async () => {
      const access = await canAccessDeal('admin-456', 'deal-123');
      expect(access.allowed).toBe(true);

      const updated = updateDeal(access.deal!, {
        risk_level: 'high',
        exchange: 'bybit',
      });

      expect(updated.risk_level).toBe('high');
      expect(updated.exchange).toBe('bybit');
    });

    it('should reject update for non-creator non-admin', async () => {
      const result = await canAccessDeal('user-789', 'deal-123');
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('Forbidden');
    });

    it('should support partial updates', () => {
      const DB = (globalThis as any).DB;
      const deal = DB.getDeal('deal-123')!;
      const updated = updateDeal(deal, { description: 'New description only' });

      expect(updated.description).toBe('New description only');
      expect(updated.name).toBe(deal.name);
    });

    it('should preserve unchanged fields during update', () => {
      const DB = (globalThis as any).DB;
      const deal = DB.getDeal('deal-123')!;
      const originalUrl = deal.url;
      const updated = updateDeal(deal, { name: 'Updated Name' });

      expect(updated.url).toBe(originalUrl);
      expect(updated.created_at).toBe(deal.created_at);
    });
  });

  describe('DELETE', () => {
    it('should soft delete deal for creator', async () => {
      const access = await canAccessDeal('user-123', 'deal-123');
      expect(access.allowed).toBe(true);

      const deactivated = deactivateDeal(access.deal!);

      expect(deactivated.is_active).toBe(0);
      expect(deactivated.updated_at).toBeDefined();
    });

    it('should soft delete deal for admin', async () => {
      const access = await canAccessDeal('admin-456', 'deal-123');
      expect(access.allowed).toBe(true);

      const deactivated = deactivateDeal(access.deal!);

      expect(deactivated.is_active).toBe(0);
    });

    it('should reject delete for non-creator non-admin', async () => {
      const result = await canAccessDeal('user-789', 'deal-123');
      expect(result.allowed).toBe(false);
    });

    it('should not modify original deal on deactivate', () => {
      const DB = (globalThis as any).DB;
      const original = DB.getDeal('deal-123')!;
      const originalIsActive = original.is_active;

      deactivateDeal(original);

      expect(original.is_active).toBe(originalIsActive);
    });
  });

  describe('Authorization', () => {
    it('should allow creator full CRUD', async () => {
      const access = await canAccessDeal('user-123', 'deal-123');
      expect(access.allowed).toBe(true);
      expect(access.deal).toBeDefined();
    });

    it('should allow admin full CRUD', async () => {
      const access = await canAccessDeal('admin-456', 'deal-123');
      expect(access.allowed).toBe(true);
      expect(access.deal).toBeDefined();
    });

    it('should deny affiliate without ownership', async () => {
      const result = await canAccessDeal('user-789', 'deal-123');
      expect(result.allowed).toBe(false);
    });
  });

  describe('Data Validation', () => {
    it('should validate exchange enum', () => {
      expect(isValidExchange('binance')).toBe(true);
      expect(isValidExchange('bybit')).toBe(true);
      expect(isValidExchange('invalid')).toBe(false);
    });

    it('should validate category enum', () => {
      expect(isValidCategory('spot')).toBe(true);
      expect(isValidCategory('futures')).toBe(true);
      expect(isValidCategory('invalid')).toBe(false);
    });

    it('should handle all exchange types', () => {
      const exchanges = ['binance', 'bybit', 'okx', 'ftx', 'coinbase', 'kraken'];
      exchanges.forEach(ex => expect(isValidExchange(ex)).toBe(true));
    });

    it('should handle all category types', () => {
      const categories = ['spot', 'futures', 'options', 'margin'];
      categories.forEach(cat => expect(isValidCategory(cat)).toBe(true));
    });
  });
});
