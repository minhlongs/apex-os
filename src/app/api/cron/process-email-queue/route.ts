import { NextRequest, NextResponse } from 'next/server';
import { warn as logWarn, info as logInfo, error as logError } from '@/lib/logger';
import { processEmailQueue, retryFailedEmails } from '@/lib/emails/email-scheduler';

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    logWarn('[Email:Cron] Unauthorized email queue request');
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const retries = url.searchParams.get('retries');

  try {
    if (action === 'retry') {
      const max = retries ? parseInt(retries, 10) : 3;
      const result = await retryFailedEmails(Number.isFinite(max) ? max : 3);
      logInfo(`[Email:Cron] Retried ${result.processed} emails: ${result.sent} sent, ${result.failed} failed`);
      return NextResponse.json({ success: true, processed: result.processed, sent: result.sent, failed: result.failed });
    }

    const result = await processEmailQueue();
    logInfo(`[Email:Cron] Processed ${result.processed} emails: ${result.sent} sent, ${result.failed} failed`);
    return NextResponse.json({ success: true, processed: result.processed, sent: result.sent, failed: result.failed, errors: result.errors });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('[Email:Cron] Email queue processing failed:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
