'use client'

import { MessageCircle, Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'

const API = 'http://localhost:3000'

type ChatSummary = { id: string; title: string; updatedAt: string }

/** 对话列表：点「新会话」创建后进入详情页，点已有会话进入历史对话。 */
export default function ChatListPage() {
  const router = useRouter()
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const refreshChats = useCallback(async () => {
    const res = await fetch(`${API}/api/chats`)
    const data = await res.json()
    setChats(data.chats ?? [])
  }, [])

  useEffect(() => {
    refreshChats()
      .catch(() => setError('加载会话失败，请稍后重试。'))
      .finally(() => setLoading(false))
  }, [refreshChats])

  const newChat = async () => {
    setCreating(true)
    setError('')
    try {
      const res = await fetch(`${API}/api/chats`, { method: 'POST' })
      if (!res.ok) throw new Error(`创建会话失败（${res.status}）`)
      const { chat } = await res.json()
      router.push(`/chat/${chat.id}`)
    } catch {
      setError('创建会话失败，请重试。')
      setCreating(false)
    }
  }

  const deleteChat = async (id: string) => {
    if (!window.confirm('删除这个会话？删除后无法恢复。')) return
    await fetch(`${API}/api/chats/${id}`, { method: 'DELETE' })
    await refreshChats()
  }

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="flex items-end justify-between pt-2">
        <div>
          <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Chat</p>
          <h1 className="text-2xl">对话</h1>
        </div>
        <Button size="sm" onClick={newChat} disabled={creating}>
          <Plus />
          {creating ? '创建中…' : '新会话'}
        </Button>
      </header>

      {error && (
        <p className="rounded-xl border-2 border-destructive bg-card px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
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
              <Card className="flex-row items-center gap-2 px-4 py-3">
                <Link href={`/chat/${chat.id}`} className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{chat.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {new Date(chat.updatedAt).toLocaleString('zh-CN')}
                  </p>
                </Link>
                <button
                  type="button"
                  aria-label="删除会话"
                  onClick={() => deleteChat(chat.id)}
                  className="shrink-0 rounded-full border-2 border-transparent px-2 py-1 text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
                >
                  ×
                </button>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
