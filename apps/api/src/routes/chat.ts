import { zValidator } from '@hono/zod-validator'
import type { UIMessage } from 'ai'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { Hono } from 'hono'
import { z } from 'zod'
import { agentLoop, type BudgetState } from '../agent/loop'
import { anthropic } from '../agent/model'
import { microcompact, summarize } from '../context/compressor'
import {
  applyDefense,
  buildTimestampedMessages,
  estimateMessageTokens,
  TokenTracker,
} from '../context/defense'
import {
  coreRules,
  deferredTools,
  memoryContext,
  PromptBuilder,
  type PromptContext,
  sessionContext,
  toolGuide,
} from '../context/prompt-builder'
import { validationHook } from '../lib/api-error'
import { listActiveMemories } from '../memory/store'
import {
  createChat,
  deleteChat,
  getChatOrThrow,
  getMessageCreatedAt,
  listChats,
  listMessages,
  saveAssistantMessage,
  saveUserMessage,
} from '../session/store'
import {
  bashTool,
  calculatorTool,
  createMemoryTool,
  createToolSearchTool,
  editFileTool,
  getMcpTools,
  globTool,
  grepTool,
  listDirectoryTool,
  pickSearchTool,
  readFileTool,
  startPreviewTool,
  ToolRegistry,
  weatherTool,
  webFetchTool,
  writeFileTool,
} from '../tools'
import { usageLog } from './usage'

/** 单次请求的 Token 预算上限（所有步骤累计） */
const TOKEN_BUDGET = 200_000

/** 系统提示管道：模块级单例（build 为纯函数，无请求级状态，可跨请求复用） */
const promptBuilder = new PromptBuilder()
  .pipe('core-rules', coreRules())
  .pipe('tool-guide', toolGuide())
  .pipe('deferred-tools', deferredTools())
  .pipe('memory-context', memoryContext())
  .pipe('session-context', sessionContext())

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
 * Chats sub-router — 会话持久化（CRUD 全部委托 session/store）。
 * GET    /            会话列表
 * POST   /            新建会话
 * DELETE /:id         删除会话（消息级联删除）
 * GET    /:id/messages 某会话的历史消息（UIMessage[]）
 */
export const chatsRoute = new Hono()
  .get('/', async (c) => {
    return c.json({ chats: await listChats() })
  })
  .post('/', async (c) => {
    return c.json({ chat: await createChat() }, 201)
  })
  .delete('/:id', async (c) => {
    await deleteChat(c.req.param('id'))
    return c.json({ ok: true })
  })
  .get('/:id/messages', async (c) => {
    return c.json({ messages: await listMessages(c.req.param('id')) })
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

    const target = await getChatOrThrow(chatId)

    // 本次新产生的最后一条用户消息（useChat 每次都发全量历史，只存增量）
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUser) {
      await saveUserMessage(target, lastUser)
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
    registry.register(createToolSearchTool(registry))
    // 记忆工具：LLM 在对话中自主触发保存/读取（写库，独占锁）
    registry.register(createMemoryTool())
    const tools = registry.toAISDKFormat()
    // 请求级加载未过期记忆：注入 system prompt 索引。
    // 本次对话中保存的记忆要到下一轮请求才注入（与 Claude Code 文件记忆一致）
    const memories = await listActiveMemories()
    const promptCtx: PromptContext = {
      toolCount: registry.getActiveTools().length,
      deferredToolSummary: registry.getDeferredToolSummary(),
      sessionMessageCount: messages.length,
      sessionId: chatId,
      memories,
    }
    const system = promptBuilder.build(promptCtx)
    promptBuilder.debug(promptCtx)
    // 工具统计：观测延迟加载对 prompt token 的节省效果
    const allCount = registry.getAll().length
    const activeCount = registry.getActiveTools().length
    const estimate = registry.countTokenEstimate()
    console.log(
      `[工具统计] 全部 ${allCount} | 活跃 ${activeCount} | 延迟 ${allCount - activeCount} | ` +
        `Token 估算 ~${estimate.active}（活跃）+ ~${estimate.deferred}（延迟，不占 prompt）`,
    )
    // 三层即时防线（治理存量历史）→ 两层压缩（microcompact / summarize），全部仅内存：
    // DB 保存完整历史。时间戳取 DB 行（服务端时钟），逐条转换保证下标对齐。
    const createdAtById = await getMessageCreatedAt(chatId)
    const { messages: modelMessages, timestamps } = await buildTimestampedMessages(
      messages,
      createdAtById,
    )
    const defense = applyDefense(modelMessages, timestamps)
    const { messages: compacted, cleared } = microcompact(defense.messages)
    const { messages: llmMessages, compressedCount } = await summarize(
      model,
      compacted,
      c.req.raw.signal,
    )
    const defenseTouched =
      defense.truncated > 0 ||
      defense.compacted > 0 ||
      defense.softPruned > 0 ||
      defense.hardPruned > 0
    if (defenseTouched || cleared > 0 || compressedCount > 0) {
      console.log(
        `[防线] 截断 ${defense.truncated} | 预算清理 ${defense.compacted} | ` +
          `TTL 软${defense.softPruned}/硬${defense.hardPruned} | ` +
          `[压缩] 清空 ${cleared} 个 | 摘要 ${compressedCount} 条 | ` +
          `token ~${estimateMessageTokens(modelMessages)} → ~${estimateMessageTokens(llmMessages)}`,
      )
    }

    // 上下文占用追踪：入口记录最终消息，循环内每步用 API 真实用量锚定。
    // 与 budget（跨步累计消耗）语义不同：tracker 计的是"当前窗口占用"。
    const tracker = new TokenTracker()
    tracker.addMessages(llmMessages)

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
        await agentLoop(
          model,
          tools,
          llmMessages,
          system,
          writer,
          c.req.raw.signal,
          budget,
          tracker,
          usageLog,
          chatId,
        )
        // 成本记录在 agentLoop 内按步写入 usageLog；
        // 展示走 web 面板（/context、/usage 命令 → /api/usage/*）
      },
      onEnd: async ({ messages: finalMessages, isAborted }) => {
        // AI 回复落库（含 reasoning / tool parts，前端以折叠形式展示）
        const responseMessage = finalMessages[finalMessages.length - 1]
        if (isAborted || !responseMessage || responseMessage.role !== 'assistant') {
          return
        }
        await saveAssistantMessage(chatId, responseMessage)
      },
    })

    return createUIMessageStreamResponse({ stream: uiStream })
  },
)
