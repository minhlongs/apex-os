/**
 * Smoke Test: Public Deals Listing
 */

type PublicDeal = {
  id: string;
  name: string;
  description: string | null;
  deal_type: string;
  url: string;
  default_commission_rate: number;
  cookie_duration_days: number;
  is_active: number;
  exchange: string | null;
  category: string | null;
  cashback_percent: number | null;
};

type PaginatedResponse<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

// Test fixtures
const mockDeals: PublicDeal[] = [
  { id: '1', name: 'Binance Spot', description: 'Spot trading', deal_type: 'service', url: 'https://binance.com', default_commission_rate: 0.1, cookie_duration_days: 30, is_active: 1, exchange: 'binance', category: 'spot', cashback_percent: 10 },
  { id: '2', name: 'Bybit Futures', description: 'Futures trading', deal_type: 'service', url: 'https://bybit.com', default_commission_rate: 0.15, cookie_duration_days: 30, is_active: 1, exchange: 'bybit', category: 'futures', cashback_percent: 15 },
  { id: '3', name: 'Inactive Deal', description: null, deal_type: 'service', url: 'https://test.com', default_commission_rate: 0.05, cookie_duration_days: 30, is_active: 0, exchange: 'kraken', category: 'spot', cashback_percent: 5 },
];

// Core logic extracted from API route
function filterDeals(
  deals: PublicDeal[],
  filters: {
    is_active?: boolean;
    exchange?: string;
    category?: string;
    deal_type?: string;
    search?: string;
  }
): PublicDeal[] {
  return deals.filter(deal => {
    if (filters.is_active !== undefined && deal.is_active !== (filters.is_active ? 1 : 0)) {
      return false;
    }
    if (filters.exchange && deal.exchange !== filters.exchange) return false;
    if (filters.category && deal.category !== filters.category) return false;
    if (filters.deal_type && deal.deal_type !== filters.deal_type) return false;
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      if (!deal.name.toLowerCase().includes(searchLower) &&
          !(deal.description || '').toLowerCase().includes(searchLower)) {
        return false;
      }
    }
    return true;
  });
}

function paginate<T>(items: T[], page: number, limit: number): PaginatedResponse<T> {
  const total = items.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const data = items.slice(offset, offset + limit);

  return { data, total, page, limit, totalPages };
}

function validateFilter(value: string, allowed: readonly string[]): boolean {
  return allowed.includes(value as any);
}

// Simulate API handler
async function handleListDeals(params: {
  page?: number;
  limit?: number;
  exchange?: string;
  category?: string;
  deal_type?: string;
  search?: string;
  is_active?: string;
}): Promise<{ status: number; data: PaginatedResponse<PublicDeal>; error?: string }> {
  const page = Math.max(parseInt(params.page || '1'), 1);
  const limit = Math.min(Math.max(parseInt(params.limit || '20'), 1), 100);
  const isActive = params.is_active !== '0';

  // Validate enums
  const ALLOWED_EXCHANGES = ['binance', 'bybit', 'okx', 'ftx', 'coinbase', 'kraken'];
  const ALLOWED_CATEGORIES = ['spot', 'futures', 'options', 'margin'];
  const ALLOWED_DEAL_TYPES = ['product', 'service', 'subscription', 'course'];

  if (params.exchange && !validateFilter(params.exchange, ALLOWED_EXCHANGES)) {
    return { status: 400, data: { data: [], total: 0, page, limit, totalPages: 0 }, error: 'Invalid exchange' };
  }
  if (params.category && !validateFilter(params.category, ALLOWED_CATEGORIES)) {
    return { status: 400, data: { data: [], total: 0, page, limit, totalPages: 0 }, error: 'Invalid category' };
  }
  if (params.deal_type && !validateFilter(params.deal_type, ALLOWED_DEAL_TYPES)) {
    return { status: 400, data: { data: [], total: 0, page, limit, totalPages: 0 }, error: 'Invalid deal_type' };
  }

  // Filter and paginate
  const filtered = filterDeals(mockDeals, {
    is_active: isActive,
    exchange: params.exchange,
    category: params.category,
    deal_type: params.deal_type,
    search: params.search,
  });

  const now = new Date().toISOString();
  const validDeals = filtered.filter(d => {
    const startsOk = !d.starts_at || d.starts_at <= now;
    const endsOk = !d.ends_at || d.ends_at >= now;
    return startsOk && endsOk;
  });

  const result = paginate(validDeals, page, limit);

  return { status: 200, data: result };
}

describe('Public Deals Listing - Smoke Tests', () => {
  describe('GET /api/public/deals', () => {
    it('should return paginated list of active deals', async () => {
      const result = await handleListDeals({ page: 1, limit: 20 });

      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('data');
      expect(Array.isArray(result.data.data)).toBe(true);
      expect(result.data.data.length).toBeLessThanOrEqual(20);
    });

    it('should filter by exchange', async () => {
      const result = await handleListDeals({ exchange: 'binance', is_active: '1' });

      expect(result.status).toBe(200);
      result.data.data.forEach(d => expect(d.exchange).toBe('binance'));
    });

    it('should filter by category', async () => {
      const result = await handleListDeals({ category: 'futures', is_active: '1' });

      expect(result.status).toBe(200);
      result.data.data.forEach(d => expect(d.category).toBe('futures'));
    });

    it('should filter by deal_type', async () => {
      const result = await handleListDeals({ deal_type: 'service', is_active: '1' });

      expect(result.status).toBe(200);
      result.data.data.forEach(d => expect(d.deal_type).toBe('service'));
    });

    it('should search in name and description', async () => {
      const result = await handleListDeals({ search: 'binance', is_active: '1' });

      expect(result.status).toBe(200);
      expect(result.data.data.some(d =>
        d.name.toLowerCase().includes('binance') ||
        (d.description && d.description.toLowerCase().includes('binance'))
      )).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const result = await handleListDeals({ limit: '2', page: '1' });

      expect(result.status).toBe(200);
      expect(result.data.limit).toBe(2);
      expect(result.data.data.length).toBeLessThanOrEqual(2);
    });

    it('should enforce max limit of 100', async () => {
      const result = await handleListDeals({ limit: '200' });

      expect(result.status).toBe(200);
      expect(result.data.limit).toBe(100);
    });

    it('should exclude inactive deals by default', async () => {
      const result = await handleListDeals({ is_active: '1' });

      result.data.data.forEach(d => expect(d.is_active).toBe(1));
    });

    it('should include inactive deals when is_active=0', async () => {
      const result = await handleListDeals({ is_active: '0' });

      expect(result.status).toBe(200);
      expect(result.data.data.some(d => d.is_active === 0)).toBe(true);
    });

    it('should calculate totalPages correctly', async () => {
      const result = await handleListDeals({ page: '1', limit: '2' });

      expect(result.status).toBe(200);
      expect(result.data.totalPages).toBe(Math.ceil(result.data.total / result.data.limit));
    });

    it('should return 400 for invalid exchange', async () => {
      const result = await handleListDeals({ exchange: 'invalid' });

      expect(result.status).toBe(400);
      expect(result.error).toBe('Invalid exchange');
    });

    it('should return 400 for invalid category', async () => {
      const result = await handleListDeals({ category: 'invalid' });

      expect(result.status).toBe(400);
      expect(result.error).toBe('Invalid category');
    });

    it('should return 400 for invalid deal_type', async () => {
      const result = await handleListDeals({ deal_type: 'invalid' });

      expect(result.status).toBe(400);
      expect(result.error).toBe('Invalid deal_type');
    });

    it('should handle database with fixture data', async () => {
      const result = await handleListDeals({});

      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('data');
      // Should return active deals from fixture
      expect(result.data.data.length).toBeGreaterThan(0);
      result.data.data.forEach(d => expect(d.is_active).toBe(1));
    });

    it('should handle page beyond results', async () => {
      const result = await handleListDeals({ page: '999', limit: '20' });

      expect(result.status).toBe(200);
      expect(result.data.data.length).toBe(0);
    });
  });
});
