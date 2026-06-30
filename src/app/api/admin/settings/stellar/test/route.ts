import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRole } from '@/lib/auth-guard';
import { testStellarConnection } from '@/lib/admin/stellar-actions';

export async function POST(request: NextRequest) {
const admin = await requireAdminRole(request);
if (!admin) {
return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

try {
const result = await testStellarConnection();
return NextResponse.json(result);
} catch (error) {
console.error('Stellar test connection error:', error);
return NextResponse.json(
{ success: false, error: error instanceof Error ? error.message : 'Unknown error' },
{ status: 500 }
);
}
}
