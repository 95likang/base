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
  // Better Auth 自带 CSRF 校验：请求 Origin 必须在信任列表内，否则登录请求会被拒。
  // 与 index.ts 的 CORS 白名单共用 CORS_ORIGINS。
  trustedOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  emailAndPassword: {
    enabled: true,
  },
})

export type Session = typeof auth.$Infer.Session
