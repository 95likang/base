'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type FileUIPart, type UIMessage } from 'ai'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  type ClipboardEvent,
  type FormEvent,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { contextCommand } from './commands/context'
import { dreamCommand, lintCommand, memoryCommand } from './commands/memory'
import {
  type ChatPanelView,
  type ContextSnapshot,
  createDispatcher,
  type LintReport,
  type MemoryItem,
  type UsageTotals,
} from './commands/types'
import { usageCommand } from './commands/usage'

const API = 'http://localhost:3000'

type ChatSummary = { id: string; title: string; updatedAt: string }

const fmt = (n: number) => n.toLocaleString('en-US')

/** 斜杠命令 dispatcher：模块级组装一次，命令只依赖传入的 CommandContext */
const dispatch = createDispatcher([
  contextCommand,
  usageCommand,
  memoryCommand,
  lintCommand,
  dreamCommand,
])

/**
 * 建会话的模块级缓存：空会话页自动建会话时，StrictMode 会把 effect 跑两遍，
 * 复用同一个 in-flight Promise，避免重复插入两条空会话。
 */
let creatingChat: Promise<string> | null = null

function createChatOnce(): Promise<string> {
  if (!creatingChat) {
    creatingChat = fetch(`${API}/api/chats`, { method: 'POST' })
      .then((res) => res.json())
      .then(({ chat }) => chat.id as string)
      .finally(() => {
        creatingChat = null
      })
  }
  return creatingChat
}

/** 图片长边降采样上限（Anthropic 推荐值），控制 data URL / DB / 每轮重放历史的体积 */
const MAX_IMAGE_EDGE = 1568

/** 单条消息图片数上限：data URL 随全量历史每轮重放并落库，需控制体积 */
const MAX_IMAGES = 8

/** File → FileUIPart：canvas 降采样 + 转 JPEG data URL（透明区垫白，GIF 取首帧） */
async function fileToImagePart(file: File): Promise<FileUIPart> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return {
    type: 'file',
    mediaType: 'image/jpeg',
    filename: file.name,
    url: canvas.toDataURL('image/jpeg', 0.85),
  }
}

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
  const [createError, setCreateError] = useState(false)
  // 记录"哪个会话的历史已加载"。useChat 的 messages 只在首次挂载生效，
  // 必须等新会话的历史就绪后才渲染 ChatPanel，否则会带着上一个会话的消息重挂载。
  const [history, setHistory] = useState<{
    chatId: string | null
    messages: UIMessage[]
  }>({
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

  // 无 id 时先建会话再跳转：Chat API 要求 chatId，否则发消息直接 400
  useEffect(() => {
    if (chatId) return
    let cancelled = false
    createChatOnce()
      .then((id) => {
        if (cancelled) return
        refreshChats()
        router.replace(`/chat?id=${id}`)
      })
      .catch(() => {
        if (!cancelled) setCreateError(true)
      })
    return () => {
      cancelled = true
    }
  }, [chatId, refreshChats, router])

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

  // 没有 chatId 时不渲染输入框，否则发送会带 chatId=null 被后端拒绝
  if (!chatId) {
    return (
      <main className="p-8">
        {createError ? '创建会话失败，请刷新页面重试。' : '正在创建会话…'}
      </main>
    )
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
  // 待发送图片（data URL，可直接预览；sendMessage 接受 FileUIPart[]）
  const [images, setImages] = useState<FileUIPart[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 斜杠命令的面板数据（本地展示，不入消息流、不落库）
  const [panel, setPanel] = useState<ChatPanelView | null>(null)

  /** 追加图片：非 image/* 的文件静默忽略；损坏图片跳过并警告，不阻塞其他图片 */
  const addImages = async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    const settled = await Promise.allSettled(imageFiles.map(fileToImagePart))
    const parts = settled
      .filter((r): r is PromiseFulfilledResult<FileUIPart> => r.status === 'fulfilled')
      .map((r) => r.value)
    for (const r of settled) {
      if (r.status === 'rejected') console.warn('图片转换失败，已跳过:', r.reason)
    }
    if (parts.length === 0) return
    setImages((prev) => [...prev, ...parts].slice(0, MAX_IMAGES))
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const cmd = input.trim()
    if (status !== 'ready') return
    // 有图片时不走斜杠命令，按普通消息发送
    if (cmd && images.length === 0) {
      const handled = await dispatch(cmd, {
        chatId,
        showPanel: setPanel,
        send: (text) => void sendMessage({ text }),
      })
      if (handled) {
        setInput('')
        return
      }
    }
    if (!cmd && images.length === 0) return
    // 纯图发送时 text 传 undefined，避免产生空白 text part（会绕过网关识图修复）
    sendMessage({ text: cmd || undefined, files: images })
    setInput('')
    setImages([])
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const files = Array.from(e.clipboardData.files)
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault()
      void addImages(files)
    }
  }

  const busy = status === 'submitted' || status === 'streaming'

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-4">
      <h1 className="text-xl font-bold">AI Chat Demo</h1>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {panel?.kind === 'context' && (
          <ContextPanel snapshot={panel.snapshot} onClose={() => setPanel(null)} />
        )}
        {panel?.kind === 'usage' && (
          <UsagePanel totals={panel.totals} title={panel.title} onClose={() => setPanel(null)} />
        )}
        {panel?.kind === 'memory' && (
          <MemoryPanel items={panel.items} onClose={() => setPanel(null)} />
        )}
        {panel?.kind === 'lint' && (
          <LintPanel total={panel.total} reports={panel.reports} onClose={() => setPanel(null)} />
        )}
        {messages.map((message) => {
          const reasoning = message.parts
            .filter((part) => part.type === 'reasoning')
            .map((part) => part.text)
            .join('')
          const text = message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
          const imgs = message.parts.filter(
            (part): part is FileUIPart =>
              part.type === 'file' && part.mediaType.startsWith('image/'),
          )
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
              {imgs.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {imgs.map((part, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同一图片可重复出现，url 可能重复，需索引区分
                    <span key={`${i}:${part.url}`}>
                      {/* biome-ignore lint/performance/noImgElement: data URL 本地图片，next/image 优化无意义 */}
                      <img
                        src={part.url}
                        alt={part.filename ?? '图片'}
                        className="max-h-48 rounded"
                      />
                    </span>
                  ))}
                </div>
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
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          {/* 发送前缩略图预览 */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((part, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同一图片可重复添加，url 可能重复，需索引区分
                <div key={`${i}:${part.url}`} className="relative h-16 w-16">
                  {/* biome-ignore lint/performance/noImgElement: data URL 本地图片，next/image 优化无意义 */}
                  <img
                    src={part.url}
                    alt={part.filename ?? '待发送图片'}
                    className="h-full w-full rounded object-cover"
                  />
                  <button
                    type="button"
                    aria-label="移除图片"
                    onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute -right-1 -top-1 rounded-full bg-black px-1 text-xs leading-4 text-white"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void addImages(Array.from(e.target.files ?? []))
                e.target.value = '' // 重置以允许重复选择同一文件
              }}
            />
            <button
              type="button"
              aria-label="上传图片"
              onClick={() => fileInputRef.current?.click()}
              className="rounded border border-gray-300 px-3 py-2"
              title="上传图片（也可直接粘贴）"
            >
              🖼️
            </button>
            <input
              className="flex-1 rounded border border-gray-300 px-3 py-2"
              placeholder="说点什么…（支持粘贴/上传图片 · /context 上下文 · /usage 成本 · /memory 记忆 · /lint 体检 · /dream 整理）"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
            />
            <button
              type="submit"
              disabled={(!input.trim() && images.length === 0) || status !== 'ready'}
              className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              发送
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

/** 上下文占用面板：输入 /context 时展示在消息区顶部（可关闭） */
function ContextPanel({ snapshot, onClose }: { snapshot: ContextSnapshot; onClose: () => void }) {
  return (
    <div className="rounded-lg border bg-white p-4 text-sm shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">
          Context · {snapshot.modelId} · 窗口 {fmt(snapshot.windowTokens)} tokens
        </p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {snapshot.sections.map((section) => (
          <div key={section.name} className="flex items-center gap-2">
            <span className="w-32 shrink-0 truncate text-xs text-gray-600" title={section.name}>
              {section.name}
            </span>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums">
              {fmt(section.tokens)}
            </span>
            <div className="h-2.5 flex-1 overflow-hidden rounded bg-gray-100">
              <div
                className="h-full rounded bg-gray-400"
                style={{
                  width: `${Math.min(100, (section.tokens / snapshot.windowTokens) * 100)}%`,
                }}
              />
            </div>
            <span className="w-14 shrink-0 text-right text-xs tabular-nums text-gray-500">
              {((section.tokens / snapshot.windowTokens) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t pt-2 text-xs text-gray-600">
        已用 <span className="font-medium text-gray-900">{fmt(snapshot.usedTokens)}</span>（
        {snapshot.usedPercent}%）· 剩余 {fmt(snapshot.freeTokens)} tokens
      </div>
    </div>
  )
}

/** 成本用量面板：输入 /usage（当前会话）或 /usage all（进程累计）时展示 */
function UsagePanel({
  totals,
  title,
  onClose,
}: {
  totals: UsageTotals
  title: string
  onClose: () => void
}) {
  const savedPct =
    totals.baselineCost > 0 ? Math.round((totals.savedCost / totals.baselineCost) * 100) : 0
  const rows = [
    { label: 'input', value: totals.inputTokens },
    { label: 'cache 写入', value: totals.cacheWriteTokens },
    { label: 'cache 读取', value: totals.cacheReadTokens },
    { label: 'output', value: totals.outputTokens },
  ]
  const max = Math.max(...rows.map((r) => r.value), 1)

  return (
    <div className="rounded-lg border bg-white p-4 text-sm shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">
          Usage · {title} {fmt(totals.steps)} 步
        </p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-xs text-gray-600">{row.label}</span>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums">{fmt(row.value)}</span>
            <div className="h-2.5 flex-1 overflow-hidden rounded bg-gray-100">
              <div
                className="h-full rounded bg-gray-400"
                style={{ width: `${(row.value / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t pt-2 text-xs text-gray-600">
        cache 命中率{' '}
        <span className="font-medium text-gray-900">{(totals.hitRate * 100).toFixed(1)}%</span>
        {' · '}花费 <span className="font-medium text-gray-900">${totals.cost.toFixed(4)}</span>
        {' · '}无 cache 假想 ${totals.baselineCost.toFixed(4)}
        {' · '}省 <span className="font-medium text-gray-900">${totals.savedCost.toFixed(4)}</span>
        {savedPct > 0 ? ` (-${savedPct}%)` : ''}
      </div>
    </div>
  )
}

/** 记忆管理面板：输入 /memory 时展示，按四类分组，支持删除 */
function MemoryPanel({ items, onClose }: { items: MemoryItem[]; onClose: () => void }) {
  const [list, setList] = useState(items)

  const remove = async (id: string) => {
    await fetch(`${API}/api/memory/${id}`, { method: 'DELETE' })
    setList((prev) => prev.filter((m) => m.id !== id))
  }

  const labels: Record<MemoryItem['type'], string> = {
    user: '用户画像',
    feedback: '行为反馈',
    project: '项目动态',
    reference: '外部资源',
  }
  const groups = (['user', 'feedback', 'project', 'reference'] as const).map((type) => ({
    type,
    entries: list.filter((m) => m.type === type),
  }))

  return (
    <div className="rounded-lg border bg-white p-4 text-sm shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">Memory · 共 {list.length} 条</p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      {list.length === 0 && (
        <p className="text-xs text-gray-500">
          还没有任何记忆。对话中透露偏好/决策/渠道时，AI 会自动保存。
        </p>
      )}
      <div className="flex flex-col gap-3">
        {groups
          .filter((g) => g.entries.length > 0)
          .map((group) => (
            <div key={group.type}>
              <p className="mb-1 text-xs font-medium text-gray-500">{labels[group.type]}</p>
              <div className="flex flex-col gap-1.5">
                {group.entries.map((m) => {
                  const expired = m.expiresAt !== null && new Date(m.expiresAt) < new Date()
                  return (
                    <div
                      key={m.id}
                      className="group flex items-start gap-2 rounded bg-gray-50 px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium" title={m.name}>
                          {m.name}
                          {expired && <span className="ml-1 text-gray-400">（已过期）</span>}
                        </p>
                        <p className="truncate text-xs text-gray-500" title={m.description}>
                          {m.description}
                          {m.expiresAt && !expired ? ` · 截止 ${m.expiresAt.slice(0, 10)}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label="删除记忆"
                        onClick={() => remove(m.id)}
                        className="shrink-0 text-gray-300 hover:text-red-600"
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}

/** 记忆体检面板：输入 /lint 时展示，列出每条记忆的失效路径、长期未读、同名重复 */
function LintPanel({
  total,
  reports,
  onClose,
}: {
  total: number
  reports: LintReport[]
  onClose: () => void
}) {
  return (
    <div className="rounded-lg border bg-white p-4 text-sm shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">
          记忆体检 · 共 {total} 条
          {reports.length > 0 ? ` · ${reports.length} 条有警告` : ' · 未发现问题'}
        </p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      {reports.length === 0 && (
        <p className="text-xs text-gray-500">
          记忆库健康。体检项：引用路径是否还存在、是否已过期、是否长期未被读取、是否有同名重复。
        </p>
      )}
      <div className="flex flex-col gap-2">
        {reports.map((report) => (
          <div key={report.entry.id} className="rounded bg-amber-50 px-2 py-1.5 text-xs">
            <p className="font-medium">
              [{report.entry.type}] {report.entry.name}
            </p>
            {report.issues.map((issue) => (
              <p key={`${issue.kind}:${issue.message}`} className="text-gray-600">
                · {issue.kind}：{issue.message}
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
