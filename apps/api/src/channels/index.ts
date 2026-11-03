import { defaultModel } from '../agent/model'
import { config } from '../config/loader'
import { buildRuntimeSystem } from '../context/runtime-prompt'
import { cronService } from '../cron'
import { createDefaultToolRegistry } from '../tools/default-registry'
import { usageLog } from '../usage'
import { DiscordChannel } from './discord'
import { FeishuChannel } from './feishu'
import { ChannelGateway } from './gateway'
import { setDiscordNotifier } from './notify'

/** 点「稍后提醒」后延后多久再次推送 */
const SNOOZE_MS = 5 * 60_000

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
  // 提醒按钮：customId 格式为 cron:<jobId>:<snooze|cancel>
  discord.onAction(async ({ actionId, senderId, messageText }) => {
    if (!actionId.startsWith('cron:')) return '未知操作'
    const [jobId, action] = actionId.slice('cron:'.length).split(':')
    if (!jobId) return '未知操作'

    const owner = config.channels.discord.notifyUserId
    if (owner && senderId !== owner) return '只有被提醒的人可以操作'

    // 一次性任务执行后已被调度器自动删除，这里不依赖任务是否存在：
    // cancel 对不存在的任务也算成功；snooze 用消息文本重建任务。
    if (action === 'cancel') {
      await cronService.remove(jobId)
      return '⏰ 提醒已关闭'
    }
    if (action === 'snooze') {
      await cronService.remove(jobId)
      try {
        await cronService.add({
          id: jobId,
          name: messageText.slice(0, 50),
          schedule: new Date(Date.now() + SNOOZE_MS).toISOString(),
          scheduleType: 'once',
          enabled: true,
          payload: { type: 'reminder', text: messageText },
          source: 'runtime',
        })
      } catch (err) {
        return `稍后提醒设置失败: ${err instanceof Error ? err.message : String(err)}`
      }
      return `⏰ 已稍后提醒（${SNOOZE_MS / 60_000} 分钟后）`
    }
    return '未知操作'
  })
  // 主动推送（定时任务结果、notify_discord 工具）复用同一个连接
  setDiscordNotifier(
    discord,
    config.channels.discord.notifyChannelId,
    config.channels.discord.notifyUserId,
  )
}
