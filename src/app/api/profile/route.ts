import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type ProfileExternalIds,
  type UpdateProfileInput,
} from '@/types/profile';
import { error as logError } from '@/lib/logger';
import { isAscendancyGuardActive } from '@/lib/compliance/legacy-route-guards';
import type { D1Database } from '@/lib/db';
import { parseExternalIds } from './exchange-keys/route';

interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  plan: string;
  referral_code: string | null;
  referred_by: string | null;
  notification_settings: string | null;
  external_ids?: string | null;
  created_at: string;
  updated_at: string;
}

interface GlobalD1 {
  DB?: {
    prepare: (sql: string) => {
      bind: (...args: unknown[]) => {
        first: <T = ProfileRow>() => Promise<T | null>;
        run: () => Promise<{ success: boolean }>;
      };
    };
  };
}

/**
 * Validation schema for notification settings update
 */
const NotificationSettingsSchema = z.object({
  enabled_channels: z.array(z.enum(['email', 'slack', 'telegram'])).min(1),
  severity_threshold: z.enum(['info', 'warning', 'critical']),
  channel_config: z.record(
    z.string(),
    z.object({
      enabled: z.boolean(),
      config: z.record(z.string(), z.unknown()).optional(),
    })
  ),
  quiet_hours: z.object({
    enabled: z.boolean(),
    start_hour: z.number().min(0).max(23),
    end_hour: z.number().min(0).max(23),
    timezone: z.string().optional(),
  }).optional(),
  email_override: z.string().email().optional().or(z.literal('')),
  weekly_summary_enabled: z.boolean(),
});

/**
 * GET /api/profile
 * Returns the current user's profile with role and notification settings
 */
export async function GET(request: NextRequest) {
  try {
    // Get session to identify user
    const sessionRes = await fetch(`${request.nextUrl.origin}/api/auth/session`, {
      headers: {
        cookie: request.headers.get('cookie') ?? '',
      },
      next: { revalidate: 0 },
    });

    if (!sessionRes.ok) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    const sessionData = await sessionRes.json();
    if (!sessionData?.user?.id) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    const userId = sessionData.user.id;

    const db = (globalThis as unknown as GlobalD1).DB ?? null;
    if (!db) {
      return NextResponse.json({ success: false, error: 'Database not configured' }, { status: 503 });
    }

    // Fetch profile with notification_settings
    const profile = await db
      .prepare(`
        SELECT id, email, full_name, role, plan, referral_code, referred_by, notification_settings, created_at, updated_at
        FROM profiles
        WHERE id = ?
      `)
      .bind(userId)
      .first<ProfileRow>();

    if (!profile) {
      return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 });
    }

    // Parse notification settings or use default
    let notificationSettings: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS;
    if (profile.notification_settings) {
      try {
        const parsed = JSON.parse(profile.notification_settings);
        // Merge with defaults to ensure all fields exist
        notificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...parsed };
      } catch (e) {
        logError('Failed to parse notification_settings:', e);
      }
    }

    const externalIds: ProfileExternalIds = parseExternalIds(profile.external_ids);

    return NextResponse.json({
      success: true,
      profile: {
        id: profile.id,
        email: profile.email,
        fullName: profile.full_name,
        role: profile.role,
        plan: profile.plan,
        referralCode: profile.referral_code,
        referredBy: profile.referred_by,
        notificationSettings,
        externalIds,
        createdAt: profile.created_at,
        updatedAt: profile.updated_at,
      },
    });
  } catch (error) {
    logError('Profile fetch error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/profile
 * Update user profile including notification settings
 */
export async function PATCH(request: NextRequest) {
  try {
    // Get session to identify user
    const sessionRes = await fetch(`${request.nextUrl.origin}/api/auth/session`, {
      headers: {
        cookie: request.headers.get('cookie') ?? '',
      },
      next: { revalidate: 0 },
    });

    if (!sessionRes.ok) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    const sessionData = await sessionRes.json();
    if (!sessionData?.user?.id) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    const userId = sessionData.user.id;

    const db = (globalThis as unknown as GlobalD1).DB ?? null;
    if (!db) {
      return NextResponse.json({ success: false, error: 'Database not configured' }, { status: 503 });
    }

    const body = await request.json();

    // Determine what fields are being updated
    const { notification_settings, ...profileUpdates } = body as UpdateProfileInput & { notification_settings?: NotificationSettings };

    // Build dynamic update query
    const updates: string[] = [];
    const bindValues: unknown[] = [];

    if (profileUpdates.full_name !== undefined) {
      updates.push('full_name = ?');
      bindValues.push(profileUpdates.full_name);
    }

    if (profileUpdates.avatar_url !== undefined) {
      updates.push('avatar_url = ?');
      bindValues.push(profileUpdates.avatar_url);
    }

    if (profileUpdates.preferred_chain !== undefined) {
      const guardActive = await isAscendancyGuardActive(
        db as unknown as D1Database,
        'wallet_change_requests'
      );
      if (guardActive) {
        return NextResponse.json(
          {
            success: false,
            code: 'USE_WALLET_TIMELOCK_ENDPOINT',
            error:
              'Direct preferred_chain modification is disabled; use POST /api/profile/wallet/timelock (48-hour timelock)',
          },
          { status: 409 }
        );
      }
      updates.push('preferred_chain = ?');
      bindValues.push(profileUpdates.preferred_chain);
    }

    // Handle notification settings if provided
    if (notification_settings) {
      // Validate notification settings
      const validated = NotificationSettingsSchema.parse(notification_settings);
      updates.push('notification_settings = ?');
      bindValues.push(JSON.stringify(validated));
    }

    if (updates.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No fields to update' },
        { status: 400 }
      );
    }

    // Add updated_at
    updates.push('updated_at = datetime("now")');

    // Build and execute query
    const query = `UPDATE profiles SET ${updates.join(', ')} WHERE id = ?`;
    bindValues.push(userId);

    const result = await db.prepare(query).bind(...bindValues).run();

    if (!result.success) {
      logError('Profile update failed:', result);
      return NextResponse.json(
        { success: false, error: 'Failed to update profile' },
        { status: 500 }
      );
    }

    // Fetch updated profile
    const updatedProfile = await db
      .prepare(`
        SELECT id, email, full_name, role, plan, referral_code, referred_by, notification_settings, created_at, updated_at
        FROM profiles
        WHERE id = ?
      `)
      .bind(userId)
      .first<ProfileRow>();

    if (!updatedProfile) {
      return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 });
    }

    // Parse notification settings
    let notificationSettings = DEFAULT_NOTIFICATION_SETTINGS;
    if (updatedProfile.notification_settings) {
      try {
        const parsed = JSON.parse(updatedProfile.notification_settings);
        notificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...parsed };
      } catch (e) {
        logError('Failed to parse notification_settings:', e);
      }
    }

    const externalIds: ProfileExternalIds = parseExternalIds(updatedProfile.external_ids);

    return NextResponse.json({
      success: true,
      profile: {
        id: updatedProfile.id,
        email: updatedProfile.email,
        fullName: updatedProfile.full_name,
        role: updatedProfile.role,
        plan: updatedProfile.plan,
        referralCode: updatedProfile.referral_code,
        referredBy: updatedProfile.referred_by,
        notificationSettings,
        externalIds,
        createdAt: updatedProfile.created_at,
        updatedAt: updatedProfile.updated_at,
      },
    });
  } catch (error) {
    logError('Profile update error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'Validation failed', details: error.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
