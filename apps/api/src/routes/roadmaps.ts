import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { ApiError, validationHook } from '../lib/api-error'
import { type AuthEnv, requireAuth } from '../lib/auth-guard'
import { completeSession, uncompleteSession } from '../roadmap/service'
import { parseRoadmapContent, summarizeRoadmap } from '../roadmap/spec'
import { deleteRoadmap, getRoadmap, listRoadmapContents, listRoadmaps } from '../roadmap/store'

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
 * GET  /stats                                     当前用户的计划数 / 已完成 / 总训练数
 * GET  /:id                                       单个计划；不存在返回 404
 * DELETE /:id                                     删除计划；不存在返回 404
 * POST /:id/sessions/:phaseIndex/:sessionIndex/complete
 *                                                 记录一次完成，生成建议并写回
 * POST /:id/sessions/:phaseIndex/:sessionIndex/uncomplete
 *                                                 撤销完成记录（误点兜底）
 *
 * 全部要求登录，且只能访问自己的计划。
 */
export const roadmapsRoute = new Hono<AuthEnv>()
  .use('*', requireAuth)
  .get('/', async (c) => {
    return c.json({ roadmaps: await listRoadmaps(c.get('authUser').id) })
  })
  // 必须排在 /:id 之前，否则 "stats" 会被当成 id
  .get('/stats', async (c) => {
    const contents = await listRoadmapContents(c.get('authUser').id)
    // 与「我的计划」列表同口径：解析失败的记录不计入任何统计
    const summaries = contents.flatMap((content) => {
      const parsed = parseRoadmapContent(content)
      return parsed ? [summarizeRoadmap(parsed)] : []
    })
    return c.json({
      plans: summaries.length,
      done: summaries.reduce((count, summary) => count + summary.done, 0),
      total: summaries.reduce((count, summary) => count + summary.total, 0),
    })
  })
  .get('/:id', async (c) => {
    const roadmap = await getRoadmap(c.req.param('id'), c.get('authUser').id)
    if (!roadmap) {
      throw new ApiError('ROADMAP_NOT_FOUND', 'Roadmap not found.', 404)
    }
    return c.json({ roadmap })
  })
  .delete('/:id', async (c) => {
    if (!(await deleteRoadmap(c.req.param('id'), c.get('authUser').id))) {
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
        userId: c.get('authUser').id,
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
      const content = await uncompleteSession({
        roadmapId: id,
        userId: c.get('authUser').id,
        phaseIndex,
        sessionIndex,
      })
      return c.json({ content })
    },
  )
