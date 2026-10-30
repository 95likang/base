import type { DiscordChannel } from './discord'

/** 主动推送目标：Discord 通道实例 + 固定频道 ID + 每条都要 @ 的用户 */
let target: { channel: DiscordChannel; channelId: string; userId: string } | undefined

/** 由 channels/index.ts 在注册 Discord 通道时调用 */
export function setDiscordNotifier(
  channel: DiscordChannel,
  channelId: string,
  userId: string,
): void {
  target = { channel, channelId, userId }
}

/**
 * 主动推送到固定频道（定时任务结果、notify_discord 工具、系统事件共用）。
 * 配了 notifyUserId 时每条消息都会 @ 该用户。
 * 未配置频道或 Discord 未连接时返回 false；发送失败由通道自身记录日志，不向调用方抛出。
 */
export async function pushDiscord(text: string): Promise<boolean> {
  if (!target?.channelId || !target.channel.isReady()) return false

  const { channel, channelId, userId } = target
  const mention = userId ? `<@${userId}>` : ''
  // 避免调用方已经写了同样的提及时重复拼接
  const content = mention && !text.includes(mention) ? `${mention} ${text}` : text
  await channel.send({ channelId, text: content })
  return true
}
