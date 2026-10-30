import type { LanguageModel, ModelMessage, UIMessageStreamWriter } from 'ai'
import { agentLoop, type BudgetState, TOKEN_BUDGET } from '../agent/loop'
import type { ToolRegistry } from '../tools/registry'
import type { UsageTracker } from '../usage/tracker'
import type { ChannelDefinition, IncomingMessage } from './types'

/** 每个会话保留的最大消息数：只存 user/assistant 文本，工具消息不进历史 */
const MAX_SESSION_MESSAGES = 40
/** 内存中最多保留的会话数：超出后淘汰最久未活跃的（Map 插入顺序即 LRU） */
const MAX_SESSIONS = 500

export interface GatewayOptions {
  model: LanguageModel
  /** 每条消息新建工具集：锁状态与延迟工具激活按消息隔离；传入预算让子 Agent 计入同一上限 */
  createRegistry: (options?: { budget?: BudgetState }) => Promise<ToolRegistry> | ToolRegistry
  /** 按会话构建系统提示；注入记忆/知识库等请求级上下文 */
  buildSystem: (
    registry: ToolRegistry,
    sessionId: string,
    messageCount: number,
  ) => string | Promise<string>
  /** 成本追踪：Channel 对话同样计入 /api/usage */
  usageTracker?: UsageTracker
}

/**
 * Channel 中枢：注册所有通道，把收到的消息交给 Agent Loop，
 * 再把最终回复通过同一通道发回去。
 *
 * 会话按 `<channel>:<chat>:<sender>` 隔离，历史只保留 user/assistant 文本：
 * 工具调用消息属于单次请求的运行细节，不跨消息复用（避免残留悬空的 tool 结果）。
 */
export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>()
  private sessions = new Map<string, ModelMessage[]>()
  /** 会话级串行队列：同一会话的并发消息按到达顺序依次处理 */
  private queues = new Map<string, Promise<unknown>>()
  private options: GatewayOptions

  constructor(options: GatewayOptions) {
    this.options = options
  }

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel)

    channel.onMessage?.((msg: IncomingMessage) => {
      // 通道的事件回调不能 await：异步处理交给后台，失败只记日志并回执，不影响通道自身
      void this.dispatch(channel.name, msg).catch(async (err) => {
        console.error(`  [${channel.name}] 处理消息失败:`, err)
        await channel.send({
          channelId: msg.channelId,
          text: '处理失败，请稍后重试。',
        })
      })
    })
  }

  async startAll(): Promise<void> {
    for (const [name, channel] of this.channels) {
      try {
        await channel.start()
        console.log(`  [gateway] ✓ ${name} 已就绪`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  [gateway] ✗ ${name} 启动失败: ${msg}`)
      }
    }
  }

  /**
   * 处理一条收到的消息并返回回复。
   * deliver=false 时不调用通道 send（管理页测试消息直接取返回值）。
   */
  dispatch(channelName: string, msg: IncomingMessage, deliver = true): Promise<string> {
    if (!this.channels.has(channelName)) {
      return Promise.reject(new Error(`未注册的通道: ${channelName}`))
    }

    const sessionKey = `${channelName}:${msg.channelId}:${msg.senderId}`
    // 同一会话串行：并发消息共享同一份历史会导致顺序错乱与上下文重复
    const previous = this.queues.get(sessionKey) ?? Promise.resolve()
    const current = previous.then(
      () => this.handleMessage(channelName, sessionKey, msg, deliver),
      () => this.handleMessage(channelName, sessionKey, msg, deliver),
    )
    this.queues.set(sessionKey, current)
    const cleanup = () => {
      if (this.queues.get(sessionKey) === current) this.queues.delete(sessionKey)
    }
    void current.then(cleanup, cleanup)
    return current
  }

  private async handleMessage(
    channelName: string,
    sessionKey: string,
    msg: IncomingMessage,
    deliver: boolean,
  ): Promise<string> {
    console.log(`\n  [${channelName}] ${msg.senderName}: ${msg.text}`)

    const session = this.getSession(sessionKey)

    // 复制历史给本次请求：agentLoop 会往数组里追加工具消息，不能污染会话历史
    const userMsg: ModelMessage = { role: 'user', content: msg.text }
    const messages: ModelMessage[] = [...session, userMsg]

    const budget: BudgetState = { used: 0, limit: TOKEN_BUDGET }
    const registry = await this.options.createRegistry({ budget })
    const system = await this.options.buildSystem(registry, sessionKey, messages.length)

    // 只保留最后一个文本块：工具步骤前的旁白不应出现在最终回复里
    let reply = ''
    const writer: UIMessageStreamWriter = {
      write(chunk) {
        if (chunk.type === 'text-start') reply = ''
        else if (chunk.type === 'text-delta') reply += chunk.delta
      },
      merge() {},
      onError: undefined,
    }
    await agentLoop(
      this.options.model,
      registry.toAISDKFormat(),
      messages,
      system,
      writer,
      undefined,
      budget,
      undefined,
      this.options.usageTracker,
      sessionKey,
    )

    const replyText = reply.trim()
    // 即使没有回复也保留本轮 user 消息，避免下一次提问丢失上下文
    session.push(userMsg)
    if (replyText) session.push({ role: 'assistant', content: replyText })
    while (session.length > MAX_SESSION_MESSAGES) session.splice(0, 2)

    if (!replyText) return ''

    const channel = this.channels.get(channelName)
    if (deliver && channel) {
      await channel.send({
        channelId: msg.channelId,
        text: replyText,
      })
      console.log(
        `  [${channelName}] → ${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}`,
      )
    }
    return replyText
  }

  /** 取会话历史并标记活跃；新会话超限时淘汰最久未活跃的 key */
  private getSession(key: string): ModelMessage[] {
    const existing = this.sessions.get(key)
    if (existing) {
      this.sessions.delete(key)
      this.sessions.set(key, existing)
      return existing
    }

    const session: ModelMessage[] = []
    this.sessions.set(key, session)
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest !== undefined) this.sessions.delete(oldest)
    }
    return session
  }

  list(): Array<{ name: string; description: string; ready: boolean | null }> {
    return Array.from(this.channels.values()).map((channel) => ({
      name: channel.name,
      description: channel.description,
      // null = 通道不提供状态（长连接由 SDK 托管），前端显示「未知」而不是假装已连接
      ready: channel.isReady?.() ?? null,
    }))
  }

  has(name: string): boolean {
    return this.channels.has(name)
  }
}
