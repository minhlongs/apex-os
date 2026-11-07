/**
 * src/app/api/admin/paper/__tests__/paper-routes.test.ts
 *
 * Route-level integration tests for:
 *   - GET /api/admin/paper/overview
 *   - GET /api/admin/paper/export?format=csv
 *   - GET /api/admin/paper/export?format=pdf
 */

import { NextRequest } from 'next/server';
import { GET as getOverview } from '../overview/route';
import { GET as getExport } from '../export/route';

jest.mock('@/lib/payouts/admin-auth', () => ({
  verifyAdminPayoutAccess: jest.fn().mockImplementation(async (req: NextRequest) => {
    const authHeader = req.headers.get('authorization');
    if (!authHeader || !authHeader.includes('Bearer admin-token')) {
      return {
        authorized: false,
        status: 401,
        error: 'Unauthorized: Session required',
        response: new Response(
          JSON.stringify({ success: false, error: 'Unauthorized: Session required' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }
    return {
      authorized: true,
      admin: {
        id: 'admin_test',
        userId: 'admin_test',
        email: 'admin@apexos.app',
        role: 'admin',
      },
      db: {} as any,
      ipAddress: '127.0.0.1',
    };
  }),
}));

describe('Admin Paper Trading API Routes', () => {
  it('GET /api/admin/paper/overview rejects unauthorized / anonymous callers (fail-closed)', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/paper/overview');
    const res = await getOverview(req);
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/paper/overview returns full paper simulator telemetry with admin auth', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/paper/overview', {
      headers: { authorization: 'Bearer admin-token' },
    });
    const res = await getOverview(req);

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.executionMode).toBe('PAPER');
    expect(data.isLive).toBe(false);
    expect(data.dataSource).toBe('FIXTURE_REPLAY_FALLBACK');
    expect(data.liveTradingEnabled).toBe(false);
    expect(data.watermark).toContain('PAPER SIMULATION ONLY');
    expect(data.replayVerification.bitIdentical).toBe(true);
    expect(data.replayVerification.digest.length).toBe(64);
    expect(data.strategies['spot-2exch'].initialCapitalUsdt).toBe(10000);
    expect(data.strategies['spot-perp'].initialCapitalUsdt).toBe(10000);
    expect(data.closedCycles.length).toBeGreaterThan(0);
    expect(data.economicResearchReport.reportType).toBe('STRICT_ECONOMIC_AUDIT');
    expect(data.economicResearchReport.isReleaseBlocker).toBe(true);
    expect(data.economicResearchReport.overallVerdict).toBe('NO_GO');
  });

  it('GET /api/admin/paper/export rejects unauthorized / anonymous callers (fail-closed)', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/paper/export?format=csv');
    const res = await getExport(req);
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/paper/export?format=csv returns CSV file stamped with PAPER watermark and auth', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/paper/export?format=csv', {
      headers: { authorization: 'Bearer admin-token' },
    });
    const res = await getExport(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('X-Execution-Mode')).toBe('PAPER');
    expect(res.headers.get('X-Data-Source')).toBe('FIXTURE_REPLAY');

    const csvText = await res.text();
    expect(csvText).toContain('# EXECUTION_MODE: PAPER');
    expect(csvText).toContain('# DATA_SOURCE: FIXTURE_REPLAY');
    expect(csvText).toContain('cycle_id,idempotency_key,strategy_id');
    expect(csvText).toContain('spot-2exch');
  });

  it('GET /api/admin/paper/export?format=pdf returns PDF binary with ISO header and PAPER stamp', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/paper/export?format=pdf', {
      headers: { authorization: 'Bearer admin-token' },
    });
    const res = await getExport(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/pdf');
    expect(res.headers.get('X-Execution-Mode')).toBe('PAPER');
    expect(res.headers.get('X-Data-Source')).toBe('FIXTURE_REPLAY');

    const pdfText = await res.text();
    expect(pdfText.startsWith('%PDF-1.4')).toBe(true);
    expect(pdfText).toContain('PAPER SIMULATION ONLY');
  });
});
