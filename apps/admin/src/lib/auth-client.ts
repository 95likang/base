import { createAuthClient } from 'better-auth/react'

/**
 * Better Auth 浏览器客户端。不传 baseURL（默认当前 origin），
 * 因为 Vite 已把 /api/* 代理到 Hono 服务器（见 vite.config.ts），
 * 同源请求 cookie 自动携带，无 CORS 问题。
 */
export const authClient = createAuthClient()
