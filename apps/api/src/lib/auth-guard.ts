import type { MiddlewareHandler } from 'hono'
import { auth, type Session } from '../auth'
import { ApiError } from './api-error'

/** 挂在路由上后，c.get('authUser') 可拿到当前登录用户。 */
export type AuthEnv = { Variables: { authUser: Session['user'] } }

/**
 * 认证守卫：无有效 session 时抛 401（由全局 onError 转成统一错误体）。
 * 用法：new Hono<AuthEnv>().use('*', requireAuth)
 */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    throw new ApiError('UNAUTHORIZED', 'Authentication required.', 401)
  }
  c.set('authUser', session.user)
  await next()
}
