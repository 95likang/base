import type { Client, WSClient } from '@larksuiteoapi/node-sdk'
import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types'

export interface FeishuConfig {
  appId: string
  appSecret: string
}

/** 事件里实际用到的字段（SDK 有完整类型，这里只声明消费面） */
interface FeishuMessageEvent {
  sender: {
    sender_type: string
    sender_id?: { open_id?: string }
  }
  message: {
    chat_id: string
    message_type: string
    content: string
    mentions?: Array<{ key: string }>
  }
}

/**
 * 飞书 Bot 通道：用长连接模式（服务主动连飞书 WebSocket）接收事件，
 * 不需要公网回调地址；发送走 im.message.create。
 */
export class FeishuChannel implements ChannelDefinition {
  name = 'feishu'
  description = '飞书 Bot 消息通道（长连接模式）'

  private config: FeishuConfig
  private messageHandler?: (msg: IncomingMessage) => void
  private wsClient?: WSClient
  private larkClient?: Client

  constructor(config: FeishuConfig) {
    this.config = config
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      console.log('    [feishu] 未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，跳过长连接')
      return
    }

    // 动态导入：不配置飞书时完全不加载 SDK
    const lark = await import('@larksuiteoapi/node-sdk')

    this.larkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    })

    const dispatcher = new lark.EventDispatcher({})
    dispatcher.register({
      'im.message.receive_v1': (data) => this.handleEvent(data),
    })

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    })
    await this.wsClient.start({ eventDispatcher: dispatcher })
    console.log('    [feishu] 长连接已建立（无需公网回调地址）')
  }

  async stop(): Promise<void> {
    this.wsClient?.close({ force: true })
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.larkClient) {
      console.log(`    [feishu] 未配置飞书，跳过发送: ${message.text.slice(0, 50)}`)
      return
    }

    try {
      await this.larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: message.channelId,
          msg_type: 'text',
          content: JSON.stringify({ text: message.text }),
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`    [feishu] 发送失败: ${msg}`)
    }
  }

  private handleEvent(data: FeishuMessageEvent): void {
    // 只处理用户发的文本：机器人/其他应用的消息不回，避免自循环
    if (data.sender.sender_type !== 'user') return
    if (data.message.message_type !== 'text') return

    const text = this.extractText(data.message.content, data.message.mentions)
    if (!text || !this.messageHandler) return

    // 事件里没有昵称，先用 open_id 作为展示名
    const senderId = data.sender.sender_id?.open_id ?? 'unknown'
    this.messageHandler({
      channelId: data.message.chat_id,
      senderId,
      senderName: senderId,
      text,
      raw: data,
    })
  }

  /** 解析文本消息并去掉 @Bot 的 mention 占位符 */
  private extractText(content: string, mentions?: Array<{ key: string }>): string {
    let text: string
    try {
      text = (JSON.parse(content) as { text?: string }).text ?? ''
    } catch {
      return ''
    }
    for (const mention of mentions ?? []) {
      text = text.replace(mention.key, '')
    }
    return text.trim()
  }
}
