import { Hono } from 'hono'
import { deleteMemory, lintMemories, listAllMemories } from '../memory/store'

/**
 * Memory 管理路由（前端 /memory、/lint 命令的数据源）。
 * GET    /        全部记忆（含已过期，管理视图）
 * GET    /lint    记忆体检报告
 * DELETE /:id     删除单条
 */
export const memoryRoute = new Hono()
  .get('/', async (c) => {
    return c.json({ memories: await listAllMemories() })
  })
  .get('/lint', async (c) => {
    return c.json(await lintMemories())
  })
  .delete('/:id', async (c) => {
    const ok = await deleteMemory(c.req.param('id'))
    return c.json({ ok })
  })
