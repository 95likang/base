import { anthropic } from '../agent/model'
import { buildRuntimeSystem } from '../context/runtime-prompt'
import { createDefaultToolRegistry } from '../tools/default-registry'
import { usageLog } from '../usage'
import { FeishuChannel } from './feishu'
import { ChannelGateway } from './gateway'

// 本模块在导入期读取 ANTHROPIC_MODEL / FEISHU_*，显式加载 .env，不依赖其他模块的副作用顺序
process.loadEnvFile?.()

/** 进程级单例：/api/channels 路由与启动流程共用 */
export const channelGateway = new ChannelGateway({
  model: anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5'),
  createRegistry: createDefaultToolRegistry,
  buildSystem: buildRuntimeSystem,
  usageTracker: usageLog,
})

channelGateway.register(
  new FeishuChannel({
    appId: process.env.FEISHU_APP_ID ?? '',
    appSecret: process.env.FEISHU_APP_SECRET ?? '',
  }),
)
