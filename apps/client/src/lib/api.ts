import type { AppType } from 'api'
import { hc } from 'hono/client'
import { cookies } from 'next/headers'

/**
 * Server-side Hono RPC client factory for Next.js Server Components.
 *
 * This runs on the server only, so it points at the API's absolute origin
 * (never exposed to the browser).
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3000'

/** 业务路由都要求登录：服务端组件必须把浏览器带来的 session cookie 转发给 API。 */
export async function createAuthedServerClient() {
  const cookieStore = await cookies()
  return hc<AppType>(API_URL, {
    headers: { cookie: cookieStore.toString() },
  })
}
