/**
 * Cloudflare Pages Analytics Service
 * Fetches analytics data from Cloudflare API
 */

import { error as logError } from '@/lib/logger';
import type {  AnalyticsResponse,
  AnalyticsOverview,
  AnalyticsTimeSeriesData,
  AnalyticsTopPages,
  AnalyticsReferrers,
  AnalyticsCountries,
  AnalyticsDevices,
  AnalyticsBrowserInfo,
} from '@/types/analytics';

const CLOUDFLARE_ANALYTICS_API = 'https://api.cloudflare.com/client/v4';
const CACHE_TTL = 15 * 60; // 15 minutes in seconds

// In-memory cache for analytics data (using any for flexibility across different analytics types)
const analyticsCache = new Map<string, {
  data: any;
  timestamp: number;
}>();

/**
 * Get cache key for analytics endpoint
 */
function getCacheKey(
  accountId: string,
  endpoint: string,
  params: Record<string, string> = {}
): string {
  const paramString = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${accountId}:${endpoint}:${paramString}`;
}

/**
 * Check if cache is valid
 */
function isCacheValid(timestamp: number): boolean {
  return Date.now() - timestamp < CACHE_TTL * 1000;
}

/**
 * Fetch analytics data from Cloudflare API
 */
async function fetchFromCloudflare(
  accountId: string,
  token: string,
  endpoint: string,
  params: Record<string, string> = {}
): Promise<Response> {
  const url = new URL(`${CLOUDFLARE_ANALYTICS_API}/accounts/${accountId}/pages/${endpoint}`);

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.append(key, value);
  });

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    next: {
      // Cache the request for 15 minutes
      revalidate: CACHE_TTL,
    },
  });

  return response;
}

/**
 * Get analytics overview for a time period
 */
export async function getAnalyticsOverview(
  accountId: string,
  token: string,
  timeRange: '24h' | '7d' | '30d' = '7d'
): Promise<AnalyticsOverview | null> {
  const cacheKey = getCacheKey(accountId, 'analytics/overview', { time_range: timeRange });
  const cached = analyticsCache.get(cacheKey);

  if (cached && isCacheValid(cached.timestamp)) {
    return cached.data as AnalyticsOverview;
  }

  try {
    const response = await fetchFromCloudflare(accountId, token, 'analytics/overview', {
      time_range: timeRange,
    });

    if (!response.ok) {
      const error = await response.json();
      logError('Cloudflare Analytics API error:', error);
      return null;
    }

    const data: AnalyticsResponse = await response.json();

    if (!data.success) {
      logError('Cloudflare Analytics API error:', data);
      return null;
    }

    const overview = data.result.overview;
    analyticsCache.set(cacheKey, {
      data: overview,
      timestamp: Date.now(),
    });

    return overview;
  } catch (error) {
    logError('Failed to fetch analytics overview:', error);
    return null;
  }
}

/**
 * Get time series data for charts
 */
export async function getAnalyticsTimeSeries(
  accountId: string,
  token: string,
  timeRange: '24h' | '7d' | '30d' = '7d',
  interval: 'hour' | 'day' = 'day'
): Promise<AnalyticsTimeSeriesData[]> {
  const cacheKey = getCacheKey(accountId, 'analytics/timeseries', { time_range: timeRange, interval: interval });
  const cached = analyticsCache.get(cacheKey);

  if (cached && isCacheValid(cached.timestamp)) {
    return ((cached.data as unknown) as AnalyticsTimeSeriesData[]).map(item => ({
      date: item.date,
      pageViews: item.pageViews,
      uniqueVisitors: item.uniqueVisitors,
      requests: item.requests,
    }));
  }

  try {
    const response = await fetchFromCloudflare(accountId, token, 'analytics/timeseries', {
      time_range: timeRange,
      interval,
    });

    if (!response.ok) {
      const error = await response.json();
      logError('Cloudflare Analytics API error:', error);
      return [];
    }

    const data: AnalyticsResponse = await response.json();

    if (!data.success) {
      logError('Cloudflare Analytics API error:', data);
      return [];
    }

    const timeseries = data.result.timeseries;
    (analyticsCache as any).set(cacheKey, {
      data: timeseries,
      timestamp: Date.now(),
    });

    return timeseries;
  } catch (error) {
    logError('Failed to fetch analytics time series:', error);
    return [];
  }
}

/**
 * Get top pages by page views
 */
export async function getTopPages(
  accountId: string,
  token: string,
  timeRange: '24h' | '7d' | '30d' = '7d',
  limit: number = 10
): Promise<AnalyticsTopPages[]> {
  const cacheKey = getCacheKey(accountId, 'analytics/top-pages', { time_range: timeRange, limit: limit.toString() });
  const cached = analyticsCache.get(cacheKey);

  if (cached && isCacheValid(cached.timestamp)) {
    return (cached.data as AnalyticsTopPages[]).map(item => ({
      url: item.url,
      pageViews: item.pageViews,
      uniqueVisitors: item.uniqueVisitors,
    }));
  }

  try {
    const response = await fetchFromCloudflare(accountId, token, 'analytics/top-pages', {
      time_range: timeRange,
      limit: limit.toString(),
    });

    if (!response.ok) {
      const error = await response.json();
      logError('Cloudflare Analytics API error:', error);
      return [];
    }

    const data: AnalyticsResponse = await response.json();

    if (!data.success) {
      logError('Cloudflare Analytics API error:', data);
      return [];
    }

    const topPages = data.result.top_pages;
    analyticsCache.set(cacheKey, {
      data: topPages,
      timestamp: Date.now(),
    });

    return topPages;
  } catch (error) {
    logError('Failed to fetch top pages:', error);
    return [];
  }
}

/**
 * Get referrers data
 */
export async function getReferrers(
  accountId: string,
  token: string,
  timeRange: '24h' | '7d' | '30d' = '7d',
  limit: number = 10
): Promise<AnalyticsReferrers[]> {
  const cacheKey = getCacheKey(accountId, 'analytics/referrers', { time_range: timeRange, limit: limit.toString() });
  const cached = analyticsCache.get(cacheKey);

  if (cached && isCacheValid(cached.timestamp)) {
    return (cached.data as AnalyticsReferrers[]).map(item => ({
      referrer: item.referrer,
      visits: item.visits,
    }));
  }

  try {
    const response = await fetchFromCloudflare(accountId, token, 'analytics/referrers', {
      time_range: timeRange,
      limit: limit.toString(),
    });

    if (!response.ok) {
      const error = await response.json();
      logError('Cloudflare Analytics API error:', error);
      return [];
    }

    const data: AnalyticsResponse = await response.json();

    if (!data.success) {
      logError('Cloudflare Analytics API error:', data);
      return [];
    }

    const referrers = data.result.referrers;
    analyticsCache.set(cacheKey, {
      data: referrers,
      timestamp: Date.now(),
    });

    return referrers;
  } catch (error) {
    logError('Failed to fetch referrers:', error);
    return [];
  }
}

/**
 * Get countries/regions breakdown
 */
export async function getCountries(
  accountId: string,
  token: string,
  timeRange: '24h' | '7d' | '30d' = '7d',
  limit: number = 15
): Promise<AnalyticsCountries[]> {
  const cacheKey = getCacheKey(accountId, 'analytics/countries', { time_range: timeRange, limit: limit.toString() });
  const cached = analyticsCache.get(cacheKey);

  if (cached && isCacheValid(cached.timestamp)) {
    return (cached.data as AnalyticsCountries[]).map(item => ({
      country: item.country,
      countryCode: item.countryCode,
      visits: item.visits,
    }));
  }

  try {
    const response = await fetchFromCloudflare(accountId, token, 'analytics/countries', {
      time_range: timeRange,
      limit: limit.toString(),
    });

    if (!response.ok) {
      const error = await response.json();
      logError('Cloudflare Analytics API error:', error);
      return [];
    }

    const data: AnalyticsResponse = await response.json();

    if (!data.success) {
      logError('Cloudflare Analytics API error:', data);
      return [];
    }

    const countries = data.result.countries;
    analyticsCache.set(cacheKey, {
      data: countries,
      timestamp: Date.now(),
    });

    return countries;
  } catch (error) {
    logError('Failed to fetch countries:', error);
    return [];
  }
}

/**
 * Get devices breakdown
 */
export async function getDevices(
  accountId: string,
  token: string,
  timeRange: '24h' | '7d' | '30d' = '7d'
): Promise<AnalyticsDevices[]> {
  const cacheKey = getCacheKey(accountId, 'analytics/devices', { time_range: timeRange });
  const cached = analyticsCache.get(cacheKey);

  if (cached && isCacheValid(cached.timestamp)) {
    return (cached.data as AnalyticsDevices[]).map(item => ({
      device: item.device,
      visits: item.visits,
    }));
  }

  try {
    const response = await fetchFromCloudflare(accountId, token, 'analytics/devices', {
      time_range: timeRange,
    });

    if (!response.ok) {
      const error = await response.json();
      logError('Cloudflare Analytics API error:', error);
      return [];
    }

    const data: AnalyticsResponse = await response.json();

    if (!data.success) {
      logError('Cloudflare Analytics API error:', data);
      return [];
    }

    const devices = data.result.devices;
    analyticsCache.set(cacheKey, {
      data: devices,
      timestamp: Date.now(),
    });

    return devices;
  } catch (error) {
    logError('Failed to fetch devices:', error);
    return [];
  }
}

/**
 * Get browsers breakdown
 */
export async function getBrowsers(
  accountId: string,
  token: string,
  timeRange: '24h' | '7d' | '30d' = '7d',
  limit: number = 10
): Promise<AnalyticsBrowserInfo[]> {
  const cacheKey = getCacheKey(accountId, 'analytics/browsers', { time_range: timeRange, limit: limit.toString() });
  const cached = analyticsCache.get(cacheKey);

  if (cached && isCacheValid(cached.timestamp)) {
    return (cached.data as AnalyticsBrowserInfo[]).map(item => ({
      browser: item.browser,
      visits: item.visits,
    }));
  }

  try {
    const response = await fetchFromCloudflare(accountId, token, 'analytics/browsers', {
      time_range: timeRange,
      limit: limit.toString(),
    });

    if (!response.ok) {
      const error = await response.json();
      logError('Cloudflare Analytics API error:', error);
      return [];
    }

    const data: AnalyticsResponse = await response.json();

    if (!data.success) {
      logError('Cloudflare Analytics API error:', data);
      return [];
    }

    const browsers = data.result.browsers;
    analyticsCache.set(cacheKey, {
      data: browsers,
      timestamp: Date.now(),
    });

    return browsers;
  } catch (error) {
    logError('Failed to fetch browsers:', error);
    return [];
  }
}

/**
 * Clear analytics cache (useful for testing or manual refresh)
 */
export function clearAnalyticsCache(): void {
  analyticsCache.clear();
}
