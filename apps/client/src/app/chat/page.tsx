'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { type FormEvent, Suspense, useCallback, useEffect, useState } from 'react'

const API = 'http://localhost:3000'

type ChatSummary = { id: string; title: string; updatedAt: string }

/** LLM 流式对话 demo：会话列表 + 历史持久化（存 PG），直接请求 Hono API。 */
export default function ChatPage() {
  return (
    <Suspense fallback={<main className="p-8">加载中…</main>}>
      <ChatPageInner />
    </Suspense>
  )
}

function ChatPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const chatId = searchParams.get('id')

  const [chats, setChats] = useState<ChatSummary[]>([])
  // 记录"哪个会话的历史已加载"。useChat 的 messages 只在首次挂载生效，
  // 必须等新会话的历史就绪后才渲染 ChatPanel，否则会带着上一个会话的消息重挂载。
  const [history, setHistory] = useState<{ chatId: string | null; messages: UIMessage[] }>({
    chatId: null,
    messages: [],
  })

  const refreshChats = useCallback(async () => {
    const res = await fetch(`${API}/api/chats`)
    const data = await res.json()
    setChats(data.chats ?? [])
  }, [])

  // 打开页面时拉会话列表
  useEffect(() => {
    refreshChats()
  }, [refreshChats])

  // 切换会话时拉历史（无 id 则重置为空会话）
  useEffect(() => {
    if (!chatId) {
      setHistory({ chatId: null, messages: [] })
      return
    }
    let cancelled = false
    fetch(`${API}/api/chats/${chatId}/messages`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setHistory({ chatId, messages: data.messages ?? [] })
      })
    return () => {
      cancelled = true
    }
  }, [chatId])

  const newChat = async () => {
    const res = await fetch(`${API}/api/chats`, { method: 'POST' })
    const { chat } = await res.json()
    await refreshChats()
    router.push(`/chat?id=${chat.id}`)
  }

  // 删除会话；删的是当前会话则回到 /chat（空会话视图）
  const deleteChat = async (id: string) => {
    await fetch(`${API}/api/chats/${id}`, { method: 'DELETE' })
    await refreshChats()
    if (id === chatId) {
      router.push('/chat')
    }
  }

  // 历史还没加载完前不渲染 ChatPanel（useChat 的 messages 只在首挂载生效）
  if (history.chatId !== chatId) {
    return <main className="p-8">加载历史…</main>
  }

  return (
    <main className="mx-auto flex h-screen max-w-4xl gap-4 p-6">
      {/* 左侧：会话列表 */}
      <aside className="flex w-56 shrink-0 flex-col gap-2 border-r pr-4">
        <button
          type="button"
          onClick={newChat}
          className="rounded bg-black px-3 py-2 text-sm text-white"
        >
          + 新会话
        </button>
        {chats.map((chat) => (
          <div
            key={chat.id}
            className={`group flex items-center gap-1 rounded px-3 py-2 text-sm ${
              chat.id === chatId ? 'bg-gray-200 font-medium' : 'hover:bg-gray-100'
            }`}
          >
            <Link
              href={`/chat?id=${chat.id}`}
              className="min-w-0 flex-1 truncate"
              title={chat.title}
            >
              {chat.title}
            </Link>
            <button
              type="button"
              aria-label="删除会话"
              onClick={() => deleteChat(chat.id)}
              className="hidden shrink-0 text-gray-400 hover:text-red-600 group-hover:block"
            >
              ×
            </button>
          </div>
        ))}
      </aside>

      {/* 右侧：对话区（key 保证切换会话时重新挂载） */}
      <ChatPanel
        key={chatId ?? 'new'}
        chatId={chatId}
        initialMessages={history.messages}
        onFinished={refreshChats}
      />
    </main>
  )
}

function ChatPanel({
  chatId,
  initialMessages,
  onFinished,
}: {
  chatId: string | null
  initialMessages: UIMessage[]
  onFinished: () => void
}) {
  const { messages, sendMessage, status, error, stop } = useChat({
    transport: new DefaultChatTransport({
      api: `${API}/api/chat`,
      body: { chatId },
    }),
    messages: initialMessages,
    onFinish: onFinished,
  })
  const [input, setInput] = useState('')

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (input.trim() && status === 'ready') {
      sendMessage({ text: input })
      setInput('')
    }
  }

  const busy = status === 'submitted' || status === 'streaming'

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-4">
      <h1 className="text-xl font-bold">AI Chat Demo</h1>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {messages.map((message) => {
          const reasoning = message.parts
            .filter((part) => part.type === 'reasoning')
            .map((part) => part.text)
            .join('')
          const text = message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
          return (
            <div
              key={message.id}
              className={`rounded-lg border p-3 ${
                message.role === 'user' ? 'ml-12 bg-black text-white' : 'mr-12 bg-gray-100'
              }`}
            >
              <p className="mb-1 text-xs opacity-60">{message.role === 'user' ? '你' : 'AI'}</p>
              {reasoning && (
                <details className="mb-2 rounded bg-gray-200/60 px-2 py-1 text-sm">
                  <summary className="cursor-pointer select-none text-xs opacity-60">
                    思考过程
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap">{reasoning}</p>
                </details>
              )}
              <p className="whitespace-pre-wrap">{text}</p>
            </div>
          )
        })}
        {status === 'submitted' && <p className="text-sm text-gray-500">思考中…</p>}
        {error && <p className="text-sm text-red-600">出错了：{error.message}</p>}
      </div>

      {busy ? (
        <button
          type="button"
          onClick={() => stop()}
          className="self-start rounded border border-gray-300 px-4 py-2"
        >
          停止生成
        </button>
      ) : (
        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            className="flex-1 rounded border border-gray-300 px-3 py-2"
            placeholder="说点什么…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            type="submit"
            disabled={!input.trim() || status !== 'ready'}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            发送
          </button>
        </form>
      )}
    </section>
  )
}
