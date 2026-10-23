import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { cronService } from '../cron'
import { detectScheduleType } from '../cron/parser'
import type { CronJobConfig } from '../cron/types'
import { ApiError, validationHook } from '../lib/api-error'
import { type AuthEnv, requireAuth } from '../lib/auth-guard'

const addSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, 'id 只能包含字母、数字、下划线和连字符'),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    schedule: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).optional(),
    handler: z.string().trim().min(1).optional(),
    timeout: z.coerce.number().int().min(1000).max(600_000).optional(),
    maxRetries: z.coerce.number().int().min(1).max(10).optional(),
  })
  .refine((data) => data.prompt || data.handler, {
    message: 'prompt 与 handler 至少提供一个',
    path: ['prompt'],
  })

const logsQuerySchema = z.object({
  jobId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

/**
 * Cron 管理路由（管理页数据源）。
 * GET    /                任务列表（含运行状态与上次执行记录）
 * GET    /logs            最近执行日志（可按 jobId 过滤）
 * POST   /                新建任务
 * DELETE /:id             删除任务
 * POST   /:id/run         立即执行一次
 * POST   /:id/enable      启用
 * POST   /:id/disable     禁用
 *
 * 均需登录：任务执行会跑完整 Agent（含工具调用）。
 */
export const cronRoute = new Hono<AuthEnv>()
  .use('*', requireAuth)
  .get('/', (c) => c.json({ jobs: cronService.list() }))
  .get('/logs', zValidator('query', logsQuerySchema, validationHook), async (c) => {
    const { jobId, limit } = c.req.valid('query')
    return c.json({ logs: await cronService.getRecentLogs(jobId, limit) })
  })
  .post('/', zValidator('json', addSchema, validationHook), async (c) => {
    const input = c.req.valid('json')
    if (cronService.list().some((job) => job.config.id === input.id)) {
      throw new ApiError('CRON_JOB_EXISTS', `任务 ${input.id} 已存在`, 409)
    }
    const config: CronJobConfig = {
      id: input.id,
      name: input.name,
      description: input.description,
      schedule: input.schedule,
      scheduleType: detectScheduleType(input.schedule),
      enabled: true,
      payload: input.handler
        ? { type: 'handler', handler: input.handler }
        : { type: 'agent', prompt: input.prompt ?? '' },
      timeout: input.timeout,
      maxRetries: input.maxRetries,
      source: 'runtime',
    }
    try {
      await cronService.add(config)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ApiError('CRON_JOB_INVALID', message, 400)
    }
    return c.json({ job: config }, 201)
  })
  .delete('/:id', async (c) => {
    if (!(await cronService.remove(c.req.param('id')))) {
      throw new ApiError('CRON_JOB_NOT_FOUND', '任务不存在', 404)
    }
    return c.json({ ok: true })
  })
  .post('/:id/run', async (c) => {
    const id = c.req.param('id')
    const job = cronService.list().find((item) => item.config.id === id)
    if (!job) {
      throw new ApiError('CRON_JOB_NOT_FOUND', '任务不存在', 404)
    }
    if (job.status === 'running') {
      throw new ApiError('CRON_JOB_RUNNING', '任务正在执行中', 409)
    }
    return c.json({ output: await cronService.runNow(id) })
  })
  .post('/:id/enable', async (c) => {
    if (!(await cronService.enable(c.req.param('id')))) {
      throw new ApiError('CRON_JOB_NOT_FOUND', '任务不存在', 404)
    }
    return c.json({ ok: true })
  })
  .post('/:id/disable', async (c) => {
    if (!(await cronService.disable(c.req.param('id')))) {
      throw new ApiError('CRON_JOB_NOT_FOUND', '任务不存在', 404)
    }
    return c.json({ ok: true })
  })
