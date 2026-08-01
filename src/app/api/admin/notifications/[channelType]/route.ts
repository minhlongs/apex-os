/**
 * DELETE /api/admin/notifications/[channelType]
 * Delete notification channel configuration
 */
import { NextRequest, NextResponse } from 'next/server';
import { error as logError } from '@/lib/logger';
import { requireAdmin } from '../../actions';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ channelType: string }> }
): Promise<NextResponse> {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    const { channelType } = await params;
    const validChannels = ['slack', 'email', 'telegram'];

    if (!validChannels.includes(channelType)) {
      return NextResponse.json(
        { success: false, error: 'Invalid channel type' },
        { status: 400 }
      );
    }

    const kv = (globalThis as unknown as { KV: KVNamespace }).KV;
    if (!kv) {
      return NextResponse.json(
        { success: false, error: 'KV namespace not configured' },
        { status: 503 }
      );
    }

    const key = `notification_config:${channelType}`;
    await kv.delete(key);

    return NextResponse.json({
      success: true,
      data: { channelType, deleted: true },
    });
  } catch (error) {
    logError('Error deleting notification config:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete configuration' },
      { status: 500 }
    );
  }
}
