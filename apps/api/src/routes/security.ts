import { zValidator } from '@hono/zod-validator'
import type { Context, Next } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { config } from '../config/loader'
import { ApiError, validationHook } from '../lib/api-error'
import { type AuthEnv, requireAuth } from '../lib/auth-guard'
import { getRole, hookPipeline, setRole } from '../security'
import { ROLES } from '../security/roles'

const roleSchema = z.object({ role: z.enum(ROLES) })

/**
 * 可切换全局角色的邮箱白名单（security.adminEmails）。
 * 未配置时不限制——仅在本地/内网使用；对外部署必须配置。
 */
function isRoleAdmin(email: string | undefined): boolean {
  const allowlist = config.security.adminEmails.map((item) => item.toLowerCase())
  return allowlist.length === 0 || allowlist.includes((email ?? '').toLowerCase())
}

/** 角色是进程级状态，一个请求会改所有会话，只允许管理员切换 */
async function requireRoleAdmin(c: Context<AuthEnv>, next: Next) {
  if (!isRoleAdmin(c.get('authUser').email)) {
    throw new ApiError('FORBIDDEN', '只有管理员可以切换执行角色', 403)
  }
  await next()
}

/**
 * 安全状态路由（admin 管理页的数据源）。
 * GET   /       当前角色 + 已注册 hook
 * PATCH /role   切换进程级角色（影响之后新建的 registry）
 *
 * 角色是进程级状态：切换后已在进行中的请求保持各自 registry 创建时的角色。
 */
export const securityRoute = new Hono<AuthEnv>()
  .use('*', requireAuth)
  .get('/', (c) => {
    return c.json({ role: getRole(), roles: ROLES, hooks: hookPipeline.list() })
  })
  .patch('/role', requireRoleAdmin, zValidator('json', roleSchema, validationHook), (c) => {
    const { role } = c.req.valid('json')
    setRole(role)
    return c.json({ role })
  })
