import { Hono } from 'hono'
import { deleteMemory, listAllMemories } from '../memory/store'

/**
 * Memory 管理路由（前端 /memory 命令的数据源）。
 * GET    /        全部记忆（含已过期，管理视图）
 * DELETE /:id     删除单条
 */
export const memoryRoute = new Hono()
  .get('/', async (c) => {
    return c.json({ memories: await listAllMemories() })
  })
  .delete('/:id', async (c) => {
    const ok = await deleteMemory(c.req.param('id'))
    return c.json({ ok })
  })
