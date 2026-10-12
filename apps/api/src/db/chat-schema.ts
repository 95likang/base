import type { UIMessage } from 'ai'
import { relations } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * 聊天会话。title 由第一条用户消息自动生成（demo 简化，不额外调 LLM）。
 */
export const chat = pgTable('chat', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text('title').notNull().default('新会话'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
})

/**
 * 聊天消息。直接存 UIMessage 的 JSON 形状（role + parts），
 * 恢复历史时无需任何转换即可喂回 useChat。
 */
export const chatMessage = pgTable(
  'chat_message',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    parts: jsonb('parts').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('chat_message_chatId_idx').on(table.chatId)],
)

export const chatRelations = relations(chat, ({ many }) => ({
  messages: many(chatMessage),
}))

export const chatMessageRelations = relations(chatMessage, ({ one }) => ({
  chat: one(chat, {
    fields: [chatMessage.chatId],
    references: [chat.id],
  }),
}))

export type Chat = typeof chat.$inferSelect
export type ChatMessageRow = typeof chatMessage.$inferSelect
/** 数据库行 → UIMessage（补回 id 与可选 metadata） */
export function toUIMessage(row: ChatMessageRow): UIMessage {
  return {
    id: row.id,
    role: row.role as UIMessage['role'],
    parts: row.parts as UIMessage['parts'],
  }
}
