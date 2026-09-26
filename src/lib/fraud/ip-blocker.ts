import { NextResponse } from 'next/server';
import type { D1Database } from '@/types/d1';
import { BlockedIpRecord, FraudReasonCode } from '@/types/fraud';

/**
 * Normalizes an IP address:
 * - Trims whitespace
 * - Handles IPv4-mapped IPv6 (::ffff:192.0.2.128 -> 192.0.2.128)
 * - Preserves standard IPv6 (e.g. 2001:db8::1) and loopback (::1) in lowercase
 */
export function normalizeIpAddress(ip: string | null | undefined): string {
  if (!ip) return '';
  let trimmed = ip.trim().toLowerCase();
  if (trimmed.startsWith('::ffff:')) {
    trimmed = trimmed.substring(7);
  }
  return trimmed;
}

/**
 * Strict Cloudflare IP extraction precedence to prevent header spoofing:
 * 1. cf-connecting-ip (Cloudflare edge validated, non-tamperable)
 * 2. x-forwarded-for (leftmost client IP in proxy chain)
 * 3. x-real-ip
 * 4. Fallback: '127.0.0.1'
 */
export function extractClientIp(headers: Headers): string {
  const cfConnectingIp = headers.get('cf-connecting-ip')?.trim();
  if (cfConnectingIp && cfConnectingIp.length > 0) {
    return cfConnectingIp;
  }

  const xForwardedFor = headers.get('x-forwarded-for');
  if (xForwardedFor && xForwardedFor.trim().length > 0) {
    const leftmost = xForwardedFor.split(',')[0]?.trim();
    if (leftmost && leftmost.length > 0) {
      return leftmost;
    }
  }

  const xRealIp = headers.get('x-real-ip')?.trim();
  if (xRealIp && xRealIp.length > 0) {
    return xRealIp;
  }

  return '127.0.0.1';
}

/**
 * Check whether a blocked IP record is currently active and not expired
 */
function checkActiveNotExpired(row: BlockedIpRecord | { is_active?: number; expires_at?: string | null }): boolean {
  if (row.is_active !== undefined && row.is_active !== 1) {
    return false;
  }
  if (row.expires_at) {
    const expiresMs = new Date(row.expires_at).getTime();
    if (!isNaN(expiresMs) && expiresMs <= Date.now()) {
      return false; // Expired -> considered unblocked
    }
  }
  return true;
}

/**
 * Query whether an IP address is blocked in the blocked_ips table.
 * Supports dual-layer expiration validation:
 * - Active check: is_active = 1
 * - Expiration check: expires_at IS NULL OR expires_at > datetime('now')
 * Supports IPv4, full IPv6, loopback (::1), and mapped IPv6 (::ffff:x.x.x.x).
 */
export async function isIpBlocked(db: D1Database, rawIp: string): Promise<boolean> {
  if (!rawIp) return false;
  const ip = normalizeIpAddress(rawIp);
  if (!ip) return false;

  // 1. Primary lookup by normalized IP
  const row = await db
    .prepare(
      'SELECT id, ip_address, reason, blocked_by, expires_at, is_active FROM blocked_ips WHERE ip_address = ?'
    )
    .bind(ip)
    .first<BlockedIpRecord>();

  if (row) {
    return checkActiveNotExpired(row);
  }

  // 2. Fallback lookup by trimmed raw IP if different from normalized (e.g. ::ffff: prefix)
  const rawTrimmed = rawIp.trim().toLowerCase();
  if (rawTrimmed !== ip) {
    const altRow = await db
      .prepare(
        'SELECT id, ip_address, reason, blocked_by, expires_at, is_active FROM blocked_ips WHERE ip_address = ?'
      )
      .bind(rawTrimmed)
      .first<BlockedIpRecord>();

    if (altRow) {
      return checkActiveNotExpired(altRow);
    }
  }

  // 3. If IPv4, also check IPv4-mapped IPv6 representation
  if (!ip.includes(':')) {
    const mappedRow = await db
      .prepare(
        'SELECT id, ip_address, reason, blocked_by, expires_at, is_active FROM blocked_ips WHERE ip_address = ?'
      )
      .bind(`::ffff:${ip}`)
      .first<BlockedIpRecord>();

    if (mappedRow) {
      return checkActiveNotExpired(mappedRow);
    }
  }

  return false;
}

export interface AutoBlockOptions {
  durationSeconds?: number | null;
  blockedBy?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Automatically escalate an offending IP to the blocked_ips table
 */
export async function autoBlockOffender(
  db: D1Database,
  rawIp: string,
  reason: string = FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER,
  options: AutoBlockOptions = {}
): Promise<boolean> {
  const ip = normalizeIpAddress(rawIp) || rawIp.trim();
  if (!ip) return false;

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const now = new Date().toISOString();
  const blockedBy = options.blockedBy || 'system';
  const expiresAt = options.durationSeconds
    ? new Date(Date.now() + options.durationSeconds * 1000).toISOString()
    : null;

  await db
    .prepare(
      'INSERT INTO blocked_ips (id, ip_address, reason, blocked_by, created_at, expires_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(ip_address) DO UPDATE SET reason = excluded.reason, is_active = 1, expires_at = excluded.expires_at, created_at = excluded.created_at'
    )
    .bind(id, ip, reason, blockedBy, now, expiresAt)
    .run();

  return true;
}

/**
 * Unblock an IP address by removing or deactivating it in the blocked_ips table
 */
export async function unblockIp(db: D1Database, rawIp: string): Promise<boolean> {
  const ip = normalizeIpAddress(rawIp) || rawIp.trim();
  if (!ip) return false;

  await db.prepare('DELETE FROM blocked_ips WHERE ip_address = ?').bind(ip).run();
  return true;
}

/**
 * Generate standard RFC-compliant HTTP 403 Forbidden response for blocked IPs
 */
export function createBlockedIp403Response(): NextResponse {
  return NextResponse.json(
    {
      error: 'Forbidden',
      message: 'IP address blocked due to suspicious activity',
    },
    { status: 403 }
  );
}
