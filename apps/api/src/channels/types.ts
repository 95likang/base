/**
 * Channel 契约 —— Agent 与外界通信的通道（终端、飞书群、邮件等）。
 * 通道只负责收发消息，消息路由与 Agent 调用统一交给 ChannelGateway。
 */

/** 通道收到的消息 */
export interface IncomingMessage {
  /** 通道内的会话/群标识（飞书为 chat_id） */
  channelId: string
  /** 发送者标识（飞书为 open_id） */
  senderId: string
  senderName: string
  text: string
  raw?: unknown
}

/** 通过通道发出的消息 */
export interface OutgoingMessage {
  /** 发回的目标会话（飞书为 chat_id） */
  channelId: string
  recipientId: string
  text: string
}

export interface ChannelDefinition {
  name: string
  description: string

  start(): Promise<void> | void
  stop(): Promise<void> | void
  send(message: OutgoingMessage): Promise<void>

  onMessage?: (handler: (msg: IncomingMessage) => void) => void
}
