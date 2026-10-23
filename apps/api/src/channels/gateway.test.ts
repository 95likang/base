import type { LanguageModel, ModelMessage, UIMessageStreamWriter } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRegistry } from '../tools/registry'
import { UsageTracker } from '../usage/tracker'
import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types'

const { agentLoopMock } = vi.hoisted(() => ({ agentLoopMock: vi.fn() }))

vi.mock('../agent/loop', () => ({
  agentLoop: agentLoopMock,
  TOKEN_BUDGET: 200_000,
}))

// mock 必须声明在 import 之前（vi.hoisted 保证提升后仍可访问）
import { ChannelGateway } from './gateway'

/** gateway 只用 toAISDKFormat，其余 registry 能力不参与编排 */
const registry = { toAISDKFormat: () => ({}) } as unknown as ToolRegistry

class FakeChannel implements ChannelDefinition {
  name = 'feishu'
  description = '测试通道'
  handler?: (msg: IncomingMessage) => void
  send = vi.fn(async (_message: OutgoingMessage) => {})

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler
  }

  start(): void {}
  stop(): void {}
}

const message = (text: string, chatId = 'chat-1'): IncomingMessage => ({
  channelId: chatId,
  senderId: 'user-1',
  senderName: 'user-1',
  text,
})

function createGateway(usageTracker?: UsageTracker): ChannelGateway {
  return new ChannelGateway({
    model: 'test-model' as unknown as LanguageModel,
    createRegistry: () => registry,
    buildSystem: () => 'system',
    usageTracker,
  })
}

/** 模拟 agentLoop 按块写文本（工具步骤常有多段文本） */
function replyWithBlocks(blocks: string[]) {
  agentLoopMock.mockImplementation(async (...args: unknown[]) => {
    const writer = args[4] as UIMessageStreamWriter
    for (const [index, text] of blocks.entries()) {
      writer.write({ type: 'text-start', id: `t${index}` })
      writer.write({ type: 'text-delta', id: `t${index}`, delta: text })
      writer.write({ type: 'text-end', id: `t${index}` })
    }
  })
}

beforeEach(() => {
  agentLoopMock.mockReset()
})

describe('ChannelGateway', () => {
  it('只把最后一个文本块作为回复', async () => {
    replyWithBlocks(['我先查一下。', '今天晴。'])
    const channel = new FakeChannel()
    const gateway = createGateway()
    gateway.register(channel)

    const reply = await gateway.dispatch('feishu', message('天气'), false)

    expect(reply).toBe('今天晴。')
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('同一发送者按 chatId 隔离会话', async () => {
    const calls: ModelMessage[][] = []
    agentLoopMock.mockImplementation(async (...args: unknown[]) => {
      calls.push(args[2] as ModelMessage[])
      const writer = args[4] as UIMessageStreamWriter
      writer.write({ type: 'text-start', id: 't' })
      writer.write({ type: 'text-delta', id: 't', delta: 'ok' })
    })
    const gateway = createGateway()
    gateway.register(new FakeChannel())

    await gateway.dispatch('feishu', message('first', 'chat-1'), false)
    await gateway.dispatch('feishu', message('second', 'chat-1'), false)
    await gateway.dispatch('feishu', message('third', 'chat-2'), false)

    expect(calls[0].map((m) => m.content)).toEqual(['first'])
    expect(calls[1].map((m) => m.content)).toEqual(['first', 'ok', 'second'])
    expect(calls[2].map((m) => m.content)).toEqual(['third'])
  })

  it('同一会话的并发消息串行执行', async () => {
    let release: (() => void) | undefined
    const order: string[] = []
    agentLoopMock.mockImplementation(async (...args: unknown[]) => {
      const messages = args[2] as ModelMessage[]
      const text = String(messages.at(-1)?.content)
      order.push(text)
      if (text === 'first') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      const writer = args[4] as UIMessageStreamWriter
      writer.write({ type: 'text-start', id: 't' })
      writer.write({ type: 'text-delta', id: 't', delta: 'ok' })
    })
    const gateway = createGateway()
    gateway.register(new FakeChannel())

    const first = gateway.dispatch('feishu', message('first'), false)
    await vi.waitFor(() => expect(agentLoopMock).toHaveBeenCalledTimes(1))
    const second = gateway.dispatch('feishu', message('second'), false)
    // 第二条必须等第一条结束后才开始
    expect(agentLoopMock).toHaveBeenCalledTimes(1)

    if (!release) throw new Error('first dispatch 未进入挂起状态')
    release()
    await Promise.all([first, second])

    expect(order).toEqual(['first', 'second'])
  })

  it('未注册的通道直接拒绝', async () => {
    const gateway = createGateway()
    await expect(gateway.dispatch('nope', message('hi'))).rejects.toThrow('未注册的通道')
    expect(agentLoopMock).not.toHaveBeenCalled()
  })

  it('处理失败时向通道回执', async () => {
    agentLoopMock.mockRejectedValue(new Error('boom'))
    const channel = new FakeChannel()
    const gateway = createGateway()
    gateway.register(channel)

    if (!channel.handler) throw new Error('通道未注册消息处理器')
    channel.handler(message('hi'))

    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1))
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'chat-1', text: '处理失败，请稍后重试。' }),
    )
  })

  it('把用量与会话 id 透传给 agentLoop', async () => {
    replyWithBlocks(['ok'])
    const usageTracker = new UsageTracker()
    const gateway = createGateway(usageTracker)
    gateway.register(new FakeChannel())

    await gateway.dispatch('feishu', message('hi'), false)

    expect(agentLoopMock.mock.calls[0][8]).toBe(usageTracker)
    expect(agentLoopMock.mock.calls[0][9]).toBe('feishu:chat-1:user-1')
  })

  it('deliver=true 时通过通道发送回复', async () => {
    replyWithBlocks(['收到'])
    const channel = new FakeChannel()
    const gateway = createGateway()
    gateway.register(channel)

    await gateway.dispatch('feishu', message('hi'))

    expect(channel.send).toHaveBeenCalledWith({
      channelId: 'chat-1',
      recipientId: 'user-1',
      text: '收到',
    })
  })
})
