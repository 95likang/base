import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { ApiError, validationHook } from '../lib/api-error'
import { completeSession, uncompleteSession } from '../roadmap/service'
import { deleteRoadmap, getRoadmap, listRoadmaps } from '../roadmap/store'

const sessionParamSchema = z.object({
  id: z.string().min(1),
  phaseIndex: z.coerce.number().int().min(0),
  sessionIndex: z.coerce.number().int().min(0),
})

const completeBodySchema = z.object({
  note: z.string().trim().min(1).max(1000),
})

/**
 * 训练计划查询与完成记录。
 * GET  /                                          全部计划，最近更新的在前
 * GET  /:id                                       单个计划；不存在返回 404
 * DELETE /:id                                     删除计划；不存在返回 404
 * POST /:id/sessions/:phaseIndex/:sessionIndex/complete
 *                                                 记录一次完成，生成建议并写回
 * POST /:id/sessions/:phaseIndex/:sessionIndex/uncomplete
 *                                                 撤销完成记录（误点兜底）
 *
 * 无认证：与 /api/chats、/api/memory 一致。
 */
export const roadmapsRoute = new Hono()
  .get('/', async (c) => {
    return c.json({ roadmaps: await listRoadmaps() })
  })
  .get('/:id', async (c) => {
    const roadmap = await getRoadmap(c.req.param('id'))
    if (!roadmap) {
      throw new ApiError('ROADMAP_NOT_FOUND', 'Roadmap not found.', 404)
    }
    return c.json({ roadmap })
  })
  .delete('/:id', async (c) => {
    if (!(await deleteRoadmap(c.req.param('id')))) {
      throw new ApiError('ROADMAP_NOT_FOUND', 'Roadmap not found.', 404)
    }
    return c.json({ ok: true })
  })
  .post(
    '/:id/sessions/:phaseIndex/:sessionIndex/complete',
    zValidator('param', sessionParamSchema, validationHook),
    zValidator('json', completeBodySchema, validationHook),
    async (c) => {
      const { id, phaseIndex, sessionIndex } = c.req.valid('param')
      const { note } = c.req.valid('json')
      const content = await completeSession({
        roadmapId: id,
        phaseIndex,
        sessionIndex,
        note,
        signal: c.req.raw.signal,
      })
      return c.json({ content })
    },
  )
  .post(
    '/:id/sessions/:phaseIndex/:sessionIndex/uncomplete',
    zValidator('param', sessionParamSchema, validationHook),
    async (c) => {
      const { id, phaseIndex, sessionIndex } = c.req.valid('param')
      const content = await uncompleteSession({ roadmapId: id, phaseIndex, sessionIndex })
      return c.json({ content })
    },
  )
