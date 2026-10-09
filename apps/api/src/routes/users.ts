import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db'
import { users } from '../db/schema'
import { ApiError, validationHook } from '../lib/api-error'

const listQuerySchema = z.object({
  // Optional case-insensitive search over the user's name.
  search: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

const createUserSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().email(),
})

const idParamSchema = z.object({
  id: z.string().min(1),
})

// PostgreSQL unique_violation SQLSTATE code.
const UNIQUE_VIOLATION = '23505'

/**
 * Users sub-router. Each handler validates its input with Zod before touching
 * the database, and the `.get`/`.post` chaining preserves the response types
 * that Hono RPC exposes to the frontends.
 */
export const usersRoute = new Hono()
  .get('/', zValidator('query', listQuerySchema, validationHook), async (c) => {
    const { search, limit } = c.req.valid('query')

    const rows = await db.query.users.findMany({
      where: search ? (u, { ilike }) => ilike(u.name, `%${search}%`) : undefined,
      limit,
      orderBy: (u, { desc }) => desc(u.createdAt),
    })

    return c.json({ users: rows })
  })
  .post('/', zValidator('json', createUserSchema, validationHook), async (c) => {
    const input = c.req.valid('json')

    try {
      const [created] = await db.insert(users).values(input).returning()
      return c.json({ user: created }, 201)
    } catch (err) {
      // 重复 email 触发 unique 约束 → 语义化 409，而不是 500。
      // 注意：Drizzle 会把 pg 错误包装成 DrizzleQueryError，原始错误在 `cause` 里。
      const pgErr = (err as { cause?: unknown }).cause ?? err
      const code =
        pgErr instanceof Error && 'code' in pgErr ? (pgErr as { code?: string }).code : undefined
      if (code === UNIQUE_VIOLATION) {
        throw new ApiError('EMAIL_TAKEN', 'A user with this email already exists.', 409)
      }
      throw err
    }
  })
  .get('/:id', zValidator('param', idParamSchema, validationHook), async (c) => {
    const { id } = c.req.valid('param')
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1)

    if (!user) {
      throw new ApiError('USER_NOT_FOUND', 'User not found.', 404)
    }

    return c.json({ user })
  })
