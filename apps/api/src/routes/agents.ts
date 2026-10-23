import { Hono } from 'hono'
import { subAgentRegistry } from '../agents'
import { type AuthEnv, requireAuth } from '../lib/auth-guard'

/**
 * 子 Agent 运行记录（管理页数据源）。
 * GET / 运行列表 + 并发/深度配置
 */
export const agentsRoute = new Hono<AuthEnv>().use('*', requireAuth).get('/', (c) =>
  c.json({
    runs: subAgentRegistry.getAllRuns(),
    config: subAgentRegistry.getConfig(),
  }),
)
