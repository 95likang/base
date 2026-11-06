'use client'

import type { UIMessage } from 'ai'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ApiError, apiFetch } from '@/lib/http'
import { ChatPanel } from './ChatPanel'

type HistoryResponse = {
  chat?: { title?: string }
  messages?: UIMessage[]
}

/** 对话详情：按路由 id 加载历史，页内续聊。 */
export default function ChatDetailPage() {
  const { id: chatId } = useParams<{ id: string }>()
  // 记录"哪个会话的历史已加载"。useChat 的 messages 只在首次挂载生效，
  // 必须等历史就绪后才渲染 ChatPanel，否则会带着上一个会话的消息重挂载。
  const [history, setHistory] = useState<{
    chatId: string | null
    messages: UIMessage[]
  }>({
    chatId: null,
    messages: [],
  })

  const [loadError, setLoadError] = useState<'notfound' | 'failed' | null>(null)
  const [chatTitle, setChatTitle] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  // 按路由 id 拉历史；401 由 apiFetch 直接跳登录页
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey 只用于触发重新加载
  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    apiFetch<HistoryResponse>(`/api/chats/${chatId}/messages`)
      .then((data) => {
        if (cancelled) return
        setChatTitle(data.chat?.title ?? '')
        setHistory({ chatId, messages: data.messages ?? [] })
      })
      .catch((err) => {
        // 401 已经在跳登录页，不再覆盖成错误态
        if (cancelled || (err instanceof ApiError && err.status === 401)) return
        setLoadError(err instanceof ApiError && err.status === 404 ? 'notfound' : 'failed')
      })
    return () => {
      cancelled = true
    }
  }, [chatId, reloadKey])

  if (loadError) {
    return (
      <main className="flex flex-col gap-4 p-6 text-sm">
        <p
          role="alert"
          className="rounded-xl border-2 border-destructive bg-card px-4 py-3 leading-relaxed text-destructive"
        >
          {loadError === 'notfound'
            ? '这个会话不存在或已被删除。'
            : '加载历史失败，请检查网络后重试。'}
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm" className="h-11">
            <Link href="/chat">返回对话列表</Link>
          </Button>
          {loadError === 'failed' ? (
            <Button size="sm" className="h-11" onClick={() => setReloadKey((key) => key + 1)}>
              重试
            </Button>
          ) : null}
        </div>
      </main>
    )
  }

  // 历史还没加载完前不渲染 ChatPanel（useChat 的 messages 只在首挂载生效）
  if (history.chatId !== chatId) {
    return (
      <main className="p-6 text-sm text-muted-foreground">
        <p role="status" aria-live="polite">
          加载历史…
        </p>
      </main>
    )
  }

  return (
    <main className="flex h-full flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b-2 border-foreground bg-card px-3 py-2">
        <Button asChild variant="ghost" size="sm" className="-ml-1 h-11">
          <Link href="/chat" aria-label="返回对话列表">
            <ArrowLeft />
            对话
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-bold">{chatTitle || '未命名会话'}</h1>
      </header>

      <ChatPanel key={chatId} chatId={chatId} initialMessages={history.messages} />
    </main>
  )
}
