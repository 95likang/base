import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db'
import { users } from '../db/schema'

const listQuerySchema = z.object({
  // Optional case-insensitive search over the user's name.
  search: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

const createUserSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().email(),
})

/**
 * Users sub-router. Each handler validates its input with Zod before touching
 * the database, and the `.get`/`.post` chaining preserves the response types
 * that Hono RPC exposes to the frontends.
 */
export const usersRoute = new Hono()
  .get('/', zValidator('query', listQuerySchema), async (c) => {
    const { search, limit } = c.req.valid('query')

    const rows = await db.query.users.findMany({
      where: search ? (u, { ilike }) => ilike(u.name, `%${search}%`) : undefined,
      limit,
      orderBy: (u, { desc }) => desc(u.createdAt),
    })

    return c.json({ users: rows })
  })
  .post('/', zValidator('json', createUserSchema), async (c) => {
    const input = c.req.valid('json')

    const [created] = await db.insert(users).values(input).returning()

    return c.json({ user: created }, 201)
  })
  .get('/:id', async (c) => {
    const id = c.req.param('id')
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1)

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    return c.json({ user })
  })
