import { anthropic } from '../agent/model'
import { createPromptBuilder } from '../context/prompt-builder'
import { listActiveMemories } from '../memory/store'
import { ragStore } from '../rag/service'
import { skillLoader } from '../skills'
import { createDefaultToolRegistry } from '../tools/default-registry'
import type { ToolRegistry } from '../tools/registry'
import { usageLog } from '../usage'
import { FeishuChannel } from './feishu'
import { ChannelGateway } from './gateway'

// 本模块在导入期读取 ANTHROPIC_MODEL / FEISHU_*，显式加载 .env，不依赖其他模块的副作用顺序
process.loadEnvFile?.()

const promptBuilder = createPromptBuilder()

/** Channel 消息没有 chatId，用会话 key 占位；其余上下文与对话路由一致 */
async function buildSystem(
  registry: ToolRegistry,
  sessionId: string,
  messageCount: number,
): Promise<string> {
  const memories = await listActiveMemories()
  await ragStore.ensureLoaded()
  return promptBuilder.build({
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messageCount,
    sessionId,
    memories,
    knowledgeBase: { size: ragStore.size(), sources: ragStore.sources() },
    skills: skillLoader.list(),
  })
}

/** 进程级单例：/api/channels 路由与启动流程共用 */
export const channelGateway = new ChannelGateway({
  model: anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5'),
  createRegistry: createDefaultToolRegistry,
  buildSystem,
  usageTracker: usageLog,
})

channelGateway.register(
  new FeishuChannel({
    appId: process.env.FEISHU_APP_ID ?? '',
    appSecret: process.env.FEISHU_APP_SECRET ?? '',
  }),
)
