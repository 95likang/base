import { createRequire } from 'node:module'
import type { Client, ClientOptions, Interaction, Message } from 'discord.js'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type {
  ChannelAction,
  ChannelActionEvent,
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from './types'

export interface DiscordConfig {
  botToken: string
  /** HTTP 代理（如 http://127.0.0.1:7890）：Node 不会自动使用系统代理，需要显式配置 */
  proxyUrl?: string
}

/** Discord 单条消息上限 2000 字符，留出切分余量 */
const MAX_MESSAGE_LENGTH = 1900

/**
 * Discord Bot 通道：用 Gateway 长连接接收消息，不需要公网回调地址。
 * 私聊直接响应；服务器频道里只在被 @ 时响应，避免刷屏所有闲聊。
 */
export class DiscordChannel implements ChannelDefinition {
  name = 'discord'
  description = 'Discord Bot 消息通道（Gateway 长连接）'

  private config: DiscordConfig
  private messageHandler?: (msg: IncomingMessage) => void
  private actionHandler?: (event: ChannelActionEvent) => Promise<string> | string
  private client?: Client

  constructor(config: DiscordConfig) {
    this.config = config
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  /** 按钮回调：返回文本会追加到原消息并移除按钮 */
  onAction(handler: (event: ChannelActionEvent) => Promise<string> | string): void {
    this.actionHandler = handler
  }

  async start(): Promise<void> {
    if (!this.config.botToken) {
      console.log('    [discord] 未配置 DISCORD_BOT_TOKEN，跳过连接')
      return
    }

    const proxy = this.config.proxyUrl ? new URL(this.config.proxyUrl) : undefined

    // 必须在 import('discord.js') 之前：@discordjs/ws 在模块加载时就取走了 WebSocket 构造函数
    if (proxy) applyWebSocketProxy(proxy.href)

    // 动态导入：不配置 Discord 时完全不加载 SDK
    const { Client, Events, GatewayIntentBits, Partials } = await import('discord.js')

    const options: ClientOptions = {
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        // 特权 intent：必须在 Developer Portal 打开，否则消息内容为空
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    }

    if (proxy) {
      // REST 走 undici，可以单独注入 dispatcher
      const { ProxyAgent } = await import('undici')
      options.rest = { agent: new ProxyAgent(proxy.href) }
      // 只打 host：代理 URL 可能带 user:pass
      console.log(`    [discord] 通过代理连接: ${proxy.host}`)
    }

    this.client = new Client(options)

    this.client.on(Events.MessageCreate, (message) => this.handleMessage(message))
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction)
    })
    this.client.on(Events.Error, (err) => {
      console.error(`    [discord] 连接错误: ${err.message}`)
    })

    try {
      await this.client.login(this.config.botToken)
    } catch (err) {
      // 登录失败时清掉半初始化的连接，避免残留重连与监听
      this.client.destroy()
      this.client = undefined
      const msg = err instanceof Error ? err.message : String(err)
      // 带上代理信息，便于区分「代理没生效」和「真实业务错误」
      throw new Error(proxy ? `${msg}（代理 ${proxy.host}）` : msg)
    }
    console.log(`    [discord] 已登录: ${this.client.user?.tag ?? 'unknown'}`)
  }

  async stop(): Promise<void> {
    this.client?.destroy()
  }

  /** Gateway 是否已就绪：主动推送依赖登录成功的 client */
  isReady(): boolean {
    return this.client?.isReady() ?? false
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.client) {
      console.log(`    [discord] Discord 未连接，跳过发送: ${message.text.slice(0, 50)}`)
      return
    }

    try {
      const channel = await this.client.channels.fetch(message.channelId)
      if (!channel?.isSendable()) {
        console.error(`    [discord] 频道不可发送: ${message.channelId}`)
        return
      }
      // 超长回复切块依次发送，保持顺序；单块失败不阻断后续
      const chunks = splitText(message.text)
      const components = message.actions ? await buildComponents(message.actions) : undefined
      for (const [index, chunk] of chunks.entries()) {
        try {
          // 允许 @用户 / @角色 / @everyone（内容里写 <@ID>、<@&ID>、@everyone）
          await channel.send({
            content: chunk,
            // 按钮挂在最后一块，避免用户在第一块就点击、后面还没发完
            components: index === chunks.length - 1 ? components : undefined,
            allowedMentions: { parse: ['users', 'roles', 'everyone'] },
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`    [discord] 分块发送失败: ${msg}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`    [discord] 发送失败: ${msg}`)
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() || !this.actionHandler) return

    // Discord 要求 3 秒内响应：先 defer；超时失败也继续处理业务
    await interaction.deferUpdate().catch(() => {})

    const content = interaction.message.content
    let reply: string
    try {
      reply = await this.actionHandler({
        actionId: interaction.customId,
        senderId: interaction.user.id,
        messageText: content,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`    [discord] 按钮处理失败: ${message}`)
      reply = '处理失败，请稍后重试'
    }

    try {
      // 处理完移除按钮；旧消息上的按钮被再次点击时由回调做幂等判断
      const merged = `${content}\n\n${reply}`
      await interaction.editReply({
        // 拼接结果可能超过 2000 字符上限，超长时只保留处理结果
        content: merged.length > 2000 ? reply : merged,
        components: [],
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`    [discord] 更新按钮消息失败: ${message}`)
    }
  }

  private handleMessage(message: Message): void {
    // 只处理人类消息：机器人/系统消息不回，避免自循环
    if (message.author.bot || !message.content.trim() || !this.messageHandler) return

    // 服务器频道里只在被 @ 时响应；私聊（guildId 为空）直接响应
    const mentioned = this.client?.user ? message.mentions.has(this.client.user.id) : false
    if (message.guildId && !mentioned) return

    const text = mentioned
      ? stripMention(message.content, this.client?.user?.id ?? '')
      : message.content
    if (!text) return

    this.messageHandler({
      channelId: message.channelId,
      senderId: message.author.id,
      senderName: message.author.displayName,
      text,
      raw: message,
    })
  }
}

/**
 * Gateway 的 WebSocket 由 @discordjs/ws 内部 `require('ws')` 创建且只传 URL：
 * 既没有注入 dispatcher/agent 的选项，又因为 ws 自带 createConnection 而绕过了
 * https.globalAgent，所以只能在构造时用代理包一层——替换 ws 的导出。
 * 只影响 Discord 连接，不设置 undici 全局 dispatcher。
 *
 * 补丁是进程级的，重复调用会层层包装，只需生效一次。
 */
let wsProxyApplied = false

function applyWebSocketProxy(proxyUrl: string): void {
  if (wsProxyApplied) return
  wsProxyApplied = true

  // 必须走 require：@discordjs/ws 拿到的是 ws 的 CJS module.exports，
  // 而 import('ws') 返回的是另一个 ESM wrapper，改它不会影响 Gateway 连接
  const ws = createRequire(import.meta.url)('ws') as {
    WebSocket: new (
      address: string,
      protocols?: string[],
      options?: Record<string, unknown>,
    ) => object
  }

  const agent = new HttpsProxyAgent(proxyUrl)
  const Original = ws.WebSocket
  ws.WebSocket = class extends Original {
    constructor(address: string, protocols?: unknown, options?: Record<string, unknown>) {
      // ws 支持 (url, options) 简写，保持同样的重载语义；
      // 注意 [] 也是 object，不能把它当 options（@discordjs/ws 正是传 (url, [], { handshakeTimeout })）
      if (protocols && typeof protocols === 'object' && !Array.isArray(protocols)) {
        options = protocols as Record<string, unknown>
        protocols = undefined
      }
      super(address, protocols as string[], { ...options, agent })
    }
  }
}

/** 去掉 <@123> / <@!123> 形式的 @Bot 占位符 */
function stripMention(content: string, botId: string): string {
  if (!botId) return content.trim()
  return content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim()
}

/** 把通道动作渲染成一行按钮；customId 超限的跳过，避免整条消息发送失败 */
async function buildComponents(actions: ChannelAction[]) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js')
  const row = new ActionRowBuilder<import('discord.js').ButtonBuilder>()
  for (const action of actions) {
    if (action.id.length > 100) {
      console.error(`    [discord] customId 超过 100 字符，按钮已跳过: ${action.id.slice(0, 40)}…`)
      continue
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(action.id)
        .setLabel(action.label)
        .setStyle(action.style === 'danger' ? ButtonStyle.Danger : ButtonStyle.Secondary),
    )
  }
  return row.components.length > 0 ? [row] : undefined
}

/** 按长度切块：优先在换行处断开，其次空格，避免把提及/单词切两半 */
function splitText(text: string): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > MAX_MESSAGE_LENGTH) {
    const slice = rest.slice(0, MAX_MESSAGE_LENGTH)
    const newlineAt = slice.lastIndexOf('\n')
    const spaceAt = slice.lastIndexOf(' ')
    const cut = newlineAt > 0 ? newlineAt : spaceAt > 0 ? spaceAt : MAX_MESSAGE_LENGTH
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^[\n ]/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}
