import { NextRequest, NextResponse } from 'next/server';
import { warn as logWarn, info as logInfo, error as logError } from '@/lib/logger';
import { enqueueTransactional, enqueueCampaign, type QueueEmailInput } from '@/lib/emails/executor';

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

function badRequest(message: string) {
  return NextResponse.json({ success: false, error: message }, { status: 400 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    logWarn('[Email:Executor] Unauthorized task call');
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const payload = body as Record<string, unknown>;
  const taskType = typeof payload.taskType === 'string' ? payload.taskType.trim() : '';
  const data = (payload.payload ?? {}) as Record<string, unknown>;

  if (!taskType) return badRequest('Missing taskType');

  const knownTypes = new Set([
    'welcome',
    'commission-earned',
    'payout-completed',
    'weekly-summary',
    'deal-published',
    'referral-signed-up',
  ]);
  if (!knownTypes.has(taskType)) return badRequest(`Unsupported taskType: ${taskType}`);

  const to = typeof data.to === 'string' ? data.to : typeof data.email === 'string' ? data.email : '';
  if (!to) return badRequest('Missing recipient email in payload');

  const userId = typeof data.userId === 'string' ? data.userId : typeof data.email === 'string' ? data.email : '';
  const subject = typeof data.subject === 'string' ? data.subject : 'ApexOS Notification';
  const text = typeof data.text === 'string' ? data.text : '';
  const html = typeof data.html === 'string' ? data.html : '<p>Notification</p>';

  const input: QueueEmailInput = {
    userId,
    email: to,
    type: taskType,
    subject,
    html,
    text,
    priority: 1,
    scheduledAt: new Date().toISOString(),
    metadata: typeof data.metadata === 'object' && data.metadata ? { ...(data.metadata as Record<string, unknown>) } : undefined,
  };

  try {
    const transactional = taskType !== 'weekly-summary';
    const item = transactional ? enqueueTransactional(input) : enqueueCampaign(input);
    logInfo(`[Email:Executor] Queued ${taskType} for ${to}`);
    return NextResponse.json({ success: true, queueId: item.id, type: taskType, scheduledAt: item.scheduled_at });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('[Email:Executor] Failed to queue email task:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
