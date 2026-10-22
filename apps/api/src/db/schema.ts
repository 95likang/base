export * from './auth-schema'
export { user as users } from './auth-schema'
export * from './chat-schema'
export * from './memory-schema'

import type { user } from './auth-schema'

export type User = typeof user.$inferSelect
export type NewUser = typeof user.$inferInsert
