import { zValidator } from '@hono/zod-validator'
import type { UIMessage } from 'ai'
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db'
import { chat, chatMessage, toUIMessage } from '../db/chat-schema'
import { agentLoop } from '../lib/agent-loop'
import { anthropic } from '../lib/ai'
import { ApiError, validationHook } from '../lib/api-error'
import { calculatorTool } from '../tools/calculator'
import { weatherTool } from '../tools/weather'

/** 系统提示词 */
const SYSTEM = 'You are a helpful assistant. 用中文简洁回答。'

/** POST /chat 请求体：只校验形状（parts 内容由 AI SDK 自行解析） */
const chatPostSchema = z.object({
  chatId: z.string().min(1),
  messages: z
    .array(
      z
        .object({
          id: z.string(),
          role: z.enum(['user', 'assistant', 'system']),
          parts: z.array(z.object({ type: z.string() }).loose()),
        })
        .loose(),
    )
    .min(1),
})

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
export const chatRoute = new Hono().post(
  '/',
  zValidator('json', chatPostSchema, validationHook),
  async (c) => {
    const { chatId, messages: rawMessages } = c.req.valid('json')
    const messages = rawMessages as UIMessage[]

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

    const model = anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5')
    const tools = { getWeather: weatherTool, calculator: calculatorTool }
    const modelMessages = await convertToModelMessages(messages)

    const uiStream = createUIMessageStream({
      onError: (err) => {
        // 真实原因只进服务端日志；err.message 可能泄漏上游细节，不回传前端
        console.error('[chat] stream error:', err)
        return '服务暂时不可用，请稍后重试。'
      },
      // 提供 originalMessages：流会为回复消息生成 id，onEnd 能拿到完整消息列表
      originalMessages: messages,
      execute: async ({ writer }) => {
        // 客户端断开/取消时中止循环，避免后续 LLM 调用白烧 token
        await agentLoop(model, tools, modelMessages, SYSTEM, writer, c.req.raw.signal)
      },
      onEnd: async ({ messages: finalMessages, isAborted }) => {
        // AI 回复落库（含 reasoning / tool parts，前端以折叠形式展示）
        const responseMessage = finalMessages[finalMessages.length - 1]
        if (isAborted || !responseMessage || responseMessage.role !== 'assistant') {
          return
        }
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

    return createUIMessageStreamResponse({ stream: uiStream })
  },
)
