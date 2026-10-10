import { createAuthClient } from 'better-auth/react'

/**
 * Better Auth 浏览器客户端。不传 baseURL（默认当前 origin），
 * 因为 next.config.ts 已把 /api/* rewrite 到 Hono 服务器，
 * 同源请求 cookie 自动携带，无 CORS 问题。
 */
export const authClient = createAuthClient()
