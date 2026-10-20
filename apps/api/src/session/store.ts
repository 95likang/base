import type { UIMessage } from 'ai'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { type Chat, chat, chatMessage, toUIMessage } from '../db/chat-schema'
import { ApiError } from '../lib/api-error'

/**
 * 会话持久化：chat / chatMessage 的数据访问函数。
 * 路由层（routes/chat.ts）只做 HTTP 编排，全部读写经由此模块。
 */

/** 会话列表（最近更新在前，最多 50 条） */
export async function listChats(): Promise<Chat[]> {
  return db.select().from(chat).orderBy(desc(chat.updatedAt)).limit(50)
}

/** 新建空会话 */
export async function createChat(): Promise<Chat> {
  // insert 单行 returning 必有且仅有一行
  const [created] = (await db.insert(chat).values({}).returning()) as [Chat]
  return created
}

/** 删除会话（消息级联删除）；不存在时抛 404 */
export async function deleteChat(id: string): Promise<void> {
  const [deleted] = await db.delete(chat).where(eq(chat.id, id)).returning({ id: chat.id })
  if (!deleted) {
    throw new ApiError('CHAT_NOT_FOUND', 'Chat not found.', 404)
  }
}

/** 按 id 取会话；不存在时抛 404 */
export async function getChatOrThrow(id: string): Promise<Chat> {
  const [target] = await db.select().from(chat).where(eq(chat.id, id)).limit(1)
  if (!target) {
    throw new ApiError('CHAT_NOT_FOUND', 'Chat not found.', 404)
  }
  return target
}

/** 某会话的历史消息（按时间升序，已转为 UIMessage[]） */
export async function listMessages(id: string): Promise<UIMessage[]> {
  await getChatOrThrow(id)
  const rows = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.chatId, id))
    .orderBy(chatMessage.createdAt)
  return rows.map(toUIMessage)
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
    const firstText = message.parts.find((p) => p.type === 'text')
    if (firstText && 'text' in firstText) {
      await db
        .update(chat)
        .set({ title: firstText.text.slice(0, 30) })
        .where(eq(chat.id, target.id))
    }
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
