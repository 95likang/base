import { createPromptBuilder } from '../context/prompt-builder'
import { listActiveMemories } from '../memory/store'
import { ragStore } from '../rag/service'
import { skillLoader } from '../skills'
import type { ToolRegistry } from '../tools/registry'

/** 系统提示管道：build 为纯函数，模块级单例可跨请求复用 */
const promptBuilder = createPromptBuilder()

/**
 * 非对话入口（Channel / Cron）的运行时系统提示。
 * 与 /api/chat 同源上下文：工具目录、记忆索引、知识库规模、skills 索引。
 */
export async function buildRuntimeSystem(
  registry: ToolRegistry,
  sessionId: string,
  messageCount: number,
): Promise<string> {
  const memories = await listActiveMemories()
  await ragStore.ensureLoaded()
  return promptBuilder.build({
    toolCount: registry.getActiveTools().length,
    hasSpawnAgent: registry.getActiveTools().some((tool) => tool.name === 'spawn_agent'),
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messageCount,
    sessionId,
    memories,
    knowledgeBase: { size: ragStore.size(), sources: ragStore.sources() },
    skills: skillLoader.list(),
  })
}
