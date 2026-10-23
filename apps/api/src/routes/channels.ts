import { zValidator } from '@hono/zod-validator'
import type { Context, Next } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { auth } from '../auth'
import { channelGateway } from '../channels'
import { ApiError, validationHook } from '../lib/api-error'

/** Web 测试消息的固定身份：不投递到真实飞书，回复直接返回给管理页 */
const WEB_TEST = {
  channelId: 'web-test',
  senderId: 'web-dashboard',
  senderName: 'web-dashboard',
}

const testSchema = z.object({
  text: z.string().trim().min(1),
})

/** 测试消息会跑完整 Agent（含 bash/写文件工具），必须登录后才能触发 */
async function requireSession(c: Context, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) throw new ApiError('UNAUTHORIZED', '需要登录', 401)
  await next()
}

/**
 * Channel 管理路由（admin 管理页的数据源）。
 * GET  /                 已注册通道列表
 * POST /feishu/test      模拟一条飞书消息走完整的 Agent 循环，返回回复（需登录）
 *
 * Channel 状态只存在于当前进程：飞书未配置时通道仍注册，但不会建立长连接。
 */
export const channelsRoute = new Hono()
  .get('/', (c) => c.json({ channels: channelGateway.list() }))
  .post(
    '/feishu/test',
    requireSession,
    zValidator('json', testSchema, validationHook),
    async (c) => {
      const { text } = c.req.valid('json')
      const reply = await channelGateway.dispatch('feishu', { ...WEB_TEST, text }, false)
      return c.json({ reply })
    },
  )
