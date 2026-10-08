import type { AppType } from 'api'
import { hc } from 'hono/client'

/**
 * Server-side Hono RPC client for Next.js Server Components.
 *
 * This runs on the server only, so it points at the API's absolute origin
 * (never exposed to the browser). Keep secrets here — Server Components are the
 * secure place to attach auth cookies/headers before calling the API.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3000'

export const serverClient = hc<AppType>(API_URL)
