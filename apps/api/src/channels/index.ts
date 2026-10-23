import { defaultModel } from '../agent/model'
import { config } from '../config/loader'
import { buildRuntimeSystem } from '../context/runtime-prompt'
import { createDefaultToolRegistry } from '../tools/default-registry'
import { usageLog } from '../usage'
import { FeishuChannel } from './feishu'
import { ChannelGateway } from './gateway'

/** 进程级单例：/api/channels 路由与启动流程共用 */
export const channelGateway = new ChannelGateway({
  model: defaultModel,
  createRegistry: createDefaultToolRegistry,
  buildSystem: buildRuntimeSystem,
  usageTracker: usageLog,
})

// 配置里 enabled=false 时完全不创建实例、不建立长连接
if (config.channels.feishu.enabled) {
  channelGateway.register(
    new FeishuChannel({
      appId: config.channels.feishu.appId,
      appSecret: config.channels.feishu.appSecret,
    }),
  )
}
