import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { auth } from './auth'
import { usersRoute } from './routes/users'

process.loadEnvFile?.()

const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3001')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const app = new Hono()

app.use('*', logger())
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
const routes = app.get('/', (c) => c.json({ status: 'ok' })).route('/api/users', usersRoute)

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🚀 API listening on http://localhost:${info.port}`)
})

/**
 * The single source of truth for end-to-end type safety. Frontends import this
 * type and feed it to `hc<AppType>()` to get a fully typed RPC client.
 */
export type AppType = typeof routes
