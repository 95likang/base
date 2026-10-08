import type { AppType } from 'api'
import { hc } from 'hono/client'

/**
 * Typed Hono RPC client. `AppType` is imported from the `api` workspace package,
 * so every route, param, and response shape is inferred here with zero codegen.
 *
 * The base URL is relative ('/') because Vite proxies `/api/*` to the Hono
 * server in dev (see vite.config.ts). In production, point this at your API
 * origin via an env var.
 */
export const client = hc<AppType>(import.meta.env.VITE_API_URL ?? '/')
