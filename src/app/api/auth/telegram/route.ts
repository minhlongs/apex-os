/**
 * src/app/api/auth/telegram/route.ts
 *
 * Edge-Compatible Telegram Mini App (TMA) Authentication & Account Binding Route
 *
 * Features:
 * - Cryptographic Telegram WebApp initData HMAC-SHA256 verification
 * - 24-hour replay attack prevention (401 on expired) & future clock skew tolerance
 * - Dual-mode account binding:
 *     1. Linking pre-authenticated user session to Telegram identity
 *     2. Auto-provisioning unauthenticated TMA user with synthetic email tg_{id}@telegram.apexos.io
 * - Idempotent upsert into telegram_users
 * - 30-day session issuance in sessions table & Set-Cookie
 * - Cryptographic wallet address format validation & profile binding
 * - Viral referral attribution from start_param (ref_<code) or referral_code
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyTelegramInitData } from '@/lib/telegram/crypto';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import {
  buildGeoRestrictedResponse,
  evaluateGeoFence,
} from '@/lib/compliance/geo-fence';
import { isAscendancyGuardActive } from '@/lib/compliance/legacy-route-guards';
import { getDB, type D1Database } from '@/lib/db';
import {
  validateWalletAddress,
  type SupportedChain,
  SUPPORTED_CHAINS,
} from '@/lib/wallet/address-validation';
import {
  isPhase1PayoutChain,
  proposeTimelockedWalletChange,
} from '@/lib/wallet/timelock-wallet-service';
import {
  buildD1RateLimitResponse,
  enforcePersistentD1RateLimit,
  extractTrustedClientIp,
} from '@/lib/security/d1-rate-limiter';
import {
  buildCsrfForbiddenResponse,
  verifyTrustedMutationOrigin,
} from '@/lib/security/http-hardening';
import { warn as logWarn, error as logError } from '@/lib/logger';
import type { TelegramAuthResponse } from '@/types/telegram';

/**
 * Resolves Cloudflare D1 database across edge Workers, request env, and test mocks
 */
function getDatabase(request?: Request): D1Database | null {
  if (request && 'env' in request && (request as any).env?.DB) {
    return (request as any).env.DB;
  }
  try {
    const db = resolveDatabase();
    if (db) return db;
  } catch {
    // Fallback below
  }
  try {
    return getDB();
  } catch {
    const globalDb = (globalThis as unknown as { DB?: D1Database }).DB;
    return globalDb || null;
  }
}

/**
 * Resolves Telegram bot API token from environment with non-prod fallback
 */
function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token && token.trim().length > 0) {
    return token.trim();
  }
  if (process.env.NODE_ENV !== 'production') {
    return 'test_bot_token';
  }
  return '';
}

export interface TelegramAuthRequestBody {
  initData: string;
  wallet_address?: string;
  walletAddress?: string;
  preferred_chain?: string;
  preferredChain?: string;
  referral_code?: string;
  referralCode?: string;
}

export interface ExtendedTelegramAuthResponse extends TelegramAuthResponse {
  session_token?: string;
  user?: {
    id: string;
    email: string;
    telegram_id: number;
    username: string | null;
    first_name: string;
    referral_code: string;
    wallet_address?: string | null;
    preferred_chain?: string | null;
    kyc_tier?: string;
    role?: string;
    plan?: string;
    tier?: string;
  };
  telegram_user?: {
    id: string;
    telegram_id: number;
    user_id: string | null;
    username: string | null;
    first_name: string;
    last_name: string | null;
    photo_url: string | null;
    language_code?: string;
    is_premium?: number;
    auth_date?: number | null;
  };
}

export async function POST(request: NextRequest): Promise<NextResponse<ExtendedTelegramAuthResponse>> {
  try {
    // 0. Enforce Edge Geo-Fence & Vietnam BLOCK_VN_SIGNUPS kill-switch even on direct route invocation
    const earlyDb = getDatabase(request);
    const geoDecision = await evaluateGeoFence(request, { db: earlyDb });
    if (!geoDecision.allowed) {
      return buildGeoRestrictedResponse(geoDecision) as NextResponse<ExtendedTelegramAuthResponse>;
    }

    // 0b. Cross-site mutation defense (reject untrusted Origin/Referer or cross-site Sec-Fetch-Site)
    const csrfDecision = verifyTrustedMutationOrigin(request);
    if (!csrfDecision.allowed) {
      return buildCsrfForbiddenResponse(
        csrfDecision
      ) as NextResponse<ExtendedTelegramAuthResponse>;
    }

    // 1. Parse JSON body
    let body: TelegramAuthRequestBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Missing request body' },
        { status: 400 }
      );
    }

    const { initData } = body;
    if (!initData || typeof initData !== 'string' || initData.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid initData' },
        { status: 400 }
      );
    }

    // 2. Resolve Telegram Bot Token
    const botToken = getBotToken();
    if (!botToken) {
      logError('[Telegram Auth] Missing TELEGRAM_BOT_TOKEN environment variable in production');
      return NextResponse.json(
        { success: false, error: 'Server configuration error: missing bot token' },
        { status: 500 }
      );
    }

    // 2b. Persistent D1 IP rate limit across Worker isolates (15 req / 60s per IP)
    if (earlyDb) {
      const clientIp = extractTrustedClientIp(request);
      const tgIpRate = await enforcePersistentD1RateLimit(earlyDb, {
        endpointType: 'telegram_auth_ip',
        identifier: clientIp,
        maxRequests: 15,
        windowSeconds: 60,
      });
      if (!tgIpRate.allowed) {
        return buildD1RateLimitResponse(
          tgIpRate
        ) as NextResponse<ExtendedTelegramAuthResponse>;
      }
    }

    // 3. Cryptographically verify initData (with 24h replay attack prevention & future clock skew)
    const verification = await verifyTelegramInitData(initData, botToken);
    if (!verification.isValid || !verification.data) {
      return NextResponse.json(
        {
          success: false,
          error: verification.error || 'Invalid or expired initData',
        },
        { status: 401 }
      );
    }

    const { user: tgUser, auth_date: authDate, start_param: startParam } = verification.data;
    const ascendancyWalletGuard = await isAscendancyGuardActive(earlyDb, 'wallet_change_requests');

    // 4. Validate wallet address format if provided
    const rawAddress = (body.wallet_address ?? body.walletAddress)?.trim();
    const rawChain = (body.preferred_chain ?? body.preferredChain)?.trim().toLowerCase();

    let walletToBind: { address: string; chain: string } | null = null;
    if (rawAddress !== undefined && rawAddress !== null && rawAddress.length > 0) {
      if (!rawChain) {
        return NextResponse.json(
          { success: false, error: 'preferred_chain is required when wallet_address is provided' },
          { status: 400 }
        );
      }
      if (ascendancyWalletGuard) {
        if (!isPhase1PayoutChain(rawChain)) {
          return NextResponse.json(
            {
              success: false,
              error: `Unsupported blockchain network: '${rawChain}'. Phase 1 supports only: stellar, arbitrum, base`,
            },
            { status: 400 }
          );
        }
        walletToBind = { address: rawAddress, chain: rawChain };
      } else {
        if (!SUPPORTED_CHAINS.includes(rawChain as SupportedChain)) {
          return NextResponse.json(
            { success: false, error: `Unsupported blockchain network: '${rawChain}'` },
            { status: 400 }
          );
        }
        const supportedChain = rawChain as SupportedChain;
        if (!validateWalletAddress(rawAddress, supportedChain)) {
          return NextResponse.json(
            { success: false, error: `Invalid wallet address format for ${supportedChain} network` },
            { status: 400 }
          );
        }
        walletToBind = { address: rawAddress, chain: supportedChain };
      }
    }

    // 5. Acquire Cloudflare D1 Database
    const db = getDatabase(request);
    if (!db) {
      logError('[Telegram Auth] Database service unavailable');
      return NextResponse.json(
        { success: false, error: 'Database service unavailable' },
        { status: 503 }
      );
    }

    // 6. Dual-Mode Account Binding
    const authenticatedUser = await getAuthenticatedUser(request, db);

    let userId: string;
    let isNewUser = false;
    let profile: any = null;

    // Lookup existing telegram_users entry
    const existingTgUser = await db
      .prepare('SELECT * FROM telegram_users WHERE telegram_id = ? LIMIT 1')
      .bind(tgUser.id)
      .first<{
        id: string;
        telegram_id: number;
        user_id: string | null;
        username: string | null;
        first_name: string;
        last_name: string | null;
        photo_url: string | null;
        language_code: string;
        is_premium: number;
        auth_date: number | null;
      }>();

    if (authenticatedUser && authenticatedUser.id) {
      // ------------------------------------------------------------------------
      // Mode A: User is already authenticated in ApexOS -> Link profile
      // ------------------------------------------------------------------------
      userId = authenticatedUser.id;
      profile = await db
        .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
        .bind(userId)
        .first<any>();

      if (!profile) {
        // Fallback profile if session points to deleted user
        profile = {
          id: userId,
          email: authenticatedUser.email || `tg_${tgUser.id}@telegram.apexos.io`,
          role: 'shopper',
          plan: 'free',
          tier: 'BASIC',
          referral_code: `TG${tgUser.id}`,
        };
      }

      if (existingTgUser) {
        await db
          .prepare(
            `UPDATE telegram_users SET
              user_id = ?,
              username = ?,
              first_name = ?,
              last_name = ?,
              photo_url = ?,
              language_code = ?,
              is_premium = ?,
              auth_date = ?,
              last_active_at = datetime('now'),
              updated_at = datetime('now')
            WHERE telegram_id = ?`
          )
          .bind(
            userId,
            tgUser.username || null,
            tgUser.first_name,
            tgUser.last_name || null,
            tgUser.photo_url || null,
            tgUser.language_code || 'en',
            tgUser.is_premium ? 1 : 0,
            authDate,
            tgUser.id
          )
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO telegram_users (
              id, telegram_id, user_id, username, first_name, last_name, photo_url,
              language_code, is_premium, auth_date, last_active_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
          )
          .bind(
            crypto.randomUUID(),
            tgUser.id,
            userId,
            tgUser.username || null,
            tgUser.first_name,
            tgUser.last_name || null,
            tgUser.photo_url || null,
            tgUser.language_code || 'en',
            tgUser.is_premium ? 1 : 0,
            authDate
          )
          .run();
      }
    } else {
      // ------------------------------------------------------------------------
      // Mode B: Unauthenticated TMA user -> Lookup or auto-provision
      // ------------------------------------------------------------------------
      if (existingTgUser && existingTgUser.user_id) {
        profile = await db
          .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
          .bind(existingTgUser.user_id)
          .first<any>();
      }

      if (profile && profile.id) {
        // Existing user returning
        userId = profile.id;
        isNewUser = false;

        await db
          .prepare(
            `UPDATE telegram_users SET
              username = ?,
              first_name = ?,
              last_name = ?,
              photo_url = ?,
              language_code = ?,
              is_premium = ?,
              auth_date = ?,
              last_active_at = datetime('now'),
              updated_at = datetime('now')
            WHERE telegram_id = ?`
          )
          .bind(
            tgUser.username || null,
            tgUser.first_name,
            tgUser.last_name || null,
            tgUser.photo_url || null,
            tgUser.language_code || 'en',
            tgUser.is_premium ? 1 : 0,
            authDate,
            tgUser.id
          )
          .run();
      } else {
        // Auto-provision new user
        const syntheticEmail = `tg_${tgUser.id}@telegram.apexos.io`;

        // Check if profile with synthetic email already exists to guarantee idempotency
        const existingEmailProfile = await db
          .prepare('SELECT * FROM profiles WHERE email = ? LIMIT 1')
          .bind(syntheticEmail)
          .first<any>();

        if (existingEmailProfile && existingEmailProfile.id) {
          userId = existingEmailProfile.id;
          profile = existingEmailProfile;
          isNewUser = false;
        } else {
          userId = crypto.randomUUID();
          isNewUser = true;

          const fullName =
            [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || tgUser.first_name;
          const referralCode = `TG${tgUser.id}`;

          await db
            .prepare(
              `INSERT INTO profiles (
                id, email, full_name, avatar_url, role, plan, tier, referral_code, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'shopper', 'free', 'BASIC', ?, datetime('now'), datetime('now'))`
            )
            .bind(userId, syntheticEmail, fullName, tgUser.photo_url || null, referralCode)
            .run();

          // Try initializing referral_tree root node for new user
          try {
            await db
              .prepare(
                `INSERT INTO referral_tree (
                  id, affiliate_id, level, is_active, joined_at, updated_at
                ) VALUES (?, ?, 1, 1, datetime('now'), datetime('now'))`
              )
              .bind(crypto.randomUUID(), userId)
              .run();
          } catch (treeErr) {
            logWarn('[Telegram Auth] Referral tree init warning:', treeErr);
          }

          profile = {
            id: userId,
            email: syntheticEmail,
            full_name: fullName,
            avatar_url: tgUser.photo_url || null,
            role: 'shopper',
            plan: 'free',
            tier: 'BASIC',
            referral_code: referralCode,
          };
        }

        // Upsert into telegram_users
        if (existingTgUser) {
          await db
            .prepare(
              `UPDATE telegram_users SET
                user_id = ?,
                username = ?,
                first_name = ?,
                last_name = ?,
                photo_url = ?,
                language_code = ?,
                is_premium = ?,
                auth_date = ?,
                last_active_at = datetime('now'),
                updated_at = datetime('now')
              WHERE telegram_id = ?`
            )
            .bind(
              userId,
              tgUser.username || null,
              tgUser.first_name,
              tgUser.last_name || null,
              tgUser.photo_url || null,
              tgUser.language_code || 'en',
              tgUser.is_premium ? 1 : 0,
              authDate,
              tgUser.id
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO telegram_users (
                id, telegram_id, user_id, username, first_name, last_name, photo_url,
                language_code, is_premium, auth_date, last_active_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
            )
            .bind(
              crypto.randomUUID(),
              tgUser.id,
              userId,
              tgUser.username || null,
              tgUser.first_name,
              tgUser.last_name || null,
              tgUser.photo_url || null,
              tgUser.language_code || 'en',
              tgUser.is_premium ? 1 : 0,
              authDate
            )
            .run();
        }
      }
    }

    // 7. Wallet Binding (48h Timelock enforced when Ascendancy schema/runtime is active)
    if (walletToBind) {
      if (ascendancyWalletGuard) {
        const proposal = await proposeTimelockedWalletChange(db, {
          authenticatedUserId: userId,
          proposedAddress: walletToBind.address,
          proposedChain: walletToBind.chain,
          requestedIp:
            request.headers.get('cf-connecting-ip') ??
            request.headers.get('x-forwarded-for') ??
            null,
        });
        if (!proposal.success) {
          return NextResponse.json(
            {
              success: false,
              error: proposal.error || 'Wallet change rejected by 48-hour timelock policy',
            },
            { status: proposal.status }
          );
        }
      } else {
        await db
          .prepare(
            `UPDATE profiles SET
              wallet_address = ?,
              preferred_chain = ?,
              updated_at = datetime('now')
            WHERE id = ?`
          )
          .bind(walletToBind.address, walletToBind.chain, userId)
          .run();

        profile.wallet_address = walletToBind.address;
        profile.preferred_chain = walletToBind.chain;

        try {
          await db
            .prepare(
              `INSERT INTO wallet_connections (id, profile_id, wallet_address, preferred_chain, is_primary, connected_at, last_used_at)
               VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
               ON CONFLICT (profile_id, wallet_address) DO UPDATE SET
                 preferred_chain = excluded.preferred_chain,
                 is_primary = 1,
                 last_used_at = datetime('now')`
            )
            .bind(crypto.randomUUID(), userId, walletToBind.address, walletToBind.chain)
            .run();
        } catch (wcErr) {
          logWarn('[Telegram Auth] wallet_connections upsert notice:', wcErr);
        }
      }
    }

    // 8. Viral Referral Tree Attribution
    let rawRefParam = (body.referral_code ?? body.referralCode)?.trim();
    if (!rawRefParam && startParam) {
      rawRefParam = startParam.trim();
    }

    if (rawRefParam && rawRefParam.length > 0) {
      const strippedCode = rawRefParam.startsWith('ref_') ? rawRefParam.slice(4) : rawRefParam;

      // Resolve referrer from profiles or affiliate_codes
      let referrerProfile = await db
        .prepare(
          `SELECT id, referral_code FROM profiles
           WHERE UPPER(referral_code) = UPPER(?) OR UPPER(referral_code) = UPPER(?)
           LIMIT 1`
        )
        .bind(strippedCode, rawRefParam)
        .first<{ id: string; referral_code: string }>();

      if (!referrerProfile) {
        try {
          const affCode = await db
            .prepare(
              `SELECT affiliate_id as id, code as referral_code FROM affiliate_codes
               WHERE UPPER(code) = UPPER(?) OR UPPER(code) = UPPER(?)
               LIMIT 1`
            )
            .bind(strippedCode, rawRefParam)
            .first<{ id: string; referral_code: string }>();
          if (affCode) {
            referrerProfile = affCode;
          }
        } catch {
          // affiliate_codes query fallback
        }
      }

      // Prevent self-referral
      if (referrerProfile && referrerProfile.id && referrerProfile.id !== userId) {
        try {
          // Lookup referrer telegram_id if linked
          const referrerTg = await db
            .prepare('SELECT telegram_id FROM telegram_users WHERE user_id = ? LIMIT 1')
            .bind(referrerProfile.id)
            .first<{ telegram_id: number }>();
          const referrerTgId = referrerTg?.telegram_id ?? null;

          // Check if referee is already recorded in telegram_referrals
          const existingRef = await db
            .prepare('SELECT id FROM telegram_referrals WHERE referee_id = ? LIMIT 1')
            .bind(tgUser.id)
            .first<{ id: string }>();

          if (!existingRef) {
            // Atomically record referral
            await db
              .prepare(
                `INSERT INTO telegram_referrals (
                  id, referrer_id, referee_id, referrer_user_id, referee_user_id,
                  referral_code, status, reward_amount, reward_currency, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0.00, 'USD', datetime('now'), datetime('now'))`
              )
              .bind(
                crypto.randomUUID(),
                referrerTgId,
                tgUser.id,
                referrerProfile.id,
                userId,
                rawRefParam
              )
              .run();

            // Link referrer into profile
            await db
              .prepare(
                `UPDATE profiles SET referred_by = ?, updated_at = datetime('now')
                 WHERE id = ? AND (referred_by IS NULL OR referred_by = '')`
              )
              .bind(referrerProfile.id, userId)
              .run();

            // Link into referral_tree
            try {
              const referrerNode = await db
                .prepare(
                  `SELECT id, root_id, level, path FROM referral_tree WHERE affiliate_id = ? LIMIT 1`
                )
                .bind(referrerProfile.id)
                .first<{ id: string; root_id: string | null; level: number; path: string | null }>();

              if (referrerNode) {
                const parentId = referrerNode.id;
                const rootId = referrerNode.root_id || referrerNode.id;
                const newLevel = Math.min((referrerNode.level || 1) + 1, 10);
                const newPath = referrerNode.path
                  ? `${referrerNode.path}/${userId}`
                  : `${referrerNode.id}/${userId}`;

                const existingRefereeNode = await db
                  .prepare(`SELECT id FROM referral_tree WHERE affiliate_id = ? LIMIT 1`)
                  .bind(userId)
                  .first<{ id: string }>();

                if (existingRefereeNode) {
                  await db
                    .prepare(
                      `UPDATE referral_tree SET
                        parent_id = ?, root_id = ?, level = ?, path = ?, updated_at = datetime('now')
                       WHERE affiliate_id = ?`
                    )
                    .bind(parentId, rootId, newLevel, newPath, userId)
                    .run();
                } else {
                  await db
                    .prepare(
                      `INSERT INTO referral_tree (
                        id, affiliate_id, parent_id, root_id, level, path, is_active, joined_at, updated_at
                      ) VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`
                    )
                    .bind(crypto.randomUUID(), userId, parentId, rootId, newLevel, newPath)
                    .run();
                }

                await db
                  .prepare(
                    `UPDATE referral_tree SET
                      total_direct_referrals = total_direct_referrals + 1,
                      updated_at = datetime('now')
                    WHERE id = ?`
                  )
                  .bind(referrerNode.id)
                  .run();
              }
            } catch (treeLinkErr) {
              logWarn('[Telegram Auth] Referral tree link notice:', treeLinkErr);
            }
          }
        } catch (refErr) {
          logWarn('[Telegram Auth] Referral attribution warning:', refErr);
        }
      }
    }

    // 9. Session Issuance (30-day expiry)
    const sessionId = crypto.randomUUID();
    const sessionToken =
      crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await db
      .prepare(
        `INSERT INTO sessions (id, user_id, token, expires_at, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      )
      .bind(sessionId, userId, sessionToken, expiresAt)
      .run();

    // 10. Fetch current state of records for response
    const freshProfile =
      (await db
        .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
        .bind(userId)
        .first<any>()) || profile;

    const freshTgUser = await db
      .prepare('SELECT * FROM telegram_users WHERE telegram_id = ? LIMIT 1')
      .bind(tgUser.id)
      .first<{
        id: string;
        telegram_id: number;
        user_id: string | null;
        username: string | null;
        first_name: string;
        last_name: string | null;
        photo_url: string | null;
        language_code: string;
        is_premium: number;
        auth_date: number | null;
      }>();

    const responsePayload: ExtendedTelegramAuthResponse = {
      success: true,
      token: sessionToken,
      session_token: sessionToken,
      is_new_user: isNewUser,
      user: {
        id: freshProfile.id || userId,
        email: freshProfile.email || `tg_${tgUser.id}@telegram.apexos.io`,
        telegram_id: tgUser.id,
        username: tgUser.username || null,
        first_name: tgUser.first_name,
        referral_code: freshProfile.referral_code || `TG${tgUser.id}`,
        wallet_address: freshProfile.wallet_address || null,
        preferred_chain: freshProfile.preferred_chain || null,
        kyc_tier: freshProfile.kyc_tier || 'tier0_unverified',
        role: freshProfile.role || 'shopper',
        plan: freshProfile.plan || 'free',
        tier: freshProfile.tier || 'BASIC',
      },
      telegram_user: {
        id: freshTgUser?.id || sessionId,
        telegram_id: tgUser.id,
        user_id: userId,
        username: tgUser.username || null,
        first_name: tgUser.first_name,
        last_name: tgUser.last_name || null,
        photo_url: tgUser.photo_url || null,
        language_code: tgUser.language_code || 'en',
        is_premium: tgUser.is_premium ? 1 : 0,
        auth_date: authDate,
      },
    };

    const isProd = process.env.NODE_ENV === 'production';
    const cookieString = `session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${isProd ? '; Secure' : ''}`;

    const response = NextResponse.json(responsePayload, {
      status: 200,
      headers: {
        'Set-Cookie': cookieString,
      },
    });

    return response;
  } catch (error) {
    logError('[Telegram Auth] Unexpected error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal Server Error',
      },
      { status: 500 }
    );
  }
}
