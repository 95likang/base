import type { AppType } from 'api'
import { hc } from 'hono/client'

/**
 * Server-side Hono RPC client factory for Next.js Server Components.
 *
 * This runs on the server only, so it points at the API's absolute origin
 * (never exposed to the browser). 业务路由已要求登录，需要把浏览器传来的
 * session cookie 转发给 API：
 *
 *   const cookies = await cookies()
 *   const client = createServerClient(cookies.toString())
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3000'

export function createServerClient(cookieHeader?: string) {
  return hc<AppType>(API_URL, {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  })
}
