import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './db'

/**
 * Better Auth instance wired to the same Drizzle/Postgres connection the rest
 * of the API uses. Run `pnpm --filter api db:generate` after enabling plugins
 * so the auth tables land in the schema snapshot.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: {
    enabled: true,
  },
})

export type Session = typeof auth.$Infer.Session
