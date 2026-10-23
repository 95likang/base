import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { auth } from './auth'
import { onError } from './lib/api-error'
import { pluginManager } from './plugins'
import { chatRoute, chatsRoute } from './routes/chat'
import { memoryRoute } from './routes/memory'
import { pluginsRoute } from './routes/plugins'
import { ragRoute } from './routes/rag'
import { skillsRoute } from './routes/skills'
import { usageRoute } from './routes/usage'
import { usersRoute } from './routes/users'
import { getMcpTools } from './tools'

process.loadEnvFile?.()

const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3001')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const app = new Hono()

app.use('*', logger())
// 全局错误处理：所有未捕获异常统一为 { error: { code, message } } 形状
app.onError(onError)
app.use(
  '/api/*',
  cors({
    origin: corsOrigins,
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
  .route('/api/memory', memoryRoute)
  .route('/api/plugins', pluginsRoute)
  .route('/api/rag', ragRoute)
  .route('/api/skills', skillsRoute)
  .route('/api/usage', usageRoute)

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port }, async (info) => {
  console.log(`🚀 API listening on http://localhost:${info.port}`)
  // MCP 预热：启动时后台连接（不阻塞监听），首个对话请求不再承担 npx 拉起子进程的耗时
  void getMcpTools()
  // 插件自动加载：单个插件失败不影响启动与其它插件
  console.log('  加载插件...')
  for (const plugin of pluginManager.list()) {
    try {
      const tools = await pluginManager.load(plugin.name)
      console.log(`  ✓ ${plugin.name} — ${tools.length} 个工具`)
    } catch {
      console.log(`  ✗ ${plugin.name} — 加载失败`)
    }
  }
})

/**
 * The single source of truth for end-to-end type safety. Frontends import this
 * type and feed it to `hc<AppType>()` to get a fully typed RPC client.
 */
export type AppType = typeof routes
