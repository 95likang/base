import { pushDiscord } from '../channels/notify'
import type { ToolDefinition } from './registry'

/**
 * notify_discord：让 Agent 在「有信息需要主动告知固定频道」时推送一条消息。
 * 与对话回复无关——Discord 会话里的正常回复直接走通道发送，不需要调用本工具。
 */
export const notifyDiscordTool: ToolDefinition = {
  name: 'notify_discord',
  description:
    '主动把一条消息推送到 Discord 通知频道。支持提及语法：<@用户ID> 提及用户、' +
    '<@&角色ID> 提及角色、<#频道ID> 链接频道。不支持 @everyone/@here。' +
    '仅在用户明确要求「通知/提醒/推送给我或某频道」，或定时任务需要把结果告知群里时使用；' +
    '普通对话回复不要调用。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要推送的纯文本，可含换行' },
    },
    required: ['text'],
  },
  execute: async (input: { text: string }) => {
    // 模型可能被外部内容诱导加 @everyone：工具层剥离，手动推送（管理页）仍保留
    const text = input.text.replace(/@(everyone|here)/gi, '')
    const sent = await pushDiscord(text)
    return sent ? '已提交 Discord 推送' : 'Discord 推送不可用（未配置频道或 bot 未连接）'
  },
}
