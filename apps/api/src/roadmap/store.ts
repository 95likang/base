import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { type PracticeRoadmapRow, practiceRoadmap } from '../db/roadmap-schema'
import type { RoadmapContent } from './spec'

/**
 * 路线图持久化。
 * 一个会话只保留最终版：同一 chatId 再次生成时覆盖 content 并刷新 updatedAt。
 * 对话内的首屏展示仍由前端从历史消息的 tool part 输入完成；
 * 这里的读取函数服务于「我的计划」页面。
 */
export async function createRoadmap(input: {
  userId: string
  chatId: string
  content: RoadmapContent
}): Promise<PracticeRoadmapRow> {
  const [saved] = (await db
    .insert(practiceRoadmap)
    .values(input)
    .onConflictDoUpdate({
      target: practiceRoadmap.chatId,
      // 用数据库 now() 而不是 JS Date：timestamp 列无时区，
      // 驱动会把 Date 转成 UTC 存储，与 defaultNow() 写入的服务器本地时间混在一起会排错序
      set: { content: input.content, updatedAt: sql`now()` },
    })
    .returning()) as [PracticeRoadmapRow]
  return saved
}

/** 当前用户的全部计划（每个会话一条），最近更新的在前 */
export async function listRoadmaps(userId: string): Promise<PracticeRoadmapRow[]> {
  return db
    .select()
    .from(practiceRoadmap)
    .where(eq(practiceRoadmap.userId, userId))
    .orderBy(desc(practiceRoadmap.updatedAt))
}

/** 统计用：只取 content 列，避免把 id / 时间等字段一起读出来 */
export async function listRoadmapContents(userId: string): Promise<RoadmapContent[]> {
  const rows = await db
    .select({ content: practiceRoadmap.content })
    .from(practiceRoadmap)
    .where(eq(practiceRoadmap.userId, userId))
  return rows.map((row) => row.content)
}

/** 按 id 取当前用户的计划；不存在或不属于该用户返回 null，由路由层转 404 */
export async function getRoadmap(id: string, userId: string): Promise<PracticeRoadmapRow | null> {
  const [row] = await db
    .select()
    .from(practiceRoadmap)
    .where(and(eq(practiceRoadmap.id, id), eq(practiceRoadmap.userId, userId)))
    .limit(1)
  return row ?? null
}

/** 覆盖计划内容（完成某次训练后写回），同时刷新最终版时间 */
export async function updateRoadmapContent(id: string, content: RoadmapContent): Promise<void> {
  await db
    .update(practiceRoadmap)
    .set({ content, updatedAt: sql`now()` })
    .where(eq(practiceRoadmap.id, id))
}

/** 删除当前用户的计划；不存在或不属于该用户返回 false，由路由层转 404 */
export async function deleteRoadmap(id: string, userId: string): Promise<boolean> {
  const [deleted] = await db
    .delete(practiceRoadmap)
    .where(and(eq(practiceRoadmap.id, id), eq(practiceRoadmap.userId, userId)))
    .returning({ id: practiceRoadmap.id })
  return Boolean(deleted)
}
