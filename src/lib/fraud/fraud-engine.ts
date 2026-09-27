/**
 * ApexOS Unified Fraud Detection & Anomaly Engine Facade
 * Location: src/lib/fraud/fraud-engine.ts
 *
 * Re-exports:
 * - Dual-Window Rate Limiting (checkIpRateLimit, createRateLimit429Response, getRateLimitHeaders)
 * - IP Blocklist Management (isIpBlocked, autoBlockOffender, unblockIp, createBlockedIp403Response, normalizeIpAddress, extractClientIp)
 * - Click Velocity & Anomaly Engine (evaluateClickVelocity)
 */

import type { D1Database } from '@/types/d1';
import {
  ClickVelocityInput,
  VelocityCheckResult,
  VelocityCheckThresholds,
  BurstDetectionDetails,
  RatioAnomalyDetails,
  FraudReasonCode,
  ReasonCode,
} from '@/types/fraud';
import {
  checkIpRateLimit,
  createRateLimit429Response,
  getRateLimitHeaders,
  DEFAULT_RATE_LIMIT_CONFIG,
} from './rate-limiter';
import {
  isIpBlocked,
  autoBlockOffender,
  unblockIp,
  createBlockedIp403Response,
  normalizeIpAddress,
  extractClientIp,
} from './ip-blocker';
import { recordFraudDecision } from './audit-logger';

export {
  checkIpRateLimit,
  createRateLimit429Response,
  getRateLimitHeaders,
  DEFAULT_RATE_LIMIT_CONFIG,
  isIpBlocked,
  autoBlockOffender,
  unblockIp,
  createBlockedIp403Response,
  normalizeIpAddress,
  extractClientIp,
  recordFraudDecision,
};

/**
 * Safely parses any date representation into UTC epoch milliseconds.
 * Normalizes both ISO 8601 strings and SQLite space-separated 'YYYY-MM-DD HH:MM:SS(.SSS)'
 * without local timezone offset errors.
 */
export function parseTimestampMs(value: string | number | Date | null | undefined): number {
  if (value === null || value === undefined) return Date.now();
  if (typeof value === 'number') return Number.isFinite(value) ? value : Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return Date.now();
    // Numeric string epoch
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num)) return num;
    }
    // Normalize SQLite format 'YYYY-MM-DD HH:MM:SS(.SSS)' to UTC ISO 8601
    let iso = trimmed;
    if (!iso.includes('T') && iso.includes(' ')) {
      iso = iso.replace(' ', 'T');
    }
    if (!iso.endsWith('Z') && !/[+-]\d{2}(:\d{2})?$/.test(iso)) {
      iso += 'Z';
    }
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }
  return Date.now();
}

/**
 * Velocity Anomaly Engine: Evaluates burst clicks (<2s delta) and abnormal click-to-conversion ratios (>10:1)
 *
 * Feature F7: Rapid Multi-Click Burst Anomaly Detection (<2,000ms delta per IP or session)
 * Feature F8: Click-to-Conversion Ratio Velocity (>10:1 ratio for >= 10 clicks)
 * Multi-Anomaly Stacking (C5): Probabilistic score combination when multiple anomalies trigger
 */
export async function evaluateClickVelocity(
  db: D1Database,
  click: ClickVelocityInput,
  thresholds?: Partial<VelocityCheckThresholds>
): Promise<VelocityCheckResult> {
  const burstWindowMs = thresholds?.burstWindowMs ?? 2000;
  const minClicksForRatioCheck = thresholds?.minClicksForRatioCheck ?? 10;
  const maxClickToConversionRatio = thresholds?.maxClickToConversionRatio ?? 10;

  let isSuspicious = false;
  let burstDetected = false;
  let ratioAnomalyDetected = false;
  let burstScore = 0;
  let ratioScore = 0;
  let anomalyScore = 0;
  const flagReasons: ReasonCode[] = [];
  let burstDetails: BurstDetectionDetails | undefined = undefined;
  let ratioDetails: RatioAnomalyDetails | undefined = undefined;

  const nowMs = click.timestamp !== undefined && click.timestamp !== null
    ? parseTimestampMs(click.timestamp)
    : Date.now();

  // 1. Feature F7: Rapid Multi-Click Burst Detection (< burstWindowMs)
  const rawIp = click.ipAddress ? click.ipAddress.trim() : '';
  const ip = rawIp ? (normalizeIpAddress(rawIp) || rawIp) : '';
  const sessionId = click.sessionId ? click.sessionId.trim() : '';

  if (ip || sessionId) {
    // Optimized index seeks on ip_address and session_id separately to utilize composite indexes
    let prior: { id: string; created_at: string; ip_address: string; session_id: string } | null = null;

    if (ip && sessionId) {
      const [priorByIp, priorBySession] = await Promise.all([
        db
          .prepare(
            'SELECT id, created_at, ip_address, session_id FROM deal_clicks WHERE ip_address = ? ORDER BY created_at DESC LIMIT 1'
          )
          .bind(ip)
          .first<{ id: string; created_at: string; ip_address: string; session_id: string }>(),
        db
          .prepare(
            'SELECT id, created_at, ip_address, session_id FROM deal_clicks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
          )
          .bind(sessionId)
          .first<{ id: string; created_at: string; ip_address: string; session_id: string }>(),
      ]);

      if (priorByIp && priorBySession) {
        const timeIp = parseTimestampMs(priorByIp.created_at);
        const timeSession = parseTimestampMs(priorBySession.created_at);
        prior = timeIp >= timeSession ? priorByIp : priorBySession;
      } else {
        prior = priorByIp || priorBySession;
      }
    } else if (ip) {
      prior = await db
        .prepare(
          'SELECT id, created_at, ip_address, session_id FROM deal_clicks WHERE ip_address = ? ORDER BY created_at DESC LIMIT 1'
        )
        .bind(ip)
        .first<{ id: string; created_at: string; ip_address: string; session_id: string }>();
    } else if (sessionId) {
      prior = await db
        .prepare(
          'SELECT id, created_at, ip_address, session_id FROM deal_clicks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
        )
        .bind(sessionId)
        .first<{ id: string; created_at: string; ip_address: string; session_id: string }>();
    }

    if (prior?.created_at) {
      const priorMs = parseTimestampMs(prior.created_at);
      const deltaMs = nowMs - priorMs;

      // Strict boundary check: 0 <= deltaMs < burstWindowMs (e.g. 1999ms flagged, 2000ms clean)
      if (deltaMs >= 0 && deltaMs < burstWindowMs) {
        burstDetected = true;
        isSuspicious = true;
        flagReasons.push(FraudReasonCode.BURST_CLICK);
        // Base score 0.85, 0.90 for sub-second burst
        burstScore = deltaMs < 1000 ? 0.90 : 0.85;

        let matchedBy: 'ip' | 'session' | 'affiliate' = 'ip';
        if (sessionId && prior.session_id === sessionId) {
          matchedBy = 'session';
        } else if (ip && prior.ip_address === ip) {
          matchedBy = 'ip';
        }

        burstDetails = {
          previousClickId: prior.id,
          previousClickTimestamp: prior.created_at,
          deltaMs,
          matchedBy,
        };
      }
    }
  }

  // 2. Feature F8: Click-to-Conversion Ratio Velocity (> 10:1 ratio where clicks >= 10)
  const affiliateIdentifier = click.affiliateCode || click.affiliateId || null;
  const isCode = Boolean(click.affiliateCode);

  if (click.dealId && affiliateIdentifier) {
    const clickQuery = isCode
      ? 'SELECT COUNT(*) as count FROM deal_clicks WHERE deal_id = ? AND affiliate_code = ?'
      : 'SELECT COUNT(*) as count FROM deal_clicks WHERE deal_id = ? AND affiliate_id = ?';

    const convQuery = isCode
      ? "SELECT COUNT(*) as count FROM conversions WHERE deal_id = ? AND affiliate_code = ? AND (status = 'confirmed' OR status = 'approved')"
      : "SELECT COUNT(*) as count FROM conversions WHERE deal_id = ? AND affiliate_id = ? AND (status = 'confirmed' OR status = 'approved')";

    const [clicksRes, convsRes] = await Promise.all([
      db
        .prepare(clickQuery)
        .bind(click.dealId, affiliateIdentifier)
        .first<{ count?: number; 'COUNT(*)': number; total?: number }>(),
      db
        .prepare(convQuery)
        .bind(click.dealId, affiliateIdentifier)
        .first<{ count?: number; 'COUNT(*)': number; total?: number }>(),
    ]);

    const totalClicks = clicksRes?.count ?? clicksRes?.['COUNT(*)'] ?? clicksRes?.total ?? 0;
    const totalConversions = convsRes?.count ?? convsRes?.['COUNT(*)'] ?? convsRes?.total ?? 0;

    if (totalClicks >= minClicksForRatioCheck) {
      const ratio = totalConversions === 0 ? Infinity : totalClicks / totalConversions;

      if (ratio > maxClickToConversionRatio) {
        ratioAnomalyDetected = true;
        isSuspicious = true;
        flagReasons.push(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
        ratioScore = 0.70;

        ratioDetails = {
          affiliateCode: click.affiliateCode ?? null,
          dealId: click.dealId,
          totalClicks,
          totalConversions,
          clickToConvRatio: ratio,
          convToClickRatio: totalConversions === 0 ? 0 : totalConversions / totalClicks,
          lookbackWindowHours: thresholds?.lookbackWindowSeconds
            ? thresholds.lookbackWindowSeconds / 3600
            : 24,
        };
      }
    }
  }

  // 3. Multi-Anomaly Score Stacking (Test C5 compliance)
  if (burstDetected && ratioAnomalyDetected) {
    // Probabilistic union formula: 1 - (1 - scoreBurst) * (1 - scoreRatio)
    anomalyScore = 1 - (1 - burstScore) * (1 - ratioScore);
  } else if (burstDetected) {
    anomalyScore = burstScore;
  } else if (ratioAnomalyDetected) {
    anomalyScore = ratioScore;
  } else {
    anomalyScore = 0.0;
  }

  // Clamp to [0.0, 1.0] and format to 4 decimals
  anomalyScore = Math.min(1.0, Math.max(0.0, Math.round(anomalyScore * 10000) / 10000));

  return {
    isSuspicious,
    anomalyScore,
    flagReasons,
    burstDetected,
    burstDetails,
    ratioAnomalyDetected,
    ratioDetails,
    rateLimitViolated: false,
    isIpBlocked: false,
  };
}
