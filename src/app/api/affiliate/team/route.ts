/**
 * Team Performance API
 * Returns per-downline-affiliate stats for the authenticated affiliate.
 *
 * Endpoint: GET /api/affiliate/team
 * Auth: Required (affiliate or admin)
 * Rate Limit: 100 req/hour per user
 * Cache: 5-minute TTL with KV
 *
 * Query params:
 * - team_depth: 1|2|3 (default 2) — how many levels of downline to include
 * - days: number (default 30) — lookback window for activity
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { withRateLimit, extractIpAddress } from '@/lib/ratelimit/middleware';
import { error as logError, warn as logWarn } from '@/lib/logger';

// Minimal Database interface for D1
interface Database {
 prepare(sql: string): {
 bind(...params: unknown[]): {
 first<T = unknown>(): Promise<T | null>;
 all<T = unknown>(): Promise<{ results: T[] }>;
 run(): Promise<{ success: boolean }>;
 };
 };
}

// Cache config
const TEAM_CACHE_TTL = 300; // 5 minutes
const TEAM_CACHE_PREFIX = 'affiliate:team';

function getCacheKey(userId: string, depth: number, days: number): string {
 return `${TEAM_CACHE_PREFIX}:${userId}:d${depth}:days${days}`;
}

function isKVAvailable(): boolean {
 // @ts-ignore - KV binding from wrangler.toml
 return typeof KV !== 'undefined' && KV.get !== undefined;
}

interface TeamResponse {
 meta: {
 generated_at: string;
 team_depth: number;
 lookback_days: number;
 cached: boolean;
 };
 members: TeamMember[];
 summary: {
 total_downline: number;
 total_conversions: number;
 total_commission: number;
 active_deals_clicked: number;
 };
}

interface TeamMember {
 affiliate_id: string;
 email: string;
 full_name: string | null;
 level: number; // 1=direct, 2=indirect, 3=third-level
 path: string;
 total_conversions: number;
 total_commission: number;
 active_deals_clicked: number;
 last_activity: string | null;
}

export const GET = withRateLimit(async (request: NextRequest): Promise<Response> => {
 const startTime = Date.now();
 let cacheAvailable = false;
 let cacheKey = '';

 try {
 const auth = createAuth({
 DB: (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!,
 });

 const sessionResult = await auth.api.getSession({
 headers: request.headers,
 cookies: request.cookies as unknown as Record<string, string>,
 });

 if (!sessionResult?.user) {
 return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 }

 const userId = (sessionResult.user as { id: string }).id;
 const DB = (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB as Database;

 // Parse query params
 const url = new URL(request.url);
 const depth = Math.min(3, Math.max(1, parseInt(url.searchParams.get('team_depth') || '2')));
 const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30')));

 cacheKey = getCacheKey(userId, depth, days);
 cacheAvailable = isKVAvailable();

 // Try KV cache
 if (cacheAvailable) {
 // @ts-ignore
 const cached = await KV.get(cacheKey, 'json');
 if (cached) {
 const data = (typeof cached === 'string' ? JSON.parse(cached) : cached) as TeamResponse;
 return NextResponse.json(
 { ...data, meta: { ...data.meta, cached: true } },
 {
 headers: {
 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
 'X-Cache': 'HIT',
 'X-Cache-Query-Time': String(Date.now() - startTime),
 },
 }
 );
 }
 }

 // Get my referral tree node
 const myNode = await DB.prepare(
 'SELECT id, path FROM referral_tree WHERE affiliate_id = ? LIMIT 1'
 )
 .bind(userId)
 .first<{ id: string; path: string }>();

 if (!myNode) {
 // User has no downline yet — return empty team
 const emptyResponse: TeamResponse = {
 meta: {
 generated_at: new Date().toISOString(),
 team_depth: depth,
 lookback_days: days,
 cached: false,
 },
 members: [],
 summary: {
 total_downline: 0,
 total_conversions: 0,
 total_commission: 0,
 active_deals_clicked: 0,
 },
 };
 return NextResponse.json(emptyResponse, {
 headers: {
 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
 'X-Cache': 'MISS',
 'X-Cache-Query-Time': String(Date.now() - startTime),
 },
 });
 }

 // Get downline within depth levels
 // path is stored as comma-separated IDs, e.g. "rootId,parentId,myId"
 // depth 2 means my direct + indirect (2 levels below me)
 const pathPrefix = myNode.path;
 const downlineQuery = `
 SELECT
 p.id as affiliate_id,
 p.email,
 p.full_name,
 rt.level,
 rt.path,
 rt.parent_id
 FROM referral_tree rt
 JOIN profiles p ON p.id = rt.affiliate_id
 WHERE rt.path LIKE ?
 AND rt.level > (
 SELECT level FROM referral_tree WHERE affiliate_id = ?
 LIMIT 1
 )
 AND rt.level <= (
 SELECT level FROM referral_tree WHERE affiliate_id = ?
 LIMIT 1
 ) + ?
 AND p.role IN ('affiliate', 'master_trader')
 ORDER BY rt.level ASC, p.email
 `;

 const myLevelRow = await DB.prepare(
 'SELECT level FROM referral_tree WHERE affiliate_id = ? LIMIT 1'
 )
 .bind(userId)
 .first<{ level: number }>();

 const myLevel = myLevelRow?.level ?? 1;
 const maxLevel = myLevel + depth;

 const downlineRows = await DB.prepare(downlineQuery)
 .bind(`${pathPrefix},%`, userId, userId, maxLevel)
 .all<{
 affiliate_id: string;
 email: string;
 full_name: string | null;
 level: number;
 path: string;
 parent_id: string | null;
 }>();

 // For each downline member, aggregate their stats
 const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

 const memberResults: TeamMember[] = [];
 let totalConversions = 0;
 let totalCommission = 0;
 let activeDealsClicked = 0;

 for (const row of downlineRows.results) {
 // Count conversions by this affiliate in the lookback window
 const convResult = await DB.prepare(
 `SELECT COUNT(*) as cnt, COALESCE(SUM(commission_amount), 0) as commission
 FROM conversions
 WHERE affiliate_id = ?
 AND converted_at >= ?
 AND status = 'approved'`
 )
 .bind(row.affiliate_id, since)
 .first<{ cnt: number; commission: number }>();

 const conversions = convResult?.cnt ?? 0;
 const commission = convResult?.commission ?? 0;

 // Count distinct deals clicked by this affiliate (through their unique clicks)
 const dealsResult = await DB.prepare(
 `SELECT COUNT(DISTINCT dc.deal_id) as cnt
 FROM deal_clicks dc
 WHERE dc.affiliate_id = ?
 AND dc.created_at >= ?`
 )
 .bind(row.affiliate_id, since)
 .first<{ cnt: number }>();

 const dealsCount = dealsResult?.cnt ?? 0;

 // Last activity
 const lastConv = await DB.prepare(
 `SELECT MAX(converted_at) as ts FROM conversions WHERE affiliate_id = ?`
 )
 .bind(row.affiliate_id)
 .first<{ ts: string | null }>();

 const levelOffset = row.level - myLevel; // 1 = direct, 2 = indirect, etc.

 memberResults.push({
 affiliate_id: row.affiliate_id,
 email: row.email,
 full_name: row.full_name,
 level: Math.min(levelOffset, 3),
 path: row.path,
 total_conversions: conversions,
 total_commission: Math.round(commission * 100) / 100,
 active_deals_clicked: dealsCount,
 last_activity: lastConv?.ts ?? null,
 });

 totalConversions += conversions;
 totalCommission += commission;
 activeDealsClicked += dealsCount;
 }

 const response: TeamResponse = {
 meta: {
 generated_at: new Date().toISOString(),
 team_depth: depth,
 lookback_days: days,
 cached: false,
 },
 members: memberResults,
 summary: {
 total_downline: memberResults.length,
 total_conversions: totalConversions,
 total_commission: Math.round(totalCommission * 100) / 100,
 active_deals_clicked: activeDealsClicked,
 },
 };

 const queryTime = Date.now() - startTime;

 // Cache the response
 if (cacheAvailable) {
 try {
 // @ts-ignore
 await KV.put(cacheKey, JSON.stringify(response), { expirationTtl: TEAM_CACHE_TTL });
 } catch (cacheError) {
 logWarn('[TeamCache] Cache store error:', cacheError);
 }
 }

 return NextResponse.json(response, {
 headers: {
 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
 'X-Cache': 'MISS',
 'X-Cache-Query-Time': String(queryTime),
 },
 });
 } catch (error) {
 logError('Error fetching team performance:', error);
 return NextResponse.json(
 { error: 'Internal server error', details: String(error) },
 { status: 500 }
 );
 }
 }, {
 endpointType: 'api_general',
 getIdentifier: (request) => ({
 ip: extractIpAddress(request.headers),
 }),
 skipIf: (request) => {
 const pathname = new URL(request.url).pathname;
 return pathname.startsWith('/api/health') || pathname.startsWith('/api/monitoring');
 },
 });
