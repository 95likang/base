import type { ModelMessage } from 'ai'
import { Hono } from 'hono'
import { microcompact } from '../context/compressor'
import { applyDefense, buildTimestampedMessages, CONTEXT_WINDOW } from '../context/defense'
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  ragContext,
  sessionContext,
  skillsContext,
  toolGuide,
} from '../context/prompt-builder'
import { buildContextSnapshot } from '../context/view'
import { buildMemoryPromptSection, listActiveMemories } from '../memory/store'
import { ragStore } from '../rag/service'
import { getRole } from '../security'
import { getMessageCreatedAt, listMessages } from '../session/store'
import { skillLoader } from '../skills'
import {
  bashTool,
  calculatorTool,
  editFileTool,
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
import { usageLog } from '../usage'

/**
 * Usage sub-router — 用量与上下文查询（web 端 /context、/usage 面板的数据源）。
 * GET /          用量查询：不带参数为进程累计；?chatId= 只统计该会话
 * GET /context   某会话的上下文占用快照（?chatId= 缺省为空会话）
 */
export const usageRoute = new Hono()
  .get('/', (c) => {
    const chatId = c.req.query('chatId')
    return c.json({ totals: usageLog.totals(chatId), recent: usageLog.recent(20, chatId) })
  })
  .get('/context', async (c) => {
    const chatId = c.req.query('chatId')

    // 与 chat.ts 相同的入口管线（估算口径一致）：时间戳 → 三层防线 → microcompact。
    // 跳过 summarize（LLM 调用，仅高占用时触发）；MCP 工具是延迟加载不占 prompt，
    // 这里只注册内置工具即可。
    let modelMessages: ModelMessage[] = []
    if (chatId) {
      const uiMessages = await listMessages(chatId)
      const createdAtById = await getMessageCreatedAt(chatId)
      const built = await buildTimestampedMessages(uiMessages, createdAtById)
      const defense = applyDefense(built.messages, built.timestamps)
      modelMessages = microcompact(defense.messages).messages
    }

    const registry = new ToolRegistry()
    // 与对话请求保持同一口径：角色过滤后实际暴露的工具才计入 prompt 估算
    registry.setRole(getRole())
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
    )
    const memories = await listActiveMemories()
    await ragStore.ensureLoaded()
    const promptCtx = {
      toolCount: registry.getActiveTools().length,
      deferredToolSummary: registry.getDeferredToolSummary(),
      sessionMessageCount: modelMessages.length,
      sessionId: chatId ?? 'new',
      memories,
      knowledgeBase: { size: ragStore.size(), sources: ragStore.sources() },
      skills: skillLoader.list(),
    }
    // 只构建一次 memory / skills 段：pipe 与快照的 chars 共用（build 内部会再次调用各 pipe）
    const memorySection = buildMemoryPromptSection(memories)
    const skillsSection = skillsContext()(promptCtx)
    const promptBuilder = new PromptBuilder()
      .pipe('core-rules', coreRules())
      .pipe('tool-guide', toolGuide())
      .pipe('deferred-tools', deferredTools())
      .pipe('memory-context', () => memorySection)
      .pipe('rag-context', ragContext())
      .pipe('skills-context', () => skillsSection)
      .pipe('session-context', sessionContext())
    const system = promptBuilder.build(promptCtx)

    const modelId = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5'
    const snapshot = buildContextSnapshot({
      modelId,
      windowTokens: CONTEXT_WINDOW,
      systemPromptChars: system.length,
      toolDescriptionChars: registry
        .getActiveTools()
        .reduce(
          (a, t) => a + t.name.length + t.description.length + JSON.stringify(t.parameters).length,
          0,
        ),
      memoryChars: memorySection.length,
      skillsChars: skillsSection?.length ?? 0,
      messages: modelMessages,
    })
    return c.json(snapshot)
  })
