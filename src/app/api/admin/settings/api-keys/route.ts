import { error as logError } from '@/lib/logger';
/**
* Admin API Keys API Routes
* GET: lay danh sach keys
* POST: them key moi
* DELETE: xoa key
*/

import { NextRequest, NextResponse } from 'next/server'
import { requireAdminRole } from '@/lib/auth-guard'
import { getUserKeys, addApiKey, deleteApiKey } from '@/app/[locale]/admin/settings/api-keys/actions'

export async function GET() {
try {
const admin = await requireAdminRole()
if (!admin) {
return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
const keys = await getUserKeys()
return NextResponse.json({ keys })
} catch (error) {
logError('[Admin API Keys API] GET error:', error)
return NextResponse.json(
{ error: 'Khong the tai danh sach API keys' },
{ status: 500 }
)
}
}

export async function POST(request: NextRequest) {
try {
const admin = await requireAdminRole(request)
if (!admin) {
return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
const formData = await request.formData()
const result = await addApiKey(formData)

if (!result.success) {
return NextResponse.json(
{ error: result.error || 'Khong them API key' },
{ status: 400 }
)
}

return NextResponse.json({ success: true })
} catch (error) {
logError('[Admin API Keys API] POST error:', error)
return NextResponse.json(
{ error: 'Khong them API key' },
{ status: 500 }
)
}
}

export async function DELETE(request: NextRequest) {
try {
const admin = await requireAdminRole(request)
if (!admin) {
return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
const { searchParams } = new URL(request.url)
const provider = searchParams.get('provider')

if (!provider) {
return NextResponse.json(
{ error: 'Thieu tham so provider' },
{ status: 400 }
)
}

const result = await deleteApiKey(provider)

if (!result.success) {
return NextResponse.json(
{ error: result.error || 'Khong xoa API key' },
{ status: 400 }
)
}

return NextResponse.json({ success: true })
} catch (error) {
logError('[Admin API Keys API] DELETE error:', error)
return NextResponse.json(
{ error: 'Khong xoa API key' },
{ status: 500 }
)
}
}
