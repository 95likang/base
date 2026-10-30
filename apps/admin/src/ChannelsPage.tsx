import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { client, readError } from './lib/api'

const CHANNELS_KEY = ['channels']

/**
 * Channel 管理页：查看已注册通道，并通过模拟飞书消息跑一遍完整的 Agent 循环。
 * 通道状态只在当前进程内有效，API 重启后回到启动时的配置。
 */
export function ChannelsPage() {
  const [text, setText] = useState('你好')
  const [discordText, setDiscordText] = useState('来自管理页的测试推送')

  const channelsQuery = useQuery({
    queryKey: CHANNELS_KEY,
    queryFn: async () => {
      const res = await client.api.channels.$get()
      if (!res.ok) throw new Error(await readError(res))
      const data = await res.json()
      return data.channels
    },
  })

  const test = useMutation({
    mutationFn: async (message: string) => {
      const res = await client.api.channels.feishu.test.$post({ json: { text: message } })
      if (!res.ok) throw new Error(await readError(res))
      const data = await res.json()
      return data.reply
    },
  })

  const pushDiscord = useMutation({
    mutationFn: async (message: string) => {
      const res = await client.api.channels.discord.push.$post({ json: { text: message } })
      if (!res.ok) throw new Error(await readError(res))
      return (await res.json()).sent
    },
  })

  const channels = channelsQuery.data ?? []

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-2xl font-bold">Channels</h1>

      <p className="mb-6 text-sm text-gray-500">
        飞书未配置 FEISHU_APP_ID / FEISHU_APP_SECRET 时不会建立长连接，但通道仍会注册。
      </p>

      {channelsQuery.isPending && <p className="text-gray-500">加载中…</p>}
      {channelsQuery.isError && <p className="text-red-600">加载失败。</p>}
      {!channelsQuery.isPending && channels.length === 0 && (
        <p className="text-gray-500">还没有注册的通道。</p>
      )}
      {channels.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-600">
              <th className="py-2 pr-3">名称</th>
              <th className="py-2 pr-3">描述</th>
              <th className="py-2 pr-3">状态</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((channel) => (
              <tr key={channel.name} className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">{channel.name}</td>
                <td className="py-2 pr-3 text-gray-600">{channel.description}</td>
                <td className="py-2 pr-3">
                  {channel.ready === null ? (
                    <span className="text-gray-500">未知</span>
                  ) : channel.ready ? (
                    <span className="text-green-700">已连接</span>
                  ) : (
                    <span className="text-red-600">未连接</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="mt-8">
        <h2 className="mb-2 text-lg font-semibold">发送测试消息</h2>
        <p className="mb-3 text-sm text-gray-500">
          模拟一条飞书消息，回复会直接显示在下方（不投递到真实飞书）。
        </p>
        <textarea
          className="h-24 w-full rounded border border-gray-300 p-3 font-mono text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className="mt-2 rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          disabled={test.isPending || !text.trim()}
          onClick={() => {
            test.reset()
            test.mutate(text.trim())
          }}
        >
          {test.isPending ? '处理中…' : '发送'}
        </button>
        {test.isError && <p className="mt-2 text-sm text-red-600">{test.error.message}</p>}
        {test.data !== undefined && (
          <pre className="mt-3 whitespace-pre-wrap rounded bg-gray-100 p-3 text-sm">
            {test.data || '（无回复）'}
          </pre>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-lg font-semibold">推送到 Discord</h2>
        <p className="mb-3 text-sm text-gray-500">
          直接推送到配置的固定频道（DISCORD_NOTIFY_CHANNEL_ID），不经过 Agent。 需要 bot
          已登录成功。提及用户写 <code>&lt;@用户ID&gt;</code>，提及角色写{' '}
          <code>&lt;@&amp;角色ID&gt;</code>，@everyone / @here 会通知全员。
        </p>
        <textarea
          className="h-24 w-full rounded border border-gray-300 p-3 font-mono text-sm"
          value={discordText}
          onChange={(e) => setDiscordText(e.target.value)}
        />
        <button
          type="button"
          className="mt-2 rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          disabled={pushDiscord.isPending || !discordText.trim()}
          onClick={() => {
            pushDiscord.reset()
            pushDiscord.mutate(discordText.trim())
          }}
        >
          {pushDiscord.isPending ? '推送中…' : '推送'}
        </button>
        {pushDiscord.isError && (
          <p className="mt-2 text-sm text-red-600">{pushDiscord.error.message}</p>
        )}
        {pushDiscord.isSuccess && (
          <p className="mt-2 text-sm text-green-700">已推送，去 Discord 频道查看。</p>
        )}
      </section>
    </main>
  )
}
