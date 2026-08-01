import { getDB } from '@/lib/db'

export async function requireAdmin(): Promise<{ userId: string; role: string } | null> {
  const db = getDB()
  const { createAuth } = await import('@/lib/auth/auth-factory')

  const { headers: getHeaders, cookies } = await import('next/headers')
  const readonlyHeaders = await getHeaders()
  const cookieStore = await cookies()

  const headers = new Headers()
  readonlyHeaders.forEach((value, key) => headers.append(key, value))

  const cookiesObj: Record<string, string> = {}
  const allCookies = cookieStore.getAll()
  for (const cookie of allCookies) {
    cookiesObj[cookie.name] = cookie.value
  }

  const sessionResult = await createAuth({ DB: db }).api.getSession({
    headers,
    cookies: cookiesObj,
  })

  if (!sessionResult?.user) {
    return null
  }

  const userId = (sessionResult.user as { id: string }).id
  const profile = await db
    .prepare('SELECT role FROM profiles WHERE id = ?')
    .bind(userId)
    .first<{ role: string }>()

  if (!profile || profile.role !== 'admin') {
    return null
  }

  return { userId, role: profile.role }
}
