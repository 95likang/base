import { desc, eq, sql } from 'drizzle-orm'
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

/** 全部计划（每个会话一条），最近更新的在前 */
export async function listRoadmaps(): Promise<PracticeRoadmapRow[]> {
  return db.select().from(practiceRoadmap).orderBy(desc(practiceRoadmap.updatedAt))
}

/** 按 id 取计划；不存在返回 null，由路由层转 404 */
export async function getRoadmap(id: string): Promise<PracticeRoadmapRow | null> {
  const [row] = await db.select().from(practiceRoadmap).where(eq(practiceRoadmap.id, id)).limit(1)
  return row ?? null
}

/** 覆盖计划内容（完成某次训练后写回），同时刷新最终版时间 */
export async function updateRoadmapContent(id: string, content: RoadmapContent): Promise<void> {
  await db
    .update(practiceRoadmap)
    .set({ content, updatedAt: sql`now()` })
    .where(eq(practiceRoadmap.id, id))
}

/** 删除计划；不存在返回 false，由路由层转 404 */
export async function deleteRoadmap(id: string): Promise<boolean> {
  const [deleted] = await db
    .delete(practiceRoadmap)
    .where(eq(practiceRoadmap.id, id))
    .returning({ id: practiceRoadmap.id })
  return Boolean(deleted)
}
