import { describe, expect, it, vi } from 'vitest'
import type { DiscordChannel } from './discord'
import type { OutgoingMessage } from './types'

/** notify 的目标是模块级状态：每个用例重新加载模块，避免用例间互相污染 */
async function freshNotify() {
  vi.resetModules()
  return import('./notify')
}

function fakeChannel(ready: boolean) {
  return {
    isReady: () => ready,
    send: vi.fn<(message: OutgoingMessage) => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as DiscordChannel & { send: ReturnType<typeof vi.fn> }
}

describe('pushDiscord', () => {
  it('未配置时返回 false 且不发送', async () => {
    const { pushDiscord } = await freshNotify()
    expect(await pushDiscord('hi')).toBe(false)
  })

  it('未配置频道 ID 时返回 false', async () => {
    const { pushDiscord, setDiscordNotifier } = await freshNotify()
    const channel = fakeChannel(true)
    setDiscordNotifier(channel, '', '')
    expect(await pushDiscord('hi')).toBe(false)
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('Discord 未连接时返回 false', async () => {
    const { pushDiscord, setDiscordNotifier } = await freshNotify()
    const channel = fakeChannel(false)
    setDiscordNotifier(channel, '111', '')
    expect(await pushDiscord('hi')).toBe(false)
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('配置了用户 ID 时在消息开头 @ 该用户', async () => {
    const { pushDiscord, setDiscordNotifier } = await freshNotify()
    const channel = fakeChannel(true)
    setDiscordNotifier(channel, '111', '222')

    expect(await pushDiscord('hi')).toBe(true)
    expect(channel.send).toHaveBeenCalledWith({ channelId: '111', text: '<@222> hi' })
  })

  it('文本里已有该提及时不重复拼接', async () => {
    const { pushDiscord, setDiscordNotifier } = await freshNotify()
    const channel = fakeChannel(true)
    setDiscordNotifier(channel, '111', '222')

    await pushDiscord('<@222> hi')
    expect(channel.send).toHaveBeenCalledWith({ channelId: '111', text: '<@222> hi' })
  })

  it('未配置用户 ID 时不加 @', async () => {
    const { pushDiscord, setDiscordNotifier } = await freshNotify()
    const channel = fakeChannel(true)
    setDiscordNotifier(channel, '111', '')

    await pushDiscord('hi')
    expect(channel.send).toHaveBeenCalledWith({ channelId: '111', text: 'hi' })
  })
})
