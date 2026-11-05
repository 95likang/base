import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import type { RoadmapContent } from '../roadmap/spec'
import { chat } from './chat-schema'

/**
 * 训练路线图。两级结构（阶段 → 训练）整体存 JSONB：
 * 本次没有按单次训练查询/更新的需求，拆表只会增加迁移与 join 成本。
 *
 * chatId 唯一：一个会话只保留最终版（重复生成走 upsert 覆盖）。
 * 唯一约束自带索引，删除会话时级联删除也走它。
 */
export const practiceRoadmap = pgTable('practice_roadmap', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  chatId: text('chat_id')
    .notNull()
    .unique()
    .references(() => chat.id, { onDelete: 'cascade' }),
  content: jsonb('content').$type<RoadmapContent>().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  /** 最终版时间：upsert 时显式写成数据库 now()，不用 $onUpdate 以免 JS Date 与本地时间混用 */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export type PracticeRoadmapRow = typeof practiceRoadmap.$inferSelect
