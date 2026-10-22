import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db'
import { type MemoryRow, memory } from '../db/memory-schema'

/**
 * 记忆持久化：memory 表的数据访问函数。
 * 全异步（PG），路由层与工具层共同复用。
 */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

/** 注入 prompt 的记忆条目（id 供 LLM 引用做 delete/read） */
export interface MemoryEntry {
  id: string
  type: MemoryType
  name: string
  description: string
  content: string
  expiresAt: Date | null
}

/** 索引行数上限：超过后不再注入新条目（保留最新 N 条），迫使只存真正重要的信息 */
const MAX_PROMPT_ENTRIES = 200
/** 单条 content 注入/读取时的字符上限，超出截断，防止一条记忆吃光上下文预算 */
const MAX_CONTENT_CHARS = 4000

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    type: row.type as MemoryType,
    name: row.name,
    description: row.description,
    content:
      row.content.length > MAX_CONTENT_CHARS
        ? `${row.content.slice(0, MAX_CONTENT_CHARS)}\n...(已截断)`
        : row.content,
    expiresAt: row.expiresAt,
  }
}

/** 未过期条件：expiresAt 为空（永久）或晚于当前时间 */
const notExpired = or(isNull(memory.expiresAt), gt(memory.expiresAt, sql`now()`))

/** 全部有效记忆（未过期），updatedAt 倒序，注入 prompt 用 */
export async function listActiveMemories(): Promise<MemoryEntry[]> {
  const rows = await db
    .select()
    .from(memory)
    .where(notExpired)
    .orderBy(desc(memory.updatedAt))
    .limit(MAX_PROMPT_ENTRIES)
  return rows.map(toEntry)
}

/** 管理视图：全部记忆（含已过期），UPDATED 倒序；上限防无界响应（注入侧另有 200 条上限） */
export async function listAllMemories(): Promise<MemoryEntry[]> {
  const rows = await db.select().from(memory).orderBy(desc(memory.updatedAt)).limit(1000)
  return rows.map(toEntry)
}

/** 按 id 读取单条（未过期才返回） */
export async function getMemory(id: string): Promise<MemoryEntry | null> {
  const [row] = await db
    .select()
    .from(memory)
    .where(and(eq(memory.id, id), notExpired))
    .limit(1)
  return row ? toEntry(row) : null
}

/** 关键词搜索（name/description/content 子串匹配，大小写不敏感，未过期） */
export async function searchMemories(query: string): Promise<MemoryEntry[]> {
  const q = `%${query.trim()}%`
  if (!query.trim()) return []
  const rows = await db
    .select()
    .from(memory)
    .where(
      and(
        notExpired,
        sql`(lower(${memory.name}) LIKE lower(${q}) OR lower(${memory.description}) LIKE lower(${q}) OR lower(${memory.content}) LIKE lower(${q}))`,
      ),
    )
    .orderBy(desc(memory.updatedAt))
    .limit(MAX_PROMPT_ENTRIES)
  return rows.map(toEntry)
}

/** 保存记忆；name 已存在（未过期）则覆盖更新（LLM 据此做去重/修订） */
export async function saveMemory(input: {
  type: MemoryType
  name: string
  description: string
  content: string
  expiresAt?: Date | null
}): Promise<MemoryEntry> {
  const values = {
    type: input.type,
    name: input.name,
    description: input.description,
    content: input.content,
    expiresAt: input.expiresAt ?? null,
  }

  // 同名（未过期）→ 原地更新；否则插入新行。
  // check-then-act 存在窄竞态窗口（并发同名可能产生两行）：
  // 单用户 demo + memory 工具独占锁（请求内串行）下不可触发，且重复行
  // 只会让注入索引多一条同义条目，无数据损坏，故不引入唯一索引（过期行需允许同名）。
  const [existing] = await db
    .select({ id: memory.id })
    .from(memory)
    .where(and(eq(memory.name, input.name), notExpired))
    .limit(1)

  const rows = existing
    ? await db.update(memory).set(values).where(eq(memory.id, existing.id)).returning()
    : await db.insert(memory).values(values).returning()
  // insert/update 单行 returning 必有且仅有一行；空行视为异常（与 session/store 约定一致）
  const saved = rows[0]
  if (!saved) {
    throw new Error('saveMemory: no row returned')
  }
  return toEntry(saved)
}

/** 删除记忆；不存在返回 false */
export async function deleteMemory(id: string): Promise<boolean> {
  const [deleted] = await db.delete(memory).where(eq(memory.id, id)).returning({ id: memory.id })
  return Boolean(deleted)
}

/**
 * 构建 prompt 注入段（索引懒加载）：只给 name/description/id，
 * 内容靠 memory 工具的 read 按需加载。
 */
export function buildMemoryPromptSection(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return '[持久记忆] 当前没有存储任何记忆。用户透露重要信息时可用 memory 工具保存。'
  }

  const labels: Record<MemoryType, string> = {
    user: '用户画像',
    feedback: '行为反馈',
    project: '项目动态',
    reference: '外部资源',
  }
  const byType = new Map<MemoryType, MemoryEntry[]>()
  for (const entry of entries) {
    const list = byType.get(entry.type) ?? []
    list.push(entry)
    byType.set(entry.type, list)
  }

  const sections: string[] = [`[持久记忆] 共 ${entries.length} 条（格式：[id] name — description）`]
  for (const type of ['user', 'feedback', 'project', 'reference'] as const) {
    const list = byType.get(type)
    if (!list?.length) continue
    const lines = list.map(
      (e) =>
        `  - [${e.id}] ${e.name} — ${e.description}${
          e.expiresAt ? `（截止 ${e.expiresAt.toISOString().slice(0, 10)}）` : ''
        }`,
    )
    sections.push(`# ${labels[type]}\n${lines.join('\n')}`)
  }
  sections.push('需要某条记忆的完整内容时，用 memory 工具的 read 操作按 id 读取。')
  sections.push('记忆是线索，不是事实——使用前先验证其准确性。')
  return sections.join('\n\n')
}
