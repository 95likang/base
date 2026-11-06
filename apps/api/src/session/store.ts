import type { UIMessage } from 'ai'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { type Chat, chat, chatMessage, toUIMessage } from '../db/chat-schema'
import { ApiError } from '../lib/api-error'
import { removeRoadmapReminder } from '../roadmap/reminder'
import { findRoadmapIdByChatId } from '../roadmap/store'

/**
 * 会话持久化：chat / chatMessage 的数据访问函数。
 * 路由层（routes/chat.ts）只做 HTTP 编排，全部读写经由此模块。
 */

/** 会话列表（当前用户，最近更新在前，最多 50 条） */
export async function listChats(userId: string): Promise<Chat[]> {
  return db
    .select()
    .from(chat)
    .where(eq(chat.userId, userId))
    .orderBy(desc(chat.updatedAt))
    .limit(50)
}

/** 新建空会话 */
export async function createChat(userId: string): Promise<Chat> {
  // insert 单行 returning 必有且仅有一行
  const [created] = (await db.insert(chat).values({ userId }).returning()) as [Chat]
  return created
}

/** 删除会话（消息级联删除）；不属于当前用户或不存在时抛 404 */
export async function deleteChat(id: string, userId: string): Promise<void> {
  // 计划随会话级联删除，但它的开始提醒不在数据库里，必须在删前拿到 id 单独清理
  const roadmapId = await findRoadmapIdByChatId(id, userId)
  const [deleted] = await db
    .delete(chat)
    .where(and(eq(chat.id, id), eq(chat.userId, userId)))
    .returning({ id: chat.id })
  if (!deleted) {
    throw new ApiError('CHAT_NOT_FOUND', 'Chat not found.', 404)
  }
  if (roadmapId) {
    try {
      await removeRoadmapReminder(roadmapId)
    } catch (err) {
      // 会话已经删掉了，清理提醒失败不能把请求变成 500（用户重试只会拿到 404）
      const message = err instanceof Error ? err.message : String(err)
      console.log(`  [session] 清理计划提醒失败: ${message}`)
    }
  }
}

/** 按 id 取当前用户的会话；不存在或不属于该用户时抛 404 */
export async function getChatOrThrow(id: string, userId: string): Promise<Chat> {
  const [target] = await db
    .select()
    .from(chat)
    .where(and(eq(chat.id, id), eq(chat.userId, userId)))
    .limit(1)
  if (!target) {
    throw new ApiError('CHAT_NOT_FOUND', 'Chat not found.', 404)
  }
  return target
}

/** 某会话的历史消息（按时间升序，已转为 UIMessage[]） */
export async function listMessages(id: string, userId: string): Promise<UIMessage[]> {
  await getChatOrThrow(id, userId)
  const rows = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.chatId, id))
    .orderBy(chatMessage.createdAt)
  return rows.map(toUIMessage)
}

/** 某会话全部消息的 id → createdAt（TTL 修剪用服务端时钟判断消息年龄） */
export async function getMessageCreatedAt(id: string): Promise<Map<string, Date>> {
  const rows = await db
    .select({ id: chatMessage.id, createdAt: chatMessage.createdAt })
    .from(chatMessage)
    .where(eq(chatMessage.chatId, id))
  return new Map(rows.map((row) => [row.id, row.createdAt]))
}

/**
 * 落库本次新产生的用户消息（useChat 每次都发全量历史，只存增量）。
 * 首条消息自动把会话标题更新为其前 30 字符（demo 简化，不额外调 LLM）。
 */
export async function saveUserMessage(target: Chat, message: UIMessage): Promise<void> {
  const [saved] = await db
    .select({ id: chatMessage.id })
    .from(chatMessage)
    .where(eq(chatMessage.id, message.id))
    .limit(1)
  if (saved) return

  await db.insert(chatMessage).values({
    id: message.id,
    chatId: target.id,
    role: message.role,
    parts: message.parts,
  })

  if (target.title === '新会话') {
    // 纯图片消息没有 text part：也要落一个非默认标题，
    // 否则「标题仍是新会话 = 空会话」的判定会把它误认成空会话
    const firstText = message.parts.find((p) => p.type === 'text')
    const title = firstText && 'text' in firstText ? firstText.text.slice(0, 30) : '图片对话'
    await db.update(chat).set({ title }).where(eq(chat.id, target.id))
  }
}

/**
 * 落库 AI 回复（含 reasoning / tool parts）。
 * 失败只记日志不抛出：流已经结束，不能让落库失败把整个响应变成 network error。
 */
export async function saveAssistantMessage(chatId: string, message: UIMessage): Promise<void> {
  try {
    await db.insert(chatMessage).values({
      id: message.id,
      chatId,
      role: message.role,
      parts: message.parts,
    })
  } catch (err) {
    console.error('[chat] persist assistant message failed:', err)
  }
}
