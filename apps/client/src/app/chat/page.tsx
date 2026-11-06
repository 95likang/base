'use client'

import { MessageCircle, Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { redirectToLogin } from '@/lib/auth-redirect'

/** 同源 rewrite 代理到 API（next.config.ts），部署时不依赖固定端口 */
const API = ''

type ChatSummary = { id: string; title: string; updatedAt: string }

/** 对话列表：点「新会话」创建后进入详情页，点已有会话进入历史对话。 */
export default function ChatListPage() {
  const router = useRouter()
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ChatSummary | null>(null)
  const [error, setError] = useState('')

  const refreshChats = useCallback(async () => {
    const res = await fetch(`${API}/api/chats`)
    if (res.status === 401) {
      redirectToLogin('/chat')
      return
    }
    if (!res.ok) throw new Error('load failed')
    const data = await res.json()
    setChats(data.chats ?? [])
  }, [])

  const load = useCallback(() => {
    setError('')
    setLoading(true)
    return refreshChats()
      .catch(() => setError('加载会话失败，请稍后重试。'))
      .finally(() => setLoading(false))
  }, [refreshChats])

  useEffect(() => {
    void load()
  }, [load])

  const newChat = async () => {
    setCreating(true)
    setError('')
    try {
      const res = await fetch(`${API}/api/chats`, { method: 'POST' })
      if (res.status === 401) {
        redirectToLogin('/chat')
        return
      }
      if (!res.ok) throw new Error(`创建会话失败（${res.status}）`)
      const { chat } = await res.json()
      router.push(`/chat/${chat.id}`)
    } catch {
      setError('创建会话失败，请重试。')
      setCreating(false)
    }
  }

  const deleteChat = async (id: string) => {
    setPendingDelete(null)
    setError('')
    try {
      const res = await fetch(`${API}/api/chats/${id}`, { method: 'DELETE' })
      if (res.status === 401) {
        redirectToLogin('/chat')
        return
      }
      if (!res.ok) throw new Error('delete failed')
      await refreshChats()
    } catch {
      setError('删除会话失败，请重试。')
    }
  }

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="flex items-end justify-between pt-2">
        <h1 className="text-2xl">对话</h1>
        <Button size="sm" onClick={newChat} disabled={creating}>
          <Plus />
          {creating ? '创建中…' : '新会话'}
        </Button>
      </header>

      {error ? (
        <div className="flex flex-col items-start gap-2">
          <p
            role="alert"
            className="w-full rounded-xl border-2 border-destructive bg-card px-4 py-3 text-sm leading-relaxed text-destructive"
          >
            {error}
          </p>
          <Button variant="outline" className="h-11" onClick={() => void load()}>
            重试
          </Button>
        </div>
      ) : loading ? (
        <div aria-hidden="true" className="flex flex-col gap-3">
          {['chat-loading-one', 'chat-loading-two', 'chat-loading-three'].map((slot) => (
            <div
              key={slot}
              className="flex items-center gap-2 rounded-xl border-2 border-border bg-card px-4 py-3 shadow-card"
            >
              <div className="min-w-0 flex-1">
                <Skeleton className="h-4 w-2/3 rounded-sm" />
                <Skeleton className="mt-1.5 h-3 w-1/3 rounded-sm" />
              </div>
              <Skeleton className="size-11 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      ) : chats.length === 0 ? (
        <Card className="items-center gap-3 border-dashed py-10 text-center shadow-none hover:scale-100 hover:rotate-0 hover:shadow-none">
          <span className="flex size-12 items-center justify-center rounded-full border-2 border-foreground bg-tertiary">
            <MessageCircle className="size-6" strokeWidth={2.5} />
          </span>
          <CardTitle>还没有对话</CardTitle>
          <CardDescription>点「新会话」开始。</CardDescription>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {chats.map((chat) => (
            <li key={chat.id}>
              <Card className="flex-row items-center gap-2 px-4 py-3 hover:rotate-0 hover:scale-100 hover:shadow-card">
                <Link href={`/chat/${chat.id}`} className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{chat.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {new Date(chat.updatedAt).toLocaleString('zh-CN')}
                  </p>
                </Link>
                <button
                  type="button"
                  aria-label="删除会话"
                  onClick={() => setPendingDelete(chat)}
                  className="flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-transparent text-lg text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
                >
                  ×
                </button>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这个会话？"
        description={`「${pendingDelete?.title ?? ''}」里的对话记录会一起消失，删除后无法恢复。`}
        onConfirm={() => {
          if (pendingDelete) void deleteChat(pendingDelete.id)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </main>
  )
}
