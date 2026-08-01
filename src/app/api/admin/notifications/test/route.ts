/**
 * POST /api/admin/notifications/test
 * Test connection for a specific notification channel
 */
import { NextRequest, NextResponse } from 'next/server';
import { error as logError } from '@/lib/logger';
import { requireAdmin } from '../../actions';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    const { testNotificationConnection } = await import('@/app/[locale]/admin/settings/actions');
    const body = await request.json();
    const { channelType, config } = body as {
      channelType: 'slack' | 'email' | 'telegram';
      config: Record<string, unknown>;
    };

    if (!channelType || !config) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: channelType, config' },
        { status: 400 }
      );
    }

    const result = await testNotificationConnection(channelType, config as any);
    return NextResponse.json(result);
  } catch (error) {
    logError('Notification test failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
