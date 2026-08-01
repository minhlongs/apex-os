import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRole } from '@/lib/auth-guard';
import { testStellarConnection } from '@/lib/admin/stellar-actions';
import { error as logError } from '@/lib/logger';

export async function POST(request: NextRequest) {
const admin = await requireAdminRole(request);
if (!admin) {
return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

try {
const result = await testStellarConnection();
return NextResponse.json(result);
} catch (error) {
logError('Stellar test connection error:', error);
return NextResponse.json(
{ success: false, error: error instanceof Error ? error.message : 'Unknown error' },
{ status: 500 }
);
}
}
