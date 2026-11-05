import { Hono } from 'hono'
import { type AuthEnv, requireAuth } from '../lib/auth-guard'
import { deleteMemory, lintMemories, listAllMemories } from '../memory/store'

/**
 * Memory 管理路由（前端 /memory、/lint 命令的数据源）。
 * GET    /        全部记忆（含已过期，管理视图，仅当前用户）
 * GET    /lint    记忆体检报告
 * DELETE /:id     删除单条
 */
export const memoryRoute = new Hono<AuthEnv>()
  .use('*', requireAuth)
  .get('/', async (c) => {
    return c.json({ memories: await listAllMemories(c.get('authUser').id) })
  })
  .get('/lint', async (c) => {
    return c.json(await lintMemories(c.get('authUser').id))
  })
  .delete('/:id', async (c) => {
    const ok = await deleteMemory(c.req.param('id'), c.get('authUser').id)
    return c.json({ ok })
  })
