import { defaultModel } from '../agent/model'
import { config } from '../config/loader'
import { buildRuntimeSystem } from '../context/runtime-prompt'
import { createDefaultToolRegistry } from '../tools/default-registry'
import { usageLog } from '../usage'
import { DiscordChannel } from './discord'
import { FeishuChannel } from './feishu'
import { ChannelGateway } from './gateway'
import { setDiscordNotifier } from './notify'

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

if (config.channels.discord.enabled) {
  const discord = new DiscordChannel({
    botToken: config.channels.discord.botToken,
    proxyUrl: config.channels.discord.proxyUrl,
  })
  channelGateway.register(discord)
  // 主动推送（定时任务结果、notify_discord 工具）复用同一个连接
  setDiscordNotifier(
    discord,
    config.channels.discord.notifyChannelId,
    config.channels.discord.notifyUserId,
  )
}
