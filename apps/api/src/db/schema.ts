import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Application `users` table.
 *
 * `id` is a database-generated UUID, `email` is unique, and `createdAt`
 * defaults to the insertion time. Drizzle infers the row types below so the
 * rest of the app never hand-writes a User shape.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
