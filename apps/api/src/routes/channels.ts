import { zValidator } from '@hono/zod-validator'
import type { Context, Next } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { auth } from '../auth'
import { channelGateway } from '../channels'
import { pushDiscord } from '../channels/notify'
import { config } from '../config/loader'
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

/** 推送是外部广播：限制长度，避免超长文本被切成上千条消息触发限流 */
const pushSchema = z.object({
  text: z.string().trim().min(1).max(4000),
})

/** 测试消息会跑完整 Agent（含 bash/写文件工具），必须登录后才能触发 */
async function requireSession(c: Context, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) throw new ApiError('UNAUTHORIZED', '需要登录', 401)
  await next()
}

/**
 * 推送会向固定频道广播并 @ 用户，仅管理员可用。
 * 与 security 路由口径一致：adminEmails 为空时不限制（本地/内网）。
 */
async function requirePushAdmin(c: Context, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) throw new ApiError('UNAUTHORIZED', '需要登录', 401)
  const allowlist = config.security.adminEmails.map((item) => item.toLowerCase())
  const email = session.user.email?.toLowerCase() ?? ''
  if (allowlist.length > 0 && !allowlist.includes(email)) {
    throw new ApiError('FORBIDDEN', '只有管理员可以推送消息', 403)
  }
  await next()
}

/**
 * Channel 管理路由（admin 管理页的数据源）。
 * GET  /                 已注册通道列表
 * POST /feishu/test      模拟一条飞书消息走完整的 Agent 循环，返回回复（需登录）
 * POST /discord/push     主动推送到 Discord 通知频道（需登录）
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
      // 配置关闭飞书时通道不会注册，明确返回 409 而不是“未注册的通道”内部错误
      if (!channelGateway.has('feishu')) {
        throw new ApiError(
          'CHANNEL_DISABLED',
          '飞书通道未启用（channels.feishu.enabled=false）',
          409,
        )
      }
      const { text } = c.req.valid('json')
      const reply = await channelGateway.dispatch('feishu', { ...WEB_TEST, text }, false)
      return c.json({ reply })
    },
  )
  .post(
    '/discord/push',
    requirePushAdmin,
    zValidator('json', pushSchema, validationHook),
    async (c) => {
      const sent = await pushDiscord(c.req.valid('json').text)
      // 未配置频道或 bot 未连接时明确报错，而不是假装成功
      if (!sent) {
        throw new ApiError(
          'CHANNEL_DISABLED',
          'Discord 推送不可用：未配置通知频道，或 bot 未连接（检查 DISCORD_BOT_TOKEN / intents / 代理）',
          409,
        )
      }
      return c.json({ sent })
    },
  )
