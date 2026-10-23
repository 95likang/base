import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { config } from '../config/loader'
import * as schema from './schema'

if (!config.database.url) {
  throw new Error(
    'DATABASE_URL is not set. Copy apps/api/.env.example to .env and fill it in (or set database.url in super-agent.config.json).',
  )
}

const pool = new Pool({ connectionString: config.database.url })

export const db = drizzle(pool, { schema })
export { schema }
