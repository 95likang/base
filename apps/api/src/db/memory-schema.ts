import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * 持久化记忆（跨会话）。四种类型：
 * - user: 用户画像（角色/偏好/技术背景/工作习惯），永久
 * - feedback: 用户对 Agent 行为的纠正与确认，永久
 * - project: 进行中的工作/决策/截止日期，expiresAt 过期后不再注入
 * - reference: 外部资源渠道（看板/面板/文档位置），永久
 * 单用户 demo，不加 userId（与 chat 表一致）。
 */
export const memory = pgTable('memory', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  type: text('type').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  content: text('content').notNull(),
  /** 仅 project 类型使用；NULL = 永久 */
  expiresAt: timestamp('expires_at'),
  /** 最近一次被 memory read 读取的时间；NULL = 从未读过（lint 的 TTL 判断用 updatedAt 兜底） */
  lastReadAt: timestamp('last_read_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
})

export type MemoryRow = typeof memory.$inferSelect
