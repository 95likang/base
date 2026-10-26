import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { auth } from './auth'
import { channelGateway } from './channels'
import { config } from './config/loader'
import { startCron } from './cron/executor'
import { onError } from './lib/api-error'
import { flushObservability } from './observability'
import { pluginManager } from './plugins'
import { agentsRoute } from './routes/agents'
import { channelsRoute } from './routes/channels'
import { chatRoute, chatsRoute } from './routes/chat'
import { cronRoute } from './routes/cron'
import { memoryRoute } from './routes/memory'
import { pluginsRoute } from './routes/plugins'
import { ragRoute } from './routes/rag'
import { securityRoute } from './routes/security'
import { skillsRoute } from './routes/skills'
import { usageRoute } from './routes/usage'
import { usersRoute } from './routes/users'
import { getMcpTools } from './tools'

const app = new Hono()

app.use('*', logger())
// 全局错误处理：所有未捕获异常统一为 { error: { code, message } } 形状
app.onError(onError)
app.use(
  '/api/*',
  cors({
    origin: config.server.corsOrigins,
    credentials: true,
  }),
)

// Better Auth owns everything under /api/auth (sign-in, sign-up, session, ...).
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

// Mount feature routers under /api. Chaining `.route()` keeps the RPC types.
const routes = app
  .get('/', (c) => c.json({ status: 'ok' }))
  .route('/api/users', usersRoute)
  .route('/api/chats', chatsRoute)
  .route('/api/chat', chatRoute)
  .route('/api/agents', agentsRoute)
  .route('/api/channels', channelsRoute)
  .route('/api/cron', cronRoute)
  .route('/api/memory', memoryRoute)
  .route('/api/plugins', pluginsRoute)
  .route('/api/rag', ragRoute)
  .route('/api/security', securityRoute)
  .route('/api/skills', skillsRoute)
  .route('/api/usage', usageRoute)

const port = config.server.port
serve({ fetch: app.fetch, port }, async (info) => {
  console.log(`🚀 API listening on http://localhost:${info.port}`)
  // MCP 预热：启动时后台连接（不阻塞监听），首个对话请求不再承担 npx 拉起子进程的耗时
  void getMcpTools()
  // 插件按配置加载：空列表视为未配置，加载全部；enabled=false 的跳过
  console.log('  加载插件...')
  const pluginConfigs =
    config.plugins.length > 0
      ? config.plugins
      : pluginManager.list().map((plugin) => ({ name: plugin.name, enabled: true }))
  for (const pluginCfg of pluginConfigs) {
    if (!pluginManager.has(pluginCfg.name)) {
      console.log(`  ✗ ${pluginCfg.name} — 未知插件`)
      continue
    }
    if (!pluginCfg.enabled) {
      console.log(`  - ${pluginCfg.name} — 已禁用`)
      continue
    }
    try {
      const tools = await pluginManager.load(pluginCfg.name)
      console.log(`  ✓ ${pluginCfg.name} — ${tools.length} 个工具`)
    } catch {
      console.log(`  ✗ ${pluginCfg.name} — 加载失败`)
    }
  }
  // Channel 启动：单个通道失败不影响 API 与其它通道
  console.log('  启动 Channel...')
  await channelGateway.startAll()
  // Cron：从数据库恢复任务并注入 Agent 执行器（逾期的一次性任务会立即补跑）
  await startCron()
})

/**
 * The single source of truth for end-to-end type safety. Frontends import this
 * type and feed it to `hc<AppType>()` to get a fully typed RPC client.
 */
export type AppType = typeof routes

// 退出前 flush Langfuse 缓冲区：长驻服务靠后台批量上报，不 flush 会丢最后一批。
// Windows 上信号处理器不一定执行，属于尽力而为，失败也不阻塞退出。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void flushObservability()
  })
}
