/**
 * Better Auth factory — accepts D1 binding at call time.
 * Avoids kysely version conflicts by using custom D1 adapter.
 */

import { createD1Adapter, D1Database } from './adapters/d1-adapter'

export interface AuthEnv {
  DB: D1Database
}

export function createAuth(env: AuthEnv): any {
  // Lazy-load better-auth so CommonJS Jest runners that mock or skip Better Auth
  // do not fail on top-level ESM-only transitive imports at module load time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { betterAuth } = require('better-auth') as { betterAuth: (opts: Record<string, unknown>) => unknown }
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
