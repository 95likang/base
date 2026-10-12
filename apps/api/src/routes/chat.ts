import type { UIMessage } from 'ai'
import { convertToModelMessages, streamText } from 'ai'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db'
import { chat, chatMessage, toUIMessage } from '../db/chat-schema'
import { anthropic } from '../lib/ai'
import { ApiError } from '../lib/api-error'

/**
 * Chats sub-router — 会话持久化。
 * GET    /            会话列表
 * POST   /            新建会话
 * DELETE /:id         删除会话（消息级联删除）
 * GET    /:id/messages 某会话的历史消息（UIMessage[]）
 */
export const chatsRoute = new Hono()
  .get('/', async (c) => {
    const chats = await db.select().from(chat).orderBy(desc(chat.updatedAt)).limit(50)
    return c.json({ chats })
  })
  .post('/', async (c) => {
    const [created] = await db.insert(chat).values({}).returning()
    return c.json({ chat: created }, 201)
  })
  .delete('/:id', async (c) => {
    const id = c.req.param('id')
    const [deleted] = await db.delete(chat).where(eq(chat.id, id)).returning({ id: chat.id })
    if (!deleted) {
      throw new ApiError('CHAT_NOT_FOUND', 'Chat not found.', 404)
    }
    return c.json({ ok: true })
  })
  .get('/:id/messages', async (c) => {
    const id = c.req.param('id')
    const [exists] = await db.select({ id: chat.id }).from(chat).where(eq(chat.id, id)).limit(1)
    if (!exists) {
      throw new ApiError('CHAT_NOT_FOUND', 'Chat not found.', 404)
    }
    const rows = await db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.chatId, id))
      .orderBy(chatMessage.createdAt)
    return c.json({ messages: rows.map(toUIMessage) })
  })

/**
 * Chat sub-router — LLM 流式对话（无需登录）。
 * body: { chatId, messages: UIMessage[] }。用户最后一条消息先落库，
 * AI 回复在流结束后落库；首条消息自动生成会话标题。
 */
export const chatRoute = new Hono().post('/', async (c) => {
  const { chatId, messages } = await c.req.json<{
    chatId: string
    messages: UIMessage[]
  }>()

  const [target] = await db.select().from(chat).where(eq(chat.id, chatId)).limit(1)
  if (!target) {
    throw new ApiError('CHAT_NOT_FOUND', 'Chat not found.', 404)
  }

  // 本次新产生的最后一条用户消息（useChat 每次都发全量历史，只存增量）
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  if (lastUser) {
    const [saved] = await db
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(eq(chatMessage.id, lastUser.id))
      .limit(1)
    if (!saved) {
      await db.insert(chatMessage).values({
        id: lastUser.id,
        chatId,
        role: 'user',
        parts: lastUser.parts,
      })
      // 首条消息 → 会话标题
      const firstText = lastUser.parts.find((p) => p.type === 'text')
      if (target.title === '新会话' && firstText && 'text' in firstText) {
        await db
          .update(chat)
          .set({ title: firstText.text.slice(0, 30) })
          .where(eq(chat.id, chatId))
      }
    }
  }

  const result = streamText({
    model: anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5'),
    system: 'You are a helpful assistant. 用中文简洁回答。',
    messages: await convertToModelMessages(messages),
  })

  // 默认会把流内错误吞成 "An error occurred."，这里把真实原因打到服务端日志方便排查
  return result.toUIMessageStreamResponse({
    onError: (err) => {
      console.error('[chat] stream error:', err)
      return err instanceof Error ? err.message : 'An error occurred.'
    },
    onFinish: async ({ responseMessage }) => {
      // AI 回复落库（含 reasoning parts，前端以折叠形式展示）。
      // 注意：v7 服务端流的 responseMessage.id 为空串，需自行生成 id，
      // 否则第二条 assistant 消息会撞 '' 的唯一键，把整个流搞崩。
      try {
        await db.insert(chatMessage).values({
          id: responseMessage.id || crypto.randomUUID(),
          chatId,
          role: 'assistant',
          parts: responseMessage.parts,
        })
      } catch (err) {
        // 落库失败只记日志，不能让流异常终止（否则前端报 network error）
        console.error('[chat] persist assistant message failed:', err)
      }
    },
  })
})
