/**
 * Better Auth factory — accepts D1 binding at call time.
 * Avoids kysely version conflicts by using custom D1 adapter.
 */

import { createD1Adapter, D1Database } from './adapters/d1-adapter'

export interface AuthEnv {
  DB: D1Database
}

export interface BetterAuthSessionUser {
  id: string
  email?: string
  name?: string | null
  role?: string | null
}

export interface BetterAuthSessionPayload {
  user: BetterAuthSessionUser
  session: {
    id: string
    userId: string
    token: string
    expiresAt: Date | string
  }
}

export interface BetterAuthInstance {
  handler: (request: Request) => Promise<Response>
  api: {
    getSession: (context: {
      headers: Headers
      cookies?: Record<string, string>
    }) => Promise<BetterAuthSessionPayload | null>
  }
  options?: Record<string, unknown>
}

export function createAuth(env: AuthEnv): BetterAuthInstance {
  // Lazy-load better-auth so CommonJS Jest runners that mock or skip Better Auth
  // do not fail on top-level ESM-only transitive imports at module load time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { betterAuth } = require('better-auth') as {
    betterAuth: (opts: Record<string, unknown>) => BetterAuthInstance
  }
  return betterAuth({
    database: createD1Adapter({ db: env.DB }),
    basePath: '/api/auth',
    emailAndPassword: {
      enabled: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    secret: process.env.BETTER_AUTH_SECRET || 'dev-secret-change-in-production',
    plugins: [],
  })
}
