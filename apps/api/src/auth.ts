import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { config } from './config/loader'
import { db } from './db'

/**
 * Better Auth instance wired to the same Drizzle/Postgres connection the rest
 * of the API uses. Run `pnpm --filter api db:generate` after enabling plugins
 * so the auth tables land in the schema snapshot.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  // 空字符串等同于未配置，交给 Better Auth 走默认/开发态行为
  secret: config.auth.secret || undefined,
  baseURL: config.auth.baseURL || undefined,
  // Better Auth 自带 CSRF 校验：请求 Origin 必须在信任列表内，否则登录请求会被拒。
  // 与 index.ts 的 CORS 白名单共用 server.corsOrigins。
  trustedOrigins: config.server.corsOrigins,
  emailAndPassword: {
    enabled: true,
  },
})

export type Session = typeof auth.$Infer.Session
