import { zValidator } from '@hono/zod-validator'
import type { UIMessage } from 'ai'
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { agentLoop, type BudgetState } from '../agent/loop'
import { anthropic } from '../agent/model'
import { db } from '../db'
import { chat, chatMessage, toUIMessage } from '../db/chat-schema'
import { ApiError, validationHook } from '../lib/api-error'
import {
  bashTool,
  calculatorTool,
  editFileTool,
  getMcpTools,
  globTool,
  grepTool,
  listDirectoryTool,
  pickSearchTool,
  readFileTool,
  startPreviewTool,
  type ToolDefinition,
  ToolRegistry,
  weatherTool,
  webFetchTool,
  writeFileTool,
} from '../tools'

/** 系统提示词 */
const SYSTEM = 'You are a helpful assistant. 用中文简洁回答。'
/** 单次请求的 Token 预算上限（所有步骤累计） */
const TOKEN_BUDGET = 200_000

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
    // 请求级注册表：锁状态只协调本次请求内的并行工具调用，不跨请求共享。
    // 文件工具限制在 TOOL_WORKSPACE_DIR 指定的工作区内（默认 <cwd>/workspace），
    // 路径越界一律拒绝；TOOL_WORKSPACE_GUARD=false 可关闭该守卫（仅限本地开发）。
    const registry = new ToolRegistry()
    registry.register(
      weatherTool,
      calculatorTool,
      pickSearchTool(),
      readFileTool,
      writeFileTool,
      listDirectoryTool,
      editFileTool,
      globTool,
      grepTool,
      bashTool,
      webFetchTool,
      startPreviewTool,
      // MCP 外部工具（MCP_SERVERS 未配置时为空数组）——延迟加载，不占初始上下文
      ...(await getMcpTools()),
    )
    // 延迟工具的发现入口：激活后 registry 原地更新 ToolSet，后续步骤立即可用
    const toolSearchTool: ToolDefinition = {
      name: 'tool_search',
      description:
        '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），激活后即可直接调用',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ query }: { query: string }) => {
        const results = registry.searchTools(query)
        if (results.length === 0) return `没有找到匹配 "${query}" 的工具`
        return results.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }))
      },
    }
    registry.register(toolSearchTool)
    const tools = registry.toAISDKFormat()
    // 系统提示附带延迟工具目录，模型据此决定是否通过 tool_search 激活
    const system = SYSTEM + registry.getDeferredToolSummary()
    // 工具统计：观测延迟加载对 prompt token 的节省效果
    const allCount = registry.getAll().length
    const activeCount = registry.getActiveTools().length
    const estimate = registry.countTokenEstimate()
    console.log(
      `[工具统计] 全部 ${allCount} | 活跃 ${activeCount} | 延迟 ${allCount - activeCount} | ` +
        `Token 估算 ~${estimate.active}（活跃）+ ~${estimate.deferred}（延迟，不占 prompt）`,
    )
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
        // 客户端断开/取消时中止循环，避免后续 LLM 调用白烧 token；
        // Token 预算限制单次请求的总消耗（所有步骤累计）
        const budget: BudgetState = { used: 0, limit: TOKEN_BUDGET }
        await agentLoop(model, tools, modelMessages, system, writer, c.req.raw.signal, budget)
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
